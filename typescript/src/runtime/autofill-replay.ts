import { Clock, Duration, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import {
  type AutofillRecipeStep,
  handsOffSignIn,
  type SignInChoice,
} from "../destinations/autofill-recipe.js";
import { resolvedPage, type SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
} from "../destinations/autofill-step.js";
import { handOffPrompt } from "../destinations/autofill-contracts.js";
import { settledMarkerCheck } from "../destinations/marker-settle.js";
import { refusalEvidence } from "../destinations/autofill-refusal-evidence.js";
import { isIdentifier, screenSubmit, submittedLoginProof } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";
import {
  type AutofillReplayInput,
  type AutofillReplayOutcome,
  emptyRetryFields,
  askOne,
  isTwoFactorOption,
  valuesNeeded,
} from "./autofill-replay-steps.js";
import { alreadySignedIn, makeReplay, type Replay, workspaceOf } from "./autofill-replay-session.js";
import { endsAtCodeScreen, lastScreenGone } from "./autofill-replay-code-screen.js";
import { admitScreen, noteExactSent } from "./autofill-replay-workspace.js";
import {
  approvalNumber,
  approvalScreen,
  openPastedLink,
  withApprovalNumber,
} from "./autofill-replay-approval.js";
import { settleCarried } from "./autofill-replay-fill.js";
import {
  codeBoxRow,
  codeScreenOf,
  findCodeScreen,
  onSignInOrigin,
} from "./autofill-unrecorded-code.js";
import { screenProbes, showsAnotherScreen } from "./autofill-replay-screens.js";
import {
  cantTell,
  cantTellInPlace,
  offScreens,
  landingSettleMs,
  stillOff,
  type OffScreens,
} from "./autofill-replay-pages.js";

/**
 * A recorded screen's page as this replay knows it, a workspace screen's on its workspace origin,
 * with the segments it lists.
 */
const pageOf = <E extends YieldableError, V extends string, L extends AutofillLogin>(replay: Replay<E, V, L>, recorded: SignInRecipeStep) => ({
  page: resolvedPage(recorded, replay.progress.workspace) ?? recorded.page,
  anySegments: recorded.anySegments,
});

/** A recorded screen the host refused: its step event says which check, then the replay ends. */
const refusedScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  refusal: AutofillRefusal,
) =>
  input
    .emit({
      stage: "step",
      outcome: "refused",
      reason: refusal.reason,
      ...refusalEvidence(refusal),
      ...replay.firstCause.evidence(refusal),
    })
    .pipe(Effect.as(replay.outcome(refusal.reason)));

/**
 * A shown screen whose `choice` the run's caller did not allow: its step event says which choice,
 * then the replay ends before its submit, having pressed nothing on it.
 */
const choiceNotAllowed = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  choice: SignInChoice,
) =>
  input
    .emit({ stage: "step", outcome: "refused", reason: "sign_in_choice_not_allowed", choice })
    .pipe(Effect.as({ ...replay.outcome("sign_in_choice_not_allowed"), choice }));

/**
 * A recorded code screen that never showed within its wait (`not_found`), with neither the marker
 * nor a later recorded screen in its place: the site asked for no code this time, or showed another
 * screen. The replay then goes on to its sign-in check, which looks for a code screen the recipe
 * never recorded, before it ends with the recorded screen's refusal (`replayAutofillRecipe`).
 */
const codeScreenMissing = (recorded: SignInRecipeStep, refusal: AutofillRefusal) =>
  refusal.reason === "not_found" &&
  recorded.fields.some((field) => "slot" in field && field.slot === "code");

/** A recorded code screen that never showed, with the refusal its wait ended with. */
interface MissingCodeScreen {
  readonly codeScreenMissing: AutofillRefusal;
}
const missingCodeScreen = (refusal: AutofillRefusal): MissingCodeScreen => ({
  codeScreenMissing: refusal,
});

/**
 * A recorded screen that never showed within its wait (`not_found`), with the refusal its wait
 * ended with, which the replay ends with only when no other recorded screen shows
 * (`showingScreen`).
 */
interface NotShown {
  readonly notShown: AutofillRefusal;
}

/** A recorded screen shown and admitted, with the step that fills it. */
interface ShownScreen {
  readonly step: AutofillStep;
  readonly inspection: AutofillInspection;
}
const shownScreen = (step: AutofillStep, inspection: AutofillInspection): ShownScreen => ({
  step,
  inspection,
});

/** The two-factor methods that sign in with a code the login's owner types. */
const codeMethods: ReadonlySet<string> = new Set(["sms", "call", "email", "totp"]);

/**
 * The recorded screen as it runs now: a method choice clicks the method this run picks, or
 * chooses its option in a native select. A way in that the recorded sign-in picked there, a
 * password or an identifier, is the run's route: it clicks that, asking nothing, and otherwise
 * picks only among the choice's two-factor methods, taking a lone one beside a way in unasked. A
 * login without a password never takes the password way where every two-factor method the choice
 * offers is a code (`codeMethods`): it picks among those.
 */
