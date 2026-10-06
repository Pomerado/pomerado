import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest } from "@openai/agents";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { guardianExecutionPolicy } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution, Reviewer, ReviewTurn } from "../../src/guardian/review.js";
import { UpstreamPolicySlotInvalid } from "../../src/guardian/upstream-policy.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { readScopedFile } from "../../src/filesystem/read.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../../src/models/model-diagnostic-failure.js";
import { EventUnavailable } from "../../src/runtime/errors.js";
import { markedUpstreamPolicy, tenantPolicyCopies } from "../support/tenant-policy.js";

const makeSourceReader = (root: string) =>
  makeSourceInspector(
    (path) =>
      Effect.tryPromise({
        try: () => readScopedFile(root, path),
        catch: () => new ReviewFailure({ code: "SourceUnavailable" }),
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );

const pending: PendingExecution = {
  invocationId: "invocation_a",
  attemptId: "attempt_a",
  entrypoint: "operation.ts",
  screenedIntent: "Read the public page title",
  screenedInput: "{}",
  screenedObservations: "untrusted page observations",
  accountScope: "account_a",
  allowedOrigins: ["https://example.test"],
  allowedEffects: ["read"],
};
const source = 'export const operation = () => "synthetic-source-evidence";';
const sourceEnvelope = JSON.stringify({
  kind: "untrusted_source",
  path: pending.entrypoint,
  byteOffset: 0,
  nextOffset: source.length,
  hasMore: false,
  source,
});

describe("Guardian modeled reviewer contract", () => {
  it("keeps source reads confined while an intermediate directory is swapped for a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-scope-race-"));
    const root = join(directory, "root");
    const nested = join(root, "nested");
    const parked = join(root, "parked");
    const outside = join(directory, "outside");
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    await writeFile(join(nested, "operation.ts"), "inside-source");
    await writeFile(join(outside, "operation.ts"), "outside-synthetic-secret");
    const read = makeSourceReader(root);
    try {
      for (let index = 0; index < 100; index++) {
        const reading = Effect.runPromise(Effect.either(read("nested/operation.ts", 0)));
        await rename(nested, parked);
        await symlink(outside, nested, "dir");
        const observed = await reading;
        if (observed._tag === "Right") {
          expect(observed.right).toContain("inside-source");
          expect(observed.right).not.toContain("outside-synthetic-secret");
        }
        await unlink(nested);
        await rename(parked, nested);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supplies actual source inspection, trusted scope and a fresh review for each execution", async () => {
    const reads: { path: string; offset: number }[] = [];
    const seenReviewIds: string[] = [];
    const reviewer: Reviewer = {
      run: (turn) =>
        Effect.gen(function* () {
          expect(turn.pending).toEqual(pending);
          expect(JSON.stringify(turn.sources?.entrypoint)).toContain("synthetic-source-evidence");
          seenReviewIds.push(turn.reviewId);
          const observed = yield* turn.readSource(turn.pending.entrypoint, 0);
          expect(observed).toContain("synthetic-source-evidence");
          return {
            outcome: "allow",
            rationale: "Modeled reviewer inspected the submitted synthetic source.",
          };
        }),
    };
    const guardian = makeGuardian(reviewer);
    for (let run = 0; run < 2; run += 1) {
      const reviewed = await Effect.runPromise(
        guardian.review(pending, (path, offset) =>
          Effect.sync(() => {
            reads.push({ path, offset });
            return sourceEnvelope;
          }),
        ),
      );
      expect(reviewed.decision.outcome).toBe("allow");
      expect(reviewed.reviewId).toBe(seenReviewIds[run]);
    }
    // Each review includes the entrypoint, and this reviewer also reads it itself.
    expect(reads).toEqual(Array.from({ length: 4 }, () => ({ path: "operation.ts", offset: 0 })));
    expect(new Set(seenReviewIds).size).toBe(2);
  });

  it.each([
    ["a read error", () => () => Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))],
    ["a missing file", (empty: string) => makeSourceReader(empty)],
    [
      "a screening refusal",
      () => {
        const secrets = makeRunSecrets();
        secrets.register("synthetic-source-evidence");
        return makeSourceInspector(
          () => Effect.succeed(new TextEncoder().encode(source)),
          (_path, bytes) =>
            secrets.assertAbsent(new TextDecoder().decode(bytes)).pipe(
              Effect.as(new TextDecoder().decode(bytes)),
              Effect.mapError(() => new ReviewFailure({ code: "SourceUnavailable" })),
            ),
        );
      },
    ],
  ] satisfies [string, (empty: string) => ReviewTurn["readSource"]][])(
    "without the entrypoint in the request after %s, a deny stands and an allow ends EntrypointNotRead",
    async (_failure, reader) => {
      const empty = await mkdtemp(join(tmpdir(), "guardian-missing-entrypoint-"));
      try {
        const decide = (outcome: "allow" | "deny") =>
          makeGuardian({
            run: (turn) =>
              Effect.sync(() => {
                expect(turn.sources?.entrypoint).toBeUndefined();
                return { outcome, rationale: "No source was read." };
              }),
          }).review(pending, reader(empty));
        expect(await Effect.runPromise(Effect.either(decide("allow")))).toMatchObject({
          _tag: "Left",
          left: { code: "EntrypointNotRead" },
        });
        expect((await Effect.runPromise(decide("deny"))).decision.outcome).toBe("deny");
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    },
  );

  it("preserves a required source outage when the reviewer tool swallows it before deny", async () => {
    const guardian = makeGuardian({
      run: (turn) =>
        turn.readSource(turn.pending.entrypoint, 0).pipe(
          Effect.either,
          Effect.as({
            outcome: "deny",
            rationale: "Source unavailable; cannot inspect the submission.",
          }),
        ),
    });
    const result = await Effect.runPromise(
      Effect.either(
        guardian.review(pending, () =>
          Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "SourceUnavailable" } });
  });

  it("preserves allow after required-source recovery and an optional missing-path probe", async () => {
    let requiredReads = 0;
    const guardian = makeGuardian({
      run: (turn) =>
        Effect.gen(function* () {
          expect(yield* Effect.either(turn.readSource(turn.pending.entrypoint, 0))).toMatchObject({
            _tag: "Left",
            left: { code: "SourceUnavailable" },
          });
          yield* turn.readSource(turn.pending.entrypoint, 0);
          expect(yield* Effect.either(turn.readSource("optional-missing.ts", 0))).toMatchObject({
            _tag: "Left",
            left: { code: "SourceUnavailable" },
          });
          return {
            outcome: "allow",
            rationale: "Decision after inspecting the required submitted source.",
          };
        }),
    });
    const reviewed = await Effect.runPromise(
      guardian.review(pending, (path) =>
        Effect.suspend(() => {
          // The host's own inclusion read and the reviewer's first read both fail.
          if (path !== pending.entrypoint || ++requiredReads <= 2)
            return Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }));
          return Effect.succeed(sourceEnvelope);
        }),
      ),
    );
    expect(reviewed.decision.outcome).toBe("allow");
    expect(requiredReads).toBe(3);
  });

  it.each([false, true])(
    "preserves a swallowed source-retention failure until that read is recovered: %s",
    async (recover) => {
      let retentionCalls = 0;
      const guardian = makeGuardian(
        {
          run: (turn) =>
            Effect.gen(function* () {
              yield* turn.readSource(turn.pending.entrypoint, 0);
              yield* Effect.either(turn.readSource("optional-evidence.ts", 0));
              if (recover) yield* turn.readSource("optional-evidence.ts", 0);
              return {
                outcome: "deny",
                rationale: "Modeled reviewer declined after a tool error.",
              };
            }),
        },
        {
          emit: () => Effect.void,
          retainModelTranscript: () => Effect.void,
          retainScreenedSource: () =>
            Effect.suspend(() => {
              retentionCalls++;
              // The third retained read, after the host's inclusion and the entrypoint read.
              return retentionCalls === 3
                ? Effect.fail(
                    new EventUnavailable({
                      event: "diagnostic_storage_failed",
                      diagnosticStorageFailure: "unavailable",
                    }),
                  )
                : Effect.void;
            }),
        },
        undefined,
        {
          diagnosticFailure: (error) =>
            new ReviewFailure({
              code: "Unavailable",
              diagnosticRetentionReason: diagnosticRetentionReason(error),
              diagnosticScreeningReason: diagnosticScreeningReason(error),
              diagnosticStorageFailure: diagnosticStorageFailure(error),
            }),
        },
      );
      const result = await Effect.runPromise(
        Effect.either(guardian.review(pending, () => Effect.succeed(sourceEnvelope))),
      );
      expect(result).toMatchObject(
        recover
          ? { _tag: "Right", right: { decision: { outcome: "deny" } } }
          : {
              _tag: "Left",
              left: {
                code: "Unavailable",
                diagnosticRetentionReason: "storage",
                diagnosticStorageFailure: "unavailable",
              },
            },
      );
    },
  );

  it.each([
    [
      "a mapped",
      {
        diagnosticFailure: (error: unknown) =>
          new ReviewFailure({
            code: "Unavailable",
            diagnosticRetentionReason: diagnosticRetentionReason(error),
            diagnosticStorageFailure: diagnosticStorageFailure(error),
          }),
      },
      { diagnosticRetentionReason: "storage" },
    ],
    ["the default", {}, { failureDetail: { operation: "diagnostics.retainScreenedSource" } }],
    ["a bare", { diagnosticFailure: () => new ReviewFailure({ code: "Unavailable" }) }, {}],
  ] as const)(
    "goes forward with the entrypoint inline after %s retention failure of the host's read",
    async (_mapping, options, gap) => {
      let entrypointSource: unknown;
      const events: [string, unknown][] = [];
      const guardian = makeGuardian(
        {
          run: (turn) =>
            Effect.sync(() => {
              entrypointSource = turn.sources?.entrypoint;
              return { outcome: "allow", rationale: "Modeled reviewer inspected the source." };
            }),
        },
        {
          emit: (name, value) => Effect.sync(() => void events.push([name, value])),
          retainModelTranscript: () => Effect.void,
          retainScreenedSource: () =>
            Effect.fail(
              new EventUnavailable({
                event: "diagnostic_storage_failed",
                diagnosticStorageFailure: "unavailable",
              }),
            ),
        },
        undefined,
        options,
      );
      const result = await Effect.runPromise(
        Effect.either(guardian.review(pending, () => Effect.succeed(sourceEnvelope))),
      );
      expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
      expect(entrypointSource).toEqual(JSON.parse(sourceEnvelope));
      expect(events).toMatchObject([
        ["guardian.started", {}],
        [
          "guardian.source_failed",
          { details: { path: pending.entrypoint, offset: 0, code: "Unavailable", ...gap } },
        ],
        ["guardian.completed", {}],
      ]);
    },
  );

  it("preserves deny/escalate decisions and rejects malformed reviewer output", async () => {
    for (const outcome of ["deny", "escalate"]) {
      const guardian = makeGuardian({
        run: () => Effect.succeed({ outcome, rationale: "Requested effect exceeds authority." }),
      });
      const result = await Effect.runPromise(
        guardian.review(pending, () => Effect.succeed(sourceEnvelope)),
      );
      expect(result.decision.outcome).toBe(outcome);
    }
    for (const raw of [
      undefined,
      { outcome: "approved", rationale: "Wrong enum" },
      { outcome: "allow" },
    ]) {
      const guardian = makeGuardian({ run: () => Effect.succeed(raw) });
      const rejected = await Effect.runPromise(
        Effect.either(guardian.review(pending, () => Effect.succeed(sourceEnvelope))),
      );
      expect(rejected).toMatchObject({
        _tag: "Left",
        left: {
          code: "InvalidDecision",
          failureDetail: { subCause: "guardian_dependency_failed", phase: "decision_validation" },
        },
      });
    }
  });

  // A denial names every problem the source has, so its rationale can outgrow the
  // 4,000-character limit. Failing it as InvalidDecision lost the denial and retried the review;
  // the host keeps the decision and the rationale's first 4,000 characters instead.
  it("keeps a denial whose rationale is too long, cut to 4,000 characters", async () => {
    const problems = Array.from(
      { length: 120 },
      (_, index) => `Problem ${index + 1}: replace page.request with SiteHttp.`,
    ).join(" ");
    expect(problems.length).toBeGreaterThan(4000);
    for (const outcome of ["deny", "escalate"]) {
      const guardian = makeGuardian({
        run: () => Effect.succeed({ outcome, rationale: problems }),
      });
      const { decision } = await Effect.runPromise(
        guardian.review(pending, () => Effect.succeed(sourceEnvelope)),
      );
      expect(decision.outcome).toBe(outcome);
      expect(decision.rationale).toHaveLength(4000);
      expect(decision.rationale).toBe(`${problems.slice(0, 3999)}…`);
    }
  });

  it("propagates required-review failure without producing an allow decision", async () => {
    const guardian = makeGuardian({
      run: () => Effect.fail(new ReviewFailure({ code: "Unavailable" })),
    });
    expect(
      await Effect.runPromise(
        Effect.either(guardian.review(pending, () => Effect.succeed(sourceEnvelope))),
      ),
    ).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  });
});

