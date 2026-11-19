import { Either, Schema } from "effect";
import { parseSync } from "oxc-parser";
import type { Expression, Node, ObjectExpression, Program } from "oxc-parser";
import { QuestionId } from "../runtime/input-request.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";

/** Not a literal: the value depends on something only running the code would know. */
const notLiteral = Symbol("not literal");

/** The value of a literal expression, or `notLiteral` for anything computed. */
const literal = (node: Expression): unknown => {
  if (node.type === "Literal")
    return typeof node.value === "bigint" || node.value instanceof RegExp ? notLiteral : node.value;
  if (node.type === "TemplateLiteral")
    return node.expressions.length === 0
      ? node.quasis.map((quasi) => quasi.value.cooked).join("")
      : notLiteral;
  if (node.type === "UnaryExpression") {
    if (node.operator !== "-" || node.argument.type !== "Literal") return notLiteral;
    const value = node.argument.value;
    return typeof value === "number" ? -value : notLiteral;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ParenthesizedExpression"
  )
    return literal(node.expression);
  if (node.type === "ArrayExpression") {
    const items: unknown[] = [];
    for (const element of node.elements) {
      if (element === null || element.type === "SpreadElement") return notLiteral;
      const value = literal(element);
      if (value === notLiteral) return notLiteral;
      items.push(value);
    }
    return items;
  }
  if (node.type !== "ObjectExpression") return notLiteral;
  const entries: [string, unknown][] = [];
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.kind !== "init" ||
      property.method
    )
      return notLiteral;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" && typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key === undefined) return notLiteral;
    const value = literal(property.value);
    if (value === notLiteral) return notLiteral;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

const isDefineOperation = (callee: Expression) =>
  (callee.type === "Identifier" && callee.name === "defineOperation") ||
  (callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "defineOperation");

const isNode = (value: object): value is Node => "type" in value && typeof value.type === "string";

/** Every node below `node`, depth first. */
function* nodes(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const item of node) yield* nodes(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (isNode(node)) yield node;
  for (const value of Object.values(node)) if (typeof value === "object") yield* nodes(value);
}

/** A module's top-level `const` bindings to object literals, by name. */
const objectConsts = (program: Program) => {
  const consts = new Map<string, ObjectExpression>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const { id, init } of declaration.declarations)
      if (id.type === "Identifier" && init?.type === "ObjectExpression") consts.set(id.name, init);
  }
  return consts;
};

/**
 * A contract's literal `questions`: an object literal's own, or those of a top-level const it
 * names or spreads, a later key winning. `undefined` when it declares none, `notLiteral` when only
 * running the code would tell. A spread or computed key it can't read keeps only a `questions`
 * key written before it in the same literal. Each name resolves once; a cycle reads as unread.
 */
const contractQuestions = (
  contract: Expression,
  consts: ReadonlyMap<string, ObjectExpression>,
  resolved = new Map<string, unknown>(),
): unknown => {
  if (contract.type === "Identifier") {
    const bound = consts.get(contract.name);
    if (bound === undefined) return notLiteral;
    if (!resolved.has(contract.name)) {
      resolved.set(contract.name, notLiteral);
      resolved.set(contract.name, contractQuestions(bound, consts, resolved));
    }
    return resolved.get(contract.name);
  }
  if (contract.type !== "ObjectExpression") return notLiteral;
  let questions: unknown;
  let keyed = false;
  for (const property of contract.properties) {
    if (property.type === "Property" && !property.computed) {
      if (
        (property.key.type === "Identifier" && property.key.name === "questions") ||
        (property.key.type === "Literal" && property.key.value === "questions")
      )
        [questions, keyed] = [literal(property.value), true];
      continue;
    }
    const spread =
      property.type === "SpreadElement"
        ? contractQuestions(property.argument, consts, resolved)
        : notLiteral;
    if (spread === notLiteral ? !keyed : spread !== undefined) [questions, keyed] = [spread, false];
  }
  return questions;
};

/**
 * Read a draft's literal `defineOperation` questions without running its source. A computed or
 * unparseable declaration has no static value; a draft that declares none reads as `undefined`.
 */
const draftQuestionValue = (path: string, source: string): unknown => {
  const lang = path.endsWith(".ts") ? "ts" : "js";
  let program: Program;
  try {
    const parsed = parseSync(path, source, { lang, sourceType: "module" });
    if (parsed.errors.length > 0) return notLiteral;
    program = parsed.program;
    // error-reporting-allow: parse-predicate a draft that does not parse declares no questions
  } catch {
    return notLiteral;
  }
  const calls = [...nodes(program)].filter(
    (node) => node.type === "CallExpression" && isDefineOperation(node.callee),
  );
  const [call] = calls;
  if (calls.length === 0) return undefined;
  if (calls.length !== 1 || call?.type !== "CallExpression") return notLiteral;
  const contract = call.arguments[0];
  if (contract === undefined || contract.type === "SpreadElement") return notLiteral;
  return contractQuestions(contract, objectConsts(program));
};

/** An unpublished example may ask only these fixed, reviewable questions. */
export const draftQuestionDeclarations = (
  path: string,
  source: string,
): ScriptQuestionDeclarations => {
  const value = draftQuestionValue(path, source);
  if (value === notLiteral) return {};
  return Either.getOrElse(
    Schema.decodeUnknownEither(ScriptQuestionDeclarations, { onExcessProperty: "error" })(value),
    () => ({}),
  );
};

/**
 * Whether only running a draft's code would tell its questions: it does not parse, or it calls
 * `defineOperation` more than once, or with a contract or questions this reader can't resolve.
 */
export const draftQuestionsUnread = (path: string, source: string) =>
  draftQuestionValue(path, source) === notLiteral;

/** Reject a literal contract's invalid ids before an example or write step can run. */
export const draftQuestionDeclarationFailure = (
  path: string,
  source: string,
): string | undefined => {
  const value = draftQuestionValue(path, source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const invalidIds = Object.keys(value).filter((id) =>
    Either.isLeft(Schema.decodeUnknownEither(QuestionId)(id)),
  );
  if (invalidIds.length === 0) {
    const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations, {
      onExcessProperty: "error",
    })(value);
    return Either.isLeft(decoded)
      ? `Invalid script questions: the run would declare none of them. Fix the declaration before executing: ${decoded.left.message}`
      : undefined;
  }
  return `Invalid script question ${invalidIds.length === 1 ? "id" : "ids"}: ${invalidIds
    .map((id) => JSON.stringify(id))
    .join(
      ", ",
    )}. Question ids must start with a lowercase letter and contain only lowercase letters, digits, or underscores, up to 64 characters. Rename them before executing.`;
};
