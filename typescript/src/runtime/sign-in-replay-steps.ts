import { randomUUID } from "node:crypto";
import { Clock, Data, Duration, Effect } from "effect";
import { maySend, typingRefusal } from "../destinations/autofill-refusal.js";
import type { AutofillPopup, SignInMethodChoice } from "../destinations/autofill-contracts.js";
import type {
  AutofillInspection,
  AutofillSlot,
  AutofillStep,
  AutofillStepReport,
  AutofillStepRequest,
  SecretSlot,
} from "../destinations/autofill-step.js";
import {
  armStep,
  isExtraSecret,
  isIdentifier,
  isSecret,
  provesLogin,
  recordStep,
  Unanswered,
  type SecretMatcher,
  type SignInBrowser,
  type SignInRecipe,
  type SignInRecipeStep,
  type SignInValueHooks,
} from "../destinations/sign-in-recipe.js";
import type { WebsiteCredentials } from "./authentication.js";
import { pickedOption, type InputAsker, type Question } from "./input-request.js";
import {
  logicalRejectedField,
  type makeSignInValues,
  type ReplayRetryState,
} from "./sign-in-values.js";
import type { ReplaySession } from "./sign-in-replay.js";

// One replay of a published sign-in recipe: its contract and the pieces of one screen.

const spoken = (reason: string | undefined) => (reason ?? "login").replaceAll("_", " ");
const runFailureMessages = {
  CredentialsRejected: (reason: string | undefined) =>
    `The website rejected the ${spoken(reason)} given for this sign-in, and the run sends it no more. Run the tool again with the right value.`,
  NeedsInput: () =>
    "The sign-in needs an answer that was not given, so the run stopped before the tool ran.",
  RecipeFailed: (reason: string | undefined) =>
    `The saved sign-in no longer matches the website (${spoken(reason)}). Build the tool again to record its sign-in.`,
  MissingRecipe: (reason: string | undefined) =>
    `The tool's saved sign-in can't be read (${spoken(reason)}), so the tool doesn't run signed out. Build the tool again.`,
} as const;

/** Why a run could not sign in, value-free. The run fails with it and never runs signed out. */
export class SignInRunFailed extends Data.TaggedError("SignInRunFailed")<{
  /**
   * `CredentialsRejected`: the site rejected a value given for the sign-in, once its corrections
   * ran out or for a value that is never corrected. `NeedsInput`: a question the sign-in needs
   * went unanswered. `RecipeFailed`: the recorded sign-in no longer matches the site.
   * `MissingRecipe`: the integration's recipe cannot be read.
   */
  readonly code: "CredentialsRejected" | "NeedsInput" | "RecipeFailed" | "MissingRecipe";
  /** A finite reason: the rejected field, the replay's reason, or why the recipe is unreadable. */
  readonly reason?: string;
}> {
  override get message() {
    return runFailureMessages[this.code](this.reason);
  }
}

/** The browser a run's sign-in replays on: the recorder's, which also opens and reads markers. */
export interface SignInReplayBrowser<E> extends SignInBrowser<E> {
  /** Opens the recipe's entry page on the run's tab. */
  readonly open: (url: string) => Effect.Effect<void, E>;
  /** Whether a recorded rejection marker shows on its screen's page, never what it says. */
  readonly markerVisible: (
    selector: string,
    page: string,
    popup?: AutofillPopup,
  ) => Effect.Effect<boolean, E>;
}

/**
 * How a replay ended: `signed_in` once the host checked the recipe's marker after this run's
 * values went out, or `alreadySignedIn` when the session showed it signed in before any value was
 * sent; `unsent` when nothing reached the site; `unclear` when something may have reached it.
 */
export type SignInReplayOutcome =
  | { readonly outcome: "signed_in"; readonly alreadySignedIn: boolean }
  | {
      readonly outcome: "unsent" | "unclear";
      readonly reason: string;
      readonly rejectedFields?: readonly AutofillSlot[];
    };

/**
 * How a replay waits: up to `stepWaitMs` for each recorded screen to show, and `pollMs` between
 * looks. Sign-in pages are often slow. The recipe's finite screens, the per-field correction and
 * code bounds and the owner's answers bound the rest.
 */
