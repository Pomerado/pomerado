import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import type { MintArtifact } from "../../src/standalone/contracts.js";
import { startShop, shopAccount, type Shop } from "./shop-fixture.js";

// How a local build signs in today, on the shop's one-screen and two-screen sign-ins: what the
// host asks, what a later run does, and what a second screen's submit may carry. Scripted models
// drive each build.

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
/** Answers each model request with `respond`, keeping every request. */
const provider = (
  respond: (request: ModelRequest, index: number) => Output,
  requests: ModelRequest[] = [],
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
const execute = (purpose: string, extra: object, callId: string) =>
  call(
    "execute",
    {
      purpose,
      target: "liveBrowser",
      entrypoint: "src/tool.mjs",
      fixtureRefs: [],
      caseFilter: [],
      maxWorkers: 1,
      timeoutSeconds: 20,
      intent: "Read whether the shop shows the account",
      ...extra,
    },
    callId,
  );
const signInStep = (step: unknown, callId: string) =>
  execute("authenticate", { signInStep: step }, callId);
/** Reports whether the shop's account page shows the signed-in account. */
const readAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_account",input:Schema.Struct({}),output:Schema.Struct({signedIn:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/account', page.url()).href); return (await page.locator('#account').count()) > 0;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {signedIn:response.result === true};
});`;
const patch: Output = [
  {
    type: "apply_patch_call",
    callId: "patch_tool",
    status: "completed",
    operation: {
      type: "create_file",
      path: "src/tool.mjs",
      diff: `${readAccount
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
    },
  },
];
/** The result the host returned for the minter's call `callId`, as the minter read it. */
const toolResult = (requests: readonly ModelRequest[], callId: string) => {
  const result = objects(requests.at(-1)?.input).find(
    (item) => item["type"] === "function_call_result" && item["callId"] === callId,
  );
  if (result === undefined) throw new Error(`No ${callId} result`);
  return result;
};
/** Answers each sign-in question with the shop account's value for its slot. */
const answers = (asked: InputRequest[]) =>
  makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          question.id === "password" ? shopAccount.password : shopAccount.username,
        ]),
      );
    }),
  );

/** A shop and a browser that resolves its host, closed after `use`. */
const withShop = async (use: (shop: Shop, endpoint: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-sign-in-"));
  const shop = await startShop(directory);
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  try {
    await use(shop, browser.wsEndpoint());
  } finally {
    await browser.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("a local build asks for each sign-in slot on its own, and a run in a new session never signs in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted build with a host sign-in, then two runs",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider((request, index) => {
      const steps: Output[] = [
        patch,
        [
          signInStep(
            {
              fields: [
                { selector: "input[name=username]", accepts: ["username"] },
                { selector: "input[name=password]", slot: "password" },
              ],
              submit: "button",
            },
            "sign_in",
          ),
        ],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
        [execute("example", {}, "example")],
      ];
      if (index < steps.length) return steps[index] ?? [];
      if (index > steps.length) return [message("Built.")];
      const receipt = objects(request.input)
        .filter((item) => typeof item["executionId"] === "string")
        .at(-1);
      if (receipt === undefined) throw new Error("No execution receipt to finish with");
      return [
        call("finish_build", {
          intent: "Return the account reader",
          entrypoint: "src/tool.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "read_account", description: "Read whether the account shows" },
          coverage: "One live example, signed in",
        }),
      ];
    }, mintRequests);
    const asked: InputRequest[] = [];
    const request = { url: `${shop.origin}/account`, intent: "Read the account", input: {} };
    const artifact = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          const built = yield* service.mint({
            ...request,
            url: `${shop.origin}/login`,
            effect: "read",
          });
          expect(built.build, JSON.stringify(built)).toBe("published");
          if (built.artifact === undefined) throw new Error(JSON.stringify(built));
          // The minting session's own browser stays signed in for a run.
          expect(yield* service.run(built.artifact, request)).toEqual({ signedIn: true });
          return built.artifact;
        }),
      ),
    );
    // One question for each slot the screen named, each a secret with its own prompt.
    expect(asked.map(({ questions }) => questions)).toEqual([
      [
        expect.objectContaining({
          id: "username",
          type: "secret",
          secretKind: "private_text",
          prompt: `Enter your username for ${shop.origin}.`,
        }),
        expect.objectContaining({
          id: "password",
          type: "secret",
          secretKind: "private_text",
          prompt: `Enter your password for ${shop.origin}.`,
        }),
      ],
    ]);
    expect(shop.state.loginPosts).toBe(1);
    expect(JSON.stringify(artifact)).not.toContain(shopAccount.password);
    // A new session starts signed out, and its run neither asks for a login nor signs in.
    const runAsked: InputRequest[] = [];
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            browser: { endpoint },
            ask: answers(runAsked),
            timeoutMs: 30_000,
          });
          return yield* service.run(artifact as MintArtifact, request);
        }),
      ),
    );
    expect(output).toEqual({ signedIn: false });
    expect(runAsked).toEqual([]);
    expect(shop.state.loginPosts).toBe(1);
  });
});

