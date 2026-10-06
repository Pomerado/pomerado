import { test, expect } from "@playwright/test";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import {
  authorityOf,
  call,
  contextOf,
  currentOf,
  execution,
  executionIdOf,
  headingOperation,
  html,
  message,
  objects,
  patch,
  probe,
  recordingGuardian,
  scripted,
  startSite,
  toolResult,
  type RecordedReview,
} from "./guardian-context-fixture.js";

type Turn = (request: ModelRequest) => ModelResponse["output"];

/** Mints against `site` with a minter that plays `turns`, one per model request. */
const mint = async (options: {
  readonly effect: "read" | "write";
  readonly url: string;
  readonly turns: readonly Turn[];
  readonly guardian: ReturnType<typeof recordingGuardian>;
  readonly answer?: (request: InputRequest) => Record<string, unknown>;
}) => {
  const requests: ModelRequest[] = [];
  const asked: InputRequest[] = [];
  const minter = scripted(
    (request, index) => options.turns[index]?.(request) ?? [message("Done.")],
    requests,
  );
  const built = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createPomerado({
          minterProvider: minter,
          guardianProvider: options.guardian.provider,
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              asked.push(request);
              return options.answer?.(request) ?? {};
            }),
          ),
          timeoutMs: 60_000,
        });
        return yield* service.mint({
          url: options.url,
          intent: "Read the fixture heading",
          effect: options.effect,
          input: {},
        });
      }),
    ),
  );
  return { built, requests, asked, last: requests.at(-1) };
};
const executions = (reviews: readonly RecordedReview[]) =>
  reviews.filter((review) => review.kind === "execution");
const sourcesOf = (review: RecordedReview, key: string) =>
  [...((contextOf(review)?.[key] as readonly string[] | undefined) ?? [])].sort();
const effectsOf = (review: RecordedReview | undefined) =>
  (review === undefined ? [] : authorityOf(review)["allowedEffects"]) as readonly string[];
const historyOf = (review: RecordedReview | undefined) =>
  ((review === undefined ? [] : contextOf(review)?.["executions"]) ??
    []) as readonly Readonly<Record<string, unknown>>[];
const stepResultsOf = (review: RecordedReview | undefined) =>
  review?.input["untrusted_step_results"] as
    | readonly { readonly executionId: string; readonly result: string }[]
    | undefined;
const offline =
  "Offline local files, source checks and computation only. No live website, credentials or network.";
const dated = {
  todayUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
  nowUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
};
const observationsOf = (review: RecordedReview | undefined) =>
  String(review?.input["untrusted_observations"]).split("\n");
const upgradeQuestion = {
  intent: "Ask to change the site",
  writeUpgrade: true,
  questions: [
    {
      id: "effect",
      type: "choice",
      prompt: "Saving the note changes the site. Allow it?",
      options: [
        { id: "read", label: "Read" },
        { id: "write", label: "Change" },
      ],
    },
  ],
};
const saveSite = () => {
  let writes = 0;
  return {
    writes: () => writes,
    start: () =>
      startSite((request, response) => {
        if (request.method === "POST") {
          writes++;
          response.end("saved");
          return;
        }
        html(
          response,
          `<title>Save</title><button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.title='Saved')">Save</button>`,
        );
      }),
  };
};
const saveStep = probe(
  "await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); return true;",
);

