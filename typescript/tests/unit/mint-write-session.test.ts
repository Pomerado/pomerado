import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionRequest, MintFailure, type WritePath } from "../../src/mint/contracts.js";
import { contractJsonSchema } from "../../src/runtime/operation.js";
import {
  checkWriteSession,
  commitEvidenceOf,
  commitUncertain,
  readBackFirst,
  sessionEnteredMarks,
  sessionSentWrite,
  uncertainCommit,
  verifyFirstNotice,
  writePathRefusal,
  writePathRemaining,
  type WriteSessionMarks,
} from "../../src/mint/write-session.js";

// A free-form JSON value, which Effect writes as a definition that refers to itself.
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
const JsonData: Schema.Schema<Json> = Schema.suspend(
  (): Schema.Schema<Json> =>
    Schema.Union(
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Null,
      Schema.Array(JsonData),
      Schema.Record({ key: Schema.String, value: JsonData }),
    ),
).annotations({ identifier: "JsonData" });

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

describe("the read-back an act step Guardian labelled a write asks for when it did not complete", () => {
  /** The notice for a step that may have committed for `reason`. */
  const notice = (reason: string) =>
    `This act step did not complete after ${reason}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. When this step's stateChangingRequests shows its commit request to the site returned 2xx or 3xx, that step may read back the write's own result, the record it just created or changed: on the page as it stands, or looked up on another page such as a list. Check it shows no error or validation message, read what the output needs, and call verified() there. Reading is allowed; a second write is not. A 200 whose body reports an error, as GraphQL can, did not go through. Read the site's own proof for such a commit, as for an error status, since part of it may have applied. A 202, or a 2xx whose body says the work is queued, counts too: return the site's own status word for it, such as Queued, in the output. If the write happened, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`;

  it("asks for none when the step's marks show no commit step entered", () => {
    expect(readBackFirst("not_entered")).toBeUndefined();
  });

  it("names why the step may have committed, then how to read back", () => {
    expect(readBackFirst("entered")).toEqual({
      verifyFirst: true,
      notice: notice("its script entered a declared commit step"),
    });
    expect(readBackFirst("unreported")).toEqual({
      verifyFirst: true,
      notice: notice(
        "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered",
      ),
    });
    // A script that declares no commit step, or reports no marks, may still have committed.
    for (const commit of ["undeclared", undefined] as const)
      expect(readBackFirst(commit)).toEqual({
        verifyFirst: true,
        notice: notice("Guardian labelled it a write"),
      });
  });

  it("lets a commit request the site answered 2xx or 3xx read back the write's own result on any page", () => {
    expect(readBackFirst("entered")?.notice).toContain(
      "When this step's stateChangingRequests shows its commit request to the site returned 2xx or 3xx, that step may read back the write's own result, the record it just created or changed: on the page as it stands, or looked up on another page such as a list.",
    );
    expect(readBackFirst("entered")?.notice).toContain("Reading is allowed; a second write is not.");
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
    readonly commitsUnproven?: readonly unknown[];
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

  describe("with save steps the session stopped before, declared unproven", () => {
    // The session saved the product, the one save the caller's facts allowed, and confirmed it.
    const saved: WriteSessionMarks = { enteredMarks: ["save_product"], confirmation: "readback" };
    const unproven = (
      commitsUnproven: readonly unknown[],
      commits = ["save_product", "save_insured"],
    ) => contract({ confirmation: "readback", commits, commitsUnproven });

    it("publishes later marks the session never entered, and reports them", () => {
      const extracted = unproven(["save_insured"]);
      expect(check([saved], extracted).result).toEqual(
        Exit.succeed({ extracted, declared: "readback", commitsUnproven: ["save_insured"] }),
      );
      // Every mark after the last entered one may be unproven, in the order commits declares.
      const longer = unproven(
        ["rate_quote", "save_insured"],
        ["save_product", "save_insured", "rate_quote"],
      );
      expect(check([saved], longer).result).toEqual(
        Exit.succeed({
          extracted: longer,
          declared: "readback",
          commitsUnproven: ["save_insured", "rate_quote"],
        }),
      );
    });
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

  describe("with the composed script's output schema", () => {
    const placing = contract({ confirmation: "readback", commits: ["place-order"] });
    const refused = (reason: string) =>
      Schema.Struct({
        status: Schema.Literal("refused"),
        reason: Schema.Literal(reason),
        site_message: Schema.String,
      });
    const refusals = Schema.Union(refused("not_eligible"), refused("sold_out"));
    const placed = <Status extends Schema.Schema.AnyNoContext>(status: Status) =>
      Schema.Struct({ status, orderNumber: Schema.String });
    // A free-text status beside the refusals could be `refused` too, so none of them is declared.
    const unreadable = contractJsonSchema(Schema.Union(placed(Schema.String), refusals));
    const readable = contractJsonSchema(Schema.Union(placed(Schema.Literal("placed")), refusals));
    const publish = (outputSchema: unknown, registeredOutputSchema?: unknown) =>
      Effect.runSyncExit(
        checkWriteSession({
          session: { steps: [confirmed] },
          step: confirmed,
          extract: Effect.succeed({ ...placing, outputSchema }),
          ...(registeredOutputSchema === undefined ? {} : { registeredOutputSchema }),
        }),
      );

    it("refuses an output schema whose listed refusals the host cannot read", () => {
      expect(reason(publish(unreadable))).toBe("refusal_unreadable");
    });

    it("publishes refusals the host reads, and a script with no refused status", () => {
      expect(Exit.isSuccess(publish(readable))).toBe(true);
      expect(Exit.isSuccess(publish(contractJsonSchema(placed(Schema.String))))).toBe(true);
      // A host that passes no output schema skips the check.
      expect(Exit.isSuccess(check([confirmed], placing).result)).toBe(true);
    });

    it("reads the refusals beside a recursive type in another property", () => {
      const detailed = (status: Schema.Schema.AnyNoContext) =>
        contractJsonSchema(
          Schema.Union(Schema.Struct({ ...placed(status).fields, details: JsonData }), refusals),
        );
      expect(Exit.isSuccess(publish(detailed(Schema.Literal("placed"))))).toBe(true);
      expect(reason(publish(detailed(Schema.String)))).toBe("refusal_unreadable");
    });

    it("never refuses a republish for the unreadable refusal its published revision has", () => {
      expect(Exit.isSuccess(publish(unreadable, unreadable))).toBe(true);
      expect(reason(publish(unreadable, readable))).toBe("refusal_unreadable");
    });

    it("checks it only after the contract, as the contract's refusal comes first", () => {
      const exit = Effect.runSyncExit(
        checkWriteSession({
          session: { steps: [confirmed] },
          step: confirmed,
          extract: Effect.succeed({ ...contract(), outputSchema: unreadable }),
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

  describe("when the example ended in the site's own declared no, for a host that publishes on it", () => {
    // A quote form that saves the property, then prices it. For this example the site said no
    // before the first save, as a product it does not offer at the property's postal code.
    const declined = Schema.Struct({
      status: Schema.Literal("refused"),
      reason: Schema.Literal("not_offered"),
      site_message: Schema.String,
    });
    const quoted = Schema.Struct({ status: Schema.Literal("quoted"), price: Schema.String });
    const outputSchema = contractJsonSchema(Schema.Union(quoted, declined));
    const refusedFirst: WriteSessionMarks = {
      enteredMarks: [],
      action: "write",
      possiblySent: false,
      refused: { reason: "not_offered" },
    };
    const path: WritePath = {
      steps: [
        { commit: "save_property", does: "Saves the property on a new quote" },
        { commit: "get_price", does: "Prices the saved quote" },
      ],
      ends: "The saved quote's price",
    };
    const allUnproven = {
      ...contract({
        confirmation: "message",
        commits: ["save_property", "get_price"],
        commitsUnproven: ["save_property", "get_price"],
      }),
      outputSchema,
    };

    it("publishes the whole path, every save step unproven, with the refusal as the proven outcome", () => {
      const published = Effect.runSyncExit(
        checkWriteSession({
          session: { steps: [refusedFirst] },
          step: refusedFirst,
          extract: Effect.succeed(allUnproven),
          writePath: path,
          publishOnRefusal: true,
        }),
      );
      expect(published).toEqual(
        Exit.succeed({
          extracted: allUnproven,
          declared: "message",
          commitsUnproven: ["save_property", "get_price"],
          refusal: { reason: "not_offered" },
        }),
      );
    });

    it("publishes on the refusal when the output holds a recursive type in another branch", () => {
      const detailed = Schema.Struct({ ...quoted.fields, details: JsonData });
      const published = Effect.runSyncExit(
        checkWriteSession({
          session: { steps: [refusedFirst] },
          step: refusedFirst,
          extract: Effect.succeed({
            ...allUnproven,
            outputSchema: contractJsonSchema(Schema.Union(detailed, declined)),
          }),
          writePath: path,
          publishOnRefusal: true,
        }),
      );
      expect(Exit.isSuccess(published) && published.value.refusal).toEqual({
        reason: "not_offered",
      });
    });
  });
});

describe("a write build's write path", () => {
  const path = (...marks: readonly string[]): WritePath => ({
    steps: marks.map((commit) => ({ commit, does: `Sends ${commit}` })),
    ends: "The quote the site returns",
  });
  const quote = path("save-draft", "save-coverage", "get-quote");
  const act = (writePath?: WritePath) => ({
    purpose: "act" as const,
    target: "liveBrowser" as const,
    ...(writePath === undefined ? {} : { writePath }),
  });
  const session = (started: boolean, recorded?: WritePath, entered: readonly string[] = []) => ({
    started,
    path: recorded,
    enteredMarks: new Set(entered),
  });

  it("names the marks no step entered yet, in path order", () => {
    expect(writePathRemaining(quote, new Set(["save-draft"]))).toEqual([
      "save-coverage",
      "get-quote",
    ]);
    expect(writePathRemaining(quote, new Set(["get-quote", "save-coverage", "save-draft"]))).toEqual(
      [],
    );
    expect(writePathRemaining(undefined, new Set())).toEqual([]);
  });

  it("is required on the session's first act step, and only there", () => {
    expect(writePathRefusal(act(), session(false))).toContain(
      "A write build's first act step declares writePath before anything is sent",
    );
    expect(writePathRefusal(act(quote), session(false))).toBeUndefined();
    expect(writePathRefusal(act(), session(true, quote))).toBeUndefined();
    // A session a host started before it kept paths runs on without one.
    expect(writePathRefusal(act(), session(true))).toBeUndefined();
    expect(writePathRefusal({ ...act(), purpose: "explore" }, session(false))).toBeUndefined();
  });

  it("may be revised to add steps, never to drop or reorder a mark the session entered", () => {
    const entered = session(true, quote, ["save-draft", "save-coverage"]);
    expect(
      writePathRefusal(act(path("save-draft", "save-coverage", "save-property", "get-quote")), entered),
    ).toBeUndefined();
    // A step the site skips for this input may leave the path before the session enters it.
    expect(writePathRefusal(act(path("save-draft", "save-coverage")), entered)).toBeUndefined();
    expect(writePathRefusal(act(path("save-draft", "get-quote")), entered)).toContain(
      "keeps every mark of the recorded path the session already entered, in the same order: save-coverage.",
    );
    expect(
      writePathRefusal(act(path("save-coverage", "save-draft", "get-quote")), entered),
    ).toContain("in the same order: save-coverage.");
  });

  // A setup step claims state the site makes by itself as the session starts, so it can only lead
  // the path: a step after a real write, or the step that reaches the outcome, is never one.
  it("takes setup steps only before the path's first other step, never as its last", () => {
    const marked = (...steps: readonly (readonly [string, boolean])[]): WritePath => ({
      steps: steps.map(([commit, setup]) => ({
        commit,
        does: `Sends ${commit}`,
        ...(setup ? { setup: true as const } : {}),
      })),
      ends: "The placed order",
    });
    const leading = marked(["open-cart", true], ["add-items", false], ["place-order", false]);
    expect(writePathRefusal(act(leading), session(false))).toBeUndefined();
    expect(writePathRefusal(act(leading), session(true, quote))).toBeUndefined();
    for (const [writePath, marks] of [
      [marked(["add-items", false], ["pay", true], ["place-order", false]), "pay"],
      [marked(["open-cart", true], ["place-order", true]), "place-order"],
      [marked(["place-order", true]), "place-order"],
    ] as const) {
      const refusal = writePathRefusal(act(writePath), session(false));
      expect(refusal).toContain(`setup: ${marks}.`);
      expect(refusal).toContain("Nothing was executed.");
      // A revision is held to the same rule.
      expect(writePathRefusal(act(writePath), session(true, quote))).toBe(refusal);
    }
  });

  it("names each mark once, and decodes on the execute request", () => {
    const decode = Schema.decodeUnknownEither(ExecutionRequest);
    const request = {
      purpose: "act",
      target: "liveBrowser",
      entrypoint: "src/draft.mjs",
      fixtureRefs: [],
      caseFilter: [],
      maxWorkers: 1,
      timeoutSeconds: 30,
    };
    expect(decode({ ...request, writePath: quote })._tag).toBe("Right");
    expect(decode({ ...request, writePath: path("save-draft", "save-draft") })._tag).toBe("Left");
    expect(decode({ ...request, writePath: path("save draft") })._tag).toBe("Left");
    expect(decode({ ...request, writePath: { steps: [], ends: "The quote" } })._tag).toBe("Right");
  });

  describe("at publication", () => {
    const contract = (write: {
      readonly confirmation: "message" | "readback";
      readonly commits: readonly unknown[];
    }) => ({ contract: { write }, inputDecodes: true });
    const reason = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof MintFailure
        ? exit.cause.error.reason
        : undefined;
    const confirmed: WriteSessionMarks = { enteredMarks: ["place-order"], confirmation: "readback" };
    const quoted = contract({
      confirmation: "message",
      commits: ["save-draft", "save-coverage", "get-quote"],
    });
    const draft: WriteSessionMarks = { enteredMarks: ["save-draft"], confirmation: "message" };
    const rest: WriteSessionMarks = {
      enteredMarks: ["save-coverage", "get-quote"],
      confirmation: "message",
    };
    const run = (
      steps: readonly WriteSessionMarks[],
      extracted: ReturnType<typeof contract>,
      writePath: WritePath | "none" = quote,
    ) => {
      let extractions = 0;
      const result = Effect.runSyncExit(
        checkWriteSession({
          session: { steps },
          step: steps.at(-1) ?? { enteredMarks: [] },
          extract: Effect.sync(() => {
            extractions++;
            return extracted;
          }),
          ...(writePath === "none" ? {} : { writePath }),
        }),
      );
      return { result, extractions };
    };
    const marksOf = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof MintFailure
        ? exit.cause.error.writePathMarks
        : undefined;

    it("refuses a session that has not entered every mark of its path, before reading the contract", () => {
      const { result, extractions } = run([draft], quoted);
      expect(reason(result)).toBe("write_path_unfinished");
      expect(marksOf(result)).toEqual(["save-coverage", "get-quote"]);
      expect(extractions).toBe(0);
    });

    it("refuses a contract that leaves a mark of the path out", () => {
      const { result } = run(
        [draft, rest],
        contract({ confirmation: "message", commits: ["save-draft", "get-quote"] }),
      );
      expect(reason(result)).toBe("write_path_undeclared");
      expect(marksOf(result)).toEqual(["save-coverage"]);
    });

    // A cart or session the site creates once per visit, such as on opening its menu, may already
    // exist when the session starts, so its step never runs; the session's confirmed write stands.
    it("publishes a confirmed session that never entered a setup step of its path", () => {
      const setupPath: WritePath = {
        steps: [
          { commit: "open-cart", does: "starts the site's empty cart", setup: true },
          { commit: "add-items", does: "adds the requested items" },
        ],
        ends: "The cart's priced items",
      };
      const added: WriteSessionMarks = { enteredMarks: ["add-items"], confirmation: "readback" };
      const adding = contract({ confirmation: "readback", commits: ["add-items"] });
      expect(run([added], adding, setupPath).result).toEqual(
        Exit.succeed({ extracted: adding, declared: "readback" }),
      );
      expect(writePathRemaining(setupPath, new Set())).toEqual(["add-items"]);
    });

    // Setup only excuses state the site makes as the session starts, so a path marked setup
    // elsewhere, as a host that skipped the act step check may have recorded, still owes its marks.
    it("still owes a setup mark after the path's first other step, and the path's last mark", () => {
      const step = (commit: string, setup?: true) => ({
        commit,
        does: `Sends ${commit}`,
        ...(setup === undefined ? {} : { setup }),
      });
      const allSetup: WritePath = {
        steps: [step("open-cart", true), step("place-order", true)],
        ends: "The placed order",
      };
      const opened: WriteSessionMarks = { enteredMarks: ["open-cart"], confirmation: "message" };
      const { result } = run(
        [opened],
        contract({ confirmation: "message", commits: ["open-cart"] }),
        allSetup,
      );
      expect(reason(result)).toBe("write_path_unfinished");
      expect(marksOf(result)).toEqual(["place-order"]);
      const lateSetup: WritePath = {
        steps: [step("add-items"), step("pay", true), step("place-order")],
        ends: "The placed order",
      };
      expect(writePathRemaining(lateSetup, new Set(["add-items"]))).toEqual(["pay", "place-order"]);
    });

    // On a host that publishes on a read-back, a request that ends before any save, and one whose
    // change the site already shows, publish as writes on the named step's read-back of that state.
    it("publishes a path with no step, or a step no session step reached, on a read-back", () => {
      const readBack: WriteSessionMarks = { enteredMarks: [], confirmation: "readback" };
      const publish = (
        writePath: WritePath,
        write: Parameters<typeof contract>[0] & { readonly commitsUnproven?: readonly string[] },
        publishOnReadBack?: true,
        steps: readonly WriteSessionMarks[] = [readBack],
      ) => {
        const extracted = { contract: { write }, inputDecodes: true };
        const result = Effect.runSyncExit(
          checkWriteSession({
            session: { steps },
            step: steps.at(-1) ?? readBack,
            extract: Effect.succeed(extracted),
            writePath,
            ...(publishOnReadBack === undefined ? {} : { publishOnReadBack }),
          }),
        );
        return { extracted, result };
      };
      const failure = (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      // A form filled and read back, never submitted.
      const filled: WritePath = { steps: [], ends: "The filled form, unsubmitted" };
      expect(writePathRefusal(act(filled), session(false))).toContain("writePath names no step");
      expect(
        writePathRefusal(act(filled), session(false), { publishOnReadBack: true }),
      ).toBeUndefined();
      const stops = publish(filled, { confirmation: "readback", commits: [] }, true);
      expect(stops.result).toEqual(
        Exit.succeed({ extracted: stops.extracted, declared: "readback", stopsBeforeSave: true }),
      );
      expect(reason(publish(filled, { confirmation: "readback", commits: [] }).result)).toBe(
        "commit_marks_undeclared",
      );
      // A listing the site already shows archived.
      const archive = path("archive-listing");
      const kept = publish(
        archive,
        {
          confirmation: "readback",
          commits: ["archive-listing"],
          commitsUnproven: ["archive-listing"],
        },
        true,
      );
      expect(kept.result).toEqual(
        Exit.succeed({
          extracted: kept.extracted,
          declared: "readback",
          commitsUnproven: ["archive-listing"],
        }),
      );
      expect(
        failure(publish(archive, { confirmation: "readback", commits: ["archive-listing"] }, true).result),
      ).toMatchObject({
        reason: "write_path_unfinished",
        writePathUnreached: ["archive-listing"],
        publishesOnReadBack: true,
      });
      const before = failure(
        publish(archive, {
          confirmation: "readback",
          commits: ["archive-listing"],
          commitsUnproven: ["archive-listing"],
        }).result,
      );
      expect(before).toMatchObject({
        reason: "write_path_unfinished",
        writePathUnreached: ["archive-listing"],
      });
      expect(before).not.toHaveProperty("publishesOnReadBack");
      // Only a read-back stands for the save: a step named for publication that read a message does not.
      const message: WriteSessionMarks = { enteredMarks: [], confirmation: "message" };
      expect(
        reason(publish(filled, { confirmation: "message", commits: [] }, true, [message]).result),
      ).toBe("commit_marks_undeclared");
      expect(
        reason(
          publish(
            archive,
            {
              confirmation: "message",
              commits: ["archive-listing"],
              commitsUnproven: ["archive-listing"],
            },
            true,
            [message],
          ).result,
        ),
      ).toBe("write_path_unfinished");
      // A step the site skipped before an entered one is no escape: the path is revised instead.
      const skipped = failure(
        publish(
          path("page-one", "page-two", "submit"),
          {
            confirmation: "readback",
            commits: ["page-one", "page-two", "submit"],
            commitsUnproven: ["page-two"],
          },
          true,
          [{ enteredMarks: ["page-one"] }, { enteredMarks: ["submit"] }, readBack],
        ).result,
      );
      expect(skipped).toMatchObject({
        reason: "write_path_unfinished",
        writePathUnreached: ["page-two"],
      });
      expect(skipped).not.toHaveProperty("publishesOnReadBack");
      // A path with no step stops before any save only while no step entered a mark, and leaves
      // no other save step unproven.
      expect(
        reason(
          publish(filled, { confirmation: "readback", commits: [] }, true, [
            { enteredMarks: ["submit"] },
            readBack,
          ]).result,
        ),
      ).toBe("commit_marks_undeclared");
      expect(
        reason(
          publish(
            filled,
            { confirmation: "readback", commits: ["submit"], commitsUnproven: ["submit"] },
            true,
          ).result,
        ),
      ).toBe("commit_marks_unentered");
    });

    it("publishes the whole path, and a session with no recorded path as before", () => {
      expect(run([draft, rest], quoted).result).toEqual(
        Exit.succeed({ extracted: quoted, declared: "message" }),
      );
      const placing = contract({ confirmation: "readback", commits: ["place-order"] });
      expect(run([confirmed], placing, "none").result).toEqual(
        Exit.succeed({ extracted: placing, declared: "readback" }),
      );
    });
  });
});
