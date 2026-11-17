import { randomUUID } from "node:crypto";
import { Context, Data, Effect, Either, Option, ParseResult, Schema, SchemaAST } from "effect";
import { isCardSlot } from "../destinations/payment-frames.js";
import type { Deadline } from "./deadline.js";
import {
  ConfirmQuestion,
  InputRequest,
  longestItemName,
  longestPrompt,
  OrderFacts,
  OrderFee,
  OrderItem,
  orderNotice,
  QuestionId,
  questionIdPattern,
  SecretQuestion,
  ShownInputs,
  TextQuestion,
  validateAnswer,
  type InputAnswers,
  type Question,
  type ValidAnswer,
} from "./input-request.js";

/**
 * A script asks its caller through the one input request (source `script`). It declares each
 * question once in its contract, so the publication review reads every prompt, and passes the
 * page's own options at ask time. Option values stay in the sandbox: the host sees opaque ids.
 */

const Prompt = ConfirmQuestion.fields.prompt;
const Selections = Schema.Int.pipe(Schema.between(0, 50));

export const ScriptQuestionDeclaration = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("choice"),
    prompt: Prompt,
    allowOther: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("multi_choice"),
    prompt: Prompt,
    /** At least one when absent. */
    minSelections: Schema.optional(Selections),
    /** Every offered option when absent; never more than the page offers. */
    maxSelections: Schema.optional(Selections),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    prompt: Prompt,
    maxLength: TextQuestion.fields.maxLength,
  }),
  Schema.Struct({
    type: Schema.Literal("confirm"),
    prompt: Prompt,
    followUp: ConfirmQuestion.fields.followUp,
  }),
  Schema.Struct({
    type: Schema.Literal("secret"),
    prompt: Prompt,
    secretKind: SecretQuestion.fields.secretKind,
    maxLength: SecretQuestion.fields.maxLength,
  }),
  /**
   * Hands the live browser to a person, who does the task `prompt` describes, such as reviewing
   * the filled form before it is submitted, and marks it done. `show_inputs` names the operation
   * inputs the host may show beside the browser, never a secret or a file. It is asked alone.
   */
  Schema.Struct({
    type: Schema.Literal("browser_handoff"),
    prompt: Prompt,
    show_inputs: Schema.optional(ShownInputs),
  }),
  /**
   * A required field the site's form adds that no input covers. It has no prompt of its own: each
   * ask passes the field's label from the page, and its options when it is a select, so it is asked
   * as a text question or a choice and never as any other kind.
   */
  Schema.Struct({ type: Schema.Literal("site_field") }),
  // The pre-unification shape, `{ prompt }`, kept for published revisions: a single choice.
  Schema.Struct({ prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)) }),
);
export type ScriptQuestionDeclaration = typeof ScriptQuestionDeclaration.Type;
const QuestionDeclarations = Schema.Record({
  key: QuestionId,
  value: ScriptQuestionDeclaration,
});
export const ScriptQuestionDeclarations = Schema.Unknown.pipe(
  // Check original keys before record construction can discard __proto__ or another invalid id.
  Schema.filter(
    (questions) =>
      typeof questions !== "object" ||
      questions === null ||
      Object.keys(questions).every((id) => questionIdPattern.test(id)),
    {
      message: () =>
        "question ids must start with a lowercase letter and contain only lowercase letters, digits, or underscores (up to 64 characters)",
    },
  ),
  Schema.compose(QuestionDeclarations),
).annotations({
  // Schema generation still describes the declarations rather than the unvalidated input.
  [SchemaAST.SurrogateAnnotationId]: QuestionDeclarations.ast,
});
export type ScriptQuestionDeclarations = Readonly<Record<string, ScriptQuestionDeclaration>>;

