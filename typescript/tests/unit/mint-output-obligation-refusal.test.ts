import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, type PublicationDecision } from "../../src/mint/contracts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";


// The host's publication refuses a loosening repair before any review. The minter reads each
// field and its change as data, the build goes on, and publishing the fixed repair succeeds.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const repair = {
  mode: "maintenance",
  intent: "Read an order with its price",
  businessInput: { order: "A-1" },
  observations: [],
};
const fixture = makeMintHarnessFixture(cleanup, repair, portableJobSession);
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
  metadata: { name: "order", description: "Read an order with its price" },
  coverage: "One example ran.",
};

it("hands a repair that loosens its output contract each field and change, and publishes once it is fixed", async () => {
  const weakened = [
    { field: "price.amount", change: "nullable" as const },
    { field: "currency", change: "removed" as const },
  ];
  const recorded: PublicationDecision[] = [];
  const answers: Record<string, unknown>[] = [];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        yield* turn.actions.finish(publication);
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: () =>
        publishes++ === 0
          ? Effect.fail(
              new MintFailure({
                code: "PublicationUnavailable",
                reason: "output_obligation_weakened",
                weakenedOutputs: weakened,
              }),
            )
          : Effect.succeed({ publicationRef: "published-revision", diagnostics: [] }),
    },
  );
  const outcome = await f.run();
  expect(answers[0]).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "output_obligation_weakened",
    weakenedOutputs: weakened,
    userInputRequired: false,
  });
  expect(answers[0]).not.toHaveProperty("retryable");
  expect(recorded[0]).toMatchObject({
    reason: "output_obligation_weakened",
    recovery: "correct_source",
  });
  // Not a review and not an outage: the same receipt publishes on the next call.
  expect(publishes).toBe(2);
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
});
