import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Either } from "effect";
import { afterEach, expect, it } from "vitest";
import type {
  AgentInputRequest,
  MintDependencies,
  TaskUpdateApplication,
  TaskUpdateCandidate,
} from "../../src/mint/contracts.js";
import { MintFailure } from "../../src/mint/contracts.js";
import type { TaskUpdateDecision } from "../../src/guardian/task-update.js";
import type {
  OutcomeReviewHost,
  OutcomeReviewSnapshot,
} from "../../src/mint/outcome-review-contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { memoryPublicationDecisions } from "../../src/standalone/publication-decisions.js";
import { validateAnswer } from "../../src/runtime/input-request.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ intent: `Synthetic ${name} purpose`, ...input }),
      status: "completed",
    },
  ],
});
const prose = (): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
});
/** The parsed result the harness returned for a call, from the request after it. */
const resultOf = (requests: readonly ModelRequest[], callId: string) => {
  for (const request of requests) {
    const input = request.input;
    if (!Array.isArray(input)) continue;
    const item = input.find(
      (entry) => entry.type === "function_call_result" && entry.callId === callId,
    );
    if (item === undefined || item.type !== "function_call_result") continue;
    const output = item.output;
    const text =
      typeof output === "string"
        ? output
        : Array.isArray(output)
          ? output.map((part) => ("text" in part ? part.text : "")).join("")
          : "text" in output
            ? output.text
            : "";
    return JSON.parse(text) as Record<string, unknown>;
  }
  return undefined;
};
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "notes", description: "Read the saved notes" },
  coverage: "One example ran.",
};
const site = "https://notes.example.test";

/** The caller answers each request in turn, as the wire would give it. */
const answering = (wire: readonly Readonly<Record<string, unknown>>[]) => {
  let index = 0;
  return (submitted: AgentInputRequest) =>
    Effect.sync(() =>
      Either.getOrThrow(
        validateAnswer(
          { ...submitted, id: "5b3f0e2a-6c1d-4f7e-9a8b-0c2d4e6f8a1b", source: "agent" },
          wire[index++] ?? {},
        ),
      ),
    );
};

/**
 * A scripted Guardian and host for task updates: Guardian decides each review in turn, and the
 * host applies what it is given, unless `host` answers instead.
 */
const updateHost = (
  decisions: readonly TaskUpdateDecision["outcome"][],
  host?: (
    application: TaskUpdateApplication,
  ) => ReturnType<NonNullable<MintDependencies["applyTaskUpdate"]>>,
) => {
  const reviews: TaskUpdateCandidate[] = [];
  const applied: TaskUpdateApplication[] = [];
  const overrides: Partial<MintDependencies> = {
    reviewTaskUpdate: (candidate) =>
      Effect.sync(() => {
        reviews.push(candidate);
        return {
          outcome: decisions[reviews.length - 1] ?? "reword",
          rationale: "Scripted review.",
          reviewId: `review_${reviews.length}`,
        };
      }),
    applyTaskUpdate: (application) =>
      host?.(application) ??
      Effect.sync(() => {
        applied.push(application);
        return { outcome: "applied" as const };
      }),
  };
  return { reviews, applied, overrides };
};

const saveQuestion = {
  questions: [
    {
      id: "save",
      type: "choice",
      prompt: "The notes page only saves a note when you submit it. May this build save it?",
      options: [
        { id: "save", label: "Yes, save the note on the site" },
        { id: "look", label: "No, only look at the notes" },
      ],
    },
  ],
};
const toWrite = {
  summary: "Save the note on the site instead of only reading the notes.",
  changes: [{ setting: "effect", effect: "write" }],
  confirmedBy: ["save"],
  recommend: "update",
};

it("turns a read build into a write build once the caller picks the option the minter wrote", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [call("request_input", saveQuestion, "ask"), call("mint_update", toWrite, "update")][index] ??
      prose(),
    { ...updates.overrides, askInput: answering([{ save: "save" }]), repeatableRead: true },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { revision: 1, effect: "write", siteOrigin: site },
    repeatableRead: false,
  });
  // Guardian read the caller's pick as the option's own words, and the host applied a write.
  expect(updates.reviews[0]?.update.confirmation).toEqual([
    {
      question: saveQuestion.questions[0]?.prompt,
      answer: "Yes, save the note on the site",
    },
  ]);
  expect(updates.reviews[0]?.current).toMatchObject({ revision: 0, effect: "read" });
  expect(updates.applied[0]?.next).toMatchObject({ revision: 1, effect: "write" });
});