/** One option the page offers now. */
export const ScriptOption = Schema.Struct({
  /** What `ask` returns when the caller picks it. It never leaves the sandbox. */
  value: Schema.String.pipe(Schema.minLength(1)),
  /**
   * The option as the site shows it. A long one reaches the caller shortened (`cutTo`), and a
   * site field's prompt adds its full text (`siteFieldPrompt`).
   */
  label: Schema.String.pipe(Schema.minLength(1)),
  /**
   * A detail of the caller's own account, such as a saved card, a passenger or an address. Its
   * full label appears only on the protected page; the API and MCP show it masked.
   */
  accountSpecific: Schema.optional(Schema.Boolean),
  /** How an account-specific option reads outside the protected page, like "Visa •••• 4242". */
  maskedLabel: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))),
  /** Picking it is the caller's no to the write, as a confirm's no is. */
  declines: Schema.optional(Schema.Boolean),
});
export type ScriptOption = typeof ScriptOption.Type;

const NameLine = Schema.String.pipe(Schema.pattern(/\S/u));
/**
 * A purchase confirm's order as the checkout shows it (`OrderFacts`): an item or fee name reaches
 * the caller on one line, and a long one shortened (`cutTo`).
 */
const ScriptOrder = Schema.Struct({
  ...OrderFacts.fields,
  items: Schema.Array(Schema.Struct({ ...OrderItem.fields, name: NameLine })),
  fees: Schema.optional(Schema.Array(Schema.Struct({ ...OrderFee.fields, name: NameLine }))),
});
export type ScriptOrder = typeof ScriptOrder.Encoded;

/**
 * A question asked now: choices carry the page's options; nothing else carries any. A site field
 * carries its label from the page, with options when it is a select. A choice or a confirm may
 * carry the order it confirms, which the host shows unmasked.
 */
interface AskSpec {
  readonly options?: ReadonlyArray<ScriptOption>;
  readonly label?: string;
  readonly order?: ScriptOrder;
}

/** What `ask` returns for a browser hand-off, once the person marked the step done. */
export interface HandoffDone {
  readonly done: true;
}

/** What `ask` returns for one question, by its declaration. */
export type ScriptAnswerOf<Declaration> = Declaration extends { readonly type: "multi_choice" }
  ? readonly string[]
  : Declaration extends { readonly type: "browser_handoff" }
    ? HandoffDone
    : Declaration extends { readonly type: "confirm" }
      ? { readonly confirmed: boolean; readonly text?: string }
      : Declaration extends { readonly type: "text" | "secret" }
        ? string
        : "allowOther" extends keyof Declaration
          ? Declaration extends { readonly allowOther: false }
            ? string
            : string | { readonly other: string }
          : string;
/** Any answer `ask` returns, before its declaration narrows it. */
export type ScriptAnswer =
  | string
  | { readonly other: string }
  | readonly string[]
  | { readonly confirmed: boolean; readonly text?: string }
  | HandoffDone;

/**
 * What each asked question needs at ask time: the page's options for a choice, a site field's
 * label and any options from the page, else nothing. A choice or a confirm may add its order.
 */
export type AskSpecOf<Declaration> = Declaration extends { readonly type: "site_field" }
  ? { readonly label: string; readonly options?: ReadonlyArray<ScriptOption> }
  : Declaration extends { readonly type: "confirm" }
    ? { readonly options?: never; readonly order?: ScriptOrder }
    : Declaration extends { readonly type: "text" | "secret" | "browser_handoff" }
      ? { readonly options?: never }
      : Declaration extends { readonly type: "multi_choice" }
        ? { readonly options: ReadonlyArray<ScriptOption> }
        : { readonly options: ReadonlyArray<ScriptOption>; readonly order?: ScriptOrder };

/**
 * `NoResponse`: the caller did not answer in time, and the run fails as `no_response`.
 * `Undeclared`: an id the contract does not declare. `InvalidOptions`: options missing for a
 * choice, given for another type, duplicated, too many, or selection bounds they cannot meet, or a
 * site field's label missing, empty or given for another type.
 * The others mean the question could not be asked or its answer could not be used.
 *
 * `InvalidOptions` always sets `message`. It names the declared question, or every question asked
 * when the ask as a whole broke a rule, then the option by its number from 1 or the field, such as
 * `order.items[0].price`, and the rule it broke in fixed words, with a length or count when the
 * rule is one. It never holds an option's value or label, or any other value the script gave,
 * and names a field an order does not take only by a plain name.
 */
export class ScriptInputFailure extends Data.TaggedError("ScriptInputFailure")<{
  readonly code: "Unavailable" | "NoResponse" | "Unauthorized" | "Undeclared" | "InvalidOptions";
  readonly message?: string;
}> {}