describe("scoped Guardian source reader", () => {
  let directory = "";
  let root = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pomerado-guardian-source-"));
    root = join(directory, "workspace");
    await mkdir(root);
    await writeFile(
      join(root, "operation.ts"),
      `${source}\nconst password = "synthetic-private-password";`,
    );
    await writeFile(join(directory, "outside.ts"), "outside-scope-content");
    await symlink(join(directory, "outside.ts"), join(root, "escape.ts"));
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("denies traversal, absolute paths, escaping symlinks, directories and invalid offsets", async () => {
    const read = makeSourceReader(root);
    for (const path of [
      "../outside.ts",
      join(directory, "outside.ts"),
      "escape.ts",
      ".",
      "missing.ts",
    ]) {
      expect(await Effect.runPromise(Effect.either(read(path, 0)))).toMatchObject({
        _tag: "Left",
        left: { code: "SourceUnavailable" },
      });
    }
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await Effect.runPromise(Effect.either(read("operation.ts", offset)))).toMatchObject({
        _tag: "Left",
        left: { code: "SourceUnavailable" },
      });
    }
  });
});

describe("OpenAI reviewer policy and trusted authority", () => {
  afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

  /** Scripted Guardian model: one entrypoint read_source call, then the given decision. */
  const readThenDecide = (decision: unknown) => {
    const requests: ModelRequest[] = [];
    setDefaultModelProvider({
      getModel: () => ({
        getResponse: async (request) => {
          requests.push(request);
          return {
            usage: new Usage(),
            output:
              requests.length === 1
                ? [
                    {
                      type: "function_call" as const,
                      callId: "read_source_once",
                      name: "read_source",
                      arguments: JSON.stringify({ path: pending.entrypoint, offset: 0 }),
                      status: "completed" as const,
                    },
                  ]
                : [
                    {
                      type: "message" as const,
                      role: "assistant" as const,
                      status: "completed" as const,
                      content: [{ type: "output_text" as const, text: JSON.stringify(decision) }],
                    },
                  ],
          };
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    });
    return requests;
  };
  const readEntrypoint = () => Effect.succeed(sourceEnvelope);
  const reviewer = (upstreamPolicy: string) =>
    makeOpenAIReviewer(upstreamPolicy, false, { executionEnvironment: "native" });
  const modelInput = (requests: readonly ModelRequest[]): unknown => {
    const input = requests[0]?.input;
    const [message] = Array.isArray(input) ? input : [];
    const content = message !== undefined && "content" in message ? message.content : undefined;
    if (typeof content !== "string") throw new Error("Guardian input is not one text message");
    return JSON.parse(content);
  };

  // Failure mode: the adapter fills the upstream policy's slot with the browser policy and then
  // appends it again, so every review sends the model that policy twice.
  it("sends the tenant policy once, in the upstream policy's slot", async () => {
    const requests = readThenDecide({ outcome: "allow", rationale: "Controlled source was read." });
    await Effect.runPromise(
      makeGuardian(reviewer(markedUpstreamPolicy)).review(pending, readEntrypoint),
    );
    const copies = requests.map((request) => tenantPolicyCopies(request.systemInstructions ?? ""));
    expect(copies).toEqual([1, 1]);
  });

  // Failure mode: an upstream policy file without its slot, or with two, builds a reviewer that
  // reviews without Pomerado's policy or with it twice.
  it.each(["Synthetic upstream", `${markedUpstreamPolicy}\n${markedUpstreamPolicy}`])(
    "refuses to build without exactly one tenant policy slot",
    (upstreamPolicy) => {
      expect(() => reviewer(upstreamPolicy)).toThrow(UpstreamPolicySlotInvalid);
    },
  );

  // Many sign-in forms enable their submit only once the fields hold input, and the host waits for
  // the page to enable it before it clicks. Guardian judges what the submit is, not whether the page
  // has enabled it yet.
  it("asks Guardian for an observed sign-in submit, enabled or not", async () => {
    const requests = readThenDecide({ outcome: "allow", rationale: "Controlled source was read." });
    await Effect.runPromise(
      makeGuardian(reviewer(markedUpstreamPolicy)).review(pending, readEntrypoint),
    );
    const sentence =
      "The submit must be an observed control that submits the named fields or is necessary to this authorized sign-in,";
    for (const policy of [requests[0]?.systemInstructions ?? "", guardianExecutionPolicy("hosted")]) {
      expect(policy).toContain(sentence);
      expect(policy).not.toContain("enabled control");
    }
  });

  // Guardian reviews an execution's source, never each request it sends.
  it("an execution review carries no destination review", async () => {
    const requests = readThenDecide({ outcome: "allow", rationale: "Relevant listing page." });
    await Effect.runPromise(
      makeGuardian(reviewer("Synthetic upstream {{ tenant_policy_config }}")).review(
        pending,
        readEntrypoint,
      ),
    );
    expect(modelInput(requests)).not.toHaveProperty("destination_review");
  });

  // An entry load can redirect to a sibling subdomain, such as flights. to www. Guardian, seeing
  // only the exact origin and no observed page, would deny every guarded explore.
  it("a first explore review names the authorized site's registrable domain", async () => {
    const requests = readThenDecide({ outcome: "allow", rationale: "Guarded on the site." });
    await Effect.runPromise(
      makeGuardian(reviewer("Synthetic upstream {{ tenant_policy_config }}")).review(
        {
          ...pending,
          allowedOrigins: ["https://flights.site.invalid"],
          mintContext: {
            repeatableRead: false,
            operationSources: [pending.entrypoint],
            currentExecution: { purpose: "explore", target: "liveBrowser" },
            browser: "active",
            executions: [],
          },
        },
        readEntrypoint,
      ),
    );
    const input = modelInput(requests);
    expect(input).toHaveProperty("trusted_authority.allowedOrigins", [
      "https://flights.site.invalid",
    ]);
    expect(input).toHaveProperty("trusted_authority.allowedSites", [
      { scheme: "https", registrableDomain: "site.invalid" },
    ]);
    expect(input).not.toHaveProperty("trusted_execution_context.currentPage");
  });
});
