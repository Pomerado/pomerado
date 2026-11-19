import { Clock, Duration, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { AutofillRecipeStep } from "../destinations/autofill-recipe.js";
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
  fingerprintText,
  type ObservedState,
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
import { approvalNumber, openPastedLink, withApprovalNumber } from "./autofill-replay-approval.js";
import { makeReplay, type Replay, workspaceOf } from "./autofill-replay-session.js";
import {
  askOne,
  type AutofillReplayInput,
  type AutofillReplayOutcome,
  isTwoFactorOption,
  valuesNeeded,
} from "./autofill-replay-steps.js";
import { admitScreen, noteExactSent } from "./autofill-replay-workspace.js";
import { isIdentifier, isSecret, screenSubmit, submittedLoginProof } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";

// A sign-in replayed from a library of states, never from a recipe: the page is looked at again
// after each action, typing one box or pressing, and each state it shows is matched to a known one
// and handled as recorded there. It reuses the recipe replay's own pieces for values, fills,
// origins and the signed-in check, so every box typed passes the same checks.

/**
 * How long a press waits for the page to hold still, and at most, when the state it is in may
 * still grow into another known state; and how long the page may show the same state after a
 * press before the replay stops there.
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
> extends Omit<AutofillReplayInput<E, V, L>, "recipe"> {
  readonly library: SignInStates;
  /** The login's own picks as its last replay gave them back (`choices` of a signed-in outcome). */
  readonly choices?: SignInStatesChoices | undefined;
  /** The page as a state, as `observeSignInState` reads it. */
  readonly observe: Effect.Effect<ObservedState | undefined, E>;
  readonly quiet?: StatesQuiet | undefined;
}

/**
 * How a replay from states ended: as a recipe's replay ends, with the states it acted in
 * (`visited`) and, once signed in, the login's picks to keep (`choices`). At a state no one knows
 * it fails with `unknown_state`, `unclear` when anything may have reached the site, else `unsent`,
 * and `unknownState`: the state's fingerprint and value-free description, the known state it came
 * from (`after`), whether anything may have been sent (`sent`), and the replay's own sign-in
 * (`signIn`), which a repair on the same browser goes on from.
 */
export type SignInStatesOutcome<V extends string = string> = AutofillReplayOutcome<V> & {
  readonly visited: readonly string[];
  readonly choices?: SignInStatesChoices;
  readonly unknownState?: {
    readonly fingerprint: StateFingerprint;
    readonly description: string;
    readonly after?: string;
    readonly sent: boolean;
    readonly signIn: AutofillSignInState;
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
}

type Shown = { readonly state: StateEntry; readonly inspection: AutofillInspection };
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
  /** The press it made with no secret typed, which a page that kept the state gets once more. */
  readonly press?: AutofillStep;
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

/** A step's controls found on the page and admitted on the state's recorded origin, or why not. */
const shownOn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  step: AutofillStep,
) =>
  Effect.gen(function* () {
    const inspection = yield* run.input.hooks.inspect(step);
    if ("outcome" in inspection) return inspection.reason;
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

/** Known states first in the order a login prefers them: its last-used, then the older. */
const preferred = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  states: readonly StateEntry[],
) => {
  const used = run.input.choices?.states ?? [];
  return [...states].sort(
    (a, b) => Number(!used.includes(a.key)) - Number(!used.includes(b.key)),
  );
};

/**
 * The known state the page shows: one whose fingerprint it is and whose recorded controls show,
 * one match each, on its recorded origin. The states the last one led to come first, then the
 * rest; never the state just acted in again.
 */
const matchState = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
  skip: StateEntry | undefined,
) =>
  Effect.gen(function* () {
    const next = new Set(
      run.input.library.transitions.filter((t) => t.from === after?.key).map((t) => t.to),
    );
    const alike = preferred(
      run,
      run.input.library.states.filter(
        (state) => state !== skip && sameFingerprint(state.fingerprint, fingerprint),
      ),
    );
    let refused: string | undefined;
    for (const state of [
      ...alike.filter((state) => next.has(state.key)),
      ...alike.filter((state) => !next.has(state.key)),
    ]) {
      const shown = yield* shownOn(run, state, resolved(run, state.step));
      if (typeof shown !== "string") return { state, inspection: shown } satisfies Shown;
      refused ??= shown;
    }
    return refused;
  });

const signedIn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  marker: SignedInEntry,
): Ended<V> => {
  const { replay, visited } = run;
  const method = replay.progress.chosen ?? run.input.choices?.method;
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

const stopped = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  reason: string,
  more: object = {},
): Ended<V> => ({ ended: { ...run.replay.outcome(reason), ...more, visited: run.visited } });

