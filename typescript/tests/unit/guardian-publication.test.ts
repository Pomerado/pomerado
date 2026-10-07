import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { guardianPublicationPolicy } from "../../src/guardian/publication.js";
import {
  makeGuardian,
  ReviewFailure,
  type GuardianDiagnostics,
  type PendingExecution,
  type Reviewer,
} from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const native = { executionEnvironment: nativeExecutionEnvironment };

const files = new Map([
  ["operation/src/tool.mjs", 'export const city = "Paris"; // synthetic é'],
  [
    "publication/definition.json",
    JSON.stringify({
      description: "Read reports",
      inputSchema: { examples: ["Synthetic example"] },
    }),
  ],
  ["publication/example-output.json", JSON.stringify({ output: { reports: [] } })],
]);
const pending: PendingExecution = {
  invocationId: "invocation_a",
  attemptId: "attempt_a",
  entrypoint: "operation/src/tool.mjs",
  screenedIntent: "Read public reports",
  screenedInput: "{}",
  screenedObservations: "Prior example completed; publication does not repeat it.",
  accountScope: "account_a",
  allowedOrigins: [],
  allowedEffects: ["Publish current package only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: true,
      current: true,
      owner: path.startsWith("publication/") ? ("host" as const) : ("minter" as const),
    })),
  },
};
const sourcesOf = (sources: ReadonlyMap<string, string>) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = sources.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
const allow = {
  outcome: "allow",
  reason: "approved",
  rationale: "The reviewed evidence supports this publication decision",
  findings: [],
};
const inspectAll: Reviewer["run"] = (turn) =>
  Effect.gen(function* () {
    for (const file of turn.pending.publication?.files ?? []) {
      let offset = 0;
      while (true) {
        const raw: unknown = JSON.parse(yield* turn.readSource(file.path, offset));
        if (
          raw === null ||
          typeof raw !== "object" ||
          !("nextOffset" in raw) ||
          typeof raw.nextOffset !== "number" ||
          !("hasMore" in raw)
        )
          throw new Error("Invalid chunk");
        if (!raw.hasMore) break;
        offset = raw.nextOffset;
      }
    }
    return allow;
  });

