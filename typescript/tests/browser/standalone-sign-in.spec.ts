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
import { recordingGuardian } from "./guardian-context-fixture.js";
import { startShop, shopAccount, type Shop } from "./shop-fixture.js";

// How a local build signs in today, on the shop's one-screen and two-screen sign-ins: what the
// host asks, what a later run does, what a second screen's submit may carry, and what Guardian
// reads of a screen that shows a typed value. Scripted models drive each build.

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

/** Another host the shop's server answers for, as a sign-in site on its own origin. */
const signInHost = "login.shop.test";
/** A shop and a browser that resolves its hosts, closed after `use`. */
const withShop = async (use: (shop: Shop, endpoint: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-sign-in-"));
  const shop = await startShop(directory);
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1, MAP ${signInHost} 127.0.0.1`,
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

test("a password screen that shows the typed email signs in, and Guardian reads that screen with the email masked", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and three host sign-in steps through a form navigation",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider((_request, index) => {
      const steps: Output[] = [
        [
          signInStep(
            { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" },
            "identifier",
          ),
        ],
        [
          signInStep(
            { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
            "password",
          ),
        ],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      ];
      return steps[index] ?? [message("Stopping here.")];
    }, mintRequests);
    const reviewer = recordingGuardian();
    const asked: InputRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: reviewer.provider,
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          // The password screen shows the typed email in its text, label and placeholder.
          yield* service.mint({
            url: `${shop.origin}/sign-in`,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(asked.map(({ questions }) => questions.map((question) => question.id))).toEqual([
      ["email"],
      ["password"],
    ]);
    expect(objects(toolResult(mintRequests, "password"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    expect(shop.state.sessionPosts).toBe(1);
    expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
      expect.objectContaining({ signedIn: true }),
    );
    // Guardian read the password screen, with the email it shows masked.
    const passwordReview = reviewer.reviews.find((review) =>
      review.reads.some(
        (read) =>
          read["path"] === "operation/sign-in-step.json" &&
          String(read["source"]).includes("#password"),
      ),
    );
    const screen = String(passwordReview?.reads.map((read) => read["source"]).join("\n"));
    expect(screen).toContain("[private]");
    expect(screen).not.toContain(shopAccount.username);
    // Its review says the host fills the login's values, which the review never shows.
    expect(String(passwordReview?.input["untrusted_observations"])).toContain(
      "never appear in this review",
    );
    for (const text of [JSON.stringify(mintRequests), JSON.stringify(reviewer.reviews)]) {
      expect(text).not.toContain(shopAccount.username);
      expect(text).not.toContain(shopAccount.password);
    }
  });
});

/** An exploration that opens `path` on the shop. */
const openPage = (name: string, path: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:${JSON.stringify(name)},input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(
    `await page.goto(new URL(${JSON.stringify(path)}, page.url()).href); return true;`,
  )},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
/** Returns the address the primary tab shows. */
const readWhere = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_where",input:Schema.Struct({}),output:Schema.Struct({where:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"const url = new URL(page.url()); return url.pathname + url.search;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {where:String(response.result)};
});`;
const create = (path: string, content: string, callId: string): Output[number] => ({
  type: "apply_patch_call",
  callId,
  status: "completed",
  operation: {
    type: "create_file",
    path,
    diff: `${content
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}\n`,
  },
});
/** The explorations the marker tests run: the search page, the account page and where it is. */
const markerFiles: Output = [
  create("explore/search.mjs", openPage("open_search", "/search?q=lamp"), "patch_search"),
  create("explore/account.mjs", openPage("open_account", "/account"), "patch_account"),
  create("explore/where.mjs", readWhere, "patch_where"),
];
const explore = (name: "search" | "account" | "where", callId = `explore_${name}`) =>
  execute(
    "explore",
    { entrypoint: `explore/${name}.mjs`, intent: `Run the ${name} exploration` },
    callId,
  );
const signInFields = (callId = "sign_in") =>
  signInStep(
    {
      fields: [
        { selector: "input[name=username]", accepts: ["username"] },
        { selector: "input[name=password]", slot: "password" },
      ],
      submit: "button",
    },
    callId,
  );
const checkMarker = (marker: object, callId: string) =>
  call("check_signed_in_marker", { intent: "Test the signed-in marker", ...marker }, callId);
/** The host's answer to the minter's marker check `callId`. */
const markerResult = (requests: readonly ModelRequest[], callId: string) =>
  objects(toolResult(requests, callId)).find((item) => item["kind"] === "host_signed_in_marker");
/**
 * Mints the shop in one session, one build for each of `builds`: each from its `url`, a read
 * unless its `effect` says otherwise, with a minter that plays its `steps`, one per model request.
 * Returns each build's requests.
 */
const markerSession = async (
  endpoint: string,
  builds: readonly {
    readonly url: string;
    readonly effect?: "read" | "write";
    readonly steps: readonly (Output | (() => Output))[];
  }[],
) => {
  const requests: ModelRequest[][] = builds.map(() => []);
  let build = 0;
  const minter = provider((request) => {
    const own = requests[build] ?? [];
    own.push(request);
    const step = builds[build]?.steps[own.length - 1] ?? [message("Stopping here.")];
    return typeof step === "function" ? step() : step;
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createPomerado({
          browser: { endpoint },
          minterProvider: minter,
          guardianProvider: guardian(),
          ask: answers([]),
          timeoutMs: 45_000,
        });
        for (const [index, { url, effect = "read" }] of builds.entries()) {
          build = index;
          yield* service.mint({ url, intent: "Read the account", effect, input: {} });
        }
      }),
    ),
  );
  return requests;
};
/** Mints a read of the shop from `url` with a minter that plays `steps`, one per model request. */
const markerBuild = async (
  endpoint: string,
  url: string,
  steps: readonly (Output | (() => Output))[],
) => (await markerSession(endpoint, [{ url, steps }]))[0] ?? [];

