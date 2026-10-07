import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit } from "effect";
import type { AutofillPopup, RejectedMarker } from "../destinations/autofill-contracts.js";
import {
  identifierPreference,
  type AutofillField,
  type AutofillSlot,
  type AutofillStep,
  type AutofillStepRequest,
  type IdentifierKind,
} from "../destinations/autofill-step.js";
import { parseDateOfBirth, wholeDateLayouts } from "../destinations/login-field-formats.js";
import {
  Unanswered,
  type PrivateQuestion,
  type SignInLogin,
  type SignInRecipeStep,
  type SignInValue,
  type SignInValueHooks,
} from "../destinations/sign-in-recipe.js";
import type { CredentialRejectedField, WebsiteCredentials } from "./authentication.js";
import type { InputAsker, Question } from "./input-request.js";

/** An identifier a site may ask for besides the username: it picks which account signs in. */
type LoginIdentifierKind = "email" | "phone" | "account_number";
/** A field the owner may be asked for during a sign-in: an identifier, a date of birth or a ZIP. */
type AnsweredLoginField = LoginIdentifierKind | "date_of_birth" | "zip";
/** The fields the owner gave in this build. */
export type AnsweredLoginFields = Partial<Record<AnsweredLoginField, string>>;
/** A field whose rejected value the site may get a correction for. */
export type CorrectionField = AnsweredLoginField | "recovery_code";

const kindNames = {
  email: "email address",
  phone: "phone number",
  account_number: "account number",
} as const;
/** What the host asks the owner for: identifiers of the kinds a field accepts, or one secret. */
type Asked = readonly LoginIdentifierKind[] | "code" | "recovery_code" | "date_of_birth" | "zip";
/** The question for a value the login does not hold. */
const question = (asked: Asked, site: string, notice?: string): Question => {
  if (asked === "code")
    return {
      id: "code",
      type: "secret",
      secretKind: "one_time_code",
      prompt: `${notice === undefined ? "" : `${notice} `}Enter the sign-in code ${site} sent you.`,
    };
  if (asked === "recovery_code")
    return {
      id: "recovery_code",
      type: "secret",
      secretKind: "private_text",
      prompt: `Enter one of your ${site} recovery codes.`,
    };
  if (asked === "date_of_birth")
    return {
      id: "date_of_birth",
      type: "secret",
      secretKind: "private_text",
      prompt: `What's the date of birth on your ${site} account? Enter it as YYYY-MM-DD.`,
    };
  if (asked === "zip")
    return {
      id: "zip",
      type: "secret",
      secretKind: "private_text",
      prompt: `What's the ZIP or postal code on your ${site} account?`,
    };
  return {
    id: asked.join("_or_"),
    type: "text",
    maxLength: 320,
    prompt: `What's the ${asked.map((kind) => kindNames[kind]).join(" or ")} for your ${site} account?`,
  };
};

const emailShaped = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
const phoneShaped = (value: string) =>
  /^\+?[\d\s().-]+$/u.test(value.trim()) && value.replace(/\D/gu, "").length >= 7;

/**
 * The kind of an answer to the kinds a field accepts: an email-shaped answer is an email address,
 * one shaped like a number a phone number when the field takes one, and anything else an account
 * number when it takes one. An answer of no accepted shape has no kind, so the owner is asked
 * again.
 */
const answeredKind = (
  value: string,
  kinds: readonly LoginIdentifierKind[],
): LoginIdentifierKind | undefined => {
  if (kinds.length === 1 && kinds[0] !== "phone") return kinds[0];
  if (kinds.includes("email") && emailShaped(value)) return "email";
  if (kinds.includes("phone") && phoneShaped(value)) return "phone";
  if (kinds.includes("account_number")) return "account_number";
  return kinds.includes("email") ? "email" : undefined;
};

/** A ZIP or postal code the owner typed, trimmed; undefined if it cannot be one. */
const parseZip = (value: string) => {
  const zip = value.trim();
  return zip.length >= 3 && zip.length <= 10 ? zip : undefined;
};

type Kept = "code" | "recovery_code" | AnsweredLoginField;
/** An answer as the field keeps it, and its kind; undefined when it is none the field takes. */
const parsedAnswer = (
  asked: Asked,
  value: string,
): { readonly slot: Kept; readonly value: string } | undefined => {
  if (asked === "code" || asked === "recovery_code") return { slot: asked, value };
  if (asked === "date_of_birth") {
    const date = parseDateOfBirth(value);
    return date === undefined ? undefined : { slot: asked, value: date };
  }
  if (asked === "zip") {
    const zip = parseZip(value);
    return zip === undefined ? undefined : { slot: asked, value: zip };
  }
  const kind = answeredKind(value, asked);
  return kind === undefined ? undefined : { slot: kind, value };
};