export interface SignInReplayTiming {
  readonly stepWaitMs: number;
  readonly pollMs: number;
}
export const defaultReplayTiming: SignInReplayTiming = { stepWaitMs: 30_000, pollMs: 250 };

/**
 * Why a value-free replay stopped: the screen it reached needs the login, which the run reads
 * before it replays again from the entry page.
 */
export const valuesNeeded = "values_needed";

/** The login's values in field order, as a run resolves them. */
export type SignInValues<E> = ReturnType<typeof makeSignInValues<E>>;

export interface SignInReplayInput<E> {
  readonly recipe: SignInRecipe;
  readonly browser: SignInReplayBrowser<E>;
  /** Where the replay starts: the published entry page. */
  readonly entryUrl: string;
  /**
   * The login, or undefined while the run holds none: the replay is then the run's value-free
   * check. It checks the session and runs fieldless screens as ever, and stops unsent
   * (`valuesNeeded`) at the first screen that needs a value, a method choice or an approval.
   */
  readonly credentials: WebsiteCredentials | undefined;
  readonly values: SignInValues<E>;
  readonly hooks: SignInValueHooks<E>;
  readonly carries: SecretMatcher;
  /** The site as a question names it. */
  readonly site: string;
  readonly retry: ReplayRetryState;
  readonly timing: SignInReplayTiming;
}

/** The recipe's screens, as every version holds them. */
export const recipeSteps = (recipe: SignInRecipe): readonly SignInRecipeStep[] => recipe.steps;

/** Asks the owner one host-written question; an unanswered one stops the sign-in. */
export const askOne = (ask: InputAsker, question: Question) =>
  ask({ id: randomUUID(), source: "system", questions: [question] }).pipe(
    Effect.mapError(() => new SignInRunFailed({ code: "NeedsInput", reason: question.id })),
    Effect.map((answers) => answers[question.id]),
  );

/** How the owner reads each recorded two-factor method. */
export const methodLabels: Record<SignInMethodChoice, string> = {
  sms: "Text message",
  call: "Phone call",
  email: "Email",
  totp: "Authenticator app",
  push: "Push notification",
  recovery_code: "Recovery code",
};

/** The method a choice screen picks: the owner's answer to a choice of the recorded methods. */
export const pickMethod = (
  ask: InputAsker,
  site: string,
  methods: NonNullable<SignInRecipeStep["methods"]>,
) =>
  Effect.gen(function* () {
    const options = methods.map((option, index) => ({
      id: `option_${index}`,
      label: methodLabels[option.method],
    }));
    const answer = yield* askOne(ask, {
      id: "method",
      type: "choice",
      prompt: `How should ${site} confirm it's you?`,
      options,
    });
    const chosen = answer?.type === "choice" ? pickedOption(answer.value) : undefined;
    const picked = methods[options.findIndex((option) => option.id === chosen)];
    if (picked !== undefined) return picked;
    return yield* new SignInRunFailed({ code: "NeedsInput", reason: "method" });
  });

/** Why a fill did not complete its screen, or undefined when it did. */
export const fillFailure = (step: AutofillStep, report: AutofillStepReport) => {
  if (typingRefusal(step, report)?.cause === "question_changed") return "question_changed";
  if (report.outcome !== "filled") return report.reason;
  if (report.fields.some((field) => field.status !== "filled")) return "fill_failed";
  return report.submit === "clicked" || report.submit === "none"
    ? undefined
    : `submit_${report.submit}`;
};

/**
 * Whether a step would fill a secret that may have gone out already beyond what a retry of a
 * rejected code allows: a password or code once more each, so either goes out at most twice; a
 * date of birth, ZIP, recovery code or private answer never again.
 */
export const refillRefused = (
  step: AutofillStep,
  maySent: ReadonlySet<SecretSlot>,
  refilled: ReadonlySet<SecretSlot>,
  codeAgain: "rejected" | undefined,
  corrected: ReadonlySet<AutofillSlot>,
) =>
  step.fields.some(
    (field) =>
      isSecret(field.slot) &&
      maySent.has(field.slot) &&
      !corrected.has(field.slot) &&
      !(
        codeAgain === "rejected" &&
        (field.slot === "code" || (provesLogin(field.slot) && !refilled.has(field.slot)))
      ),
  );