test("a second sign-in screen whose form posts to a URL holding the password is refused after the first screen's typing", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and two host sign-in steps through a form navigation",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider((_request, index) => {
      if (index === 0)
        return [
          signInStep(
            { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" },
            "identifier",
          ),
        ];
      if (index === 1)
        return [
          signInStep(
            { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
            "password",
          ),
        ];
      return [message("Stopping here.")];
    }, mintRequests);
    const asked: InputRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          yield* service.mint({
            // The password screen's form posts to a URL that holds the password, as page code
            // that kept a typed value could make it; the host cannot tell.
            url: `${shop.origin}/sign-in?echo=none&stash=password`,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    // Each screen asks for its own slot.
    expect(asked.map(({ questions }) => questions.map((question) => question.id))).toEqual([
      ["email"],
      ["password"],
    ]);
    expect(objects(toolResult(mintRequests, "identifier"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    // The host typed into the page on the first screen, so the second screen's guard no longer
    // trusts a URL the page chose to hold the password: it refuses the submit as it fires.
    expectRefusedSubmit(shop, mintRequests);
  });
});

/** The password step typed, but its guard refused the submit to the URL holding the password. */
const expectRefusedSubmit = (shop: Shop, mintRequests: readonly ModelRequest[]) => {
  const result = objects(toolResult(mintRequests, "password"));
  expect(result).toContainEqual(
    expect.objectContaining({ outcome: "filled", submit: "refused", clicked: true }),
  );
  expect(result).toContainEqual(
    expect.objectContaining({ changed: "submission.action", submissionActionOrigin: shop.origin }),
  );
  expect(shop.state.sessionPosts).toBe(0);
  expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
};

test("a later build in the same session judges its first sign-in screen as typed into", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and two scripted builds in one session",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // Each build sends its one screen, then stops.
    let screen: "identifier" | "password" = "identifier";
    const mintRequests: ModelRequest[] = [];
    const minter = provider(
      (request) =>
        objects(request.input).some((item) => item["type"] === "function_call_result")
          ? [message("Stopping here.")]
          : [
              signInStep(
                screen === "identifier"
                  ? { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" }
                  : { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
                screen,
              ),
            ],
      mintRequests,
    );
    const asked: InputRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          const request = { intent: "Read the account", effect: "read" as const, input: {} };
          yield* service.mint({ ...request, url: `${shop.origin}/sign-in?echo=none` });
          // The second build starts on a password-only screen. Its first screen comes after the
          // first build typed into this session's page.
          screen = "password";
          yield* service.mint({
            ...request,
            url: `${shop.origin}/sign-in/password?echo=none&stash=password`,
          });
        }),
      ),
    );
    expect(asked.map(({ questions }) => questions.map((question) => question.id))).toEqual([
      ["email"],
      ["password"],
    ]);
    expectRefusedSubmit(shop, mintRequests);
  });
});
