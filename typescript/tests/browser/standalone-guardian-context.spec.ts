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

test("a read build's reviews carry the build-wide context", async () => {
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
        () => [
          call(
            "request_input",
            {
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
            },
            "upgrade",
          ),
        ],
        (request) => [
          call("finish_build", {
            intent: "Return the fixture integration",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example_1"),
            metadata: { name: "read_fixture", description: "Read the fixture heading" },
            coverage: "One live example",
          }),
        ],
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    // The minter's request carries no observations.
    const screened = objects(requests[0]?.input).find(
      (value) => "intent" in value && "observations" in value,
    );
    expect(screened?.["observations"]).toEqual({});

    const question = guardian.reviews.find((review) => review.kind === "question");
    expect(authorityOf(question ?? guardian.reviews[0]!)["allowedEffects"]).toEqual(["read"]);
    expect(question?.input["trusted_execution_context"]).toBeUndefined();

    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["purpose"])).toEqual([
      "command",
      "explore",
      "test",
      "example",
      "contract",
    ]);
    for (const review of reviewed) {
      expect(authorityOf(review)["allowedEffects"]).toEqual(["read"]);
      expect(contextOf(review)).toMatchObject({ repeatableRead: false, browser: "active" });
      expect(sourcesOf(review, "executedSources")).toEqual(sourcesOf(review, "operationSources"));
      expect(contextOf(review)).not.toHaveProperty("currentPage");
      expect(contextOf(review)).not.toHaveProperty("inputSchema");
      expect(Object.keys(currentOf(review) ?? {}).sort()).toEqual(["purpose", "target"]);
      expect(review.input["untrusted_observations"]).toBe(
        "Caller-owned local workspace and native Playwright session.",
      );
      expect(review.input).not.toHaveProperty("untrusted_step_results");
    }
    const [command, explore, liveTest, example] = reviewed;
    expect((command?.input["submitted_call"] as Record<string, unknown>)["entrypoint"]).toBe(
      "operation/command.sh",
    );
    expect(sourcesOf(explore!, "executedSources")).toContain("operation/src/unused.mjs");
    expect((liveTest?.input["submitted_call"] as Record<string, unknown>)["input"]).toBe("{}");
    expect(
      (contextOf(example!)?.["executions"] as readonly Record<string, unknown>[]).map(
        (entry) => `${String(entry["purpose"])}:${String(entry["status"])}`,
      ),
    ).toEqual(["command:completed", "explore:completed", "test:completed"]);

    expect(toolResult(last, "test")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(objects(last?.input))).toContain("AlreadyExecuted");
    expect(toolResult(last, "upgrade")).toMatchObject({
      status: "question_refused",
      reason: "write_upgrade_unavailable",
    });
  } finally {
    await site.close();
  }
});

test("a write build repeats an unchanged act step and runs live tests", async () => {
  test.setTimeout(90_000);
  let writes = 0;
  const site = await startSite((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("saved");
      return;
    }
    html(
      response,
      `<title>Save</title><button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.title='Saved')">Save</button>`,
    );
  });
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/act.mjs": probe(
              "await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); return true;",
            ),
            "src/look.mjs": probe(),
          }),
        () => [call("execute", execution("act", "src/act.mjs"), "act_1")],
        () => [call("execute", execution("act", "src/act.mjs"), "act_2")],
        () => [call("execute", execution("test", "src/look.mjs"), "test")],
        () => [call("execute", execution("explore", "src/look.mjs"), "explore")],
      ],
    });
    expect(writes).toBe(2);
    for (const id of ["act_1", "act_2", "test", "explore"])
      expect(toolResult(last, id), id).toMatchObject({ status: "completed" });
    const act = executions(guardian.reviews).find(
      (review) => currentOf(review)?.["purpose"] === "act",
    );
    expect(authorityOf(act!)["allowedEffects"]).toEqual(["read", "write"]);
  } finally {
    await site.close();
  }
});

test("secret handle problems are refused after Guardian reviews the source", async () => {
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
    expect(
      executions(guardian.reviews).map((review) => currentOf(review)?.["purpose"]),
    ).toEqual(["explore", "explore"]);
    const text = JSON.stringify(objects(last?.input));
    expect(text).toContain("ScopeDenied");
    expect(toolResult(last, "misplaced")).not.toMatchObject({ status: "unsupported" });
    expect(toolResult(last, "unissued")).not.toMatchObject({ status: "unsupported" });
  } finally {
    await site.close();
  }
});

test("a Guardian outage ends the step as a host failure without a retry", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian({
    fail: (index) => (index === 0 ? new Error("Synthetic provider outage") : undefined),
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
    expect(built.build).not.toBe("published");
    expect(JSON.stringify(built)).not.toContain("review_unavailable");
  } finally {
    await site.close();
  }
});
