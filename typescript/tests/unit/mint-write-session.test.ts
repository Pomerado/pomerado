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

  it("sent its write on a confirmation or a write Guardian labelled that may have reached the site", () => {
    const write: WriteSessionMarks = { enteredMarks: [], action: "write", possiblySent: true };
    expect(sessionSentWrite({ steps: [] })).toBe(false);
    expect(sessionSentWrite({ steps: [write] })).toBe(true);
    expect(sessionSentWrite({ steps: [{ enteredMarks: [], confirmation: "message" }] })).toBe(true);
    // A write that never reached the site, or a step Guardian labelled a read, sent nothing.
    expect(sessionSentWrite({ steps: [{ ...write, possiblySent: false }] })).toBe(false);
    expect(sessionSentWrite({ steps: [{ ...write, action: "read" }] })).toBe(false);
    // Commit marks are the contract's evidence, never whether the write was sent.
    expect(sessionSentWrite({ steps: [{ enteredMarks: ["place-order"] }] })).toBe(false);
  });

  it("sent its write unless the outcome review found every labelled write did not happen", () => {
    const write: WriteSessionMarks = { enteredMarks: [], action: "write", possiblySent: true };
    expect(sessionSentWrite({ steps: [{ ...write, assessment: "not_done" }] })).toBe(false);
    expect(sessionSentWrite({ steps: [{ ...write, assessment: "unknown" }] })).toBe(true);
    expect(sessionSentWrite({ steps: [{ ...write, assessment: "not_done" }, write] })).toBe(true);
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
        session: { steps },
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
      [{ enteredMarks: [], action: "write", possiblySent: true }],
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

  it("accepts any short identifier as a mark name, and still refuses one with a space", () => {
    for (const name of ["place_order", "placeOrder", "place-order"]) {
      const extracted = contract({ confirmation: "readback", commits: [name] });
      const entered: WriteSessionMarks = { enteredMarks: [name], confirmation: "readback" };
      expect(check([entered], extracted).result).toEqual(
        Exit.succeed({ extracted, declared: "readback" }),
      );
    }
    const spaced: WriteSessionMarks = { enteredMarks: ["place order"], confirmation: "readback" };
    expect(
      reason(check([spaced], contract({ confirmation: "readback", commits: ["place order"] })).result),
    ).toBe("commit_marks_undeclared");
  });

  it("returns the declared confirmation and the extracted contract", () => {
    const extracted = contract({ confirmation: "readback", commits: ["place-order"] });
    const { result, extractions } = check([confirmed], extracted);
    expect(result).toEqual(Exit.succeed({ extracted, declared: "readback" }));
    expect(extractions).toBe(1);
  });

  describe("with the steps its confirm popups were accepted at", () => {
    const placing = contract({ confirmation: "readback", commits: ["place-order"] });
    const withFiles = (files: Readonly<Record<string, string>>) => ({
      ...placing,
      files: new Map(Object.entries(files)),
    });
    const confirmsAt = (extracted: ReturnType<typeof withFiles>, steps: readonly string[]) =>
      Effect.runSyncExit(
        checkWriteSession({
          session: { steps: [confirmed] },
          step: confirmed,
          extract: Effect.succeed(extracted),
          confirms: { steps, entrypoint: "src/tool.mjs" },
        }),
      );

    it("refuses a composed script that never names a step a confirm was accepted at", () => {
      const exit = confirmsAt(withFiles({ "src/tool.mjs": `decideDialog({step:"submit-order"})` }), [
        "place-order",
      ]);
      expect(reason(exit)).toBe("confirm_action_unmatched");
      expect(
        Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : undefined,
      ).toMatchObject({ confirmActionIds: ["place-order"] });
    });

    it("passes when the entrypoint or a module it imports names each step", () => {
      const imported = withFiles({
        "src/tool.mjs": `import { step } from "./steps.mjs";`,
        "src/steps.mjs": `export const step = 'place-order';`,
      });
      expect(Exit.isSuccess(confirmsAt(imported, ["place-order"]))).toBe(true);
      // A file the entrypoint does not import does not count.
      const unimported = withFiles({
        "src/tool.mjs": `decideDialog({step:"submit-order"})`,
        "src/old.mjs": `decideDialog({step:"place-order"})`,
      });
      expect(reason(confirmsAt(unimported, ["place-order"]))).toBe("confirm_action_unmatched");
      expect(Exit.isSuccess(confirmsAt(unimported, []))).toBe(true);
    });

    it("checks them only after the contract, as the contract's refusal comes first", () => {
      const exit = Effect.runSyncExit(
        checkWriteSession({
          session: { steps: [confirmed] },
          step: confirmed,
          extract: Effect.succeed({ ...contract(), files: new Map([["src/tool.mjs", ""]]) }),
          confirms: { steps: ["place-order"], entrypoint: "src/tool.mjs" },
        }),
      );
      expect(reason(exit)).toBe("confirmation_undeclared");
    });
  });

  it("publishes an unverifiable write whose step entered its mark and confirmed nothing", () => {
    const { result } = check(
      [{ enteredMarks: ["place-order"], action: "write", possiblySent: true }],
      contract({ confirmation: "unverifiable", commits: ["place-order"] }),
    );
    expect(Exit.isSuccess(result) && result.value.declared).toBe("unverifiable");
  });
});
