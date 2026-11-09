import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintHarnessSnapshot,
  type MintDependencies,
  type TaskUpdateCandidate,
} from "../../src/mint/contracts.js";
import type { MintAgentSnapshot } from "../../src/mint/recovery-contracts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const site = "https://notes.example.test";
const request = {
  mode: "mint",
  intent: "Read the saved notes",
  businessInput: { day: "2026-11-01" },
  observations: [],
  siteOrigin: site,
};
const fixture = makeMintHarnessFixture(cleanup, request, portableJobSession);

const question = {
  questions: [{ id: "day", type: "text" as const, prompt: "Which day should the notes be from?" }],
};
const toNovemberTwo = {
  summary: "Read the notes from November 2 instead of November 1.",
  changes: [{ setting: "input", values: { day: "2026-11-02" } }],
  confirmedBy: ["day"],
  recommend: "update",
};
/** A Guardian that allows every update, and what it reviewed. */
const allowing =
  (reviews: TaskUpdateCandidate[]): NonNullable<MintDependencies["reviewTaskUpdate"]> =>
  (candidate) =>
    Effect.sync(() => {
      reviews.push(candidate);
      return { outcome: "allow" as const, rationale: "Confirmed.", reviewId: "review" };
    });
const agent: MintAgentSnapshot = {
  version: 1,
  sdkVersion: "0.18.0",
  sdkState: "",
  modelCalls: 0,
  finalsWithoutTool: 0,
  tools: [],
};

it("restores an applied update and the caller's answers after a takeover, and never applies it twice", async () => {
  // The first worker asks, then updates; the host stores the checkpoint it is given.
  let stored: unknown;
  const first = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(question);
        const updated = JSON.parse(yield* turn.actions.updateTask!(toNovemberTwo));
        expect(updated).toMatchObject({ status: "updated", task: { revision: 1 } });
      }),
    {
      askInput: () => Effect.succeed({ day: { type: "text", value: "November 2 instead" } }),
      reviewTaskUpdate: allowing([]),
      applyTaskUpdate: (application) =>
        Effect.sync(() => {
          stored = JSON.parse(JSON.stringify(application.harness));
          return { outcome: "applied" as const };
        }),
    },
  );
  await first.run();
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(stored);

  // The worker that takes over gets the same call again, then another update on the same answer.
  const reviews: TaskUpdateCandidate[] = [];
  let applied = 0;
  const results: Record<string, unknown>[] = [];
  const second = await fixture(
    (turn) =>
      Effect.gen(function* () {
        results.push(JSON.parse(yield* turn.actions.updateTask!(toNovemberTwo)));
        results.push(
          JSON.parse(
            yield* turn.actions.updateTask!({
              ...toNovemberTwo,
              summary: "Read only the pinned notes from November 2.",
              changes: [{ setting: "requirement", change: "add", text: "Only pinned notes." }],
            }),
          ),
        );
      }),
    {
      agentRecovery: { initial: { agent, harness }, save: () => Effect.void },
      reviewTaskUpdate: allowing(reviews),
      applyTaskUpdate: () =>
        Effect.sync(() => {
          applied++;
          return { outcome: "applied" as const };
        }),
    },
  );
  await second.run();
  expect(results[0]).toMatchObject({ status: "updated", task: { revision: 1 } });
  expect(results[1]).toMatchObject({ status: "updated", task: { revision: 2 } });
  // Only the new update was reviewed and applied, against the restored task and answer.
  expect(applied).toBe(1);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.current).toMatchObject({
    revision: 1,
    businessInput: { day: "2026-11-02" },
  });
  expect(reviews[0]?.update.confirmation).toEqual([
    { id: "day", question: "Which day should the notes be from?", answer: "November 2 instead" },
  ]);
});