it("drops a prerequisite the caller said the site does not offer", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "request_input",
          {
            questions: [
              {
                id: "check",
                type: "text",
                prompt:
                  "The site shows no way to check a note's history before saving. How should the build go on?",
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: "Save the note without checking its history first.",
            changes: [
              { setting: "requirement", change: "drop", text: "Check the note's history first." },
            ],
            confirmedBy: ["check"],
            recommend: "update",
          },
          "update",
        ),
        call("execute", example, "example"),
        call("finish_build", publication, "publish"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ check: "Skip the history check and just save it" }]),
    },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({ status: "updated" });
  expect(updates.applied[0]?.next.updates).toEqual([
    {
      revision: 1,
      summary: "Save the note without checking its history first.",
      changes: [
        { setting: "requirement", change: "drop", text: "Check the note's history first." },
      ],
      confirmation: [
        {
          question:
            "The site shows no way to check a note's history before saving. How should the build go on?",
          answer: "Skip the history check and just save it",
        },
      ],
      reviewId: "review_1",
      requestDigest: expect.any(String),
    },
  ]);
  expect(outcome.build).toBe("published");
});

it("moves the build to another site of the same product, with the host rebinding it", async () => {
  const sister = "https://notes.example.org";
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "request_input",
          {
            questions: [
              {
                id: "site",
                type: "choice",
                prompt: `Your notes live on ${sister}, not on this site. Build the tool there?`,
                options: [
                  { id: "move", label: `Yes, use ${sister}` },
                  { id: "stay", label: "No, stay here" },
                ],
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: `Build the tool on ${sister}, where the caller's notes live.`,
            changes: [{ setting: "site", origin: sister }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: "move" }]) },
    { siteOrigin: site },
  );
  await f.run();
  expect(updates.applied[0]).toMatchObject({
    current: { siteOrigin: site },
    next: { siteOrigin: sister, revision: 1 },
  });
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { siteOrigin: sister, siteDomain: "example.org" },
  });
});

it("asks the caller first when the host needs a login for the new site", async () => {
  const sister = "https://notes.example.org";
  const updates = updateHost(["allow"], () =>
    Effect.succeed({
      outcome: "clarification_required" as const,
      reason: "login_required",
      notice: "The account has no saved login for the new site. Ask the caller to add one.",
    }),
  );
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "site", type: "text", prompt: "Where?" }] }),
        call(
          "mint_update",
          {
            summary: `Build the tool on ${sister}.`,
            changes: [{ setting: "site", origin: sister }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: sister }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "clarification_required",
    source: "host",
    reason: "login_required",
  });
  expect(outcome).not.toHaveProperty("blocked");
});

it("ends the build blocked with the recommendation when the change is a different task", async () => {
  const updates = updateHost(["allow"]);
  const suggestedRequest = "Book a table at the restaurant the caller picks on the booking site.";
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call(
          "mint_update",
          {
            summary: "The caller now wants to book a table, not list restaurant hours.",
            changes: [{ setting: "purpose", text: "Book a table at a restaurant." }],
            confirmedBy: ["task"],
            recommend: "new_mint",
            suggestedRequest,
          },
          "update",
        ),
        call("execute", example, "after"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ task: "Actually book me a table" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: {
      reason: "new_mint_recommended",
      explanation: "The caller now wants to book a table, not list restaurant hours.",
      suggestedRequest,
    },
  });
  // The build ends with the update: nothing runs after it, and the host applied nothing.
  expect(f.counts().executed).toBe(0);
  expect(updates.applied).toEqual([]);
});

