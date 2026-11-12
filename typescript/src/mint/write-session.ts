import { Effect } from "effect";
import { confirmActionUnmatched } from "../browser/dialogs/expected.js";
import {
  declaredRefusalReasons,
  unreadableRefusal,
  type CommitEvidence,
  type DeclaredRefusal,
} from "../runtime/run-outcome.js";
import { MintFailure, type ExecutionRequest, type WritePath } from "./contracts.js";
import { entrypointImportClosure } from "./operation-source.js";
import { writeContractRefusal } from "./write-contract.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import type { OutcomeAssessment } from "./outcome-review-contracts.js";

// The commit evidence of an act step's runner, shared with the run outcome classifier. This module
// keeps exporting both names, so its subpath's exports are unchanged.
export { commitEvidenceOf, type CommitEvidence } from "../runtime/run-outcome.js";

/**
 * Whether an act step that did not succeed may have committed its write: the host counted
 * something it sent, or could not count (`sent` undefined), or the step entered a commit mark or
 * returned no result (a lost page). Those last two may have committed where the host's count
 * cannot see, so the minter verifies before writing again.
 *
 * @deprecated Hosts use `readBackFirst`, which keys on Guardian's write label and the commit marks.
 */
export const commitUncertain = (sent: number | undefined, commit?: CommitEvidence) =>
  sent !== 0 || commit === "entered" || commit === "unreported";

/**
 * Why a failed act step may have committed its write, for its receipt.
 *
 * @deprecated Hosts use `readBackFirst`.
 */
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
 *
 * @deprecated Hosts use `readBackFirst`.
 */
export const verifyFirstNotice = (sent: number | undefined, commit: CommitEvidence | undefined) =>
  `This act step did not complete after ${uncertainCommit(sent, commit)}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. If it did, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`;

/** Why a failed act step Guardian labelled a write may have committed it, for its receipt. */
const labelledWriteUncertainty = (commit: CommitEvidence | undefined) =>
  commit === "entered"
    ? "its script entered a declared commit step"
    : commit === "unreported"
      ? "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered"
      : "Guardian labelled it a write";

/**
 * The receipt of an act step that failed after it may have committed its write. The host never
 * blocks or resubmits a write; the minter verifies by reading back, then decides. A commit request
 * the site answered 2xx or 3xx lets that read be the write's own result, on the page as it stands
 * or looked up on another page such as a list.
 */
const labelledWriteNotice = (commit: CommitEvidence | undefined) =>
  `This act step did not complete after ${labelledWriteUncertainty(commit)}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. When this step's stateChangingRequests shows its commit request to the site returned 2xx or 3xx, that step may read back the write's own result, the record it just created or changed: on the page as it stands, or looked up on another page such as a list. Check it shows no error or validation message, read what the output needs, and call verified() there. Reading is allowed; a second write is not. A 200 whose body reports an error, as GraphQL can, did not go through. Read the site's own proof for such a commit, as for an error status, since part of it may have applied. A 202, or a 2xx whose body says the work is queued, counts too: return the site's own status word for it, such as Queued, in the output. If the write happened, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`;

/**
 * What an act step Guardian labelled a write asks of the minter when it did not complete: read
 * back before any further write, unless its commit marks show no commit step entered, since such
 * a step changed nothing. Each host decides that the step was a write that did not complete; the
 * rule and its text are the same for every host.
 */
export const readBackFirst = (commit: CommitEvidence | undefined) =>
  commit === "not_entered"
    ? undefined
    : { verifyFirst: true as const, notice: labelledWriteNotice(commit) };

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
   * The host's own record shows this step may have reached the site, as an effect journal does
   * once the step called the browser, or as a step whose dispatch fence passed does.
   */
  readonly possiblySent?: boolean;
  /** Guardian's action label for the step: only a `write` is the session's write. */
  readonly action?: GuardianAction;
  /** The outcome review's newest finding for this step's write, when it has one. */
  readonly assessment?: OutcomeAssessment["outcome"];
  /**
   * The refusal this step returned in a shape its own output schema declares, while its runner
   * showed it entered no commit mark and recorded no confirmation (`returnedRefusal`): the site's
   * own no to the session's input, such as a product it does not offer for these facts. A host
   * sets it only on the session's last act step, and only when no other step may have sent a write
   * without entering a mark, since the check reads it on the step named for publication alone.
   */
  readonly refused?: DeclaredRefusal;
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

