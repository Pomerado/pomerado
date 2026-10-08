import type { InputRequest, Question } from "../runtime/input-request.js";
import type {
  ScriptQuestionDeclaration,
  ScriptQuestionDeclarations,
} from "../runtime/script-input.js";

// The host's check that a running script asks only what publication reviewed. The questions come
// from the script input (`makeScriptInput`), so these bounds follow how it builds each one.

type Typed = Extract<ScriptQuestionDeclaration, { readonly type: string }>;
/** Per declared type: whether the asked question keeps the declared bounds on its answer. */
const keepsBounds: Readonly<
  Record<Typed["type"], (question: Question, declaration: Typed) => boolean>
> = {
  choice: (question, declaration) =>
    declaration.type === "choice" &&
    question.type === "choice" &&
    (question.allowOther === true) === (declaration.allowOther === true),
  multi_choice: (question, declaration) =>
    declaration.type === "multi_choice" &&
    question.type === "multi_choice" &&
    question.minSelections === (declaration.minSelections ?? 1) &&
    question.maxSelections ===
      Math.min(declaration.maxSelections ?? question.options.length, question.options.length),
  text: (question, declaration) =>
    declaration.type === "text" &&
    question.type === "text" &&
    question.maxLength === declaration.maxLength,
  confirm: (question, declaration) =>
    declaration.type === "confirm" &&
    question.type === "confirm" &&
    question.followUp?.prompt === declaration.followUp?.prompt &&
    question.followUp?.defaultText === declaration.followUp?.defaultText,
  secret: (question, declaration) =>
    declaration.type === "secret" &&
    question.type === "secret" &&
    question.secretKind === declaration.secretKind &&
    question.maxLength === declaration.maxLength,
};
const typed = (declaration: ScriptQuestionDeclaration): Typed =>
  // The pre-unification `{ prompt }` declaration is a plain choice.
  "type" in declaration ? declaration : { type: "choice", prompt: declaration.prompt };

/**
 * Whether one asked question is exactly one its operation declared: the same id, type and prompt,
 * and the same bounds on what the caller may answer. Only a choice's options come from the page
 * at ask time. The host checks this against the declarations publication reviewed, never against
 * the ones the running script reports, since the sandbox runs the minted code.
 */
const matchesDeclaration = (
  question: Question,
  declaration: ScriptQuestionDeclaration | undefined,
): boolean => {
  if (declaration === undefined || question.prompt !== declaration.prompt) return false;
  const declared = typed(declaration);
  return keepsBounds[declared.type](question, declared);
};

/** Whether a script's request asks only what `declared` allows, and adds no text of its own. */
export const asksAsDeclared = (
  request: InputRequest,
  declared: ScriptQuestionDeclarations,
): boolean =>
  request.source === "script" &&
  request.notice === undefined &&
  request.questions.every((question) =>
    matchesDeclaration(
      question,
      Object.hasOwn(declared, question.id) ? declared[question.id] : undefined,
    ),
  );
