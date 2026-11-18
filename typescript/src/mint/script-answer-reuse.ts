import { Effect, Either, Schema } from "effect";
import type { AnsweredQuestion, QuestionDecision } from "../guardian/question.js";
import {
  InvalidAnswer,
  OrderFacts,
  optionsRepeatedBy,
  orderNotice,
  validateAnswer,
  type InputRequest,
  type ValidAnswers,
} from "../runtime/input-request.js";

/**
 * The question types whose answers a later step may reuse: never a code, a secret, a login or a
 * browser hand-off, which a person does anew each time.
 */
const ReusableType = Schema.Literal("choice", "multi_choice", "text", "confirm");
const reusable = Schema.is(ReusableType);

/**
 * What a later ask must match to reuse an answer: the same id, type, screened prompt, and screened
 * options or a confirm's screened follow-up.
 */
const KeptQuestion = Schema.Struct({
  id: Schema.String,
  type: ReusableType,
  prompt: Schema.String,
  options: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  followUp: Schema.optional(
    Schema.Struct({ prompt: Schema.String, defaultText: Schema.optional(Schema.String) }),
  ),
});
type KeptQuestion = typeof KeptQuestion.Type;

/**
 * One answer the owner gave a script's question in this build, which a later step may reuse:
 * the screened question and the answer as the asker returned it, and the order of a purchase
 * confirm when the host that asked it in this build kept it (`keptScriptAnswers`).
 */
export const KeptScriptAnswer = Schema.Struct({
  question: KeptQuestion,
  answer: Schema.Struct({ type: Schema.String, value: Schema.Unknown }),
  order: Schema.optional(OrderFacts),
});
export type KeptScriptAnswer = typeof KeptScriptAnswer.Type;

const KeptAnswers = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({ type: Schema.String, value: Schema.Unknown }),
});
/**
 * Validates kept answers, each `{ type, value }`, by the same rules as the caller's own answer
 * values.
 */
export const validateKeptAnswers = (
  request: InputRequest,
  kept: unknown,
): Either.Either<ValidAnswers, InvalidAnswer> => {
  const decoded = Schema.decodeUnknownEither(KeptAnswers)(kept);
  return Either.isLeft(decoded)
    ? Either.left(new InvalidAnswer({ reason: "malformed" }))
    : validateAnswer(
        request,
        Object.fromEntries(Object.entries(decoded.right).map(([id, answer]) => [id, answer.value])),
      );
};

/**
 * Each question's match key, its texts screened as the owner saw them, or undefined for a question
 * no later step may reuse: a code, a secret, a login or a browser hand-off.
 */
export const scriptQuestionKeys = <E>(
  asked: InputRequest,
  screen: (text: string) => Effect.Effect<string, E>,
) =>
  Effect.forEach(asked.questions, (question) =>
    Effect.gen(function* () {
      const { type } = question;
      if (!reusable(type)) return undefined;
      const key = { id: question.id, type, prompt: yield* screen(question.prompt) };
      if (question.type === "choice" || question.type === "multi_choice") {
        const options = yield* Effect.forEach(question.options, (option) =>
          screen(option.label).pipe(Effect.map((label) => ({ id: option.id, label }))),
        );
        return { ...key, options } satisfies KeptQuestion;
      }
      if (question.type !== "confirm" || question.followUp === undefined)
        return key satisfies KeptQuestion;
      const { prompt, defaultText } = question.followUp;
      const followUp = {
        prompt: yield* screen(prompt),
        ...(defaultText === undefined ? {} : { defaultText: yield* screen(defaultText) }),
      };
      return { ...key, followUp } satisfies KeptQuestion;
    }),
  );

const sameQuestion = (left: KeptQuestion, right: KeptQuestion) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Whether two requests carry the same order, as its notice shows it, or both none. */
const sameOrder = (left: OrderFacts | undefined, right: OrderFacts | undefined) =>
  (left && orderNotice(left)) === (right && orderNotice(right));

/**
 * The kept answers a script's ask may reuse, as a fresh answer's shape, or undefined to ask the
 * owner. Every question needs a kept answer to the same question, still valid for the question as
 * asked now. Any step may reuse it, the one that got it included, as often as the question comes
 * back and however long ago the owner gave it. A purchase confirm, which carries its order, reuses
 * only an answer kept with the same order, and only when each confirm it asks was answered yes; a
 * kept answer with an order answers no request without one.
 */
export const reusedScriptAnswers = (
  asked: InputRequest,
  keys: readonly (KeptQuestion | undefined)[],
  kept: readonly KeptScriptAnswer[],
): ValidAnswers | undefined => {
  const found: Record<string, KeptScriptAnswer["answer"]> = {};
  for (const key of keys) {
    const entry =
      key === undefined
        ? undefined
        : kept.find(
            (candidate) =>
              sameQuestion(candidate.question, key) && sameOrder(candidate.order, asked.order),
          );
    if (key === undefined || entry === undefined) return undefined;
    found[key.id] = entry.answer;
  }
  const valid = validateKeptAnswers(asked, found);
  if (Either.isLeft(valid)) return undefined;
  const confirms = asked.questions.filter((question) => question.type === "confirm");
  const confirmed = confirms.every((question) => {
    const answer = valid.right[question.id];
    return answer?.type === "confirm" && answer.value.confirmed;
  });
  return asked.order === undefined || (confirms.length > 0 && confirmed) ? valid.right : undefined;
};