test("a read build's reviews carry each step's own context", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const { built, requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ note: "plain" }),
      turns: [
        () =>
          patch({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs": "export const heading = (value) => String(value).trim();",
            "src/unused.mjs": "export const unused = 1;",
            "explore/look.mjs": probe(),
          }),
        () => [
          call("request_input", {
            intent: "Ask which note to keep",
            questions: [{ id: "note", type: "text", prompt: "Which note should I keep?" }],
          }),
        ],
        () => [call("exec_command", { cmd: "ls src" }, "command")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "explore")],
        () => [call("execute", execution("test", "src/tool.mjs", { testInput: "{}" }), "test")],
        () => [call("execute", execution("example", "src/tool.mjs"), "example_1")],
        () => [call("execute", execution("example", "src/tool.mjs"), "example_2")],
        () => [call("request_input", upgradeQuestion, "upgrade")],
        (request) => [
          call("finish_build", {
            intent: "Return the fixture integration",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example_2"),
            metadata: { name: "read_fixture", description: "Read the fixture heading" },
            coverage: "One live example",
          }),
        ],
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    // The minter's request carries the host's date.
    const screened = objects(requests[0]?.input).find(
      (value) => "intent" in value && "observations" in value,
    );
    expect(screened?.["observations"]).toEqual(dated);

    // A question review has no step: no effects, no current execution and no step results.
    const question = guardian.reviews.find((review) => review.kind === "question");
    expect(effectsOf(question)).toEqual([]);
    expect(contextOf(question!)).toMatchObject({ repeatableRead: true, browser: "not_opened" });
    expect(contextOf(question!)).not.toHaveProperty("currentExecution");
    expect(question?.input).not.toHaveProperty("untrusted_step_results");

    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["purpose"])).toEqual([
      "command",
      "explore",
      "test",
      "example",
      "example",
      "contract",
    ]);
    const [command, explore, liveTest, example1, example2, contract] = reviewed;
    for (const review of reviewed) {
      expect(contextOf(review)?.["repeatableRead"]).toBe(true);
      expect(JSON.parse(observationsOf(review)[0] ?? "")).toEqual(dated);
      expect(stepResultsOf(review)).toEqual(expect.any(Array));
    }
    // Each step gets the authority its own kind of work needs.
    expect(effectsOf(command)).toEqual([offline]);
    expect(effectsOf(contract)).toEqual([offline]);
    for (const review of [explore, liveTest, example1, example2])
      expect(effectsOf(review)[0]).toMatch(/^Authorized repeatable reads/u);

    // The command runs before any page is open, with its sandbox's facts.
    expect(currentOf(command!)).toEqual({
      purpose: "command",
      target: "pureFiles",
      commandSandbox: { cwd: expect.any(String), timeoutSeconds: 30, maxOutputBytes: 1_048_576 },
    });
    expect(contextOf(command!)).not.toHaveProperty("executedSources");
    expect(contextOf(command!)?.["browser"]).toBe("not_opened");
    // Executed sources are the entrypoint's imports, not the whole workspace.
    expect(sourcesOf(explore!, "executedSources")).toEqual(["operation/explore/look.mjs"]);
    expect(sourcesOf(explore!, "operationSources")).toContain("operation/src/unused.mjs");
    expect(contextOf(explore!)?.["browser"]).toBe("not_opened");
    expect(contextOf(explore!)).not.toHaveProperty("currentPage");
    // Once a step ran, Guardian sees the page it left open and the last results.
    expect(contextOf(liveTest!)).toMatchObject({
      browser: "active",
      currentPage: { origin: site.origin, path: "/", capture: "captures/current-page.aria.yml" },
    });
    expect(sourcesOf(liveTest!, "executedSources")).toEqual([
      "operation/src/heading.mjs",
      "operation/src/tool.mjs",
    ]);
    expect(currentOf(liveTest!)).toEqual({
      purpose: "test",
      target: "liveBrowser",
      input: "agent_chosen",
    });
    expect(stepResultsOf(liveTest)).toHaveLength(2);
    // The input schema comes from the latest example or contract run.
    for (const review of [command, explore, liveTest, example1])
      expect(contextOf(review!)).not.toHaveProperty("inputSchema");
    expect(String(contextOf(example2!)?.["inputSchema"])).toContain("object");
    expect(String(contextOf(contract!)?.["inputSchema"])).toContain("object");
    expect(observationsOf(contract).slice(1).join("\n")).toContain("never calls operation.run");
    expect(
      historyOf(example2).map(
        (entry) =>
          `${String(entry["purpose"])}:${String(entry["status"])}${entry["input"] === undefined ? "" : `:${String(entry["input"])}`}`,
      ),
    ).toEqual([
      "command:completed",
      "explore:completed",
      "test:completed:agent_chosen",
      "example:completed",
    ]);

    // A read build may run its example again; once it ran one, it can no longer become a write.
    expect(toolResult(last, "test")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "example_2")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(objects(last?.input))).not.toContain("AlreadyExecuted");
    expect(toolResult(last, "upgrade")).toMatchObject({
      status: "question_refused",
      reason: "write_upgrade_unavailable",
    });
  } finally {
    await site.close();
  }
});

