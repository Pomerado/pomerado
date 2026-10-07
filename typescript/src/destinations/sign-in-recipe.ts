import { Deferred, Effect, Either, FiberId, Option, Schema } from "effect";
import {
  AutofillApproval,
  AutofillPopup,
  DateControl,
  DateOfBirthFormat,
  IdentifierKinds,
  maximumStepFields,
  RejectedMarker,
  SecretSlots,
  SignInMethodChoice,
} from "./autofill-contracts.js";
import type {
  AutofillField,
  AutofillInspection,
  AutofillRefusal,
  AutofillScreens,
  AutofillSignedIn,
  AutofillSignedInCheck,
  AutofillSlot,
  AutofillStep,
  AutofillStepReport,
  ExtraSecretSlot,
  IdentifierKind,
  SecretSlot,
} from "./autofill-step.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import type { InputAsker } from "../runtime/input-request.js";
import { sameSite } from "../runtime/same-site.js";

/** The file a minted tool's sign-in recipe ships as, beside its source. */
export const signInRecipePath = "auth-fill.json";

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/**
 * A recorded field: an identifier field by every kind it accepts, which each run resolves against
 * its own login, or a secret field by its slot.
 */
const RecipeField = Schema.Union(
  Schema.Struct({
    selector: Selector,
    accepts: Schema.Array(IdentifierKinds).pipe(Schema.minItems(1), Schema.maxItems(4)),
  }),
  Schema.Struct({
    selector: Selector,
    slot: SecretSlots,
    format: Schema.optional(DateOfBirthFormat),
    control: Schema.optional(DateControl),
  }),
);

/**
 * One recorded sign-in screen: the page it ran on (origin and path), the fields the host filled by
 * slot, and the control that submitted them, clicked by the host or, after a missed host click, by
 * the minter. A two-factor method choice records every method the screen offered, each with the
 * control that picks it, and its `submit` is the one the mint picked.
 */
const RecipeStep = Schema.Struct({
  rejectedMarkers: Schema.optional(
    Schema.Array(RejectedMarker).pipe(Schema.maxItems(maximumStepFields)),
  ),
  page: Schema.String.pipe(Schema.maxLength(2_000)),
  fields: Schema.Array(RecipeField).pipe(Schema.maxItems(maximumStepFields)),
  submit: Schema.optional(Selector),
  submittedBy: Schema.optional(Schema.Literal("host", "minter")),
  methods: Schema.optional(
    Schema.Array(Schema.Struct({ method: SignInMethodChoice, selector: Selector })).pipe(
      Schema.minItems(1),
      Schema.maxItems(8),
    ),
  ),
});

/**
 * A verified sign-in, value-free: selectors, slots, submits and pages, and the indicator the minter
 * found and the host checked. A run replays it with the host's own fill. `version` is what a run
 * checks before replaying: a host that does not know it refuses the recipe rather than dropping
 * step metadata or typing into a different page.
 */