/**
 * The runner's way to the host: the request out, the caller's raw answers back. The handler calls
 * `opened` once the host shows the request to its caller, before the caller can act on it: a
 * browser hand-off marks a write's commit steps sent then, since the person may submit. A host
 * that refuses the request before showing it never calls it. Calling it again does nothing.
 */
export type ScriptQuestionHandler = (
  request: InputRequest,
  opened: () => void,
) => Effect.Effect<InputAnswers, ScriptInputFailure>;

/** What a caller of `ask` learns while its request waits. */
export interface ScriptAskHooks {
  /** Told once the host shows the request to its caller (`ScriptQuestionHandler`). */
  readonly opened?: () => void;
}

/** The sandbox's own side of one asked question: the option value behind each host id. */
interface Asked {
  readonly question: Question;
  readonly values: ReadonlyMap<string, string>;
}

/** Names the declared questions and why they could not be asked, in fixed words. */
const invalidOptions = (ids: ReadonlyArray<string>, reason: string) =>
  new ScriptInputFailure({
    code: "InvalidOptions",
    message: `Script ${ids.length === 1 ? "question" : "questions"} ${ids.join(", ")} could not be asked because ${reason}.`,
  });

/** What can be wrong with one option, in the fixed words a run's error may carry. */
const optionProblem = {
  emptyValue: "has an empty value",
  emptyLabel: "has an empty label",
  repeatedValue: "repeats another option's value",
  extraField: "has a field options do not take",
} as const;
type OptionProblem = (typeof optionProblem)[keyof typeof optionProblem];

/** Names the declared question, the option by its number from 1 and the fixed words. */
const invalidOption = (id: string, index: number, problem: OptionProblem) =>
  invalidOptions([id], `option ${index + 1} ${problem}`);

/** Where a decode failed, as the keys and positions that lead there, and the rule it broke. */
interface Broken {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly rule: string;
}

/** What a schema takes, in words for a value of another type. */
const expected = (ast: SchemaAST.AST): string => {
  switch (ast._tag) {
    case "StringKeyword":
      return "text";
    case "NumberKeyword":
      return "a number";
    case "BooleanKeyword":
      return "true or false";
    case "TypeLiteral":
      return "an object";
    case "TupleType":
      return "a list";
    case "Literal":
      return typeof ast.literal === "string" ? JSON.stringify(ast.literal) : String(ast.literal);
    case "Union": {
      // An optional field's union takes `undefined` too, which the caller of `ask` never passes.
      const types = ast.types.filter((type) => !SchemaAST.isUndefinedKeyword(type));
      const [only] = types;
      return types.length === 1 && only !== undefined
        ? expected(only)
        : `one of ${types.map(expected).join(", ")}`;
    }
    default:
      return Option.getOrElse(SchemaAST.getDescriptionAnnotation(ast), () => "another type");
  }
};

/**
 * The rule a refinement states, in its schema's words: a length or count with the given one's,
 * else its message or description. These schemas' messages are fixed words.
 */
const ruleOf = (issue: ParseResult.Refinement): string => {
  const { ast, actual } = issue;
  const message = Option.getOrUndefined(SchemaAST.getMessageAnnotation(ast))?.(issue);
  if (typeof message === "string") return `breaks the rule that ${message}`;
  const limits = Option.getOrElse(SchemaAST.getJSONSchemaAnnotation(ast), () => ({}));
  const text = typeof actual === "string";
  if (text || Array.isArray(actual)) {
    const most: unknown = Reflect.get(limits, text ? "maxLength" : "maxItems");
    const least: unknown = Reflect.get(limits, text ? "minLength" : "minItems");
    const size = text ? `is ${actual.length} characters` : `has ${actual.length} entries`;
    if (typeof most === "number") return `${size}; the limit is ${most}`;
    if (typeof least === "number")
      return actual.length === 0 ? "is empty" : `${size}; it needs at least ${least}`;
  }
  const description = SchemaAST.getDescriptionAnnotation(ast);
  return Option.isSome(description) ? `must be ${description.value}` : "does not pass its check";
};

/**
 * A field name a failure may say: a plain identifier, as a field's name is. Any other key goes
 * unnamed.
 */