test("Guardian reads the page the build last observed, with private values redacted", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Account</title><h1>Account</h1><p>Code fixture-private-value</p>"),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: "fixture-private-value" }),
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [
          call("request_input", {
            intent: "Ask for the private code",
            questions: [
              { id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" },
            ],
          }),
        ],
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    const [first, second] = executions(guardian.reviews);
    expect(contextOf(first!)).not.toHaveProperty("currentPage");
    expect(contextOf(second!)?.["currentPage"]).toEqual({
      origin: site.origin,
      path: "/",
      capture: "captures/current-page.aria.yml",
    });
    const capture = second!.reads.find(
      (read) => read["path"] === "captures/current-page.aria.yml",
    );
    expect(String(capture?.["source"])).toContain("Account");
    expect(String(capture?.["source"])).toContain("[private]");
    expect(JSON.stringify(guardian.reviews)).not.toContain("fixture-private-value");
  } finally {
    await site.close();
  }
});

test("a read build runs two live tests on inputs it chose and its example on the input it read", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  const chosen = (value: number) => execution("test", "src/tool.mjs", { testInput: `{"page":${value}}` });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs": "export const heading = (value) => String(value).trim();",
          }),
        () => [call("execute", chosen(1), "test_1")],
        () => [call("execute", chosen(2), "test_2")],
        () => [call("execute", chosen(3), "test_3")],
        () => [call("execute", execution("test", "src/tool.mjs", { testInput: "{x" }), "not_json")],
        () => [
          call("execute", execution("example", "src/tool.mjs", { testInput: "{}" }), "example_test"),
        ],
        () => [
          call(
            "execute",
            execution("example", "src/tool.mjs", { exampleInput: '{"venue":"Venue X"}' }),
            "example",
          ),
        ],
      ],
    });
    expect(toolResult(last, "test_1")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "test_2")).toMatchObject({ status: "completed" });
    for (const [id, reason] of [
      ["test_3", "already ran 2 live tests with an input you chose"],
      ["not_json", "testInput must be the tool's input as JSON text"],
      ["example_test", "testInput is only for a read's live test"],
    ] as const) {
      expect(toolResult(last, id), id).toMatchObject({ status: "unsupported" });
      expect(JSON.stringify(toolResult(last, id)), id).toContain(reason);
    }
    expect(toolResult(last, "example")).toMatchObject({ status: "completed" });
    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["input"])).toEqual([
      "agent_chosen",
      "agent_chosen",
      "intent_derived",
    ]);
    const example = reviewed.at(-1);
    expect((example?.input["submitted_call"] as Record<string, unknown>)["input"]).toBe(
      '{"venue":"Venue X"}',
    );
    expect(historyOf(example).map((entry) => entry["input"])).toEqual([
      "agent_chosen",
      "agent_chosen",
    ]);
  } finally {
    await site.close();
  }
});

