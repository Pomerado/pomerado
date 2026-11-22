import { Clock, Duration, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import { type AutofillRecipeStep, handsOffSignIn } from "../destinations/autofill-recipe.js";
import { handOffPrompt, type SignInMethodChoice } from "../destinations/autofill-contracts.js";
import { urlOrigin } from "../destinations/autofill-refusal.js";
import {
  type AutofillInspection,
  type AutofillSlot,
  type AutofillStep,
  hostSubmits,
} from "../destinations/autofill-step.js";
import {
  addsDismiss,
  blankFingerprint,
  containsFingerprint,
  describeFingerprint,
  type FingerprintShape,
  fingerprintShape,
  fingerprintText,
  type Look,
  type ObservedState,
  sameBoxes,
  sameFingerprint,
  type SignedInEntry,
  type SignInStates,
  type SignInStatesChoices,
  signInStatesStepUpRecipe,
  standingFingerprint,
  stateAfter,
  type StateEntry,
  type StateFingerprint,
  takesLost,
  toldApart,
} from "../destinations/sign-in-states.js";
import type { AutofillSignInState } from "./autofill-state.js";
import { maySend } from "../destinations/autofill-refusal.js";
import { recordedRejections } from "./autofill-rejection.js";
import { approvalNumber, openPastedLink, withApprovalNumber } from "./autofill-replay-approval.js";
import { settleCarried } from "./autofill-replay-fill.js";
import { landingSettleMs } from "./autofill-replay-pages.js";
import { alreadySignedIn, makeReplay, type Replay, workspaceOf } from "./autofill-replay-session.js";
import {
  askOne,
  type AutofillReplayInput,
  type AutofillReplayOutcome,
  isTwoFactorOption,
  stepDiagnostic,
  valuesNeeded,
} from "./autofill-replay-steps.js";
import { admitScreen, noteExactSent } from "./autofill-replay-workspace.js";
import { codeRowFields, isCodeRowByPlace } from "./autofill-unrecorded-code.js";
import { isIdentifier, provesLogin, screenSubmit, submittedLoginProof } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";
import { workspaceHost } from "./workspace-origin.js";

// A sign-in replayed from a library of states, never from a recipe: the page is looked at again
// after each action, typing one box or pressing, and each state it shows is matched to a known one
// and handled as recorded there. It reuses the recipe replay's own pieces for values, fills,
// origins and the signed-in check, so every box typed passes the same checks.

/**
 * How long a press waits for the page to hold still, and at most, when the state it is in may
 * still grow into another known state; and how long a page that was to send what was typed itself
 * gets to move before Enter is pressed there (`enterMs`, `enterAfterTyping`).
 */
export interface StatesQuiet {
  readonly quietMs: number;
  readonly capMs: number;
  readonly enterMs?: number | undefined;
}
export const statesQuiet = { quietMs: 1_000, capMs: 15_000, enterMs: 3_000 } satisfies StatesQuiet;
/** How many states one replay acts in at most. */
export const maximumStateVisits = 12;

export interface SignInStatesReplayInput<
  E extends YieldableError = YieldableError,
  V extends string = string,
  L extends AutofillLogin = AutofillLogin,
> extends Omit<AutofillReplayInput<E, V, L>, "recipe" | "onScreen"> {
  readonly library: SignInStates;
  /** The login's own picks as its last replay gave them back (`choices` of a signed-in outcome). */
  readonly choices?: SignInStatesChoices | undefined;
  /**
   * The method that orders known states sharing a look where the login's own picks name none, such
   * as the one its caller asked for or the one it saved. It picks nothing among a page's methods
   * itself, though a state it ranks first may press its recorded method there.
   */
  readonly rankMethod?: SignInMethodChoice | undefined;
  /** The page as a state, as `observeSignInState` reads it. */
  readonly observe: Effect.Effect<ObservedState | undefined, E>;
  readonly quiet?: StatesQuiet | undefined;
  /**
   * Where a value-free replay on this browser stopped for the login's values (`stop`), for this
   * replay with them to go on from: it opens no entry URL when the page still shows that state, one
   * the login's own route takes (`stillShown`), and otherwise opens it as any replay does. Absent,
   * the replay opens it.
   */
  readonly from?: SignInStatesStop | undefined;
  /**
   * Whether a code state whose recorded boxes never show, on a page that shows its look, has the
   * code typed by place into the row of code boxes the page shows instead (`byPlace`), as by
   * default; false for a caller that goes on from the page itself, as a build's or repair's minter
   * does, so the page is left for it to record.
   */
  readonly codeRowByPlace?: boolean | undefined;
  /**
   * Whether the replay goes on from the page as it is (in place), for a session already signed in
   * that a later stage of the site, or a pop-up a page of the session opened, asks for the login
   * again (a step-up). It opens no entry URL and starts only in a known state the page shows
   * (`shownHere`) that leads to a marker the page does not show yet (`leadsToNewMarker`), else
   * ends `state_not_shown` having done nothing, or at once with the origin
   * rule's refusal of a state that shows. Only a marker the states it acted in led to, and that
   * the page did not show before it acted, signs it in (`markersNow`), checked on the page as it
   * is, and never a page that can't tell. A state in a pop-up is told by its controls there
   * (`inPopup`). The login's own picks come back as they were given. Absent, the replay opens the
   * entry URL as before.
   */
  readonly inPlace?: boolean | undefined;
}

/**
 * Where a value-free replay stopped for the login's values: the states it acted in, the last the
 * one it stopped in (`state`), and the page as read when it reached the state before, if it acted
 * in one, which the state's look was told against (`stateAfter`).
 */
export interface SignInStatesStop {
  readonly visited: readonly string[];
  readonly state: string;
  readonly before?: ObservedState | undefined;
}

/**
 * How a replay from states ended: as a recipe's replay ends, with the states it acted in
 * (`visited`) and, once signed in, the login's picks to keep (`choices`). At a state no one knows
 * it fails with `unknown_state`, `unclear` when anything may have reached the site, else `unsent`,
 * and `unknownState`: the state's fingerprint and value-free description, the known state it came
 * from (`after`), whether anything may have been sent (`sent`), the replay's own sign-in
 * (`signIn`), which a repair on the same browser goes on from: a call, so the outcome itself holds
 * no typed value and logs none; and, for a log, the page's shape, a part of its path only where a
 * stored page's path has it, and those of the stored states on its origin with or without boxes as
 * it is, at most eight, the newest first (`shapes`). A value-free replay that stopped in a state it
 * reached, for the login's values, gives where (`stop`), a call too, as the page it read stays out
 * of the outcome. A replay given `from` says whether it went on from there (`fromStop`), or why not.
 */
export type SignInStatesOutcome<V extends string = string> = AutofillReplayOutcome<V> & {
  readonly visited: readonly string[];
  readonly choices?: SignInStatesChoices;
  readonly stop?: () => SignInStatesStop;
  readonly fromStop?: { readonly continued: true } | { readonly continued: false; readonly reason: string };
  readonly unknownState?: {
    readonly fingerprint: StateFingerprint;
    readonly description: string;
    readonly after?: string;
    readonly sent: boolean;
    readonly signIn: () => AutofillSignInState;
    readonly shapes?: {
      readonly observed: FingerprintShape;
      readonly stored: readonly (FingerprintShape & { readonly key: string })[];
    };
  };
};

interface Run<E extends YieldableError, V extends string, L extends AutofillLogin> {
  readonly input: SignInStatesReplayInput<E, V, L>;
  readonly as: AutofillReplayInput<E, V, L>;
  readonly replay: Replay<E, V, L>;
  readonly quiet: StatesQuiet;
  readonly markers: readonly SignedInEntry[];
  readonly visited: string[];
  /**
   * The one look again this replay gives a state whose fill failed before anything was sent, or
   * Enter in place of a submit that went once its identifiers were typed.
   */
  gone: boolean;
  /** The states whose site's answer the host gave. */
  readonly answered: Set<string>;
  /** The page's address as the last marker check read it, for an unknown state's shape. */
  page: string | undefined;
  /** The page's look as last read, and the known state of that look whose controls did not show. */
  seen: StateFingerprint | undefined;
  missing: string | undefined;
  /**
   * For each state taking a private answer that this replay acted in, the page's message and its
   * question (`questionOf`) each time it reached that state, held in memory alone.
   */
  readonly asked: Map<string, { readonly message?: string | undefined; readonly question?: string | undefined }[]>;
  /**
   * Whether the method picked last is the host's hint (`rankMethod`) as a lone method beside a way
   * in, for a login that names no method of its own, in a state the hint may have ranked first: it
   * is never stored as a pick (`choices.method`); the route that signed in is kept as any route is.
   */
  hinted: boolean;
  /**
   * The origin rule's refusal of a known state whose controls showed, at the look matched last
   * (`admitScreen`): the page is a sign-in on a host this login may not type on.
   */
  admission: string | undefined;
  /**
   * In place (`inPlace`), the markers the page showed before the replay acted, which tell nothing
   * of a step-up's own sign-in (`markersNow`).
   */
  readonly shownBefore: Set<string>;
}

/**
 * A known state the page shows, told by its control and address alone (`byControl`), with its
 * code typed by place into the row the page shows (`byPlace`), learned after the login's own state
 * of its look whose box is gone (`newer`, `matchState`), or as recorded.
 */
type Shown = {
  readonly state: StateEntry;
  readonly inspection: AutofillInspection;
  readonly by?: "control" | "row" | "newer";
};
type Ended<V extends string> = { readonly ended: SignInStatesOutcome<V> };
/**
 * What the state just acted in, showing again, asks of the replay: its press once more
 * (`repress`), a new code for a code it refused (`code`), or the emailed link the site's own answer
 * says it sent (`link`).
 */
type Again =
  | { readonly again: "repress" }
  | { readonly again: "code"; readonly explicit: boolean }
  | { readonly again: "link" };
const isAgain = (value: object): value is Again => "again" in value;
/** The state a replay last acted in, and the page as read when it reached it. */
type Acted = {
  readonly acted: StateEntry;
  readonly reached: ObservedState;
  /**
   * The press it made with nothing typed and no method picked, where no state it leads to takes a
   * code or an approval, which a page that kept the state gets once more.
   */
  readonly press?: AutofillStep;
  /** Its press picked a method the site sends something by: a text, a call, an email or a push. */
  readonly sends?: true;
  /** The state's controls went before anything was sent: it is looked for once more. */
  readonly gone?: true;
};

const now = Clock.currentTimeMillis;
const pause = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) => Effect.sleep(Duration.millis(run.replay.timing.pollMs));

/** The step a state's recorded step resolves to for this login, with how it submits. */
const resolved = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  step: AutofillRecipeStep,
): AutofillStep => ({
  ...run.replay.resolve({ fields: step.fields, ...screenSubmit(step) }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
});

/**
 * The step a state acts with (`resolved`), with the dismiss of the newest look-alike a sign-in
 * learned that only adds one to it (`addsDismiss`): a notice that came to cover the state for one
 * login covers it for every login, and a fill clicks it only where the page shows it. The state
 * keeps its key, its route and what it leads to.
 */
const actedStep = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
): AutofillStep => {
  const full = resolved(run, state.step);
  const dismiss = run.input.library.states.findLast((other) => addsDismiss(other, state))?.step.dismiss;
  return dismiss === undefined ? full : { ...full, dismiss };
};

