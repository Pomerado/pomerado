import { describe, expect, it } from "vitest";
import {
  classifyRun,
  commitReportOf,
  commitRetryRefusal,
  confirmedRun,
  possibleCommit,
  runError,
  runOutcomeCodes,
  runOutcomeRetry,
  runnerVerified,
  unconfirmedWrite,
  validatedWriteNeeds,
  writeStatusOf,
  type RunEvidence,
} from "../../src/runtime/run-outcome.js";
import { classifiedOutcomes } from "../../src/runtime/failure-renderer-contract.js";

describe("commit evidence", () => {
  it.each([
    { report: undefined, evidence: "unreported" },
    { report: "not json", evidence: "unreported" },
    { report: { commits: [{ name: "Has Spaces", state: "sent" }] }, evidence: "unreported" },
    { report: { commits: [{ name: "save", state: "maybe" }] }, evidence: "unreported" },
    { report: { commits: [] }, evidence: "undeclared" },
    {
      report: {
        commits: [
          { name: "save", state: "not_sent" },
          { name: "place-order", state: "not_sent" },
        ],
      },
      evidence: "not_entered",
    },
    {
      report: {
        commits: [
          { name: "save", state: "not_sent" },
          { name: "place-order", state: "sent" },
        ],
      },
      evidence: "entered",
    },
    { report: { commits: [{ name: "save", state: "confirmed" }] }, evidence: "entered" },
  ])("reads $evidence from $report", ({ report, evidence }) => {
    expect(commitReportOf(report).evidence).toBe(evidence);
  });

  it("keeps the marks only when the report is readable", () => {
    expect(commitReportOf({ commits: [{ name: "save", state: "sent" }] })).toEqual({
      evidence: "entered",
      marks: [{ name: "save", state: "sent" }],
    });
    expect(commitReportOf({})).toEqual({ evidence: "unreported" });
  });

  it.each([
    { evidence: "not_entered", refusal: undefined },
    { evidence: "entered", refusal: "commit_entered" },
    { evidence: "undeclared", refusal: "commit_undeclared" },
    { evidence: "unreported", refusal: "commit_unreported" },
  ] as const)("refuses a repeat after $evidence with $refusal", ({ evidence, refusal }) => {
    expect(commitRetryRefusal(evidence)).toBe(refusal);
  });
});

describe("write confirmation", () => {
  const write = (writeConfirmation?: "message" | "readback" | "unverifiable") => ({
    effect: "write" as const,
    ...(writeConfirmation === undefined ? {} : { writeConfirmation }),
  });
  it.each([
    { revision: undefined, effect: "verified", confirmation: undefined, verified: true },
    { revision: { effect: "read" }, effect: "verified", confirmation: undefined, verified: true },
    { revision: write(), effect: "verified", confirmation: undefined, verified: true },
    { revision: write("message"), effect: "verified", confirmation: undefined, verified: false },
    { revision: write("message"), effect: "verified", confirmation: "message", verified: true },
    { revision: write("readback"), effect: "verified", confirmation: "readback", verified: true },
    {
      revision: write("message"),
      effect: "may_have_dispatched",
      confirmation: "message",
      verified: false,
    },
    { revision: write(), effect: "not_started", confirmation: undefined, verified: false },
  ] as const)(
    "runner effect $effect with confirmation $confirmation verifies: $verified",
    ({ revision, effect, confirmation, verified }) => {
      expect(runnerVerified(revision, effect, confirmation)).toBe(verified);
    },
  );

  it.each([
    { revision: undefined, effect: "may_have_dispatched", needs: "nothing" },
    { revision: { effect: "read" }, effect: "may_have_dispatched", needs: "nothing" },
    { revision: write("message"), effect: "verified", needs: "nothing" },
    { revision: write("message"), effect: "may_have_dispatched", needs: "confirmation_missing" },
    { revision: write(), effect: "may_have_dispatched", needs: "confirmation_missing" },
    { revision: write("unverifiable"), effect: "may_have_dispatched", needs: "unverifiable" },
  ] as const)("a validated $effect write needs $needs", ({ revision, effect, needs }) => {
    expect(validatedWriteNeeds(revision, effect)).toBe(needs);
  });
});

const evidence = (fields: Partial<RunEvidence>): RunEvidence => ({
  status: "completed",
  effect: "not_started",
  output: "failed",
  tool_effect: "write",
  ...fields,
});