/**
 * The commit marks no later act step of the session may enter, with the steps that may have sent
 * each: every mark a step entered, or streamed when its result was lost, unless the outcome review
 * found that step's write `not_done`. A host runs each later act step with them settled
 * (`makeEffectJournalWith`), so entering one fails with `CommitAlreadySent` before it sends,
 * whatever file the step runs. A mark a step put back unsent (`notCommitted`) is not entered.
 */
export const fencedCommits = (
  steps: readonly {
    readonly executionId: string;
    readonly enteredMarks: readonly string[];
    readonly streamedMarks?: readonly string[] | undefined;
    readonly assessment?: OutcomeAssessment["outcome"] | undefined;
  }[],
): ReadonlyMap<string, readonly string[]> => {
  const fenced = new Map<string, string[]>();
  for (const step of steps)
    if (step.assessment !== "not_done")
      for (const name of new Set([...step.enteredMarks, ...(step.streamedMarks ?? [])]))
        fenced.set(name, [...(fenced.get(name) ?? []), step.executionId]);
  return fenced;
};

/** What an act step hears when it stopped at commit step `mark`, which `writes` may have sent. */
export const fencedCommitNotice = (mark: string, writes: readonly string[]) =>
  `This step stopped at commit step \`${mark}\` before sending it: an earlier step may already have sent it (${writes.join(", ")}). A commit step that may have gone out is never entered again, from any file, unless an outcome review finds that write did not happen. Prefer reading back the account or page in a step that changes nothing.`;

/**
 * How many steps lead the path as setup steps: those before its first other step, and never its
 * last, which reaches the outcome. Setup is state the site makes by itself as the session starts,
 * so `setup` on any later step claims nothing.
 */
const setupLead = (path: WritePath) => {
  const first = path.steps.findIndex((step) => step.setup !== true);
  return first === -1 ? path.steps.length - 1 : first;
};

/** The marks of steps that claim `setup` where the path may not have one, in path order. */
const setupMisplaced = (path: WritePath) =>
  path.steps
    .slice(setupLead(path))
    .filter((step) => step.setup === true)
    .map((step) => step.commit);

/**
 * The commit marks of a recorded write path that `entered` lacks, in path order. A leading setup
 * step is no commit step: the site makes its session state once, and may have before the session
 * started, so its mark is never owed. Every other step's mark is, `setup` or not, so the step that
 * reaches the outcome always is.
 */
export const writePathRemaining = (
  path: WritePath | undefined,
  entered: ReadonlySet<string>,
): readonly string[] =>
  path === undefined
    ? []
    : path.steps
        .slice(setupLead(path))
        .map((step) => step.commit)
        .filter((name) => !entered.has(name));

/**
 * The marks of the recorded path the session entered that a revision drops or moves out of their
 * order. A revision may add marks anywhere, the ones the session entered off the path included.
 */
const enteredMarksLost = (
  recorded: WritePath,
  revised: WritePath,
  entered: ReadonlySet<string>,
) => {
  const order = revised.steps.map((step) => step.commit);
  const lost: string[] = [];
  let next = 0;
  for (const { commit } of recorded.steps) {
    if (!entered.has(commit)) continue;
    const at = order.indexOf(commit, next);
    if (at === -1) lost.push(commit);
    else next = at + 1;
  }
  return lost;
};