/**
 * Whether each control, and each frame above it, sits on the state's top origin, its recorded
 * origin or a frame its boxes were read on, named as the scan names them (`workspace`).
 */
const onStateFrames = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  inspection: AutofillInspection,
) => {
  const parent = run.input.library.workspace?.parent;
  const { siteOrigin, targets } = inspection;
  const named = (origin: string) =>
    parent !== undefined && origin !== siteOrigin && workspaceHost(siteOrigin, parent, origin)
      ? "workspace"
      : origin;
  const fingerprint = state.fingerprint;
  const allowed = new Set([
    fingerprint.top,
    state.step.origin === "workspace" ? "workspace" : named(urlOrigin(state.step.page)),
    ...fingerprint.boxes.map((box) => box.frame),
  ]);
  return [...targets.fields, ...(targets.submit === null ? [] : [targets.submit])].every((target) =>
    [urlOrigin(target.ownerUrl ?? inspection.page), ...(target.ancestors ?? [])].every((origin) =>
      allowed.has(named(origin)),
    ),
  );
};

/**
 * A step's controls found on the page and admitted on the state's recorded origin, each on a frame
 * of the state (`onStateFrames`), or why not.
 */
const shownOn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  step: AutofillStep,
) =>
  Effect.gen(function* () {
    const inspection = yield* run.input.hooks.inspect(step);
    if ("outcome" in inspection) return inspection.reason;
    if (!onStateFrames(run, state, inspection)) return "screen_origin_changed" as const;
    if (placed.has(state) && step.fields.length > 0 && !(yield* placedRow(run, state, inspection)))
      return "ambiguous_match" as const;
    const refused = yield* admitScreen(run.as, run.replay, state.step, inspection.page, inspection);
    if (refused !== undefined) run.admission = refused;
    return refused ?? inspection;
  });

/** The states whose code is typed by place (`byPlace`). */
const placed = new WeakSet<StateEntry>();

/**
 * A code state's row as its look holds it: one code box with a count, a row of one-character
 * boxes (`row`), else as many code boxes as it shows.
 */
const codeRowOf = (state: StateEntry) => {
  const { boxes } = state.fingerprint;
  const row = boxes.length === 1 && boxes[0]?.count !== undefined;
  return { row, count: row ? (boxes[0]?.count ?? 0) : boxes.length };
};

/**
 * Whether a state typed by place shows its row as taken: each field the next box of the row, none
 * labelled for a PIN, a social security number or a date (`isCodeRowByPlace`), and no box at the
 * place after it, as a box the scan does not count, such as one drawn transparent, would put every
 * character a box over.
 */
const placedRow = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  inspection: AutofillInspection,
) =>
  Effect.gen(function* () {
    const { row, count } = codeRowOf(state);
    if (!isCodeRowByPlace(inspection.screen.fields, count, row)) return false;
    const after = yield* run.input.hooks.inspect({ fields: codeRowFields(count + 1, row).slice(count) });
    return "outcome" in after && after.reason === "not_found";
  });

/**
 * `shownOn` within the step wait: controls not found yet, as on a page that redraws, are looked
 * for again as a recipe screen's are; any other refusal stands at once.
 */
const shownWithin = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  step: AutofillStep,
) =>
  Effect.gen(function* () {
    const until = (yield* now) + run.replay.timing.stepWaitMs;
    for (;;) {
      const shown = yield* shownOn(run, state, step);
      if (shown !== "not_found" || (yield* now) >= until) return shown;
      yield* pause(run);
    }
  });

/** Whether a known state has the whole look `look`, its step telling what its boxes take (`Look`). */
const looksLike = (look: Look) => (state: StateEntry) => sameFingerprint(state, look);

/**
 * Whether a state's step takes a private answer and its look holds no words of the page's message,
 * which may hold its question (`noteSignInState`): none, or its shape alone.
 */
const untold = (state: StateEntry) => !/\p{L}/u.test(state.fingerprint.message ?? "") && takesPrivateAnswer(state);

/** Whether a state's step takes a private answer. */
const takesPrivateAnswer = (state: StateEntry) =>
  state.step.fields.some((field) => "slot" in field && field.slot === "private_answer");

/** Whether a known state has the look `look`, one noted without its question (`untold`) whatever its message. */
const lookedFor = (state: StateEntry, look: StateFingerprint) =>
  untold(state)
    ? sameFingerprint({ ...state, fingerprint: { ...state.fingerprint, message: undefined } }, { ...look, message: undefined })
    : sameFingerprint(state, look);

/**
 * A state's look, one noted without its question (`untold`) with the message the page showed when
 * this replay last reached it, as a look noted with that question reads.
 */
const seenLook = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
): { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep } => {
  if (!untold(state)) return state;
  const { message: _shape, ...look } = state.fingerprint;
  const message = run.asked.get(state.key)?.at(-1)?.message;
  return { fingerprint: message === undefined ? look : { ...look, message }, step: state.step };
};

/**
 * The questions a step's private-answer fields show, as its inspection read them by their recorded
 * selectors, else their labels; undefined where one shows neither.
 */
const questionOf = (inspection: AutofillInspection) => {
  const questions = inspection.screen.fields
    .filter((field) => field.slot === "private_answer")
    .map((field) => field.questionText ?? (field.label || undefined));
  return questions.every((question) => question !== undefined) ? JSON.stringify(questions) : undefined;
};

/** Whether a page asks a question (`questionOf`) this replay answered, as a site asks after a wrong answer. */
const askedBefore = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  inspection: AutofillInspection,
) => {
  const question = questionOf(inspection);
  return question !== undefined && [...run.asked.values()].flat().some((visit) => visit.question === question);
};

/**
 * A state noted without its question (`untold`) that the page shows, of its look whatever the
 * page's message (`lookedFor`), in the order this login takes them (`ranked`), one this replay has
 * not acted in or that the sign-in learned to come after the state acted in last (`next`), whose
 * controls show on its recorded origin and whose question (`questionOf`) is none this replay
 * answered; one whose question can't be read only while it answered none. Its refusals count for
 * nothing, so a page no state is still ends as an unknown state.
 */
const askedHere = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
  next: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const told = (state: StateEntry) =>
      untold(state) &&
      lookedFor(state, fingerprint) &&
      (!run.visited.includes(state.key) || next.has(state.key)) &&
      (after !== undefined || run.input.inPlace !== true || leadsToNewMarker(run, state));
    const answered = [...run.asked.values()].flat().map((visit) => visit.question);
    for (const state of ranked(run, run.input.library.states.filter(told), told, next, fingerprint)) {
      const shown = yield* shownOn(run, state, resolved(run, state.step));
      if (typeof shown === "string") continue;
      const question = questionOf(shown);
      if (question === undefined ? answered.length === 0 : !answered.includes(question))
        return { state, inspection: shown } satisfies Shown;
    }
    return undefined;
  });

/**
 * In place (`inPlace`), whether a state sits in a pop-up, where it is told by its controls there:
 * the page read is the one that opened it, which tells nothing of the pop-up.
 */
const inPopup = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) => run.input.inPlace === true && state.step.popup !== undefined;

/**
 * The markers that may sign the replay in: each one, or in place (`inPlace`) only those the
 * states it acted in led to, through the states after them, and the page did not show before it
 * acted (`shownBefore`), so a page signed in already, as a step-up's is, never ends it, nor does
 * the marker of another sign-in.
 */
const markersNow = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) => {
  if (run.input.inPlace !== true) return run.markers;
  const reached = new Set(run.visited);
  const queue = [...reached];
  for (const at of queue)
    for (const { from, to } of run.input.library.transitions)
      if (from === at && !reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
  return run.markers.filter((marker) => reached.has(marker.key) && !run.shownBefore.has(marker.key));
};

/**
 * In place (`inPlace`), whether a state leads, through the states after it, to a marker the page
 * did not show before the replay acted (`shownBefore`): only such a state is acted in at the
 * start, so a step-up page that looks like a state of the site's own sign-in, whose marker shows
 * there already, has nothing typed into it.
 */
const leadsToNewMarker = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) => {
  const markers = new Set(run.markers.filter((marker) => !run.shownBefore.has(marker.key)).map((marker) => marker.key));
  const reached = new Set([state.key]);
  const queue = [state.key];
  for (const at of queue)
    for (const { from, to } of run.input.library.transitions)
      if (from === at && !reached.has(to)) {
        if (markers.has(to)) return true;
        reached.add(to);
        queue.push(to);
      }
  return false;
};

/**
 * A marker verified in full; in place (`inPlace`) on the page as it is, its account page
 * (`openPath`) never opened, as the task's page must stay.
 */
const verifyMarker = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  marker: SignedInEntry,
) =>
  run.replay.verify(
    run.input.inPlace === true
      ? {
          ...(marker.selector === undefined ? {} : { selector: marker.selector }),
          ...(marker.urlPath === undefined ? {} : { urlPath: marker.urlPath }),
        }
      : marker,
  );

/** `matchState`'s refusal where none of the login's own states shows, as an unknown state. */
const ownStateNotShown = "own_state_not_shown";

/**
 * Known states that share one look (`alike`), in the order this login takes them. Where its
 * own route, the states it last signed in through (`choices.states`), holds a state with that look
 * besides the one it last acted in, unless that one is looked for again, only its own are taken,
 * in their order there from the last state it acted in that the route holds, then the earlier ones:
 * a login never goes on along another login's route, so one whose own state no longer shows stops
 * there, for a repair of its own, but where a box its own state types is gone and a look-alike
 * learned after it shows by the step wait (`matchState`). Otherwise first a state whose picked
 * method is the login's (`choices.method`, else `rankMethod`), then one the last state led to, or
 * at the start one no state leads to (`next`), then the most recently learned, as a library holds
 * its states in the order learned. Given the page's look (`page`), a state whose recorded instruction and ways stand
 * further from the page's than another's do (`toldApart`) goes after the rest, next after the
 * login's own route; one recorded without them is never moved by them. In place (`inPlace`), the
 * route takes no part, as a step-up is no part of the login's own sign-in.
 */
