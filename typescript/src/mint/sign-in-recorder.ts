import { randomUUID } from "node:crypto";
import { Effect, Schema, type Scope } from "effect";
import { maySend, typingRefusal } from "../destinations/autofill-refusal.js";
import type {
  AutofillInspection,
  AutofillScreens,
  AutofillSignedIn,
  AutofillStep,
  AutofillStepReport,
  IdentifierKind,
  SecretSlot,
} from "../destinations/autofill-step.js";
import {
  armStep,
  isExtraSecret,
  isIdentifier,
  isSecret,
  keepProvingOrigins,
  makeSentTracker,
  namedUntrustedOrigins,
  openSignInRecord,
  provesLogin,
  recordStep,
  SignInRecipe,
  signInRecipe,
  trustOrigin,
  Unanswered,
  type SecretMatcher,
  type SignInBrowser,
  type SignInLogin,
  type SignInRecord,
  type SignInValueHooks,
} from "../destinations/sign-in-recipe.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import { makeSignInValues, type AnsweredLoginFields } from "../runtime/sign-in-values.js";
import { MintFailure, type SignInStep } from "./contracts.js";
import { autofillRefusalFailure } from "./sign-in-failure.js";

/** What one sign-in step gave the minter, and what it means for the build. */
export interface SignInStepResult {
  /** What the minter reads besides the screen's report. */
  readonly result: Readonly<Record<string, unknown>>;
  /** The screen's report, after the host inspected it and maybe filled it. */
  readonly report?: AutofillStepReport;
  /** The check showed the site signed in once the sign-in sent the login: it is verified. */
  readonly verified?: true;
  /** The owner completed the sign-in's approval. */
  readonly approved?: true;
  /**
   * The check found the open sign-in's login sent only to these origins, off the site and its
   * trusted sign-in origins, each an exact origin; `result` names them for the minter too.
   */
  readonly untrustedSignInOrigins?: readonly string[];
}

/** A verified sign-in's value-free recipe and the address its runs start from. */
export interface PublishedSignIn {
  readonly recipe: SignInRecipe;
  readonly entryUrl: string;
}

const recovery = "then inspect read-only and correct the sign-in steps from the page's evidence";

/** A step the host refused before touching the page: it typed and asked nothing. */
const refusedStep = (
  reason:
    | "credential_already_filled"
    | "nothing_rejected"
    | "selector_names_contact"
    | "page_names_contact",
  target: number,
  nextStep: string,
): SignInStepResult => ({ result: { step: { outcome: "refused", reason, target }, nextStep } });

const filledNotices = {
  failed:
    "The host filled the fields, but its click of the submit failed. You may click that one submit yourself in an explore, and nothing else: never read, change or return a field the host filled. Then continue with the next signInStep, or signedIn.",
  none: "The host filled the fields; the screen has no button. Explore read-only to see what it revealed, then send the next signInStep for it.",
  clicked:
    "The host filled the fields and clicked the submit. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
  not_attempted:
    "A field could not be filled, so the host did not submit. Explore read-only to see why, then correct the step.",
  refused:
    "The host filled the fields, but afterwards a field or the submit no longer sat or submitted where the host judged it (page code moved the form or changed how it submits), so the host did not click, or stopped the submission as it fired. Never click it yourself: inspect the changed form and correct the sign-in step.",
  stayed_disabled:
    "The host filled the fields, but the page kept the submit disabled through the host's wait for it to be enabled, so the host never clicked it. Never click it yourself: explore read-only to see what the page still needs before it enables the submit, such as another field, a checkbox or a choice (never read a field the host filled), then correct the sign-in step.",
} as const;

/** What the minter does after a screen the host inspected and maybe filled. */
const stepNotice = (report: AutofillStepReport) => {
  if (report.outcome === "refused")
    return `The host typed and clicked nothing (${report.reason}), so nothing reached the site and no sign-in was spent. Correct the step from the page's evidence, ${recovery}.`;
  if (report.outcome === "uncertain")
    return `The host lost the fill call's answer: the fields and the submit may have reached the site. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep, ${recovery}.`;
  return filledNotices[report.submit];
};

/** A check before this sign-in's requests carried the login proves nothing about this build. */
const credentialsNotSubmitted = {
  signedIn: false,
  failed: "credentials_not_submitted",
  nextStep:
    "No sign-in step since the last verified sign-in sent the login's identifier with a password, a code or a completed approval, so the host cannot take this page as signed in. A verified sign-in is over, so checking it again counts for nothing. Send the sign-in screens' signInSteps first, then check again.",
} as const;

