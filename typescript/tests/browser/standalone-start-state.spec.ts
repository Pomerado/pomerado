import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { MintArtifact } from "../../src/standalone/contracts.js";

// Where each live step of a local build starts: its page, tabs, cookies and storage. A local
// fixture site records what every probe saw, and scripted models drive the build.

type Output = ModelResponse["output"];
const call = (name: string, input: unknown, callId = name): Output[number] => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const message = (text: string): Output[number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const objects = (value: unknown): readonly Record<string, unknown>[] => {
  if (typeof value === "string") {
    try {
      return objects(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(objects);
  if (typeof value !== "object" || value === null) return [];
  const record = Schema.decodeUnknownEither(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(value);
  return record._tag === "Left"
    ? []
    : [record.right, ...Object.values(record.right).flatMap(objects)];
};
const provider = (respond: (request: ModelRequest, index: number) => Output): ModelProvider => {
  let index = 0;
  return {
    getModel: () => ({
      getResponse: async (request) => ({ usage: new Usage(), output: respond(request, index++) }),
      getStreamedResponse: () => {
        throw new Error("Fixture does not stream");
      },
    }),
  };
};
/** Allows every review after reading the reviewed source, as the review loop requires. */
const guardian = () => {
  let sourcePending = false;
  return provider((request, index) => {
    const current = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    if (current !== undefined && "question_review" in current)
      return [message(JSON.stringify({ outcome: "allow_business", rationale: "Fixture" }))];
    if (sourcePending) {
      sourcePending = false;
      return [message(JSON.stringify({ outcome: "allow", rationale: "Fixture review" }))];
    }
    sourcePending = true;
    const pending = objects(current).find((item) => typeof item["entrypoint"] === "string");
    if (pending === undefined) throw new Error("Guardian did not receive its review input");
    return [call("read_source", { path: pending["entrypoint"], offset: 0 }, `source_${index}`)];
  });
};
const patch = (files: Readonly<Record<string, string>>): Output =>
  Object.entries(files).map(([path, content], index) => ({
    type: "apply_patch_call",
    callId: `patch_${index}`,
    status: "completed",
    operation: {
      type: "create_file",
      path,
      diff:
        content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n") + "\n",
    },
  }));
const execution = (
  purpose: string,
  entrypoint: string,
  extra: object = {},
  callId = `${purpose}_${entrypoint}`,
) =>
  call(
    "execute",
    {
      purpose,
      target: "liveBrowser",
      entrypoint,
      fixtureRefs: [],
      caseFilter: [],
      maxWorkers: 1,
      timeoutSeconds: 20,
      intent: `Run ${entrypoint}`,
      ...extra,
    },
    callId,
  );
const finish = (request: ModelRequest): Output => {
  const receipt = objects(request.input)
    .filter((item) => typeof item["executionId"] === "string")
    .at(-1);
  if (receipt === undefined) throw new Error("No execution receipt to finish with");
  return [
    call("finish_build", {
      intent: "Return the probe",
      entrypoint: "src/tool.mjs",
      executionId: receipt["executionId"],
      metadata: { name: "probe", description: "Report where the page starts" },
      coverage: "One live example",
    }),
  ];
};

/** One browser call in an operation module, which fails the run when the call fails. */
const operation = (name: string, code: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:${JSON.stringify(name)},input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(code)},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
/** Reports the page's path, tabs, cookies and storage to the site, then runs `then`. */
const probe = (step: string, then = "") => `
const state = await page.evaluate(() => ({
  path: location.pathname,
  explored: localStorage.getItem("explored"),
  token: localStorage.getItem("token"),
  tab: sessionStorage.getItem("explored"),
}));
const cookies = (await context.cookies()).map((cookie) => cookie.name).sort();
const report = JSON.stringify({ step: ${JSON.stringify(step)}, ...state, cookies, tabs: context.pages().length });
await page.evaluate((body) => fetch("/probe", { method: "POST", body }), report);
${then}
return true;`;
/** Leaves a cookie, site storage, tab storage and a second tab, then goes deeper. */
const explore = operation(
  "explore",
  `await page.evaluate(() => {
  document.cookie = "explored=yes; path=/";
  localStorage.setItem("explored", "yes");
  sessionStorage.setItem("explored", "yes");
});
await context.newPage();
await page.goto(new URL("/deep", page.url()).href);
return true;`,
);

interface Probe {
  readonly step: string;
  readonly path: string;
  readonly explored: string | null;
  readonly token: string | null;
  readonly tab: string | null;
  readonly cookies: readonly string[];
  readonly tabs: number;
}
const account = { username: "member@example.test", password: "fixture-password-41" };
/** The code the site sends during a passwordless sign-in. */
const signInCode = "482913";
const hostname = "www.start.test";
/** Another site the same server answers for, which a page on the site may frame. */
const elsewhere = "www.elsewhere.test";
const page = (response: ServerResponse, text: string) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(text);
};
const body = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
  });

/**
 * A local HTTPS site with a deep page, a sign-in and a probe the operations report to. Its
 * root sets no cookie, so a reset's root load keeps whatever session the reset left. The same
 * server answers as another site, whose code field a page on the site frames.
 */
const startSite = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-start-state-"));
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    `/CN=${hostname}`,
    "-days",
    "1",
  ]);
  const visits: string[] = [];
  const probes: Probe[] = [];
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", `https://${hostname}`).pathname;
        if (request.method === "POST" && path === "/probe") {
          probes.push(JSON.parse(await body(request)) as Probe);
          response.end();
          return;
        }
        // A passwordless sign-in: the identifier, then the code the site sent.
        if (request.method === "POST" && path === "/api/identify") {
          const sent = JSON.parse(await body(request)) as { readonly username?: unknown };
          response.writeHead(sent.username === account.username ? 200 : 401);
          response.end("{}");
          return;
        }
        if (request.method === "POST" && path === "/api/verify") {
          const sent = JSON.parse(await body(request)) as { readonly code?: unknown };
          const matches = sent.code === signInCode;
          response.writeHead(matches ? 200 : 401, {
            "content-type": "application/json",
            ...(matches ? { "set-cookie": "member=signed; Path=/; Secure; HttpOnly" } : {}),
          });
          response.end("{}");
          return;
        }
        if (request.method === "POST" && path === "/api/login") {
          const sent: unknown = JSON.parse(await body(request));
          const matches = JSON.stringify(sent) === JSON.stringify(account);
          response.writeHead(matches ? 200 : 401, {
            "content-type": "application/json",
            ...(matches ? { "set-cookie": "member=signed; Path=/; Secure; HttpOnly" } : {}),
          });
          response.end("{}");
          return;
        }
        visits.push(path);
        if (path === "/login")
          return page(
            response,
            `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>
<script>document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const sent=await fetch('/api/login',{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});if(sent.ok){localStorage.setItem('token','member');location.href='/account'}})</script>`,
          );
        // A sign-in that submits itself once the password is typed, and removes its own form.
        if (path === "/login-self")
          return page(
            response,
            `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>
<script>const form=document.querySelector('#login');form.password.addEventListener('input',()=>form.requestSubmit());form.addEventListener('submit',async event=>{event.preventDefault();const data=new FormData(form);form.replaceWith(Object.assign(document.createElement('p'),{textContent:'Signing in'}));const sent=await fetch('/api/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})});if(sent.ok){localStorage.setItem('token','member');location.href='/account'}})</script>`,
          );
        if (path === "/login-code")
          return page(
            response,
            `<title>Sign in</title><form id="identify"><input name="username"><button>Continue</button></form><form id="verify" hidden><input name="code" autocomplete="one-time-code"><button id="verify-button">Verify</button></form>
<script>document.querySelector('#identify').addEventListener('submit',async event=>{event.preventDefault();const sent=await fetch('/api/identify',{method:'POST',body:JSON.stringify({username:new FormData(event.target).get('username')})});if(sent.ok){event.target.hidden=true;document.querySelector('#verify').hidden=false}});document.querySelector('#verify').addEventListener('submit',async event=>{event.preventDefault();const sent=await fetch('/api/verify',{method:'POST',body:JSON.stringify({code:new FormData(event.target).get('code')})});if(sent.ok){localStorage.setItem('token','member');location.href='/account'}})</script>`,
          );
        // A code screen that sends itself the moment the sixth digit is typed.
        if (path === "/verify-code") {
          const sent = new URL(request.url ?? "/", "https://fixture").searchParams.get("code");
          const matches = sent === signInCode;
          response.writeHead(302, {
            location: matches ? "/account" : "/login-code-self",
            ...(matches ? { "set-cookie": "member=signed; Path=/; Secure; HttpOnly" } : {}),
          });
          response.end();
          return;
        }
        if (path === "/login-code-self")
          return page(
            response,
            `<title>Sign in</title><form id="identify"><input name="username"><button>Continue</button></form><form id="verify" action="/verify-code" hidden><input name="code" autocomplete="one-time-code"></form>
<script>document.querySelector('#identify').addEventListener('submit',async event=>{event.preventDefault();const sent=await fetch('/api/identify',{method:'POST',body:JSON.stringify({username:new FormData(event.target).get('username')})});if(sent.ok){event.target.hidden=true;document.querySelector('#verify').hidden=false}});const verify=document.querySelector('#verify');verify.code.addEventListener('input',()=>{if(verify.code.value.length===6)verify.submit()})</script>`,
          );
        if (path === "/framed")
          return page(
            response,
            `<title>Framed</title><iframe src="https://${elsewhere}:${request.socket.localPort}/code-frame"></iframe>`,
          );
        if (path === "/code-frame")
          return page(response, `<title>Code</title><input name="code">`);
        if (path === "/account")
          return page(
            response,
            request.headers.cookie?.includes("member=signed")
              ? `<title>Account</title><p id="account">Signed in</p>`
              : `<title>Account</title><p id="signed-out">Please sign in</p>`,
          );
        return page(response, `<title>${path}</title><h1>${path}</h1>`);
      })().catch(() => response.destroy());
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${hostname} 127.0.0.1, MAP ${elsewhere} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  return {
    origin: `https://${hostname}:${address.port}`,
    elsewhere: `https://${elsewhere}:${address.port}`,
    endpoint: browser.wsEndpoint(),
    visits,
    probes,
    probe: (step: string) => {
      const found = probes.find((entry) => entry.step === step);
      if (found === undefined) throw new Error(`No ${step} probe in ${JSON.stringify(probes)}`);
      return found;
    },
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
};
type Site = Awaited<ReturnType<typeof startSite>>;

