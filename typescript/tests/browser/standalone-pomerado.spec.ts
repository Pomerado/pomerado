import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { mkdtemp, readdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startShop, shopAccount } from "./shop-fixture.js";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import { InputRequest as InputRequestSchema } from "../../src/runtime/input-request.js";
import { makeMcpJobs } from "../../src/standalone/mcp-jobs.js";
import { prepareIntegration } from "../../src/standalone/mcp-package.js";
import { writeArtifact } from "../../src/standalone/artifact-files.js";

const message = (text: string): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const call = (name: string, input: unknown, callId = name): ModelResponse["output"][number] => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const provider = (
  respond: (request: ModelRequest, index: number) => ModelResponse["output"],
  requests: ModelRequest[],
): ModelProvider => ({
  getModel: () => ({
    getResponse: async (request) => {
      requests.push(request);
      return { usage: new Usage(), output: respond(request, requests.length - 1) };
    },
    getStreamedResponse: () => {
      throw new Error("Fixture does not stream");
    },
  }),
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
/** The standalone host tells Guardian it runs natively. A hosted review gets the hosted policy. */
const reviewedNative = (request: ModelRequest) =>
  objects(request.input).find((item) => "trusted_execution_environment" in item)?.[
    "trusted_execution_environment"
  ] === "native";
const guardian = (
  requests: ModelRequest[],
  outcome: "allow" | "deny" | ((request: ModelRequest) => "allow" | "deny") = "allow",
) => {
  let sourcePending = false;
  return provider((request, index) => {
    const current = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    if (current !== undefined && "question_review" in current)
      return [
        message(
          JSON.stringify({ outcome: "allow_business", rationale: "Caller chooses read authority" }),
        ),
      ];
    if (sourcePending) {
      sourcePending = false;
      const decided = typeof outcome === "function" ? outcome(request) : outcome;
      return [
        message(
          JSON.stringify({
            outcome: reviewedNative(request) ? decided : "deny",
            rationale: "Recorded fixture review",
          }),
        ),
      ];
    }
    sourcePending = true;
    const submission = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    const pending = objects(submission).find((item) => typeof item["entrypoint"] === "string");
    if (pending === undefined)
      throw new Error("Guardian did not receive its original review input");
    return [call("read_source", { path: pending["entrypoint"], offset: 0 }, `source_${index}`)];
  }, requests);
};
const operation = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
import { heading } from "./heading.mjs";
export default defineOperation({name:"read_fixture",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:2});
  if(!response.success) throw new Error(String(response.error));
  return {heading:heading(response.result)};
});`;
const patch = (authentication = false): ModelResponse["output"] =>
  [
    [
      "src/tool.mjs",
      authentication
        ? operation.replace("await page.locator('h1').textContent()", "await page.title()")
        : operation,
    ],
    ["src/heading.mjs", "export const heading = (value) => String(value).trim();"],
  ].map(([path, content], index) => ({
    type: "apply_patch_call",
    callId: `patch_${index}`,
    status: "completed",
    operation: {
      type: "create_file",
      path: path ?? "",
      diff:
        (content ?? "")
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n") + "\n",
    },
  }));
const execution = {
  purpose: "example",
  target: "liveBrowser",
  entrypoint: "src/tool.mjs",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 10,
  intent: "Read the fixture heading",
};
const minter = (requests: ModelRequest[], authentication = false) =>
  provider((request, index) => {
    const steps: ModelResponse["output"][] = [];
    if (!authentication)
      steps.push([
        call("request_input", {
          intent: "Ask caller whether this tool reads or changes the site",
          questions: [
            {
              id: "effect",
              type: "choice",
              prompt: "Should this tool read the site or change it?",
              options: [
                { id: "read", label: "Read" },
                { id: "write", label: "Change" },
              ],
            },
          ],
        }),
      ]);
    steps.push(patch(authentication));
    if (authentication)
      steps.push(
        [
          call(
            "execute",
            {
              ...execution,
              purpose: "authenticate",
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
        ],
        [
          call(
            "execute",
            {
              ...execution,
              purpose: "authenticate",
              signInStep: { signedIn: { selector: "#account" } },
            },
            "signed_in",
          ),
        ],
      );
    steps.push([call("execute", execution, "example")]);
    if (index < steps.length) return steps[index] ?? [];
    if (index === steps.length) {
      const receipts = objects(request.input).filter(
        (item) => typeof item["executionId"] === "string",
      );
      const receipt = receipts.at(-1);
      if (receipt === undefined) throw new Error("Original execute tool did not return a receipt");
      return [
        call("finish_build", {
          intent: "Return the fixture integration",
          entrypoint: "src/tool.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "read_fixture", description: "Read local fixture heading" },
          coverage: "Actual native browser example",
        }),
      ];
    }
    return [message("Built the fixture integration.")];
  }, requests);

for (const authentication of [false, true]) {
  test(`original SDKs mint a multi-file ${authentication ? "authenticated" : "public"} integration and run it`, async () => {
    test.info().annotations.push({
      type: "slow",
      description:
        "Original SDKs, Chromium and local operation lifecycles; default-effect answer waits11s beyond its injected10s active budget to verify caller waiting is excluded",
    });
    test.setTimeout(45_000);
    const log: string[] = [];
    const server = createServer((request, response) => {
      log.push(request.url ?? "");
      response.setHeader("Content-Type", "text/html");
      response.end(
        authentication && !request.headers.cookie?.includes("signed=yes")
          ? `<label>User<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="signin" onclick="document.cookie='signed=yes;path=/';document.body.innerHTML='<div id=signed-in>Signed in</div><h1>Account fixture</h1>';fetch('/signed-in')">Sign in</button>`
          : `<h1>${authentication ? "Account" : "Public"} fixture</h1>`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const fixtureURL = `http://127.0.0.1:${address.port}/`;
    const directory = await mkdtemp(join(tmpdir(), "pomerado-standalone-"));
    const shop = authentication ? await startShop(directory) : undefined;
    const url = shop === undefined ? fixtureURL : `${shop.origin}/login`;
    const remote =
      shop === undefined
        ? undefined
        : await chromium.launchServer({
            args: [
              `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
              "--no-proxy-server",
              "--ignore-certificate-errors",
            ],
          });
    const mintRequests: ModelRequest[] = [];
    const reviewRequests: ModelRequest[] = [];
    const asked: InputRequest[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createPomerado({
              ...(remote === undefined ? {} : { browser: { endpoint: remote.wsEndpoint() } }),
              minterProvider: minter(mintRequests, authentication),
              guardianProvider: guardian(reviewRequests),
              ask: makeInputAsker((request) =>
                Effect.sleep(authentication ? 0 : 11_000).pipe(
                  Effect.zipRight(
                    Effect.sync(() => {
                      asked.push(request);
                      return Object.fromEntries(
                        request.questions.map((question) => [
                          question.id,
                          question.id === "effect"
                            ? "read"
                            : question.id === "username"
                              ? shopAccount.username
                              : shopAccount.password,
                        ]),
                      );
                    }),
                  ),
                ),
              ),
              timeoutMs: authentication ? 30_000 : 10_000,
            });
            const built = yield* service.mint({
              url,
              intent: "Read the fixture heading",
              ...(authentication ? { effect: "read" as const } : {}),
              input: {},
            });
            expect(
              built.build,
              JSON.stringify({
                built,
                toolResults: objects(mintRequests.at(-1)?.input).filter(
                  (item) => item["type"] === "function_call_result",
                ),
              }),
            ).toBe("published");
            expect(built.artifact?.files.map((file) => file.path)).toEqual(
              expect.arrayContaining(["src/tool.mjs", "src/heading.mjs"]),
            );
            if (built.artifact === undefined) throw new Error(JSON.stringify(built));
            const modelRequests = [mintRequests.length, reviewRequests.length];
            expect(
              yield* service.run(built.artifact, {
                url: shop === undefined ? url : `${shop.origin}/account`,
                intent: "Read the fixture heading",
                input: {},
              }),
            ).toEqual({ heading: authentication ? "Account" : "Public fixture" });
            // Guardian reviewed the source while minting. The run makes no model request.
            expect([mintRequests.length, reviewRequests.length]).toEqual(modelRequests);
            expect(JSON.stringify(built)).not.toContain(shopAccount.password);
          }),
        ),
      );
      expect(asked).toHaveLength(1);
      expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
      expect(JSON.stringify(reviewRequests)).not.toContain(shopAccount.password);
      if (shop !== undefined) expect(shop.state.loginPosts).toBe(1);
    } finally {
      await remote?.close();
      await shop?.close();
      await rm(directory, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

/** Records and fails any model request, as a host without a model key or provider would. */
const unreachableModel = (calls: string[], role: string): ModelProvider => ({
  getModel: () => {
    calls.push(role);
    throw new Error(`Unexpected ${role} model request during a run`);
  },
});

test("a run makes no Guardian or model call and returns the operation's output", async () => {
  let hits = 0;
  const calls: string[] = [];
  const server = createServer((_request, response) => {
    hits++;
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Run fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  try {
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel(calls, "minter"),
            guardianProvider: unreachableModel(calls, "guardian"),
            timeoutMs: 10_000,
          });
          return yield* service.run(
            {
              entrypoint: "src/tool.mjs",
              files: [
                { path: "src/tool.mjs", content: operation },
                {
                  path: "src/heading.mjs",
                  content: "export const heading = (value) => String(value).trim();",
                },
              ],
              inputSchema: {},
              outputSchema: {},
            },
            {
              url: `http://127.0.0.1:${address.port}/`,
              intent: "Read fixture",
              effect: "read",
              input: {},
            },
          );
        }),
      ),
    );
    expect(output).toEqual({ heading: "Run fixture" });
    expect(calls).toEqual([]);
    expect(hits).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("terminal CLI help requires no provider credentials", async () => {
  const child = spawn(process.execPath, ["dist/typescript/src/standalone/cli.js", "--help"], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  const code = closed[0];
  expect(code, errors).toBe(0);
  expect(output).toContain("pomerado mint --url URL");
  expect(output).toContain("A run ignores --intent and --effect.");
});

/** Runs the built terminal CLI with only PATH, so it has no model key or provider. */
const terminal = async (args: readonly string[]) => {
  const child = spawn(process.execPath, ["dist/typescript/src/standalone/cli.js", ...args], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  return { code: closed[0], stdout, stderr };
};

test("terminal run needs no model key, provider or intent", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Terminal fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const directory = await mkdtemp(join(tmpdir(), "pomerado-cli-run-"));
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    await Effect.runPromise(
      Effect.scoped(
        writeArtifact(join(directory, "artifact"), {
          entrypoint: "src/tool.mjs",
          files: [
            { path: "src/tool.mjs", content: operation },
            {
              path: "src/heading.mjs",
              content: "export const heading = (value) => String(value).trim();",
            },
          ],
          inputSchema: {},
          outputSchema: {},
        }),
      ),
    );
    // A run ignores --effect, so even the mint-only value ask is accepted.
    const ran = await terminal([
      "run",
      "--artifact",
      join(directory, "artifact"),
      "--url",
      url,
      "--effect",
      "ask",
    ]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ heading: "Terminal fixture" });
    const minted = await terminal(["mint", "--url", url, "--out", join(directory, "minted")]);
    expect(minted.code).toBe(1);
    expect(minted.stderr).toContain("--intent is required to mint.");
    expect(await readdir(directory)).toEqual(["artifact"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal EOF ends an ordinary unanswered question", async () => {
  const script = `import { Effect } from "effect";
import { makeTerminalAsker } from "./dist/typescript/src/inputs/terminal.js";
const result = await Effect.runPromise(Effect.either(makeTerminalAsker()({id:"11111111-1111-4111-8111-111111111111",source:"system",questions:[{id:"name",type:"text",prompt:"Name?"}]})));
console.log(result._tag === "Left" ? result.left.code : "unexpected_answer");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  expect(closed[0]).toBe(0);
  expect(output.trim()).toBe("NoResponse");
});

test("confirmed native write finishes a composed artifact after invalid output without replay", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original model SDKs, native write confirmation and offline contract child; a real POST proves no write replay",
  });
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/save") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(() => document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No write fixture address");
  const act = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},
async ({kernel,sessionId,enteringCommit,verified}) => {
  enteringCommit("save");
  const result = await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
  if(!result.success || result.result !== true) throw new Error("Save not confirmed");
  verified({confirmation:"message"});
  return {saved:"invalid_output_after_confirmed_commit"};
});`;
  const final = act.replace('"invalid_output_after_confirmed_commit"', "true");
  const requests: ModelRequest[] = [];
  const patchSource = (path: string, content: string, id: string): ModelResponse["output"] => [
    {
      type: "apply_patch_call",
      callId: id,
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
    },
  ];
  const model = provider((request, index) => {
    if (index === 0) return patchSource("src/act.mjs", act, "act_source");
    if (index === 1)
      return [
        call(
          "execute",
          { ...execution, purpose: "act", entrypoint: "src/act.mjs", intent: "Save exactly once" },
          "act_once",
        ),
      ];
    if (index === 2) return patchSource("src/final.mjs", final, "composed_source");
    if (index === 3) {
      const receipt = objects(request.input)
        .filter((item) => typeof item["executionId"] === "string")
        .at(-1);
      if (receipt === undefined) throw new Error("Confirmed act receipt missing");
      return [
        call("finish_build", {
          intent: "Return composed write without executing it",
          entrypoint: "src/final.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "save_fixture", description: "Save the fixture once" },
          coverage:
            "One live confirmed act; its invalid output was repaired in the composed contract",
        }),
      ];
    }
    return [message("Return the existing confirmed write artifact.")];
  }, requests);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            minterProvider: model,
            guardianProvider: guardian([]),
            ask: makeInputAsker(() => Effect.succeed({})),
          });
          const built = yield* service.mint({
            url: `http://127.0.0.1:${address.port}/`,
            intent: "Save the fixture once",
            effect: "write",
            input: {},
          });
          expect(
            built.build,
            JSON.stringify({
              built,
              results: objects(requests.at(-1)?.input).filter(
                (item) => item["type"] === "function_call_result",
              ),
            }),
          ).toBe("published");
          expect(built.artifact?.entrypoint).toBe("src/final.mjs");
          expect(built.executions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ status: "failed", effect: "verified" }),
            ]),
          );
          expect(writes).toBe(1);
        }),
      ),
    );
    expect(writes).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

