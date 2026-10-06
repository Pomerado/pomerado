import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  InputRequest,
  inputWindowMs,
  maximumInputWaitMs,
  noticeRequest,
  validateAnswer,
} from "../../src/runtime/input-request.js";

const request = Schema.decodeUnknownSync(InputRequest)({
  id: "3f0c2a4e-7c1e-4a55-9d3b-1f2e3d4c5b6a",
  source: "agent",
  questions: [
    {
      id: "plan",
      type: "choice",
      prompt: "Which plan?",
      options: [
        { id: "basic", label: "Basic" },
        { id: "gold", label: "Gold" },
      ],
    },
    {
      id: "extras",
      type: "multi_choice",
      prompt: "Which extras?",
      options: [
        { id: "bag", label: "Bag" },
        { id: "seat", label: "Seat" },
        { id: "meal", label: "Meal" },
      ],
      minSelections: 1,
      maxSelections: 2,
    },
    { id: "note", type: "text", prompt: "Anything else?", maxLength: 5 },
  ],
});

const reason = (answers: unknown, of = request) => {
  const result = validateAnswer(of, answers);
  return Either.isLeft(result) ? [result.left.reason, result.left.questionId] : "valid";
};

describe("validateAnswer", () => {
  it("accepts one answer per question and types each by its question", () => {
    const result = validateAnswer(request, { plan: "gold", extras: ["bag", "meal"], note: "hi" });
    expect(Either.getOrThrow(result)).toEqual({
      plan: { type: "choice", value: "gold" },
      extras: { type: "multi_choice", value: ["bag", "meal"] },
      note: { type: "text", value: "hi" },
    });
  });

  it("refuses missing, extra, unoffered and out-of-bounds answers", () => {
    expect(reason({ plan: "gold", extras: ["bag"] })).toEqual(["missing_answer", "note"]);
    expect(reason({ plan: "gold", extras: ["bag"], note: "x", more: "y" })).toEqual([
      "unexpected_answer",
      "more",
    ]);
    expect(reason({ plan: "platinum", extras: ["bag"], note: "x" })).toEqual([
      "unoffered_option",
      "plan",
    ]);
    expect(reason({ plan: "gold", extras: [], note: "x" })).toEqual(["selection_bounds", "extras"]);
    expect(reason({ plan: "gold", extras: ["bag", "seat", "meal"], note: "x" })).toEqual([
      "selection_bounds",
      "extras",
    ]);
    expect(reason({ plan: "gold", extras: ["bag", "bag"], note: "x" })).toEqual([
      "malformed",
      "extras",
    ]);
    expect(reason({ plan: "gold", extras: ["bag"], note: "toolong" })).toEqual([
      "too_long",
      "note",
    ]);
    expect(reason({ plan: { other: "custom" }, extras: ["bag"], note: "x" })).toEqual([
      "other_not_allowed",
      "plan",
    ]);
    expect(reason("not an object")).toEqual(["malformed", undefined]);
  });

  it("takes the caller's own option and note only where the question allows them", () => {
    const ownWords = Schema.decodeUnknownSync(InputRequest)({
      ...request,
      questions: request.questions.map((question) =>
        question.type === "text" ? question : { ...question, allowOther: true, allowNote: true },
      ),
    });
    const valid = (answers: Readonly<Record<string, unknown>>) =>
      Either.getOrThrow(validateAnswer(ownWords, { note: "x", ...answers }));
    expect(
      valid({
        plan: { option: "gold", note: "Billed yearly" },
        extras: { options: [], other: "A blanket" },
      }),
    ).toMatchObject({
      plan: { type: "choice", value: { option: "gold", note: "Billed yearly" } },
      extras: { type: "multi_choice", value: { options: [], other: "A blanket" } },
    });
    // Without own words, an answer keeps its plain shape.
    expect(valid({ plan: { option: "gold" }, extras: { options: ["bag"] } })).toMatchObject({
      plan: { type: "choice", value: "gold" },
      extras: { type: "multi_choice", value: ["bag"] },
    });
    expect(
      reason(
        { plan: "gold", extras: { options: ["bag", "seat"], other: "A blanket" }, note: "x" },
        ownWords,
      ),
    ).toBe("valid");
    expect(
      reason(
        { plan: "gold", extras: { options: ["bag", "seat", "meal"], other: "A" }, note: "x" },
        ownWords,
      ),
    ).toEqual(["selection_bounds", "extras"]);
    expect(
      reason({ plan: { other: "Silver", note: "Monthly" }, extras: ["bag"], note: "x" }, ownWords),
    ).toEqual(["malformed", "plan"]);
    expect(
      reason({ plan: { option: "silver", note: "Monthly" }, extras: ["bag"], note: "x" }, ownWords),
    ).toEqual(["unoffered_option", "plan"]);
    expect(
      reason({ plan: { option: "gold", note: "Yearly" }, extras: ["bag"], note: "x" }),
    ).toEqual(["note_not_allowed", "plan"]);
    expect(
      reason({ plan: "gold", extras: { options: ["bag"], note: "Large" }, note: "x" }),
    ).toEqual(["note_not_allowed", "extras"]);
    expect(
      reason({ plan: "gold", extras: { options: [], other: "A blanket" }, note: "x" }),
    ).toEqual(["other_not_allowed", "extras"]);
  });

  // Own text that repeats an offered option is that option, picked.
  it.each([
    ["the label, padded and in another case", "  cONTINUE at https://x.invalid/a\n", "go"],
    ["only an option's hidden id", "go", { other: "go" }],
    ["a masked label", "Card ending 42", "card"],
    ["the MCP form's listed entry", " GO (continue at https://x.invalid/a) ", "go"],
    ["the MCP form's listed entry with a masked label", "card (Card ending 42)", "card"],
    ["one option's id with another's label", "go (Stop)", { other: "go (Stop)" }],
    ["a label two options share", "Same", { other: "Same" }],
    ["none", "Continue at https://y.invalid", { other: "Continue at https://y.invalid" }],
  ])("takes a choice's own text that repeats %s as a pick only of one option", (_, text, value) => {
    const choice = Schema.decodeUnknownSync(InputRequest)({
      id: "3f0c2a4e-7c1e-4a55-9d3b-1f2e3d4c5b6a",
      source: "agent",
      questions: [
        {
          id: "next",
          type: "choice",
          prompt: "Next?",
          allowOther: true,
          options: [
            { id: "go", label: "Continue at https://x.invalid/a" },
            { id: "stop", label: "Stop" },
            {
              id: "card",
              label: "Visa 4242",
              accountSpecific: true,
              maskedLabel: "Card ending 42",
            },
            { id: "same_a", label: "Same" },
            { id: "same_b", label: "Same" },
          ],
        },
      ],
    });
    expect(Either.getOrThrow(validateAnswer(choice, { next: { other: text } }))).toEqual({
      next: { type: "choice", value },
    });
  });

  // Option ids are hidden on the Dashboard, so own text equal to one is the
  // owner's own answer, never a different option.
  it("keeps a choice's own text that equals only an option's id as the owner's text", () => {
    const carrier = Schema.decodeUnknownSync(InputRequest)({
      id: "6b1d0e2f-3a4c-4d5e-8f60-718293a4b5c6",
      source: "script",
      questions: [
        {
          id: "carrier",
          type: "choice",
          prompt: "Which carrier?",
          allowOther: true,
          options: [
            { id: "o1", label: "Vodafone" },
            { id: "o2", label: "EE" },
            { id: "o3", label: "Three" },
          ],
        },
      ],
    });
    expect(Either.getOrThrow(validateAnswer(carrier, { carrier: { other: "O2" } }))).toEqual({
      carrier: { type: "choice", value: { other: "O2" } },
    });
  });

  it("takes a notice's yes or no, and a prompt dialog's text only when confirmed", () => {
    const notice = noticeRequest(
      "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "kernel_auth",
      "Approve it on your phone.",
    );
    expect(reason({ done: { confirmed: false } }, notice)).toBe("valid");
    const dialog = Schema.decodeUnknownSync(InputRequest)({
      id: notice.id,
      source: "system",
      questions: [
        { id: "dialog", type: "confirm", prompt: "Name?", followUp: { prompt: "Your name" } },
      ],
    });
    expect(reason({ dialog: { confirmed: true, text: "Ada" } }, dialog)).toBe("valid");
    expect(reason({ dialog: { confirmed: false, text: "Ada" } }, dialog)).toEqual([
      "unexpected_answer",
      "dialog",
    ]);
  });

  it("keeps logins host-only and checks their fields", () => {
    const credential = {
      id: "login",
      type: "credential",
      prompt: "Sign in",
      fields: "password",
      reason: "credentials_expired",
      allowSave: false,
      siteOrigin: "https://example.test",
    };
    expect(
      Schema.decodeUnknownEither(InputRequest)({
        id: request.id,
        source: "agent",
        questions: [credential],
      })._tag,
    ).toBe("Left");
    const system = Schema.decodeUnknownSync(InputRequest)({
      id: request.id,
      source: "system",
      questions: [credential],
    });
    expect(reason({ login: { password: "pw", saveLogin: false } }, system)).toBe("valid");
    expect(reason({ login: { username: "u", password: "pw", saveLogin: false } }, system)).toEqual([
      "username_not_allowed",
      "login",
    ]);
    expect(reason({ login: { password: "pw", saveLogin: true } }, system)).toEqual([
      "unexpected_answer",
      "login",
    ]);
    expect(reason({ login: { saveLogin: false } }, system)).toEqual(["password_required", "login"]);
  });

  it("lets a new login omit its password, but saves only with a code-save offer", () => {
    const login = Schema.decodeUnknownSync(InputRequest)({
      id: request.id,
      source: "system",
      questions: [
        {
          id: "login",
          type: "credential",
          prompt: "Sign in",
          fields: "username_password",
          reason: "missing_credentials",
          allowSave: true,
          siteOrigin: "https://example.test",
        },
      ],
    });
    expect(reason({ login: { username: "u", saveLogin: false } }, login)).toBe("valid");
    expect(reason({ login: { username: "u", saveLogin: true } }, login)).toEqual([
      "password_required",
      "login",
    ]);
    const codeSave = Schema.decodeUnknownSync(InputRequest)({
      ...login,
      questions: [{ ...login.questions[0], allowCodeSave: true }],
    });
    expect(reason({ login: { username: "u", saveLogin: true } }, codeSave)).toBe("valid");
    const repair: InputRequest = {
      ...login,
      questions: login.questions.map((question) =>
        question.type === "credential" ? { ...question, allowSave: false } : question,
      ),
    };
    expect(reason({ login: { username: "u", saveLogin: false } }, repair)).toEqual([
      "password_required",
      "login",
    ]);
  });
});

describe("inputWindowMs", () => {
  it("is the smallest of the policy bound, the source's end and the job window", () => {
    expect(inputWindowMs({ now: 0 })).toBe(maximumInputWaitMs);
    expect(inputWindowMs({ now: 1_000, sourceEndsAt: 61_000 })).toBe(60_000);
    expect(inputWindowMs({ now: 0, jobWindowEndsAt: 30_000, endMarginMs: 10_000 })).toBe(20_000);
    expect(inputWindowMs({ now: 50_000, jobWindowEndsAt: 40_000 })).toBeLessThan(0);
  });
});
