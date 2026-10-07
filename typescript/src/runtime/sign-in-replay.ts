import { Clock, Duration, Effect, type Scope } from "effect";
import type { SignInMethodChoice } from "../destinations/autofill-contracts.js";
import type {
  AutofillRefusal,
  AutofillSignedIn,
  AutofillSlot,
  AutofillStep,
  AutofillStepRequest,
  SecretSlot,
} from "../destinations/autofill-step.js";
import {
  decodeSignInRecipe,
  isIdentifier,
  makeSentTracker,
  openSignInRecord,
  provesLogin,
  type SecretMatcher,
  type SignInLogin,
  type SignInRecipe,
  type SignInRecipeStep,
  type SignInValueHooks,
} from "../destinations/sign-in-recipe.js";
import type { CredentialRejectedField, WebsiteCredentials } from "./authentication.js";
import { trustedUrl } from "./sign-in-origins.js";
import {
  askOne,
  correctReplayExtras,
  defaultReplayTiming,
  emptyRetryFields,
  landingSettleMs,
  makeReplayScreenWait,
  offScreens,
  pickMethod,
  recipeSteps,
  runReplayStep,
  shownAgain,
  SignInRunFailed,
  stillOff,
  valuesNeeded,
  type OffScreens,
  type SignInReplayBrowser,
  type SignInReplayInput,
  type SignInReplayOutcome,
  type SignInReplayTiming,
} from "./sign-in-replay-steps.js";
import {
  correctRejectedLogin,
  logicalRejectedField,
  makeReplayRetryState,
  makeRunLogin,
  makeSignInValues,
  recordedRejections,
  type ReplayRetryState,
} from "./sign-in-values.js";

export { SignInRunFailed } from "./sign-in-replay-steps.js";
export type { SignInReplayBrowser, SignInReplayOutcome } from "./sign-in-replay-steps.js";

/** One replay's state: what its fills sent, the screens it ran and the rejections it saw. */
const makeReplaySession = <E>(input: SignInReplayInput<E>) => {
  const steps = recipeSteps(input.recipe);
  const record = openSignInRecord();
  /** Every secret a submit may have sent, which this replay never fills again past its allowance. */
  const maySent = new Set<SecretSlot>();
  const tracker = makeSentTracker(
    () => record,
    input.carries,
    (slots) => {
      for (const slot of slots) maySent.add(slot);
    },
  );
  const sent = {
    maySent,
    heard: tracker.heard,
    sequence: tracker.sequence,
    settled: tracker.settled,
    /** A request the page sent carried this value; read once `settled`. */
    seenSent: (slot: AutofillSlot) => record.submittedSlots.has(slot),
  };
  const { retry } = input;
  const rejectedCodes = new Set(retry.rejectedValues.code ?? []);
  let rejectedFields: readonly AutofillSlot[] = [];
  const recordRejected = (fields: readonly AutofillSlot[]) => {
    rejectedFields = fields;
    for (const field of fields) {
      const logical = logicalRejectedField(field, retry.primary.kind);
      const value = retry.lastFilled[logical];
      if (value === undefined) continue;
      (retry.rejectedValues[logical] ??= new Set()).add(value);
      if (logical === "code") rejectedCodes.add(value);
    }
  };
  const observeRejections = Effect.gen(function* () {
    const observed = yield* recordedRejections(input.browser.markerVisible, steps);
    if (observed !== "unavailable") recordRejected(observed);
    return observed;
  });
  const progress = {
    anythingSent: false,
    chosen: undefined as SignInMethodChoice | undefined,
    ran: [] as AutofillStep[],
    /** The password or code a retry filled a second time, which is never filled again. */
    refilled: new Set<SecretSlot>(),
  };
  const outcome = (reason: string): SignInReplayOutcome => ({
    outcome: progress.anythingSent ? "unclear" : "unsent",
    reason,
    ...(rejectedFields.length === 0 ? {} : { rejectedFields }),
  });
  // The marker as the current page shows it; only the full check opens the account page.
  const onPage = { selector: input.recipe.signedIn.selector, urlPath: input.recipe.signedIn.urlPath };
  return {
    input,
    steps,
    record,
    sent,
    retry,
    rejectedCodes,
    progress,
    outcome,
    observeRejections,
    recordRejected,
    onPage,
    checkHere: input.browser.confirm(onPage, steps, steps),
  };
};
export type ReplaySession<E> = ReturnType<typeof makeReplaySession<E>>;

