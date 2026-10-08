import { Effect } from "effect";
import { MintFailure } from "../mint/contracts.js";
import { writeContractRefusal } from "../mint/write-contract.js";
import type { LocalOperationJournal, LocalOperationOutput } from "../execution/local-operation.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import type { OutcomeAssessment } from "../mint/outcome-review-contracts.js";

/**
 * A composed write is checked offline against actual act steps; it is never replayed. Returns
 * the confirmation it declares. The session submitted its write when an act step Guardian
 * labelled a write ran on the site and the outcome review has not found that it did not happen:
 * a write whose outcome is unknown or not yet assessed counts, since publication never waits.
 * Commit marks and confirmations stay the contract's evidence.
 */
export const validateStandaloneWrite = (
  contract: Pick<LocalOperationOutput, "write" | "inputDecodes">,
  session: {
    readonly named: LocalOperationJournal;
    readonly steps: readonly {
      readonly journal: LocalOperationJournal;
      readonly action?: GuardianAction;
      readonly assessment?: OutcomeAssessment;
    }[];
  },
): Effect.Effect<NonNullable<LocalOperationOutput["write"]>["confirmation"], MintFailure> =>
  Effect.suspend(() => {
    const enteredMarks = new Set(
      session.steps.flatMap(({ journal }) =>
        journal.commits.filter((mark) => mark.state !== "not_sent").map((mark) => mark.name),
      ),
    );
    const reason = writeContractRefusal(
      contract.write,
      contract.inputDecodes === true,
      session.named,
      {
        confirmed: session.steps.some(({ journal }) => journal.confirmation !== undefined),
        enteredMarks,
      },
    );
    if (reason !== undefined || contract.write === undefined)
      return Effect.fail(
        new MintFailure({
          code: "PublicationUnavailable",
          reason: reason ?? "confirmation_undeclared",
        }),
      );
    const submitted = session.steps.filter(
      (step) => step.action === "write" && step.journal.effect !== "not_sent",
    );
    if (submitted.every((step) => step.assessment?.outcome === "not_done"))
      return Effect.fail(
        new MintFailure({ code: "PublicationUnavailable", reason: "write_not_submitted" }),
      );
    return Effect.succeed(contract.write.confirmation);
  });
