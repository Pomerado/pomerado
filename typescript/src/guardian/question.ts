import { Effect, Schema } from "effect";
import type { PublicationDecision } from "../mint/contracts.js";
import {
  type InputOption,
  type InputRequest,
  isProtectedQuestion,
  optionsRepeatedBy,
  publicOptionLabel,
  type Question,
  type ValidAnswers,
} from "../runtime/input-request.js";

export const QuestionDecision = Schema.Struct({
  outcome: Schema.Literal("allow_business", "authentication", "reword"),
  rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
});
export type QuestionDecision = typeof QuestionDecision.Type;

/** One offered option as the caller sees it: the full label, and the masked one the API shows. */
interface ReviewedOption {
  readonly label: string;
  readonly accountSpecific?: true;
  readonly maskedLabel?: string;
}

/**
 * What Guardian sees of one proposed question: every string the caller will see, screened like
 * the rest (prompt, option labels including account-specific ones and their masked labels, and a
 * confirm dialog's follow-up). Never an answer, a credential value, a provider field id, or a
 * host-held login's username or site.
 */
interface ReviewedQuestion {
  readonly id: string;
  readonly type: Question["type"];
  readonly prompt: string;
  readonly options?: readonly ReviewedOption[];
  readonly followUp?: { readonly prompt: string; readonly defaultText?: string };
  readonly secretKind?: "one_time_code" | "totp" | "private_text";
  readonly fields?: "username_password" | "password";
}

/** One proposed input request, reviewed as a whole. Its questions are shown together. */
export interface PendingQuestion {
  readonly questions: readonly ReviewedQuestion[];
  readonly notice?: string;
  /** Host fact only. No credential values or authentication result are exposed. */
  readonly credentialsAvailable: boolean;
  /** Host fact: the request asks the owner to turn this read build into a write build. */
  readonly writeUpgrade?: true;
  /**
   * Host fact: not a question but the agent's report that the task is impossible as asked, which
   * the caller reads as the build's outcome (`report_blocked`); its one prompt is the report.
   */
  readonly blockedOutcome?: true;
  /**
   * Host evidence: the build's latest publication refusals, as the host recorded them, so a
   * report or question about one is judged against the refusal itself.
   */
  readonly publicationDecisions?: readonly PublicationDecision[];
}