const screenFor = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    // Each identifier field takes the kind this run's login holds that it accepts.
    const step: AutofillStep = replay.resolve({
      fields: recorded.fields,
      ...screenSubmit(recorded),
    });
    if (recorded.methods === undefined) return step;
    // The choice screen shows before a method is picked; its first option finds it.
    const probe = {
      fields: [],
      submit: recorded.methods[0]?.selector ?? "",
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
    };
    const alternatives = recorded.methods.slice(1).map((method) => ({
      fields: [],
      submit: method.selector,
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
    }));
    const shown = yield* replay.awaitScreen(
      probe,
      until,
      pageOf(replay, recorded),
      later,
      alternatives,
    );
    if (typeof shown === "string" || "outcome" in shown.found) return shown;
    // Picking a method may send a code: a value-free replay stops before it.
    if (replay.valueFree) return valuesNeeded;
    const twoFactor = recorded.methods.filter(isTwoFactorOption);
    const codeOnly =
      input.credentials?.password === undefined &&
      twoFactor.length > 0 &&
      twoFactor.every((method) => codeMethods.has(method.method));
    const picked =
      recorded.methods.find(
        (method) =>
          !isTwoFactorOption(method) &&
          !(codeOnly && method.method === "password") &&
          method.option === undefined &&
          method.selector === recorded.submit,
      ) ??
      (twoFactor.length === 1 && twoFactor.length < recorded.methods.length
        ? twoFactor[0]
        : undefined) ??
      (yield* replay.pickMethod(twoFactor));
    if (isTwoFactorOption(picked)) replay.progress.chosen = picked.method;
    return {
      fields: [],
      submit: picked.selector,
      // A method chosen from a native select: the host chooses its option there.
      ...(picked.option === undefined ? {} : { option: picked.option }),
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
    };
  });

/** An approval happens off the page: the caller confirms it, and a "no" stops the replay. */
const confirmPush = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  askOne(input, {
    id: "approved",
    type: "confirm",
    prompt: `Approve the sign-in request ${input.site} sent you, then confirm here.`,
  }).pipe(
    Effect.map((approved) =>
      approved?.type === "confirm" && approved.value.confirmed
        ? ("continue" as const)
        : replay.outcome("push_declined"),
    ),
  );

/** Wait for a resolved step's screen, and admit it only on the recorded screen's own origin. */
const awaitRecordedScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  step: AutofillStep,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    const shown = yield* replay.awaitScreen(step, until, pageOf(replay, recorded), later);
    if (typeof shown === "string")
      return shown === "signed_in" || shown === "skipped" ? shown : replay.outcome(shown);
    if ("outcome" in shown.found)
      return codeScreenMissing(recorded, shown.found)
        ? missingCodeScreen(shown.found)
        : shown.found.reason === "not_found"
          ? ({ notShown: shown.found } satisfies NotShown)
          : yield* refusedScreen(input, replay, shown.found);
    // The screen must sit on its recorded origin or the login's own workspace, not only on the
    // same site: another tenant's login on a shared domain would pass the site check.
    const refused = yield* admitScreen(input, replay, recorded, shown.found.page, shown.found);
    if (refused !== undefined) return replay.outcome(refused);
    return shownScreen(step, shown.found);
  });

/** Resolve and admit the observed recorded screen before any host-filled submission. */
const inspectRecordedScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    const step = yield* screenFor(input, replay, recorded, until, later);
    if (typeof step === "string")
      return step === "signed_in" || step === "skipped" ? step : replay.outcome(step);
    if ("found" in step)
      return "outcome" in step.found
        ? step.found.reason === "not_found"
          ? ({ notShown: step.found } satisfies NotShown)
          : yield* refusedScreen(input, replay, step.found)
        : replay.outcome("screen_changed");
    return yield* awaitRecordedScreen(input, replay, step, recorded, until, later);
  });

/**
 * A fill that sent nothing found its screen gone, as a single-page app's login route removes its
 * form while it sends a signed-in browser on: once per replay, the step leaves the screens that
 * ran and the screen gets a wait of its own, which finds the page signed in, or the screen, which
 * it holds until it stays shown before filling it again (`holdsShown`).
 */
const screenGoneUnsent = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  step: AutofillStep,
  ranBefore: number,
) =>
  Effect.gen(function* () {
    if (replay.progress.screenGone || replay.progress.anythingSent || replay.sent.maySent.size > 0)
      return false;
    const here = yield* input.hooks.inspect(step);
    if (!("outcome" in here) || here.reason !== "not_found") return false;
    replay.progress.ran.splice(ranBefore);
    replay.progress.screenGone = true;
    yield* input.emit({ stage: "retried", reason: "screen_gone" });
    return true;
  });

/**
 * A screen of email or username fields whose recorded submit went once they were typed, with
 * nothing sent, as a site that turns its Continue into its single sign-on control once it knows
 * the login does: the step takes Enter in its last field in place of that submit, which sends the
 * field's form, as a step with a submit key does. The host refuses a field in no form, and the
 * screen then waits as one gone (`screenGoneUnsent`). Enter spends the replay's one such wait, so
 * the step takes it at most once, and a press that fails ends the screen with its own failure.
 */