describe("run failures", () => {
  // The details keep their keys and order, since another host answers them as JSON.
  it.each([
    {
      run: evidence({ failure_reason: "no_response", effect: "may_have_dispatched" }),
      json: '{"code":"no_response","details":{"possible_commit":true}}',
    },
    {
      run: evidence({ failure_reason: "no_response", possible_commit: false }),
      json: '{"code":"no_response","details":{"possible_commit":false}}',
    },
    {
      run: evidence({ failure_reason: "credentials_rejected", rejected_field: "password" }),
      json: '{"code":"credentials_rejected","details":{"possible_commit":false,"field":"password"}}',
    },
    {
      run: evidence({
        failure_reason: "invalid_input",
        effect: "rejected",
        refusal_reason: "The date must be in the future.",
      }),
      json: '{"code":"input_rejected","details":{"possible_commit":false,"reason":"The date must be in the future."}}',
    },
    {
      run: evidence({ failure_reason: "invalid_input", effect: "may_have_dispatched" }),
      json: '{"code":"input_rejected","details":{"possible_commit":true}}',
    },
    {
      run: evidence({ failure_reason: "login_identity_conflict" }),
      json: '{"code":"login_identity_conflict","details":{}}',
    },
    {
      run: evidence({ failure_reason: "login_check_unavailable" }),
      json: '{"code":"website_sign_in_unavailable","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost", tool_effect: "read", effect: "unknown" }),
      json: '{"code":"worker_lost","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost" }),
      json: '{"code":"worker_lost","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost", effect: "may_have_dispatched" }),
      json: '{"code":"outcome_unknown","details":{}}',
    },
    {
      run: evidence({ effect: "may_have_dispatched", output: "valid" }),
      json: '{"code":"outcome_unknown","details":{}}',
    },
    {
      run: evidence({ status: "outcome_unknown", effect: "verified", output: "valid" }),
      json: '{"code":"outcome_unknown","details":{}}',
    },
    {
      run: evidence({ effect: "verified", output: "invalid" }),
      json: '{"code":"invalid_output","details":{}}',
    },
    { run: evidence({}), json: '{"code":"execution_failed","details":{}}' },
    {
      run: evidence({ failure_reason: "something_new" }),
      json: '{"code":"execution_failed","details":{}}',
    },
  ])("answers $json", ({ run, json }) => {
    expect(JSON.stringify(runError(run))).toBe(json);
  });

  it.each([
    { run: evidence({ tool_effect: "read" }), status: null },
    { run: evidence({ tool_effect: undefined }), status: null },
    { run: evidence({ status: "outcome_unknown", effect: "verified" }), status: "may_have_applied" },
    { run: evidence({ effect: "may_have_dispatched" }), status: "may_have_applied" },
    { run: evidence({ effect: "unknown" }), status: "may_have_applied" },
    { run: evidence({ effect: "partial" }), status: "may_have_applied" },
    { run: evidence({ effect: "verified" }), status: "applied" },
    { run: evidence({ effect: "rejected" }), status: "not_applied" },
    { run: evidence({ effect: "not_started" }), status: "not_attempted" },
  ])("gives write status $status", ({ run, status }) => {
    expect(writeStatusOf(run)).toBe(status);
  });

  it.each([
    { run: evidence({ possible_commit: true }), possible: true },
    { run: evidence({ effect: "may_have_dispatched" }), possible: true },
    { run: evidence({ status: "outcome_unknown" }), possible: true },
    { run: evidence({ effect: "verified" }), possible: false },
    { run: evidence({ effect: "rejected" }), possible: false },
  ])("possible commit is $possible", ({ run, possible }) => {
    expect(possibleCommit(run)).toBe(possible);
  });

  it.each([
    { run: evidence({ effect: "verified", output: "valid" }), confirmed: true },
    { run: evidence({ effect: "not_started", output: "valid" }), confirmed: true },
    {
      run: evidence({ status: "cleanup_pending", effect: "verified", output: "valid" }),
      confirmed: true,
    },
    {
      run: evidence({ effect: "verified", output: "invalid", output_drift: true }),
      confirmed: true,
    },
    { run: evidence({ effect: "may_have_dispatched", output: "valid" }), confirmed: false },
    { run: evidence({ effect: "verified", output: "invalid" }), confirmed: false },
    { run: evidence({ status: "outcome_unknown", effect: "verified", output: "valid" }), confirmed: false },
  ])("a run is confirmed: $confirmed", ({ run, confirmed }) => {
    expect(confirmedRun(run)).toBe(confirmed);
  });

  it.each([
    { run: evidence({ effect: "may_have_dispatched", output: "valid" }), kept: true },
    { run: evidence({ failure_reason: "worker_lost", output: "valid" }), kept: true },
    { run: evidence({ effect: "may_have_dispatched", output: "failed" }), kept: false },
    {
      run: evidence({ effect: "may_have_dispatched", output: "valid", tool_effect: "read" }),
      kept: false,
    },
    { run: evidence({ effect: "verified", output: "invalid" }), kept: false },
  ])("an unconfirmed write keeps its result: $kept", ({ run, kept }) => {
    expect(unconfirmedWrite(run)).toBe(kept);
  });
});