/**
 * Asks the owner, in place, for a value the login does not hold, as the same `system` source as
 * every login ask, and masks the answer both as typed and as kept before anything is filled. An
 * answer the field cannot take is asked again, twice at most. `keep` hears each kept answer.
 */
const makeFieldAsk =
  <E>(input: {
    readonly ask: InputAsker;
    readonly register: (slot: AutofillSlot, value: string) => Effect.Effect<void, E>;
    readonly site: string;
    readonly keep?: (kept: { readonly slot: Kept; readonly value: string }) => void;
  }) =>
  (
    asked: Asked,
    notice?: string,
  ): Effect.Effect<Unanswered | { readonly slot: Kept; readonly value: string }, E> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const questions = [question(asked, input.site, notice)];
        const response = yield* Effect.either(
          input.ask({ id: randomUUID(), source: "system", questions }),
        );
        if (response._tag === "Left") return new Unanswered(response.left);
        const answer = response.right[questions[0]?.id ?? "code"];
        if (answer?.type !== "text" && answer?.type !== "secret")
          return new Unanswered("answer_shape");
        const kept = parsedAnswer(asked, answer.value);
        if (kept === undefined) continue;
        yield* input.register(kept.slot, answer.value);
        if (kept.value !== answer.value) yield* input.register(kept.slot, kept.value);
        input.keep?.(kept);
        return kept;
      }
      return new Unanswered("answer_kind");
    });

/** Host-written: why the owner is asked for a code again. */
const codeRejectedNotice = "The site did not accept the last code, so it needs a new one.";

/** The longest prompt a question may have, as the input request allows. */
const promptLimit = 2_000;

/**
 * What the owner is asked for a private answer: the question the page shows, cut to leave room
 * for the site's origin; else that the recorded question could not be read; else the field's label.
 */
