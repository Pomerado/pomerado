import { Either, Schema } from "effect";
import { expect, it } from "vitest";
import { RejectedMarker, SecretSlots } from "../../src/destinations/autofill-contracts.js";
import { autofillSignedInCode } from "../../src/destinations/autofill-page-code.js";
import { SignInStep } from "../../src/mint/contracts.js";

it("accepts a one-use private answer as a field but never as a recorded rejection", () => {
  expect(Either.isRight(Schema.decodeUnknownEither(SecretSlots)("private_answer"))).toBe(true);
  expect(
    Either.isLeft(
      Schema.decodeUnknownEither(RejectedMarker)({
        slot: "private_answer",
        selector: "#security-error",
      }),
    ),
  ).toBe(true);
});

it("retains a private answer's question selector and rejects it on another secret slot", () => {
  const field = { selector: "#answer", slot: "private_answer", questionSelector: "#question" };
  expect(Schema.decodeUnknownSync(SignInStep)({ fields: [field] })).toEqual({ fields: [field] });
  expect(Either.isLeft(Schema.decodeUnknownEither(SignInStep)({
    fields: [{ ...field, slot: "password" }],
  }))).toBe(true);
});

// A caller written for the signed-in page code before challenge fields keeps its arguments:
// `popups` stays fifth, and with no challenge fields given the code checks no challenge.
it("keeps the signed-in page code's popups fifth, with no challenge check by default", () => {
  const code = autofillSignedInCode("target", "#identity", "bank.example.test", ["#password"], [
    { opener: "primary", origin: "https://login.example.test" },
  ]);
  expect(code).toContain('const popupOrigins = ["https://login.example.test"];');
  expect(code).toContain("const challengeFields = [];");
  expect(code).toContain("const authenticationOrigins = [];");
});