/** Mints with the scripted steps, then runs the published probe on `runUrl` when given. */
const build = (
  site: Site,
  request: {
    readonly url: string;
    readonly effect: "read" | "write";
    readonly authenticationOrigins?: readonly string[];
  },
  steps: readonly ((request: ModelRequest) => Output)[],
  runUrl?: string,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createPomerado({
          browser: { endpoint: site.endpoint },
          minterProvider: provider((model, index) => steps[index]?.(model) ?? [message("Done.")]),
          guardianProvider: guardian(),
          ask: makeInputAsker((asked) =>
            Effect.succeed(
              Object.fromEntries(
                asked.questions.map((question) => [
                  question.id,
                  question.id === "username"
                    ? account.username
                    : question.id === "code"
                      ? signInCode
                      : account.password,
                ]),
              ),
            ),
          ),
          timeoutMs: 40_000,
        });
        const built = yield* service.mint({
          ...request,
          intent: "Report where the page starts",
          input: {},
        });
        if (runUrl === undefined) return built;
        const artifact: MintArtifact | undefined = built.artifact;
        if (artifact === undefined) throw new Error(JSON.stringify(built));
        yield* service.run(artifact, { url: runUrl, intent: "Report", input: {} });
        return built;
      }),
    ),
  ).finally(site.close);