test("the local minter's marker check before the signedIn step compares a page explored once the login was sent", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium, a host sign-in, two marker checks and three explorations",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // The skill's order: sign in, explore signed in, test the marker, then send it.
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      markerFiles,
      [signInFields()],
      [explore("search")],
      [explore("account")],
      // The search page, explored after the login was sent, lacks the account page's element.
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
      // The sign-in page the host saw before typing shows it.
      [checkMarker({ selector: "body" }, "shared")],
      // Sent anyway, the signedIn step refuses it too, and the sign-in stays open.
      [signInStep({ signedIn: { selector: "body" } }, "signed_in_shared")],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      [explore("where")],
    ]);
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
      secondPage: false,
      refusals: ["marker_missing_on_second_page"],
    });
    expect(markerResult(mintRequests, "shared")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "matches",
      signedInNow: true,
      freshLoad: true,
      secondPage: true,
      refusals: ["marker_matches_signed_out_page"],
    });
    expect(objects(toolResult(mintRequests, "signed_in_shared"))).toContainEqual(
      expect.objectContaining({ signedIn: false, failed: "marker_matches_signed_out_page" }),
    );
    expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
      expect.objectContaining({ signedIn: true }),
    );
    // The checks left the agent on the account page, where it was.
    expect(objects(toolResult(mintRequests, "explore_where"))).toContainEqual({
      where: "/account",
    });
    // The checks only loaded pages: one sign-in, and no value reached the minter.
    expect(shop.state.loginPosts).toBe(1);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
  });
});

test("the local minter's marker check after the signedIn step compares the signed-out sign-in page, a fresh load and another signed-in page", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium, a host sign-in, four marker checks and three explorations",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [signInFields()],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      // The sign-in page the host saw before typing shows it too.
      [checkMarker({ selector: "body" }, "shared")],
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
      // XPath is beyond the signed-out page's match, so that page leaves it unchecked.
      [checkMarker({ selector: "xpath=//p[@id='account']", openPath: "/account" }, "xpath")],
      markerFiles,
      [explore("search")],
      [explore("account")],
      // The search page, visited signed in, doesn't show the account page's own element.
      [checkMarker({ selector: "#account", openPath: "/account" }, "second")],
      [explore("where")],
    ]);
    expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
      expect.objectContaining({ signedIn: true }),
    );
    expect(markerResult(mintRequests, "shared")).toEqual(
      expect.objectContaining({
        status: "refused",
        signedOutSnapshot: "matches",
        signedInNow: true,
        freshLoad: true,
        refusals: ["marker_matches_signed_out_page"],
      }),
    );
    // The shared check loaded the root, then went back to the account page, which shows the
    // marker now. No other page was visited signed in yet, so there is no second page.
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
    });
    expect(markerResult(mintRequests, "xpath")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed_unchecked",
      signedOutSnapshot: "unchecked",
      signedInNow: true,
      freshLoad: true,
      warnings: ["signed_out_page_unchecked"],
    });
    expect(markerResult(mintRequests, "second")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
      secondPage: false,
      refusals: ["marker_missing_on_second_page"],
    });
    expect(objects(toolResult(mintRequests, "explore_where"))).toContainEqual({
      where: "/account",
    });
    expect(shop.state.loginPosts).toBe(1);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
  });
});

test("a later build in the same session keeps no signed-in page as a signed-out page", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium and two scripted builds with host sign-ins in one session",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const [, later] = await markerSession(endpoint, [
      {
        url: `${shop.origin}/login`,
        steps: [
          [signInFields()],
          [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
        ],
      },
      {
        // The session is still signed in, so the account page shows the account, and the first
        // sign-in step finds no form there.
        url: `${shop.origin}/account`,
        steps: [
          [signInFields()],
          [create("explore/login.mjs", openPage("open_login", "/login"), "patch_login")],
          [
            execute(
              "explore",
              { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
              "explore_login",
            ),
          ],
          [signInFields("sign_in_again")],
          [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
        ],
      },
    ]);
    if (later === undefined) throw new Error("No later build");
    expect(objects(toolResult(later, "sign_in"))).toContainEqual(
      expect.objectContaining({ outcome: "refused", reason: "not_found" }),
    );
    // The account page the later build started on was signed in, so it is no signed-out page.
    // The build has none, and the marker passes unchecked.
    expect(markerResult(later, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed_unchecked",
      signedOutSnapshot: "unchecked",
      signedInNow: true,
      freshLoad: true,
      warnings: ["signed_out_page_unchecked"],
    });
    expect(shop.state.loginPosts).toBe(2);
  });
});