const ranked = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  candidates: readonly StateEntry[],
  alike: (state: StateEntry) => boolean,
  next: ReadonlySet<string> = new Set(),
  page?: StateFingerprint,
) => {
  const route = run.input.choices?.states ?? [];
  const method = run.input.choices?.method ?? run.input.rankMethod;
  const { states } = run.input.library;
  // The state last acted in, when it is not looked for again, leaves the route no say: where its
  // page stays, the route goes no further there, so a look-alike a repair learned after it may go on.
  const last = run.visited.at(-1);
  // In place, the route is the login's own sign-in's, of which a step-up is no part.
  const own =
    run.input.inPlace !== true &&
    states.some(
      (state) => (state.key !== last || candidates.includes(state)) && route.includes(state.key) && alike(state),
    );
  const picks = (state: StateEntry) =>
    method !== undefined && state.step.methods?.find((option) => option.selector === state.step.submit)?.method === method;
  // Along the route from the last state acted in that it holds, so a look the route holds twice
  // goes on, after a page of another login's too.
  const at = route.indexOf([...run.visited].reverse().find((key) => route.includes(key)) ?? "");
  const along = (state: StateEntry) => {
    const index = route.indexOf(state.key);
    return index > at ? index - at : route.length + index;
  };
  const told = (state: StateEntry) => (page === undefined ? undefined : toldApart(state.fingerprint, page));
  const nearest = Math.min(...candidates.flatMap((state) => told(state) ?? []));
  const order = (state: StateEntry) => [
    own ? along(state) : 0,
    Number((told(state) ?? nearest) > nearest),
    Number(!picks(state)),
    Number(!next.has(state.key)),
    -states.indexOf(state),
  ];
  return candidates
    .filter((state) => !own || route.includes(state.key))
    .map((state) => ({ state, by: order(state) }))
    .sort((a, b) => {
      const at = a.by.findIndex((value, index) => value !== b.by[index]);
      return at < 0 ? 0 : (a.by[at] ?? 0) - (b.by[at] ?? 0);
    })
    .map(({ state }) => state);
};

/**
 * Whether the page shows again, after something went out, a state acted in: `state` itself, or
 * a look-alike of one acted in whose own recorded controls show now, as a recording that names the
 * same control by another selector or picks another method does. It is never acted in again.
 */
const returnedTo = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) =>
  Effect.gen(function* () {
    if (!run.replay.progress.anythingSent && run.replay.sent.maySent.size === 0) return false;
    for (const other of run.input.library.states) {
      if (!run.visited.includes(other.key) || !sameFingerprint(other, state)) continue;
      if (other === state) return true;
      if (typeof (yield* shownOn(run, other, resolved(run, other.step))) !== "string") return true;
    }
    return false;
  });

/** Whether a state's step types a password or identifier this replay saw go out. */
const typesSent = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) =>
  resolved(run, state.step).fields.some(
    (field) => (field.slot === "password" || isIdentifier(field.slot)) && run.replay.sent.seenSent(field.slot),
  );

/**
 * The states a sign-in learned to come after `after` that this replay has not acted in: a page
 * that looks like one acted in, where a sign-in learned another step, is that state, not the one
 * acted in come back. Never one that would type again a password or identifier that went out
 * (`typesSent`), nor one that may have the site send something again: a press alone that may send
 * a code or link (`sendsOnPress`), a method choice or an approval; and none after an approval,
 * whose page stays while the owner answers.
 */
const learnedNext = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  after: StateEntry | undefined,
) => {
  if (after?.step.approval !== undefined) return [];
  const next = new Set(
    run.input.library.transitions.filter((t) => t.from === after?.key).map((t) => t.to),
  );
  return run.input.library.states.filter(
    (state) =>
      next.has(state.key) &&
      !run.visited.includes(state.key) &&
      !typesSent(run, state) &&
      state.step.approval === undefined &&
      state.step.methods === undefined &&
      (resolved(run, state.step).fields.length > 0 || !sendsOnPress(run, state)),
  );
};

/**
 * The host's challenge look (`gate`), heard as `challenge_look`: `cleared`, `none`, or the
 * replay's end at a challenge the host can't clear (`challenge_unsolved`).
 */
const lookForChallenge = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  gate: NonNullable<SignInStatesReplayInput<E, V, L>["hooks"]["challenge"]>,
  look: "early" | "deadline",
) =>
  Effect.gen(function* () {
    const challenge = yield* gate;
    yield* run.input.emit({ stage: "challenge_look", look, outcome: challenge?.outcome ?? "none" });
    if (challenge === undefined) return "none" as const;
    if (challenge.outcome === "cleared") return "cleared" as const;
    run.replay.progress.challenge = challenge.vendor;
    return stopped(run, "challenge_unsolved", { challenge: challenge.vendor });
  });

/**
 * The first learned look-alike of the state just acted in (`learnedNext`) that the page is, or in
 * place one in a pop-up (`inPopup`), and whose controls show, in the order this login takes them
 * (`ranked`): one that types something once the page settled (`typing`), and a press alone only at
 * the step wait where that state's own press would be made once more (`pressing`), in its place, as
 * before then it may answer that press, still under way; never one that presses that state's own
 * control, as that press would go out once more after it.
 */
const learnedAlike = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  after: StateEntry,
  fingerprint: StateFingerprint,
  allowed: { readonly typing: boolean; readonly pressing: boolean; readonly sent: boolean },
) =>
  Effect.gen(function* () {
    const told = (state: StateEntry) => sameFingerprint(fingerprint, state) || inPopup(run, state);
    const learned = learnedNext(run, after).filter(told);
    for (const next of ranked(run, learned, told, undefined, fingerprint)) {
      const types = resolved(run, next.step).fields.length > 0;
      if (!(types ? allowed.typing : allowed.pressing && next.step.submit !== after.step.submit)) continue;
      // After a press that may have had a code or link sent (`sent`), one that takes no code and
      // whose own press may have one sent could have the site send a second.
      if (types && allowed.sent && !takesCodeIn(run, next) && sendsOnPress(run, next)) continue;
      const shown = yield* shownOn(run, next, resolved(run, next.step));
      if (typeof shown !== "string") return { state: next, inspection: shown } satisfies Shown;
    }
    return undefined;
  });

/**
 * Whether a state may be told by its control and address alone (`byControl`): it shows no box and
 * presses one recorded control on an absolute page, typing nothing, with no method, choice,
 * approval or pop-up, and its press has the site send nothing the library knows of
 * (`sendsOnPress`), so taking it never has anything sent twice.
 */
const pressesOnly = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) => {
  const { fingerprint, step } = state;
  return (
    fingerprint.boxes.length === 0 &&
    step.origin !== "workspace" &&
    step.submit !== undefined &&
    step.fields.length === 0 &&
    step.methods === undefined &&
    step.choice === undefined &&
    step.approval === undefined &&
    step.popup === undefined &&
    !sendsOnPress(run, state)
  );
};

/** Whether two absolute URLs share their host and path. */
const sameAddress = (a: string, b: string) => {
  const left = URL.parse(a);
  const right = URL.parse(b);
  return left !== null && right !== null && left.host === right.host && left.pathname === right.pathname;
};
/**
 * Whether an absolute URL has no hash: a control's inspection reads its page's origin and path
 * alone, so it can never confirm a hash route.
 */
const hashless = (url: string) => URL.parse(url)?.hash === "";

/**
 * Where no known state has the page's whole look, the known state a page with no box is by the
 * control it presses, as one page shows other labels in another browser or place, while nothing
 * this sign-in typed may have reached the site: a state that presses only (`pressesOnly`), with
 * the page's top origin and main message, at the host and path the last marker check read
 * (`page`), neither address with a hash, and, on the page of the state just acted in, one that
 * state led to; never the state just acted in nor one acted in that came back (`returnedTo`).
 * They are taken in the order this login takes states of one look (`ranked`), so a route that
 * holds one there besides the state last acted in takes only its own: the first whose control
 * shows, one match on its recorded origin, on a page at its recorded host and path whose live
 * address, as the inspection read it, has no hash either. With no address read, none.
 */
const byControl = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
  skip: StateEntry | undefined,
  next: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const { page } = run;
    if (
      fingerprint.boxes.length > 0 ||
      page === undefined ||
      !hashless(page) ||
      mayHaveSent(run) ||
      run.replay.sent.maySent.size > 0
    )
      return undefined;
    const stayed = after !== undefined && sameAddress(page, after.step.page);
    // Each state here counts for the login's own route, one that came back too, as `ranked` reads
    // it, which leaves out the state last acted in as it does for a look.
    const here = (state: StateEntry) =>
      state.fingerprint.top === fingerprint.top &&
      state.fingerprint.message === fingerprint.message &&
      pressesOnly(run, state) &&
      hashless(state.step.page) &&
      sameAddress(page, state.step.page) &&
      (!stayed || next.has(state.key));
    const pressing: StateEntry[] = [];
    for (const state of run.input.library.states)
      if (state !== skip && here(state) && !(yield* returnedTo(run, state))) pressing.push(state);
    for (const state of ranked(run, pressing, here, next)) {
      const inspection = yield* shownOn(run, state, resolved(run, state.step));
      // The live address as the inspection read it, whose hash a host's marker check may leave out.
      if (
        typeof inspection !== "string" &&
        inspection.url !== undefined &&
        hashless(inspection.url) &&
        sameAddress(inspection.page, state.step.page)
      )
        return { state, inspection, by: "control" } satisfies Shown;
    }
    return undefined;
  });

/**
 * A code state of the page's look whose recorded boxes never showed (`missing`, in the order this
 * login takes them), with its code typed by place into the row of code boxes the page shows
 * instead: the first whose step types a code alone, one character a box, into as many fields as
 * its look's one row of code boxes in one frame holds, two or more, as its own step with the row's
 * fields (`codeRowFields`), once they show on its frames and pass its origin rule as that row, at
 * this and every later look (`shownOn`, `placedRow`). Its own submit, Enter or the page's own send
 * then goes as recorded.
 */
const byPlace = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  missing: readonly StateEntry[],
) =>
  Effect.gen(function* () {
    for (const state of missing) {
      const { boxes } = state.fingerprint;
      const { row, count } = codeRowOf(state);
      if (
        count < 2 ||
        state.step.fields.length !== count ||
        !state.step.fields.every((field) => "slot" in field && field.slot === "code") ||
        !boxes.every((box) => box.kind === "code" && box.frame === boxes[0]?.frame)
      )
        continue;
      const typed: StateEntry = { ...state, step: { ...state.step, fields: codeRowFields(count, row) } };
      placed.add(typed);
      const shown = yield* shownOn(run, typed, resolved(run, typed.step));
      if (typeof shown !== "string") return { state: typed, inspection: shown, by: "row" } satisfies Shown;
    }
    return undefined;
  });

/**
 * The known state the page shows: one whose fingerprint it is and whose recorded controls show,
 * one match each, on its recorded origin, in the order this login takes them (`ranked`), never
 * the state just acted in again; in place, one in a pop-up (`inPopup`) that no state leads to, or
 * that `after` led to, whatever the look. A state acted in before something went out that the
 * page shows again, with no other, is `returned`, unless a sign-in learned it after the last one
 * (`learnedNext`). With `loose`, states of its look none of whose recorded controls showed may be a
 * code state typed by place into the row the page shows (`byPlace`); with no state of its whole
 * look, a page with no box may be a state told by its control and address alone (`byControl`);
 * its refusals count for nothing, so a page no state is still ends as an unknown state. Where none
 * shows and the origin rule refused one whose controls showed (`admission`), that refusal
 * (`refusedOrigin`). A state noted without its question (`untold`) is taken so only on a page with
 * no message, and else, or acted in again, apart, before one that came back (`askedHere`). None is
 * taken where the page asks a question this replay answered (`askedBefore`). Where the login's own
 * route left other logins' states out and none of its own shows by the step wait (`waited`), for a
 * box its own state types that is gone, as one the site renamed, a look-alike learned after its
 * own that types too, presses the same submit and picks no method is taken in its place, the first
 * whose controls show in the order a login with no route there takes them (`newer`). On a page of
 * code boxes the press just made had the site send a code to (`sent`), the code goes in first: a
 * state that types no code is taken only where that press led, and, with `loose`, a state that
 * types a code into the boxes the page shows counts whatever its text, as one recorded for another
 * method does.
 */