/** A submitted username or password screen that shows again is rejection evidence for it. */
const returnedCredential = <E>(session: ReplaySession<E>) =>
  Effect.gen(function* () {
    const previous = session.progress.ran.at(-1);
    if (previous === undefined || previous.fields.some((field) => field.slot === "code"))
      return undefined;
    yield* session.sent.settled;
    const field =
      previous.fields.find((one) => one.slot === "password") ??
      previous.fields.find((one) => isIdentifier(one.slot));
    if (field === undefined || !session.sent.seenSent(field.slot)) return undefined;
    const returned = yield* session.input.browser.inspect({
      fields: [field],
      ...(previous.popup === undefined ? {} : { popup: previous.popup }),
    });
    if ("outcome" in returned) return undefined;
    session.recordRejected([field.slot]);
    return field.slot === "password" ? ("password_rejected" as const) : ("username_rejected" as const);
  });

/** The rejection evidence on the page now, read before waiting for a later screen. */
const screenRejection = <E>(
  session: ReplaySession<E>,
  extras: (observed: readonly AutofillSlot[]) => ReturnType<typeof correctReplayExtras<E>>,
) =>
  Effect.gen(function* () {
    const observed = yield* session.observeRejections;
    if (observed === "unavailable") return "ambiguous_combined_rejection" as const;
    const extra = yield* extras(observed);
    if (extra !== undefined) return extra;
    const marked = observed[0];
    if (marked !== undefined && marked !== "code")
      return marked === "password" ? ("password_rejected" as const) : ("username_rejected" as const);
    return yield* returnedCredential(session);
  });

/**
 * The sign-in check after this run's values went out: every identifier and password or code
 * field the replay filled was carried by a request the page sent, no rejection marker shows, and
 * the recipe's check passes.
 */
const verifySignIn = <E>(session: ReplaySession<E>) => (indicator: AutofillSignedIn) =>
  Effect.gen(function* () {
    yield* session.sent.settled;
    const required = session.progress.ran
      .flatMap((step) => step.fields)
      .filter((field) => isIdentifier(field.slot) || provesLogin(field.slot));
    if (required.some((field) => !session.record.submittedSlots.has(field.slot))) return false;
    const rejected = yield* session.observeRejections;
    if (rejected === "unavailable" || rejected.length > 0) return false;
    return (yield* session.input.browser.confirm(indicator, session.steps, session.steps)).signedIn;
  });

const makeReplay = <E>(input: SignInReplayInput<E>) => {
  const session = makeReplaySession(input);
  const run = (
    asked: AutofillStep,
    inspection: Parameters<typeof runReplayStep<E>>[2],
    codeAgain?: "rejected",
    explicitCodeRejection = false,
    corrected: ReadonlySet<AutofillSlot> = new Set(),
  ) => runReplayStep(session, asked, inspection, codeAgain, explicitCodeRejection, corrected);
  const extras = (observed: readonly AutofillSlot[]) => correctReplayExtras(session, run, observed);
  const resolve = (request: AutofillStepRequest) => input.values.resolve(request, input.credentials);
  return {
    session,
    /** The run holds no login yet: this replay is its value-free sign-in check. */
    valueFree: input.credentials === undefined,
    pages: new Set(session.steps.map((step) => step.page)),
    awaitScreen: makeReplayScreenWait(input, session.progress, input.timing, resolve, () =>
      screenRejection(session, extras),
    ),
    runStep: run,
    verify: verifySignIn(session),
    correctExtras: extras,
    resolve,
    shownAgain: (slot: SecretSlot) =>
      shownAgain(input.browser, session.progress.ran, session.sent.maySent, slot),
  };
};
type Replay<E> = ReturnType<typeof makeReplay<E>>;

const originOf = (page: string) => URL.parse(page)?.origin;