const submitGoneAfterTyping = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  step: AutofillStep,
  failed: string,
) =>
  Effect.gen(function* () {
    if (
      failed !== "submit_refused" ||
      step.submit === undefined ||
      replay.progress.anythingSent ||
      replay.sent.maySent.size > 0 ||
      step.fields.length === 0 ||
      !step.fields.every((field) => field.slot === "email" || field.slot === "username")
    )
      return undefined;
    const here = yield* input.hooks.inspect(step);
    if (!("outcome" in here) || here.reason !== "not_found" || here.target !== "submit")
      return undefined;
    const { submit: _gone, submitVia: _via, ...rest } = step;
    const keyed: AutofillStep = { ...rest, submitKey: "Enter" };
    const inspection = yield* input.hooks.inspect(keyed);
    if ("outcome" in inspection) return undefined;
    if ((yield* admitScreen(input, replay, recorded, inspection.page, inspection)) !== undefined)
      return undefined;
    replay.progress.screenGone = true;
    yield* input.emit({ stage: "retried", reason: "submit_gone_after_typing" });
    return shownScreen(keyed, inspection);
  });

/**
 * Waits for a recorded hand-off screen within the screen's own wait. A step with no fields shows on
 * any page, so the wait reads the page itself: `signed_in` only once it shows the recipe's marker,
 * as a saved session's does; else the page it settles on, once it stays `landingSettleMs` without
 * the marker, or the page at the deadline. That page is the hand-off screen wherever it is, even off
 * the recorded page, as a site may send the browser on to an identity provider whose page changes
 * from one sign-in to the next. The person signs in there, and the marker check after it decides.
 * `undefined` when no page could be read.
 */
const handOffShown = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  replay: Replay<E, V, L>,
  until: number,
) =>
  Effect.gen(function* () {
    let settled: OffScreens | undefined;
    while (true) {
      const here = yield* replay.checkHere;
      if (here.signedIn) return "signed_in" as const;
      const now = yield* Clock.currentTimeMillis;
      settled = stillOff(settled, here.url, now);
      if (settled !== undefined && (now - settled.since >= landingSettleMs || now >= until))
        return URL.parse(settled.url);
      if (now >= until) return undefined;
      yield* Effect.sleep(Duration.millis(replay.timing.pollMs));
    }
  });

/**
 * The recipe's full check, once, on a page that settled without the marker: a saved session's page
 * may draw it late, or show it only on the account page the check opens (`openPath`). It waits for
 * a late marker as `settledMarkerCheck` does, and passes only when the marker shows.
 */
const signedInLate = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
) =>
  settledMarkerCheck(
    (indicator) =>
      replay
        .verify(indicator)
        .pipe(
          Effect.map(
            (shown): AutofillSignedInCheck =>
              shown
                ? { signedIn: true, url: "" }
                : { signedIn: false, failed: "indicator_not_visible" },
          ),
        ),
    input.recipe.signedIn,
    replay.timing.markerSettle,
  ).pipe(Effect.map((check) => check.signedIn));

/**
 * A recorded hand-off screen (`approval: "handoff"`), which needs no identifier first. Once the
 * page settles without the marker and the recipe's full check fails there (`signedInLate`), a
 * replay that may not hand off stops unsent (`valuesNeeded`) on the page the browser then settles
 * on, as at any approval; one that may (`handOff`) asks the person one `browser_handoff` question
 * there, with no values. The person signs in in the browser and marks it done; nothing is typed,
 * and the check after the screens decides (`signedInByHandOff`).
 */
const handOffScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  until: number,
) =>
  Effect.gen(function* () {
    let shown = yield* handOffShown(replay, until);
    // The full check may open the account page, so a hand-off waits for a page to settle again.
    if (shown instanceof URL)
      shown = (yield* signedInLate(input, replay))
        ? "signed_in"
        : yield* handOffShown(replay, (yield* Clock.currentTimeMillis) + replay.timing.stepWaitMs);
    if (shown === "signed_in") {
      yield* input.emit({ stage: "skipped", reason: "signed_in_indicator" });
      return shown;
    }
    if (shown === null || shown === undefined)
      return yield* refusedScreen(input, replay, { outcome: "refused", reason: "not_found" });
    if (input.handOff !== true) return replay.outcome(valuesNeeded);
    const done = yield* askOne(input, {
      id: "signed_in",
      type: "browser_handoff",
      prompt: handOffPrompt(input.site),
      show_inputs: [],
    });
    if (done?.type !== "browser_handoff") return replay.outcome("approval_declined");
    // The page as every recorded screen names it: origin and path.
    replay.state.steps.push({
      page: `${shown.origin}${shown.pathname}`,
      fields: [],
      approval: "handoff",
    });
    return "continue" as const;
  });