it("ends the build blocked when Guardian finds an update belongs in a new build", async () => {
  const updates = updateHost(["new_mint"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call(
          "mint_update",
          {
            summary: "Order supplies on another vendor's store instead.",
            changes: [{ setting: "site", origin: "https://store.vendor.test" }],
            confirmedBy: ["task"],
            recommend: "update",
            suggestedRequest: "Order the listed supplies on the other vendor's store.",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ task: "Use the other vendor" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toEqual({
    reason: "new_mint_recommended",
    explanation: "Order supplies on another vendor's store instead.",
    suggestedRequest: "Order the listed supplies on the other vendor's store.",
  });
  expect(updates.applied).toEqual([]);
});

it("keeps building after Guardian asks to reword an update", async () => {
  const updates = updateHost(["reword", "allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "date", type: "text", prompt: "Which day?" }] }),
        call(
          "mint_update",
          {
            summary: "Change the day.",
            changes: [{ setting: "input", values: { day: "2026-11-02" } }],
            confirmedBy: ["date"],
            recommend: "update",
          },
          "first",
        ),
        call(
          "mint_update",
          {
            summary: "Look up notes for November 2 instead of November 1, as the caller asked.",
            changes: [{ setting: "input", values: { day: "2026-11-02" } }],
            confirmedBy: ["date"],
            recommend: "update",
          },
          "second",
        ),
        call("execute", example, "example"),
        call("finish_build", publication, "publish"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ date: "November 2 instead" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "first")).toMatchObject({
    status: "reword",
    rationale: "Scripted review.",
  });
  expect(resultOf(f.requests, "second")).toMatchObject({ status: "updated" });
  expect(updates.applied).toHaveLength(1);
  expect(updates.applied[0]?.next.businessInput).toEqual({ day: "2026-11-02" });
  expect(outcome.build).toBe("published");
});

it("asks the minter to confirm an update that cites no answered question", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [call("mint_update", { ...toWrite, confirmedBy: ["save"] }, "update")][index] ?? prose(),
    { ...updates.overrides, repeatableRead: true },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "clarification_required",
    source: "host",
    unanswered: ["save"],
  });
  expect(updates.reviews).toEqual([]);
});

/** Execution receipts numbered in order, each completed with a protected result. */
const numberedExecutions = () => {
  let count = 0;
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (_input, beforeDispatch) =>
    (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          count++;
          return {
            executionId: `execution_${count}`,
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: `protected_${count}`,
            observations: { value: "public" },
          };
        }),
      ),
    );
  return reviewAndExecute;
};
const sister = "https://notes.example.org";
const siteQuestion = {
  questions: [
    {
      id: "site",
      type: "choice",
      prompt: `Your notes live on ${sister}. Build the tool there?`,
      options: [
        { id: "move", label: `Yes, use ${sister}` },
        { id: "stay", label: "No, stay here" },
      ],
    },
  ],
};
const toSister = {
  summary: `Build the tool on ${sister}, where the caller's notes live.`,
  changes: [{ setting: "site", origin: sister }],
  confirmedBy: ["site"],
  recommend: "update",
};

// Guardian judges a proposed change against the host's own record of the refusal that led to it,
// not only the minter's account of it.
it("shows the update review the host's publication refusal", async () => {
  const updates = updateHost(["allow"]);
  const decisions = memoryPublicationDecisions();
  const dateQuestion = {
    questions: [
      {
        id: "date",
        type: "choice",
        prompt: "The site does not take notes dated on a weekend. Use Monday instead?",
        options: [
          { id: "monday", label: "Yes, use Monday" },
          { id: "stop", label: "No, stop" },
        ],
      },
    ],
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "act"),
        call("finish_build", { ...publication, executionId: "execution_1" }, "refused"),
        call("request_input", dateQuestion, "ask"),
        call(
          "mint_update",
          {
            summary: "Date the note Monday, since the site refuses weekend dates.",
            changes: [{ setting: "input", values: { date: "monday" } }],
            confirmedBy: ["date"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ date: "monday" }]),
      reviewAndExecute: numberedExecutions(),
      publicationDecisions: decisions,
      publish: () =>
        Effect.fail(
          new MintFailure({ code: "PublicationUnavailable", reason: "write_not_submitted" }),
        ),
    },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "refused")).toMatchObject({ reason: "write_not_submitted" });
  const held = await Effect.runPromise(decisions.list);
  expect(held).toEqual([
    expect.objectContaining({ reason: "write_not_submitted", recovery: "write_completion" }),
  ]);
  expect(updates.reviews).toHaveLength(1);
  expect(updates.reviews[0]?.update.publicationDecisions).toEqual(held);
});

it("publishes after a site change only an example that ran on the new site", async () => {
  const updates = updateHost(["allow"]);
  const decisions = memoryPublicationDecisions();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "before"),
        call("request_input", siteQuestion, "ask"),
        call("mint_update", toSister, "update"),
        call("finish_build", { ...publication, executionId: "execution_1" }, "stale"),
        call("execute", example, "after"),
        call("finish_build", { ...publication, executionId: "execution_2" }, "publish"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ site: "move" }]),
      repeatableRead: true,
      reviewAndExecute: numberedExecutions(),
      publicationDecisions: decisions,
    },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({ status: "updated" });
  expect(resultOf(f.requests, "stale")).toMatchObject({
    status: "not_published",
    reason: "example_before_site_change",
  });
  expect(outcome.build).toBe("published");
  // The stale refusal is host evidence: a fresh example on the current site recovers it.
  expect(await Effect.runPromise(decisions.list)).toEqual([
    expect.objectContaining({
      outcome: "refused",
      reason: "example_before_site_change",
      executionId: "execution_1",
      recovery: "new_observation",
    }),
    expect.objectContaining({ outcome: "published", executionId: "execution_2" }),
  ]);
  expect(f.counts().published).toBe(1);
});