/**
 * Why a write build's act step may not run with the write path it carries, if it may not, before
 * any review or dispatch. A build's first act step declares its whole write path; a later one may
 * revise it, keeping every mark of the recorded path the session already entered, in the same
 * order. A path, first or revised, marks `setup` only on steps before its first other step, and
 * never on its last. A path with no step, for a request that ends before any save, is refused
 * unless the host publishes on a read-back (`publishOnReadBack`, as `checkWriteSession` takes it).
 * A session that started without a recorded path, as one a host started before it kept paths,
 * runs on without one. Hosts apply it to a build's write session, never to a repair's.
 */
export const writePathRefusal = (
  submitted: Pick<ExecutionRequest, "purpose" | "target" | "writePath">,
  session: {
    readonly started: boolean;
    readonly path: WritePath | undefined;
    readonly enteredMarks: ReadonlySet<string>;
  },
  host: { readonly publishOnReadBack?: boolean } = {},
): string | undefined => {
  if (submitted.purpose !== "act" || submitted.target !== "liveBrowser") return undefined;
  if (submitted.writePath === undefined)
    return session.started
      ? undefined
      : "A write build's first act step declares writePath before anything is sent: in steps, each step that saves or submits on the site through to the outcome the request asks for, by the commit mark its helper enters, in order, and none when the request ends before any save, never a step that saves nothing; in ends, what the last step leaves the caller with. Guardian reviews the path as publication will review the tool, and the session runs until every mark on it is entered. Add writePath and execute again. Nothing was executed.";
  if (submitted.writePath.steps.length === 0 && host.publishOnReadBack !== true)
    return "writePath names no step, and this host publishes only a write that saves on the site. When the request ends before any save, end with report_blocked and say so. Nothing was executed.";
  const misplaced = setupMisplaced(submitted.writePath);
  if (misplaced.length > 0)
    return `A setup step only comes before every other step of writePath, and its last step, which reaches the outcome, is never one. Remove setup: ${misplaced.join(", ")}. Nothing was executed.`;
  if (session.path === undefined) return undefined;
  const lost = enteredMarksLost(session.path, submitted.writePath, session.enteredMarks);
  return lost.length === 0
    ? undefined
    : `A revised writePath keeps every mark of the recorded path the session already entered, in the same order: ${lost.join(", ")}. Correct writePath and execute again. Nothing was executed.`;
};

/**
 * The receipt note of an act step after which marks of the recorded write path are not yet settled,
 * as unentered or entered only by a step that lost its result: the session runs on until they are,
 * and a confirmation the step recorded does not end it. A read-back settles only the marks a lost
 * step streamed (`sessionEnteredMarks`), never one no step entered; the host's receipt does not say
 * which is which, so the note gives both rules. The refusal at publication tells them apart.
 */
export const writePathNotice = (remaining: readonly string[], confirmed: boolean) => ({
  remaining,
  instruction: `${confirmed ? "This step's confirmation does not end the write session. " : ""}The session's recorded write path has commit marks not yet settled: ${remaining.join(", ")}. The session runs until every one is settled. Read back first where a receipt says so: a read-back that confirms the write settles the marks a lost step entered, never one no step entered. Then run only steps that never ran, on the page as it stands; never redo one that finished or may have. When the page shows the path must change, such as a step the site skips for this input or one that saves nothing, declare the revised path in writePath on the next act step.`,
});

/** Whether a step of the session recorded a confirmation. */
export const sessionConfirmed = (steps: readonly WriteSessionMarks[]) =>
  steps.some((entry) => entry.confirmation !== undefined);

/**
 * Whether the session sent its write. A recorded confirmation is that proof, whatever request
 * carried the commit. Otherwise (an unverifiable write) a step Guardian labelled a write must
 * have possibly reached the site without the outcome review finding it `not_done`: a write whose
 * outcome is unknown or not yet assessed counts, since publication never waits for the review.
 * Request counts and commit marks never decide it; they stay the write contract's evidence.
 */
export const sessionSentWrite = (session: { readonly steps: readonly WriteSessionMarks[] }) =>
  sessionConfirmed(session.steps) ||
  session.steps.some(
    (step) =>
      step.action === "write" && step.possiblySent === true && step.assessment !== "not_done",
  );