/** Fill only a recorded screen whose live controls and origin passed inspection. */
const runScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    if (recorded.approval === "handoff") return yield* handOffScreen(input, replay, until);
    const inspected = yield* inspectRecordedScreen(input, replay, recorded, until, later);
    if (typeof inspected === "string" || !("inspection" in inspected)) return inspected;
    let { step, inspection } = inspected;
    // The screen is shown and needs the login: a value-free replay stops before anything is sent.
    if (replay.valueFree && (recorded.approval !== undefined || step.fields.length > 0))
      return replay.outcome(valuesNeeded);
    // A screen that names a choice is pressed only when the run's caller allowed that choice.
    if (
      recorded.choice !== undefined &&
      !(input.hosted?.allowedChoices ?? []).includes(recorded.choice)
    )
      return yield* choiceNotAllowed(input, replay, recorded.choice);
    if (recorded.approval !== undefined) {
      settleCarried(replay);
      if (![...replay.state.submittedSlots].some(isIdentifier))
        return replay.outcome("identifier_not_submitted");
      // The approval may show on another page of its recorded origin (`approvalScreen`).
      const approval = yield* approvalScreen(
        input,
        replay,
        recorded,
        pageOf(replay, recorded).page,
        inspection.page,
      );
      if (approval === "signed_in") return approval;
      if (approval === "screen_changed") return replay.outcome(approval);
      // A site that emailed a sign-in link when the recipe was recorded may text or email a code
      // this time, and show its box where the link's screen was: the code goes in as on a code
      // screen the recipe never recorded (`runFoundCodeScreen`), and nobody is asked for a link,
      // unless nobody gives the code: never the host generator's, as the recording says the site
      // emails.
      // While no code may have gone out, so the look never sends a second one.
      if (recorded.approval === "email_link" && !replay.sent.maySent.has("code")) {
        const code = yield* runFoundCodeScreen(input, replay, true);
        if (code === "ran") return "continue" as const;
        if (code !== "none") return replay.outcome(code);
      }
      // A site whose emailed link signs in only the browser that opens it: the owner pastes the
      // link, and the replay opens it itself (`openPastedLink`).
      if (recorded.approval === "email_link" && recorded.delivery === "paste") {
        const opened = yield* openPastedLink(input, inspection);
        if (opened !== "opened") return replay.outcome(opened);
        replay.state.steps.push({
          page: inspection.page,
          fields: [],
          approval: recorded.approval,
          delivery: recorded.delivery,
          ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
        });
        return "continue" as const;
      }
      // A device approval may have the owner pick the number its screen shows (`matchSelector`).
      const number =
        recorded.approval === "device"
          ? yield* approvalNumber(
              input.hooks,
              recorded.matchSelector,
              inspection.page,
              recorded.popup,
            )
          : undefined;
      const answer = yield* askOne(input, {
        id: "approved",
        type: "confirm",
        prompt:
          recorded.approval === "email_link"
            ? `Open the sign-in link ${input.site} emailed you, then confirm here.`
            : withApprovalNumber(
                `Approve the sign-in request ${input.site} sent to your device, then confirm here.`,
                number,
              ),
      });
      if (answer?.type !== "confirm" || !answer.value.confirmed)
        return replay.outcome("approval_declined");
      replay.state.steps.push({
        page: inspection.page,
        fields: [],
        approval: recorded.approval,
        ...(recorded.matchSelector === undefined ? {} : { matchSelector: recorded.matchSelector }),
        ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
      });
      return "continue" as const;
    }
    for (;;) {
      const ranBefore = replay.progress.ran.length;
      const failed = yield* replay.runStep(
        step,
        inspection,
        undefined,
        false,
        undefined,
        recorded.refills,
        later[0],
      );
      if (failed === undefined) break;
      const keyed = yield* submitGoneAfterTyping(input, replay, recorded, step, failed);
      if (keyed !== undefined) {
        ({ step, inspection } = keyed);
        continue;
      }
      // A fieldless step whose submit the page kept disabled through the host's wait typed and
      // clicked nothing, so it waits for its screen again within the screen's own wait, as it
      // did while the host refused a disabled submit, and so does a fill whose screen went with
      // nothing sent. Any other step with fields ends: the page still wants something besides them.
      const now = yield* Clock.currentTimeMillis;
      const waitsAgain =
        failed === "submit_stayed_disabled"
          ? step.fields.length === 0 && now < until
          : yield* screenGoneUnsent(input, replay, step, ranBefore);
      if (!waitsAgain) return replay.outcome(failed);
      // A screen gone under the fill gets a screen's wait of its own, so its hold still runs.
      const by = failed === "submit_stayed_disabled" ? until : now + replay.timing.stepWaitMs;
      const shown = yield* awaitRecordedScreen(input, replay, step, recorded, by, later);
      if (typeof shown === "string" || !("inspection" in shown)) return shown;
      inspection = shown.inspection;
    }
    // What a screen on its exact origin sent anchors the login's workspace (`admitScreen`).
    noteExactSent(replay, recorded, step, inspection);
    // The site's own answer to the password decides before a later recorded screen does, which
    // may show on the very screen the site sent back, as a screen of only a button or another
    // password field: a link it emailed is asked for, and a refused login ends as that returned
    // screen does. A recorded marker that shows decides first, as the next screen's wait has it.
    if (step.fields.some((field) => field.slot === "password") && later.length > 0) {
      const unmarked = Effect.map(
        replay.observeRejections,
        (marked) => marked !== "unavailable" && marked.length === 0,
      );
      const answer = yield* readAnswer(input, replay, unmarked);
      if (answer?.said === "link")
        return yield* openAnsweredLink(input, replay, answer.returned.inspection);
      if (answer?.said === "refused") return replay.outcome("credential_screen_returned");
    }
    // An approval happens off the page: the caller confirms it, then the screens go on.
    if (replay.progress.chosen === "push" && recorded.methods !== undefined)
      return yield* confirmPush(input, replay);
    return "continue" as const;
  });