const reviewedOption = <E>(
  option: InputOption,
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<ReviewedOption, E> =>
  Effect.gen(function* () {
    const label = yield* screen(option.label);
    if (option.accountSpecific !== true) return { label };
    const masked = option.maskedLabel === undefined ? undefined : yield* screen(option.maskedLabel);
    return {
      label,
      accountSpecific: true,
      ...(masked === undefined ? {} : { maskedLabel: masked }),
    };
  });

/**
 * Projects a request for review, screening every caller-visible string through `screen`, so
 * Guardian reviews exactly what the caller will see. Only a host-raised login's username and site
 * stay out; the agent never writes them.
 */
export const questionForReview = <E>(
  request: Pick<InputRequest, "notice" | "questions">,
  facts: {
    readonly credentialsAvailable: boolean;
    readonly writeUpgrade?: true;
    readonly blockedOutcome?: true;
    readonly publicationDecisions?: readonly PublicationDecision[];
  },
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<PendingQuestion, E> =>
  Effect.gen(function* () {
    const questions = yield* Effect.forEach(request.questions, (question) =>
      Effect.gen(function* () {
        const prompt = yield* screen(question.prompt);
        const base = { id: question.id, type: question.type, prompt };
        switch (question.type) {
          case "choice":
          case "multi_choice":
            return {
              ...base,
              options: yield* Effect.forEach(question.options, (option) =>
                reviewedOption(option, screen),
              ),
            };
          case "confirm": {
            const followUp = question.followUp;
            if (followUp === undefined) return base;
            const followUpPrompt = yield* screen(followUp.prompt);
            const defaultText =
              followUp.defaultText === undefined ? undefined : yield* screen(followUp.defaultText);
            return {
              ...base,
              followUp: {
                prompt: followUpPrompt,
                ...(defaultText === undefined ? {} : { defaultText }),
              },
            };
          }
          case "secret":
            return { ...base, secretKind: question.secretKind };
          case "credential":
            return { ...base, fields: question.fields };
          case "text":
            return base;
        }
      }),
    );
    const notice = request.notice === undefined ? undefined : yield* screen(request.notice);
    return {
      questions,
      ...(notice === undefined ? {} : { notice }),
      credentialsAvailable: facts.credentialsAvailable,
      ...(facts.writeUpgrade === true ? { writeUpgrade: true as const } : {}),
      ...(facts.blockedOutcome === true ? { blockedOutcome: true as const } : {}),
      // Finite host metadata, written by the harness: nothing to screen.
      ...(facts.publicationDecisions === undefined || facts.publicationDecisions.length === 0
        ? {}
        : { publicationDecisions: facts.publicationDecisions }),
    };
  });

/**
 * One question the owner answered through the host's question flow, as every later Guardian
 * review sees it: the screened prompt and the screened answer. A choice is its option's label (an
 * account-specific option's masked label, as the API shows it) or the owner's own text, a multiple
 * choice its labels with `other`, an option of the owner's own, and either may carry `note`, the
 * owner's clarification of their pick. A confirm is whether the owner confirmed. `typed` marks an
 * answer whose own text the owner wrote: a text answer, a choice's own text or a multiple choice's
 * `other` that repeats no offered option, or a confirm's text other than the offered default. An
 * option label is the minting model's wording even when the owner picks it or types it back, so it
 * never names where the owner's work lives (`ownerNamedOrigins`). A note is the owner's own words;
 * one that only repeats an offered option is left out, as the agent's wording.
 */
export const AnsweredQuestion = Schema.Struct({
  question: Schema.String,
  answer: Schema.Union(
    Schema.String,
    Schema.Array(Schema.String),
    Schema.Struct({
      confirmed: Schema.Boolean,
      text: Schema.optionalWith(Schema.String, { exact: true }),
    }),
  ),
  other: Schema.optionalWith(Schema.String, { exact: true }),
  note: Schema.optionalWith(Schema.String, { exact: true }),
  typed: Schema.optionalWith(Schema.Literal(true), { exact: true }),
});
export type AnsweredQuestion = typeof AnsweredQuestion.Type;

/**
 * Whether the owner wrote the answer's text, rather than picking an option the agent wrote.
 * `validateAnswer` already takes own text that repeats one option as that pick; text that repeats
 * several (options sharing a label) stays the owner's text but is still the agent's wording.
 */
const ownerTyped = (question: Question, given: ValidAnswers[string]) => {
  const own =
    given.type === "choice" && typeof given.value !== "string" && "other" in given.value
      ? given.value.other
      : given.type === "multi_choice" && "options" in given.value
        ? given.value.other
        : undefined;
  return (
    given.type === "text" ||
    (own !== undefined &&
      ((question.type !== "choice" && question.type !== "multi_choice") ||
        optionsRepeatedBy(question.options, own).length === 0)) ||
    (given.type === "confirm" &&
      given.value.text !== undefined &&
      (question.type !== "confirm" || given.value.text !== question.followUp?.defaultText))
  );
};

/**
 * The answers to one request as Guardian sees them, screening every string through `screen`.
 * Protected answers (`isProtectedQuestion`: secrets and logins) never appear, not even their
 * prompts. Nor does a notice's confirm, which says only that the owner acted on the notice.
 */
export const answersForReview = <E>(
  request: Pick<InputRequest, "notice" | "questions">,
  answers: ValidAnswers,
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<readonly AnsweredQuestion[], E> =>
  Effect.forEach(
    request.questions.filter(
      (question) =>
        !isProtectedQuestion(question) &&
        !(request.notice !== undefined && question.type === "confirm"),
    ),
    (question) =>
      Effect.gen(function* () {
        const given = answers[question.id];
        if (given === undefined) return [];
        const label = (id: string) => {
          const option =
            question.type === "choice" || question.type === "multi_choice"
              ? question.options.find((offered) => offered.id === id)
              : undefined;
          return screen(option === undefined ? id : publicOptionLabel(option));
        };
        // The owner's own option beside a multiple choice's picks, and their note beside a pick.
        const beside =
          given.type === "multi_choice" && "options" in given.value
            ? given.value
            : given.type === "choice" && typeof given.value !== "string" && "note" in given.value
              ? { note: given.value.note }
              : {};
        const other = "other" in beside ? beside.other : undefined;
        // A note that only repeats an offered option is the agent's wording, never the owner's.
        const note =
          "note" in beside &&
          beside.note !== undefined &&
          (question.type === "choice" || question.type === "multi_choice") &&
          optionsRepeatedBy(question.options, beside.note).length === 0
            ? beside.note
            : undefined;
        const answer: AnsweredQuestion["answer"] | undefined =
          given.type === "text"
            ? yield* screen(given.value)
            : given.type === "choice"
              ? yield* typeof given.value === "string"
                  ? label(given.value)
                  : "other" in given.value
                    ? screen(given.value.other)
                    : label(given.value.option)
              : given.type === "multi_choice"
                ? yield* Effect.forEach(
                    "options" in given.value ? given.value.options : given.value,
                    label,
                  )
                : given.type === "confirm"
                  ? {
                      confirmed: given.value.confirmed,
                      ...(given.value.text === undefined
                        ? {}
                        : { text: yield* screen(given.value.text) }),
                    }
                  : undefined;
        return answer === undefined
          ? []
          : [
              {
                question: yield* screen(question.prompt),
                answer,
                ...(other === undefined ? {} : { other: yield* screen(other) }),
                ...(note === undefined ? {} : { note: yield* screen(note) }),
                ...(ownerTyped(question, given) ? { typed: true as const } : {}),
              },
            ];
      }),
  ).pipe(Effect.map((entries) => entries.flat()));