/** Whether anything this replay typed may have reached the site. */
const mayHaveSent = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
) =>
  run.replay.progress.anythingSent ||
  run.replay.state.submittedSlots.size > 0 ||
  run.replay.state.filled.size > 0;

const unknownState = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  fingerprint: StateFingerprint,
  after: StateEntry | undefined,
): Ended<V> => {
  const sent = mayHaveSent(run);
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
        signIn: run.replay.state,
      },
    },
  };
};

/**
 * A signed-in marker on the page as it is, checked without opening anything, then verified in
 * full; a marker that shows but fails the full check stops the replay. With `opening`, a marker
 * named only by its account page is verified too, which opens that page.
 */
const signedInHere = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  opening: boolean,
) =>
  Effect.gen(function* () {
    const { replay, input } = run;
    for (const marker of run.markers) {
      const onPage = { selector: marker.selector, urlPath: marker.urlPath };
      if (onPage.selector === undefined && onPage.urlPath === undefined) {
        if (opening && (yield* replay.verify(marker))) return signedIn(run, marker);
        continue;
      }
      const check = yield* input.hooks.check(onPage, run.as.recipe.steps, replay.state.steps);
      if (!check.signedIn) continue;
      return (yield* replay.verify(marker))
        ? signedIn(run, marker)
        : stopped(run, "sign_in_check_failed");
    }
    return undefined;
  });

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
 * Waits for the page to show a known state after `after`, reached as `reached`, acted (`acted`), or
 * at the start, as the recipe replay waits for a screen. The marker signs in; a known state is
 * taken once its controls show and pass its origin rule, the states `after` led to first. The
 * state just acted in, still showing with the same text, stops at a recorded error marker; else,
 * after `capMs`, a press that typed no secret is made once more (`repress`), and otherwise it
 * stops (`state_repeated`), as no secret is sent twice. The same boxes with a new text are another
 * state (`stateAfter`). A page with boxes no known state has ends the replay once it held still
 * `quietMs`; a page of text alone, or one a known state's controls have not shown on, gets the
 * whole step wait, as a slow page is no unknown state, and at its end the host's challenge look
 * runs once, as at a recipe screen's deadline.
 */
const arrive = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  last: Acted | undefined,
) =>
  Effect.gen(function* () {
    const { replay, quiet } = run;
    const after = last?.acted;
    const acted = last !== undefined && last.gone !== true;
    let start = yield* now;
    let held: { readonly text: string; readonly since: number } | undefined;
    let shape: StateFingerprint | undefined;
    let refused: string | undefined;
    let challenged = false;
    let answerRead = false;
    for (;;) {
      const signed = yield* signedInHere(run, false);
      if (signed !== undefined) return signed;
      const observed = yield* run.input.observe;
      const at = yield* now;
      if (observed !== undefined) {
        shape = acted ? stateAfter(last?.reached, observed) : observed.fingerprint;
        const text = fingerprintText(shape);
        if (held?.text !== text) held = { text, since: at };
        if (acted && after !== undefined && sameFingerprint(shape, after.fingerprint)) {
          const marked = yield* replay.observeRejections;
          const first = marked === "unavailable" ? undefined : marked[0];
          if (first !== undefined && first !== "code") return stopped(run, rejection(first));
          const still = at - held.since >= quiet.quietMs;
          const capped = at - start >= quiet.capMs;
          if (takesCodeIn(run, after) && replay.sent.maySent.has("code") && (first === "code" || still))
            return { again: "code", explicit: first === "code" } satisfies Again;
          if ((still && !answerRead) || capped) {
            answerRead = true;
            const said = yield* siteAnswer(run, after);
            if (said === "link") return { again: "link" } satisfies Again;
            if (said === "refused") return stopped(run, "credential_screen_returned");
          }
          if (capped)
            return last?.press === undefined
              ? stopped(run, "state_repeated")
              : ({ again: "repress" } satisfies Again);
        } else if (!blankFingerprint(shape)) {
          const shown = yield* matchState(run, shape, after, acted ? after : undefined);
          if (typeof shown === "object") return { ...shown, observed };
          refused = shown;
          if (refused === undefined && shape.boxes.length > 0 && at - held.since >= quiet.quietMs)
            break;
        }
      }
      if (at - start >= replay.timing.stepWaitMs) {
        const challenge = challenged ? undefined : yield* run.input.hooks.challenge ?? Effect.succeed(undefined);
        challenged = true;
        if (challenge?.outcome === "failed") {
          replay.progress.challenge = challenge.vendor;
          return stopped(run, "challenge_unsolved", { challenge: challenge.vendor });
        }
        if (challenge === undefined) break;
        start = yield* now;
      }
      yield* pause(run);
    }
    if (replay.progress.anythingSent) {
      const signed = yield* signedInHere(run, true);
      if (signed !== undefined) return signed;
    }
    if (refused !== undefined) return stopped(run, refused);
    return shape === undefined || blankFingerprint(shape)
      ? stopped(run, "state_not_shown")
      : unknownState(run, shape, after);
  });