/**
 * Where a sign-in's walk of the recorded screens starts (`from`), the screen it last ran (`at`),
 * the screens that acted in it (`acted`), each of which acts at most once per sign-in, and the
 * screens it restarted at (`restarted`), each at most once.
 */
interface Walk {
  from: number;
  at: number;
  readonly acted: Set<number>;
  readonly restarted: Set<number>;
}

/**
 * The recorded screens in order from `walk.from`, past those that acted, each waited for at most
 * `stepWaitMs`.
 */
const runScreens = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  walk: Walk,
) =>
  Effect.gen(function* () {
    const { steps } = input.recipe;
    for (const [index, recorded] of steps.entries()) {
      if (index < walk.from || walk.acted.has(index)) continue;
      walk.at = index;
      const now = yield* Clock.currentTimeMillis;
      const ran = yield* runScreen(
        input,
        replay,
        recorded,
        now + replay.timing.stepWaitMs,
        steps.filter((_, at) => at > index && !walk.acted.has(at)),
      );
      if (ran === "continue") walk.acted.add(index);
      if (ran === "signed_in")
        return replay.progress.entryCantTell
          ? ({ outcome: "signed_in", alreadySignedIn: true, cantTell: true } as const)
          : replay.progress.alreadySignedIn
            ? ({ outcome: "signed_in", alreadySignedIn: true, ...workspaceOf(replay) } as const)
            : undefined;
      if (ran !== "continue" && ran !== "skipped") return ran;
    }
    return undefined;
  });

/**
 * Waits, bounded, for the marker to show on the current page. Once the page left the recorded
 * login screens and stayed put a moment, a read's sign-in on a page that can't tell stops waiting
 * and returns that page's check
 * (`cantTellHere`) for the last check to decide from, as it does at once on the shared entry
 * address a screen's wait already found settled there (`landedInPlace`). A page that reads signed
 * out, such as the marker's own path, waits out a marker drawn late.
 * A caller that hands over at a code screen the recipe never recorded stops once the page is one
 * (`endsAtCodeScreen`), which the probe after the wait answers.
 */
const awaitIndicator = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + replay.timing.stepWaitMs;
    const mayCantTell = input.hooks.confirmCantTell !== undefined;
    // The page off the recorded screens, and since when: a passing page redirects on before it
    // settles, so only one that stayed put can't tell.
    let off: OffScreens | undefined;
    const look = { next: 0 };
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= until) return { shown: false } as const;
      const check = yield* replay.checkHere;
      if (check.signedIn) return { shown: true } as const;
      if (yield* endsAtCodeScreen(input, replay, check.url, look)) return { shown: false } as const;
      if (
        replay.progress.landedInPlace &&
        cantTellInPlace(check, input.recipe, replay.matchesRecorded, input.entryUrl)
      )
        return { shown: false, cantTellHere: check } as const;
      off = stillOff(off, offScreens(replay.onScreens, check.url), now);
      if (off !== undefined && now - off.since >= landingSettleMs) {
        if (
          mayCantTell &&
          cantTell(
            check,
            { signedIn: input.recipe.signedIn, steps: replay.resolvedSteps() },
            replay.onScreens,
          )
        )
          return { shown: false, cantTellHere: check } as const;
      }
      yield* Effect.sleep(Duration.millis(replay.timing.pollMs));
    }
  });

/**
 * The last code step whose field shows again. An unrecorded code screen shows again only where it
 * was found: a code field on another screen is the site's next one, not a refusal of the code the
 * first took.
 */
const codeShownAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const shown = yield* replay.shownAgain("code");
    const unrecorded = replay.progress.unrecordedCodeScreen;
    if (shown === undefined || unrecorded === undefined) return shown;
    const here = yield* input.hooks.inspect({
      fields: shown.fields,
      ...(shown.popup === undefined ? {} : { popup: shown.popup }),
    });
    return !("outcome" in here) && codeScreenOf(here) === unrecorded ? shown : undefined;
  });

/**
 * A code screen that came back: the caller types a new code, never one from the host's generator.
 * What was sent does not decide the rest, the screen does: every other password or
 * code field it shows empty is filled again, as a site that empties the whole screen needs, and a
 * field that still holds a value is left as it is. A password goes out at most twice this way.
 */