/** The recorded screen as it runs now: a method choice clicks the method the owner picks. */
const screenFor = <E>(
  input: SignInReplayInput<E>,
  replay: Replay<E>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly SignInRecipeStep[],
) =>
  Effect.gen(function* () {
    // Each identifier field takes the kind this run's login holds that it accepts.
    const step: AutofillStep = replay.resolve({
      fields: recorded.fields,
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
      ...(recorded.submit === undefined ? {} : { submit: recorded.submit }),
    });
    if (recorded.methods === undefined) return step;
    // The choice screen shows before a method is picked; its first option finds it.
    const popup = recorded.popup === undefined ? {} : { popup: recorded.popup };
    const probe = { fields: [], submit: recorded.methods[0]?.selector ?? "", ...popup };
    const alternatives = recorded.methods
      .slice(1)
      .map((method) => ({ fields: [], submit: method.selector, ...popup }));
    const shown = yield* replay.awaitScreen(probe, until, recorded.page, later, alternatives);
    if (typeof shown === "string" || "outcome" in shown.found) return shown;
    // Picking a method may send a code: a value-free replay stops before it.
    if (replay.valueFree) return valuesNeeded;
    const picked = yield* pickMethod(input.hooks.ask, input.site, recorded.methods);
    replay.session.progress.chosen = picked.method;
    return { fields: [], submit: picked.selector, ...popup };
  });

/** An approval the owner completes off the page, after picking a push method. */
const confirmPush = <E>(input: SignInReplayInput<E>, replay: Replay<E>) =>
  askOne(input.hooks.ask, {
    id: "approved",
    type: "confirm",
    prompt: `Approve the sign-in request ${input.site} sent you, then confirm here.`,
  }).pipe(
    Effect.map((approved) =>
      approved?.type === "confirm" && approved.value.confirmed
        ? ("continue" as const)
        : replay.session.outcome("push_declined"),
    ),
  );

/** Waits for a resolved step's screen, and admits it only on the recorded screen's own origin. */
const awaitRecordedScreen = <E>(
  replay: Replay<E>,
  step: AutofillStep,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly SignInRecipeStep[],
) =>
  Effect.gen(function* () {
    const shown = yield* replay.awaitScreen(step, until, recorded.page, later);
    if (typeof shown === "string")
      return shown === "signed_in" || shown === "skipped" ? shown : replay.session.outcome(shown);
    if ("outcome" in shown.found) return refusedScreen(replay, shown.found);
    // The screen must sit on the recorded screen's own origin, not only on the same site: another
    // tenant's sign-in on a shared domain would pass the site check.
    if (originOf(shown.found.page) !== originOf(recorded.page))
      return replay.session.outcome("screen_origin_changed");
    return { step, inspection: shown.found };
  });

/** A recorded screen the host refused or never found: the replay ends with its reason. */
const refusedScreen = <E>(replay: Replay<E>, refusal: AutofillRefusal) =>
  replay.session.outcome(refusal.reason);

/** Resolves and admits a recorded screen before anything is filled into it. */
const inspectRecordedScreen = <E>(
  input: SignInReplayInput<E>,
  replay: Replay<E>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly SignInRecipeStep[],
) =>
  Effect.gen(function* () {
    const step = yield* screenFor(input, replay, recorded, until, later);
    if (typeof step === "string")
      return step === "signed_in" || step === "skipped" ? step : replay.session.outcome(step);
    if ("found" in step)
      return "outcome" in step.found
        ? refusedScreen(replay, step.found)
        : replay.session.outcome("screen_changed");
    return yield* awaitRecordedScreen(replay, step, recorded, until, later);
  });

