import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution, Reviewer } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { readScopedFile } from "../../src/filesystem/read.js";
import {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../../src/models/model-diagnostic-failure.js";
import { EventUnavailable } from "../../src/runtime/errors.js";

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

  it("does not permit an allow decision when the entrypoint could not be put in view", async () => {
    const guardian = makeGuardian({
      run: () => Effect.succeed({ outcome: "allow", rationale: "No source was read." }),
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