test("the local minter's marker check loads no page once the write session started", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a host sign-in, two act steps and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    let searchLoads: number | undefined;
    const [build] = await markerSession(endpoint, [
      {
        url: `${shop.origin}/login`,
        effect: "write",
        steps: [
          [
            create("src/search.mjs", openPage("open_search", "/search?q=lamp"), "patch_search"),
            create("src/account.mjs", openPage("open_account", "/account"), "patch_account"),
          ],
          [signInFields()],
          [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
          // An act step leaves the search page, whose load a site could take as an action.
          [
            execute(
              "act",
              { entrypoint: "src/search.mjs", intent: "Search the shop" },
              "act_search",
            ),
          ],
          [
            execute(
              "act",
              { entrypoint: "src/account.mjs", intent: "Open the account" },
              "act_account",
            ),
          ],
          () => {
            searchLoads = shop.state.searchPageLoads;
            return [checkMarker({ selector: "#account", openPath: "/account" }, "account")];
          },
        ],
      },
    ]);
    if (build === undefined) throw new Error("No build");
    expect(objects(toolResult(build, "act_account"))).toContainEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect(searchLoads).toBe(1);
    // The next act step continues the page as it is, so the check loads nothing: not the
    // marker's page, and not the search page the earlier act step left.
    expect(shop.state.searchPageLoads).toBe(1);
    expect(objects(toolResult(build, "account"))).toContainEqual(
      expect.objectContaining({ status: "tool_failed", code: "Unavailable" }),
    );
  });
});

/** A live test of where the page is, which resets the browser and loads the site's root first. */
const testWhere = execute(
  "test",
  { entrypoint: "explore/where.mjs", intent: "Read where a live test starts" },
  "test_where",
);

test("a sign-in screen on another origin and a root that failed to load are no signed-out pages", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a live test, a host sign-in and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    shop.state.home = "broken";
    const signInSite = `https://${signInHost}:${shop.port}/login`;
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [
        ...markerFiles,
        create("explore/sign-in-site.mjs", openPage("open_sign_in", signInSite), "patch_sign_in"),
      ],
      // The test's reset loads the root, which fails and leaves a blank page.
      [testWhere],
      [
        execute(
          "explore",
          { entrypoint: "explore/sign-in-site.mjs", intent: "Open the sign-in site" },
          "explore_sign_in",
        ),
      ],
      [signInFields()],
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
    ]);
    expect(objects(toolResult(mintRequests, "sign_in"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    // Neither page could show the shop's own pages signed out, so the check has none.
    expect(markerResult(mintRequests, "account")).toEqual(
      expect.objectContaining({
        signedOutSnapshot: "unchecked",
        warnings: ["signed_out_page_unchecked"],
      }),
    );
  });
});

test("a client-rendered root counts as signed out once it renders", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a live test, a host sign-in and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    shop.state.home = "late";
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [
        ...markerFiles,
        create("explore/login.mjs", openPage("open_login", "/login"), "patch_login"),
      ],
      // The test's reset loads the root, an empty shell until its script renders the header.
      [testWhere],
      [
        execute(
          "explore",
          { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
          "explore_login",
        ),
      ],
      [signInFields()],
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
    ]);
    // The rendered root shows its Account link signed out too.
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "matches",
      signedInNow: true,
      freshLoad: true,
      refusals: ["marker_matches_signed_out_page"],
    });
  });
});

/** An exploration that posts an empty form to the shop's search page, as a search form may. */
const postSearch = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"post_search",input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(
    `await Promise.all([page.waitForURL("**/search?q=lamp"), page.evaluate(() => { const form = document.createElement("form"); form.method = "post"; form.action = "/search?q=lamp"; document.body.append(form); form.submit(); })]); return true;`,
  )},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;

test("the local minter's marker check leaves a form's answer where its loads left the tab", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a host sign-in, two explorations and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    let searchLoads: number | undefined;
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [...markerFiles, create("explore/post-search.mjs", postSearch, "patch_post_search")],
      [signInFields()],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      [
        execute(
          "explore",
          { entrypoint: "explore/post-search.mjs", intent: "Post the search form" },
          "explore_post_search",
        ),
      ],
      () => {
        searchLoads = shop.state.searchPageLoads;
        return [checkMarker({ selector: "#results" }, "results")];
      },
      [explore("where")],
    ]);
    expect(searchLoads).toBe(1);
    expect(markerResult(mintRequests, "results")).toEqual(
      expect.objectContaining({ signedInNow: true, freshLoad: false }),
    );
    // The search page answered the form's post, so its address alone would send a GET in its
    // place: the host leaves the tab on the root it loaded.
    expect(shop.state.searchPageLoads).toBe(1);
    expect(objects(toolResult(mintRequests, "explore_where"))).toContainEqual({ where: "/" });
  });
});