describe("a publication decision", () => {
  it("returns corrective locations for publication/definition.json and records them in the completion diagnostic", async () => {
    const path = "publication/definition.json";
    const findings = [{ path, byteStart: 0, byteEnd: 12, category: "private_literal" }];
    const persisted: { name: string; details: unknown }[] = [];
    const diagnostics: GuardianDiagnostics = {
      emit: (name, details) =>
        Effect.sync(() => {
          persisted.push({ name, details });
        }),
      retainScreenedSource: () => Effect.void,
      retainModelTranscript: () => Effect.void,
    };
    const reviewer: Reviewer = {
      run: (turn) =>
        inspectAll(turn).pipe(
          Effect.as({
            outcome: "deny",
            reason: "privacy",
            findings,
            rationale: "Remove the literal",
          }),
        ),
    };
    const result = await Effect.runPromise(
      makeGuardian(reviewer, diagnostics).review(pending, sourcesOf(files)),
    );
    expect(result.decision).toEqual({
      outcome: "deny",
      reason: "privacy",
      rationale: "Remove the literal",
      findings,
    });
    expect(
      JSON.stringify(persisted.find((event) => event.name === "guardian.completed")),
    ).toContain(JSON.stringify(findings));
  });

  it.each([
    { path: "unknown", byteStart: 0, byteEnd: 1, category: "private_literal" },
    { path: pending.entrypoint, byteStart: 5, byteEnd: 1, category: "private_literal" },
    { path: pending.entrypoint, byteStart: 0, byteEnd: 9000, category: "private_literal" },
    { path: pending.entrypoint, byteStart: 0, byteEnd: 1, category: "PRIVATE_CANARY" },
  ])("rejects invalid finding metadata: %j", async (finding) => {
    const reviewer: Reviewer = {
      run: () =>
        Effect.succeed({
          outcome: "deny",
          reason: "privacy",
          rationale: "The reviewed evidence supports this publication decision",
          findings: [finding],
        }),
    };
    expect(
      await Effect.runPromise(
        Effect.either(makeGuardian(reviewer).review(pending, sourcesOf(files))),
      ),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  // A denial that names every problem keeps its findings and its rationale's first 4,000
  // characters, rather than failing as InvalidDecision and losing them.
  it("keeps a denial whose rationale is too long, cut to 4,000 characters", async () => {
    const rationale = "The source hard-codes a private value. ".repeat(120);
    const finding = {
      path: pending.entrypoint,
      byteStart: 0,
      byteEnd: 1,
      category: "private_literal",
    };
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({ outcome: "deny", reason: "privacy", rationale, findings: [finding] }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toMatchObject({ outcome: "deny", reason: "privacy", findings: [finding] });
    expect(decision.rationale).toBe(`${rationale.slice(0, 3999)}…`);
  });

  // Guardian's shared output format sends null for a field a kind does not use.
  it("reads a null findings list as none and an allow without a reason as approved", async () => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({ outcome: "allow", reason: null, rationale: "Fine.", findings: null }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toEqual({
      outcome: "allow",
      reason: "approved",
      rationale: "Fine.",
      findings: [],
    });
  });

  const definitionFinding = (category: string) => ({
    path: "publication/definition.json",
    byteStart: 0,
    byteEnd: 1,
    category,
  });
  const decide = (decision: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.either(
        makeGuardian({
          run: (turn) =>
            inspectAll(turn).pipe(
              Effect.as({ rationale: "The source needs the indicated correction", ...decision }),
            ),
        }).review(pending, sourcesOf(files)),
      ),
    );

  it("requires an in-index unsupported_claim finding for an unsupported-claim denial", async () => {
    expect(
      await decide({
        outcome: "deny",
        reason: "unsupported_claim",
        findings: [definitionFinding("schema_mismatch")],
      }),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  it("cannot approve with an unsupported-claim reason", async () => {
    expect(
      await decide({ outcome: "allow", reason: "unsupported_claim", findings: [] }),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  it("returns input feedback made only of input findings with its reason", async () => {
    const findings = [
      "account_specific_enum",
      "input_option",
      "example_value",
      "example_input",
    ].map(definitionFinding);
    expect(
      await decide({
        outcome: "escalate",
        reason: "input_feedback",
        rationale: "Expose the account-specific choice as caller input",
        findings,
      }),
    ).toMatchObject({
      _tag: "Right",
      right: {
        decision: {
          outcome: "escalate",
          reason: "input_feedback",
          rationale: "Expose the account-specific choice as caller input",
          findings,
        },
      },
    });
  });

  it.each([
    { outcome: "escalate", reason: "input_feedback", findings: [] },
    {
      outcome: "escalate",
      reason: "input_feedback",
      findings: [definitionFinding("account_specific_enum"), definitionFinding("private_literal")],
    },
    {
      outcome: "escalate",
      reason: "input_feedback",
      findings: [definitionFinding("example_value"), definitionFinding("private_literal")],
    },
    { outcome: "allow", reason: "input_feedback", findings: [definitionFinding("input_option")] },
  ])("rejects input feedback that is empty, blocking or approving: %j", async (decision) => {
    expect(await decide(decision)).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidDecision" },
    });
  });

  it("keeps an input finding beside a blocking reason, which still decides", async () => {
    const findings = [
      definitionFinding("private_literal"),
      definitionFinding("account_specific_enum"),
    ];
    expect(await decide({ outcome: "deny", reason: "privacy", findings })).toMatchObject({
      _tag: "Right",
      right: { decision: { outcome: "deny", reason: "privacy", findings } },
    });
  });

  // A host_owned denial tells the minter it cannot fix the findings, so none may be in its files
  // or in the public definition, which follows from its source and build metadata.
  it.each([
    { path: "publication/example-output.json", decided: "Right" },
    { path: "publication/definition.json", decided: "Left" },
    { path: "operation/src/tool.mjs", decided: "Left" },
  ])("decides a host_owned denial with a finding in $path: $decided", async ({ path, decided }) => {
    const findings = [{ path, byteStart: 0, byteEnd: 1, category: "private_literal" }];
    expect(await decide({ outcome: "deny", reason: "host_owned", findings })).toMatchObject(
      decided === "Right"
        ? { _tag: "Right", right: { decision: { reason: "host_owned", findings } } }
        : { _tag: "Left", left: { code: "InvalidDecision" } },
    );
  });

  it("accepts a confirmation finding as a source correction", async () => {
    const findings = [definitionFinding("confirmation")];
    expect(await decide({ outcome: "deny", reason: "source_correction", findings })).toMatchObject({
      _tag: "Right",
      right: { decision: { reason: "source_correction", findings } },
    });
  });
});

describe("the publication policy", () => {
  it("is the core text, naming the files the host writes", () => {
    const policy = guardianPublicationPolicy;
    expect(policy.split("\n")).toHaveLength(12);
    expect(
      policy.startsWith("This is the existing publication review, not an execution request.\n"),
    ).toBe(true);
    expect(policy).toContain(
      "Every owner: host file is written by the host, which the minter cannot edit: any entry file the host adds to the bundle and every publication/ file (the definition, the example or session output and the session steps). No file must be read in full:",
    );
    expect(policy).toContain(
      "never ask for a source correction or another run for it. When such a file shows a problem the minter's source causes, the finding keeps its ordinary reason and the rationale names the source to change.",
    );
    expect(policy).not.toContain("  ");
  });
});

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const read = (path: string, offset = 0, callId = `read_${path}_${offset}`) => ({
  type: "function_call" as const,
  callId,
  name: "read_source",
  status: "completed" as const,
  arguments: JSON.stringify({ path, offset }),
});
const scripted = (respond: (index: number) => ModelResponse["output"]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return { usage: new Usage(), output: respond(requests.length - 1) };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
/** The review request the host sent: the first user message that is one. */
const reviewRequest = (request: ModelRequest | undefined): Record<string, unknown> => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of items) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as Record<string, unknown>;
  }
  throw new Error("No review request");
};
const policyOf = (request: ModelRequest | undefined) =>
  (reviewRequest(request)["trusted_review"] as { readonly policy: string }).policy;

describe("the OpenAI publication reviewer", () => {
  it("sends the outcome policy, the publication policy, then the host's, and indexes the evidence before the environment", async () => {
    const requests = scripted(() => [message(allow)]);
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
          ...native,
          specialize: () => ({
            policy: "Synthetic host policy.",
            input: { trusted_host_record: { synthetic: true } },
          }),
        }),
      ).review(pending, sourcesOf(files)),
    );
    const policy = policyOf(requests[0]);
    expect(policy.startsWith("Return the structured outcome allow, deny or escalate")).toBe(true);
    expect(
      policy.endsWith(`\n\n${guardianPublicationPolicy}\n\nSynthetic host policy.`),
    ).toBe(true);
    const request = reviewRequest(requests[0]);
    const keys = Object.keys(request);
    expect(
      keys.slice(keys.indexOf("trusted_authority"), keys.indexOf("trusted_authority") + 4),
    ).toEqual([
      "trusted_authority",
      "trusted_host_record",
      "trusted_publication",
      "trusted_execution_environment",
    ]);
    expect(request["trusted_publication"]).toEqual(pending.publication);
  });

  it("gives an execution review no publication policy or index", async () => {
    const requests = scripted((index) =>
      index === 0
        ? [read(pending.entrypoint)]
        : [message({ outcome: "allow", rationale: "Fine." })],
    );
    const { publication: _publication, ...execution } = pending;
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      ).review(execution, sourcesOf(files)),
    );
    expect(policyOf(requests[0])).not.toContain("publication review");
    expect(reviewRequest(requests[0])).not.toHaveProperty("trusted_publication");
  });

  it.each([false, true])(
    "finishes a multi-file publication review or reports its 32-turn limit, repeatUnavailable=%s",
    async (repeatUnavailable) => {
      const source = 'export const value = "PRIVATE_SOURCE_CANARY";';
      const manifest = Array.from({ length: 13 }, (_, index) => ({
        path: `operation/src/file-${index}.mjs`,
        byteLength: Buffer.byteLength(source),
        published: true,
        current: true,
        owner: "minter" as const,
      }));
      const request: PendingExecution = {
        ...pending,
        entrypoint: manifest[0]?.path ?? "missing",
        publication: { files: manifest },
      };
      const requests = scripted((index) => {
        const file = manifest[index];
        return repeatUnavailable || file !== undefined
          ? [
              read(
                repeatUnavailable ? "operation/src/unavailable.mjs" : (file?.path ?? ""),
                0,
                `read_${index}`,
              ),
            ]
          : [message(allow)];
      });
      const events: { name: string; details: unknown }[] = [];
      const diagnostics: GuardianDiagnostics = {
        emit: (name, details) =>
          Effect.sync(() => {
            events.push({ name, details });
          }),
        retainScreenedSource: () => Effect.void,
        retainModelTranscript: () => Effect.void,
      };
      const result = await Effect.runPromise(
        Effect.either(
          makeGuardian(
            makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
            diagnostics,
          ).review(request, sourcesOf(new Map(manifest.map((file) => [file.path, source])))),
        ),
      );
      expect(result).toMatchObject(
        repeatUnavailable
          ? { _tag: "Left", left: { code: "TurnLimitExceeded" } }
          : { _tag: "Right", right: { decision: { outcome: "allow" } } },
      );
      expect(requests).toHaveLength(repeatUnavailable ? 32 : 14);
      expect(events.find((event) => event.name === "guardian.started")).toMatchObject({
        details: { details: { manifestFiles: 13 } },
      });
    },
  );

  it("keeps a host's own turn limit for a publication review", async () => {
    const requests = scripted((index) => [read(pending.entrypoint, 0, `read_${index}`)]);
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            specialize: () => ({ maxTurns: 3 }),
          }),
        ).review(pending, sourcesOf(files)),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    expect(requests).toHaveLength(3);
  });

  it.each([
    { reason: "unsupported_claim", category: "unsupported_claim" },
    { reason: "input_feedback", category: "account_specific_enum" },
    { reason: "input_feedback", category: "example_value" },
  ])(
    "accepts a $reason decision with a $category finding through the reviewer output schema",
    async ({ reason, category }) => {
      const requests = scripted(() => [
        message({
          outcome: "deny",
          reason,
          rationale: "The schema encodes a private account-specific choice",
          findings: [{ path: "publication/definition.json", byteStart: 0, byteEnd: 1, category }],
        }),
      ]);
      const result = await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review(
          pending,
          sourcesOf(files),
        ),
      );
      expect(result.decision).toMatchObject({
        outcome: "deny",
        reason,
        findings: [{ path: "publication/definition.json", category }],
      });
      expect(JSON.stringify(requests[0]?.outputType)).toContain(category);
    },
  );

  it("completes a review whose model reads one chunk past the end of a large file", async () => {
    const source = `export const value = "${"x".repeat(70_000)}";`;
    const path = "operation/src/large.mjs";
    const request: PendingExecution = {
      ...pending,
      entrypoint: path,
      publication: {
        files: [
          {
            path,
            byteLength: Buffer.byteLength(source),
            published: true,
            current: true,
            owner: "minter",
          },
        ],
      },
    };
    const reads = [[0], [65_536, 131_072]];
    const requests = scripted((index) => {
      const offsets = reads[index];
      return offsets === undefined
        ? [message(allow)]
        : offsets.map((offset, at) => read(path, offset, `read_${index}_${at}`));
    });
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review(
          request,
          sourcesOf(new Map([[path, source]])),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(requests).toHaveLength(3);
  });
});
