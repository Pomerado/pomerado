import { Effect } from "effect";
import { confirmActionUnmatched } from "../browser/dialogs/expected.js";
import type { CommitMark } from "../runtime/context.js";
import { MintFailure } from "./contracts.js";
import { entrypointImportClosure } from "./operation-source.js";
import { writeContractRefusal } from "./write-contract.js";

/**
 * What an act step's runner proves about its commit steps. `not_entered`: it declared marks and
 * entered none. `entered`: it entered at least one. `undeclared`: the script declared no marks, so
 * a commit the host cannot see stays possible. `unreported`: no readable report, so nothing is
 * known. Only `not_entered` ever lets a write count as having sent nothing.
 */
export type CommitEvidence = "not_entered" | "entered" | "undeclared" | "unreported";

/** The evidence of a runner's own report of its commit marks. */
export const commitEvidenceOf = (marks: readonly CommitMark[]) =>
  marks.length === 0
    ? ("undeclared" as const)
    : marks.some((mark) => mark.state !== "not_sent")
      ? ("entered" as const)
      : ("not_entered" as const);

/**
 * Whether an act step that did not succeed may have committed its write: the host counted
 * something it sent, or could not count (`sent` undefined), or the step entered a commit mark or
 * returned no result (a lost page). Those last two may have committed where the host's count
 * cannot see, so the minter verifies before writing again.
 */
export const commitUncertain = (sent: number | undefined, commit?: CommitEvidence) =>
  sent !== 0 || commit === "entered" || commit === "unreported";

/** Why a failed act step may have committed its write, for its receipt. */
export const uncertainCommit = (sent: number | undefined, commit: CommitEvidence | undefined) =>
  sent === undefined
    ? "the page sent requests the host could not count"
    : sent > 0
      ? `the page sent ${sent} request(s) or opened socket(s) that could change the site`
      : commit === "entered"
        ? "its script entered a declared commit step, which may have sent the write as a request the host does not count (a GET link, for example)"
        : "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered";

/**
 * The receipt of an act step that failed after it may have committed its write. The host never
 * blocks or resubmits a write; the minter verifies by reading back, then decides.
 */
export const verifyFirstNotice = (sent: number | undefined, commit: CommitEvidence | undefined) =>
  `This act step did not complete after ${uncertainCommit(sent, commit)}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. If it did, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`;

/** What publication reads of one act step of a write session. */
export interface WriteSessionMarks {
  /** The confirmation the step recorded. */
  readonly confirmation?: "message" | "readback";
  /** The commit marks this step's runner reported entered (`sent` or `confirmed`). */
  readonly enteredMarks: readonly string[];
  /**
   * Set only when the step returned no readable commit report, such as when its browser was lost:
   * the commit marks its runner streamed to the host as it entered them.
   */
  readonly streamedMarks?: readonly string[];
  /**
   * The host's own record shows this step may have sent something to the site, as an effect
   * journal does once the step called the browser. A host that counts the requests a step sent
   * passes its count as `nonReadRequests` and leaves this unset.
   */
  readonly possiblySent?: boolean;
}

/**
 * The commit marks a session entered: those its steps' runners reported, and, once a later step
 * confirmed the write, those a step whose result was lost streamed as it entered them.
 */
export const sessionEnteredMarks = (steps: readonly WriteSessionMarks[]) => {
  const entered = new Set(steps.flatMap((step) => step.enteredMarks));
  steps.forEach((step, index) => {
    if (steps.slice(index + 1).some((later) => later.confirmation !== undefined))
      for (const name of step.streamedMarks ?? []) entered.add(name);
  });
  return entered;
};

/** Whether a step of the session recorded a confirmation. */
export const sessionConfirmed = (steps: readonly WriteSessionMarks[]) =>
  steps.some((entry) => entry.confirmation !== undefined);

/**
 * Whether the session sent its write. A recorded confirmation is that proof, whatever request
 * carried the commit; otherwise (an unverifiable write) an act step must have sent a non-read
 * request, or entered a commit mark, which is the only evidence of a GET or websocket commit.
 * `nonReadRequests` is what the host counted while the session's act steps ran. A host that
 * counts no requests passes 0 and marks each step it cannot rule out as `possiblySent`, so the
 * check fails closed. A socket or an unclassified dispatch only asks the minter to verify.
 */
export const sessionSentWrite = (session: {
  readonly steps: readonly WriteSessionMarks[];
  readonly nonReadRequests: number;
}) =>
  sessionConfirmed(session.steps) ||
  session.nonReadRequests > 0 ||
  session.steps.some((step) => step.enteredMarks.length > 0) ||
  session.steps.some((step) => step.possiblySent === true);

const sessionRefusal = (reason: NonNullable<MintFailure["reason"]>) =>
  new MintFailure({ code: "PublicationUnavailable", reason });

/**
 * A write session's checks before its composed script publishes, in order: the session sent its
 * write, then the script's contract, which `extract` reads offline only after that, declares a
 * confirmation and the commit marks the session entered, decodes the session's input and matches
 * the confirmation the named step recorded. Last, given `confirms`, the script names each step its
 * session accepted a confirm popup at. The composed script is never run.
 */
export const checkWriteSession = <
  Extracted extends {
    readonly contract: { readonly write?: Parameters<typeof writeContractRefusal>[0] };
    readonly inputDecodes: boolean;
    /** The composed script's files, which the confirm popup check reads. */
    readonly files?: ReadonlyMap<string, string>;
  },
  E,
  R,
>(check: {
  readonly session: {
    readonly steps: readonly WriteSessionMarks[];
    readonly nonReadRequests: number;
  };
  /** The act step named for publication. */
  readonly step: { readonly confirmation?: "message" | "readback" };
  readonly extract: Effect.Effect<Extracted, E, R>;
  /**
   * The steps the session's act steps accepted confirm popups at, and the composed script's
   * entrypoint. The entrypoint's import closure must name each step as a literal, or a run could
   * never match its recorded confirm. A host that runs this check on its own leaves it unset.
   */
  readonly confirms?: { readonly steps: Iterable<string>; readonly entrypoint: string };
}) =>
  Effect.gen(function* () {
    const { session, step } = check;
    if (!sessionSentWrite(session)) return yield* sessionRefusal("write_not_submitted");
    const extracted = yield* check.extract;
    const declared = extracted.contract.write?.confirmation;
    const refusal = writeContractRefusal(extracted.contract.write, extracted.inputDecodes, step, {
      confirmed: sessionConfirmed(session.steps),
      enteredMarks: sessionEnteredMarks(session.steps),
    });
    if (refusal !== undefined || declared === undefined)
      return yield* sessionRefusal(refusal ?? "confirmation_undeclared");
    // A run accepts a confirm popup without asking only at the action the build accepted it at,
    // so the composed script must run each such action under the session's action id.
    if (check.confirms !== undefined) {
      const files = extracted.files ?? new Map<string, string>();
      const composed = entrypointImportClosure(files, check.confirms.entrypoint);
      yield* confirmActionUnmatched(check.confirms.steps, [...composed.values()]);
    }
    return { extracted, declared };
  });