/** Records each secret a step may have sent, and those it sent a second time. */
export const noteMaySent = (
  step: AutofillStep,
  sentBefore: ReadonlySet<SecretSlot>,
  maySent: Set<SecretSlot>,
  refilled: Set<SecretSlot>,
) => {
  for (const field of step.fields) {
    if (!isSecret(field.slot)) continue;
    if (sentBefore.has(field.slot)) refilled.add(field.slot);
    maySent.add(field.slot);
  }
};

/** The fields of `fields` the page shows empty, inspected one at a time without any value. */
export const emptyReplayFields = <E>(
  browser: SignInReplayBrowser<E>,
  fields: AutofillStep["fields"],
  popup?: AutofillStep["popup"],
) =>
  Effect.forEach(fields, (field) =>
    browser
      .inspect({ fields: [field], ...(popup === undefined ? {} : { popup }) })
      .pipe(
        Effect.map((found) =>
          !("outcome" in found) && found.targets.fields[0]?.empty === true ? field : undefined,
        ),
      ),
  ).pipe(Effect.map((found) => found.filter((field) => field !== undefined)));

/**
 * The fields a code screen that came back is filled with again: its code, and each password field
 * it shows empty. A combined screen whose password field emptied with no marker saying which half
 * the site rejected is ambiguous.
 */
export const emptyRetryFields = <E>(
  browser: SignInReplayBrowser<E>,
  shown: AutofillStep,
  codeRejected: boolean,
) =>
  Effect.gen(function* () {
    const fields: AutofillStep["fields"][number][] = [];
    for (const field of shown.fields) {
      if (field.slot === "code") fields.push(field);
      else if (provesLogin(field.slot)) {
        const empty = yield* emptyReplayFields(browser, [field], shown.popup);
        if (empty.length > 0) {
          if (field.slot === "password" && !codeRejected) return "ambiguous_combined_rejection";
          fields.push(field);
        }
      }
    }
    return fields;
  });

/** The last step that took `slot`, when it may have sent it and the page shows its field again. */
export const shownAgain = <E>(
  browser: SignInReplayBrowser<E>,
  ran: readonly AutofillStep[],
  maySent: ReadonlySet<SecretSlot>,
  slot: SecretSlot,
) =>
  Effect.gen(function* () {
    const step = ran.findLast((candidate) => candidate.fields.some((field) => field.slot === slot));
    const field = step?.fields.find((candidate) => candidate.slot === slot);
    if (step === undefined || field === undefined || !maySent.has(slot)) return undefined;
    const inspected = yield* browser.inspect({
      fields: [field],
      ...(step.popup === undefined ? {} : { popup: step.popup }),
    });
    return "outcome" in inspected ? undefined : step;
  });

/** A page's origin and path, as a recorded screen's page is kept. */
const pageOf = (url: string | undefined) => {
  const at = URL.parse(url ?? "");
  return at === null ? undefined : `${at.origin}${at.pathname}`;
};

/** Whether a page is neither a recorded screen nor the entry: the session went past the sign-in. */
export const leftSignInScreens = (
  pages: ReadonlySet<string>,
  entryUrl: string,
  url: string | undefined,
) => {
  const here = pageOf(url);
  return here !== undefined && !pages.has(here) && here !== pageOf(entryUrl);
};

/** How long a page off the recorded screens must stay put before the account-page check opens. */
export const landingSettleMs = 1_500;
/** The page's address when it is none of the recorded screens. */
export const offScreens = (pages: ReadonlySet<string>, url: string | undefined) => {
  const here = pageOf(url);
  return here === undefined || pages.has(here) ? undefined : url;
};
/** A page off the recorded screens and since when it showed. */
export type OffScreens = { readonly url: string; readonly since: number };
/** The page off the recorded screens and since when it showed, or undefined while on them. */
export const stillOff = (previous: OffScreens | undefined, url: string | undefined, now: number) =>
  url === undefined ? undefined : previous?.url === url ? previous : { url, since: now };