describe("run outcomes", () => {
  it("leaves a confirmed run unclassified", () => {
    expect(classifyRun(evidence({ effect: "verified", output: "valid" }))).toBeUndefined();
  });

  it("reports a write that returned without its confirmation as possibly applied", () => {
    expect(classifyRun(evidence({ effect: "may_have_dispatched", output: "valid" }))).toEqual({
      code: "outcome_unknown",
      details: {},
      writeStatus: "may_have_applied",
      possibleCommit: true,
      retry: "never",
    });
  });

  it("reports a refused input that sent nothing as not applied and safe to correct", () => {
    expect(
      classifyRun(evidence({ failure_reason: "invalid_input", effect: "rejected" })),
    ).toEqual({
      code: "input_rejected",
      details: { possible_commit: false },
      writeStatus: "not_applied",
      possibleCommit: false,
      retry: "fix_input",
    });
  });

  it("claims a possible commit only for a code whose meaning allows one", () => {
    expect(
      classifyRun(
        evidence({ failure_reason: "worker_lost", tool_effect: "read", possible_commit: true }),
      ),
    ).toMatchObject({ code: "worker_lost", possibleCommit: false });
    expect(
      [
        ...new Set(
          classifiedOutcomes()
            .filter((outcome) => outcome.possibleCommit)
            .map((outcome) => outcome.code),
        ),
      ].sort(),
    ).toEqual(["credentials_rejected", "input_rejected", "no_response", "outcome_unknown"]);
    for (const outcome of classifiedOutcomes())
      if ("possible_commit" in outcome.details)
        expect(outcome.possibleCommit).toBe(outcome.details["possible_commit"]);
  });

  it("gives every code a retry class", () => {
    expect(Object.keys(runOutcomeRetry).sort()).toEqual([...runOutcomeCodes].sort());
  });

  it("produces exactly the listed codes over every evidence combination", () => {
    expect([...new Set(classifiedOutcomes().map((outcome) => outcome.code))].sort()).toEqual(
      [...runOutcomeCodes].sort(),
    );
  });
});

describe("a location the page did not apply", () => {
  const location = { field: "zip", requested: "00001", step: "store_save" };
  const failed = (evidence: Partial<RunEvidence>): RunEvidence => ({
    status: "completed",
    effect: "not_started",
    output: "failed",
    tool_effect: "read",
    failure_reason: "location_not_applied",
    location,
    ...evidence,
  });

  it.each([
    { name: "a read", evidence: {} },
    { name: "a write that sent nothing", evidence: { tool_effect: "write", effect: "rejected" } },
  ] as const)("may run again with the same request for $name", ({ evidence }) => {
    expect(classifyRun(failed(evidence))).toMatchObject({
      code: "location_not_applied",
      retry: "same_key",
      possibleCommit: false,
    });
  });

  it.each([
    {
      name: "a confirmed write",
      evidence: { tool_effect: "write", effect: "verified" },
      code: "execution_failed",
    },
    { name: "a run that judged a step may have committed", evidence: { possible_commit: true } },
    {
      name: "a write that may have dispatched",
      evidence: { tool_effect: "write", effect: "may_have_dispatched" },
      code: "outcome_unknown",
    },
  ] as const)("never offers $name a same-request retry", ({ evidence, ...expected }) => {
    const outcome = classifyRun(failed(evidence));
    expect(outcome?.code).not.toBe("location_not_applied");
    expect(outcome?.retry).not.toBe("same_key");
    if ("code" in expected) expect(outcome?.code).toBe(expected.code);
  });
});
