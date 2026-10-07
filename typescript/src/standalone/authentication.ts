import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { fillAutofillStep } from "../destinations/autofill-fill.js";
import { maySend, typingRefusal } from "../destinations/autofill-refusal.js";
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
import { rememberTyping } from "../destinations/autofill-typed-page.js";
import type { CredentialKeyboard } from "../destinations/credential-keyboard.js";
import { parseDateOfBirth, wholeDateLayouts } from "../destinations/login-field-formats.js";
import type { InputAsker, Question } from "../runtime/input-request.js";
import { autofillRefusalFailure } from "../mint/sign-in-failure.js";

const credentialQuestion = (slot: AutofillSlot, siteOrigin: string, prompt?: string): Question => ({
  id: slot,
  type: "secret",
  secretKind: slot === "code" ? "one_time_code" : "private_text",
  prompt:
    prompt ??
    `Enter your ${slot.replaceAll("_", " ")}${slot === "date_of_birth" ? " (YYYY-MM-DD)" : ""} for ${siteOrigin}.`,
  maxLength: ["username", "email", "phone", "account_number"].includes(slot) ? 1024 : 16_384,
});

/** The longest prompt a question may have, as the input request allows. */
const promptLimit = 2_000;

/**
 * What the owner is asked for a private answer: the question the page shows, cut to leave room
 * for the site's origin; else that the recorded question could not be read; else the field's label.
 */
const answerPrompt = (
  siteOrigin: string,
  field:
    | {
        readonly questionText?: string | undefined;
        readonly questionUnread?: true | undefined;
        readonly label: string | null;
      }
    | undefined,
) => {
  const label = field?.label ?? null;
  if (field?.questionText !== undefined) {
    const suffix = ` (${siteOrigin})`;
    const room = promptLimit - suffix.length;
    const question =
      field.questionText.length <= room
        ? field.questionText
        : `${field.questionText.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
    return `${question}${suffix}`;
  }
  if (field?.questionUnread === true)
    return `Enter your security answer for ${siteOrigin}. The question it answers could not be read from the page.${label === null ? "" : ` The answer field reads "${label}".`}`;
  return label === null ? undefined : `${label} (${siteOrigin})`;
};

/**
 * Whether the host typed a sign-in value into the session browser's page. It lasts for the
 * session, since page code may have kept what was typed for any later screen.
 */
export interface SessionTyping {
  typed: boolean;
}

/**
 * Local values feed the original inspected-field fill without a credential store or portal. A fill
 * that refused a field of the screen fails as a sign-in the host refused (`autofillRefusalFailure`).
 * Once the host typed into the page, each later screen is judged as typed into (`rememberTyping`).
 * `typing` carries that across every authentication on the same browser; without it, this one
 * keeps its own. A check that shows the site signed in ends the sign-in, so a later check counts
 * only the challenge fields of screens filled after it.
 */
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
  readonly typing?: SessionTyping;
}) => {
  const typing = options.typing ?? { typed: false };
  const browser = rememberTyping({
    inspect: (request) =>
      inspectAutofillStep({
        ...request,
        page: options.page,
        siteOrigin: options.siteOrigin,
        authenticationOrigins: options.authenticationOrigins,
      }),
    fill: (input: {
      readonly step: AutofillStep;
      readonly inspection: AutofillInspection;
      readonly values: readonly string[];
    }) =>
      fillAutofillStep({ ...input, page: options.page, keyboard: options.keyboard }).pipe(
        // The shared record counts what `rememberTyping` counts: a fill that typed.
        Effect.tap((report) =>
          Effect.sync(() => {
            if (report.outcome !== "refused" && report.typed === true) typing.typed = true;
          }),
        ),
      ),
    typed: typing.typed,
  });
  const values: Partial<Record<AutofillSlot, string>> = {};
  const screens: AutofillStep[] = [];
  /** Where the current sign-in's screens start in `screens`. */
  let signInStart = 0;
  /** Whether a screen's fill may have sent anything to the site. */
  let sent = false;
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
      const inspected = yield* browser.inspect(selected);
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
                answerPrompt(options.siteOrigin, inspected.screen.fields[index]),
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
      const result = yield* browser.fill({
        step: selected,
        inspection: inspected,
        values: selected.fields.map((item, index) =>
          item.slot === "private_answer" ? (privateAnswers[index] ?? "") : (values[item.slot] ?? ""),
        ),
      });
      screens.push(selected);
      delete values.code;
      delete values.recovery_code;
      if (maySend(result)) sent = true;
      const refusal = typingRefusal(selected, result);
      if (refusal !== undefined)
        return yield* Effect.fail(autofillRefusalFailure(refusal, { nothingSubmitted: !sent }));
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
        authenticationOrigins: options.authenticationOrigins,
        screens,
        challengeScreens: screens.slice(signInStart),
      }).pipe(
        Effect.tap((checked) =>
          Effect.sync(() => {
            if (checked.signedIn) signInStart = screens.length;
          }),
        ),
      ),
  };
};