/** Fills a recorded screen whose live controls and origin passed inspection. */
const runScreen = <E>(
  input: SignInReplayInput<E>,
  replay: Replay<E>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly SignInRecipeStep[],
) =>
  Effect.gen(function* () {
    const inspected = yield* inspectRecordedScreen(input, replay, recorded, until, later);
    if (typeof inspected === "string" || "outcome" in inspected) return inspected;
    const { step } = inspected;
    let { inspection } = inspected;
    const { session } = replay;
    // The screen shows and needs the login: a value-free replay stops before anything is sent.
    if (replay.valueFree && (recorded.approval !== undefined || step.fields.length > 0))
      return session.outcome(valuesNeeded);
    if (recorded.approval !== undefined) {
      yield* session.sent.settled;
      if (![...session.record.submittedSlots].some(isIdentifier))
        return session.outcome("identifier_not_submitted");
      if (inspection.page !== recorded.page) return session.outcome("screen_changed");
      const answer = yield* askOne(input.hooks.ask, {
        id: "approved",
        type: "confirm",
        prompt:
          recorded.approval === "email_link"
            ? `Open the sign-in link ${input.site} emailed you, then confirm here.`
            : `Approve the sign-in request ${input.site} sent to your device, then confirm here.`,
      });
      if (answer?.type !== "confirm" || !answer.value.confirmed)
        return session.outcome("approval_declined");
      return "continue" as const;
    }
    for (;;) {
      const failed = yield* replay.runStep(step, inspection);
      if (failed === undefined) break;
      // A fieldless step whose submit the page kept disabled typed and clicked nothing, so it
      // waits for its screen again within the screen's own wait. A step with fields ends: the
      // page still wants something besides them.
      if (
        failed !== "submit_stayed_disabled" ||
        step.fields.length > 0 ||
        (yield* Clock.currentTimeMillis) >= until
      )
        return session.outcome(failed);
      const shown = yield* awaitRecordedScreen(replay, step, recorded, until, later);
      if (typeof shown === "string" || "outcome" in shown) return shown;
      inspection = shown.inspection;
    }
    // An approval happens off the page: the owner confirms it, then the screens go on.
    if (session.progress.chosen === "push" && recorded.methods !== undefined)
      return yield* confirmPush(input, replay);
    return "continue" as const;
  });

/** The recorded screens in order, each waited for at most `stepWaitMs`. */
const runScreens = <E>(input: SignInReplayInput<E>, replay: Replay<E>) =>
  Effect.gen(function* () {
    const steps = replay.session.steps;
    for (const [index, recorded] of steps.entries()) {
      const now = yield* Clock.currentTimeMillis;
      const ran = yield* runScreen(
        input,
        replay,
        recorded,
        now + input.timing.stepWaitMs,
        steps.slice(index + 1),
      );
      if (ran === "signed_in") return undefined;
      if (ran !== "continue" && ran !== "skipped") return ran;
    }
    return undefined;
  });

/**
 * Waits, bounded, for the marker to show on the current page. A recipe that checks on an account
 * page stops waiting once the page left the recorded screens and stayed put a moment.
 */
const awaitIndicator = <E>(input: SignInReplayInput<E>, replay: Replay<E>) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + input.timing.stepWaitMs;
    let off: OffScreens | undefined;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= until) return false;
      const check = yield* replay.session.checkHere;
      if (check.signedIn) return true;
      off = stillOff(off, offScreens(replay.pages, check.url), now);
      if (
        input.recipe.signedIn.openPath !== undefined &&
        off !== undefined &&
        now - off.since >= landingSettleMs
      )
        return false;
      yield* Effect.sleep(Duration.millis(input.timing.pollMs));
    }
  });

/**
 * A code screen that came back: the owner gives a new code, never one the site rejected. The
 * screen decides the rest: every other password or code field it shows empty is filled again,
 * and a field that still holds a value is left as it is. A password goes out at most twice.
 */
const retryCode = <E>(input: SignInReplayInput<E>, replay: Replay<E>) =>
  Effect.gen(function* () {
    const { session } = replay;
    const observed = yield* session.observeRejections;
    if (observed === "unavailable") return "ambiguous_combined_rejection";
    const extra = yield* replay.correctExtras(observed);
    if (extra !== undefined) return extra;
    const rejected = observed[0];
    if (rejected === "password") return "password_rejected";
    if (rejected !== undefined && rejected !== "code") return "username_rejected";
    const shown = yield* replay.shownAgain("code");
    if (shown === undefined) return "none" as const;
    session.recordRejected([...observed, "code"]);
    const fields = yield* emptyRetryFields(input.browser, shown, rejected === "code");
    if (typeof fields === "string") return fields;
    const retryStep: AutofillStep = {
      fields,
      ...(shown.popup === undefined ? {} : { popup: shown.popup }),
      ...(shown.submit === undefined ? {} : { submit: shown.submit }),
    };
    const inspected = yield* input.browser.inspect(retryStep);
    if ("outcome" in inspected) return "none" as const;
    return (
      (yield* replay.runStep(retryStep, inspected, "rejected", rejected === "code")) ??
      ("retried" as const)
    );
  });