const sessionRefusal = (
  reason: NonNullable<MintFailure["reason"]>,
  writePathMarks?: readonly string[],
  publishesOnRefusal = false,
  publishesOnReadBack = false,
  writePathUnreached?: readonly string[],
) =>
  new MintFailure({
    code: "PublicationUnavailable",
    reason,
    ...(writePathMarks === undefined ? {} : { writePathMarks }),
    ...(writePathUnreached === undefined || writePathUnreached.length === 0
      ? {}
      : { writePathUnreached }),
    // The two refusals a minter meets when it has not yet published on the site's own no.
    ...(publishesOnRefusal &&
    (reason === "write_not_submitted" || reason === "commit_marks_unentered")
      ? { publishesOnRefusal: true as const }
      : {}),
    // And the two it meets when it has not yet published on a read-back of the end state.
    ...(publishesOnReadBack &&
    (reason === "write_path_unfinished" || reason === "commit_marks_unentered")
      ? { publishesOnReadBack: true as const }
      : {}),
  });

/** The marks of `remaining` no step of the session entered or streamed, in their order. */
const unreachedMarks = (remaining: readonly string[], steps: readonly WriteSessionMarks[]) => {
  const streamed = new Set(steps.flatMap((step) => step.streamedMarks ?? []));
  return remaining.filter((name) => !streamed.has(name));
};

/**
 * A write session's checks before its composed script publishes, in order: the session sent its
 * write and, given `writePath`, entered every mark of its recorded write path; then the script's
 * contract, which `extract` reads offline only after that, declares a confirmation and the commit
 * marks the session entered, decodes the session's input and matches the confirmation the named
 * step recorded, and declares every mark of the recorded path. Then, given the script's
 * `outputSchema`, every refusal it lists is one the host reads as declared. Last, given
 * `confirms`, the script names each step its session accepted a confirm popup at. The composed
 * script is never run. Its result names, as `commitsUnproven` in the order `commits` declares
 * them, the commit steps the contract declares unproven, after the last one the session entered or
 * named by `skippableCommits`, which no run has shown yet; it leaves the key out when there are none.
 *
 * A host that publishes a write whose example ended in the site's own no sets `publishOnRefusal`.
 * Then, when the step named for publication entered no commit mark, recorded no confirmation and
 * returned a declared refusal (`refused`), the refusal is the session's proven outcome: the check
 * skips the sent and write path checks, and the composed script must declare that refusal's reason
 * in its output schema and name every commit step after the last one the session entered (all of
 * them when it entered none) in `commitsUnproven`. The result carries the refusal as `refusal`.
 *
 * A host that publishes on a read-back sets `publishOnReadBack`. Then, when the step named for
 * publication recorded a `readback` confirmation, two outcomes that stand without a save may
 * publish on it, each still a write the publication review judges against that read-back. A
 * recorded write path with no step, for a request that ends before any save, publishes a contract
 * that declares no commit steps while no step entered or streamed a mark, and the result says so
 * as `stopsBeforeSave`. And marks the
 * session never entered, as when the site already showed the request's end state, may be named in
 * `commitsUnproven`: every commit step after the last one the session entered, all of them when it
 * entered none, and so may marks of the path no step entered or streamed after the last mark of
 * the path it entered, which the write path check then leaves to the contract. With a recorded
 * path, a session that entered none may leave unproven only marks of that path. A host that leaves
 * it unset refuses both as before.
 */
export const checkWriteSession = <
  Extracted extends {
    readonly contract: { readonly write?: Parameters<typeof writeContractRefusal>[0] };
    readonly inputDecodes: boolean;
    /** The composed script's files, which the confirm popup check reads. */
    readonly files?: ReadonlyMap<string, string>;
    /**
     * The composed script's output JSON Schema, as it publishes it. Given it, the check refuses
     * an output schema that lists a `refused` status the host cannot read as a declared refusal
     * (`unreadableRefusal`), as `refusal_unreadable`. A host that leaves it out skips that check.
     */
    readonly outputSchema?: unknown;
  },
  E,
  R,