/**
 * Whether an account-page recipe can stop waiting for a screen: the session left the sign-in's
 * screens, at once when nothing was sent, after a submit once the page stayed put a moment.
 */
export const settledSessionLanding = (
  openPath: string | undefined,
  off: OffScreens | undefined,
  sent: boolean,
  now: number,
) => openPath !== undefined && off !== undefined && (!sent || now - off.since >= landingSettleMs);

/** A later recorded screen or ready fields of one prove the replay moved on; a same-page button cannot. */
const inspectReplayProgression = <E>(
  browser: SignInReplayBrowser<E>,
  currentPage: string,
  current: AutofillStep,
  alternatives: readonly AutofillStep[],
  later: readonly SignInRecipeStep[],
  resolve: (request: AutofillStepRequest) => AutofillStep,
) =>
  Effect.gen(function* () {
    for (const alternative of alternatives) {
      const found = yield* browser.inspect(alternative);
      if (!("outcome" in found)) return { found } as const;
    }
    for (const recorded of later) {
      const probes =
        recorded.methods === undefined
          ? [resolve(recorded)]
          : recorded.methods.map((method) => ({
              fields: [],
              submit: method.selector,
              ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
            }));
      for (const probe of probes) {
        const found = yield* browser.inspect(probe);
        if (
          !("outcome" in found) &&
          found.page === recorded.page &&
          (found.page !== currentPage ||
            (current.fields.length > 0 &&
              probe.fields.some(
                (field) => !current.fields.some((previous) => previous.selector === field.selector),
              )))
        )
          return { next: recorded } as const;
      }
    }
    return undefined;
  });

/**
 * Waits for a recorded screen to be ready, or for evidence of a later screen or a landing: the
 * recipe's marker on the page, or for an account-page recipe a page off the screens. Rejection
 * evidence (`rejection`) is read before each wait.
 */
export const makeReplayScreenWait = <E, Rejection extends string = never>(
  input: {
    readonly browser: SignInReplayBrowser<E>;
    readonly recipe: SignInRecipe;
    readonly entryUrl: string;
  },
  progress: { readonly anythingSent: boolean },
  timing: SignInReplayTiming,
  resolve: (request: AutofillStepRequest) => AutofillStep,
  rejection?: () => Effect.Effect<Rejection | undefined, E | SignInRunFailed>,
) => {
  const { browser, recipe } = input;
  const steps = recipeSteps(recipe);
  const pages = new Set(steps.map((step) => step.page));
  const onPage = { selector: recipe.signedIn.selector, urlPath: recipe.signedIn.urlPath };
  const checkHere = browser.confirm(onPage, steps, steps);
  const now = Clock.currentTimeMillis;
  const pause = Effect.sleep(Duration.millis(timing.pollMs));
  const inspectStage = (
    step: AutofillStep,
    currentPage: string,
    later: readonly SignInRecipeStep[],
    alternatives: readonly AutofillStep[],
  ) =>
    Effect.gen(function* () {
      const inspected = yield* browser.inspect(step);
      if (!("outcome" in inspected)) return { found: inspected } as const;
      if (
        inspected.reason !== "not_found" &&
        inspected.reason !== "not_editable" &&
        inspected.reason !== "popup_missing"
      )
        return { found: inspected } as const;
      if (rejection !== undefined) {
        const rejected = yield* rejection();
        if (rejected !== undefined) return rejected;
      }
      const progressed = yield* inspectReplayProgression(
        browser,
        currentPage,
        step,
        alternatives,
        later,
        resolve,
      );
      if (progressed?.found !== undefined) return { found: progressed.found } as const;
      if (progressed !== undefined) return "skipped" as const;
      return { waiting: inspected } as const;
    });
  return (
    step: AutofillStep,
    until: number,
    currentPage: string,
    later: readonly SignInRecipeStep[] = [],
    alternatives: readonly AutofillStep[] = [],
  ) =>
    Effect.gen(function* () {
      let off: OffScreens | undefined;
      while (true) {
        const stage = yield* inspectStage(step, currentPage, later, alternatives);
        if (stage === "extra_retried") continue;
        if (typeof stage === "string") return stage;
        if (stage.found !== undefined) return { found: stage.found } as const;
        const here = yield* checkHere;
        // Leaving the screens ends the wait for an account-page recipe: at once before anything
        // was sent, after a submit once the page off them stayed put, so a passing page between
        // two screens is waited out while a skipped screen is not, and the full check decides.
        off = stillOff(off, leftSignInScreens(pages, input.entryUrl, here.url) ? here.url : undefined, yield* now);
        if (
          here.signedIn ||
          settledSessionLanding(recipe.signedIn.openPath, off, progress.anythingSent, yield* now)
        )
          return "signed_in" as const;
        // A bounded wait without observed progress stops the replay.
        if ((yield* now) >= until) return { found: stage.waiting } as const;
        yield* pause;
      }
    });
};