const readSteps = (signIn: boolean) => [
  () =>
    patch({
      "explore/look.mjs": explore,
      "src/tool.mjs": operation("probe", probe("example")),
    }),
  ...(signIn
    ? [
        () =>
          [
            execution(
              "authenticate",
              "src/tool.mjs",
              {
                signInStep: {
                  fields: [
                    { selector: "input[name=username]", accepts: ["username"] },
                    { selector: "input[name=password]", slot: "password" },
                  ],
                  submit: "button",
                },
              },
              "sign_in",
            ),
          ] as Output,
        () =>
          [
            execution(
              "authenticate",
              "src/tool.mjs",
              { signInStep: { signedIn: { selector: "#account" } } },
              "signed_in",
            ),
          ] as Output,
      ]
    : []),
  () => [execution("explore", "explore/look.mjs")] as Output,
  () => [execution("example", "src/tool.mjs")] as Output,
  finish,
];

test("a signed-out build's example starts clean at the site root, and a run starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/entry`, effect: "read" },
    readSteps(false),
    `${site.origin}/entry`,
  );
  expect(built.build).toBe("published");
  // The first live step still loads the request's URL. The reset's blank root sends no request,
  // so the example and the run each load the root once.
  expect(site.visits).toEqual(["/entry", "/deep", "/", "/"]);
  const [example, run] = site.probes;
  expect(example).toMatchObject({
    path: "/",
    cookies: [],
    explored: null,
    tab: null,
    tabs: 1,
  });
  expect(run).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a signed-in build's example starts at the root with the session saved after sign-in", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login`, effect: "read" },
    readSteps(true),
    `${site.origin}/deep`,
  );
  expect(built.build).toBe("published");
  expect(site.visits).toEqual(["/login", "/account", "/deep", "/", "/"]);
  const [example, run] = site.probes;
  // The sign-in's cookie and storage come back; exploration's do not.
  expect(example).toMatchObject({
    path: "/",
    cookies: ["member"],
    explored: null,
    token: "member",
    tab: null,
    tabs: 1,
  });
  // A run keeps the browser's session and loads the root, whatever the request's path.
  expect(run).toMatchObject({ path: "/", cookies: ["member"], token: "member", tabs: 1 });
});

