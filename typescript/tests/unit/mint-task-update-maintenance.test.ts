import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type MintDependencies,
  type TaskUpdateApplication,
  type TaskUpdateCandidate,
} from "../../src/mint/contracts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const site = "https://notes.example.test";
const repair = {
  mode: "maintenance",
  intent: "Read the saved notes with each note's color",
  businessInput: { day: "2026-11-01" },
  observations: [],
  siteOrigin: site,
};
const fixture = makeMintHarnessFixture(cleanup, repair, portableJobSession);

const colorQuestion = {
  questions: [
    {
      id: "color",
      type: "choice" as const,
      prompt: "The notes page no longer shows a note's color. May the tool stop returning it?",
      options: [
        { id: "drop", label: "Yes, return notes without a color" },
        { id: "keep", label: "No, keep the color" },
      ],
    },
  ],
};
/** Loosening one output field of the registered contract, as a repair proposes it. */
const dropColor = {
  summary: "Return each note without its color, which the notes page no longer shows.",
  changes: [
    {
      setting: "output",
      field: "notes[].color",
      change: "remove",
      text: "The notes page no longer shows a color for any note.",
    },
  ],
  confirmedBy: ["color"],
  recommend: "update",
};

/** A Guardian that allows every update, and a host that applies it, recording both. */
const updateHost = () => {
  const reviews: TaskUpdateCandidate[] = [];
  const applied: TaskUpdateApplication[] = [];
  const dependencies: Partial<MintDependencies> = {
    reviewTaskUpdate: (candidate) =>
      Effect.sync(() => {
        reviews.push(candidate);
        return { outcome: "allow" as const, rationale: "Confirmed.", reviewId: "review" };
      }),
    applyTaskUpdate: (application) =>
      Effect.sync(() => {
        applied.push(application);
        return { outcome: "applied" as const };
      }),
    askInput: () => Effect.succeed({ color: { type: "choice", value: "drop" } }),
  };
  return { reviews, applied, dependencies };
};

/** Runs a repair that asks the owner, then proposes `update`, and returns the update's result. */
const propose = async (
  update: object,
  dependencies: Partial<MintDependencies>,
  request: object = repair,
) => {
  const results: Record<string, unknown>[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(colorQuestion);
        results.push(JSON.parse(yield* turn.actions.updateTask!(update)));
      }),
    dependencies,
  );
  await f.run(request);
  return results[0];
};

it("applies an output change to a repaired tool's contract once its owner confirms it", async () => {
  const host = updateHost();
  const result = await propose(dropColor, {
    ...host.dependencies,
    taskUpdateConfirmer: () => Effect.succeed("owner"),
  });
  expect(result).toMatchObject({ status: "updated", task: { revision: 1 } });
  // Guardian reviewed it knowing the owner answered, then the host applied the same change.
  expect(host.reviews[0]?.update).toMatchObject({
    changes: [{ setting: "output", field: "notes[].color", change: "remove" }],
    maintenance: { confirmer: "owner" },
  });
  expect(host.applied[0]?.update.changes).toEqual(dropColor.changes);
});

it.each([
  { case: "nobody who owns the tool", confirmer: () => Effect.succeed("none" as const) },
  {
    case: "a confirmer that fails",
    confirmer: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
  },
  { case: "a host without a confirmer", confirmer: undefined },
])("keeps the registered contract with $case, before any review", async ({ confirmer }) => {
  const host = updateHost();
  const result = await propose(dropColor, {
    ...host.dependencies,
    ...(confirmer === undefined ? {} : { taskUpdateConfirmer: confirmer }),
  });
  expect(result).toMatchObject({ status: "update_refused", reason: "owner_unavailable" });
  expect(host.reviews).toEqual([]);
  expect(host.applied).toEqual([]);
});

it("asks for the owner's confirmation before reviewing a contract change that cites none", async () => {
  const host = updateHost();
  const result = await propose(
    { ...dropColor, confirmedBy: [] },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
  );
  expect(result).toMatchObject({
    status: "clarification_required",
    source: "host",
    reason: "confirmation_required",
  });
  expect(host.reviews).toEqual([]);
});

it.each([
  { setting: "input", change: { setting: "input", values: { day: "2026-11-02" } } },
  { setting: "effect", change: { setting: "effect", effect: "write" } },
  { setting: "site", change: { setting: "site", origin: "https://notes.example.org" } },
  { setting: "login", change: { setting: "login", change: "sign_in" } },
])("refuses changing the $setting in maintenance before any review", async ({ change }) => {
  const host = updateHost();
  const result = await propose(
    { ...dropColor, changes: [dropColor.changes[0], change] },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
  );
  expect(result).toMatchObject({ status: "update_refused", reason: "maintenance_setting" });
  expect(host.reviews).toEqual([]);
});

it("refuses a recommended new build in maintenance before any review", async () => {
  const host = updateHost();
  const result = await propose(
    {
      ...dropColor,
      recommend: "new_mint",
      suggestedRequest: "Read the saved notes without their colors.",
    },
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
  );
  expect(result).toMatchObject({ status: "update_refused", reason: "maintenance_setting" });
  expect(host.reviews).toEqual([]);
});

it("refuses an output change outside maintenance, where the build sets its own schema", async () => {
  const host = updateHost();
  const result = await propose(
    dropColor,
    { ...host.dependencies, taskUpdateConfirmer: () => Effect.succeed("owner") },
    { ...repair, mode: "mint" },
  );
  expect(result).toMatchObject({ status: "update_refused", reason: "output_outside_maintenance" });
  expect(host.reviews).toEqual([]);
});