const answerPrompt = (siteOrigin: string, field: PrivateQuestion | undefined) => {
  const label = field?.label ?? null;
  if (field?.questionText !== undefined) {
    const suffix = ` (${siteOrigin})`;
    const room = promptLimit - suffix.length;
    const asked =
      field.questionText.length <= room
        ? field.questionText
        : `${field.questionText.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
    return `${asked}${suffix}`;
  }
  if (field?.questionUnread === true)
    return `Enter your security answer for ${siteOrigin}. The question it answers could not be read from the page.${label === null ? "" : ` The answer field reads "${label}".`}`;
  return label === null
    ? `Enter your private answer for ${siteOrigin}.`
    : `${label} (${siteOrigin})`;
};

/**
 * The local host's codes, recovery codes and private answers: it asks the owner each time one is
 * needed, and masks each answer for the session.
 */
export const askingValueHooks = (input: {
  readonly ask: InputAsker;
  readonly register: (value: string) => void;
  /** The site as a question names it: its host, without `www.`. */
  readonly site: string;
  readonly siteOrigin: string;
}): SignInValueHooks<never> => {
  const register = (_slot: AutofillSlot, value: string) => Effect.sync(() => input.register(value));
  const ask = makeFieldAsk({ ask: input.ask, register, site: input.site });
  return {
    ask: input.ask,
    register,
    code: ({ again }) =>
      ask("code", again === "rejected" ? codeRejectedNotice : undefined).pipe(
        Effect.map((kept): SignInValue | Unanswered =>
          kept instanceof Unanswered ? kept : { slot: "code", value: kept.value },
        ),
      ),
    recoveryCode: ask("recovery_code").pipe(
      Effect.map((kept): SignInValue | Unanswered =>
        kept instanceof Unanswered ? kept : { slot: "recovery_code", value: kept.value },
      ),
    ),
    privateAnswer: (field) =>
      Effect.gen(function* () {
        const response = yield* Effect.either(
          input.ask({
            id: randomUUID(),
            source: "system",
            questions: [
              {
                id: "private_answer",
                type: "secret",
                secretKind: "private_text",
                prompt: answerPrompt(input.siteOrigin, field),
                maxLength: 16_384,
              },
            ],
          }),
        );
        if (response._tag === "Left") return new Unanswered(response.left);
        const answer = response.right["private_answer"];
        if (answer?.type !== "secret") return new Unanswered("answer_shape");
        input.register(answer.value);
        return { slot: "private_answer", value: answer.value } satisfies SignInValue;
      }),
  };
};

/** Where an answered field's own value sits in a login. */
const loginFieldKeys = {
  email: "email",
  phone: "phone",
  account_number: "accountNumber",
  date_of_birth: "dateOfBirth",
  zip: "zip",
} as const satisfies Record<AnsweredLoginField, keyof WebsiteCredentials>;

/**
 * Whether a login's username is a username of its own. A login kept without one keeps its primary
 * identifier, an email address, phone number or account number, as its username and under its own
 * key, so a username equal to one of its identifiers is that identifier.
 */
const separateUsername = (login: WebsiteCredentials) =>
  login.username !== "" &&
  login.username !== login.email &&
  login.username !== login.phone &&
  login.username !== login.accountNumber;

/**
 * A field the login holds: its own value, the owner's answer in this build, or, for an email
 * address, an email-shaped username (a site whose usernames are emails). A username of digits is
 * never taken as the phone number: it is as often a member number.
 */
const heldField = (
  field: AnsweredLoginField,
  credentials: WebsiteCredentials,
  given: AnsweredLoginFields,
) =>
  credentials[loginFieldKeys[field]] ??
  given[field] ??
  (field === "email" && emailShaped(credentials.username) ? credentials.username : undefined);

/**
 * The kind the host sends into an identifier field: the first it accepts that the login holds, by
 * `identifierPreference`; else the kind the owner is asked for.
 */
const chosenKind = (
  accepts: readonly IdentifierKind[],
  held: (kind: IdentifierKind) => boolean,
): IdentifierKind =>
  identifierPreference.find((kind) => accepts.includes(kind) && held(kind)) ??
  accepts.find((kind) => kind !== "username") ??
  "username";

/** What one step's values need besides the login. */
export interface StepValueContext {
  readonly credentials: WebsiteCredentials;
  /** The question each field's screen showed, by field, as the host inspected it. */
  readonly questions?: readonly (PrivateQuestion | undefined)[];
  /** Values the site rejected in this build, by field; never filled again. */
  readonly rejected?: Partial<Record<CorrectionField, ReadonlySet<string>>>;
  /** The corrections asked so far, by field: two at most. */
  readonly corrections?: Partial<Record<CorrectionField, number>>;
  /** A code after the site rejected the last: the codes it rejected and the asks so far. */
  readonly code?: {
    readonly again?: "rejected";
    readonly rejected: ReadonlySet<string>;
    readonly requests: { current: number };
  };
}

/**
 * A sign-in's values in field order: the login's username into a `username` slot, its password,
 * an identifier it holds or the owner gave, a date of birth or ZIP, and a code, recovery code or
 * private answer from `hooks`. What the login does not hold is asked of the owner in place, and
 * each answer is masked before any screen can send it. The identifiers, date of birth and ZIP the
 * owner gives are kept for the build (`given`). A rejected value is never filled again: its
 * correction is asked twice at most.
 */
export const makeSignInValues = <E>(hooks: SignInValueHooks<E>, site: string) => {
  let given: AnsweredLoginFields = {};
  const ask = makeFieldAsk({
    ask: hooks.ask,
    register: hooks.register,
    site,
    keep: (kept) => {
      if (kept.slot !== "code" && kept.slot !== "recovery_code")
        given = { ...given, [kept.slot]: kept.value };
    },
  });
  const correctedValue = (
    slot: CorrectionField,
    context: StepValueContext,
    request: () => Effect.Effect<Unanswered | SignInValue, E>,
  ) =>
    Effect.gen(function* () {
      const counts = context.corrections;
      if (counts === undefined) return new Unanswered("correction_history_unavailable");
      while ((counts[slot] ?? 0) < 2) {
        counts[slot] = (counts[slot] ?? 0) + 1;
        const answered = yield* request();
        if (
          answered instanceof Unanswered ||
          context.rejected?.[slot]?.has(answered.value) !== true
        )
          return answered;
      }
      return new Unanswered("field_corrections_exhausted", slot);
    });
  /** A field's value: the login's or the owner's, else asked; a rejected one is corrected. */
  const fieldValue = (slot: AnsweredLoginField, context: StepValueContext) =>
    Effect.gen(function* () {
      const requested: Asked = slot === "date_of_birth" || slot === "zip" ? slot : [slot];
      const rejected = context.rejected?.[slot] ?? new Set<string>();
      if (rejected.size === 0) {
        const held = heldField(slot, context.credentials, given);
        return held === undefined ? yield* ask(requested) : { slot, value: held };
      }
      const fresh = given[slot];
      if (fresh !== undefined && !rejected.has(fresh)) return { slot, value: fresh };
      return yield* correctedValue(slot, context, () => ask(requested));
    });
  /** A date of birth or ZIP, masked; a date in every whole-date layout a page may show it in. */
  const checkedValue = (slot: "date_of_birth" | "zip", context: StepValueContext) =>
    Effect.gen(function* () {
      const answered = yield* fieldValue(slot, context);
      if (answered instanceof Unanswered) return answered;
      const forms = slot === "zip" ? [answered.value] : wholeDateLayouts(answered.value);
      for (const form of forms) yield* hooks.register(slot, form);
      return { slot, value: answered.value };
    });
  /** An identifier besides the username: the login's or the owner's, else one the field takes. */
  const identifierValue = (
    field: AutofillField,
    slot: LoginIdentifierKind,
    context: StepValueContext,
  ) =>
    Effect.gen(function* () {
      if ((context.rejected?.[slot]?.size ?? 0) > 0) return yield* fieldValue(slot, context);
      const stored = heldField(slot, context.credentials, given);
      if (stored !== undefined) return { slot, value: stored };
      return yield* ask(
        (field.accepts ?? [slot]).filter(
          (kind): kind is LoginIdentifierKind => kind !== "username",
        ),
      );
    });
  /** A code, asked again after a rejection twice at most, never one the site rejected. */
  const codeValue = (context: StepValueContext) =>
    Effect.gen(function* () {
      const code = context.code;
      while (true) {
        if (code?.again === "rejected") {
          if (code.requests.current >= 2) return new Unanswered("code_corrections_exhausted");
          code.requests.current += 1;
        }
        const answered = yield* hooks.code(code?.again === "rejected" ? { again: "rejected" } : {});
        if (answered instanceof Unanswered || code?.rejected.has(answered.value) !== true)
          return answered;
        if (code.again !== "rejected") return new Unanswered("code_already_rejected");
      }
    });
  const recoveryValue = (context: StepValueContext) =>
    (context.rejected?.recovery_code?.size ?? 0) === 0
      ? hooks.recoveryCode
      : correctedValue("recovery_code", context, () => hooks.recoveryCode);
  const valueFor = (
    field: AutofillField,
    index: number,
    context: StepValueContext,
  ): Effect.Effect<
    Unanswered | { readonly slot: AutofillField["slot"]; readonly value: string },
    E
  > => {
    const { slot } = field;
    if (slot === "password")
      return Effect.succeed(
        context.credentials.password === undefined
          ? new Unanswered("password_unavailable")
          : { slot, value: context.credentials.password },
      );
    if (slot === "code") return codeValue(context);
    if (slot === "recovery_code") return recoveryValue(context);
    if (slot === "username") return Effect.succeed({ slot, value: context.credentials.username });
    if (slot === "date_of_birth" || slot === "zip") return checkedValue(slot, context);
    if (slot === "private_answer") return hooks.privateAnswer(context.questions?.[index]);
    return identifierValue(field, slot, context);
  };
  return {
    /**
     * The step's values in field order, and the step with the kind each identifier field was sent,
     * which an answer to a field that takes several kinds decides; else why one is missing.
     */
    valuesFor: (step: AutofillStep, context: StepValueContext) =>
      Effect.gen(function* () {
        const values: string[] = [];
        const fields: AutofillField[] = [];
        for (const [index, field] of step.fields.entries()) {
          const found = yield* valueFor(field, index, context);
          if (found instanceof Unanswered) return found;
          values.push(found.value);
          fields.push({ ...field, slot: found.slot });
        }
        return { values, step: { ...step, fields } };
      }),
    /**
     * The step as the host sends it: each identifier field takes the kind `chosenKind` picks.
     * Before the login is given, only the owner's answers count.
     */
    resolve: (
      step: AutofillStepRequest,
      credentials: WebsiteCredentials | undefined,
    ): AutofillStep => ({
      ...step,
      fields: step.fields.map((field) =>
        "slot" in field
          ? field
          : {
              ...field,
              slot: chosenKind(field.accepts, (kind) =>
                credentials === undefined
                  ? kind !== "username" && given[kind] !== undefined
                  : kind === "username"
                    ? separateUsername(credentials)
                    : heldField(kind, credentials, given) !== undefined,
              ),
            },
      ),
    }),
    /** The identifiers, date of birth and ZIP the owner gave in this build. */
    given: () => given,
  };
};

/**
 * The login a run signs in with: none until its value-free check finds a screen that needs it,
 * then read once for the whole run. A read that failed stays failed, so a replay that tries again
 * never asks again, and a correction the owner gives replaces what the run holds.
 */
export const makeRunLogin = <E>(login: SignInLogin<E>) =>
  Effect.gen(function* () {
    let held = login.held();
    const read = yield* Effect.cached(
      login.values.pipe(
        Effect.tap((values) =>
          Effect.sync(() => {
            held ??= values;
          }),
        ),
      ),
    );
    return {
      held: () => held,
      values: Effect.suspend(() => (held === undefined ? read : Effect.succeed(held))),
      hold: (values: WebsiteCredentials) => {
        held = values;
      },
    };
  });

/**
 * What a run's sign-in keeps across its replays, in memory only: the value each field last went
 * out with, the values the site rejected, which are never filled again, the corrections asked so
 * far, the codes asked and filled after a rejection, and the identifier field the login's username
 * went into, which counts as the username.
 */
export interface ReplayRetryState {
  readonly rejectedValues: Partial<Record<AutofillSlot, Set<string>>>;
  readonly lastFilled: Partial<Record<AutofillSlot, string>>;
  readonly correctionRequests: Partial<Record<AutofillSlot, number>>;
  readonly codeRequests: { current: number };
  readonly codeAttempts: { current: number };
  readonly primary: { kind?: IdentifierKind };
}

export const makeReplayRetryState = (): ReplayRetryState => ({
  rejectedValues: {},
  lastFilled: {},
  correctionRequests: {},
  codeRequests: { current: 0 },
  codeAttempts: { current: 0 },
  primary: {},
});

/** A rejected field as corrections count it: the field the login's username went into is its username. */
export const logicalRejectedField = (
  slot: RejectedMarker["slot"] | AutofillSlot,
  primaryKind?: IdentifierKind,
) => (slot === primaryKind ? "username" : slot);

/**
 * The fields the recipe's recorded rejection markers show now, credentials before codes, each
 * once; `unavailable` when any marker could not be read, so a partial reading never decides. A
 * marker only says whether its selector shows, never what the page says.
 */
export const recordedRejections = <E>(
  markerVisible: (
    selector: string,
    page: string,
    popup?: AutofillPopup,
  ) => Effect.Effect<boolean, E>,
  steps: readonly SignInRecipeStep[],
): Effect.Effect<readonly RejectedMarker["slot"][] | "unavailable"> =>
  Effect.gen(function* () {
    const markers = steps
      .flatMap((step) =>
        (step.rejectedMarkers ?? []).map((marker) => ({
          marker,
          page: step.page,
          popup: step.popup,
        })),
      )
      .sort(
        (left, right) => Number(left.marker.slot === "code") - Number(right.marker.slot === "code"),
      );
    const rejected = new Set<RejectedMarker["slot"]>();
    for (const { marker, page, popup } of markers) {
      const visible = yield* Effect.exit(
        Effect.suspend(() => markerVisible(marker.selector, page, popup)),
      );
      if (Exit.isFailure(visible)) {
        if (Cause.isInterrupted(visible.cause)) return yield* Effect.interrupt;
        return "unavailable" as const;
      }
      if (visible.value) rejected.add(marker.slot);
    }
    return [...rejected];
  });

/**
 * The owner's correction of a login the site rejected (`fields`, the username or the password):
 * both fields are asked together, at most twice per field in the run, and asked again while the
 * answer repeats a value the site rejected, which is never sent. Once a field's corrections run
 * out, the run fails with `reject` for it.
 */
export const correctRejectedLogin = <E, F>(input: {
  readonly fields: readonly CredentialRejectedField[];
  readonly retry: ReplayRetryState;
  readonly ask: () => Effect.Effect<WebsiteCredentials, E>;
  readonly reject: (field: CredentialRejectedField) => F;
}): Effect.Effect<WebsiteCredentials, E | F> =>
  Effect.gen(function* () {
    const { retry } = input;
    const logical = [
      ...new Set(
        input.fields
          .map((slot) => logicalRejectedField(slot, retry.primary.kind))
          .filter((slot) => slot === "username" || slot === "password"),
      ),
    ];
    const rejectedUsernames = retry.rejectedValues.username ?? new Set<string>();
    const rejectedPasswords = retry.rejectedValues.password ?? new Set<string>();
    while (
      logical.length > 0 &&
      logical.every((field) => (retry.correctionRequests[field] ?? 0) < 2)
    ) {
      for (const field of logical)
        retry.correctionRequests[field] = (retry.correctionRequests[field] ?? 0) + 1;
      const answer = yield* input.ask();
      if (
        !rejectedUsernames.has(answer.username) &&
        (answer.password === undefined || !rejectedPasswords.has(answer.password))
      )
        return answer;
    }
    const exhausted = input.fields.find(
      (field) =>
        (retry.correctionRequests[logicalRejectedField(field, retry.primary.kind)] ?? 0) >= 2,
    );
    return yield* Effect.fail(input.reject(exhausted ?? input.fields[0] ?? "password"));
  });