/** Each code a step filled, which a fresh code request never takes again. */
const noteCodeValues = (rejectedCodes: Set<string>, step: AutofillStep, filled: readonly string[]) => {
  for (const [index, field] of step.fields.entries())
    if (field.slot === "code" && filled[index] !== undefined) rejectedCodes.add(filled[index]);
};

/**
 * Records the value each field went out with, for later rejection evidence, and counts a code
 * filled after a rejection. A private answer is never kept: it is asked on every sign-in.
 */
const recordFilledValues = <E>(
  session: ReplaySession<E>,
  step: AutofillStep,
  filled: readonly string[],
  codeAgain: "rejected" | undefined,
) => {
  const { retry } = session;
  for (const [index, field] of step.fields.entries()) {
    const value = filled[index];
    if (value !== undefined && field.slot !== "private_answer")
      retry.lastFilled[logicalRejectedField(field.slot, retry.primary.kind)] = value;
  }
  if (codeAgain === "rejected" && step.fields.some((field) => field.slot === "code"))
    retry.codeAttempts.current += 1;
};

/** A step the retry rules refuse: a third code after two rejected, or a secret filled too often. */
const retryRefusal = <E>(
  session: ReplaySession<E>,
  asked: AutofillStep,
  codeAgain: "rejected" | undefined,
  explicitCodeRejection: boolean,
  corrected: ReadonlySet<AutofillSlot>,
) => {
  const { retry, sent, progress } = session;
  if (
    codeAgain === "rejected" &&
    asked.fields.some((field) => field.slot === "code") &&
    retry.codeAttempts.current >= 2
  )
    return "code_rejected" as const;
  if (refillRefused(asked, sent.maySent, progress.refilled, codeAgain, corrected))
    return codeAgain === "rejected" && explicitCodeRejection
      ? "code_rejected"
      : "credential_already_filled";
  return undefined;
};

/**
 * One inspected screen filled and submitted with this run's values. Returns why it did not
 * complete, or undefined when it did. Only a request the page sent carrying a value counts as
 * sending it; a submit that may have sent one counts against the fill allowance.
 */
