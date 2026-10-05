import { Context, Effect, Ref } from "effect";
import { CommitAlreadySent } from "./errors.js";
import type { CaptureUnavailable, EventUnavailable, WriteConfirmationRefused } from "./errors.js";
import type { Deadline } from "./deadline.js";

export interface EventSink {
  // The host stamps correlation fields and screens details before publication.
  readonly emit: (name: string, details: unknown) => Effect.Effect<void, EventUnavailable>;
}

export interface CaptureLifecycle {
  readonly start: Effect.Effect<void, CaptureUnavailable>;
  /** Collect final evidence and register discovered secrets, then await retain/discard. */
  readonly prepareRelease?: Effect.Effect<void, CaptureUnavailable>;
  readonly finish: Effect.Effect<void, CaptureUnavailable>;
  /** Optional success-only retention; cap screened files before any storage write. */
  readonly finishSampled?: (maxBytes: number) => Effect.Effect<void, CaptureUnavailable>;
  /** Await only after starting finish; success means final batch secrets are registered. */
  readonly releasePrepared?: Effect.Effect<void, CaptureUnavailable>;
  /** Complete a prepared finalization without rendering or storing capture artifacts. */
  readonly discard?: Effect.Effect<void, CaptureUnavailable>;
}

/**
 * Capture is evidence, never the run's result: a capture that cannot finish becomes a recorded
 * gap event and the operation's own outcome stands. The event sink failing too changes nothing.
 */
export const finishCaptureAsEvidence = (context: {
  readonly capture: CaptureLifecycle;
  readonly events: EventSink;
}) =>
  context.capture.finish.pipe(
    Effect.catchAll((error) =>
      context.events
        .emit("capture.finish_gap", {
          phase: error.phase,
          ...(error.captureReason === undefined ? {} : { reason: error.captureReason }),
          ...(error.captureCollection === undefined ? {} : { collection: error.captureCollection }),
          ...(error.captureScreening === undefined ? {} : { screening: error.captureScreening }),
          ...(error.captureReleasePreparation === undefined
            ? {}
            : { releasePreparation: error.captureReleasePreparation }),
        })
        // error-reporting-allow: typed-recovery the capture failure is what the gap event names; a sink that cannot take it leaves the operation's own outcome as the record
        .pipe(Effect.ignore),
    ),
  );

export type WebsiteEffect = "not_started" | "may_have_dispatched" | "verified";
/** How a write confirmed its effect: a confirmation the site showed, or a read-back of the saved state. */
export type WriteConfirmation = "message" | "readback";
/**
 * One named commit step of a write: `not_sent` until the step is about to dispatch, `sent` from
 * then on (it may have reached the site), `confirmed` once the write's confirmation was read.
 */
export type CommitMarkState = "not_sent" | "sent" | "confirmed";
export interface CommitMark {
  readonly name: string;
  readonly state: CommitMarkState;
}

export interface EffectJournal {
  readonly state: Effect.Effect<WebsiteEffect>;
  readonly enteringDispatch: Effect.Effect<void>;
  /** Completion evidence with no kind; a write records its kind with `confirmed`. */
  readonly verified: Effect.Effect<void, WriteConfirmationRefused>;
  /** The write read the site's confirmation or read back its saved state. It also sets `verified`,
   * so a host that reads only `state` still sees a confirmed write as verified. */
  readonly confirmed: (kind: WriteConfirmation) => Effect.Effect<void, WriteConfirmationRefused>;
  readonly confirmation: Effect.Effect<WriteConfirmation | undefined>;
  /**
   * Just before a write's named commit step dispatches. The mark reads `sent` from here on, even
   * if the step then fails, because the site may already have the request; like
   * `enteringDispatch`, it also marks the effect as possibly dispatched. A settled step, which
   * maintenance may not redo, fails with `CommitAlreadySent` instead, leaving the journal as it was.
   */
  readonly enteringCommit: (name: string) => Effect.Effect<void, CommitAlreadySent>;
  /** The operation's declared marks, in order; `executeOperation` records them before it runs. */
  readonly declareCommits: (names: readonly string[]) => Effect.Effect<void>;
  /** Every mark: the declared ones in order, then any entered without a declaration. */
  readonly commits: Effect.Effect<readonly CommitMark[]>;
}

/**
 * A journal whose `settledCommits` cannot be entered: during maintenance, the steps the original
 * confirmed and the sent ones its read-back did not find missing.
 */
export const makeEffectJournalWith = (options: {
  readonly settledCommits?: readonly string[];
}): Effect.Effect<EffectJournal> =>
  Effect.gen(function* () {
    const settled = new Set(options.settledCommits ?? []);
    const state = yield* Ref.make<WebsiteEffect>("not_started");
    const confirmation = yield* Ref.make<WriteConfirmation | undefined>(undefined);
    const commits = yield* Ref.make<readonly CommitMark[]>([]);
    const withMark = (name: string, next: (current: CommitMarkState) => CommitMarkState) =>
      Ref.update(commits, (marks) =>
        marks.some((mark) => mark.name === name)
          ? marks.map((mark) => (mark.name === name ? { name, state: next(mark.state) } : mark))
          : [...marks, { name, state: next("not_sent") }],
      );
    return {
      state: Ref.get(state),
      // A later dispatch reopens the effect, so a confirmation recorded before it no longer holds,
      // and the commit steps it covered read sent again.
      enteringDispatch: Ref.set(state, "may_have_dispatched").pipe(
        Effect.zipRight(Ref.set(confirmation, undefined)),
        Effect.zipRight(
          Ref.update(commits, (marks) =>
            marks.map((mark) => (mark.state === "confirmed" ? { ...mark, state: "sent" } : mark)),
          ),
        ),
      ),
      verified: Ref.set(state, "verified"),
      // The confirmation covers the whole write, so every commit step it followed is confirmed.
      confirmed: (kind) =>
        Ref.set(confirmation, kind).pipe(
          Effect.zipRight(
            Ref.update(commits, (marks) =>
              marks.map((mark) => (mark.state === "sent" ? { ...mark, state: "confirmed" } : mark)),
            ),
          ),
          Effect.zipRight(Ref.set(state, "verified")),
        ),
      confirmation: Ref.get(confirmation),
      // Entering a step again commits again, so even a confirmed mark reads sent.
      enteringCommit: (name) =>
        settled.has(name)
          ? Effect.fail(new CommitAlreadySent({ name }))
          : withMark(name, () => "sent").pipe(
              Effect.zipRight(Ref.set(state, "may_have_dispatched")),
            ),
      declareCommits: (names) =>
        Effect.forEach(names, (name) => withMark(name, (current) => current), { discard: true }),
      commits: Ref.get(commits),
    };
  });

export const makeEffectJournal: Effect.Effect<EffectJournal> = makeEffectJournalWith({});

export interface ExecutionServices {
  readonly deadline: Deadline;
  readonly events: EventSink;
  readonly capture: CaptureLifecycle;
  readonly journal: EffectJournal;
}

export class ExecutionContext extends Context.Tag("pomerado/ExecutionContext")<
  ExecutionContext,
  ExecutionServices
>() {}