const retryCode = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const observed = yield* replay.observeRejections;
    if (observed === "unavailable") return "ambiguous_combined_rejection";
    const extra = yield* replay.correctExtras(observed);
    if (extra !== undefined) return extra;
    const rejected = observed[0];
    if (rejected === "password") return "password_rejected";
    if (rejected !== undefined && rejected !== "code") return "username_rejected";
    const shown = yield* codeShownAgain(input, replay);
    if (shown === undefined) return "none" as const;
    replay.recordRejected([...observed, "code"]);
    const fields = yield* emptyRetryFields(input, shown, rejected === "code");
    if (typeof fields === "string") return fields;
    const retryStep: AutofillStep = {
      fields,
      ...screenSubmit(shown),
    };
    const inspected = yield* input.hooks.inspect(retryStep);
    if ("outcome" in inspected) return "none" as const;
    return (
      (yield* replay.runStep(retryStep, inspected, "rejected", rejected === "code")) ??
      ("retried" as const)
    );
  });

/**
 * A code screen the recipe never recorded, where one shows (`findCodeScreen`, `onSignInOrigin`). A
 * code field in no form with a submit is filled with no submit, so the page's own send counts
 * (`page`). A field that is the first of a row of one-character boxes takes the whole row, or
 * nothing (`codeBoxRow`). Its code comes as a recorded code screen's does: the host's own, else the
 * owner's answer to the host's question; after it refuses a code, its retries never take the host
 * generator's (see `runReplayStep`). The screen this replay last submitted still showing is the
 * site's answer to it, such as a password screen shown again or a refused recovery code, so a code
 * box on it takes no code. A fill that typed no code leaves the sign-in as it was, its step dropped
 * from the screens that ran; one that typed it and sent nothing stops, as the code it holds would
 * count as sent there.
 * On a recorded emailed link's screen (`onLinkScreen`), the recording says the site emails, so the
 * code never comes from the host's generator, and a code nobody gave leaves the link's question to
 * ask (`none`), as nothing was typed.
 * `ran` when the code went out, `none` when none shows, or why it stopped.
 */
const runFoundCodeScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  onLinkScreen = false,
) =>
  Effect.gen(function* () {
    const field = yield* findCodeScreen(input.hooks);
    const found = "outcome" in field ? field : yield* codeBoxRow(input.hooks, field);
    if ("outcome" in found || !onSignInOrigin(replay.signInOrigins(), found.inspection))
      return "none" as const;
    if (!(yield* lastScreenGone(input, replay))) return "none" as const;
    const screen = codeScreenOf(found.inspection);
    const earlier = replay.progress.unrecordedCodeScreen;
    replay.progress.unrecordedCodeScreen = screen;
    if (onLinkScreen) replay.progress.linkCodeScreen = screen;
    const before = replay.progress.ran.length;
    const failed = yield* replay.runStep(found.step, found.inspection);
    if (failed === "link_code_unanswered") {
      replay.progress.unrecordedCodeScreen = earlier;
      replay.progress.linkCodeScreen = undefined;
      return "none" as const;
    }
    if (failed === undefined && replay.sent.maySent.has("code")) return "ran" as const;
    if (replay.sent.maySent.has("code") || replay.state.filled.has("code"))
      return failed ?? "sign_in_check_failed";
    replay.progress.ran.splice(before);
    return "none" as const;
  });

/**
 * A code screen the recipe never recorded, after the screens: looked for once and only while no
 * code may have gone out, so the look never sends a second one (`runFoundCodeScreen`). A fill that
 * typed no code leaves the full check to decide.
 */
const unrecordedCode = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  probed: { current: boolean },
) =>
  Effect.gen(function* () {
    if (probed.current || replay.sent.maySent.has("code")) return "none" as const;
    probed.current = true;
    return yield* runFoundCodeScreen(input, replay);
  });

/**
 * The check after a person signed in on the recipe's hand-off screen: the recipe's marker signs
 * the run in with nothing typed (`handedOff`), and no page that can't tell does; else the sign-in
 * ends `handoff_not_signed_in`.
 */
const signedInByHandOff = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
) =>
  Effect.gen(function* () {
    if (yield* replay.verify(input.recipe.signedIn))
      return {
        outcome: "signed_in",
        alreadySignedIn: false,
        loginProved: false,
        handedOff: true,
        ...workspaceOf(replay),
      } as const;
    return replay.outcome("handoff_not_signed_in");
  });

/** The indicator verified a sign-in this replay sent, and whether it submitted the login proof. */
const signedInBySending = <E extends YieldableError, V extends string, L extends AutofillLogin>(replay: Replay<E, V, L>) =>
  ({
    outcome: "signed_in",
    alreadySignedIn: false,
    loginProved: submittedLoginProof(replay.state),
    ...workspaceOf(replay),
  }) as const;

/**
 * The full check for a recipe that checks on the landing page, else why the replay did not sign
 * in: the password screen showing again after a submit sent the password, with no recorded error
 * marker, is no verdict on the login (`credential_screen_returned`); the
 * password screen after no submit sent it (`password_screen_again`), or any other failed check, is
 * the recipe's. A saved security answer whose question shows again was refused, and is flagged.
 * A read's page that can't tell, such as an account picker the site shows before its marker, signs
 * in. One the marker wait already found so (`cantTellHere`)
 * decides from that check, with no marker wait of its own, as a missed marker only waits for the
 * read to prove the sign-in, and a marker drawn since changes nothing.
 */
