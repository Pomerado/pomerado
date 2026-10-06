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
const hostname = "www.start.test";
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
 * root sets no cookie, so a reset's root load keeps whatever session the reset left.
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
      `--host-resolver-rules=MAP ${hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  return {
    origin: `https://${hostname}:${address.port}`,
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
  request: { readonly url: string; readonly effect: "read" | "write" },
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
                  question.id === "username" ? account.username : account.password,
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

test("a signed-out build's example and run continue the page exploration left", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/entry`, effect: "read" },
    readSteps(false),
    `${site.origin}/entry`,
  );
  expect(built.build).toBe("published");
  // The first live step loads the request's URL.
  expect(site.visits[0]).toBe("/entry");
  const [example, run] = site.probes;
  expect(example).toMatchObject({
    path: "/deep",
    cookies: ["explored"],
    explored: "yes",
    tab: "yes",
    tabs: 2,
  });
  expect(run).toMatchObject({ path: "/entry", cookies: ["explored"], tabs: 2 });
});

test("a signed-in build's example and run continue the page exploration left", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login`, effect: "read" },
    readSteps(true),
    `${site.origin}/deep`,
  );
  expect(built.build).toBe("published");
  expect(site.visits[0]).toBe("/login");
  const [example, run] = site.probes;
  expect(example).toMatchObject({
    path: "/deep",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tab: "yes",
    tabs: 2,
  });
  expect(run).toMatchObject({ path: "/deep", cookies: ["explored", "member"], tabs: 2 });
});

test("a write session's first step continues the page exploration left", async () => {
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
    path: "/deep",
    cookies: ["explored"],
    explored: "yes",
    tab: "yes",
    tabs: 2,
  });
  // A later step continues the page the previous step left.
  expect(site.probe("next")).toMatchObject({ path: "/form", cookies: ["explored"], tabs: 2 });
});
