import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type ControlCheckEvidence,
  type ControlCheckHost,
  type PublicationDecision,
} from "../../src/mint/contracts.js";
import type { ControlCheckPlan } from "../../src/mint/control-cases.js";
import type { ControlCheckRun } from "../../src/mint/control-verdicts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

// Control checks at finish_build of a read, through the harness with a scripted host: the host
// runs the plan the harness generated, and the harness refuses or publishes on the verdicts.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const mint = {
  mode: "mint",
  intent: "Search the catalog",
  businessInput: { query: "tent" },
  observations: [],
};
const repair = { ...mint, mode: "maintenance" };
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
  metadata: { name: "search", description: "Search the catalog" },
  coverage: "One example ran.",
};
const schemas = {
  input: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", examples: ["tent"] },
      sort: { type: "string", enum: ["price_asc", "price_desc"] },
    },
  },
  output: {
    type: "object",
    required: ["items"],
    properties: { items: { type: "array", items: { type: "object" } } },
  },
};
const listing = (...names: string[]) => ({
  status: "completed" as const,
  output: { items: names.map((name) => ({ name })) },
});
/** A run where every case returns a live, sortable listing. */
const working = (plan: ControlCheckPlan): ControlCheckRun => ({
  cases: plan.cases.map(({ key }) => ({
    key,
    outcome: key.includes("price_desc") ? listing("b", "a") : listing("a", "b"),
  })),
});
const decisions = () => {
  const recorded: PublicationDecision[] = [];
  return {
    recorded,
    log: {
      record: (decision: PublicationDecision) =>
        Effect.sync(() => {
          recorded.push(decision);
        }),
      list: Effect.sync(() => recorded),
    },
  };
};
const controlHost = (
  runControlCases: ControlCheckHost["runControlCases"],
  extra: Partial<ControlCheckHost> = {},
): ControlCheckHost => ({
  schemas: () => Effect.succeed(schemas),
  runControlCases,
  now: () => new Date("2026-10-09T12:00:00Z"),
  ...extra,
});

it("refuses publication as controls_stale when the source changed while the checks ran, then checks the current source", async () => {
  const fixture = makeMintHarnessFixture(cleanup, mint, portableJobSession);
  const digests: string[] = [];
  const published: (ControlCheckEvidence | undefined)[] = [];
  const answers: Record<string, unknown>[] = [];
  const { recorded, log } = decisions();
  let root = "";
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      publicationDecisions: log,
      controlChecks: controlHost((plan, bundleDigest) =>
        Effect.promise(async () => {
          digests.push(bundleDigest);
          // The first check run overlaps an edit of the source it checks.
          if (digests.length === 1)
            await writeFile(join(root, "src/tool.ts"), "export const edited = true;\n");
          return working(plan);
        }),
      ),
      publish: (_request, _evidence, controlChecks) =>
        Effect.sync(() => {
          published.push(controlChecks);
          return { publicationRef: "published-revision", diagnostics: [] };
        }),
    },
  );
  root = (f.workspace as unknown as { root: string }).root;
  const outcome = await f.run();
  expect(answers[0]).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "controls_stale",
    userInputRequired: false,
  });
  expect(recorded[0]).toMatchObject({ outcome: "refused", reason: "controls_stale" });
  // The next finish_build checks the edited source and publishes it with that digest.
  expect(digests).toHaveLength(2);
  expect(digests[1]).not.toBe(digests[0]);
  expect(published).toEqual([
    expect.objectContaining({
      bundleDigest: digests[1],
      results: expect.arrayContaining([expect.objectContaining({ key: "{}", verdict: "pass" })]),
    }),
  ]);
  expect(outcome).toMatchObject({ build: "published" });
});

it("refuses a schema without examples before running any case, naming the fields", async () => {
  const fixture = makeMintHarnessFixture(cleanup, mint, portableJobSession);
  const answers: Record<string, unknown>[] = [];
  let runs = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      controlChecks: controlHost(
        (plan) =>
          Effect.sync(() => {
            runs++;
            return working(plan);
          }),
        {
          schemas: () =>
            Effect.succeed({
              input: { type: "object", properties: { query: { type: "string" } } },
              output: schemas.output,
            }),
        },
      ),
    },
  );
  await f.run();
  expect(answers[0]).toMatchObject({
    status: "not_published",
    reason: "input_examples_missing",
    controlChecks: { fields: ["query"] },
  });
  expect(runs).toBe(0);
});

it("blocks a repair whose candidate breaks a control that passed on the published revision, and a control broken on both", async () => {
  const fixture = makeMintHarnessFixture(cleanup, repair, portableJobSession);
  const answers: Record<string, unknown>[] = [];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      canPublishRepair: () => true,
      controlChecks: controlHost((plan) =>
        Effect.succeed({
          cases: plan.cases.map(({ key }) => ({
            key,
            outcome: key.includes("sort")
              ? {
                  status: "failed" as const,
                  errorClass: "TimeoutError",
                  failingFrame: "src/sort.ts:4",
                }
              : key === "{}"
                ? listing("a", "b")
                : listing(),
          })),
          baseline: [
            { key: "{}", fields: [], verdict: "pass" as const },
            { key: '{"sort":"price_asc"}', fields: ["sort"], verdict: "pass" as const },
            { key: '{"sort":"price_desc"}', fields: ["sort"], verdict: "fail" as const },
          ],
        }),
      ),
      publish: () =>
        Effect.sync(() => {
          publishes++;
          return { publicationRef: "published-revision", diagnostics: [] };
        }),
    },
  );
  await f.run();
  expect(publishes).toBe(0);
  expect(answers[0]).toMatchObject({
    status: "not_published",
    reason: "control_regression",
    controlChecks: {
      findings: [
        {
          reason: "control_regression",
          key: '{"sort":"price_asc"}',
          errorClass: "TimeoutError",
          failingFrame: "src/sort.ts:4",
          passedOnBaseline: true,
        },
        { reason: "control_broken", key: '{"sort":"price_desc"}', passedOnBaseline: false },
      ],
    },
  });
  expect(String(answers[0]?.["instruction"])).toContain('{"sort":"price_asc"}');
});

it("publishes with every case inconclusive when the host could not run its checks", async () => {
  const fixture = makeMintHarnessFixture(cleanup, mint, portableJobSession);
  const coverage: string[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        yield* turn.actions.finish(publication);
      }),
    {
      controlChecks: controlHost(() => Effect.fail(new MintFailure({ code: "Unavailable" }))),
      publish: (request) =>
        Effect.sync(() => {
          coverage.push(request.coverage);
          return { publicationRef: "published-revision", diagnostics: [] };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published" });
  expect(coverage[0]).toContain("inconclusive (host)");
});

it("runs no checks for a write build", async () => {
  const fixture = makeMintHarnessFixture(cleanup, { ...mint, effect: "write" }, portableJobSession);
  let runs = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...example, purpose: "act", target: "liveBrowser" });
        yield* turn.actions.finish(publication);
      }),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "execution_one",
          status: "completed",
          effect: "verified",
          confirmation: "message",
          resultRef: "private-result-ref",
          observations: {},
        }),
      controlChecks: controlHost((plan) =>
        Effect.sync(() => {
          runs++;
          return working(plan);
        }),
      ),
    },
  );
  await f.run();
  expect(runs).toBe(0);
});