/**
 * The same check when the page's sign-in request carried the login only to `origins`, off the site
 * and its trusted sign-in origins: it names each exact origin, never a path, query or value, so
 * the caller can trust it for sign-in.
 */
const loginSentOffSite = (origins: readonly string[]) => ({
  ...credentialsNotSubmitted,
  untrustedSignInOrigins: origins,
  nextStep:
    "The page's sign-in request carried the login to the origins in untrustedSignInOrigins, which are neither this site nor one of the build's sign-in origins, so the host did not count it as sent and cannot take this page as signed in. Signing in again sends it there again. Tell the caller which origin received the login. A build counts a login sent there only once that origin is one of its sign-in origins.",
});

const identifierUnobserved: SignInStepResult = {
  result: {
    step: { outcome: "refused", reason: "login_identifier_unobserved" },
    nextStep:
      "Inspect the site's sign-in entry and provide its identifier step before requesting a secret. No credential was requested or sent.",
  },
};

/** The login's identifiers this build knows, lowercased: what a published selector never names. */
const identityValues = (
  held: WebsiteCredentials | undefined,
  given: AnsweredLoginFields,
  known: Iterable<string>,
) =>
  [
    held?.username,
    held?.email,
    held?.phone,
    held?.accountNumber,
    given.email,
    given.phone,
    given.account_number,
    ...known,
  ].flatMap((value) => (value === undefined || value.length < 3 ? [] : [value.toLowerCase()]));

/** Whether a text names a known identity value, or the placeholder the minter saw for one. */
const namesIdentity = (text: string, values: readonly string[]) => {
  const lower = text.toLowerCase();
  return values.some((value) => lower.includes(value)) || lower.includes("[private]");
};

/**
 * A selector that copies a masked contact detail, as choice buttons show one ("Text (***) ***-1234",
 * "j•••@example.com"): a run of mask characters, or four or more digits in a row.
 */
const namesContact = (selector: string) => /[*•●]{2,}|\d{4,}/u.test(selector);

/** A refusal of a method choice whose selector copies a masked contact detail, or undefined. */
const maskedMethodRefusal = (step: Pick<AutofillStep, "methods" | "submit">) => {
  if (step.methods === undefined) return undefined;
  const masked = step.methods.findIndex((option) => namesContact(option.selector));
  if (masked === -1 && !namesContact(step.submit ?? "")) return undefined;
  return refusedStep(
    "selector_names_contact",
    Math.max(masked, 0),
    "A method's selector publishes with the tool, so it never names the masked phone number or address the option shows. Name each option by its method's own words or a stable attribute, and send the step again.",
  );
};

/**
 * A refusal of a screen whose recorded selectors, submit or page name this account's identity, or
 * undefined: the recipe ships each one with the tool. Nothing is typed before it.
 */
const stepIdentityRefusal = (step: AutofillStep, page: string, values: readonly string[]) => {
  const selectors = [
    ...(step.rejectedMarkers ?? []).map((marker) => marker.selector),
    ...step.fields.flatMap((field) =>
      field.questionSelector === undefined
        ? [field.selector]
        : [field.selector, field.questionSelector],
    ),
    ...(step.submit === undefined ? [] : [step.submit]),
    ...(step.methods ?? []).map((option) => option.selector),
  ];
  const named = selectors.findIndex((selector) => namesIdentity(selector, values));
  if (named !== -1)
    return refusedStep(
      "selector_names_contact",
      named,
      "A screen's selectors and submit publish with the tool, so they never name this account's username, email, phone or account number (such as a \"Continue as …\" button or a data attribute holding it). Name each control by its role, label or a stable attribute, and send the step again.",
    );
  // An address may carry a value percent-encoded, such as an email's `@` as `%40`.
  const encoded = values.map((value) => encodeURIComponent(value).toLowerCase());
  if (namesIdentity(page, [...values, ...encoded]))
    return refusedStep(
      "page_names_contact",
      0,
      "This screen's address names this account's identity, and the recipe would publish it with the tool, so the host typed nothing. Use an account-independent route and inspect its sign-in screens.",
    );
  return undefined;
};

