import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { fillAutofillStep } from "../destinations/autofill-fill.js";
import {
  checkAutofillSignedIn,
  identifierPreference,
  inspectAutofillStep,
} from "../destinations/autofill-step.js";
import type {
  AutofillField,
  AutofillInspection,
  AutofillPage,
  AutofillSignedIn,
  AutofillSlot,
  AutofillStep,
  AutofillStepRequest,
} from "../destinations/autofill-step.js";
import type { CredentialKeyboard } from "../destinations/credential-keyboard.js";
import { parseDateOfBirth, wholeDateLayouts } from "../destinations/login-field-formats.js";
import type { InputAsker, Question } from "../runtime/input-request.js";

const credentialQuestion = (
  slot: AutofillSlot,
  siteOrigin: string,
  currentFieldLabel?: string,
): Question => ({
  id: slot,
  type: "secret",
  secretKind: slot === "code" ? "one_time_code" : "private_text",
  prompt:
    slot === "private_answer" && currentFieldLabel !== undefined
      ? `${currentFieldLabel} (${siteOrigin})`
      : `Enter your ${slot.replaceAll("_", " ")}${slot === "date_of_birth" ? " (YYYY-MM-DD)" : ""} for ${siteOrigin}.`,
  maxLength: ["username", "email", "phone", "account_number"].includes(slot) ? 1024 : 16_384,
});

/** Local values feed the original inspected-field fill without a credential store or portal. */
export const makeLiveAuthentication = (options: {
  readonly page: AutofillPage;
  readonly keyboard: CredentialKeyboard;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly ask: InputAsker;
  readonly registerSecret: (value: string) => void;
  readonly review: (
    step: AutofillStep,
    inspection: AutofillInspection,
  ) => Effect.Effect<void, Error>;
}) => {
  const values: Partial<Record<AutofillSlot, string>> = {};
  const screens: AutofillStep[] = [];
  const field = (input: AutofillStepRequest["fields"][number]): AutofillField => {
    if ("slot" in input) return input;
    const held = identifierPreference.find(
      (kind) => input.accepts.includes(kind) && values[kind] !== undefined,
    );
    const slot = held ?? identifierPreference.find((kind) => input.accepts.includes(kind));
    if (slot === undefined) throw new Error("Sign-in field must accept an identifier kind");
    return { ...input, slot };
  };
  const step = (
    request: AutofillStepRequest,
    beforeFill: Effect.Effect<void, Error> = Effect.void,
  ) => {
    const privateAnswers: string[] = [];
    return Effect.gen(function* () {
      const selected: AutofillStep = yield* Effect.try({
        try: () => ({ ...request, fields: request.fields.map(field) }),
        catch: (cause) => new Error("Invalid sign-in field", { cause }),
      });
      const inspected = yield* inspectAutofillStep({
        step: selected,
        page: options.page,
        siteOrigin: options.siteOrigin,
        authenticationOrigins: options.authenticationOrigins,
      });
      if ("outcome" in inspected) return inspected;
      yield* options.review(selected, inspected);
      yield* beforeFill;
      const missing = [...new Set(selected.fields.map((item) => item.slot))].filter(
        (slot) =>
          slot !== "private_answer" &&
          (values[slot] === undefined || slot === "code" || slot === "recovery_code"),
      );
      if (missing.length > 0) {
        const answered = yield* options
          .ask({
            id: randomUUID(),
            source: "system",
            questions: missing.map((slot) => credentialQuestion(slot, options.siteOrigin)),
          })
          .pipe(
            Effect.mapError((cause) => new Error("Sign-in input was not completed", { cause })),
          );
        for (const slot of missing) {
          const answer = answered[slot];
          if (answer?.type !== "secret")
            return yield* Effect.fail(new Error("Invalid sign-in answer"));
          options.registerSecret(answer.value);
          const value = slot === "date_of_birth" ? parseDateOfBirth(answer.value) : answer.value;
          if (value === undefined)
            return yield* Effect.fail(new Error("Date of birth must be a valid YYYY-MM-DD date"));
          values[slot] = value;
          options.registerSecret(value);
          if (slot === "date_of_birth")
            for (const layout of wholeDateLayouts(value)) options.registerSecret(layout);
        }
      }
      for (const [index, item] of selected.fields.entries()) {
        if (item.slot !== "private_answer") continue;
        const answered = yield* options
          .ask({
            id: randomUUID(),
            source: "system",
            questions: [
              credentialQuestion(
                "private_answer",
                options.siteOrigin,
                inspected.screen.fields[index]?.questionText ??
                  inspected.screen.fields[index]?.label ?? undefined,
              ),
            ],
          })
          .pipe(
            Effect.mapError((cause) => new Error("Sign-in input was not completed", { cause })),
          );
        const answer = answered.private_answer;
        if (answer?.type !== "secret")
          return yield* Effect.fail(new Error("Invalid sign-in answer"));
        options.registerSecret(answer.value);
        privateAnswers[index] = answer.value;
      }
      const result = yield* fillAutofillStep({
        step: selected,
        inspection: inspected,
        page: options.page,
        keyboard: options.keyboard,
        values: selected.fields.map((item, index) =>
          item.slot === "private_answer" ? (privateAnswers[index] ?? "") : (values[item.slot] ?? ""),
        ),
      });
      screens.push(selected);
      delete values.code;
      delete values.recovery_code;
      return result;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          privateAnswers.fill("");
        }),
      ),
    );
  };
  return {
    step,
    rejected: (slot: AutofillSlot) => {
      delete values[slot];
    },
    signedIn: (indicator: AutofillSignedIn) =>
      checkAutofillSignedIn({
        indicator,
        page: options.page,
        siteOrigin: options.siteOrigin,
        screens,
      }),
  };
};
