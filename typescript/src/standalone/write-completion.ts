import { Effect } from "effect";
import { MintFailure } from "../mint/contracts.js";
import { writeContractRefusal } from "../mint/write-contract.js";
import type { LocalOperationJournal, LocalOperationOutput } from "../execution/local-operation.js";

/** A composed write is checked offline against actual act steps; it is never replayed. */
export const validateStandaloneWrite = (
  contract: Pick<LocalOperationOutput, "write" | "inputDecodes">,
  session: {
    readonly named: LocalOperationJournal;
    readonly steps: readonly LocalOperationJournal[];
  },
): Effect.Effect<void, MintFailure> =>
  Effect.suspend(() => {
    const enteredMarks = new Set(
      session.steps.flatMap((step) =>
        step.commits.filter((mark) => mark.state !== "not_sent").map((mark) => mark.name),
      ),
    );
    const reason = writeContractRefusal(
      contract.write,
      contract.inputDecodes === true,
      session.named,
      {
        confirmed: session.steps.some((step) => step.confirmation !== undefined),
        enteredMarks,
      },
    );
    if (reason !== undefined)
      return Effect.fail(new MintFailure({ code: "PublicationUnavailable", reason }));
    if (!session.steps.some((step) => step.effect !== "not_sent"))
      return Effect.fail(
        new MintFailure({ code: "PublicationUnavailable", reason: "write_not_submitted" }),
      );
    return Effect.void;
  });