export const runReplayStep = <E>(
  session: ReplaySession<E>,
  asked: AutofillStep,
  inspection: AutofillInspection,
  codeAgain?: "rejected",
  explicitCodeRejection = false,
  corrected: ReadonlySet<AutofillSlot> = new Set(),
) =>
  Effect.gen(function* () {
    const { input, retry, sent, progress, record } = session;
    const { credentials } = input;
    // A value-free replay stops before any screen with a field.
    if (credentials === undefined && asked.fields.length > 0) return valuesNeeded;
    codeAgain ??= retry.rejectedValues.code?.size ? "rejected" : undefined;
    const refused = retryRefusal(session, asked, codeAgain, explicitCodeRejection, corrected);
    if (refused !== undefined) return refused;
    const resolved =
      credentials === undefined
        ? { values: [] as string[], step: asked }
        : yield* input.values.valuesFor(asked, {
            credentials,
            questions: inspection.screen.fields,
            rejected: retry.rejectedValues,
            corrections: retry.correctionRequests,
            code: {
              ...(codeAgain === undefined ? {} : { again: codeAgain }),
              rejected: session.rejectedCodes,
              requests: retry.codeRequests,
            },
          });
    if (resolved instanceof Unanswered) {
      if (corrected.size > 0) return "extra_rejected";
      if (codeAgain === "rejected") return "code_rejected";
      return yield* new SignInRunFailed({ code: "NeedsInput", reason: "sign_in_value" });
    }
    // The kinds the fields were sent as: an answer to a field that accepts several decides.
    const { values: filled, step } = resolved;
    return yield* Effect.gen(function* () {
      noteCodeValues(session.rejectedCodes, step, filled);
      step.fields.forEach((field, index) => {
        if (isIdentifier(field.slot) && filled[index] === credentials?.username)
          retry.primary.kind ??= field.slot;
      });
      // What went out before this fill; the tracker credits this fill's own request as it hears it.
      const sentBefore = new Set(sent.maySent);
      armStep(
        record,
        step,
        inspection,
        filled,
        sent.sequence(),
        input.browser.authenticationOrigins,
      );
      const report = yield* input.browser.fill({ step, values: filled, inspection });
      if (recordStep(record, step, report))
        for (const field of step.fields)
          if (isExtraSecret(field.slot)) sent.maySent.add(field.slot);
      if (step.fields.length > 0 && maySend(report)) {
        recordFilledValues(session, step, filled, codeAgain);
        progress.anythingSent = true;
        noteMaySent(step, sentBefore, sent.maySent, progress.refilled);
      }
      progress.ran.push(step);
      return fillFailure(step, report);
    }).pipe(
      // A private answer is discarded after its fill.
      Effect.ensuring(
        Effect.sync(() => {
          step.fields.forEach((field, index) => {
            if (field.slot === "private_answer") filled[index] = "";
          });
        }),
      ),
    );
  });

/** Corrects only visibly rejected secondary fields on the screen that took them. */
export const correctReplayExtras = <E>(
  session: ReplaySession<E>,
  run: (
    asked: AutofillStep,
    inspection: AutofillInspection,
    codeAgain?: "rejected",
    explicitCodeRejection?: boolean,
    corrected?: ReadonlySet<AutofillSlot>,
  ) => ReturnType<typeof runReplayStep<E>>,
  observed: readonly AutofillSlot[],
) =>
  Effect.gen(function* () {
    const { input, progress, retry } = session;
    // A username or password correction replays the sign-in again; it decides those.
    if (
      observed.some(
        (slot) =>
          slot === "password" || logicalRejectedField(slot, retry.primary.kind) === "username",
      )
    )
      return undefined;
    const extras = new Set<AutofillSlot>(observed.filter((slot) => slot !== "code"));
    if (extras.size === 0) return undefined;
    const previous = progress.ran.findLast((step) =>
      step.fields.some((field) => extras.has(field.slot)),
    );
    if (previous === undefined) return "extra_rejected" as const;
    const fields = previous.fields.filter((field) => extras.has(field.slot));
    if (
      fields.length !== extras.size ||
      fields.some((field) => !retry.rejectedValues[field.slot]?.size)
    )
      return "extra_rejected" as const;
    // A screen with a recovery code may clear that one-use code when another field is rejected:
    // a fresh one is asked, never the one already used.
    const corrected = new Set(extras);
    const emptyRecovery = yield* emptyReplayFields(
      input.browser,
      previous.fields.filter((field) => field.slot === "recovery_code" && !corrected.has(field.slot)),
      previous.popup,
    );
    for (const field of emptyRecovery) {
      fields.push(field);
      corrected.add(field.slot);
    }
    const retryStep: AutofillStep = {
      fields,
      ...(previous.popup === undefined ? {} : { popup: previous.popup }),
      ...(previous.submit === undefined ? {} : { submit: previous.submit }),
    };
    const inspected = yield* input.browser.inspect(retryStep);
    if ("outcome" in inspected) return "extra_rejected" as const;
    return (yield* run(retryStep, inspected, undefined, false, corrected)) ?? "extra_retried";
  });