it("applies nothing when the host refuses, so a takeover restores the task as it was", async () => {
  const snapshots: MintHarnessSnapshot[] = [];
  let capture: (() => MintHarnessSnapshot) | undefined;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(question);
        const refused = JSON.parse(yield* turn.actions.updateTask!(toNovemberTwo));
        expect(refused).toMatchObject({ status: "update_refused", reason: "intake_refused" });
        if (capture !== undefined) snapshots.push(capture());
      }),
    {
      askInput: () => Effect.succeed({ day: { type: "text", value: "November 2 instead" } }),
      reviewTaskUpdate: allowing([]),
      applyTaskUpdate: () =>
        Effect.succeed({
          outcome: "refused" as const,
          reason: "intake_refused",
          notice: "Intake screening refused the updated task.",
        }),
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await f.run();
  expect(snapshots[0]).not.toHaveProperty("taskState");
  expect(snapshots[0]?.answeredQuestions).toHaveLength(1);
});


it("restores a write build lowered to a read as a read after a takeover", async () => {
  const writeFixture = makeMintHarnessFixture(
    cleanup,
    { ...request, effect: "write" },
    portableJobSession,
  );
  const toRead = {
    summary: "Only read the notes; never save one.",
    changes: [{ setting: "effect", effect: "read" }],
    confirmedBy: ["effect"],
    recommend: "update",
  };
  const effectQuestion = {
    questions: [
      {
        id: "effect",
        type: "choice" as const,
        prompt: "Read the notes, or save one?",
        options: [
          { id: "read", label: "Only read the notes" },
          { id: "write", label: "Save a note" },
        ],
      },
    ],
  };
  let stored: unknown;
  const first = await writeFixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(effectQuestion);
        const updated = JSON.parse(yield* turn.actions.updateTask!(toRead));
        expect(updated).toMatchObject({ status: "updated", task: { effect: "read" } });
      }),
    {
      askInput: () => Effect.succeed({ effect: { type: "choice", value: "read" } }),
      reviewTaskUpdate: allowing([]),
      lowersEffect: true,
      applyTaskUpdate: (application) =>
        Effect.sync(() => {
          stored = JSON.parse(JSON.stringify(application.harness));
          return { outcome: "applied" as const };
        }),
    },
  );
  await first.run();
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(stored);
  const results: Record<string, unknown>[] = [];
  const second = await writeFixture(
    (turn) =>
      Effect.gen(function* () {
        results.push(JSON.parse(yield* turn.actions.updateTask!(toRead)));
      }),
    {
      agentRecovery: { initial: { agent, harness }, save: () => Effect.void },
      reviewTaskUpdate: allowing([]),
      lowersEffect: true,
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
  );
  await second.run();
  expect(results[0]).toMatchObject({ status: "updated", task: { revision: 1, effect: "read" } });
});

it("keeps a write build a write once live execution closed before a takeover", async () => {
  const writeFixture = makeMintHarnessFixture(
    cleanup,
    { ...request, effect: "write" },
    portableJobSession,
  );
  let stored: unknown;
  const first = await writeFixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(question);
        yield* turn.actions.updateTask!(toNovemberTwo);
      }),
    {
      askInput: () => Effect.succeed({ day: { type: "text", value: "November 2 instead" } }),
      reviewTaskUpdate: allowing([]),
      applyTaskUpdate: (application) =>
        Effect.sync(() => {
          stored = JSON.parse(JSON.stringify(application.harness));
          return { outcome: "applied" as const };
        }),
    },
  );
  await first.run();
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)({
    ...(stored as object),
    executionClosed: true,
  });
  const reviews: TaskUpdateCandidate[] = [];
  const results: Record<string, unknown>[] = [];
  const second = await writeFixture(
    (turn) =>
      Effect.gen(function* () {
        results.push(
          JSON.parse(
            yield* turn.actions.updateTask!({
              summary: "Only read the notes; never save one.",
              changes: [{ setting: "effect", effect: "read" }],
              confirmedBy: ["day"],
              recommend: "update",
            }),
          ),
        );
      }),
    {
      agentRecovery: { initial: { agent, harness }, save: () => Effect.void },
      reviewTaskUpdate: allowing(reviews),
      lowersEffect: true,
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
  );
  await second.run();
  expect(results[0]).toMatchObject({ status: "update_refused", reason: "no_live_example_left" });
  expect(reviews).toEqual([]);
});