/** A signed-in check that names the account's own identity: it ships and runs for every login. */
const indicatorHoldsIdentity = {
  signedIn: false,
  failed: "indicator_holds_identity",
  nextStep: `The signed-in check names this account's own identity, which publishes with the tool and fails for every other login. Name a marker every signed-in account shows, such as a sign-out control or the account menu, never the account's name, email or number, ${recovery}.`,
} as const;

/** A web address a run can open, without credentials or fragment; undefined for anything else. */
const entryOf = (url: string | undefined) => {
  const parsed = URL.parse(url ?? "");
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
    return undefined;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.href;
};

/** The sign-in fails as rejected: the host already asked for its correction, or cannot. */
const rejection = (
  cause: "site_rejected" | "equal_correction" | "rejected_password_held",
  field: CredentialRejectedField = "password",
) =>
  new MintFailure({
    code: "CredentialsRejected",
    rejectedCredential: field,
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "autofill.rejected",
      phase: "sign_in",
      context: { cause },
    }),
  });

const unansweredFailure = ({ cause }: Unanswered) =>
  new MintFailure({
    code: "Unavailable",
    ...(cause instanceof InputRequestFailure && cause.code === "NoResponse"
      ? { noResponse: { possibleCommit: false } }
      : {}),
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "autofill.ask",
      phase: "sign_in_input",
      error: cause,
    }),
  });

/** A field the site may reject that holds a secret, which the host may have filled. */
const secretField = (field: CredentialRejectedField) =>
  field === "password" ||
  field === "code" ||
  field === "date_of_birth" ||
  field === "zip" ||
  field === "recovery_code";

/** An open sign-in, with where its runs would start and whether an exploration typed its code. */
type OpenSignIn = SignInRecord & { readonly entry: string | undefined; codeTyped?: true };

/**
 * Records a build's sign-in screen by screen, as the host fills it: each screen is inspected,
 * reviewed (`review`) and checked for this account's identity before anything is typed, its values
 * come from the login (`login`, asked once when needed) and the value hooks, and a value counts as
 * sent only once a request the page sent carried it (`carries`). A signed-in check verifies the
 * sign-in only after a request carried its identifier with a password or code, or after an
 * approval or a code an exploration typed; then the sign-in's value-free recipe is what the build
 * publishes, while no later sign-in started (`published`). A password or code is filled twice at
 * most in one sign-in, any other secret once. A value the site rejected is never filled again: a
 * code gets two fresh ones, the login one correction in place, an identifier, date of birth, ZIP or
 * recovery code a fresh answer on its next screen. `refuseIndicator` may refuse a check the page
 * passed, keeping the sign-in open. The host hears the page's requests only while a sign-in is
 * open, and never past the scope.
 */