test("an approved write upgrade turns a read build into a write build", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ effect: "write" }),
      turns: [
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        () => [call("execute", execution("explore", "src/look.mjs"), "explore")],
        () => [call("request_input", upgradeQuestion, "upgrade")],
        () => [call("execute", execution("act", "src/act.mjs"), "act")],
      ],
    });
    expect(toolResult(last, "upgrade")).toMatchObject({ status: "answered", buildEffect: "write" });
    expect(toolResult(last, "act")).toMatchObject({ status: "completed" });
    expect(fixture.writes()).toBe(1);
    const [explore, act] = executions(guardian.reviews);
    expect(contextOf(explore!)?.["repeatableRead"]).toBe(true);
    expect(contextOf(act!)?.["repeatableRead"]).toBe(false);
    expect(effectsOf(act)[0]).toMatch(/^The caller's requested task, done once/u);
    expect(authorityOf(act!)["intent"]).toBe(
      "Read the fixture heading\nThe owner approved turning this read build into a write build, answering this reviewed question: Saving the note changes the site. Allow it?",
    );
  } finally {
    await site.close();
  }
});

test("a write build refuses a blind repeat of a write, and live tests and explores in its session", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        () => [call("execute", execution("act", "src/act.mjs"), "act_1")],
        () => [call("execute", execution("act", "src/act.mjs"), "act_2")],
        () => [call("execute", execution("test", "src/look.mjs"), "test")],
        () => [call("execute", execution("explore", "src/look.mjs"), "explore")],
        () => [call("execute", execution("act", "src/look.mjs"), "read_back")],
        () => [call("execute", execution("act", "src/act.mjs"), "act_3")],
      ],
    });
    expect(fixture.writes()).toBe(2);
    for (const id of ["act_1", "read_back", "act_3"])
      expect(toolResult(last, id), id).toMatchObject({ status: "completed" });
    for (const [id, reason] of [
      ["act_2", "could commit the write twice"],
      ["test", "never as a live example or a live test"],
      ["explore", "live exploration is over"],
    ] as const) {
      expect(toolResult(last, id), id).toMatchObject({ status: "unsupported" });
      expect(JSON.stringify(toolResult(last, id)), id).toContain(reason);
    }
    const acts = executions(guardian.reviews);
    expect(acts.map((review) => currentOf(review)?.["purpose"])).toEqual(["act", "act", "act"]);
    expect(effectsOf(acts[0])[0]).toMatch(/^The caller's requested task, done once/u);
  } finally {
    await site.close();
  }
});

test("secret handle problems are refused before Guardian reviews the source", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, `<title>Code</title><h1>Code</h1><input id="code">`),
  );
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: "fixture-private-value" }),
      turns: [
        () =>
          patch({
            "explore/leak.mjs": `const handle = "{{secret.s1}}";\nconsole.log(handle);\nexport default {};`,
            "explore/unknown.mjs": probe(`await page.locator('#code').fill("{{secret.s9}}"); return 1;`),
          }),
        () => [
          call("request_input", {
            intent: "Ask for the private code",
            questions: [
              { id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" },
            ],
          }),
        ],
        () => [call("execute", execution("explore", "explore/leak.mjs"), "misplaced")],
        () => [call("execute", execution("explore", "explore/unknown.mjs"), "unissued")],
      ],
    });
    expect(executions(guardian.reviews)).toEqual([]);
    expect(toolResult(last, "misplaced")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "misplaced"))).toContain("explore/leak.mjs line 1: ");
    expect(toolResult(last, "unissued")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "unissued"))).toContain("{{secret.s9}}");
  } finally {
    await site.close();
  }
});

test("a Guardian outage is retried before the step runs", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian({
    fail: (index) => (index === 0 ? new Error("Synthetic provider outage") : undefined),
  });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "explore")],
      ],
    });
    expect(guardian.calls()).toBeGreaterThan(1);
    expect(toolResult(last, "explore")).toMatchObject({ status: "completed" });
  } finally {
    await site.close();
  }
});

test("a spent Guardian model quota ends the build as a host failure without a retry", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian({
    fail: () => Object.assign(new Error("Synthetic spent quota"), { code: "insufficient_quota" }),
  });
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "explore")],
      ],
    });
    expect(guardian.calls()).toBe(1);
    expect(built).toMatchObject({ build: "incomplete", hostFailure: "model_quota_exhausted" });
  } finally {
    await site.close();
  }
});