const lastCheck = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  cantTellHere: AutofillSignedInCheck | undefined,
) =>
  Effect.gen(function* () {
    if (cantTellHere === undefined && (yield* replay.verify(input.recipe.signedIn)))
      return signedInBySending(replay);
    if ((yield* replay.shownAgain("password")) === undefined) {
      yield* replay.refuseShownAnswer;
      if (yield* replay.endedCantTell(cantTellHere))
        return { ...signedInBySending(replay), cantTell: true } as const;
      return replay.outcome("sign_in_check_failed");
    }
    return replay.outcome(
      replay.sent.seenSent("password") ? "credential_screen_returned" : "password_screen_again",
    );
  });

/**
 * After the screens, the recipe's own sign-in check decides: the marker on the
 * page, a code screen answered first (a refused code's retry, else one the recipe never recorded:
 * see `retryCode` and `unrecordedCode`), then the full check on the page as it is, once it settled. A
 * check that fails ends the replay with its reason, such as a password the site rejected.
 */
const settle = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const probed = { current: false };
    while (true) {
      // A screen that submitted itself, such as a code box on its last digit, sent its values:
      // they count before the code retry and the unrecorded-code probe decide.
      settleCarried(replay);
      const waited = yield* awaitIndicator(input, replay);
      if (!replay.progress.anythingSent)
        return replay.state.steps.some((step) => step.approval === "handoff")
          ? yield* signedInByHandOff(input, replay)
          : yield* alreadySignedIn(input, replay, waited.cantTellHere);
      if (waited.shown && (yield* replay.verify(replay.onPage))) return signedInBySending(replay);
      const code = yield* retryCode(input, replay);
      if (code === "retried" || code === "extra_retried") continue;
      if (code !== "none") return replay.outcome(code);
      const unrecorded = yield* unrecordedCode(input, replay, probed);
      if (unrecorded === "ran") continue;
      if (unrecorded !== "none") return replay.outcome(unrecorded);
      return yield* lastCheck(input, replay, waited.cantTellHere);
    }
  });

/**
 * The recorded screen the page shows now among those that have neither acted in this sign-in nor
 * had the walk restart at them: its controls as the progression check finds them
 * (`screenProbes`), on its own recorded page, and another screen than the one the walk waited for
 * or last ran, and than the step that last ran, by the progression check's rule
 * (`showsAnotherScreen`). Of several, the one with the
 * most controls found, then the first recorded. A hand-off screen, or one with no control to find,
 * never shows here.
 */
const showingScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  walk: Walk,
) =>
  Effect.gen(function* () {
    let best: { readonly index: number; readonly controls: number } | undefined;
    const steps: readonly SignInRecipeStep[] = input.recipe.steps;
    const last = steps[walk.at];
    if (last === undefined) return undefined;
    const lastStep = replay.resolve({ fields: last.fields, ...screenSubmit(last) });
    const before = replay.progress.ran.slice(-1);
    for (const [index, recorded] of steps.entries()) {
      if (walk.acted.has(index) || walk.restarted.has(index) || recorded.approval === "handoff")
        continue;
      for (const probe of screenProbes(recorded, replay.resolve)) {
        const controls = probe.fields.length + (probe.submit === undefined ? 0 : 1);
        if (controls <= (best?.controls ?? 0)) continue;
        const found = yield* input.hooks.inspect(probe);
        if (
          !("outcome" in found) &&
          replay.matchesRecorded(found.page, recorded) &&
          (yield* showsAnotherScreen(
            input.hooks,
            found.page,
            probe,
            pageOf(replay, last),
            lastStep,
            before,
            before[0],
          ))
        )
          best = { index, controls };
      }
    }
    return best?.index;
  });

/**
 * A sign-in check that ended with no verdict on the login (`sign_in_check_failed`), with no code
 * it typed and never sent, which stops the sign-in where it is (`runFoundCodeScreen`).
 */
const noVerdict = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  replay: Replay<E, V, L>,
  settled: { readonly outcome: string; readonly reason?: string },
) =>
  settled.outcome !== "signed_in" &&
  settled.reason === "sign_in_check_failed" &&
  !(replay.state.filled.has("code") && !replay.sent.maySent.has("code"));

/**
 * One walk of the recorded screens from `walk.from`, and the sign-in check after them: how the
 * replay ends, or, where it would end because a screen it waited for never showed or the check
 * found no verdict on the login (`noVerdict`), that ending (`failed`), which stands only when no
 * other recorded screen shows (`showingScreen`). A recorded code screen that never showed leaves
 * the sign-in check to decide first, which looks for a code screen the recipe never recorded: one
 * that signs in, or sends a code, stands.
 */