it("lets a read build that ran its live example become a write, and publishes only the write", async () => {
  const updates = updateHost(["allow"]);
  const decisions = memoryPublicationDecisions();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "read"),
        call("request_input", saveQuestion, "ask"),
        call("mint_update", toWrite, "update"),
        call("finish_build", { ...publication, executionId: "execution_1" }, "stale"),
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "act"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ save: "save" }]),
      repeatableRead: false,
      reviewAndExecute: numberedExecutions(),
      publicationDecisions: decisions,
    },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  // The read's receipt is refused as host evidence: the write itself is still to do.
  expect(await Effect.runPromise(decisions.list)).toEqual([
    expect.objectContaining({
      outcome: "refused",
      reason: "example_before_effect_change",
      executionId: "execution_1",
      recovery: "write_completion",
    }),
  ]);
  expect(resultOf(f.requests, "read")).toMatchObject({ status: "completed" });
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { revision: 1, effect: "write" },
  });
  expect(resultOf(f.requests, "stale")).toMatchObject({
    status: "not_published",
    reason: "example_before_effect_change",
  });
  expect(resultOf(f.requests, "act")).toMatchObject({ status: "completed" });
});

it("refuses a site change once the build cannot run another live example", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "example"),
        call("request_input", siteQuestion, "ask"),
        call("mint_update", toSister, "update"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: "move" }]), repeatableRead: false },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "update_refused",
    reason: "no_live_example_left",
  });
  expect(String(resultOf(f.requests, "update")?.["instruction"])).toContain("new_mint");
  expect(updates.reviews).toEqual([]);
});

it("refuses a site change while the write session is open", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "act"),
        call("request_input", siteQuestion, "ask"),
        call("mint_update", toSister, "update"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: "move" }]) },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "act")).toMatchObject({ status: "completed" });
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "update_refused",
    reason: "write_session_open",
  });
  expect(updates.reviews).toEqual([]);
});

it("asks for the caller's confirmation before a change that widens what the build may do", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("mint_update", { ...toSister, confirmedBy: [] }, "site"),
        call("mint_update", { ...toWrite, confirmedBy: [] }, "write"),
      ][index] ?? prose(),
    { ...updates.overrides, repeatableRead: true },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  for (const id of ["site", "write"])
    expect(resultOf(f.requests, id), id).toMatchObject({
      status: "clarification_required",
      source: "host",
      reason: "confirmation_required",
    });
  expect(updates.reviews).toEqual([]);
});

// Fails when an applied update leaves the outcome reviewer unaware that the remaining work changed,
// or when a refused one tells it the work changed.
it("tells the outcome reviewer about an applied update, never a refused one", async () => {
  const updates = updateHost(["reword", "allow"]);
  const saved: OutcomeReviewSnapshot[] = [];
  const review: OutcomeReviewHost = {
    // A reviewer that takes its turns and never assesses, so the write stays unresolved.
    model: { turn: () => Effect.void },
    save: (snapshot) =>
      Effect.sync(() => {
        saved.push(snapshot);
      }),
    recordAssessment: () => Effect.void,
  };
  const dropCheck = {
    summary: "Save the note without checking its history first.",
    changes: [{ setting: "requirement", change: "drop", text: "Check the note's history first." }],
    confirmedBy: [],
    recommend: "update",
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "save"),
        call("mint_update", dropCheck, "refused"),
        call("mint_update", dropCheck, "applied"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      outcomeReview: review,
      reviewAndExecute: (_input, beforeDispatch) =>
        (beforeDispatch?.({ reviewId: "review_save", action: "write" }) ?? Effect.void).pipe(
          Effect.as({
            executionId: "save_1",
            status: "completed" as const,
            effect: "possible" as const,
            resultRef: "save_result",
            observations: { page: "Saved." },
            review: {
              reviewId: "review_save",
              outcome: "allow" as const,
              rationale: "Scripted review.",
              action: "write" as const,
            },
          }),
        ),
    },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "refused")).toMatchObject({ status: "reword" });
  expect(resultOf(f.requests, "applied")).toMatchObject({ status: "updated" });
  const events = saved.at(-1)?.events ?? [];
  expect(events.filter((event) => event.kind === "task_updated")).toEqual([
    expect.objectContaining({ change: expect.stringContaining(dropCheck.summary) as unknown }),
  ]);
});
