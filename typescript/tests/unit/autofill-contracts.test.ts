import { Either, Schema } from "effect";
import { expect, it } from "vitest";
import { RejectedMarker, SecretSlots } from "../../src/destinations/autofill-contracts.js";
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
