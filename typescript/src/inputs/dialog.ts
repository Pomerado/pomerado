import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ExpectedConfirm } from "../browser/dialogs/contracts.js";
import {
  keepAcceptedConfirm,
  makeRunDialogDecision,
  type ObservedConfirm,
} from "../browser/dialogs/expected.js";
import { DialogFailure } from "../runtime/dialogs.js";
import type { IncidentStore } from "../runtime/incidents.js";
import type { DialogDecider, DialogReport } from "../runtime/kernel-operation.js";
import type { InputAsker } from "../runtime/input-request.js";

/** A script's report as the shared confirm matcher reads it: its step is the action that raised it. */
const eventOf = (report: DialogReport) => ({ type: report.type, candidateActionId: report.step });
const factsOf = (report: DialogReport) => ({ message: report.message, pageUrl: report.url });

/** Native dialogs stay open while the caller decides in their input surface. */
export const makeDialogDecider =
  (ask: InputAsker, project: (text: string) => string): DialogDecider =>
  (report) =>
    Effect.gen(function* () {
      const answers = yield* ask({
        id: randomUUID(),
        source: "system",
        notice: project(`${report.type} from ${report.url}\n${report.message}`),
        questions: [
          {
            id: "choice",
            type: "choice",
            prompt: "How should Pomerado respond to this dialog?",
            options: [
              { id: "accept", label: "Accept" },
              { id: "dismiss", label: "Dismiss" },
            ],
          },
        ],
      });
      const choice = answers.choice;
      if (choice?.type !== "choice" || choice.value !== "accept")
        return { choice: "dismiss" as const };
      if (report.type !== "prompt") return { choice: "accept" as const };
      const response = yield* ask({
        id: randomUUID(),
        source: "system",
        questions: [
          {
            id: "text",
            type: "secret",
            secretKind: "private_text",
            maxLength: 16_384,
            prompt: "Enter the text to submit to this dialog.",
          },
        ],
      });
      const text = response.text;
      if (text?.type !== "secret")
        return yield* Effect.fail(new DialogFailure({ reason: "invalid_request" }));
      return { choice: "accept" as const, promptText: text.value };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DialogFailure ? cause : new DialogFailure({ reason: "unavailable" }),
      ),
    );

/**
 * A build's decider that also keeps, in `accepted`, each confirm the owner accepted that a run
 * could expect, so an act step's accepted confirms can be published with the tool.
 */
export const keepingAcceptedConfirms =
  (decide: DialogDecider, accepted: ObservedConfirm[]): DialogDecider =>
  (report) =>
    decide(report).pipe(
      Effect.tap((decision) =>
        Effect.sync(() =>
          keepAcceptedConfirm(accepted, { event: eventOf(report), facts: factsOf(report), decision }),
        ),
      ),
    );

/**
 * A run's native dialogs. A write's confirm that its build accepted, with the same message on the
 * same page origin at the same step, is accepted without asking, once per record. Every other
 * dialog asks the caller, as a build does. A dialog whose answer never comes, or that cannot be
 * asked, is dismissed, never accepted, and the run goes on.
 */
export const makeRunDialogDecider = (input: {
  readonly ask: InputAsker;
  readonly project: (text: string) => string;
  /** A read tool accepts nothing from the record. */
  readonly readOnly: boolean;
  readonly expectedConfirms?: readonly ExpectedConfirm[] | undefined;
  readonly incidents: IncidentStore;
}): DialogDecider => {
  const askCaller = makeDialogDecider(input.ask, input.project);
  const decide = makeRunDialogDecision({
    readOnly: input.readOnly,
    expectedConfirms: input.expectedConfirms,
    askCaller: (report: Parameters<DialogDecider>[0] & { readonly candidateActionId: string }) =>
      askCaller(report).pipe(
        Effect.catchAll(() =>
          input.incidents
            .record({
              source: "host",
              kind: "dialog",
              reason: "dialog_decision_expired",
              hostBug: false,
              severity: "info",
              subCause: `${report.type}_dismiss`,
            })
            .pipe(Effect.as({ choice: "dismiss" as const })),
        ),
      ),
    incidents: input.incidents,
    askEveryDialog: true,
  });
  return (report) => decide({ ...report, ...eventOf(report) }, factsOf(report));
};