const matchState = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
  skip: StateEntry | undefined,
  loose: boolean,
  waited = false,
  sent = false,
) =>
  Effect.gen(function* () {
    const { states, transitions } = run.input.library;
    run.admission = undefined;
    // At the start, the states no state leads to, as a recorded sign-in's first.
    const next = new Set(
      after === undefined
        ? states.filter((state) => !transitions.some((t) => t.to === state.key)).map((state) => state.key)
        : transitions.filter((t) => t.from === after.key).map((t) => t.to),
    );
    const learned = learnedNext(run, after);
    const codeSent = sent && fingerprint.boxes.some((box) => box.kind === "code");
    // In place, a state in a pop-up where the route leads is told by its controls, not the look.
    const told = (state: StateEntry) =>
      ((sameFingerprint(state, fingerprint) && (fingerprint.message === undefined || !untold(state))) ||
        (inPopup(run, state) && next.has(state.key)) ||
        (codeSent && loose && takesCodeIn(run, state) && sameBoxes(state, fingerprint))) &&
      (after !== undefined || run.input.inPlace !== true || leadsToNewMarker(run, state));
    const candidates = states.filter(
      (state) => state !== skip && told(state) && (!codeSent || next.has(state.key) || takesCodeIn(run, state)),
    );
    const alike = ranked(run, candidates, told, next, fingerprint);
    let refused: string | undefined;
    let returned: StateEntry | undefined;
    const missing: StateEntry[] = [];
    for (const state of alike) {
      if (!learned.includes(state) && (yield* returnedTo(run, state))) {
        returned ??= state;
        continue;
      }
      const shown = yield* shownOn(run, state, resolved(run, state.step));
      if (typeof shown !== "string") {
        if (askedBefore(run, shown)) continue;
        return { state, inspection: shown } satisfies Shown;
      }
      refused ??= shown;
      if (shown === "not_found") missing.push(state);
    }
    const asked = yield* askedHere(run, fingerprint, after, next);
    if (asked !== undefined) return asked;
    if (returned !== undefined) return { returned: returned as StateEntry };
    if (run.admission !== undefined) return { refusedOrigin: run.admission };
    if (missing[0] !== undefined) run.missing = missing[0].key;
    if (loose && refused === "not_found" && run.input.codeRowByPlace !== false) {
      const row = yield* byPlace(run, missing);
      if (row !== undefined) return row;
    }
    // Where the login's own route left other logins' states out, none of its own showing by the
    // step wait is a page it does not know, for a repair of its own to go on from, unless a box its
    // own state types is gone, as one the site renamed, and a look-alike learned after its own
    // that types too, presses the same submit and picks no method shows then. A page that lost
    // only a press, such as a method's, keeps to the route, as does another form drawn in place of
    // its own, whose submit is its own.
    if (alike.length < candidates.length && refused === "not_found") {
      const [first] = alike;
      const lost = waited && first !== undefined ? yield* run.input.hooks.inspect(resolved(run, first.step)) : undefined;
      if (lost !== undefined && "outcome" in lost && lost.reason === "not_found" && typeof lost.target === "number") {
        const own = Math.max(...alike.map((state) => states.indexOf(state)));
        const newer = candidates.filter(
          (state) =>
            states.indexOf(state) > own &&
            state.step.submit === first?.step.submit &&
            state.step.methods === undefined &&
            resolved(run, state.step).fields.length > 0,
        );
        for (const state of ranked(run, newer, (other) => newer.includes(other), next, fingerprint)) {
          const shown = yield* shownOn(run, state, resolved(run, state.step));
          if (typeof shown !== "string" && !askedBefore(run, shown))
            return { state, inspection: shown, by: "newer" } satisfies Shown;
        }
      }
      return ownStateNotShown;
    }
    return candidates.length > 0 || !loose ? refused : yield* byControl(run, fingerprint, after, skip, next);
  });

const signedIn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  marker: SignedInEntry,
): Ended<V> => {
  const { replay, visited } = run;
  const method = (run.hinted ? undefined : replay.progress.chosen) ?? run.input.choices?.method;
  // In place, the route is a step-up's, never the login's own: its picks go back as given.
  const choices: SignInStatesChoices | undefined =
    run.input.inPlace === true
      ? run.input.choices
      : { states: [...new Set(visited)], ...(method === undefined ? {} : { method }), signedIn: marker.key };
  const sent = replay.progress.anythingSent;
  return {
    ended: {
      outcome: "signed_in",
      ...(sent
        ? { alreadySignedIn: false, loginProved: submittedLoginProof(replay.state) }
        : { alreadySignedIn: true }),
      ...workspaceOf(replay),
      visited,
      ...(choices === undefined ? {} : { choices }),
    } as SignInStatesOutcome<V>,
  };
};

/** Whether anything this replay typed may have reached the site. */
const mayHaveSent = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  run.replay.progress.anythingSent ||
  run.replay.state.submittedSlots.size > 0 ||
  run.replay.state.filled.size > 0;

/** A replay's end, `unclear` once anything it typed may have reached the site, as a press may. */
const stopped = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  reason: string,
  more: object = {},
): Ended<V> => ({
  ended: {
    ...run.replay.outcome(reason),
    ...(mayHaveSent(run) ? { outcome: "unclear" as const } : {}),
    ...more,
    visited: run.visited,
  } as SignInStatesOutcome<V>,
});

/** How many stored states an unknown state's shapes hold at most. */
const shapesStored = 8;

const unknownState = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
): Ended<V> => {
  const sent = mayHaveSent(run);
  const boxed = (shown: StateFingerprint) => shown.boxes.length > 0;
  const stored = run.input.library.states
    .filter((state) => state.fingerprint.top === fingerprint.top && boxed(state.fingerprint) === boxed(fingerprint))
    .slice(-shapesStored)
    .reverse()
    .map((state) => ({ key: state.key, ...fingerprintShape(state.fingerprint, state.step.page) }));
  return {
    ended: {
      outcome: sent ? "unclear" : "unsent",
      reason: "unknown_state",
      visited: run.visited,
      unknownState: {
        fingerprint,
        description: describeFingerprint(fingerprint),
        ...(after === undefined ? {} : { after: after.key }),
        sent,
        signIn: () => run.replay.state,
        shapes: {
          observed: fingerprintShape(fingerprint, run.page, run.input.library.states.map((state) => state.step.page)),
          stored,
        },
      },
    },
  };
};

/**
 * For a log, a replay that ended `not_found`: the known state whose controls did not show, else
 * the one it acted in last, and the page's look as last read, as an unknown state's is shaped.
 */
const notFound = <E extends YieldableError, V extends string, L extends AutofillLogin>(run: Run<E, V, L>) => {
  const state = run.missing ?? run.visited.at(-1);
  const { states } = run.input.library;
  return run.input.emit({
    stage: "state_not_found",
    ...(state === undefined ? {} : { state }),
    ...(run.seen === undefined
      ? {}
      : { shape: fingerprintShape(run.seen, run.page, states.map((known) => known.step.page)) }),
  });
};

/**
 * A signed-in marker that may sign the replay in (`markersNow`) on the page as it is, checked
 * without opening anything, then verified in full (`verifyMarker`); a marker that shows but fails
 * the full check, with no other that passes, stops the replay.
 */
const signedInHere = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    let failed = false;
    for (const marker of markersNow(run)) {
      const onPage = { selector: marker.selector, urlPath: marker.urlPath };
      if (onPage.selector === undefined && onPage.urlPath === undefined) continue;
      const check = yield* input.hooks.check(onPage, run.as.recipe.steps, replay.state.steps);
      run.page = check.url;
      if (!check.signedIn) continue;
      if (yield* verifyMarker(run, marker)) return signedIn(run, marker);
      failed = true;
    }
    return failed ? stopped(run, "sign_in_check_failed") : undefined;
  });

/**
 * Before a replay ends at a state no one knows, or with none shown, the recipe replay's last
 * check: each marker that may sign it in verified in full (`markersNow`, `verifyMarker`), opening
 * its account page save in place, then the host's look at a page that can't tell
 * (`alreadySignedIn`, `endedCantTell`). Never while the state just acted in still stands, or the
 * page shows a password or code box, as no signed-in page does: a repair goes on from that page as
 * it is. Before the step wait ran out (`waitedOut`), the can't-tell look keeps the early guard
 * (`mayCantTell`).
 */
const endCheck = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  observed: ObservedState | undefined,
  stood: boolean,
  last: StateEntry | undefined,
  waitedOut: boolean,
) =>
  Effect.gen(function* () {
    const { replay } = run;
    if (stood || observed?.boxes.some((box) => box.kind === "password" || box.kind === "code"))
      return undefined;
    for (const marker of markersNow(run)) if (yield* verifyMarker(run, marker)) return signedIn(run, marker);
    const marker = run.markers[0];
    if (marker === undefined || run.input.hooks.confirmCantTell === undefined || !mayCantTell(run, last, !waitedOut))
      return undefined;
    if (!replay.progress.anythingSent) {
      const already = yield* alreadySignedIn(run.as, replay, undefined);
      return already.outcome === "signed_in"
        ? ({ ended: { ...signedIn(run, marker).ended, ...already } } as Ended<V>)
        : undefined;
    }
    return (yield* replay.endedCantTell(undefined)) ? cantTellEnd(run, marker) : undefined;
  });

/**
 * Whether a page that can't tell may sign in, as the recipe replay's screen wait decides
 * (`landedCantTell`): never in place (`inPlace`), as a task's page can't tell; never on a browser
 * that started empty before a password or code of the library went in (`loginUnproved`), nor
 * `early`, before the step wait ends, after a state whose press leads to a code or an approval, as
 * a code screen's wait never ends so; at its end a site may have skipped its code, as the recipe
 * replay's settle allows.
 */
const mayCantTell = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  last: StateEntry | undefined,
  early: boolean,
) => {
  const { hooks, library } = run.input;
  if (run.input.inPlace === true) return false;
  const unproved =
    hooks.startedEmpty === true &&
    hooks.signedInBefore !== true &&
    !run.replay.progress.ran.some((step) => step.fields.some((field) => provesLogin(field.slot))) &&
    library.states.some((state) => state.step.fields.some((field) => "slot" in field && provesLogin(field.slot)));
  return !unproved && (!early || last === undefined || !sendsOnPress(run, last));
};

/** Signed in on a page that can't tell, as the host confirmed (`endedCantTell`). */
const cantTellEnd = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  marker: SignedInEntry,
) => ({ ended: { ...signedIn(run, marker).ended, cantTell: true } }) as Ended<V>;