// A tiny runtime override supplies recorded providers to the actual compiled stdio entrypoint.
// Saved launchers import the same module through their existing runtime-URL argument.
const mcpRuntime = async (
  directory: string,
  outputs: readonly (ModelResponse["output"] | null)[] = [],
  options: { deny?: boolean; endpoint?: string; timeoutMs?: number } = {},
) => {
  const file = join(directory, "recorded-runtime.mjs");
  const ledger = join(directory, "model-calls.txt");
  const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
  await writeFile(
    file,
    `import { startMcpCli as start } from ${JSON.stringify(runtime)};
import { Usage } from ${JSON.stringify(import.meta.resolve("@openai/agents"))};
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const outputs=${JSON.stringify(outputs)};
const objects=(value)=>{if(typeof value==='string'){try{return objects(JSON.parse(value));}catch{return [];}}if(Array.isArray(value))return value.flatMap(objects);if(value===null||typeof value!=='object')return [];return [value,...Object.values(value).flatMap(objects)];};
const response=(output)=>({usage:new Usage(),output});
const message=(value)=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]});
process.once('SIGTERM',()=>appendFileSync(${JSON.stringify(ledger)},'sigterm\\n'));
let index=0;let sourcePending=false;
const minterProvider={getModel:()=>({getResponse:async(request)=>{
appendFileSync(${JSON.stringify(ledger)},'minter\\n');
const recorded=outputs[index++];
if(recorded===undefined)throw new Error('Unexpected recorded minter request');
if(recorded!==null)return response(recorded);
const receipt=objects(request.input).filter(item=>typeof item.executionId==='string').at(-1);
if(!receipt)throw new Error('Missing actual execution receipt');
return response([{type:'function_call',name:'finish_build',callId:'finish',status:'completed',arguments:JSON.stringify({intent:'Return the actual integration',entrypoint:'src/tool.mjs',executionId:receipt.executionId,metadata:{name:'read_fixture',description:'Read local fixture'},coverage:'Actual native example'})}]);
},getStreamedResponse:()=>{throw new Error('Unused stream');}})};
const guardianProvider={getModel:()=>({getResponse:async(request)=>{
appendFileSync(${JSON.stringify(ledger)},'guardian\\n');
const current=objects(request.input).filter(item=>'submitted_call'in item).at(-1);
if(current&&'question_review'in current)return response([message({outcome:'allow_business',rationale:'Caller answers a fixture question'})]);
if(sourcePending){sourcePending=false;return response([message({outcome:${JSON.stringify(options.deny ? "deny" : "allow")},rationale:'Original Guardian fixture review'})]);}
sourcePending=true;return response([{type:'function_call',name:'read_source',callId:'source_'+index,status:'completed',arguments:JSON.stringify({path:objects(current).find(item=>typeof item.entrypoint==='string').entrypoint,offset:0})}]);
},getStreamedResponse:()=>{throw new Error('Unused stream');}})};
export const startMcpCli=(args)=>start(args,{policy:'Synthetic fixture policy {{ tenant_policy_config }}',minterProvider,guardianProvider,timeoutMs:${options.timeoutMs ?? 30_000},browser:${JSON.stringify(options.endpoint === undefined ? {} : { endpoint: options.endpoint })}});
if(process.argv[2]==='mint'||process.argv[2]==='serve')startMcpCli(process.argv.slice(2));
`,
  );
  return { file, ledger };
};
const stdioMcp = async (args: string[]) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "pomerado-browser-qa", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
  } catch (cause) {
    await transport.close();
    throw new Error(stderr, { cause });
  }
  return { client, transport, stderr: () => stderr };
};
const McpView = Schema.Struct({
  job_id: Schema.String,
  status: Schema.String,
  pending_input: Schema.optional(InputRequestSchema),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const viewOf = (result: unknown) =>
  Schema.decodeUnknownSync(McpView)(
    objects(result).find(
      (value) => typeof value["job_id"] === "string" && typeof value["status"] === "string",
    ),
  );
const observeMcp = async (client: Client, id: string, status: string) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const view = viewOf(
      await client.callTool({ name: "get_job", arguments: { job_id: id, wait_seconds: 1 } }),
    );
    if (view.status === status) return view;
    if (["failed", "cancelled", "completed"].includes(view.status))
      throw new Error(JSON.stringify(view));
  }
  throw new Error(`MCP job did not reach ${status}`);
};

