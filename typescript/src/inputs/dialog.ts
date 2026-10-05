import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { DialogFailure } from "../runtime/dialogs.js";
import type { DialogDecider } from "../runtime/kernel-operation.js";
import type { InputAsker } from "../runtime/input-request.js";

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