const rejection = (slot: string) =>
  slot === "password" ? "password_rejected" : slot === "code" ? "code_rejected" : "username_rejected";

/** Whether a state's step takes a code. */
const takesCodeIn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) => resolved(run, state.step).fields.some((field) => field.slot === "code");

/**
 * The site's own answer to a state whose password or identifier went out and that shows again, as
 * the host reads it (`hosted.siteAnswer`), as the recipe replay reads it for a credential screen
 * that came back: never once an emailed link was asked for, never for a state that takes a code,
 * and once per state at most.
 */
const siteAnswer = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) =>
  Effect.gen(function* () {
    const { replay } = run;
    const read = run.input.hosted?.siteAnswer;
    const fields = resolved(run, state.step).fields;
    if (
      read === undefined ||
      replay.progress.linkAsked ||
      replay.state.steps.some((step) => step.approval === "email_link") ||
      run.answered.has(state.key) ||
      fields.some((field) => field.slot === "code") ||
      !fields.some(
        (field) => (field.slot === "password" || isIdentifier(field.slot)) && replay.sent.seenSent(field.slot),
      )
    )
      return undefined;
    const said = yield* read();
    if (said !== undefined) run.answered.add(state.key);
    return said;
  });

/**
 * The recorded error markers that show now of the states this replay acted in, as the recipe
 * replay reads its screens' while it waits (`screenRejection`), kept for the outcome.
 */
const markedNow = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  Effect.gen(function* () {
    const marked = yield* markersShown(run);
    if (marked !== "unavailable" && marked.length > 0) run.replay.recordRejected(marked);
    return marked;
  });

/** The recorded error markers that show now of the states this replay acted in, read alone. */
const markersShown = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) => {
  const { replay, input } = run;
  const acted = new Set(run.visited);
  const steps = replay
    .resolvedSteps()
    .filter((_, index) => acted.has(input.library.states[index]?.key ?? ""));
  return recordedRejections(input.hooks, steps, input.correlation);
};

/**
 * Why a state acted in shows again with nothing to explain it: its password or identifier went out
 * and came back (`credential_screen_returned`), as the recipe replay names a credential screen
 * that returns, so no host sends it again; else the state itself (`state_repeated`).
 */
const returnedReason = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) => (typesSent(run, state) ? "credential_screen_returned" : "state_repeated");

/**
 * Waits for the page to show a known state after `last`, or at the start, as the recipe replay
 * waits for a screen. The marker signs in. Once anything may have gone out, a recorded error marker
 * of a state acted in stops the replay as that rejection, whatever else the page shows. A known
 * state is taken once its controls show and pass its origin rule, in the order this login takes
 * them (`ranked`); where the login's own route left another login's out, none of its own showing,
 * nor by the step wait one learned after it for a box it types that is gone (`matchState`), is an
 * unknown state; a known state whose controls show on a host the origin rule refuses for this
 * login ends it at once (`refusedOrigin`), as a recipe screen does. In place, once the controls of a
 * state acted in within a pop-up went from it, a state it led to there that shows is taken
 * (`inPopup`, `learnedAlike`). One acted in before something went out showing again stops it
 * (`returnedReason`), unless a sign-in learned a look-alike after the last (`learnedNext`) or the
 * state just acted in stands.
 * It stands while the page shows its boxes as they were, with or without a new text, or a notice
 * state's boxes beside its text, a state noted without its question read with the one it showed
 * (`seenLook`); through the step wait, as the recipe replay waits for its next
 * screen, a code state whose code went asks for a new one at its code marker or at the step wait
 * (`code`), though at the step wait, with no code marker, a locked account the site's own answer
 * names ends it at once (`account_locked`), with no code asked again; the site's own answer, read
 * once it held still and again at the step wait, opens an emailed link (`link`) or ends a refused
 * login; a page of a state that typed nothing, held still
 * `quietMs`, and `landingSettleMs` at least, with every box empty and no code marker, is a
 * look-alike learned after it that types something, or at the step wait one that presses another
 * control alone in place of the press made once more, once its controls show (`learnedAlike`) and
 * the host's challenge look found none there, for any host, the page settling again after a look
 * that cleared one; at
 * the step wait, a new text no known state has is an unknown state, else a press that typed nothing
 * and sends no code or link is made once more (`repress`), and otherwise it stops
 * (`returnedReason`), as nothing is sent twice. A box that sent itself counts as sent first
 * (`settleCarried`). A page with boxes no known state has or holds ends the replay once it held
 * still `quietMs`; a page of
 * text alone, one a known state may still grow into, or one a known state's controls have not
 * shown on, gets the whole step wait, as a slow page is no unknown state. The host's challenge
 * look runs on such a page once it held still `quietMs`, and `landingSettleMs` at least, once for
 * each page it holds, and always at the step wait's end, as at a recipe screen (`challengeLook`):
 * never early for a host that reads no page state, or where a known state sits in a pop-up. A look
 * that cleared a challenge gives the page the whole step wait again, with no look after it, and
 * each look is heard (`challenge_look`). Once the login went out, a
 * page of text alone that held still `landingSettleMs` and can't tell signs in, as at the recipe
 * replay's marker wait. Before an unknown state, or none, the recipe replay's last check runs
 * (`endCheck`).
 */
const arrive = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  last: Acted | undefined,
) =>
  Effect.gen(function* () {
    const { replay, quiet } = run;
    const after = last?.acted;
    const acted = last !== undefined && last.gone !== true ? last : undefined;
    let start = yield* now;
    let held: { readonly text: string; readonly since: number } | undefined;
    let shape: StateFingerprint | undefined;
    let observed: ObservedState | undefined;
    let refused: string | undefined;
    let stood = false;
    let challenged = false;
    const looked = new Set<string>();
    // Early looks as at a recipe screen: never for a host that reads no page state, nor where a
    // state sits in a pop-up, as the page is read on its primary tab alone.
    const lookEarly =
      run.input.hooks.pageState !== undefined &&
      !run.input.library.states.some((state) => state.step.popup !== undefined);
    let answerRead = false;
    let cantTellRead: string | undefined;
    let waitedOut = false;
    // The last look a state was looked for by its control alone (`byControl`).
    let byControlRead: string | undefined;
    for (;;) {
      const signed = yield* signedInHere(run);
      if (signed !== undefined) return signed;
      if (acted !== undefined) settleCarried(replay);
      let codeMarked = false;
      if (acted !== undefined && mayHaveSent(run)) {
        const marked = yield* markedNow(run);
        if (marked === "unavailable") return stopped(run, "ambiguous_combined_rejection");
        const first = marked[0];
        if (first !== undefined && first !== "code") return stopped(run, rejection(first));
        codeMarked = first === "code";
      }
      const read = yield* run.input.observe;
      const at = yield* now;
      stood = false;
      if (read !== undefined) {
        let back: StateEntry | undefined;
        observed = read;
        shape = acted === undefined ? read.fingerprint : stateAfter(acted.reached, read);
        run.seen = shape;
        run.missing = undefined;
        const text = fingerprintText(shape);
        if (held?.text !== text) held = { text, since: at };
        const still = at - held.since >= quiet.quietMs;
        const capped = at - start >= replay.timing.stepWaitMs;
        // One noted without its question looks as it did with the question it showed (`seenLook`).
        const look = acted === undefined ? undefined : seenLook(run, acted.acted);
        const fingerprint = look?.fingerprint;
        // A box that lost a kind it took when the state was reached is a new page, whatever the
        // state's own look says (`takesLost`).
        const moved = acted !== undefined && takesLost(acted.reached, read);
        // A page with no box that still looks as it did when its state was taken is that state,
        // as one told by its control alone (`byControl`) is.
        const again =
          acted !== undefined &&
          look !== undefined &&
          !moved &&
          (sameFingerprint(shape, look) ||
            (look.fingerprint.boxes.length === 0 && sameFingerprint(shape, acted.reached.fingerprint)) ||
            (look.fingerprint.message !== undefined &&
              look.fingerprint.boxes.length > 0 &&
              sameBoxes(shape, look) &&
              read.texts.includes(look.fingerprint.message)));
        stood =
          acted !== undefined &&
          fingerprint !== undefined &&
          !moved &&
          (again || (fingerprint.boxes.length > 0 && sameBoxes(shape, acted.acted)));
        if (!again && !blankFingerprint(shape)) {
          // A state by its control alone, once for each look that settled as for an early look,
          // and at the step wait, as a whole look may still draw.
          const loose =
            capped || (at - held.since >= Math.max(quiet.quietMs, landingSettleMs) && byControlRead !== text);
          if (loose) byControlRead = text;
          const shown = yield* matchState(run, shape, after, acted?.acted, loose, capped, acted?.sends === true);
          refused = typeof shown === "object" ? undefined : shown;
          if (typeof shown === "object") {
            // A known state on a host this login may not type on ends it at once, as at a recipe
            // screen, after the step wait's last check, which may find the login's session still good.
            if ("refusedOrigin" in shown)
              return (yield* endCheck(run, read, stood, after, false)) ?? stopped(run, shown.refusedOrigin);
            if (!("returned" in shown)) return { ...shown, observed: read };
            if (!stood) return stopped(run, returnedReason(run, shown.returned));
            back = shown.returned;
          }
        }
        if (acted !== undefined && stood) {
          const state = acted.acted;
          if (takesCodeIn(run, state) && replay.sent.maySent.has("code") && (codeMarked || capped)) {
            // The site's answer to the code: the texts the page shows that it didn't as the state showed.
            const answer = codeMarked ? undefined : run.input.hosted?.siteAnswer;
            if (answer !== undefined) {
              const said = yield* answer(read.texts.filter((text) => !acted.reached.texts.includes(text)));
              if (said === "locked") return stopped(run, "account_locked");
            }
            return { again: "code", explicit: codeMarked } satisfies Again;
          }
          if ((still && !answerRead) || capped) {
            answerRead = true;
            const said = yield* siteAnswer(run, state);
            if (said === "link") return { again: "link" } satisfies Again;
            if (said === "refused") return stopped(run, "credential_screen_returned");
          }
          // In place, a state in a pop-up stands on the page that opened it, which tells nothing:
          // once its own controls went from the pop-up, a state it led to there that shows goes on.
          if (
            inPopup(run, state) &&
            !codeMarked &&
            (yield* shownOn(run, state, resolved(run, state.step))) === "not_found"
          ) {
            const next = yield* learnedAlike(run, state, shape, {
              typing: true,
              pressing: true,
              sent: acted.sends === true || sendsOnPress(run, state, true),
            });
            if (next !== undefined) return { ...next, observed: read };
          }
          // A fresh page that settled looking like the state just acted in, a press that typed
          // nothing, with no answer of the site's to explain it, is a look-alike a sign-in learned
          // to come after it, if one shows and the host's look finds no challenge there. It settles
          // as for an early look, so a challenge drawn late shows first; a press alone waits for
          // the step wait.
          const settledHere = at - held.since >= Math.max(quiet.quietMs, landingSettleMs);
          if (
            again &&
            (settledHere || capped) &&
            !codeMarked &&
            resolved(run, state.step).fields.length === 0 &&
            state.step.approval === undefined &&
            read.boxes.every((box) => box.empty)
          ) {
            const alike = yield* learnedAlike(run, state, shape, {
              typing: settledHere,
              pressing: capped && acted.press !== undefined,
              sent: acted.sends === true || sendsOnPress(run, state, true),
            });
            const gate = challenged ? undefined : run.input.hooks.challenge;
            const challenge =
              alike === undefined || gate === undefined
                ? "none"
                : yield* lookForChallenge(run, gate, capped ? "deadline" : "early");
            if (typeof challenge === "object") return challenge;
            if (challenge === "cleared") {
              // The page settles again before a look-alike is taken, as the site may still be
              // acting on what the challenge held.
              challenged = true;
              start = yield* now;
              held = undefined;
              yield* pause(run);
              continue;
            }
            if (alike !== undefined) return { ...alike, observed: read };
          }
          if (capped) {
            if (!again && back !== undefined) return stopped(run, returnedReason(run, back));
            if (!again) break;
            return acted.press === undefined
              ? stopped(run, returnedReason(run, state))
              : ({ again: "repress" } satisfies Again);
          }
        } else if (shape.boxes.length === 0) {
          const marker = run.markers[0];
          if (
            replay.progress.anythingSent &&
            marker !== undefined &&
            at - held.since >= landingSettleMs &&
            cantTellRead !== held.text &&
            mayCantTell(run, after, true)
          ) {
            cantTellRead = held.text;
            if (yield* replay.endedCantTell(undefined)) return cantTellEnd(run, marker);
          }
        } else if (
          refused === undefined &&
          still &&
          !run.input.library.states.some((state) => containsFingerprint(shape as StateFingerprint, state))
        )
          break;
      }
      const waited = at - start >= replay.timing.stepWaitMs;
      // Held as long as a page that can't tell is before it signs in, so that check goes first.
      const settled =
        lookEarly &&
        read !== undefined &&
        !stood &&
        held !== undefined &&
        at - held.since >= Math.max(quiet.quietMs, landingSettleMs) &&
        !looked.has(held.text);
      const gate = challenged ? undefined : run.input.hooks.challenge;
      const look = waited ? "deadline" : settled ? "early" : undefined;
      if (gate !== undefined && look !== undefined) {
        if (held !== undefined) looked.add(held.text);
        const challenge = yield* lookForChallenge(run, gate, look);
        if (typeof challenge === "object") return challenge;
        if (challenge === "cleared") {
          challenged = true;
          start = yield* now;
        } else if (waited) {
          waitedOut = true;
          break;
        }
      } else if (waited) {
        waitedOut = true;
        break;
      }
      yield* pause(run);
    }
    const checked = yield* endCheck(run, observed, stood, after, waitedOut);
    if (checked !== undefined) return checked;
    if (refused === ownStateNotShown && shape !== undefined) return unknownState(run, shape, after);
    if (refused !== undefined) return stopped(run, refused);
    return shape === undefined || blankFingerprint(shape)
      ? stopped(run, "state_not_shown")
      : unknownState(run, shape, after);
  });

