import { Either, Schema } from "effect";
import { expect, it } from "vitest";
import { RejectedMarker, SecretSlots } from "../../src/destinations/autofill-contracts.js";
import {
  ExecutionRequest,
  PrivateAnswerExecutionRequest,
  PrivateAnswerSignInStep,
  SignInStep,
} from "../../src/mint/contracts.js";

const answerField = { selector: "#answer", slot: "private_answer", questionSelector: "#question" };

it("never records a private answer as a rejection or takes it as a shared secret slot", () => {
  expect(Either.isLeft(Schema.decodeUnknownEither(SecretSlots)("private_answer"))).toBe(true);
  expect(
    Either.isLeft(
      Schema.decodeUnknownEither(RejectedMarker)({
        slot: "private_answer",
        selector: "#security-error",
      }),
    ),
  ).toBe(true);
});

// A host that fills no private answers decodes no field for one.
it("takes a private answer field only in a host that fills private answers", () => {
  const step = { fields: [answerField] };
  expect(Either.isLeft(Schema.decodeUnknownEither(SignInStep)(step))).toBe(true);
  expect(Schema.decodeUnknownSync(PrivateAnswerSignInStep)(step)).toEqual(step);
  const request = {
    purpose: "authenticate",
    target: "liveBrowser",
    entrypoint: "operation/sign-in-step.json",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 60,
    signInStep: step,
  };
  expect(Either.isLeft(Schema.decodeUnknownEither(ExecutionRequest)(request))).toBe(true);
  expect(
    Either.isRight(Schema.decodeUnknownEither(PrivateAnswerExecutionRequest)(request)),
  ).toBe(true);
});

it("takes a question selector only on a private answer", () => {
  expect(
    Either.isLeft(
      Schema.decodeUnknownEither(PrivateAnswerSignInStep)({
        fields: [{ ...answerField, slot: "password" }],
      }),
    ),
  ).toBe(true);
});
