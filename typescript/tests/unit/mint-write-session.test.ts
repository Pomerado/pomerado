import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import {
  checkWriteSession,
  commitEvidenceOf,
  commitUncertain,
  sessionEnteredMarks,
  sessionSentWrite,
  uncertainCommit,
  verifyFirstNotice,
  type WriteSessionMarks,
} from "../../src/mint/write-session.js";

describe("an act step's commit evidence", () => {
  it("reads the runner's own marks", () => {
    expect(commitEvidenceOf([])).toBe("undeclared");
    expect(commitEvidenceOf([{ name: "place-order", state: "not_sent" }])).toBe("not_entered");
    expect(
      commitEvidenceOf([
        { name: "save-address", state: "confirmed" },
        { name: "place-order", state: "not_sent" },
      ]),
    ).toBe("entered");
    expect(commitEvidenceOf([{ name: "place-order", state: "sent" }])).toBe("entered");
  });

  it("is uncertain unless nothing was sent and the marks prove no commit", () => {
    expect(commitUncertain(undefined, "not_entered")).toBe(true);
    expect(commitUncertain(2, "not_entered")).toBe(true);
    expect(commitUncertain(0, "entered")).toBe(true);
    expect(commitUncertain(0, "unreported")).toBe(true);
    expect(commitUncertain(0, "not_entered")).toBe(false);
    expect(commitUncertain(0, "undeclared")).toBe(false);
    expect(commitUncertain(0)).toBe(false);
  });

  it("names why a failed step may have committed", () => {
    expect(uncertainCommit(undefined, "entered")).toBe(
      "the page sent requests the host could not count",
    );
    expect(uncertainCommit(3, "unreported")).toBe(
      "the page sent 3 request(s) or opened socket(s) that could change the site",
    );
    expect(uncertainCommit(0, "entered")).toBe(
      "its script entered a declared commit step, which may have sent the write as a request the host does not count (a GET link, for example)",
    );
    expect(uncertainCommit(0, "unreported")).toBe(
      "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered",
    );
    expect(verifyFirstNotice(0, "entered")).toBe(
      `This act step did not complete after ${uncertainCommit(0, "entered")}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. If it did, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`,
    );
  });
});

describe("a write session's marks", () => {
  it("counts a lost step's streamed marks only once a later step confirmed", () => {
    const lost: WriteSessionMarks = { enteredMarks: [], streamedMarks: ["place-order"] };
    const reported: WriteSessionMarks = { enteredMarks: ["save-address"] };
    expect([...sessionEnteredMarks([reported, lost])]).toEqual(["save-address"]);
    expect([
      ...sessionEnteredMarks([reported, lost, { enteredMarks: [], confirmation: "readback" }]),
    ]).toEqual(["save-address", "place-order"]);
    // A confirmation before the lost step proves nothing about it.
    expect([
      ...sessionEnteredMarks([{ enteredMarks: [], confirmation: "readback" }, lost]),
    ]).toEqual([]);
  });

  it("sent its write on a confirmation, a non-read request or an entered mark", () => {
    const none: WriteSessionMarks = { enteredMarks: [], streamedMarks: ["place-order"] };
    expect(sessionSentWrite({ steps: [], nonReadRequests: 0 })).toBe(false);
    expect(sessionSentWrite({ steps: [none], nonReadRequests: 0 })).toBe(false);
    expect(sessionSentWrite({ steps: [none], nonReadRequests: 1 })).toBe(true);
    expect(
      sessionSentWrite({ steps: [{ enteredMarks: ["place-order"] }], nonReadRequests: 0 }),
    ).toBe(true);
    expect(
      sessionSentWrite({
        steps: [{ enteredMarks: [], confirmation: "message" }],
        nonReadRequests: 0,
      }),
    ).toBe(true);
  });

  it("sent its write when a host that counts no requests marked a step possibly sent", () => {
    expect(
      sessionSentWrite({ steps: [{ enteredMarks: [], possiblySent: true }], nonReadRequests: 0 }),
    ).toBe(true);
    expect(
      sessionSentWrite({ steps: [{ enteredMarks: [], possiblySent: false }], nonReadRequests: 0 }),
    ).toBe(false);
  });
});

describe("a write session's publication check", () => {
  const contract = (write?: {
    readonly confirmation: "message" | "readback" | "unverifiable";
    readonly commits?: readonly unknown[];
  }) => ({ contract: write === undefined ? {} : { write }, inputDecodes: true });
  const check = (
    steps: readonly WriteSessionMarks[],
    extracted: ReturnType<typeof contract>,
    named: WriteSessionMarks = steps.at(-1) ?? { enteredMarks: [] },
  ) => {
    let extractions = 0;
    const result = Effect.runSyncExit(
      checkWriteSession({
        session: { steps, nonReadRequests: 0 },
        step: named,
        extract: Effect.sync(() => {
          extractions++;
          return extracted;
        }),
      }),
    );
    return { result, extractions };
  };
  const reason = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof MintFailure
      ? exit.cause.error.reason
      : undefined;
  const confirmed: WriteSessionMarks = { enteredMarks: ["place-order"], confirmation: "readback" };

  it("refuses a session that never sent its write before reading the contract", () => {
    const { result, extractions } = check(
      [{ enteredMarks: [] }],
      contract({ confirmation: "readback", commits: ["place-order"] }),
    );
    expect(reason(result)).toBe("write_not_submitted");
    expect(extractions).toBe(0);
  });

  it("refuses the contract, not the sent check, for a step that may have sent its write", () => {
    const { result, extractions } = check(
      [{ enteredMarks: [], possiblySent: true }],
      contract({ confirmation: "readback", commits: ["place-order"] }),
    );
    expect(reason(result)).toBe("commit_marks_unentered");
    expect(extractions).toBe(1);
  });

  it("then refuses a contract that does not match the session", () => {
    expect(reason(check([confirmed], contract()).result)).toBe("confirmation_undeclared");
    expect(reason(check([confirmed], contract({ confirmation: "readback" })).result)).toBe(
      "commit_marks_undeclared",
    );
    expect(
      reason(check([confirmed], contract({ confirmation: "readback", commits: ["pay"] })).result),
    ).toBe("commit_marks_unentered");
    expect(
      reason(
        check([confirmed], contract({ confirmation: "unverifiable", commits: ["place-order"] }))
          .result,
      ),
    ).toBe("confirmation_unrecorded");
    expect(
      reason(
        check([confirmed], {
          ...contract({ confirmation: "readback", commits: ["place-order"] }),
          inputDecodes: false,
        }).result,
      ),
    ).toBe("contract_input_mismatch");
  });

  it("returns the declared confirmation and the extracted contract", () => {
    const extracted = contract({ confirmation: "readback", commits: ["place-order"] });
    const { result, extractions } = check([confirmed], extracted);
    expect(result).toEqual(Exit.succeed({ extracted, declared: "readback" }));
    expect(extractions).toBe(1);
  });

  it("publishes an unverifiable write whose step entered its mark and confirmed nothing", () => {
    const { result } = check(
      [{ enteredMarks: ["place-order"] }],
      contract({ confirmation: "unverifiable", commits: ["place-order"] }),
    );
    expect(Exit.isSuccess(result) && result.value.declared).toBe("unverifiable");
  });
});