/**
 * After a box was typed, or while a press waits: `same` while the page shows the state's boxes,
 * grown or not, a notice state's beside its text, or, for a state told by its text alone, as one
 * whose boxes are drawn transparent, while the page still looks as the state does (`seenLook`);
 * another known state it now shows in full with what was typed (`fuller`), never one acted in
 * before something went out; or `moved` once a box of the state went. In place, a state in a pop-up
 * stays `same`, as the page read is the one that opened it (`inPopup`).
 */
const lookAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  reached: ObservedState,
) =>
  Effect.gen(function* () {
    if (inPopup(run, state)) return { kind: "same" as const, text: "" };
    const observed = yield* run.input.observe;
    if (observed === undefined) return { kind: "same" as const, text: "" };
    const shape = standingFingerprint(reached, observed);
    const text = fingerprintText(shape);
    const notice = state.fingerprint.message !== undefined && state.fingerprint.boxes.length > 0;
    // A state told by its text alone, whose boxes the look never counts, stands while the page
    // still looks as the state does.
    const toldByText =
      state.fingerprint.boxes.length === 0 && sameFingerprint(observed.fingerprint, seenLook(run, state));
    if (sameFingerprint(shape, state) || (notice && sameBoxes(shape, state)) || toldByText)
      return { kind: "same" as const, text };
    for (const other of ranked(
      run,
      run.input.library.states.filter((known) => known !== state && sameFingerprint(known, shape)),
      looksLike(shape),
    )) {
      if (yield* returnedTo(run, other)) continue;
      const shown = yield* shownOn(run, other, resolved(run, other.step));
      if (typeof shown !== "string") return { kind: "fuller" as const, state: other, observed };
    }
    return containsFingerprint(state, shape)
      ? { kind: "same" as const, text }
      : { kind: "moved" as const };
  });

/**
 * Before a press in a state another known state holds, as an email box alone that a password box
 * may join: the page gets to hold still `quietMs`, at most `capMs`, and a fuller known state it
 * draws meanwhile is taken instead.
 */
const holdStill = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  reached: ObservedState,
) =>
  Effect.gen(function* () {
    const start = yield* now;
    let held: { readonly text: string; readonly since: number } | undefined;
    for (;;) {
      const look = yield* lookAgain(run, state, reached);
      if (look.kind !== "same") return look;
      const at = yield* now;
      if (held?.text !== look.text) held = { text: look.text, since: at };
      if (at - held.since >= run.quiet.quietMs || at - start >= run.quiet.capMs) return look;
      yield* pause(run);
    }
  });

/** A state's code boxes go in as one action; every other box alone. */
const actions = (fields: AutofillStep["fields"]) =>
  fields.reduce<AutofillStep["fields"][]>((groups, field) => {
    const last = groups.at(-1);
    if (last !== undefined && field.slot === "code" && last.at(-1)?.slot === "code")
      return [...groups.slice(0, -1), [...last, field]];
    return [...groups, [field]];
  }, []);

const codeMethods: ReadonlySet<string> = new Set(["sms", "call", "email", "totp"]);
/** The methods by which the site sends something once picked: a code, or a push. */
const sendMethods: ReadonlySet<string> = new Set(["sms", "call", "email", "push"]);

/**
 * A method choice's pick, as a recipe's replay picks: the way in the recording took, a lone
 * two-factor method beside a way in, or the host's pick (`hosted.method`), else the login's own
 * (`choices.method`), else the caller's. The host's hint (`rankMethod`) picks nothing here; a lone
 * method that is the hint, in a state the hint may have ranked first, is never stored as a pick
 * (`hinted`).
 */
const methodFor = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  step: AutofillRecipeStep,
) =>
  Effect.gen(function* () {
    const methods = step.methods ?? [];
    const twoFactor = methods.filter(isTwoFactorOption);
    const own = twoFactor.find((option) => option.method === run.input.choices?.method);
    const codeOnly =
      run.input.credentials?.password === undefined &&
      twoFactor.length > 0 &&
      twoFactor.every((option) => codeMethods.has(option.method));
    const lone = twoFactor.length === 1 && twoFactor.length < methods.length ? twoFactor[0] : undefined;
    const picked =
      methods.find(
        (option) =>
          !isTwoFactorOption(option) &&
          !(codeOnly && option.method === "password") &&
          option.option === undefined &&
          option.selector === step.submit,
      ) ??
      lone ??
      (own === undefined
        ? yield* run.replay.pickMethod(twoFactor)
        : ((yield* run.input.hosted?.method?.(twoFactor) ?? Effect.succeed(undefined)) ?? own));
    if (isTwoFactorOption(picked)) {
      run.replay.progress.chosen = picked.method;
      run.hinted =
        picked === lone && run.input.choices?.method === undefined && picked.method === run.input.rankMethod;
    }
    return picked;
  });

/**
 * An approval off the page, as the recipe replay asks for one: the emailed link the caller pastes
 * where the recording says so (`delivery: "paste"`), else the link or a device's request, confirmed.
 */
const approve = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  inspection: AutofillInspection,
) =>
  Effect.gen(function* () {
    const { replay, input, as } = run;
    const step = state.step;
    settleCarried(replay);
    if (![...replay.state.submittedSlots].some(isIdentifier))
      return stopped(run, "identifier_not_submitted");
    const popup = step.popup === undefined ? {} : { popup: step.popup };
    if (step.approval === "email_link" && step.delivery === "paste") {
      const opened = yield* openPastedLink(as, inspection);
      if (opened !== "opened") return stopped(run, opened);
      replay.state.steps.push({ page: inspection.page, fields: [], approval: "email_link", delivery: "paste", ...popup });
      return undefined;
    }
    const number =
      step.approval === "device"
        ? yield* approvalNumber(input.hooks, step.matchSelector, inspection.page, step.popup)
        : undefined;
    const answer = yield* askOne(input, {
      id: "approved",
      type: "confirm",
      prompt:
        step.approval === "email_link"
          ? `Open the sign-in link ${input.site} emailed you, then confirm here.`
          : withApprovalNumber(
              `Approve the sign-in request ${input.site} sent to your device, then confirm here.`,
              number,
            ),
    });
    if (answer?.type !== "confirm" || !answer.value.confirmed)
      return stopped(run, "approval_declined");
    replay.state.steps.push({
      page: inspection.page,
      fields: [],
      approval: step.approval === "email_link" ? "email_link" : "device",
      ...(step.matchSelector === undefined ? {} : { matchSelector: step.matchSelector }),
      ...popup,
    });
    return undefined;
  });

/**
 * A hand-off state, once it shows, as at the recipe replay's hand-off screen: a replay that may
 * not hand off (`handOff`) stops there for values (`valuesNeeded`); one that may asks the person
 * one `browser_handoff` question, with no values, and then only a marker that may sign it in and
 * verifies (`markersNow`, `verifyMarker`) does so (`handedOff`), never a page that can't tell;
 * else it ends `handoff_not_signed_in`.
 */
const handOff = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  inspection: AutofillInspection,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    if (input.handOff !== true) return stopped(run, valuesNeeded);
    const done = yield* askOne(input, {
      id: "signed_in",
      type: "browser_handoff",
      prompt: handOffPrompt(input.site),
      show_inputs: [],
    });
    if (done?.type !== "browser_handoff") return stopped(run, "approval_declined");
    replay.state.steps.push({ page: inspection.page, fields: [], approval: "handoff" });
    for (const marker of markersNow(run))
      if (yield* verifyMarker(run, marker))
        return {
          ended: { ...signedIn(run, marker).ended, alreadySignedIn: false, loginProved: false, handedOff: true },
        } as Ended<V>;
    return stopped(run, "handoff_not_signed_in");
  });

/**
 * Whether a state's press may have the site send a code or link: a state it led to takes one or an
 * approval other than a hand-off, which the site sends nothing for, or one it led to through states
 * that take nothing, as a "code sent" page before the code's box; never through a method choice,
 * whose own pick has the site send, so a press that only opens the choice sends nothing.
 * With `alone`, never through a state with its look, which is another press on its page, such as
 * one another sign-in learned there.
 */