>(check: {
  readonly session: { readonly steps: readonly WriteSessionMarks[] };
  /** The act step named for publication. */
  readonly step: Pick<WriteSessionMarks, "confirmation" | "refused"> & {
    readonly enteredMarks?: readonly string[];
  };
  readonly extract: Effect.Effect<Extracted, E, R>;
  /**
   * The steps the session's act steps accepted confirm popups at, and the composed script's
   * entrypoint. The entrypoint's import closure must name each step as a literal, or a run could
   * never match its recorded confirm. A host that runs this check on its own leaves it unset.
   */
  readonly confirms?: { readonly steps: Iterable<string>; readonly entrypoint: string };
  /**
   * The session's recorded write path, which its first act step declared and Guardian allowed. A
   * host that kept none, as for a session started before hosts kept paths, leaves it unset.
   */
  readonly writePath?: WritePath;
  /**
   * For a publication that replaces a published revision, such as a repair or a change, that
   * revision's output JSON Schema. A refusal the host cannot read in it too is not refused here,
   * so a tool published before the refusal check is never refused for the shape it has.
   */
  readonly registeredOutputSchema?: unknown;
  /**
   * Set by a host that publishes a write whose example ended in the site's own declared no. A
   * host that leaves it unset refuses such a session as before.
   */
  readonly publishOnRefusal?: boolean;
  /**
   * Set by a host that publishes, on the `readback` confirmation the step named for publication
   * recorded, a write path with no step and save steps the session never entered. A host that
   * leaves it unset refuses such a session as before.
   */
  readonly publishOnReadBack?: boolean;
  /**
   * For a publication that replaces a published revision, such as a repair or a change: given the
   * read contract, the commit steps that `commitsUnproven` may name wherever they sit in `commits`,
   * not only after the last one the session entered, as conditional steps the session's input
   * skipped whose code the replacement left as the revision has it. Still only once the session
   * entered a mark. A host that leaves it unset refuses them as before.
   */
  readonly skippableCommits?: (extracted: Extracted) => Iterable<string>;
}) =>
  Effect.gen(function* () {
    const { session, step } = check;
    // The step named for publication saved and confirmed nothing, so the site's own no may stand.
    const refusable =
      check.publishOnRefusal === true &&
      step.confirmation === undefined &&
      step.enteredMarks?.length === 0;
    // The step named for publication read back the page, so an outcome that stands without a save
    // may publish on it.
    const readBack = check.publishOnReadBack === true && step.confirmation === "readback";
    const refuse = (
      reason: NonNullable<MintFailure["reason"]>,
      writePathMarks?: readonly string[],
      writePathUnreached?: readonly string[],
      publishesOnReadBack = check.publishOnReadBack === true,
    ) =>
      sessionRefusal(reason, writePathMarks, refusable, publishesOnReadBack, writePathUnreached);
    const siteRefusal = refusable ? step.refused : undefined;
    if (siteRefusal === undefined && !sessionSentWrite(session))
      return yield* refuse("write_not_submitted");
    const enteredMarks = sessionEnteredMarks(session.steps);
    // The refusal ends the session (the host sets `refused` only on its last act step), so the
    // path's later marks stay unentered.
    const unrun =
      siteRefusal === undefined ? writePathRemaining(check.writePath, enteredMarks) : [];
    // No read-back settles a mark no step entered or streamed. On a read-back, the contract may
    // declare such marks unproven when each comes after the last mark of the path the session
    // entered, all of them when it entered none, as `writeContractRefusal` takes them; an earlier
    // one, as a step the site skipped, leaves the path to revise.
    const unreached = unreachedMarks(unrun, session.steps);
    const pathMarks = check.writePath?.steps.map((pathStep) => pathStep.commit) ?? [];
    const lastEntered = pathMarks.findLastIndex((name) => enteredMarks.has(name));
    const escapes =
      check.publishOnReadBack === true &&
      unreached.length > 0 &&
      unreached.every((name) => pathMarks.indexOf(name) > lastEntered);
    if (unrun.length > 0 && !(readBack && escapes && unreached.length === unrun.length))
      return yield* refuse("write_path_unfinished", unrun, unreached, escapes);
    const extracted = yield* check.extract;
    const declared = extracted.contract.write?.confirmation;
    const declaredUnproven = new Set(extracted.contract.write?.commitsUnproven ?? []);
    const owed = unrun.filter((name) => !declaredUnproven.has(name));
    if (owed.length > 0) return yield* refuse("write_path_unfinished", owed, owed);
    const commits = extracted.contract.write?.commits ?? [];
    // A path with no step, for a request that ends before any save, publishes saving nothing, and
    // only while no step entered or streamed a mark.
    const stopsBeforeSave =
      readBack &&
      check.writePath?.steps.length === 0 &&
      session.steps.every(
        (entry) => entry.enteredMarks.length === 0 && (entry.streamedMarks ?? []).length === 0,
      );
    const refusal = writeContractRefusal(extracted.contract.write, extracted.inputDecodes, step, {
      confirmed: sessionConfirmed(session.steps),
      enteredMarks,
      ...(siteRefusal === undefined ? {} : { refused: true }),
      // With a recorded path, a read-back leaves unproven from the start only steps of that path,
      // which Guardian reviewed before anything was sent.
      ...(readBack &&
      (check.writePath === undefined ||
        [...declaredUnproven].every((name) => typeof name === "string" && pathMarks.includes(name)))
        ? { readBack: true }
        : {}),
      ...(stopsBeforeSave ? { stopsBeforeSave: true } : {}),
      ...(check.skippableCommits === undefined
        ? {}
        : { skippable: new Set(check.skippableCommits(extracted)) }),
    });
    if (refusal !== undefined || declared === undefined)
      return yield* refuse(refusal ?? "confirmation_undeclared");
    const undeclared = writePathRemaining(check.writePath, new Set(commits.map(String)));
    if (undeclared.length > 0) return yield* refuse("write_path_undeclared", undeclared);
    // A refusal the host cannot read ends its run as an unknown outcome, so it is fixed now.
    if (
      extracted.outputSchema !== undefined &&
      unreadableRefusal(extracted.outputSchema) &&
      (check.registeredOutputSchema === undefined ||
        !unreadableRefusal(check.registeredOutputSchema))
    )
      return yield* refuse("refusal_unreadable");
    // The example's refusal stands for the tool only when the composed script declares it too.
    if (
      siteRefusal !== undefined &&
      !declaredRefusalReasons(extracted.outputSchema).has(siteRefusal.reason)
    )
      return yield* refuse("write_not_submitted");
    // A run accepts a confirm popup without asking only at the action the build accepted it at,
    // so the composed script must run each such action under the session's action id.
    if (check.confirms !== undefined) {
      const files = extracted.files ?? new Map<string, string>();
      const composed = entrypointImportClosure(files, check.confirms.entrypoint);
      yield* confirmActionUnmatched(check.confirms.steps, [...composed.values()]);
    }
    // The contract check accepted these only as marks of `commits` the session never entered.
    const unproven = commits.filter((name) => declaredUnproven.has(name)).map(String);
    const checked: {
      readonly extracted: Extracted;
      readonly declared: NonNullable<typeof declared>;
      readonly commitsUnproven?: readonly string[];
      readonly refusal?: DeclaredRefusal;
      /** The tool stops before any save: its path names no step and it declares no commit step. */
      readonly stopsBeforeSave?: true;
    } = {
      extracted,
      declared,
      ...(unproven.length === 0 ? {} : { commitsUnproven: unproven }),
      ...(siteRefusal === undefined ? {} : { refusal: siteRefusal }),
      ...(stopsBeforeSave && commits.length === 0 ? { stopsBeforeSave: true as const } : {}),
    };
    return checked;
  });
