import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import {
  InputRequestFailure,
  type InputAsker,
  type InputRequest,
} from "../../src/runtime/input-request.js";
import type { ScriptQuestionDeclarations } from "../../src/runtime/script-input.js";
import {
  returnedRun,
  runOutcomeFailure,
  type RunOutcomeFailure,
} from "../../src/standalone/run-report.js";

// A synthetic claims form: the script fills it, hands the browser to a person to check it, then
// reads the page again. The browser's page after the hand-off is the scenario: the person
// submitted the claim, left it waiting, or left a page that is neither. What the caller is told
// depends on that page and on what the script could prove.

const entrypoint = "operation/src/tool.mjs";
const questions: ScriptQuestionDeclarations = {
  review_claim: {
    type: "browser_handoff",
    prompt: "Check the claim form, correct anything wrong, then mark this step done.",
    show_inputs: ["policy_number", "amount"],
  },
};
/** The script; `afterHandOff` is what it does once the person handed the browser back. */
const claimTool = (
  effect: "read" | "write",
  afterHandOff: "branch" | "fail_unproven" = "branch",
) => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    input: Schema.Struct({ policy_number: Schema.String, amount: Schema.String }),
    output: Schema.Struct({ reference: Schema.String, submitted_by: Schema.String }),
    questions: ${JSON.stringify(questions)},
    ${effect === "write" ? 'write: { confirmation: "readback", commits: ["submit-claim"] },' : ""}
  },
  async ({ kernel, sessionId, handOff, verified, enteringCommit, notCommitted, errors }) => {
    await kernel.browsers.playwright.execute(sessionId, { code: "return fillClaim();" });
    await handOff("review_claim");
    const after = await kernel.browsers.playwright.execute(sessionId, { code: "return readClaimPage();" });
    ${afterHandOff === "fail_unproven" ? 'throw new errors.OperationFailure("The page did not load");' : ""}
    if (after.result.state === "submitted") {
      ${effect === "write" ? "verified();" : ""}
      return { reference: after.result.reference, submitted_by: "person" };
    }
    if (after.result.state !== "waiting") throw new errors.HandoffStateChanged();
    ${effect === "write" ? 'notCommitted("submit-claim"); enteringCommit("submit-claim");' : ""}
    const submitted = await kernel.browsers.playwright.execute(sessionId, { code: "return submitClaim();" });
    ${effect === "write" ? "verified();" : ""}
    return { reference: submitted.result.reference, submitted_by: "tool" };
  },
);`;

/** A browser whose claim page, read after the hand-off, shows `page`. */
const browserShowing = (page: unknown) => ({
  sessionId: "local",
  executeResponse: (code: string) =>
    Effect.succeed({
      success: true,
      result: code.includes("readClaimPage")
        ? page
        : code.includes("submitClaim")
          ? { reference: "C-2" }
          : null,
    }),
});

/** A person who checks the form and marks the step done; every request asked is kept. */
const personMarksDone = (asked: InputRequest[]): InputAsker => (request) =>
  Effect.sync(() => {
    asked.push(request);
    return { review_claim: { type: "browser_handoff" as const, value: { done: true as const } } };
  });

const run = (options: {
  readonly effect: "read" | "write";
  readonly page: unknown;
  readonly ask: InputAsker;
  readonly afterHandOff?: "branch" | "fail_unproven";
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, claimTool(options.effect, options.afterHandOff)]],
          input: { policy_number: "P-100", amount: "120.50" },
          browser: browserShowing(options.page),
          ask: options.ask,
          declaredQuestions: questions,
        }).pipe(
          Effect.mapError(runOutcomeFailure(options.effect, "operation")),
          Effect.flatMap((result) => returnedRun(options.effect, result)),
          Effect.either,
        );
      }),
    ),
  );
const failureOf = (settled: Either.Either<unknown, RunOutcomeFailure>) => {
  if (Either.isRight(settled)) throw new Error("Expected a failed run");
  return settled.left;
};

// Each case starts a local operation child, which takes seconds on a loaded host.
describe("a run that hands its browser to a person", { timeout: 30_000 }, () => {
  it("asks the declared hand-off alone, with its shown inputs, and returns the person's submission", async () => {
    const asked: InputRequest[] = [];
    const settled = await run({
      effect: "write",
      page: { state: "submitted", reference: "C-1" },
      ask: personMarksDone(asked),
    });
    expect(settled).toEqual(Either.right({ reference: "C-1", submitted_by: "person" }));
    expect(asked.map((request) => [request.source, request.questions])).toEqual([
      [
        "script",
        [
          {
            id: "review_claim",
            type: "browser_handoff",
            prompt: "Check the claim form, correct anything wrong, then mark this step done.",
            show_inputs: ["policy_number", "amount"],
          },
        ],
      ],
    ]);
  });

  it("submits a form the person left waiting itself, once it put the step back unsent", async () => {
    expect(
      await run({ effect: "write", page: { state: "waiting" }, ask: personMarksDone([]) }),
    ).toEqual(Either.right({ reference: "C-2", submitted_by: "tool" }));
  });

  it("stops as handoff_state_changed, possibly committed, when a write's page changed", async () => {
    const failure = failureOf(
      await run({ effect: "write", page: { state: "other" }, ask: personMarksDone([]) }),
    );
    expect(failure.outcome).toMatchObject({
      code: "handoff_state_changed",
      details: { possible_commit: true },
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(failure.message).toContain(
      "The page changed while a person had the browser, so the tool stopped without acting further.",
    );
  });

  it("reports a write that fails right after the hand-off, proving nothing, as possibly committed", async () => {
    const failure = failureOf(
      await run({
        effect: "write",
        page: { state: "waiting" },
        ask: personMarksDone([]),
        afterHandOff: "fail_unproven",
      }),
    );
    expect(failure.outcome).toMatchObject({ possibleCommit: true, writeStatus: "may_have_applied" });
    expect(failure.journal?.commits).toEqual([{ name: "submit-claim", state: "sent" }]);
  });

  it("tells a read whose page changed that nothing was committed", async () => {
    const failure = failureOf(
      await run({ effect: "read", page: { state: "other" }, ask: personMarksDone([]) }),
    );
    expect(failure.outcome).toMatchObject({
      code: "handoff_state_changed",
      possibleCommit: false,
      writeStatus: null,
    });
  });

  it("fails as no_response when the person never marks the step done", async () => {
    const failure = failureOf(
      await run({
        effect: "write",
        page: { state: "waiting" },
        ask: () => Effect.fail(new InputRequestFailure({ code: "NoResponse" })),
      }),
    );
    expect(failure.outcome).toMatchObject({ code: "no_response", possibleCommit: true });
  });
});