const sendsOnPress = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  alone = false,
) => {
  const { states, transitions } = run.input.library;
  const seen = new Set([state.key]);
  const queue = [state.key];
  for (const from of queue)
    for (const { to } of transitions.filter((t) => t.from === from && !seen.has(t.to))) {
      seen.add(to);
      const next = states.find((other) => other.key === to);
      if (next === undefined) continue;
      if (
        (next.step.approval !== undefined && next.step.approval !== "handoff") ||
        next.step.fields.some((field) => "slot" in field && field.slot === "code")
      )
        return true;
      const pressOnly = next.step.fields.length === 0 && next.step.methods === undefined;
      if (pressOnly && !(alone && sameFingerprint(next, state))) queue.push(to);
    }
  return false;
};

/**
 * Acts in a shown state, one action at a time, and looks at the page after each: each box typed
 * alone (a code's boxes together, with the state's recorded `refills`), then its press. A fuller
 * known state the page shows after a box or while a press waits (`holdStill`) is taken, keeping
 * what was typed. A fill that failed with nothing yet sent, as when the page redrew its form under
 * it, has the state looked for once more in the replay (`gone`), as a recipe screen gone unsent is.
 */
const actIn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  shown: Shown,
  arrival: ObservedState,
): Effect.Effect<Ended<V> | Acted, E> =>
  Effect.gen(function* () {
    const { replay, input } = run;
    let { state } = shown;
    const { inspection } = shown;
    let reached = arrival;
    const typed = new Set<AutofillSlot>();
    const acted = (press?: AutofillStep, picked?: NonNullable<AutofillRecipeStep["methods"]>[number]): Acted => ({
      acted: state,
      reached,
      ...(press === undefined || typed.size > 0 || state.step.methods !== undefined || sendsOnPress(run, state)
        ? {}
        : { press }),
      ...(picked !== undefined && isTwoFactorOption(picked) && sendMethods.has(picked.method)
        ? { sends: true as const }
        : {}),
    });
    for (;;) {
      const step = state.step;
      // Before the value-free stop, as a hand-off takes no value.
      if (step.approval === "handoff") return yield* handOff(run, inspection);
      if (
        replay.valueFree &&
        (step.fields.length > 0 ||
          step.approval !== undefined ||
          step.methods !== undefined ||
          sendsOnPress(run, state))
      )
        return stopped(run, valuesNeeded);
      if (step.choice !== undefined && !(input.hosted?.allowedChoices ?? []).includes(step.choice))
        return stopped(run, "sign_in_choice_not_allowed", { choice: step.choice });
      if (step.approval !== undefined) return (yield* approve(run, state, inspection)) ?? acted();
      const full = actedStep(run, state);
      let fuller: { readonly state: StateEntry; readonly observed: ObservedState } | undefined;
      const groups = actions(full.fields.filter((field) => !typed.has(field.slot)));
      for (const [index, fields] of groups.entries()) {
        const keyed = index === groups.length - 1 && full.submitKey !== undefined;
        const typing: AutofillStep = {
          fields,
          ...(full.popup === undefined ? {} : { popup: full.popup }),
          ...(full.dismiss === undefined ? {} : { dismiss: full.dismiss }),
          ...(full.rejectedMarkers === undefined ? {} : { rejectedMarkers: full.rejectedMarkers }),
          ...(keyed ? { submitKey: full.submitKey } : {}),
        };
        const here = yield* shownWithin(run, state, typing);
        if (typeof here === "string") return stopped(run, here);
        const failed = yield* replay.runStep(typing, here, undefined, false, undefined, step.refills ?? []);
        if (failed !== undefined) {
          if (run.gone || replay.progress.anythingSent || replay.sent.maySent.size > 0)
            return stopped(run, failed);
          run.gone = true;
          yield* input.emit({ stage: "retried", reason: "screen_gone" });
          return { acted: state, reached, gone: true };
        }
        for (const field of fields) typed.add(field.slot);
        if (keyed) {
          replay.progress.anythingSent = true;
          input.sent.current = true;
          noteExactSent(replay, step, full, here);
          return acted();
        }
        const look = yield* lookAgain(run, state, reached);
        if (look.kind === "moved") return acted();
        if (look.kind === "fuller") {
          fuller = look;
          break;
        }
      }
      if (fuller === undefined && hostSubmits(full)) {
        if (input.library.states.some((other) => containsFingerprint(state, other))) {
          const look = yield* holdStill(run, state, reached);
          if (look.kind === "moved") return acted();
          if (look.kind === "fuller") fuller = look;
        }
      }
      if (fuller !== undefined) {
        // The fuller state as if reached now, with what this replay typed still to count as new.
        if (run.visited.length >= maximumStateVisits) return stopped(run, "state_limit");
        yield* input.emit({ stage: "state", state: fuller.state.key, reason: "fuller_state" });
        state = fuller.state;
        reached = { ...reached, fingerprint: state.fingerprint, texts: fuller.observed.texts };
        run.visited.push(state.key);
        continue;
      }
      if (!hostSubmits(full)) {
        if (groups.length > 0) yield* enterAfterTyping(run, state, full, reached, false);
        return acted();
      }
      const method = step.methods === undefined ? undefined : yield* methodFor(run, step);
      const press: AutofillStep = {
        fields: [],
        ...screenSubmit(full),
        ...(method === undefined ? {} : { submit: method.selector }),
        ...(method?.option === undefined ? {} : { option: method.option }),
        ...(step.choice === undefined ? {} : { choice: step.choice }),
      };
      // A submit that went once the identifiers were typed, as a Continue the site turns into its
      // single sign-on control: Enter in the last field sends their form, once per replay.
      const enterInstead =
        !run.gone &&
        !replay.progress.anythingSent &&
        replay.sent.maySent.size === 0 &&
        full.fields.length > 0 &&
        full.fields.every((field) => field.slot === "email" || field.slot === "username");
      const once = yield* shownOn(run, state, press);
      const here = once === "not_found" && !enterInstead ? yield* shownWithin(run, state, press) : once;
      const failed =
        typeof here === "string" ? here : yield* replay.runStep(press, here);
      if ((failed === "not_found" || failed === "submit_refused") && enterInstead) {
        run.gone = true;
        yield* input.emit({ stage: "retried", reason: "submit_gone_after_typing" });
        const { submit: _gone, submitVia: _via, ...rest } = full;
        const keyed: AutofillStep = { ...rest, submitKey: "Enter" };
        const shown = yield* shownOn(run, state, keyed);
        if (typeof shown === "string") return stopped(run, shown);
        const enter = yield* replay.runStep(keyed, shown);
        if (enter !== undefined) return stopped(run, enter);
        replay.progress.anythingSent = true;
        input.sent.current = true;
        noteExactSent(replay, step, full, shown);
        return acted();
      }
      if (typeof here === "string") return stopped(run, here);
      if (failed !== undefined) return stopped(run, failed);
      if (typed.size > 0) {
        replay.progress.anythingSent = true;
        input.sent.current = true;
      }
      noteExactSent(replay, step, full, here);
      if (method !== undefined && replay.progress.chosen === "push") {
        const approved = yield* askOne(input, {
          id: "approved",
          type: "confirm",
          prompt: `Approve the sign-in request ${input.site} sent you, then confirm here.`,
        });
        if (approved?.type !== "confirm" || !approved.value.confirmed)
          return stopped(run, "push_declined");
      }
      return acted(press, method);
    }
  });

/**
 * After typing a state that names no submit nor submit key, whose page was to send what was typed
 * itself, as a code box that sends on its last digit, while what it typed is still held unsent:
 * once the page held, `enterMs` from the typing, the look it had then (`stateAfter`), with the
 * state's boxes and every box it typed still holding something, and no recorded error marker of a
 * state acted in shows, Enter in the last field, once, by the host's click again, which types
 * nothing (`resubmit`), as a keyed step's would. A fill that may have sent what it typed, as when
 * the page sent the code itself, gets none, however long the site takes to answer it; nor does a
 * page that moved, or could not be read, at once. Never where the host refuses the key, as for a
 * field in no form, nor where that form shows a submit control, nor on a host with no click again.
 * A press that may have gone out, and only such a press, is heard as `retried`, sends what was
 * typed, and after a code typed again (`retry`) counts as one try of the code retry bound, as a
 * submit would. The replay then waits for the next state as after any typing.
 */
const enterAfterTyping = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  step: AutofillStep,
  reached: ObservedState,
  retry: boolean,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    const { resubmit } = input.hooks;
    if (resubmit === undefined || hostSubmits(step) || step.fields.length === 0) return;
    if (!step.fields.some((field) => replay.state.filled.has(field.slot))) return;
    const since = yield* now;
    const typed = (read: ObservedState) => read.boxes.filter((box) => !box.empty).length;
    const first = yield* input.observe;
    if (first === undefined) return;
    const look = stateAfter(reached, first);
    if (!sameBoxes(look, reached.fingerprint) || typed(first) === 0) return;
    for (;;) {
      const marked = yield* markersShown(run);
      if (marked === "unavailable" || marked.length > 0) return;
      if ((yield* now) - since >= (run.quiet.enterMs ?? statesQuiet.enterMs)) break;
      yield* pause(run);
      const read = yield* input.observe;
      if (read === undefined || !sameFingerprint(stateAfter(reached, read), look) || typed(read) < typed(first))
        return;
    }
    const keyed: AutofillStep = {
      fields: step.fields,
      ...(step.popup === undefined ? {} : { popup: step.popup }),
      submitKey: "Enter",
    };
    const here = yield* shownOn(run, state, keyed);
    if (typeof here === "string" || (here.screen.submitKey?.submitControls ?? 0) > 0) return;
    const pressed = yield* resubmit({ step: keyed, inspection: here });
    const sent = maySend(pressed);
    if (sent) yield* input.emit({ stage: "retried", reason: "enter_after_typing" });
    yield* input.emit(stepDiagnostic(keyed, pressed));
    if (!sent) return;
    settleCarried(replay);
    replay.progress.anythingSent = true;
    input.sent.current = true;
    noteExactSent(replay, state.step, step, here);
    if (retry && step.fields.some((field) => field.slot === "code")) replay.codeAttempts.current += 1;
  });

/**
 * What the state just acted in, showing again, asks (`Again`): its press once more, typing nothing;
 * a new code from the caller in its code boxes, with its submit, the last code counted refused
 * whether or not the site showed a refusal, so it never goes in again, and bounded as the recipe
 * replay bounds a refused code's retries (`runStep` with `rejected`), each code typed again one try
 * even when nothing showed it went out, and a state with no submit gets its Enter
 * (`enterAfterTyping`); or the emailed link the site's answer named, pasted and opened as an
 * approval's (`openPastedLink`), once per sign-in.
 */
const actAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  last: Acted,
  again: Again,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    const state = last.acted;
    const full = actedStep(run, state);
    const step: AutofillStep =
      again.again === "repress" && last.press !== undefined
        ? last.press
        : again.again === "code"
          ? { ...full, fields: full.fields.filter((field) => field.slot === "code") }
          : { fields: [], ...(full.popup === undefined ? {} : { popup: full.popup }) };
    yield* input.emit({ stage: "retried", reason: `state_${again.again}` });
    const here = yield* shownWithin(run, state, step);
    if (typeof here === "string") return stopped(run, here);
    if (again.again === "link") {
      replay.progress.linkAsked = true;
      const opened = yield* openPastedLink(run.as, here);
      return opened === "opened" ? { acted: state, reached: last.reached } : stopped(run, opened);
    }
    if (again.again === "code") replay.recordRejected(["code"]);
    const tries = replay.codeAttempts.current;
    const failed =
      again.again === "code"
        ? yield* replay.runStep(step, here, "rejected", again.explicit)
        : yield* replay.runStep(step, here);
    if (failed !== undefined) return stopped(run, failed);
    if (again.again === "code") {
      yield* enterAfterTyping(run, state, step, last.reached, true);
      // A box that sends itself, and that the site empties, shows no send: the code still counts.
      if (replay.codeAttempts.current === tries) replay.codeAttempts.current += 1;
    }
    return { acted: state, reached: last.reached } satisfies Acted;
  });

/**
 * The state a value-free replay stopped in for values (`from`), with the page as read now, when
 * the page still shows it as that replay told it: the same look after the state before
 * (`stateAfter`, `lookedFor`), its top origin included, and its controls shown on its origin
 * (`shownOn`), at one look; else why not. Never a state that looks like one the replay acted in before it, as a
 * learned look-alike does (`state_alike`): a page gone back to that state reads the same, and only
 * `arrive`'s wait tells them apart. Nor one the login's own route leaves out where it holds a state
 * with that look (`state_not_own`), as a stop of a value-free replay given no `choices` may be.
 */
const stillShown = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  from: SignInStatesStop,
) =>
  Effect.gen(function* () {
    const { states } = run.input.library;
    const state = states.find((known) => known.key === from.state);
    if (state === undefined || from.visited.at(-1) !== from.state) return "state_unknown";
    const before = from.visited.slice(0, -1);
    if (states.some((known) => before.includes(known.key) && sameFingerprint(known, state))) return "state_alike";
    if (ranked({ ...run, visited: before }, [state], looksLike(state)).length === 0) return "state_not_own";
    const read = yield* run.input.observe;
    if (read === undefined) return "page_unread";
    const seen = stateAfter(from.before, read);
    if (!lookedFor(state, seen)) return "page_changed";
    run.seen = seen;
    if (run.input.inPlace === true && !leadsToNewMarker(run, state)) return "marker_shown_before";
    const shown = yield* shownOn(run, state, resolved(run, state.step));
    return typeof shown === "string" ? shown : { state, inspection: shown, observed: read };
  });

/**
 * In place (`inPlace`), the known state the page shows as the replay starts, in the order this
 * login takes them (`matchState`), one in a pop-up told by its controls there, and only one that
 * leads to a marker the page has not shown at any look so far (`leadsToNewMarker`): the first look one
 * shows at; else why not, the origin rule's refusal at once (`refusedOrigin`), else
 * `state_not_shown` once the page's look held still `quietMs`, or `capMs` passed.
 */
const shownHere = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  Effect.gen(function* () {
    const start = yield* now;
    let held: { readonly text: string; readonly since: number } | undefined;
    for (;;) {
      const read = yield* run.input.observe;
      const at = yield* now;
      if (read !== undefined) {
        run.seen = read.fingerprint;
        yield* noteShownBefore(run);
        const shown = yield* matchState(run, read.fingerprint, undefined, undefined, false);
        if (typeof shown === "object" && "refusedOrigin" in shown) return shown.refusedOrigin;
        if (typeof shown === "object" && !("returned" in shown)) return { ...shown, observed: read };
      }
      // A page the host can't read holds still as one look.
      const text = read === undefined ? "" : fingerprintText(read.fingerprint);
      if (held?.text !== text) held = { text, since: at };
      if (at - held.since >= run.quiet.quietMs || at - start >= run.quiet.capMs) return "state_not_shown";
      yield* pause(run);
    }
  });

/**
 * In place (`inPlace`), the markers the page shows before the replay acts (`shownBefore`): each
 * whose check passes, or fails only for a password field or a challenge's form that shows beside
 * it, as a step-up's own form does.
 */
const noteShownBefore = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  Effect.gen(function* () {
    for (const marker of run.markers) {
      const onPage = { selector: marker.selector, urlPath: marker.urlPath };
      if (onPage.selector === undefined && onPage.urlPath === undefined) continue;
      const check = yield* run.input.hooks.check(onPage, run.as.recipe.steps, run.replay.state.steps);
      // A marker that shows beside the step-up's own form fails the check for that form alone.
      if (check.signedIn || check.failed === "password_field_visible" || check.failed === "challenge_form_visible")
        run.shownBefore.add(marker.key);
    }
  });

/**
 * Replays a sign-in from a library of states on the run's own browser with the host's fill, from
 * the entry URL, or in place from the page as it is (`inPlace`): it matches the page to a known
 * state, acts there one action at a time, and waits for the next known state, until a signed-in
 * marker verifies the login, a stop rule ends it, or the page shows a state no one knows. Each box goes through the recipe replay's inspection and its
 * screen's origin rule (`admitScreen`), each value through its fill, and a secret goes out at most
 * once in a state. A recipe never runs here; this runs only for a library. Only a replay in place
 * reads a step-up's entries (`stepUp`); any other leaves them out, with every transition to or
 * from them.
 */
export const replaySignInStates = <
  E extends YieldableError,
  V extends string,
  L extends AutofillLogin,
>(
  given: SignInStatesReplayInput<E, V, L>,
): Effect.Effect<SignInStatesOutcome<V>, E> =>
  Effect.gen(function* () {
    const stepUp = new Set(
      [...given.library.states, ...given.library.signedIn].filter((entry) => entry.stepUp === true).map((entry) => entry.key),
    );
    const input =
      given.inPlace === true || stepUp.size === 0
        ? given
        : {
            ...given,
            library: {
              ...given.library,
              states: given.library.states.filter((entry) => !stepUp.has(entry.key)),
              transitions: given.library.transitions.filter((entry) => !stepUp.has(entry.from) && !stepUp.has(entry.to)),
              signedIn: given.library.signedIn.filter((entry) => !stepUp.has(entry.key)),
            },
          };
    const { library } = input;
    const picked = library.signedIn.filter((marker) => marker.key === input.choices?.signedIn);
    // The login's own marker, then the newest first, as the recipe view takes the newest.
    const markers = [...picked, ...library.signedIn.filter((marker) => !picked.includes(marker)).reverse()];
    // Every state in library order, as `markersShown` reads its steps by their place there. Not in
    // place the library holds no step-up, so this is the login's recipe with the marker it takes.
    const recipe = signInStatesStepUpRecipe(library, input.choices);
    if (recipe === undefined)
      return {
        outcome: "unsent",
        reason: "states_empty",
        visited: [],
        ...(input.from === undefined ? {} : { fromStop: { continued: false, reason: "states_empty" } }),
      } as SignInStatesOutcome<V>;
    // A library that hands off signs in only once a marker shows, never on a page that can't tell,
    // as a recipe that hands off (`markerOnly`).
    const { confirmCantTell: _cantTell, ...markerOnly } = input.hooks;
    const held = handsOffSignIn(recipe) ? { ...input, hooks: markerOnly } : input;
    const as: AutofillReplayInput<E, V, L> = { ...held, recipe };
    const run: Run<E, V, L> = {
      input: held,
      as,
      replay: makeReplay(as),
      quiet: input.quiet ?? statesQuiet,
      markers,
      visited: [],
      gone: false,
      answered: new Set(),
      page: undefined,
      seen: undefined,
      missing: undefined,
      asked: new Map(),
      hinted: false,
      admission: undefined,
      shownBefore: new Set(),
    };
    if (input.inPlace === true) yield* noteShownBefore(run);
    const from = input.from === undefined ? undefined : yield* stillShown(run, input.from);
    const here = typeof from === "object" || input.inPlace !== true ? undefined : yield* shownHere(run);
    if (typeof from === "object") run.visited.push(...(input.from?.visited ?? []).slice(0, -1));
    else if (input.inPlace !== true) yield* input.hooks.open(input.entryUrl);
    const ended =
      typeof here === "string"
        ? stopped(run, here).ended
        : yield* walk(run, typeof from === "object" ? from : here);
    if ("reason" in ended && ended.reason === "not_found") yield* notFound(run);
    return from === undefined
      ? ended
      : {
          ...ended,
          fromStop: typeof from === "string" ? { continued: false, reason: from } : { continued: true },
        };
  });

/**
 * The replay from the page it is on: each known state it shows in turn, from `first` when given,
 * as the state the page shows now. A value-free replay that stopped for values in a state it
 * reached gives where (`stop`).
 */
const walk = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  first: (Shown & { readonly observed: ObservedState }) | undefined,
) =>
  Effect.gen(function* () {
    const { input } = run;
    let last: Acted | undefined;
    let next = first;
    for (;;) {
      const arrived = next ?? (yield* arrive(run, last));
      next = undefined;
      if (isAgain(arrived)) {
        if (last === undefined) return stopped(run, "state_repeated").ended;
        const again = yield* actAgain(run, last, arrived);
        if ("ended" in again) return again.ended;
        last = again;
        continue;
      }
      if ("ended" in arrived) return arrived.ended;
      if (run.visited.length >= maximumStateVisits) return stopped(run, "state_limit").ended;
      run.visited.push(arrived.state.key);
      run.missing = undefined;
      if (takesPrivateAnswer(arrived.state))
        run.asked.set(arrived.state.key, [
          ...(run.asked.get(arrived.state.key) ?? []),
          { message: run.seen?.message, question: questionOf(arrived.inspection) },
        ]);
      yield* input.emit({
        stage: "state",
        state: arrived.state.key,
        ...("by" in arrived && arrived.by !== undefined
          ? { reason: arrived.by === "row" ? "code_row" : arrived.by === "newer" ? "newer_look_alike" : "same_control" }
          : {}),
      });
      const done = yield* actIn(run, arrived, arrived.observed);
      if ("ended" in done) return withStop(run, done.ended, arrived.state, last);
      last = done;
    }
  });

/**
 * A value-free replay's stop for values in `state`, the state it reached last, with where it
 * stopped (`stop`), the page read when it reached the state before kept unless that state's
 * controls went (`gone`), as `arrive` told `state` from it; any other end as it is.
 */
const withStop = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  ended: SignInStatesOutcome<V>,
  state: StateEntry,
  last: Acted | undefined,
): SignInStatesOutcome<V> => {
  if (
    !run.replay.valueFree ||
    ended.outcome === "signed_in" ||
    ended.reason !== valuesNeeded ||
    run.visited.at(-1) !== state.key
  )
    return ended;
  const visited = [...run.visited];
  const before = last === undefined || last.gone === true ? undefined : last.reached;
  return { ...ended, stop: () => ({ visited, state: state.key, ...(before === undefined ? {} : { before }) }) };
};
