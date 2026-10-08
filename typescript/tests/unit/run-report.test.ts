import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../../src/execution/local-operation.js";
import type { WriteDeclaration } from "../../src/runtime/operation.js";
import { InputRequestFailure } from "../../src/runtime/input-request.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import {
  beforeOperationFailure,
  returnedRun,
  runOutcomeFailure,
  RunOutcomeFailure,
} from "../../src/standalone/run-report.js";

const readBack = /read the site back before any retry/iu;
const nothingSent: LocalOperationJournal = { effect: "not_sent", commits: [] };
const commitNotEntered: LocalOperationJournal = {
  effect: "possible",
  commits: [{ name: "save", state: "not_sent" }],
};
const commitSent: LocalOperationJournal = {
  effect: "possible",
  commits: [{ name: "save", state: "sent" }],
};
const confirmedWrite: LocalOperationJournal = {
  effect: "verified",
  confirmation: "message",
  commits: [{ name: "save", state: "confirmed" }],
};

const returned = (
  journal: LocalOperationJournal,
  write?: WriteDeclaration,
): LocalOperationOutput => ({
  output: { saved: true },
  schemas: { input: {}, output: {} },
  stdout: "",
  stderr: "",
  ...journal,
  ...(write === undefined ? {} : { write }),
});
const settle = (declared: "read" | "write" | undefined, result: LocalOperationOutput) =>
  Effect.runSync(Effect.either(returnedRun(declared, result)));
const failureOf = (declared: "read" | "write" | undefined, result: LocalOperationOutput) => {
  const settled = settle(declared, result);
  if (Either.isRight(settled)) throw new Error("Expected a failed run");
  return settled.left;
};

describe("a run that returned", () => {
  it("returns a read's output", () => {
    expect(settle("read", returned({ effect: "possible", commits: [] }))).toEqual(
      Either.right({ saved: true }),
    );
  });

  it("returns a confirmed write's output", () => {
    expect(
      settle("write", returned(confirmedWrite, { confirmation: "message", commits: ["save"] })),
    ).toEqual(Either.right({ saved: true }));
  });

  it("returns an undeclared script's output as a read when no effect was given", () => {
    expect(settle(undefined, returned({ effect: "possible", commits: [] }))).toEqual(
      Either.right({ saved: true }),
    );
  });

  it("fails a write that returned without its confirmation, keeping its output", () => {
    const failure = failureOf(
      undefined,
      returned(commitSent, { confirmation: "message", commits: ["save"] }),
    );
    expect(failure).toBeInstanceOf(RunOutcomeFailure);
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
      retry: "never",
    });
    expect(failure.unconfirmed).toEqual({ output: { saved: true } });
    expect(failure.message).toMatch(/without recording its confirmation/u);
    expect(failure.message).toMatch(readBack);
  });

  it("fails a write whose bare verified() is not the confirmation it declared", () => {
    const failure = failureOf(
      "write",
      returned({ effect: "verified", commits: [{ name: "save", state: "sent" }] }, {
        confirmation: "readback",
      }),
    );
    expect(failure.outcome).toMatchObject({ code: "outcome_unknown", writeStatus: "may_have_applied" });
  });

  it("fails an unverifiable write as possibly completed", () => {
    const failure = failureOf("write", returned(commitSent, { confirmation: "unverifiable" }));
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(failure.message).toMatch(/offers no confirmation/u);
    expect(failure.message).toMatch(readBack);
  });
});

