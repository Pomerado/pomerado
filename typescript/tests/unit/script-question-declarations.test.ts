import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import { ScriptQuestionDeclarations } from "../../src/runtime/script-input.js";

describe("script question declarations", () => {
  const question = { type: "text", prompt: "Which page?", maxLength: 100 };

  it.each(["pageTitle", "paragraphText", "Page_title", "1_page", "page-title"])(
    "rejects an invalid id instead of projecting it away: %s",
    (id) => {
      const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations)({
        page_title: question,
        [id]: question,
      });
      expect(Either.isLeft(decoded)).toBe(true);
    },
  );

  it("preserves every valid id", () => {
    const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations)({
      page_title: question,
      paragraph_text: question,
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded))
      expect(Object.keys(decoded.right)).toEqual(["page_title", "paragraph_text"]);
  });
});