const plainName = /^[A-Za-z_$][\w$]{0,63}$/u;

/**
 * Where a decode failed first and the rule it broke, in fixed words. It never holds a given value:
 * only the schema's field names, positions, lengths and counts.
 */
const brokenRule = (
  issue: ParseResult.ParseIssue,
  path: ReadonlyArray<PropertyKey> = [],
): Broken => {
  switch (issue._tag) {
    case "Pointer":
      return brokenRule(issue.issue, path.concat(issue.path));
    case "Composite": {
      const issues = Array.isArray(issue.issues) ? issue.issues : [issue.issues];
      const tried = issues.filter(
        (member) => !(member._tag === "Type" && SchemaAST.isUndefinedKeyword(member.ast)),
      );
      // A member that matched the value's type and failed deeper says more than its type does.
      const deeper = tried.find((member) => member._tag !== "Type");
      return deeper === undefined
        ? { path, rule: `must be ${expected(issue.ast)}` }
        : brokenRule(deeper, path);
    }
    case "Refinement":
      return issue.kind === "Predicate"
        ? { path, rule: ruleOf(issue) }
        : brokenRule(issue.issue, path);
    case "Transformation":
      return brokenRule(issue.issue, path);
    case "Type":
      return { path, rule: `must be ${expected(issue.ast)}` };
    case "Missing":
      return { path, rule: "is missing" };
    case "Unexpected": {
      const field = path.at(-1);
      return {
        path: path.slice(0, -1),
        rule:
          typeof field === "string" && plainName.test(field)
            ? `has a field it does not take: ${field}`
            : "has a field it does not take",
      };
    }
    case "Forbidden":
      return { path, rule: "does not pass its check" };
  }
};

/** A path as code writes it, such as `order.items[0].price`. */
const pathText = (path: ReadonlyArray<PropertyKey>) =>
  path
    .map((key, at) =>
      typeof key === "number" ? `[${key}]` : at === 0 ? String(key) : `.${String(key)}`,
    )
    .join("");

const optionFields = new Set(Object.keys(ScriptOption.fields));
/** What the fixed words say is wrong with an option `ScriptOption` refuses, when they cover it. */
const problemOf = (option: unknown): OptionProblem | undefined => {
  if (typeof option !== "object" || option === null || Array.isArray(option)) return undefined;
  if (Object.keys(option).some((key) => !optionFields.has(key))) return optionProblem.extraField;
  if (Reflect.get(option, "value") === "") return optionProblem.emptyValue;
  if (Reflect.get(option, "label") === "") return optionProblem.emptyLabel;
  return undefined;
};
/**
 * The failure for refused options, named after the first refused one: in the fixed words when
 * they cover it, else by its field and the rule that field broke.
 */
const refusedOptions = (id: string, given: unknown, issue: ParseResult.ParseIssue) => {
  const { path, rule } = brokenRule(issue);
  const [index, ...field] = path;
  if (typeof index !== "number") return invalidOptions([id], `options ${rule}`);
  const problem = Array.isArray(given) ? problemOf(given[index]) : undefined;
  if (problem !== undefined) return invalidOption(id, index, problem);
  const option = `option ${index + 1}${field.length === 0 ? "" : `'s ${pathText(field)}`}`;
  return invalidOptions([id], `${option} ${rule}`);
};

/**
 * The failure for a request its schema refuses, named after the question whose part broke a
 * rule, or the question that carries the order, else every question asked.
 */
const refusedRequest = (
  questions: ReadonlyArray<Asked>,
  orderedBy: string | undefined,
  issue: ParseResult.ParseIssue,
) => {
  const { path, rule } = brokenRule(issue);
  const [first, at, ...field] = path;
  const question = first === "questions" && typeof at === "number" ? questions[at] : undefined;
  if (question !== undefined)
    return invalidOptions(
      [question.question.id],
      `${field.length === 0 ? "it" : pathText(field)} ${rule}`,
    );
  // The notice is the order's own text, which the runtime writes from it.
  if ((first === "order" || first === "notice") && orderedBy !== undefined)
    return invalidOptions(
      [orderedBy],
      `${first === "notice" ? "the order's notice" : pathText(path)} ${rule}`,
    );
  return invalidOptions(
    questions.map((asked) => asked.question.id),
    `${path.length === 0 ? "the request" : pathText(path)} ${rule}`,
  );
};