export const makeSignInRecorder = <E>(input: {
  readonly browser: SignInBrowser<E>;
  readonly login: SignInLogin<E>;
  readonly values: SignInValueHooks<E>;
  readonly review: (step: AutofillStep, seen: AutofillInspection) => Effect.Effect<void, E>;
  /** The site as a question names it: its host, without `www.`. */
  readonly site: string;
  readonly carries: SecretMatcher;
  readonly refuseIndicator?: (
    indicator: AutofillSignedIn,
  ) => Readonly<Record<string, unknown>> | undefined;
}): Effect.Effect<
  {
    readonly step: (
      step: SignInStep,
      loginUrl: string | undefined,
      beforeFill: Effect.Effect<void, E>,
    ) => Effect.Effect<SignInStepResult, MintFailure | E>;
    readonly codeTyped: () => void;
    readonly screens: () => {
      readonly screens: AutofillScreens;
      readonly challengeScreens: AutofillScreens;
    };
    readonly published: () => PublishedSignIn | undefined;
    readonly untrustedOrigins: () => readonly string[];
    readonly trustOrigins: (origins: readonly string[]) => void;
    readonly namedOrigins: (named: readonly string[]) => readonly string[];
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { browser, login, values: hooks } = input;
    const values = makeSignInValues(hooks, input.site);
    let open: OpenSignIn | undefined;
    let stopHearing: (() => void) | undefined;
    /** Sign-ins whose screens reached the site; a verified one publishes while it is the latest. */
    let signIns = 0;
    let verified:
      | {
          readonly recipe: SignInRecipe;
          readonly entry: string | undefined;
          readonly signIn: number;
        }
      | undefined;
    /** The latest login URL the minter gave, which runs open rather than the first screen's address. */
    let loginUrl: string | undefined;
    /** Every screen the build filled, and where the current sign-in's start. */
    const screens: AutofillScreens[number][] = [];
    let signInStart = 0;
    /** Secrets the sign-in filled that may have reached the site, and those filled once more. */
    const filled = new Set<SecretSlot>();
    const refilled = new Set<SecretSlot>();
    /** Each field's last value a fill may have sent, by field; in memory only. */
    const sent = new Map<CredentialRejectedField, string>();
    /** The kind of identifier field the login's username went into. */
    let primaryKind: IdentifierKind | undefined;
    /** Values the site rejected in this build, by field; never filled again. */
    const rejected: Partial<Record<CredentialRejectedField, Set<string>>> = {};
    const corrections: Partial<Record<CredentialRejectedField, number>> = {};
    const code: {
      again?: "rejected";
      readonly rejected: Set<string>;
      readonly requests: { current: number };
    } = {
      rejected: new Set(),
      requests: { current: 0 },
    };
    let codeRejected = false;
    let loginCorrected = false;

    const tracker = makeSentTracker(
      () => open,
      input.carries,
      (slots) => {
        for (const slot of slots) filled.add(slot);
      },
    );
    /** The origins the caller trusted for the open sign-in that received its password or code. */
    const trustedProving = new Set<string>();
    const close = () => {
      stopHearing?.();
      stopHearing = undefined;
      open = undefined;
      trustedProving.clear();
    };
    yield* Effect.addFinalizer(() => Effect.sync(close));

    /** A rejected field as the build tracks it: the username's own field counts as the username. */
    const logical = (field: CredentialRejectedField): CredentialRejectedField =>
      field === primaryKind ? "username" : field;
    const wasSent = (field: CredentialRejectedField) =>
      sent.has(logical(field)) || (secretField(field) && filled.has(field as SecretSlot));

    /** The field of `step` naming a secret this sign-in may not fill again, or -1. */
    const exhaustedSecret = (step: AutofillStep) =>
      step.fields.findIndex(
        (field) =>
          isSecret(field.slot) &&
          field.slot !== "private_answer" &&
          filled.has(field.slot) &&
          (!provesLogin(field.slot) || refilled.has(field.slot)),
      );

    const unansweredStep = (unanswered: Unanswered) => {
      if (
        codeRejected &&
        (unanswered.cause === "code_corrections_exhausted" ||
          unanswered.cause === "code_already_rejected")
      )
        return Effect.fail(rejection("site_rejected", "code"));
      if (
        unanswered.cause === "field_corrections_exhausted" &&
        (unanswered.field === "date_of_birth" || unanswered.field === "zip")
      )
        return Effect.fail(rejection("site_rejected", unanswered.field));
      return Effect.fail(unansweredFailure(unanswered));
    };

    /** The screen as the signed-in check reads it: each field with what named its control. */
    const screenOf = (step: AutofillStep, inspected: AutofillInspection) => ({
      ...step,
      fields: step.fields.map((item, index) => {
        const named = inspected.screen.fields[index];
        return named === undefined
          ? item
          : {
              ...item,
              identity: {
                label: named.label,
                ariaLabel: named.ariaLabel,
                placeholder: named.placeholder,
                type: named.type,
                autocomplete: named.autocomplete,
                name: named.name,
                id: named.id,
              },
            };
      }),
    });

    const fill = (
      request: Extract<SignInStep, { readonly fields: unknown }>,
      beforeFill: Effect.Effect<void, E>,
    ) => {
      let filledValues: string[] = [];
      let step: AutofillStep = { ...request, fields: [] };
      return Effect.gen(function* () {
        const masked = maskedMethodRefusal(request);
        if (masked !== undefined) return masked;
        let held = login.held();
        step = values.resolve(request, held);
        if (
          step.fields.some((field) => field.slot === "password") &&
          held?.password !== undefined &&
          rejected.password?.has(held.password) === true
        )
          return yield* rejection("rejected_password_held");
        // A password or code this sign-in already filled is filled once more at most: a page error
        // may have kept the first from the site, but the site may have rejected it, and sending it
        // a third time risks a lockout.
        const again = exhaustedSecret(step);
        if (again !== -1) {
          if (codeRejected && step.fields.some((field) => field.slot === "code"))
            return yield* rejection("site_rejected", "code");
          const slot = step.fields[again]?.slot ?? "password";
          return refusedStep(
            "credential_already_filled",
            again,
            `The host already filled this login's ${slot} ${provesLogin(slot) ? "twice" : "once"} in this sign-in and never fills it again, so it typed nothing: if the site did not sign in, count it as a possible rejection. Explore read-only to see the page; send signedIn if the page shows the site signed in, ${recovery}.`,
          );
        }
        const refills = step.fields
          .map((field) => field.slot)
          .filter((slot): slot is SecretSlot => isSecret(slot) && filled.has(slot));
        const inspected = yield* browser.inspect(step);
        if ("outcome" in inspected)
          return { report: inspected, result: { nextStep: stepNotice(inspected) } };
        const entry = open === undefined ? entryOf(inspected.url ?? inspected.page) : undefined;
        yield* input.review(step, inspected);
        if (
          held === undefined &&
          step.fields.length > 0 &&
          !step.fields.some((field) => field.accepts !== undefined)
        )
          return identifierUnobserved;
        yield* beforeFill;
        if (held === undefined && step.fields.length > 0) {
          held = yield* login.values;
          step = values.resolve(request, held);
        }
        const valued =
          held === undefined
            ? { values: [] as string[], step }
            : yield* values.valuesFor(step, {
                credentials: held,
                questions: inspected.screen.fields,
                rejected,
                corrections,
                code,
              });
        if (valued instanceof Unanswered) return yield* unansweredStep(valued);
        step = valued.step;
        filledValues = valued.values;
        const named = stepIdentityRefusal(
          step,
          inspected.page,
          identityValues(held, values.given(), [
            ...[...sent].flatMap(([field, value]) => (isIdentifier(field) ? [value] : [])),
            ...step.fields.flatMap((field, index) =>
              isIdentifier(field.slot) ? [filledValues[index] ?? ""] : [],
            ),
          ]),
        );
        if (named !== undefined) return named;
        // A value the site rejected is never sent again, whoever gave it.
        const recorded = step.fields.flatMap((field, index) => {
          const value = filledValues[index];
          return field.slot === "private_answer" || value === undefined
            ? []
            : [{ field: field.slot, value }];
        });
        for (const { field, value } of recorded)
          if (isIdentifier(field) && value === held?.username) primaryKind ??= field;
        for (const { field, value } of recorded)
          if (rejected[logical(field)]?.has(value) === true)
            return yield* rejection("equal_correction", field);
        const previous = new Map(sent);
        for (const { field, value } of recorded) sent.set(logical(field), value);
        const opened = open === undefined;
        if (open === undefined) {
          open = { ...openSignInRecord(), entry };
          signIns += 1;
          stopHearing = browser.onRequest(tracker.heard);
        }
        const record = open;
        armStep(
          record,
          step,
          inspected,
          filledValues,
          tracker.sequence(),
          browser.authenticationOrigins,
        );
        const report = yield* browser.fill({ step, values: filledValues, inspection: inspected });
        yield* tracker.settled;
        // A fill refused or not attempted cannot have sent what it held.
        step.fields.forEach((field, index) => {
          if (
            field.slot === "private_answer" ||
            (report.outcome !== "refused" &&
              !(report.outcome === "filled" && report.fields[index]?.status === "not_attempted"))
          )
            return;
          const key = logical(field.slot);
          const before = previous.get(key);
          if (before === undefined) sent.delete(key);
          else sent.set(key, before);
        });
        screens.push(screenOf(step, inspected));
        // A first screen that reached nothing leaves no sign-in open.
        const reached = recordStep(record, step, report);
        if (!reached) {
          if (opened) {
            close();
            signIns -= 1;
          }
        } else {
          for (const slot of refills) refilled.add(slot);
          for (const field of step.fields)
            if (isExtraSecret(field.slot) && field.slot !== "private_answer")
              filled.add(field.slot);
          if (step.fields.some((field) => field.slot === "code")) delete code.again;
        }
        // A host click after the fill, or a lost answer, may have sent every filled secret.
        if (maySend(report)) {
          record.mayHaveSent = true;
          for (const slot of record.pending.keys()) if (isSecret(slot)) filled.add(slot);
        }
        const refusal = typingRefusal(step, report);
        if (refusal !== undefined)
          return yield* autofillRefusalFailure(refusal, {
            nothingSubmitted: record.mayHaveSent !== true && record.submittedSlots.size === 0,
          });
        return { report, result: { nextStep: stepNotice(report) } };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // A private answer is discarded after its fill.
            step.fields.forEach((field, index) => {
              if (field.slot === "private_answer") filledValues[index] = "";
            });
          }),
        ),
      );
    };

    const approval = (step: Extract<SignInStep, { readonly approval: unknown }>) =>
      Effect.gen(function* () {
        yield* tracker.settled;
        const record = open;
        if (record === undefined || ![...record.submittedSlots].some(isIdentifier))
          return {
            result: {
              approved: false,
              failed: "identifier_not_submitted",
              nextStep:
                "Send the identifier screen first, then request protected confirmation of the site's email link or device approval.",
            },
          };
        const shown = yield* browser.inspect({
          fields: [],
          ...(step.popup === undefined ? {} : { popup: step.popup }),
        });
        if ("outcome" in shown) return { result: { approved: false, failed: shown.reason } };
        const answered = yield* Effect.either(
          hooks.ask({
            id: randomUUID(),
            source: "system",
            questions: [
              {
                id: "approved",
                type: "confirm",
                prompt:
                  step.approval === "email_link"
                    ? "Open the sign-in link the site emailed you, then confirm here."
                    : "Approve the site's sign-in request on your device, then confirm here.",
              },
            ],
          }),
        );
        if (answered._tag === "Left")
          return yield* unansweredFailure(new Unanswered(answered.left));
        const answer = answered.right["approved"];
        if (answer?.type !== "confirm" || !answer.value.confirmed)
          return { result: { approved: false, failed: "approval_declined" } };
        record.steps.push({
          page: shown.page,
          fields: [],
          approval: step.approval,
          ...(step.popup === undefined ? {} : { popup: step.popup }),
        });
        return {
          approved: true as const,
          result: {
            approved: true,
            nextStep:
              "Explore read-only to find the site's signed-in indicator, then send signedIn. The confirmation alone does not verify sign-in.",
          },
        };
      });

    /**
     * The site said a field was wrong. Only a value this sign-in may have sent can be rejected.
     * A code gets a fresh one until three were rejected; the login gets one correction in place,
     * which starts the sign-in again; any other field a fresh answer on its next screen.
     */
    const rejectedStep = (slot: CredentialRejectedField) =>
      Effect.gen(function* () {
        if (!wasSent(slot))
          return refusedStep(
            "nothing_rejected",
            0,
            `No ${slot} was sent in this sign-in, so there is nothing for the site to have rejected. Explore read-only to see the page, then send the next signInStep.`,
          );
        const key = logical(slot);
        const value = sent.get(key);
        if (value !== undefined) (rejected[key] ??= new Set()).add(value);
        if (secretField(slot)) filled.delete(slot as SecretSlot);
        if (slot === "code") {
          codeRejected = true;
          code.again = "rejected";
          if (value !== undefined) code.rejected.add(value);
          if ((rejected.code?.size ?? 0) >= 3) return yield* rejection("site_rejected", "code");
          return {
            result: {
              rejected: "code",
              nextStep:
                "The host will ask the owner for a new code at the next code step. Send the code screen's signInStep again.",
            },
          };
        }
        if (key !== "username" && slot !== "password")
          return {
            result: {
              rejected: slot,
              nextStep:
                "The host will ask for a fresh correction of that field on its next sign-in screen. Send that screen's signInStep again.",
            },
          };
        const held = login.held();
        if (loginCorrected || held === undefined) return yield* rejection("site_rejected", slot);
        loginCorrected = true;
        const corrected = yield* login.correct(slot, held);
        // A correction equal to the rejected value is the second rejection: it is never sent.
        const repeated =
          slot === "password"
            ? corrected.password !== undefined &&
              rejected.password?.has(corrected.password) === true
            : rejected.username?.has(corrected.username) === true;
        if (repeated) return yield* rejection("equal_correction", slot);
        // A changed password starts its own send allowance; a new identifier alone does not.
        if (corrected.password !== undefined && corrected.password !== sent.get("password")) {
          filled.delete("password");
          refilled.delete("password");
        }
        // The rejected sign-in is over: the next screen starts a new one.
        close();
        return {
          result: {
            corrected: true,
            nextStep:
              "The owner gave a corrected login. Start the sign-in screens again from the login page: send each screen's signInStep, then signedIn.",
          },
        };
      });

    const signedIn = (indicator: AutofillSignedIn) =>
      Effect.gen(function* () {
        yield* tracker.settled;
        const record = open;
        const carried = [...(record?.submittedSlots ?? [])];
        if (
          record === undefined ||
          !carried.some(isIdentifier) ||
          (!carried.some(provesLogin) &&
            !record.steps.some((step) => step.approval !== undefined) &&
            record.codeTyped !== true)
        )
          return record?.untrustedOrigins === undefined
            ? { result: credentialsNotSubmitted }
            : {
                result: loginSentOffSite(namedUntrustedOrigins(record)),
                untrustedSignInOrigins: namedUntrustedOrigins(record),
              };
        const named = identityValues(
          login.held(),
          values.given(),
          [...sent].flatMap(([field, value]) => (isIdentifier(field) ? [value] : [])),
        );
        if (
          namesIdentity(
            [indicator.selector, indicator.urlPath, indicator.openPath]
              .filter((part) => part !== undefined)
              .join(" "),
            named,
          )
        )
          return { result: indicatorHoldsIdentity };
        const checked = yield* browser.confirm(indicator, screens, screens.slice(signInStart));
        if (!checked.signedIn) return { result: checked };
        const refused = input.refuseIndicator?.(indicator);
        if (refused !== undefined) return { result: refused };
        signInStart = screens.length;
        verified = {
          recipe: signInRecipe(record.steps, indicator),
          entry: loginUrl ?? record.entry,
          signIn: signIns,
        };
        close();
        filled.clear();
        refilled.clear();
        codeRejected = false;
        return { result: checked, verified: true as const };
      });

    return {
      /**
       * Runs one sign-in step: a screen, an approval, a rejected field or a signed-in check.
       * `loginUrl` is the minter's login route, which runs open; `beforeFill` runs once the screen
       * passed its review, before the host asks for or types anything.
       */
      step: (step: SignInStep, given: string | undefined, beforeFill: Effect.Effect<void, E>) =>
        Effect.suspend((): Effect.Effect<SignInStepResult, MintFailure | E> => {
          loginUrl = entryOf(given) ?? loginUrl;
          if ("fields" in step) return fill(step, beforeFill);
          if ("approval" in step) return approval(step);
          if ("rejected" in step) return rejectedStep(step.rejected.slot);
          return signedIn(step.signedIn);
        }),
      /**
       * An exploration typed a code the site sent for the sign-in under way, on the site or a
       * configured sign-in origin: it proves the open sign-in as a code the host fills does.
       */
      codeTyped: () => {
        if (open !== undefined) open.codeTyped = true;
      },
      /** The screens a signed-in check reads now: every screen, and the current sign-in's. */
      screens: () => ({ screens: [...screens], challengeScreens: screens.slice(signInStart) }),
      /**
       * The origins off the site and its sign-in origins that the open sign-in's requests carried
       * the login to, as a check names them, whether or not one ran; none once it is over.
       */
      untrustedOrigins: () => (open === undefined ? [] : namedUntrustedOrigins(open)),
      /**
       * What a build names to its caller: the origins its checks named since the last verified
       * sign-in (`named`), then the open sign-in's own, each once, filtered as a check filters
       * them now (`keepProvingOrigins`). An early check may have named an origin that heard the
       * identifier alone, before another received the password.
       */
      namedOrigins: (named: readonly string[]) =>
        keepProvingOrigins(
          [...new Set([...named, ...(open === undefined ? [] : namedUntrustedOrigins(open))])],
          open,
          trustedProving,
        ),
      /**
       * The caller trusted `origins` for this sign-in: what the open sign-in sent there counts as
       * sent, and its next check may verify it. Nothing is typed again, and a secret credited
       * this way counts as filled, as one the request rule credited does.
       */
      trustOrigins: (origins: readonly string[]) => {
        if (open === undefined) return;
        for (const origin of origins) {
          const credited = trustOrigin(open, origin);
          if (credited.some(provesLogin)) trustedProving.add(origin);
          for (const slot of credited) filled.add(slot);
        }
      },
      /** The latest verified sign-in, while no later sign-in reached the site; else none. */
      published: () => {
        if (verified === undefined || verified.signIn !== signIns) return undefined;
        const { recipe, entry } = verified;
        return entry === undefined || !Schema.is(SignInRecipe)(recipe)
          ? undefined
          : { recipe, entryUrl: entry };
      },
    };
  });