/**
 * After a box was typed, or while a press waits: `same` while the page shows the state's boxes,
 * grown or not; another known state it now shows in full with what was typed (`fuller`); or
 * `moved` once a box of the state went.
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
    if (sameFingerprint(shape, state.fingerprint)) return { kind: "same" as const, text };
    for (const other of preferred(
      run,
      run.input.library.states.filter(
        (known) => known !== state && sameFingerprint(known.fingerprint, shape),
      ),
    )) {
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

/**
 * A method choice's pick: the login's own (`choices.method`), else the way in the recording took,
 * a lone two-factor method beside a way in, or the host's or caller's pick, as a recipe's replay
 * picks.
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
    const picked =
      own ??
      methods.find(
        (option) =>
          !isTwoFactorOption(option) &&
          !(codeOnly && option.method === "password") &&
          option.option === undefined &&
          option.selector === step.submit,
      ) ??
      (twoFactor.length === 1 && twoFactor.length < methods.length ? twoFactor[0] : undefined) ??
      (yield* run.replay.pickMethod(twoFactor));
    if (isTwoFactorOption(picked)) run.replay.progress.chosen = picked.method;
    return picked;
  });

/** An approval off the page: the emailed link the caller pastes, or a device's, confirmed. */
const approve = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
  inspection: AutofillInspection,
) =>
  Effect.gen(function* () {
    const { replay, input, as } = run;
    const step = state.step;
    if (![...replay.state.submittedSlots].some(isIdentifier))
      return stopped(run, "identifier_not_submitted");
    const popup = step.popup === undefined ? {} : { popup: step.popup };
    if (step.approval === "email_link") {
      const opened = yield* openPastedLink(as, inspection);
      if (opened !== "opened") return stopped(run, opened);
      replay.state.steps.push({ page: inspection.page, fields: [], approval: "email_link", delivery: "paste", ...popup });
      return undefined;
    }
    const number = yield* approvalNumber(input.hooks, step.matchSelector, inspection.page, step.popup);
    const answer = yield* askOne(input, {
      id: "approved",
      type: "confirm",
      prompt: withApprovalNumber(
        `Approve the sign-in request ${input.site} sent to your device, then confirm here.`,
        number,
      ),
    });
    if (answer?.type !== "confirm" || !answer.value.confirmed)
      return stopped(run, "approval_declined");
    replay.state.steps.push({
      page: inspection.page,
      fields: [],
      approval: "device",
      ...(step.matchSelector === undefined ? {} : { matchSelector: step.matchSelector }),
      ...popup,
    });
    return undefined;
  });

/** Whether a state's press may have the site send a code or link: a state it led to takes one. */
const sendsOnPress = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  run: Run<E, V, L>,
  state: StateEntry,
) => {
  const next = new Set(
    run.input.library.transitions.filter((t) => t.from === state.key).map((t) => t.to),
  );
  return run.input.library.states.some(
    (other) =>
      next.has(other.key) &&
      (other.step.approval !== undefined ||
        other.step.fields.some((field) => "slot" in field && field.slot === "code")),
  );
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
    let secret = false;
    const acted = (press?: AutofillStep): Acted => ({
      acted: state,
      reached,
      ...(press === undefined || secret ? {} : { press }),
    });
    const typed = new Set<AutofillSlot>();
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
        for (const field of fields) {
          typed.add(field.slot);
          if (isSecret(field.slot)) secret = true;
        }
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
      return acted(press);
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
    const markers = [...picked, ...library.signedIn.filter((marker) => !picked.includes(marker))];
    const recipe = signInStatesRecipe(library, input.choices);
    if (recipe === undefined)
      return { outcome: "unsent", reason: "states_empty", visited: [] } as SignInStatesOutcome<V>;
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
    };
    yield* input.hooks.open(input.entryUrl);
    let last: Acted | undefined;
    for (;;) {
      const arrived = yield* arrive(run, last);
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
      yield* input.emit({ stage: "state", state: arrived.state.key });
      const done = yield* actIn(run, arrived, arrived.observed);
      if ("ended" in done) return done.ended;
      last = done;
    }
  });