test("MCP stdio discovers tools before browser or model activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-mcp-discovery-"));
  const fixture = await mcpRuntime(directory, [], { endpoint: "ws://127.0.0.1:1/unavailable" });
  const connection = await stdioMcp([fixture.file, "mint", "--root", directory]);
  try {
    const listed = await connection.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_job",
      "get_job",
      "mint",
      "provide_input",
    ]);
    await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await connection.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pomerado-mcp starts through a linked bin, as npm and npx install it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-mcp-bin-"));
  const bin = join(directory, "pomerado-mcp");
  await symlink(resolve("dist/typescript/src/standalone/mcp-cli.js"), bin);
  const connection = await stdioMcp([bin, "mint", "--root", join(directory, "integrations")]);
  try {
    const listed = await connection.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_job",
      "get_job",
      "mint",
      "provide_input",
    ]);
  } finally {
    await connection.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP mint input continues once into saved launcher and fresh business MCP", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Real original SDK mint, stdio child processes and a caller wait beyond the injected active budget",
  });
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "pomerado-mcp-mint-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Public fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing MCP fixture address");
  const url = `http://127.0.0.1:${address.port}/`;
  const fixture = await mcpRuntime(
    directory,
    [
      patch(),
      [
        call("request_input", {
          intent: "Ask caller for the fixture note",
          questions: [
            { id: "note", type: "text", prompt: "Which note should accompany this fixture?" },
          ],
        }),
      ],
      [call("execute", execution)],
      null,
    ],
    { timeoutMs: 10_000 },
  );
  const mint = await stdioMcp([fixture.file, "mint", "--root", directory]);
  try {
    const started = viewOf(
      await mint.client.callTool({
        name: "mint",
        arguments: {
          name: "read_fixture",
          url,
          intent: "Read public fixture",
          effect: "read",
          input: {},
        },
      }),
    );
    const pending = await observeMcp(mint.client, started.job_id, "input_required").catch(
      async (cause) => {
        throw new Error((await readFile(fixture.ledger, "utf8")) + mint.stderr(), { cause });
      },
    );
    const question = pending.pending_input;
    if (question === undefined) throw new Error("Missing actual MCP question");
    const invalid = await mint.client.callTool({
      name: "provide_input",
      arguments: { job_id: started.job_id, request_id: question.id, answers: { note: 42 } },
    });
    expect(invalid.isError).toBe(true);
    await Effect.runPromise(Effect.sleep(11_000));
    await mint.client.callTool({
      name: "provide_input",
      arguments: {
        job_id: started.job_id,
        request_id: question.id,
        answers: { note: "Approved fixture" },
      },
    });
    const stale = await mint.client.callTool({
      name: "provide_input",
      arguments: {
        job_id: started.job_id,
        request_id: question.id,
        answers: { note: "Duplicate" },
      },
    });
    expect(stale.isError).toBe(true);
    const completed = await observeMcp(mint.client, started.job_id, "completed");
    expect(objects(completed.output).find((value) => value["build"] === "published")).toBeDefined();
    const saved = join(directory, "read_fixture");
    expect(JSON.parse(await readFile(join(saved, "deployment.json"), "utf8"))).toMatchObject({
      name: "read_fixture",
      request: { url, effect: "read" },
    });
    expect(JSON.parse(await readFile(join(saved, "mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        read_fixture: {
          command: process.execPath,
          args: [
            join(saved, "mcp.mjs"),
            pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href,
          ],
        },
      },
    });
    const metadata: unknown = JSON.parse(await readFile(join(saved, "pomerado.json"), "utf8"));
    expect(metadata).toMatchObject({
      files: expect.arrayContaining(["src/tool.mjs", "src/heading.mjs"]),
    });
    const generated = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
    try {
      expect((await generated.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "cancel_job",
        "get_job",
        "provide_input",
        "read_fixture",
      ]);
      const malformed = await generated.client.callTool({
        name: "read_fixture",
        arguments: { input: "wrong" },
      });
      expect(malformed.isError).toBe(true);
      const minted = await readFile(fixture.ledger, "utf8");
      const result = await generated.client.callTool({
        name: "read_fixture",
        arguments: { input: {} },
      });
      expect(
        objects(result).find((value) => value["heading"] === "Public fixture"),
        generated.stderr(),
      ).toBeDefined();
      // The served run adds no model request to the ledger the mint wrote.
      expect(await readFile(fixture.ledger, "utf8")).toBe(minted);
    } finally {
      await generated.client.close();
    }
  } finally {
    await mint.client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

const saveMcpFixture = (
  root: string,
  name: string,
  url: string,
  effect: "read" | "write",
  source: string,
  inputSchema: unknown = { type: "object", properties: {}, additionalProperties: false },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const publish = yield* prepareIntegration({
          root,
          name,
          request: { url, intent: "Operate local fixture", effect },
        });
        yield* publish({
          entrypoint: "src/tool.mjs",
          files: [{ path: "src/tool.mjs", content: source }],
          inputSchema,
          outputSchema: {
            type: "object",
            properties:
              effect === "write" ? { saved: { type: "boolean" } } : { heading: { type: "string" } },
            required: [effect === "write" ? "saved" : "heading"],
            additionalProperties: false,
          },
        });
        return join(root, name);
      }),
    ),
  );