const walkScreens = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  walk: Walk,
) =>
  Effect.gen(function* () {
    const stopped = yield* runScreens(input, replay, walk);
    if (stopped === undefined) {
      const settled = yield* settle(input, replay);
      return noVerdict(replay, settled) ? { failed: Effect.succeed(settled) } : settled;
    }
    if ("notShown" in stopped) return { failed: refusedScreen(input, replay, stopped.notShown) };
    if (!("codeScreenMissing" in stopped)) return stopped;
    const settled = yield* settle(input, replay);
    if (settled.outcome === "signed_in") return settled;
    const ending = replay.sent.maySent.has("code")
      ? Effect.succeed(settled)
      : refusedScreen(input, replay, stopped.codeScreenMissing);
    return noVerdict(replay, settled) ? { failed: ending } : yield* ending;
  });

/**
 * The site's own answer to the credential screen the replay submitted last, come back, password or
 * identifier alike (`returnedScreen`), as the host reads it (`hosted.siteAnswer`), with that screen.
 * None without the host's read, once an emailed link went in or was asked for, when no screen came
 * back, as after a submit the site signed in on, which never asks the host, once the host gave its
 * answer for that screen, or when the screen that came back fails `unmarked`.
 */
const readAnswer = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  unmarked: Effect.Effect<boolean> = Effect.succeed(true),
) =>
  Effect.gen(function* () {
    const read = input.hosted?.siteAnswer;
    if (
      read === undefined ||
      replay.progress.linkAsked ||
      replay.state.steps.some((step) => step.approval === "email_link")
    )
      return undefined;
    const returned = yield* replay.returnedScreen;
    if (
      returned === undefined ||
      replay.progress.answered === returned.step ||
      !(yield* unmarked)
    )
      return undefined;
    const said = yield* read();
    if (said === undefined) return undefined;
    replay.progress.answered = returned.step;
    return { said, returned };
  });

/**
 * A `link` answer has the owner paste the sign-in link the site emailed, which the replay opens in
 * its own browser (`openPastedLink`), trusted as the returned screen's page trusts it, and the
 * sign-in's check after the screens decides (`settle`), at most once per sign-in.
 */
const openAnsweredLink = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  screen: Pick<AutofillInspection, "siteOrigin" | "authenticationOrigins">,
) =>
  Effect.gen(function* () {
    replay.progress.linkAsked = true;
    yield* input.emit({ stage: "approval", approval: "email_link", reason: "site_answer" });
    const opened = yield* openPastedLink(input, screen);
    if (opened !== "opened") return replay.outcome(opened);
    return yield* settle(input, replay);
  });

/**
 * A replay that would end with no verdict on the login (`credential_screen_returned`, or a failed
 * check, `sign_in_check_failed`) because the credential screen it submitted last came back reads the
 * site's own answer to that submit once that screen shows (`readAnswer`), as a reply too late for
 * the read right after the password's submit (`runScreen`) is: a `link` answer opens the link
 * (`openAnsweredLink`). Any other ending stands, and so does this one on any other answer.
 */
const answeredScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  ended: AutofillReplayOutcome<V>,
) =>
  Effect.gen(function* () {
    if (
      ended.outcome === "signed_in" ||
      (ended.reason !== "credential_screen_returned" && ended.reason !== "sign_in_check_failed")
    )
      return ended;
    const answer = yield* readAnswer(input, replay);
    if (answer?.said !== "link") return ended;
    return yield* openAnsweredLink(input, replay, answer.returned.inspection);
  });

/**
 * A sign-in by hand-off counts only once the recipe's marker shows: its replay takes no page that
 * can't tell as signed in, so a page that settles without the marker is its hand-off screen.
 */
const markerOnly = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
): AutofillReplayInput<E, V, L> => {
  if (!handsOffSignIn(input.recipe)) return input;
  const { confirmCantTell: _cantTell, ...hooks } = input.hooks;
  return { ...input, hooks };
};

/**
 * Replays the recipe on the run's own browser with the host's fill: each screen is found and
 * judged (one visible match, frame and form on the site or a configured sign-in origin), filled
 * and submitted, then the host checks the indicator. The build's rules hold: a password or code
 * goes out at most twice, a visible credential rejection stops before another fill, and an empty
 * combined screen without distinct code-rejection evidence ends the replay
 * (`ambiguous_combined_rejection`).
 * A value counts as sent once a submit was clicked after it was filled.
 */
export const replayAutofillRecipe = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  given: AutofillReplayInput<E, V, L>,
) =>
  Effect.gen(function* () {
    const input = markerOnly(given);
    const replay = makeReplay(input);
    const removeFailureListener = input.hooks.onLoadFailure?.(replay.firstCause.heard);
    if (removeFailureListener) yield* Effect.addFinalizer(() => Effect.sync(removeFailureListener));
    yield* input.hooks.open(input.entryUrl);
    // Each restart is at a screen not restarted at before, so the walk ends.
    const walk: Walk = { from: 0, at: 0, acted: new Set(), restarted: new Set() };
    for (;;) {
      const ended = yield* walkScreens(input, replay, walk);
      if (!("failed" in ended)) return yield* answeredScreen(input, replay, ended);
      const next = yield* showingScreen(input, replay, walk);
      if (next === undefined) return yield* answeredScreen(input, replay, yield* ended.failed);
      yield* input.emit({ stage: "skipped", reason: "recorded_screen_showing", nextStep: next });
      walk.restarted.add(next);
      walk.from = next;
    }
  });