/**
 * The kept answers once the order a purchase confirm's yes answered may have been placed: by a
 * step that made a browser call and did not leave every commit step it declares unsent, as its
 * report shows once it ended or its journal shows when it asks. No kept answer with an order
 * answers again.
 */
export const forgetOrderAnswers = (kept: readonly KeptScriptAnswer[]) =>
  kept.filter((entry) => entry.order === undefined);

/**
 * The kept answers without any to these screened prompts. Only the owner's latest answer to a
 * prompt stands, as in Guardian's trusted answers, so an answer the owner gave since to a question
 * with the same prompt, whoever asked it, means the next script ask asks again.
 */
export const forgetScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  prompts: readonly string[],
): readonly KeptScriptAnswer[] => kept.filter((entry) => !prompts.includes(entry.question.prompt));

/**
 * The kept answers once the owner answered a script's question afresh: its reusable answers
 * replace any kept for the same prompt. Only the host that asked a purchase confirm in this build
 * passes its `order`, so a later ask of the same order there may reuse the yes; an answer kept
 * without it, such as another job's, never answers a purchase confirm.
 */
export const keptScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (KeptQuestion | undefined)[],
  answers: ValidAnswers,
  order?: OrderFacts,
): readonly KeptScriptAnswer[] => {
  const latest = keys.flatMap((key): KeptScriptAnswer[] => {
    const answer = key === undefined ? undefined : answers[key.id];
    return key === undefined || answer === undefined
      ? []
      : [{ question: key, answer, ...(order === undefined ? {} : { order }) }];
  });
  return [
    ...forgetScriptAnswers(
      kept,
      latest.map((entry) => entry.question.prompt),
    ),
    ...latest,
  ];
};

/** A confirm the owner answered, as Guardian's trusted answers show it. */
const confirmedAnswer = ({ answer }: AnsweredQuestion) =>
  typeof answer === "object" && "confirmed" in answer ? answer.confirmed : undefined;

/**
 * The answers a script's question takes when Guardian's question review rewords it as a repeat of
 * the owner's earlier answers and names, for each of its questions, the answer they give
 * (`answers`) and which answered questions they are (`answeredBy`); undefined to ask the owner.
 * Every id named is the owner's latest answer to its prompt in `answered`, the answers the review
 * trusted. Each question gets exactly one answer of its own kind, a choice the one option its
 * label names, and no yes rests on a named no. A purchase confirm, which carries its order, takes
 * only a yes, or an option that doesn't decline, resting on a named yes that `orderYes` says may
 * still answer an order, as a kept yes may until a step may have placed it. Never a code, a
 * secret, a login, a hand-off, a text or a multiple choice.
 */
export const repeatedScriptAnswers = (
  asked: InputRequest,
  decision: Pick<QuestionDecision, "outcome" | "label" | "answers" | "answeredBy">,
  answered: readonly AnsweredQuestion[],
  orderYes: (entry: AnsweredQuestion) => boolean,
): ValidAnswers | undefined => {
  const { answers = [], answeredBy = [] } = decision;
  if (
    asked.source !== "script" ||
    decision.outcome !== "reword" ||
    decision.label !== "repeat" ||
    answeredBy.length === 0 ||
    answers.length !== asked.questions.length
  )
    return undefined;
  const named = answeredBy.map((id) => answered.find((entry) => entry.id === id));
  const cited = named.filter((entry) => entry !== undefined);
  if (
    cited.length !== named.length ||
    cited.some((entry) => answered.findLast((later) => later.question === entry.question) !== entry)
  )
    return undefined;
  const saidNo = cited.some((entry) => confirmedAnswer(entry) === false);
  const saidYes = cited.some((entry) => confirmedAnswer(entry) === true && orderYes(entry));
  const given: Record<string, unknown> = {};
  for (const question of asked.questions) {
    const matching = answers.filter((answer) => answer.question === question.id);
    const answer = matching.length === 1 ? matching[0] : undefined;
    if (answer === undefined) return undefined;
    if (question.type === "confirm" && answer.confirmed !== null) {
      const yes = answer.confirmed;
      if ((yes && saidNo) || (asked.order !== undefined && (!yes || !saidYes))) return undefined;
      given[question.id] = { confirmed: yes };
    } else if (question.type === "choice" && answer.option !== null) {
      const options = optionsRepeatedBy(question.options, answer.option);
      const option = options.length === 1 ? options[0] : undefined;
      if (option === undefined) return undefined;
      const proceeds = option.declines !== true;
      if ((proceeds && saidNo) || (asked.order !== undefined && (!proceeds || !saidYes)))
        return undefined;
      given[question.id] = option.id;
    } else return undefined;
  }
  return Either.getOrUndefined(validateAnswer(asked, given));
};