test("MCP write polls and answers never resubmit and EOF closes its owned context", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Actual stdio SDK and three distinct native write lifecycles including cancellation and EOF",
  });
  test.setTimeout(60_000);
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing write address");
  const browserServer = await chromium.launchServer();
  const observer = await chromium.connect(browserServer.wsEndpoint());
  const cdp = await observer.newBrowserCDPSession();
  const contexts = async () => (await cdp.send("Target.getBrowserContexts")).browserContextIds;
  const directory = await mkdtemp(join(tmpdir(), "pomerado-mcp-write-"));
  const source = `import {Schema} from "effect";
import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]},questions:{continue:{type:"confirm",prompt:"Continue after this confirmed save?"}}},async({kernel,sessionId,enteringCommit,verified,ask})=>{
enteringCommit("save");const result=await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
if(!result.success||result.result!==true)throw new Error("Save not confirmed");verified({confirmation:"message"});await ask({continue:{}});return {saved:true};});`;
  const saved = await saveMcpFixture(
    directory,
    "save_fixture",
    `http://127.0.0.1:${address.port}/`,
    "write",
    source,
  );
  const fixture = await mcpRuntime(directory, [], { endpoint: browserServer.wsEndpoint() });
  const connection = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
  try {
    const first = viewOf(
      await connection.client.callTool({ name: "save_fixture", arguments: { input: {} } }),
    );
    expect(first.status, connection.stderr()).toBe("input_required");
    expect(writes).toBe(1);
    for (let i = 0; i < 3; i++)
      expect(
        viewOf(
          await connection.client.callTool({
            name: "get_job",
            arguments: { job_id: first.job_id, wait_seconds: 0 },
          }),
        ).status,
      ).toBe("input_required");
    expect(writes).toBe(1);
    if (!first.pending_input) throw new Error("No save question");
    await connection.client.callTool({
      name: "provide_input",
      arguments: {
        job_id: first.job_id,
        request_id: first.pending_input.id,
        answers: { continue: { confirmed: true } },
      },
    });
    expect((await observeMcp(connection.client, first.job_id, "completed")).output).toEqual({
      saved: true,
    });
    expect(writes).toBe(1);
    const second = viewOf(
      await connection.client.callTool({ name: "save_fixture", arguments: { input: {} } }),
    );
    expect(second.status).toBe("input_required");
    expect(writes).toBe(2);
    expect(
      viewOf(
        await connection.client.callTool({
          name: "cancel_job",
          arguments: { job_id: second.job_id },
        }),
      ).status,
    ).toBe("cancelled");
    expect(await contexts()).toEqual([]);
    expect(writes).toBe(2);
    const third = viewOf(
      await connection.client.callTool({ name: "save_fixture", arguments: { input: {} } }),
    );
    expect(third.status).toBe("input_required");
    expect(writes).toBe(3);
    expect((await contexts()).length).toBe(1);
    await connection.client.close();
    expect(await contexts()).toEqual([]);
    expect(writes).toBe(3);
    // The ledger would record a SIGTERM or any model request. A served run makes no model request.
    await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await connection.client.close();
    await cdp.detach();
    await observer.close();
    await browserServer.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP malformed saved schema fails before models and a served run calls no model", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Served</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing serve address");
  const directory = await mkdtemp(join(tmpdir(), "pomerado-mcp-serve-"));
  const url = `http://127.0.0.1:${address.port}/`;
  const source = operation.replace(
    'import { heading } from "./heading.mjs";',
    "const heading=value=>String(value);",
  );
  try {
    const malformed = await saveMcpFixture(directory, "invalid_fixture", url, "read", source, {
      type: "not_a_json_schema_type",
    });
    const invalidRuntime = await mcpRuntime(directory);
    await expect(
      stdioMcp([join(malformed, "mcp.mjs"), pathToFileURL(invalidRuntime.file).href]),
    ).rejects.toThrow();
    await expect(readFile(invalidRuntime.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(hits).toBe(0);
    const saved = await saveMcpFixture(directory, "served_fixture", url, "read", source);
    // The recorded Guardian denies every review and the ledger records any model request.
    const fixture = await mcpRuntime(directory, [], { deny: true });
    const connection = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
    try {
      const result = await connection.client.callTool({
        name: "served_fixture",
        arguments: { input: {} },
      });
      expect(result.isError, connection.stderr()).toBeFalsy();
      expect(result.structuredContent).toEqual({ heading: "Served" });
      expect(hits).toBeGreaterThan(0);
      await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await connection.client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("a generated integration serves and runs with no model key or provider", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Keyless</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing keyless address");
  const directory = await mkdtemp(join(tmpdir(), "pomerado-mcp-keyless-"));
  const source = operation.replace(
    'import { heading } from "./heading.mjs";',
    "const heading=value=>String(value);",
  );
  try {
    const saved = await saveMcpFixture(
      directory,
      "keyless_fixture",
      `http://127.0.0.1:${address.port}/`,
      "read",
      source,
    );
    // The installed runtime with its default configuration. stdioMcp passes only PATH, so the
    // server has no model key and no injected provider.
    const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
    const connection = await stdioMcp([join(saved, "mcp.mjs"), runtime]);
    try {
      expect((await connection.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "cancel_job",
        "get_job",
        "keyless_fixture",
        "provide_input",
      ]);
      const result = await connection.client.callTool({
        name: "keyless_fixture",
        arguments: { input: {} },
      });
      expect(result.isError, JSON.stringify(result) + connection.stderr()).toBeFalsy();
      expect(result.structuredContent).toEqual({ heading: "Keyless" });
    } finally {
      await connection.client.close();
    }
    // An unclassified run failure names no model, because a run makes no model request.
    const failing = await saveMcpFixture(
      directory,
      "failing_fixture",
      `http://127.0.0.1:${address.port}/`,
      "read",
      source.replace("const response =", 'throw new Error("Fixture failure"); const response ='),
    );
    const failed = await stdioMcp([join(failing, "mcp.mjs"), runtime]);
    try {
      const result = await failed.client.callTool({
        name: "failing_fixture",
        arguments: { input: {} },
      });
      expect(result.structuredContent, failed.stderr()).toMatchObject({
        status: "failed",
        error:
          "Operation failed. Check the local browser and integration configuration. A dispatched website action may have taken effect; this job will not be replayed.",
      });
    } finally {
      await failed.client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP concurrent original input callbacks remain answerable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1);
        const request = (id: string): InputRequest => ({
          id,
          source: "script",
          questions: [{ id: "note", type: "text", prompt: "A fixture note?" }],
        });
        const started = yield* jobs.start((ask) =>
          Effect.all(
            [
              ask(request("11111111-1111-4111-8111-111111111111")),
              ask(request("22222222-2222-4222-8222-222222222222")),
            ],
            { concurrency: "unbounded" },
          ),
        );
        for (let count = 0; count < 2; count++) {
          const pending = yield* jobs.get(started.job_id, 500);
          expect(pending.status).toBe("input_required");
          if (!pending.pending_input) throw new Error("Concurrent question orphaned");
          yield* jobs.provide(started.job_id, pending.pending_input.id, { note: "Answered" });
        }
        let final = yield* jobs.get(started.job_id, 500);
        for (let count = 0; count < 5 && final.status === "running"; count++)
          final = yield* jobs.get(started.job_id, 500);
        expect(final.status).toBe("completed");
      }),
    ),
  );
});