/** Nothing was sent and the marker shows: the session was already signed in. */
const alreadySignedIn = <E>(input: SignInReplayInput<E>, replay: Replay<E>) =>
  replay
    .verify(input.recipe.signedIn)
    .pipe(
      Effect.map(
        (signedIn): SignInReplayOutcome =>
          signedIn
            ? { outcome: "signed_in", alreadySignedIn: true }
            : replay.session.outcome("indicator_not_visible"),
      ),
    );

/**
 * The full check for a recipe that checks on the landing page, else why the replay did not sign
 * in: `private_answer_rejected` when the security question's screen shows again after its answer
 * went out, `password_rejected` when a request carried the password and the site showed its field
 * again, and the recipe's own failure for a password screen after a submit that may not have sent
 * it (`password_screen_again`) or any other failed check.
 */
const lastCheck = <E>(input: SignInReplayInput<E>, replay: Replay<E>, opened: boolean) =>
  Effect.gen(function* () {
    const { session } = replay;
    if (!opened && (yield* replay.verify(input.recipe.signedIn)))
      return { outcome: "signed_in", alreadySignedIn: false } as const;
    if ((yield* replay.shownAgain("private_answer")) !== undefined)
      return session.outcome("private_answer_rejected");
    if ((yield* replay.shownAgain("password")) === undefined)
      return session.outcome("sign_in_check_failed");
    yield* session.sent.settled;
    const submitted = session.sent.seenSent("password");
    if (submitted) session.recordRejected(["password"]);
    return session.outcome(submitted ? "password_rejected" : "password_screen_again");
  });

/**
 * After the screens, the recipe's own check decides: the marker on the page, a code screen
 * answered again first, then the full check, which may open the account page.
 */
const settle = <E>(input: SignInReplayInput<E>, replay: Replay<E>) =>
  Effect.gen(function* () {
    while (true) {
      const shown = yield* awaitIndicator(input, replay);
      if (!replay.session.progress.anythingSent) return yield* alreadySignedIn(input, replay);
      if (shown && (yield* replay.verify(replay.session.onPage)))
        return { outcome: "signed_in", alreadySignedIn: false } as const;
      // The full check opens the account page first when the recipe names one.
      const opens = input.recipe.signedIn.openPath !== undefined;
      if (opens && (yield* replay.verify(input.recipe.signedIn)))
        return { outcome: "signed_in", alreadySignedIn: false } as const;
      const code = yield* retryCode(input, replay);
      if (code === "retried" || code === "extra_retried") continue;
      if (code !== "none") return replay.session.outcome(code);
      return yield* lastCheck(input, replay, opens);
    }
  });

/**
 * Replays a published sign-in recipe on the run's browser: it opens the entry page, finds and
 * judges each recorded screen (one visible match, its frame and form on the site or a configured
 * sign-in origin, on the recorded screen's own origin), fills and submits it, then checks the
 * recipe's marker. A password or code goes out at most twice, any other secret once, a visible
 * rejection stops before another fill, and only a request the page sent carrying a value counts
 * as sending it. The page's requests are heard only while it runs.
 */
export const replaySignInRecipe = <E>(
  input: SignInReplayInput<E>,
): Effect.Effect<SignInReplayOutcome, E | SignInRunFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const replay = makeReplay(input);
    const stopHearing = input.browser.onRequest(replay.session.sent.heard);
    yield* Effect.addFinalizer(() => Effect.sync(stopHearing));
    yield* input.browser.open(input.entryUrl);
    const stopped = yield* runScreens(input, replay);
    return stopped ?? (yield* settle(input, replay));
  });

/** A field the site rejected that a correction may name, as a run reports it. */
const isRejectedField = (slot: AutofillSlot): slot is CredentialRejectedField =>
  slot !== "private_answer";

/**
 * What a replay that did not sign in with the login leads to: the owner's correction of a
 * rejected username or password, or the run's failure. A rejected code, secondary field or
 * security answer is never corrected here, and any other reason means the recipe no longer
 * matches the site.
 */