type GivenSpec = AskSpec | ReadonlyArray<ScriptOption>;
/** The pre-unification call passed a choice's options directly. */
const isOptionList = (spec: GivenSpec): spec is ReadonlyArray<ScriptOption> => Array.isArray(spec);

/** The longest label the host takes (`InputOption`), in UTF-16 code units as it counts them. */
export const longestLabel = 256;
/**
 * Text the host can show within `limit`: longer text keeps its start and ends in "…". The cut
 * never splits a surrogate pair, so the start may be one code unit shorter. Options that read
 * the same once cut stay apart, since the host names each by its own id.
 */
const cutTo = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const end = limit - 1;
  const last = text.charCodeAt(end - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
};

/**
 * A site field's prompt: the page's label whole, and after it the full text of each option its
 * label had to cut, by the option's number from 1, all cut only past `longestPrompt`. An
 * account-specific option's text never joins it: that label shows only on the protected page.
 */
const siteFieldPrompt = (label: string, options: ReadonlyArray<ScriptOption> = []) =>
  cutTo(
    [
      label,
      ...options.flatMap((option, index) =>
        option.label.length > longestLabel && option.accountSpecific !== true
          ? [`Option ${index + 1} in full: ${option.label.trim()}`]
          : [],
      ),
    ].join("\n\n"),
    longestPrompt,
  );

