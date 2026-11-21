import { Clock, Duration, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { AutofillRecipeStep } from "../destinations/autofill-recipe.js";
import type { SignInMethodChoice } from "../destinations/autofill-contracts.js";
import { urlOrigin } from "../destinations/autofill-refusal.js";
import {
  type AutofillInspection,
  type AutofillSlot,
  type AutofillStep,
  hostSubmits,
} from "../destinations/autofill-step.js";
import {
  blankFingerprint,
  containsFingerprint,
  describeFingerprint,
  type FingerprintShape,
  fingerprintShape,
  fingerprintText,
  type ObservedState,
  sameBoxes,
  sameFingerprint,
  type SignedInEntry,
  type SignInStates,
  type SignInStatesChoices,
  signInStatesRecipe,
  standingFingerprint,
  stateAfter,
  type StateEntry,
  type StateFingerprint,
} from "../destinations/sign-in-states.js";
import type { AutofillSignInState } from "./autofill-state.js";
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
  valuesNeeded,
} from "./autofill-replay-steps.js";
import { admitScreen, noteExactSent } from "./autofill-replay-workspace.js";
import { isIdentifier, provesLogin, screenSubmit, submittedLoginProof } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";
import { workspaceHost } from "./workspace-origin.js";

// A sign-in replayed from a library of states, never from a recipe: the page is looked at again
// after each action, typing one box or pressing, and each state it shows is matched to a known one
// and handled as recorded there. It reuses the recipe replay's own pieces for values, fills,
// origins and the signed-in check, so every box typed passes the same checks.

/**
 * How long a press waits for the page to hold still, and at most, when the state it is in may
 * still grow into another known state.
 */
export interface StatesQuiet {
  readonly quietMs: number;
  readonly capMs: number;
}
export const statesQuiet: StatesQuiet = { quietMs: 1_000, capMs: 15_000 };
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
   * as the one its caller asked for or the one it saved; it picks nothing at a method choice.
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
  /**
   * Whether the method picked last is the host's hint (`rankMethod`) as a lone method beside a way
   * in, in a state the hint may have ranked first: it is never stored as a pick (`choices.method`)
   * unless the login named it; the route that signed in is kept as any route is.
   */
  hinted: boolean;
}