describe("a run that failed in its operation", () => {
  const fail = (declared: "read" | "write" | undefined, error: unknown) =>
    runOutcomeFailure(declared, "operation")(error);

  it.each([
    {
      case: "a confirmed write with invalid output",
      error: new LocalOperationFailure("InvalidOutput", confirmedWrite, "InvalidOutput"),
      outcome: { code: "invalid_output", writeStatus: "applied", possibleCommit: false },
    },
    {
      case: "a refused input whose commit was never entered",
      error: new LocalOperationFailure(
        "The date must be in the future.",
        commitNotEntered,
        "InvalidInput",
      ),
      outcome: {
        code: "input_rejected",
        details: { possible_commit: false, reason: "The date must be in the future." },
        writeStatus: "not_applied",
        possibleCommit: false,
        retry: "fix_input",
      },
    },
    {
      case: "a refused input after its commit was sent",
      error: new LocalOperationFailure("InvalidInput", commitSent, "InvalidInput"),
      outcome: {
        code: "input_rejected",
        details: { possible_commit: true },
        writeStatus: "may_have_applied",
        possibleCommit: true,
      },
    },
    {
      case: "a script error before anything was dispatched",
      error: new LocalOperationFailure("Fixture failure", nothingSent),
      outcome: { code: "execution_failed", writeStatus: "not_attempted", possibleCommit: false },
    },
    {
      case: "a script error whose commit was never entered",
      error: new LocalOperationFailure("Fixture failure", commitNotEntered),
      outcome: { code: "execution_failed", writeStatus: "not_attempted", possibleCommit: false },
    },
    {
      case: "an unanswered question before anything was dispatched",
      error: new LocalOperationFailure("NoResponse", nothingSent, "NoResponse"),
      outcome: {
        code: "no_response",
        details: { possible_commit: false },
        writeStatus: "not_attempted",
        retry: "new_key",
      },
    },
    {
      case: "an unanswered question after a commit was sent",
      error: new LocalOperationFailure("NoResponse", commitSent, "NoResponse"),
      outcome: {
        code: "no_response",
        details: { possible_commit: true },
        writeStatus: "may_have_applied",
        possibleCommit: true,
      },
    },
    {
      case: "an expired deadline after a commit was sent",
      error: new LocalOperationFailure(
        "Local operation deadline expired; execution was not replayed",
        commitSent,
      ),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "a failure with no journal",
      error: new Error("Local operation child did not exit after result"),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
  ])("classifies $case", ({ error, outcome }) => {
    const failure = fail("write", error);
    expect(failure.outcome).toMatchObject(outcome);
    if (failure.outcome.possibleCommit) expect(failure.message).toMatch(readBack);
    else expect(failure.message).not.toMatch(readBack);
  });

  it("names the tool's own reason for a refused input", () => {
    expect(
      fail("write", new LocalOperationFailure("The date must be in the future.", commitNotEntered, "InvalidInput"))
        .message,
    ).toBe(
      "The tool or the website refused a value in the input. The date must be in the future. Nothing changed on the website. Correct the input and run it again.",
    );
  });

  it("gives a failed read no possible website change", () => {
    const failure = fail("read", new LocalOperationFailure("Fixture failure", commitSent));
    expect(failure.outcome).toMatchObject({
      code: "execution_failed",
      writeStatus: null,
      possibleCommit: false,
    });
  });

  it("fails closed when the tool's effect is unknown", () => {
    expect(
      fail(undefined, new LocalOperationFailure("Fixture failure", { effect: "possible", commits: [] }))
        .outcome,
    ).toMatchObject({ code: "outcome_unknown", writeStatus: null, possibleCommit: true });
  });

  it("counts declared commit marks as a write when the tool's effect is unknown", () => {
    expect(fail(undefined, new LocalOperationFailure("Fixture failure", commitSent)).outcome)
      .toMatchObject({ code: "outcome_unknown", writeStatus: "may_have_applied" });
  });
});

describe("a run that failed before its operation", () => {
  const fail = beforeOperationFailure("write");

  it("keeps a sign-in failure as the typed failure a caller catches", () => {
    const signIn = new SignInRunFailed({ code: "CredentialsRejected", reason: "password" });
    expect(fail(signIn)).toBe(signIn);
  });

  it.each([
    { error: new InputRequestFailure({ code: "NoResponse" }), code: "no_response" },
    { error: new InputRequestFailure({ code: "Unavailable" }), code: "execution_failed" },
    { error: new Error("Invalid URL"), code: "execution_failed" },
  ])("reports $code with nothing changed", ({ error, code }) => {
    const failure = fail(error);
    if (!(failure instanceof RunOutcomeFailure)) throw new Error("Expected a run outcome");
    expect(failure.outcome).toMatchObject({
      code,
      writeStatus: "not_attempted",
      possibleCommit: false,
    });
    expect(failure.message).toMatch(/Nothing changed on the website/u);
    expect(failure.message).not.toMatch(readBack);
  });

  it("passes an outcome already classified through unchanged", () => {
    const classified = runOutcomeFailure("write", "operation")(
      new LocalOperationFailure("Fixture failure", commitSent),
    );
    expect(fail(classified)).toBe(classified);
  });
});