/** The page's options with host-opaque ids, and the value behind each id. */
const offeredOptions = (id: string, given: ReadonlyArray<ScriptOption> | undefined) => {
  if (given === undefined) return Either.left(invalidOptions([id], "it has no options"));
  const decoded = Schema.decodeUnknownEither(Schema.Array(ScriptOption), {
    onExcessProperty: "error",
  })(given);
  if (Either.isLeft(decoded)) return Either.left(refusedOptions(id, given, decoded.left.issue));
  const options = decoded.right;
  const seen = new Set<string>();
  const repeated = options.findIndex(({ value }) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
  if (repeated >= 0) return Either.left(invalidOption(id, repeated, optionProblem.repeatedValue));
  return Either.right({
    values: new Map(options.map((option, index) => [`o${index + 1}`, option.value])),
    offered: options.map((option, index) => ({
      id: `o${index + 1}`,
      label: cutTo(option.label, longestLabel),
      ...(option.accountSpecific === undefined ? {} : { accountSpecific: option.accountSpecific }),
      ...(option.maskedLabel === undefined ? {} : { maskedLabel: option.maskedLabel }),
      ...(option.declines === undefined ? {} : { declines: option.declines }),
    })),
  });
};

/** Builds the host's question from a declaration and the options given now. */
const askedQuestion = (
  id: string,
  declaration: ScriptQuestionDeclaration,
  spec: GivenSpec,
): Either.Either<Asked, ScriptInputFailure> => {
  const given = isOptionList(spec) ? spec : spec.options;
  const label = isOptionList(spec) ? undefined : spec.label;
  // Only a site field takes a label from the page; every other prompt is the declared one.
  if (label !== undefined && !("type" in declaration && declaration.type === "site_field"))
    return Either.left(invalidOptions([id], "only a site field takes a label"));
  /** A question that takes no options; giving any is a mistake. */
  const plain = (question: Question) =>
    given === undefined
      ? Either.right({ question, values: new Map<string, string>() })
      : Either.left(invalidOptions([id], `a ${question.type} question takes no options`));
  if (!("type" in declaration))
    return Either.map(offeredOptions(id, given), ({ values, offered }) => ({
      question: { id, type: "choice" as const, prompt: declaration.prompt, options: offered },
      values,
    }));
  switch (declaration.type) {
    case "text":
      return plain({
        id,
        type: "text",
        prompt: declaration.prompt,
        ...(declaration.maxLength === undefined ? {} : { maxLength: declaration.maxLength }),
      });
    case "confirm":
      return plain({
        id,
        type: "confirm",
        prompt: declaration.prompt,
        ...(declaration.followUp === undefined ? {} : { followUp: declaration.followUp }),
      });
    case "secret":
      return plain({
        id,
        type: "secret",
        prompt: declaration.prompt,
        secretKind: declaration.secretKind,
        ...(declaration.maxLength === undefined ? {} : { maxLength: declaration.maxLength }),
      });
    case "browser_handoff":
      return plain({
        id,
        type: "browser_handoff",
        prompt: declaration.prompt,
        show_inputs: declaration.show_inputs ?? [],
      });
    case "multi_choice":
      return Either.flatMap(offeredOptions(id, given), ({ values, offered }) => {
        const minSelections = declaration.minSelections ?? 1;
        const maxSelections = Math.min(declaration.maxSelections ?? offered.length, offered.length);
        return minSelections > maxSelections
          ? Either.left(
              invalidOptions(
                [id],
                offered.length === 0
                  ? "options is empty"
                  : `minSelections is ${minSelections} but at most ${maxSelections} can be selected`,
              ),
            )
          : Either.right({
              question: {
                id,
                type: "multi_choice" as const,
                prompt: declaration.prompt,
                options: offered,
                minSelections,
                maxSelections,
              },
              values,
            });
      });
    case "choice":
      return Either.map(offeredOptions(id, given), ({ values, offered }) => ({
        question: {
          id,
          type: "choice" as const,
          prompt: declaration.prompt,
          options: offered,
          ...(declaration.allowOther === undefined ? {} : { allowOther: declaration.allowOther }),
        },
        values,
      }));
    case "site_field": {
      const pageLabel = typeof label === "string" ? label.trim() : "";
      if (pageLabel === "")
        return Either.left(invalidOptions([id], "its label is missing, empty or not text"));
      if (given === undefined)
        return Either.right({
          question: { id, type: "text" as const, prompt: siteFieldPrompt(pageLabel) },
          values: new Map<string, string>(),
        });
      return Either.map(offeredOptions(id, given), ({ values, offered }) => ({
        question: {
          id,
          type: "choice" as const,
          prompt: siteFieldPrompt(pageLabel, given),
          options: offered,
        },
        values,
      }));
    }
  }
};

/** The script's own value for one validated answer: option ids become the page's values. */
const scriptValue = (asked: Asked, answer: ValidAnswer): ScriptAnswer | undefined => {
  switch (answer.type) {
    // A script's question takes no note, and a multiple choice no own option.
    case "choice": {
      if (typeof answer.value === "string") return asked.values.get(answer.value);
      return "other" in answer.value ? { other: answer.value.other } : undefined;
    }
    case "multi_choice": {
      const selected = answer.value;
      if ("options" in selected) return undefined;
      const chosen = selected.flatMap((id) => {
        const value = asked.values.get(id);
        return value === undefined ? [] : [value];
      });
      return chosen.length === selected.length ? chosen : undefined;
    }
    case "confirm":
      return answer.value.text === undefined
        ? { confirmed: answer.value.confirmed }
        : { confirmed: answer.value.confirmed, text: answer.value.text };
    case "text":
    case "secret":
      return answer.value;
    case "browser_handoff":
      return { done: true };
    case "credential":
      return undefined;
  }
};

type AskInput = string | ReadonlyArray<string> | Readonly<Record<string, GivenSpec>>;
const isIdList = (input: AskInput): input is ReadonlyArray<string> => Array.isArray(input);

/**
 * Asks the caller at any point of a run. The run waits with its browser open, its active budget
 * paused, and continues in place with the answer. `ask("id")` returns that question's answer;
 * `ask(["a", "b"])` and `ask({ seat: { options }, code: {} })` return one per id. A choice's
 * options come from the page at ask time; no other question takes any, except a site field, which
 * takes its label and, for a select, its options: `ask({ extra: { label, options } })`.
 */
export const makeScriptInput = (
  declared: ScriptQuestionDeclarations | undefined,
  handle: ScriptQuestionHandler | undefined,
  deadline?: Deadline,
) => {
  const askAll = (asked: Readonly<Record<string, GivenSpec>>, hooks: ScriptAskHooks = {}) =>
    Effect.gen(function* () {
      const questions: Asked[] = [];
      let order: OrderFacts | undefined;
      let orderedBy: string | undefined;
      for (const [id, spec] of Object.entries(asked)) {
        const declaration = declared && Object.hasOwn(declared, id) ? declared[id] : undefined;
        if (declaration === undefined) return yield* new ScriptInputFailure({ code: "Undeclared" });
        const built = askedQuestion(id, declaration, spec);
        if (Either.isLeft(built)) return yield* built.left;
        questions.push(built.right);
        const given = isOptionList(spec) ? undefined : spec.order;
        if (given === undefined) continue;
        // One order per request, with a choice or a confirm, and only the facts it names.
        const type: string = "type" in declaration ? declaration.type : "choice";
        if (order !== undefined)
          return yield* invalidOptions([id], "only one question in an ask may carry an order");
        if (type !== "choice" && type !== "confirm")
          return yield* invalidOptions(
            [id],
            `a ${type} question takes no order; only a choice or a confirm does`,
          );
        const decoded = Schema.decodeUnknownEither(ScriptOrder, { onExcessProperty: "error" })(
          given,
        );
        if (Either.isLeft(decoded)) {
          const { path, rule } = brokenRule(decoded.left.issue);
          return yield* invalidOptions([id], `${pathText(["order", ...path])} ${rule}`);
        }
        const named = <Line extends { readonly name: string }>(line: Line) => ({
          ...line,
          name: cutTo(line.name.replace(/\s+/gu, " ").trim(), longestItemName),
        });
        const { fees, ...facts } = decoded.right;
        orderedBy = id;
        order = {
          ...facts,
          items: facts.items.map(named),
          // An empty list is left out, so an order of the earlier shape still decodes on a host
          // that predates fees.
          ...(fees === undefined || fees.length === 0 ? {} : { fees: fees.map(named) }),
        };
      }
      const request = yield* Schema.decodeUnknown(InputRequest)(
        {
          id: randomUUID(),
          source: "script",
          questions: questions.map((asked) => asked.question),
          ...(order === undefined ? {} : { order, notice: orderNotice(order) }),
        },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError((error) => refusedRequest(questions, orderedBy, error.issue)));
      if (handle === undefined) return yield* new ScriptInputFailure({ code: "Unavailable" });
      const answers = yield* Effect.acquireUseRelease(
        Effect.sync(() => deadline?.suspend()),
        () => {
          let told = false;
          return handle(request, () => {
            if (told) return;
            told = true;
            hooks.opened?.();
          });
        },
        (resume) => Effect.sync(() => resume?.()),
      );
      // A card answer reaches the script as the run's handle, never the card, so only the host
      // checks the card against its declared length.
      const valid = validateAnswer(
        {
          ...request,
          questions: request.questions.map((question) => {
            if (question.type !== "secret" || !isCardSlot(question.secretKind)) return question;
            const { maxLength: _checkedByHost, ...rest } = question;
            return rest;
          }),
        },
        answers,
      );
      if (Either.isLeft(valid)) return yield* new ScriptInputFailure({ code: "Unavailable" });
      const values: Record<string, ScriptAnswer> = {};
      for (const asked of questions) {
        const answer = valid.right[asked.question.id];
        const value = answer === undefined ? undefined : scriptValue(asked, answer);
        if (value === undefined) return yield* new ScriptInputFailure({ code: "Unavailable" });
        values[asked.question.id] = value;
      }
      return values;
    });
  const ask = (
    input: AskInput,
    hooks: ScriptAskHooks = {},
  ): Effect.Effect<ScriptAnswer | Readonly<Record<string, ScriptAnswer>>, ScriptInputFailure> => {
    if (typeof input === "string")
      return askAll({ [input]: {} }, hooks).pipe(
        Effect.flatMap((values) => {
          const value = values[input];
          return value === undefined
            ? Effect.fail(new ScriptInputFailure({ code: "Unavailable" }))
            : Effect.succeed(value);
        }),
      );
    if (isIdList(input)) return askAll(Object.fromEntries(input.map((id) => [id, {}])), hooks);
    return askAll(input, hooks);
  };
  return { ask };
};

export class ScriptInput extends Context.Tag("pomerado/ScriptInput")<
  ScriptInput,
  ReturnType<typeof makeScriptInput>
>() {}