test("a write session's first step starts clean at the root, and the next continues", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  await build(site, { url: `${site.origin}/entry`, effect: "write" }, [
    () =>
      patch({
        "explore/look.mjs": explore,
        "src/act.mjs": operation(
          "first_step",
          probe("first", 'await page.goto(new URL("/form", page.url()).href);'),
        ),
        "src/next.mjs": operation("next_step", probe("next")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [execution("act", "src/act.mjs")],
    () => [execution("act", "src/next.mjs")],
  ]);
  expect(site.visits[0]).toBe("/entry");
  expect(site.probe("first")).toMatchObject({
    path: "/",
    cookies: [],
    explored: null,
    tab: null,
    tabs: 1,
  });
  // A later step continues the page the previous step left.
  expect(site.probe("next")).toMatchObject({ path: "/form", cookies: [], tabs: 1 });
});

test("each live test starts clean at the root, as the example does", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(site, { url: `${site.origin}/entry`, effect: "read" }, [
    () =>
      patch({
        "explore/look.mjs": explore,
        // The test leaves state of its own, which the example must not see either.
        "test/check.mjs": operation("check", probe("test")),
        "src/tool.mjs": operation("probe", probe("example")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [execution("test", "test/check.mjs")],
    () => [execution("test", "explore/look.mjs", {}, "test_leaves_state")],
    () => [execution("example", "src/tool.mjs")],
    finish,
  ]);
  expect(built.build).toBe("published");
  expect(site.probe("test")).toMatchObject({ path: "/", cookies: [], explored: null, tabs: 1 });
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: [],
    explored: null,
    tab: null,
    tabs: 1,
  });
});

test("a page that shows the account before any sign-in leaves the example signed out", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const checked: Record<string, unknown>[] = [];
  await build(site, { url: `${site.origin}/entry`, effect: "read" }, [
    () =>
      patch({
        // Exploration sets the site's member cookie itself, so its account page shows the account.
        "explore/look.mjs": operation(
          "look",
          `await page.evaluate(() => { document.cookie = "member=signed; path=/"; });
await page.goto(new URL("/account", page.url()).href);
return true;`,
        ),
        "src/tool.mjs": operation("probe", probe("example")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [
      execution(
        "authenticate",
        "src/tool.mjs",
        { signInStep: { signedIn: { selector: "#account" } } },
        "signed_in",
      ),
    ],
    (request) => {
      checked.push(...objects(request.input).filter((item) => "signedIn" in item));
      return [execution("example", "src/tool.mjs")];
    },
    finish,
  ]);
  // No sign-in step sent the login, so the host does not take the page as signed in.
  expect(checked).toContainEqual(
    expect.objectContaining({ signedIn: false, failed: "credentials_not_submitted" }),
  );
  expect(site.probe("example")).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a sign-in whose page submits its own form still counts, and the example keeps it", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const seen: Record<string, unknown>[] = [];
  const steps = readSteps(true).map(
    (respond) => (request: ModelRequest) => {
      seen.push(...objects(request.input).filter((item) => "submit" in item || "signedIn" in item));
      return respond(request);
    },
  );
  await build(site, { url: `${site.origin}/login-self`, effect: "read" }, steps);
  // The page sent the login itself, so the host found no submit to click after typing.
  expect(seen).toContainEqual(expect.objectContaining({ outcome: "filled", submit: "refused" }));
  expect(seen).toContainEqual(expect.objectContaining({ signedIn: true }));
  expect(site.visits.slice(0, 2)).toEqual(["/login-self", "/account"]);
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["member"],
    explored: null,
    token: "member",
    tabs: 1,
  });
});

test("a build whose first live step is its example starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  await build(site, { url: `${site.origin}/entry`, effect: "read" }, [
    () => patch({ "src/tool.mjs": operation("probe", probe("example")) }),
    () => [execution("example", "src/tool.mjs")],
    finish,
  ]);
  // The request's URL is never loaded: the reset's root is the first page the site serves.
  expect(site.visits).toEqual(["/"]);
  expect(site.probe("example")).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a write build whose first live step is its act starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  await build(site, { url: `${site.origin}/entry`, effect: "write" }, [
    () => patch({ "src/act.mjs": operation("first_step", probe("first")) }),
    () => [execution("act", "src/act.mjs")],
  ]);
  expect(site.visits).toEqual(["/"]);
  expect(site.probe("first")).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a check again after a confirmed sign-in is refused and drops the saved session", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const checked: Record<string, unknown>[] = [];
  const [patched, signIn, check, explored, example, finished] = readSteps(true);
  if (!patched || !signIn || !check || !explored || !example || !finished)
    throw new Error("Unexpected read steps");
  await build(site, { url: `${site.origin}/login`, effect: "read" }, [
    patched,
    signIn,
    check,
    explored,
    () => [
      execution(
        "authenticate",
        "src/tool.mjs",
        { signInStep: { signedIn: { selector: "#account" } } },
        "signed_in_again",
      ),
    ],
    (request) => {
      checked.push(...objects(request.input).filter((item) => "failed" in item));
      return example(request);
    },
    finished,
  ]);
  // The check starts a new sign-in that sent nothing, so it is refused, like any first check.
  expect(checked).toContainEqual(
    expect.objectContaining({ signedIn: false, failed: "credentials_not_submitted" }),
  );
  // Nothing saved describes the browser any more: the example keeps its cookies and storage.
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tabs: 1,
  });
});