test("original owner intent authorizes a named off-site tenant while an unnamed tenant is refused", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original Guardian source review of a minting example and native browser navigation to the existing TLS shop on another registrable domain",
  });
  const directory = await mkdtemp(join(tmpdir(), "pomerado-owner-origin-"));
  const shop = await startShop(directory);
  let productHits = 0;
  const server = createServer((_request, response) => {
    productHits++;
    response.end("Product site");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No product fixture address");
  const remote = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  const target = `${shop.origin}/search`;
  const browserCode = `await page.goto(${JSON.stringify(target)}); return await page.title();`;
  const source = `import {Schema} from "effect";import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"tenant_title",input:Schema.Struct({}),output:Schema.Struct({title:Schema.String})},async({kernel,sessionId})=>{const result=await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(browserCode)},timeout_sec:3});if(!result.success)throw new Error(String(result.error));return {title:result.result};});`;
  const Authority = Schema.Struct({
    allowedOrigins: Schema.Array(Schema.String),
    ownerNamedOrigins: Schema.optional(Schema.Array(Schema.String)),
  });
  try {
    for (const named of [false, true]) {
      let inspected = false;
      const decisions: string[] = [];
      const reviewer = provider((request, index) => {
        const current = objects(request.input)
          .filter((item) => "submitted_call" in item)
          .at(-1);
        if (current === undefined) throw new Error("Missing original Guardian execution input");
        if (!inspected) {
          inspected = true;
          const submitted = Schema.decodeUnknownSync(Schema.Struct({ entrypoint: Schema.String }))(
            current["submitted_call"],
          );
          return [
            call(
              "read_source",
              { path: submitted.entrypoint, offset: 0 },
              `tenant_source_${index}`,
            ),
          ];
        }
        const authority = Schema.decodeUnknownSync(Authority)(current["trusted_authority"]);
        const readSource = objects(request.input).find(
          (item) => typeof item["source"] === "string" && item["source"].includes(shop.origin),
        );
        const allowed =
          reviewedNative(request) &&
          readSource !== undefined &&
          [...authority.allowedOrigins, ...(authority.ownerNamedOrigins ?? [])].includes(
            shop.origin,
          );
        decisions.push(allowed ? "allow" : "deny");
        return [
          message(
            JSON.stringify({
              outcome: allowed ? "allow" : "deny",
              rationale: allowed
                ? "The owner named their tenant for this read"
                : "The tenant was not named by the owner",
            }),
          ),
        ];
      }, []);
      // The minter writes the source, asks for one live example and then stops.
      const minterRequests: ModelRequest[] = [];
      const minter = provider((_request, index) => {
        if (index === 0)
          return [
            {
              type: "apply_patch_call",
              callId: "tenant_source",
              status: "completed",
              operation: {
                type: "create_file",
                path: "src/tool.mjs",
                diff:
                  source
                    .split("\n")
                    .map((line) => `+${line}`)
                    .join("\n") + "\n",
              },
            },
          ];
        if (index === 1)
          return [call("execute", { ...execution, intent: "Read the tenant page title" })];
        return [message("Stopped after the tenant example.")];
      }, minterRequests);
      const searchLoads = shop.state.searchPageLoads;
      const productLoads = productHits;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createPomerado({
              browser: { endpoint: remote.wsEndpoint() },
              minterProvider: minter,
              guardianProvider: reviewer,
              ask: makeInputAsker(() => Effect.succeed({})),
              timeoutMs: 10_000,
            });
            return yield* Effect.either(
              service.mint({
                url: `http://127.0.0.1:${address.port}/`,
                intent: named
                  ? `Read the page title of our tenant at ${target}.`
                  : "Read the tenant page title",
                effect: "read",
                input: {},
              }),
            );
          }),
        ),
      );
      expect(decisions, JSON.stringify(minterRequests.at(-1)?.input)).toEqual([
        named ? "allow" : "deny",
      ]);
      if (named) {
        expect(shop.state.searchPageLoads).toBe(searchLoads + 1);
      } else {
        expect(shop.state.searchPageLoads).toBe(searchLoads);
        expect(productHits).toBe(productLoads);
      }
    }
  } finally {
    await remote.close();
    await shop.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