export const SignInRecipeV1 = Schema.Struct({
  version: Schema.Literal(1),
  steps: Schema.Array(RecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  /**
   * The deterministic check that the sign-in worked: a marker on the page it lands on, or on the
   * account page `openPath` the host opens first.
   */
  signedIn: Schema.Struct({
    selector: Schema.optional(Selector),
    urlPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
    openPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  }),
});
const PopupRecipeStep = Schema.Struct({
  ...RecipeStep.fields,
  popup: Schema.optional(AutofillPopup),
  approval: Schema.optional(AutofillApproval),
});
/** Version 2 keeps a host that does not know it from dropping popup metadata. */
export const SignInRecipeV2 = Schema.Struct({
  ...SignInRecipeV1.fields,
  version: Schema.Literal(2),
  steps: Schema.Array(PopupRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
});
const QuestionRecipeStep = Schema.Struct({
  ...PopupRecipeStep.fields,
  fields: Schema.Array(
    Schema.Union(
      RecipeField.members[0],
      Schema.Struct({
        ...RecipeField.members[1].fields,
        questionSelector: Schema.optional(Selector),
      }).pipe(
        Schema.filter(
          (field) => field.questionSelector === undefined || field.slot === "private_answer",
          { message: () => "only a private answer names a question selector" },
        ),
      ),
    ),
  ).pipe(Schema.maxItems(maximumStepFields)),
});
/**
 * Version 3 adds a private answer's `questionSelector`, which a run reads again before it fills
 * the answer: a host that does not know it refuses the recipe rather than dropping that check.
 */
export const SignInRecipeV3 = Schema.Struct({
  ...SignInRecipeV1.fields,
  version: Schema.Literal(3),
  steps: Schema.Array(QuestionRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
});
export const SignInRecipe = Schema.Union(SignInRecipeV1, SignInRecipeV2, SignInRecipeV3);
export type SignInRecipe = typeof SignInRecipe.Type;
export type SignInRecipeStep = typeof QuestionRecipeStep.Type;

const knownVersions: readonly unknown[] = [1, 2, 3];
/** Whether a recipe's steps name any question selector, which only version 3 holds. */
const namesQuestion = (recipe: object) => {
  const steps: unknown = Reflect.get(recipe, "steps");
  return (
    Array.isArray(steps) &&
    steps.some((step: unknown) => {
      const fields: unknown =
        typeof step === "object" && step !== null ? Reflect.get(step, "fields") : undefined;
      return (
        Array.isArray(fields) &&
        fields.some(
          (field: unknown) =>
            typeof field === "object" && field !== null && "questionSelector" in field,
        )
      );
    })
  );
};

/**
 * A published recipe file read back: the recipe, `unknown_version` for a version this host does
 * not know, else `invalid`. A version 1 or 2 recipe naming a question selector is invalid, since a
 * host reading it as that version would drop the question's check.
 */
export const decodeSignInRecipe = (text: string): SignInRecipe | "invalid" | "unknown_version" => {
  const parsed = Schema.decodeUnknownEither(Schema.parseJson())(text);
  if (Either.isLeft(parsed) || typeof parsed.right !== "object" || parsed.right === null)
    return "invalid";
  const version: unknown = Reflect.get(parsed.right, "version");
  if (typeof version === "number" && !knownVersions.includes(version)) return "unknown_version";
  if (version !== 3 && namesQuestion(parsed.right)) return "invalid";
  return Option.getOrElse(
    Schema.decodeUnknownOption(SignInRecipe)(parsed.right),
    () => "invalid" as const,
  );
};

/**
 * One screen of a sign-in as the host ran it, value-free: what a run replays. `submittedBy` is
 * `minter` when the host's click failed and the minter clicked it itself.
 */
export interface RecordedSignInStep {
  readonly popup?: AutofillPopup | undefined;
  readonly approval?: AutofillApproval | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  /** With each identifier field's accepted kinds, never a value. */
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  readonly submittedBy?: "host" | "minter" | undefined;
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillStep["methods"];
  /** The page the step ran on, origin and path only. */
  readonly page: string;
}

/**
 * A recorded screen as the recipe ships it: an identifier field by the kinds it accepts, never the
 * kind this login sent, which each run resolves against its own login. Only a private answer keeps
 * its question selector. Nothing else a host held of the screen ships.
 */
export const recipeStep = (step: RecordedSignInStep): SignInRecipeStep => ({
  page: step.page,
  ...(step.approval === undefined ? {} : { approval: step.approval }),
  ...(step.popup === undefined ? {} : { popup: step.popup }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
  fields: step.fields.map((field) =>
    isSecret(field.slot)
      ? {
          selector: field.selector,
          slot: field.slot,
          ...(field.format === undefined ? {} : { format: field.format }),
          ...(field.control === undefined ? {} : { control: field.control }),
          ...(field.slot !== "private_answer" || field.questionSelector === undefined
            ? {}
            : { questionSelector: field.questionSelector }),
        }
      : { selector: field.selector, accepts: field.accepts ?? [field.slot] },
  ),
  ...(step.submit === undefined ? {} : { submit: step.submit }),
  ...(step.submittedBy === undefined ? {} : { submittedBy: step.submittedBy }),
  ...(step.methods === undefined ? {} : { methods: step.methods }),
});

/**
 * A verified sign-in's recipe in the lowest version that holds every step: version 3 only with a
 * question selector, else version 2 only with a popup or an approval, else version 1.
 */
export const signInRecipe = (
  steps: readonly RecordedSignInStep[],
  signedIn: AutofillSignedIn,
): SignInRecipe => {
  const shipped = steps.map(recipeStep);
  const indicator = {
    ...(signedIn.selector === undefined ? {} : { selector: signedIn.selector }),
    ...(signedIn.urlPath === undefined ? {} : { urlPath: signedIn.urlPath }),
    ...(signedIn.openPath === undefined ? {} : { openPath: signedIn.openPath }),
  };
  if (shipped.some((step) => step.fields.some((field) => "questionSelector" in field)))
    return { version: 3, steps: shipped, signedIn: indicator };
  if (shipped.some((step) => step.popup !== undefined || step.approval !== undefined))
    return { version: 2, steps: shipped, signedIn: indicator };
  return { version: 1, steps: shipped, signedIn: indicator };
};

export const isIdentifier = (slot: AutofillSlot): slot is IdentifierKind =>
  slot === "username" || slot === "email" || slot === "phone" || slot === "account_number";
/** Whether a field's slot is a secret's: the password, a code or an extra secret. */
export const isSecret = (slot: AutofillSlot): slot is SecretSlot => !isIdentifier(slot);
/** The secrets that prove the login: a sign-in verifies only once a request carried one. */
export const provesLogin = (slot: AutofillSlot) => slot === "password" || slot === "code";
/**
 * A date of birth, ZIP, recovery code or private answer: the site checks it, but the host does not
 * track it as sent. A dropdown sends an option's own value, never the text the host chose.
 */
export const isExtraSecret = (slot: AutofillSlot): slot is ExtraSecretSlot =>
  slot === "date_of_birth" ||
  slot === "zip" ||
  slot === "recovery_code" ||
  slot === "private_answer";

/**
 * A request the page sent while a sign-in was open, as the host heard it: `navigation` for the
 * primary page's own document request, `popup` for one a popup sent, `http` for anything else
 * (a fetch, an XHR). Its body stays in the host's memory, is only matched and is never logged:
 * `null` with `bodyUnseen` when the browser could not give it or it ran past the host's cap.
 */
export interface SignInRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly bodyUnseen?: true | undefined;
  readonly channel: "navigation" | "popup" | "http";
  /** A document request's frame. */
  readonly frame?: "main" | "sub" | undefined;
  readonly resourceType: string;
  /** The browser's id for the tab that sent it, when the host knows it. */
  readonly ownerTargetId?: string | undefined;
}

/** Whether `texts` carry every expected value; the host's matching of registered values. */
export type SecretMatcher = (
  expected: readonly string[],
  texts: readonly string[],
) => Effect.Effect<boolean>;

/** The latest fill's watch for its form going out; see `armStep`. */
interface SignInWatch {
  readonly endpoints: readonly { readonly endpoint: string; readonly method: string }[];
  readonly armedAt: number;
  /** The inspected popup's tab, in memory only, never a recipe field. */
  readonly popupTargetId?: string | undefined;
  /**
   * The origins a script's own sign-in request may go to besides the site's registrable domain:
   * the judged form actions' origins and the configured sign-in origins.
   */
  readonly scriptOrigins: readonly string[];
  /** The site the host judged the step's controls against. */
  readonly siteOrigin: string;
}

/** An open sign-in: its steps so far and what of it the host saw sent. */
export interface SignInRecord {
  /** Each screen as the host ran it, value-free: what a run replays. */
  readonly steps: RecordedSignInStep[];
  /**
   * The latest fill's watch: the form endpoints and methods the host judged for the step, and how
   * many requests the host had heard when it armed it, just before the fill. Only a request heard
   * after that can carry the step's values, whoever clicked.
   */
  watch: SignInWatch | undefined;
  /** Values filled but not yet seen sent, by slot, held in memory only and never logged. */
  readonly pending: Map<AutofillSlot, string>;
  /** Slots a request the host heard carried; a verified sign-in needs an identifier and a proof. */
  readonly submittedSlots: Set<AutofillSlot>;
  /** Set once a screen's host click ran or its fill's answer was lost: it may have sent a value. */
  mayHaveSent?: true;
}

export const openSignInRecord = (): SignInRecord => ({
  steps: [],
  watch: undefined,
  pending: new Map(),
  submittedSlots: new Set(),
});

/** Where a form submits, as the host compares it: origin and path. */
const formEndpoint = (url: string) => {
  const parsed = URL.parse(url);
  return parsed === null ? undefined : `${parsed.origin}${parsed.pathname}`;
};

/**
 * The page's own document request to an endpoint the host judged, with the form's method (a POST,
 * or a main-frame navigation for a GET form), heard after the watch was armed, with a body the
 * host read.
 */
const sentAsJudged = (watch: SignInWatch, sentAt: number, request: SignInRequest) => {
  const endpoint = formEndpoint(request.url);
  const method = request.method.toLowerCase();
  return (
    sentAt > watch.armedAt &&
    ((request.channel === "navigation" && watch.popupTargetId === undefined) ||
      (request.channel === "popup" &&
        watch.popupTargetId !== undefined &&
        request.ownerTargetId === watch.popupTargetId)) &&
    request.resourceType === "document" &&
    request.bodyUnseen !== true &&
    (method === "post" || request.frame !== "sub") &&
    watch.endpoints.some(
      (candidate) => candidate.endpoint === endpoint && candidate.method === method,
    )
  );
};

/**
 * A script's own sign-in request (a fetch or XHR, as most single-page logins send): a non-GET heard
 * after the watch was armed, to an HTTPS host on the site's registrable domain, a judged form
 * action's origin or a configured sign-in origin, with a body the host read. Only one that carries
 * every pending value counts (`noteFormSubmit`), which rules out a forged or empty request.
 */
const sentByScript = (watch: SignInWatch, sentAt: number, request: SignInRequest) => {
  const url = URL.parse(request.url);
  return (
    sentAt > watch.armedAt &&
    request.channel === "http" &&
    (watch.popupTargetId === undefined || request.ownerTargetId === watch.popupTargetId) &&
    (request.resourceType === "fetch" || request.resourceType === "xhr") &&
    request.method.toUpperCase() !== "GET" &&
    request.bodyUnseen !== true &&
    url !== null &&
    (watch.scriptOrigins.includes(url.origin) || sameSite(watch.siteOrigin, url))
  );
};

/** Values a form request carried are sent; after a missed host click, the minter sent them. */
const markSent = (record: SignInRecord, carried: readonly AutofillSlot[]) => {
  for (const slot of carried) {
    record.pending.delete(slot);
    record.submittedSlots.add(slot);
  }
  const last = record.steps.at(-1);
  if (carried.length > 0 && last?.submittedBy === undefined && last?.submit !== undefined)
    record.steps[record.steps.length - 1] = { ...last, submittedBy: "minter" };
};

/**
 * One rule for every submit, the host's click or the minter's own after a missed one: a filled
 * value counts as sent only when the host hears the page's request carry it. Each value it carries
 * moves to `submittedSlots`; one it does not stays unsent, so a reload, a remount or a form that
 * emptied never counts. Returns the secret slots it carried.
 */
export const noteFormSubmit = (
  record: SignInRecord | undefined,
  sentAt: number,
  request: SignInRequest,
  carries: SecretMatcher,
): Effect.Effect<readonly SecretSlot[]> =>
  Effect.gen(function* () {
    const watch = record?.watch;
    if (record === undefined || watch === undefined) return [];
    const texts = [request.url, request.body ?? ""];
    const carried: AutofillSlot[] = [];
    if (sentAsJudged(watch, sentAt, request)) {
      for (const [slot, value] of record.pending)
        if (yield* carries([value], texts)) carried.push(slot);
    } else if (
      sentByScript(watch, sentAt, request) &&
      (yield* carries([...record.pending.values()], texts))
    )
      carried.push(...record.pending.keys());
    markSent(record, carried);
    return carried.filter(isSecret);
  });

/**
 * Arms the watch for a fill about to run, with the form endpoints the host judged for its step,
 * and holds the step's values as pending: the request its submit sends may be heard before the
 * fill returns.
 */
export const armStep = (
  record: SignInRecord,
  step: AutofillStep,
  inspection: Pick<AutofillInspection, "page" | "targets" | "popupTargetId" | "siteOrigin">,
  values: readonly string[],
  armedAt: number,
  authenticationOrigins: readonly string[],
) => {
  const { fields, submit } = inspection.targets;
  const endpoints = [...fields, ...(submit === null ? [] : [submit])].flatMap((target) => {
    const endpoint = target.actions[0] === undefined ? undefined : formEndpoint(target.actions[0]);
    return endpoint === undefined ? [] : [{ endpoint, method: target.methods[0] ?? "get" }];
  });
  record.watch = {
    endpoints,
    armedAt,
    ...(inspection.popupTargetId === undefined ? {} : { popupTargetId: inspection.popupTargetId }),
    scriptOrigins: [
      ...new Set([
        ...endpoints.flatMap(({ endpoint }) => URL.parse(endpoint)?.origin ?? []),
        ...authenticationOrigins,
      ]),
    ],
    siteOrigin: inspection.siteOrigin,
  };
  step.fields.forEach((field, index) => {
    if (!isExtraSecret(field.slot)) record.pending.set(field.slot, values[index] ?? "");
  });
  // A date of birth records the control the host found for it, never its value.
  const control = (index: number) => {
    const found = inspection.targets.fields[index]?.control;
    return found === undefined || found === "other" ? undefined : found;
  };
  record.steps.push({
    ...(step.popup === undefined ? {} : { popup: step.popup }),
    ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
    fields: step.fields.map((field, index) =>
      field.slot === "date_of_birth" ? { ...field, control: control(index) } : field,
    ),
    ...(step.submit === undefined ? {} : { submit: step.submit }),
    ...(step.methods === undefined ? {} : { methods: step.methods }),
    page: inspection.page,
  });
};

/**
 * Records what a fill did once it returns: a field it did not fill is not pending, a step that
 * reached nothing leaves the recipe, and a step the host clicked records it. Whether any value
 * reached the site is the request rule's call alone (`noteFormSubmit`). Returns whether anything
 * reached the page.
 */
export const recordStep = (
  record: SignInRecord,
  step: AutofillStep,
  report: AutofillStepReport,
) => {
  const filled = step.fields.map(
    (_, index) =>
      report.outcome === "uncertain" ||
      (report.outcome === "filled" && report.fields[index]?.status === "filled"),
  );
  step.fields.forEach((field, index) => {
    if (!filled[index] && !record.submittedSlots.has(field.slot)) record.pending.delete(field.slot);
  });
  const reached = filled.includes(true);
  const submit = report.outcome === "filled" ? report.submit : report.outcome;
  const last = record.steps.at(-1);
  if (!reached && submit !== "clicked" && submit !== "uncertain") record.steps.pop();
  else if (submit === "clicked" && last)
    record.steps[record.steps.length - 1] = { ...last, submittedBy: "host" };
  return reached || submit === "clicked" || submit === "uncertain";
};

/**
 * Checks each request the host hears against the open sign-in (`current`), in the order heard,
 * and tells `credited` the secret slots each one carried. `sequence` is how many it heard so far,
 * which arms a step's watch; `settled` waits until every request heard so far was checked.
 */
export const makeSentTracker = (
  current: () => SignInRecord | undefined,
  carries: SecretMatcher,
  credited: (slots: readonly SecretSlot[]) => void = () => {},
) => {
  let sequence = 0;
  let checkedThrough: Deferred.Deferred<void> | undefined;
  const heard = (request: SignInRequest) => {
    const sentAt = ++sequence;
    const previous = checkedThrough;
    const checked = Deferred.unsafeMake<void>(FiberId.none);
    checkedThrough = checked;
    Effect.runFork(
      (previous === undefined ? Effect.void : Deferred.await(previous)).pipe(
        Effect.zipRight(noteFormSubmit(current(), sentAt, request, carries)),
        Effect.tap((slots) => Effect.sync(() => credited(slots))),
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(Deferred.succeed(checked, undefined)),
      ),
    );
  };
  return {
    heard,
    sequence: () => sequence,
    settled: Effect.suspend(() =>
      checkedThrough === undefined ? Effect.void : Deferred.await(checkedThrough),
    ),
  };
};

/** The browser a sign-in runs on, as the recorder uses it. */
export interface SignInBrowser<E> {
  /** Finds the step's controls and judges where they submit, before anything is typed. */
  readonly inspect: (step: AutofillStep) => Effect.Effect<AutofillRefusal | AutofillInspection, E>;
  /** Fills the step's values into the inspected controls and clicks its submit. */
  readonly fill: (input: {
    readonly step: AutofillStep;
    readonly values: readonly string[];
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Checks the minter's signed-in indicator on the page: `screens` are every screen the build
   * filled, `challengeScreens` the current sign-in's, whose recorded challenges count.
   */
  readonly confirm: (
    indicator: AutofillSignedIn,
    screens: AutofillScreens,
    challengeScreens: AutofillScreens,
  ) => Effect.Effect<AutofillSignedInCheck, E>;
  /** Hears each request the page sends until the returned function stops it. */
  readonly onRequest: (listener: (request: SignInRequest) => void) => () => void;
  /** The configured sign-in origins off the site. */
  readonly authenticationOrigins: readonly string[];
}

/** Where a sign-in's login comes from. */
export interface SignInLogin<E> {
  /** The login already given, if any. */
  readonly held: () => WebsiteCredentials | undefined;
  /** The login, asked for once when none is held. */
  readonly values: Effect.Effect<WebsiteCredentials, E>;
  /** A corrected login after the site rejected `field` of `held`. */
  readonly correct: (
    field: CredentialRejectedField,
    held: WebsiteCredentials,
  ) => Effect.Effect<WebsiteCredentials, E>;
}

/** Why the host could not get a value: the owner's answer went unanswered, failed or ran out. */
export class Unanswered {
  constructor(
    readonly cause: unknown,
    /** The field whose corrections ran out, for `field_corrections_exhausted`. */
    readonly field?: string,
  ) {}
}

/** A value for a field, with the slot it fills. */
export interface SignInValue {
  readonly slot: AutofillSlot;
  readonly value: string;
}

/** A private answer's question as the host inspected it, never a recipe value. */
export interface PrivateQuestion {
  readonly questionText?: string | undefined;
  readonly questionUnread?: true | undefined;
  readonly label: string | null;
}

/** Where a sign-in's values besides the login come from, and how each is masked. */
export interface SignInValueHooks<E> {
  /** Asks the owner, for an identifier, date of birth or ZIP the login does not hold. */
  readonly ask: InputAsker;
  /** Masks a value everywhere before any screen can send it. */
  readonly register: (slot: AutofillSlot, value: string) => Effect.Effect<void, E>;
  /** A sign-in code; `again` when the site rejected the last one. */
  readonly code: (need: {
    readonly again?: "rejected";
  }) => Effect.Effect<SignInValue | Unanswered, E>;
  /** One of the login's recovery codes. */
  readonly recoveryCode: Effect.Effect<SignInValue | Unanswered, E>;
  /** The answer to the security question the screen shows now. */
  readonly privateAnswer: (
    question: PrivateQuestion | undefined,
  ) => Effect.Effect<SignInValue | Unanswered, E>;
}