/** Types the code the agent was given into the code screen, then waits for the account page. */
const typeCode = operation(
  "code",
  "await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.locator('#verify-button').click(); await page.locator('#account').waitFor({ timeout: 5000 }); return true;",
);
/** Makes the page show an account without any sign-in: a cookie of its own, then the page. */
const forge = `await page.evaluate(() => { document.cookie = "member=signed; path=/"; localStorage.setItem("token", "member"); });
await page.goto(new URL("/account", page.url()).href);`;

/**
 * A passwordless sign-in: the host fills the identifier, the agent asks for the code the site
 * sent, writes `files` once the code's handle is issued, runs `explores`, then checks, explores
 * and runs its example.
 */
const passwordlessSteps = (
  files: Readonly<Record<string, string>>,
  explores: readonly string[],
): readonly ((request: ModelRequest) => Output)[] => [
  () =>
    patch({
      "explore/look.mjs": explore,
      "src/tool.mjs": operation("probe", probe("example")),
    }),
  () =>
    [
      execution(
        "authenticate",
        "src/tool.mjs",
        {
          signInStep: {
            fields: [{ selector: "#identify input[name=username]", accepts: ["username"] }],
            submit: "#identify button",
          },
        },
        "sign_in",
      ),
    ] as Output,
  // The code the site sent for this sign-in, asked by the agent.
  () =>
    [
      call("request_input", {
        intent: "Ask for the code the site sent to finish signing in",
        questions: [
          {
            id: "code",
            type: "secret",
            secretKind: "one_time_code",
            prompt: "Enter the code the site sent you to finish signing in.",
          },
        ],
      }),
    ] as Output,
  // Written once its handle is issued: a handle the attempt never issued refuses every execution.
  () => patch(files).map((item, index) => ({ ...item, callId: `patch_code_${index}` })),
  ...explores.map((entrypoint) => () => [execution("explore", entrypoint)] as Output),
  () =>
    [
      execution(
        "authenticate",
        "src/tool.mjs",
        { signInStep: { signedIn: { selector: "#account" } } },
        "signed_in",
      ),
    ] as Output,
  () => [execution("explore", "explore/look.mjs")] as Output,
  () => [execution("example", "src/tool.mjs")] as Output,
  finish,
];