const afterRejection = <E>(
  replayed: Exclude<SignInReplayOutcome, { readonly outcome: "signed_in" }>,
  held: WebsiteCredentials,
  retry: ReplayRetryState,
  login: SignInLogin<E>,
) =>
  Effect.gen(function* () {
    const rejected = (field: string) =>
      new SignInRunFailed({ code: "CredentialsRejected", reason: field });
    const { reason } = replayed;
    if (reason === "code_rejected") return yield* rejected("code");
    if (reason === "extra_rejected")
      return yield* rejected(replayed.rejectedFields?.[0] ?? "password");
    if (reason === "private_answer_rejected") return yield* rejected("private_answer");
    if (reason !== "password_rejected" && reason !== "username_rejected")
      return yield* new SignInRunFailed({ code: "RecipeFailed", reason });
    const observed = (
      replayed.rejectedFields ?? [reason === "username_rejected" ? "username" : "password"]
    ).filter(isRejectedField);
    const paired = observed.filter(
      (field) =>
        field === "password" || logicalRejectedField(field, retry.primary.kind) === "username",
    );
    const field = paired[0] ?? observed[0] ?? "password";
    if (paired.length === 0) return yield* rejected(field);
    return yield* correctRejectedLogin({
      fields: paired,
      retry,
      ask: () => login.correct(field, held),
      reject: rejected,
    });
  });

/**
 * Signs a run in with the integration's recipe before its operation runs. It first replays
 * without values and asks nothing when the session already shows signed in. Otherwise it reads
 * the login once (`login`), replays with it, asking for any code, date of birth, ZIP or security
 * answer the screens need (`values`), and corrects a rejected username or password at most twice
 * per field, never sending a rejected value again. Values stay in memory for the run. A recipe it
 * cannot read fails `MissingRecipe`, and an entry page off the site fails before anything opens.
 */
export const signInForRun = <E>(input: {
  readonly recipe: SignInRecipe;
  readonly entryUrl: string;
  readonly browser: SignInReplayBrowser<E>;
  /** The owner's login; a login question left unanswered fails the run `NeedsInput`. */
  readonly login: SignInLogin<unknown>;
  readonly values: SignInValueHooks<E>;
  readonly carries: SecretMatcher;
  /** The site as a question names it. */
  readonly site: string;
  /** The site the run is authorized for, which the entry page must be on. */
  readonly siteOrigin: string;
  readonly timing?: SignInReplayTiming;
}): Effect.Effect<{ readonly alreadySignedIn: boolean }, E | SignInRunFailed> =>
  Effect.gen(function* () {
    const recipe = decodeSignInRecipe(JSON.stringify(input.recipe) ?? "");
    if (recipe === "invalid" || recipe === "unknown_version")
      return yield* new SignInRunFailed({ code: "MissingRecipe", reason: recipe });
    if (!trustedUrl(input.siteOrigin, input.browser.authenticationOrigins, input.entryUrl))
      return yield* new SignInRunFailed({ code: "RecipeFailed", reason: "entry_off_site" });
    const unanswered = () => new SignInRunFailed({ code: "NeedsInput", reason: "login" });
    const login: SignInLogin<SignInRunFailed> = {
      held: input.login.held,
      values: input.login.values.pipe(Effect.mapError(unanswered)),
      correct: (field, held) => input.login.correct(field, held).pipe(Effect.mapError(unanswered)),
    };
    const runLogin = yield* makeRunLogin(login);
    const retry = makeReplayRetryState();
    const values = makeSignInValues(input.values, input.site);
    let held = runLogin.held();
    while (true) {
      const replayed = yield* Effect.scoped(
        replaySignInRecipe({
          recipe,
          browser: input.browser,
          entryUrl: input.entryUrl,
          credentials: held,
          values,
          hooks: input.values,
          carries: input.carries,
          site: input.site,
          retry,
          timing: input.timing ?? defaultReplayTiming,
        }),
      );
      if (replayed.outcome === "signed_in") return { alreadySignedIn: replayed.alreadySignedIn };
      // The value-free check did not find the session signed in: the login is read once, and the
      // sign-in replays again from the entry page.
      if (held === undefined) {
        held = yield* runLogin.values;
        continue;
      }
      held = yield* afterRejection(replayed, held, retry, login);
      runLogin.hold(held);
    }
  });