/** A known state the page shows, told by its control and address alone (`byControl`) or not. */
type Shown = {
  readonly state: StateEntry;
  readonly inspection: AutofillInspection;
  readonly by?: "control";
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
    const refused = yield* admitScreen(run.as, run.replay, state.step, inspection.page, inspection);
    return refused ?? inspection;
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

/** Whether a known state has the whole look `fingerprint`. */
const looksLike = (fingerprint: StateFingerprint) => (state: StateEntry) =>
  sameFingerprint(state.fingerprint, fingerprint);

/** `matchState`'s refusal where none of the login's own states shows, as an unknown state. */
const ownStateNotShown = "own_state_not_shown";

/**
 * Known states that share one look (`alike`), in the order this login takes them. Where its
 * own route, the states it last signed in through (`choices.states`), holds a state with that look
 * besides the one it last acted in, unless that one is looked for again, only its own are taken,
 * in their order there from the last state it acted in that the route holds, then the earlier ones:
 * a login never goes on along another login's route, so one whose own state no longer shows stops
 * there, for a repair of its own. Otherwise first a state whose picked method is the login's
 * (`choices.method`, else `rankMethod`), then one the last state led to, or at the start one no
 * state leads to (`next`), then the most recently learned, as a library holds its states in the
 * order learned.
 */
const ranked = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  candidates: readonly StateEntry[],
  alike: (state: StateEntry) => boolean,
  next: ReadonlySet<string> = new Set(),
) => {
  const route = run.input.choices?.states ?? [];
  const method = run.input.choices?.method ?? run.input.rankMethod;
  const { states } = run.input.library;
  // The state last acted in, when it is not looked for again, leaves the route no say: where its
  // page stays, the route goes no further there, so a look-alike a repair learned after it may go on.
  const last = run.visited.at(-1);
  const own = states.some(
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
  const order = (state: StateEntry) => [
    own ? along(state) : 0,
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
      if (!run.visited.includes(other.key) || !sameFingerprint(other.fingerprint, state.fingerprint)) continue;
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
 * The first learned look-alike of the state just acted in (`learnedNext`) that the page is and
 * whose controls show, in the order this login takes them (`ranked`): one that types something
 * once the page settled (`typing`), and a press alone only at the step wait where that state's own
 * press would be made once more (`pressing`), in its place, as before then it may answer that
 * press, still under way; never one that presses that state's own control, as that press would go
 * out once more after it.
 */
const learnedAlike = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  after: StateEntry,
  fingerprint: StateFingerprint,
  allowed: { readonly typing: boolean; readonly pressing: boolean; readonly sent: boolean },
) =>
  Effect.gen(function* () {
    const learned = learnedNext(run, after).filter((state) => sameFingerprint(fingerprint, state.fingerprint));
    for (const next of ranked(run, learned, looksLike(fingerprint))) {
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
 * The known state the page shows: one whose fingerprint it is and whose recorded controls show,
 * one match each, on its recorded origin, in the order this login takes them (`ranked`), never
 * the state just acted in again. A state acted in before something went out that the
 * page shows again, with no other, is `returned`, unless a sign-in learned it after the last one
 * (`learnedNext`). With no state of its whole look, and `loose`, a page with no box may be a
 * state told by its control and address alone (`byControl`); its refusals count for nothing, so a
 * page no state is still ends as an unknown state.
 */
const matchState = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
  skip: StateEntry | undefined,
  loose: boolean,
) =>
  Effect.gen(function* () {
    const { states, transitions } = run.input.library;
    // At the start, the states no state leads to, as a recorded sign-in's first.
    const next = new Set(
      after === undefined
        ? states.filter((state) => !transitions.some((t) => t.to === state.key)).map((state) => state.key)
        : transitions.filter((t) => t.from === after.key).map((t) => t.to),
    );
    const learned = learnedNext(run, after);
    const candidates = states.filter(
      (state) => state !== skip && sameFingerprint(state.fingerprint, fingerprint),
    );
    const alike = ranked(run, candidates, looksLike(fingerprint), next);
    let refused: string | undefined;
    let returned: StateEntry | undefined;
    for (const state of alike) {
      if (!learned.includes(state) && (yield* returnedTo(run, state))) {
        returned ??= state;
        continue;
      }
      const shown = yield* shownOn(run, state, resolved(run, state.step));
      if (typeof shown !== "string") return { state, inspection: shown } satisfies Shown;
      refused ??= shown;
    }
    if (returned !== undefined) return { returned: returned as StateEntry };
    // Where the login's own route left other logins' states out, none of its own showing by the
    // step wait is a page it does not know, for a repair of its own to go on from.
    if (alike.length < candidates.length && refused === "not_found") return ownStateNotShown;
    return candidates.length > 0 || !loose ? refused : yield* byControl(run, fingerprint, after, skip, next);
  });

const signedIn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  marker: SignedInEntry,
): Ended<V> => {
  const { replay, visited } = run;
  const method = (run.hinted ? undefined : replay.progress.chosen) ?? run.input.choices?.method;
  const choices: SignInStatesChoices = {
    states: [...new Set(visited)],
    ...(method === undefined ? {} : { method }),
    signedIn: marker.key,
  };
  const sent = replay.progress.anythingSent;
  return {
    ended: {
      outcome: "signed_in",
      ...(sent
        ? { alreadySignedIn: false, loginProved: submittedLoginProof(replay.state) }
        : { alreadySignedIn: true }),
      ...workspaceOf(replay),
      visited,
      choices,
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
 * A signed-in marker on the page as it is, checked without opening anything, then verified in
 * full; a marker that shows but fails the full check, with no other that passes, stops the replay.
 */
const signedInHere = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    let failed = false;
    for (const marker of run.markers) {
      const onPage = { selector: marker.selector, urlPath: marker.urlPath };
      if (onPage.selector === undefined && onPage.urlPath === undefined) continue;
      const check = yield* input.hooks.check(onPage, run.as.recipe.steps, replay.state.steps);
      run.page = check.url;
      if (!check.signedIn) continue;
      if (yield* replay.verify(marker)) return signedIn(run, marker);
      failed = true;
    }
    return failed ? stopped(run, "sign_in_check_failed") : undefined;
  });

/**
 * Before a replay ends at a state no one knows, or with none shown, the recipe replay's last
 * check: each marker verified in full, opening its account page, then the host's look at a page
 * that can't tell (`alreadySignedIn`, `endedCantTell`). Never while the state just acted in still
 * stands, or the page shows a password or code box, as no signed-in page does: a repair goes on
 * from that page as it is. Before the step wait ran out (`waitedOut`), the can't-tell look keeps
 * the early guard (`mayCantTell`).
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
    for (const marker of run.markers) if (yield* replay.verify(marker)) return signedIn(run, marker);
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
 * (`landedCantTell`): never on a browser that started empty before a password or code of the
 * library went in (`loginUnproved`), nor `early`, before the step wait ends, after a state whose
 * press leads to a code or an approval, as a code screen's wait never ends so; at its end a site
 * may have skipped its code, as the recipe replay's settle allows.
 */
const mayCantTell = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  last: StateEntry | undefined,
  early: boolean,
) => {
  const { hooks, library } = run.input;
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
    const { replay, input } = run;
    const acted = new Set(run.visited);
    const steps = replay
      .resolvedSteps()
      .filter((_, index) => acted.has(input.library.states[index]?.key ?? ""));
    const marked = yield* recordedRejections(input.hooks, steps, input.correlation);
    if (marked !== "unavailable" && marked.length > 0) replay.recordRejected(marked);
    return marked;
  });

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
 * them (`ranked`); where the login's own route left another login's out, none of its own showing
 * is an unknown state. One acted in before something went out showing again stops it
 * (`returnedReason`), unless a sign-in learned a look-alike after the last (`learnedNext`) or the
 * state just acted in stands.
 * It stands while the page shows its boxes as they were, with or without a new text, or a notice
 * state's boxes beside its text; through the step wait, as the recipe replay waits for its next
 * screen, a code state whose code went asks for a new one at its code marker or at the step wait
 * (`code`); the site's own answer, read once it held still and again at the step wait, opens an
 * emailed link (`link`) or ends a refused login; a page of a state that typed nothing, held still
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
        const text = fingerprintText(shape);
        if (held?.text !== text) held = { text, since: at };
        const still = at - held.since >= quiet.quietMs;
        const capped = at - start >= replay.timing.stepWaitMs;
        const fingerprint = acted?.acted.fingerprint;
        // A page with no box that still looks as it did when its state was taken is that state,
        // as one told by its control alone (`byControl`) is.
        const again =
          fingerprint !== undefined &&
          (sameFingerprint(shape, fingerprint) ||
            (acted !== undefined &&
              fingerprint.boxes.length === 0 &&
              sameFingerprint(shape, acted.reached.fingerprint)) ||
            (fingerprint.message !== undefined &&
              fingerprint.boxes.length > 0 &&
              sameBoxes(shape, fingerprint) &&
              read.texts.includes(fingerprint.message)));
        stood =
          fingerprint !== undefined &&
          (again || (fingerprint.boxes.length > 0 && sameBoxes(shape, fingerprint)));
        if (!again && !blankFingerprint(shape)) {
          // A state by its control alone, once for each look that settled as for an early look,
          // and at the step wait, as a whole look may still draw.
          const loose =
            capped || (at - held.since >= Math.max(quiet.quietMs, landingSettleMs) && byControlRead !== text);
          if (loose) byControlRead = text;
          const shown = yield* matchState(run, shape, after, acted?.acted, loose);
          refused = typeof shown === "object" ? undefined : shown;
          if (typeof shown === "object") {
            if (!("returned" in shown)) return { ...shown, observed: read };
            if (!stood) return stopped(run, returnedReason(run, shown.returned));
            back = shown.returned;
          }
        }
        if (acted !== undefined && stood) {
          const state = acted.acted;
          if (takesCodeIn(run, state) && replay.sent.maySent.has("code") && (codeMarked || capped))
            return { again: "code", explicit: codeMarked } satisfies Again;
          if ((still && !answerRead) || capped) {
            answerRead = true;
            const said = yield* siteAnswer(run, state);
            if (said === "link") return { again: "link" } satisfies Again;
            if (said === "refused") return stopped(run, "credential_screen_returned");
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
          !run.input.library.states.some((state) => containsFingerprint(shape as StateFingerprint, state.fingerprint))
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
 * grown or not, a notice state's beside its text; another known state it now shows in full with
 * what was typed (`fuller`), never one acted in before something went out; or `moved` once a box
 * of the state went.
 */
const lookAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  reached: ObservedState,
) =>
  Effect.gen(function* () {
    const observed = yield* run.input.observe;
    if (observed === undefined) return { kind: "same" as const, text: "" };
    const shape = standingFingerprint(reached, observed);
    const text = fingerprintText(shape);
    const notice = state.fingerprint.message !== undefined && state.fingerprint.boxes.length > 0;
    if (sameFingerprint(shape, state.fingerprint) || (notice && sameBoxes(shape, state.fingerprint)))
      return { kind: "same" as const, text };
    for (const other of ranked(
      run,
      run.input.library.states.filter(
        (known) => known !== state && sameFingerprint(known.fingerprint, shape),
      ),
      looksLike(shape),
    )) {
      if (yield* returnedTo(run, other)) continue;
      const shown = yield* shownOn(run, other, resolved(run, other.step));
      if (typeof shown !== "string") return { kind: "fuller" as const, state: other, observed };
    }
    return containsFingerprint(state.fingerprint, shape)
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
 * A method choice's pick: the login's own (`choices.method`), else the way in the recording took,
 * a lone two-factor method beside a way in, or the host's or caller's pick, as a recipe's replay
 * picks. The host's hint (`rankMethod`) picks nothing here; a lone method that is the hint, in a
 * state the hint may have ranked first, is never stored as a pick (`hinted`).
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
      own ??
      methods.find(
        (option) =>
          !isTwoFactorOption(option) &&
          !(codeOnly && option.method === "password") &&
          option.option === undefined &&
          option.selector === step.submit,
      ) ??
      lone ??
      (yield* run.replay.pickMethod(twoFactor));
    if (isTwoFactorOption(picked)) {
      run.replay.progress.chosen = picked.method;
      run.hinted = picked === lone && picked.method === run.input.rankMethod;
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
 * Whether a state's press may have the site send a code or link: a state it led to takes one, or
 * one it led to through states that take nothing, as a "code sent" page before the code's box.
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
        next.step.approval !== undefined ||
        next.step.fields.some((field) => "slot" in field && field.slot === "code")
      )
        return true;
      if (next.step.fields.length === 0 && !(alone && sameFingerprint(next.fingerprint, state.fingerprint)))
        queue.push(to);
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
      if (step.approval === "handoff") return stopped(run, "unsupported_state");
      if (step.approval !== undefined) return (yield* approve(run, state, inspection)) ?? acted();
      const full = resolved(run, step);
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
        if (input.library.states.some((other) => containsFingerprint(state.fingerprint, other.fingerprint))) {
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
      if (!hostSubmits(full)) return acted();
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
 * What the state just acted in, showing again, asks (`Again`): its press once more, typing nothing;
 * a new code from the caller in its code boxes, with its submit, bounded as the recipe replay bounds
 * a refused code's retries (`runStep` with `rejected`); or the emailed link the site's answer
 * named, pasted and opened as an approval's (`openPastedLink`), once per sign-in.
 */
const actAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  last: Acted,
  again: Again,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    const state = last.acted;
    const full = resolved(run, state.step);
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
    const failed =
      again.again === "code"
        ? yield* replay.runStep(step, here, "rejected", again.explicit)
        : yield* replay.runStep(step, here);
    if (failed !== undefined) return stopped(run, failed);
    return { acted: state, reached: last.reached } satisfies Acted;
  });

/**
 * The state a value-free replay stopped in for values (`from`), with the page as read now, when
 * the page still shows it as that replay told it: the same look after the state before
 * (`stateAfter`), its top origin included, and its controls shown on its origin (`shownOn`), at
 * one look; else why not. Never a state that looks like one the replay acted in before it, as a
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
    if (states.some((known) => before.includes(known.key) && sameFingerprint(known.fingerprint, state.fingerprint)))
      return "state_alike";
    if (ranked({ ...run, visited: before }, [state], looksLike(state.fingerprint)).length === 0) return "state_not_own";
    const read = yield* run.input.observe;
    if (read === undefined) return "page_unread";
    if (!sameFingerprint(stateAfter(from.before, read), state.fingerprint)) return "page_changed";
    const shown = yield* shownOn(run, state, resolved(run, state.step));
    return typeof shown === "string" ? shown : { state, inspection: shown, observed: read };
  });

/**
 * Replays a sign-in from a library of states on the run's own browser with the host's fill, from
 * the entry URL: it matches the page to a known state, acts there one action at a time, and waits
 * for the next known state, until a signed-in marker verifies the login, a stop rule ends it, or
 * the page shows a state no one knows. Each box goes through the recipe replay's inspection and its
 * screen's origin rule (`admitScreen`), each value through its fill, and a secret goes out at most
 * once in a state. A recipe never runs here; this runs only for a library.
 */
export const replaySignInStates = <
  E extends YieldableError,
  V extends string,
  L extends AutofillLogin,
>(
  input: SignInStatesReplayInput<E, V, L>,
): Effect.Effect<SignInStatesOutcome<V>, E> =>
  Effect.gen(function* () {
    const { library } = input;
    const picked = library.signedIn.filter((marker) => marker.key === input.choices?.signedIn);
    // The login's own marker, then the newest first, as the recipe view takes the newest.
    const markers = [...picked, ...library.signedIn.filter((marker) => !picked.includes(marker)).reverse()];
    const recipe = signInStatesRecipe(library, input.choices);
    if (recipe === undefined)
      return {
        outcome: "unsent",
        reason: "states_empty",
        visited: [],
        ...(input.from === undefined ? {} : { fromStop: { continued: false, reason: "states_empty" } }),
      } as SignInStatesOutcome<V>;
    const as: AutofillReplayInput<E, V, L> = { ...input, recipe };
    const run: Run<E, V, L> = {
      input,
      as,
      replay: makeReplay(as),
      quiet: input.quiet ?? statesQuiet,
      markers,
      visited: [],
      gone: false,
      answered: new Set(),
      page: undefined,
      hinted: false,
    };
    const from = input.from === undefined ? undefined : yield* stillShown(run, input.from);
    if (from === undefined || typeof from === "string") yield* input.hooks.open(input.entryUrl);
    else run.visited.push(...(input.from?.visited ?? []).slice(0, -1));
    const ended = yield* walk(run, typeof from === "object" ? from : undefined);
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
      yield* input.emit({
        stage: "state",
        state: arrived.state.key,
        ...("by" in arrived ? { reason: "same_control" } : {}),
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