test("a code the agent types into a passwordless sign-in's code screen counts as its proof", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login-code`, effect: "read" },
    passwordlessSteps({ "explore/code.mjs": typeCode }, ["explore/code.mjs"]),
  );
  expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
  // The check counted the sign-in, so the example gets back the session saved after it.
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["member"],
    explored: null,
    token: "member",
    tabs: 1,
  });
});

/** Code that holds a handle may not evaluate in the page, so this sets the cookie on the context. */
const forgeByContext =
  "await context.addCookies([{ name: 'member', value: 'signed', url: new URL(page.url()).origin }]); await page.goto(new URL('/account', page.url()).href);";
/** An operation module that runs `code` in the page once, after `before` in the module. */
const module = (code: string, before = "", imports = "") => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
${imports}
export default defineOperation({name:"forge",input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  ${before}
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(code)},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
const forgeOperation = operation("forge", `${forge}\nreturn true;`);
/** Types the code into the other site's field, framed by a page on the site, then forges. */
const typeInFrame = `await page.goto(new URL('/framed', page.url()).href); await page.frameLocator('iframe').locator('input[name=code]').fill('{{secret.s1}}'); ${forgeByContext} return true;`;

for (const [name, files, explores] of [
  [
    "sits in a file that never ran",
    { "explore/code.mjs": typeCode, "explore/forge.mjs": forgeOperation },
    ["explore/forge.mjs"],
  ],
  [
    "sits in a file that never ran, beside an explore with a computed import",
    {
      "explore/code.mjs": typeCode,
      "explore/forge.mjs": module(
        `${forge}\nreturn true;`,
        'const target = ["./no", "ne.mjs"].join(""); if (sessionId === "") await import(target);',
      ),
    },
    ["explore/forge.mjs"],
  ],
  [
    "sits in a file that never ran, in a workspace with a package.json",
    {
      "explore/code.mjs": typeCode,
      "explore/forge.mjs": forgeOperation,
      "scratch/package.json": "{}",
    },
    ["explore/forge.mjs"],
  ],
  [
    "sits in a helper the explore imports but never calls",
    {
      "explore/helper.mjs": `export const typeCode = (kernel, sessionId) => kernel.browsers.playwright.execute(sessionId, { code: ${JSON.stringify("await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.locator('#verify-button').click(); return true;")}, timeout_sec: 15 });`,
      "explore/forge.mjs": module(
        `${forge}\nreturn true;`,
        "void typeCode;",
        'import { typeCode } from "./helper.mjs";',
      ),
    },
    ["explore/forge.mjs"],
  ],
  [
    "was typed into a page of the explore's own off the site",
    {
      "explore/code.mjs": operation(
        "code",
        `const site = page.url(); await page.goto('data:text/html,<input name=code>'); await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.goto(site); ${forgeByContext} return true;`,
      ),
    },
    ["explore/code.mjs"],
  ],
  [
    "was typed into another site's frame on the site's page",
    { "explore/code.mjs": operation("code", typeInFrame) },
    ["explore/code.mjs"],
  ],
  [
    "never reached a field, in a fill whose failure the explore caught",
    {
      "explore/code.mjs": operation(
        "code",
        `try { await page.locator('#no-such-field').fill('{{secret.s1}}', { timeout: 1000 }); } catch {} ${forgeByContext} return true;`,
      ),
    },
    ["explore/code.mjs"],
  ],
  [
    "comes after the explore failed",
    {
      "explore/code.mjs": operation(
        "code",
        `${forgeByContext} throw new Error('Stopped before the code'); await page.locator('input[name=code]').fill('{{secret.s1}}');`,
      ),
    },
    ["explore/code.mjs"],
  ],
] as const)
  test(`a sign-in code that ${name} is no proof, so a page showing an account leaves the example signed out`, async () => {
    test.setTimeout(90_000);
    const site = await startSite();
    const built = await build(
      site,
      { url: `${site.origin}/login-code`, effect: "read" },
      passwordlessSteps(files, explores),
    );
    expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
    // The check was refused, so the build never signed in and the example starts clean.
    expect(site.probe("example")).toMatchObject({
      path: "/",
      cookies: [],
      explored: null,
      token: null,
      tabs: 1,
    });
  });

test("a code typed into a frame on a configured sign-in origin counts as typed on the site", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    {
      url: `${site.origin}/login-code`,
      effect: "read",
      authenticationOrigins: [site.elsewhere],
    },
    passwordlessSteps({ "explore/code.mjs": operation("code", typeInFrame) }, [
      "explore/code.mjs",
    ]),
  );
  expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
  // The same explore as the frame above, but that origin is where this site signs in.
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["member"],
    explored: null,
    token: null,
    tabs: 1,
  });
});

test("a code typed into a code screen that sends itself at once counts as its proof", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login-code-self`, effect: "read" },
    passwordlessSteps(
      {
        "explore/code.mjs": operation(
          "code",
          "await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.locator('#account').waitFor({ timeout: 5000 }); return true;",
        ),
      },
      ["explore/code.mjs"],
    ),
  );
  expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["member"],
    explored: null,
    token: null,
    tabs: 1,
  });
});
