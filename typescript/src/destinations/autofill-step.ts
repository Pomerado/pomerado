import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import type { FailureDetail } from "../runtime/failure-detail.js";
import type { HostExecute } from "../runtime/host-execute.js";
import { frameCrossing, unsupportedSelector } from "./autofill-locate-code.js";
import { autofillSignedInCode, autofillStepCode, SignedInPage } from "./autofill-page-code.js";
import { openAutofillLogin } from "./autofill-page.js";
import {
  foundEvidence,
  foundFor,
  FoundAt,
  FoundIn,
  locatedRefusal,
  namedAfterTyping,
  refused,
  Searched,
  targetEvidence,
  urlOrigin,
  withCheck,
  withEvidence,
} from "./autofill-refusal.js";
import { sameSite, siteDomain } from "../runtime/same-site.js";
import type {
  AutofillPopup,
  DateControl,
  DateOfBirthFormat,
  SignInMethodChoice,
  RejectedMarker,
} from "./autofill-contracts.js";

/** A kind of sign-in identifier: what an identifier field may accept. */
export type IdentifierKind = "username" | "email" | "phone" | "account_number";
/** The order the host picks an accepted identifier kind in when the login holds several. */
export const identifierPreference: readonly IdentifierKind[] = [
  "username",
  "email",
  "phone",
  "account_number",
];
/**
 * A secret a site may check besides the password: the login's date of birth, ZIP or postal code,
 * or one of its recovery codes. It proves the account and never picks it.
 */
export type ExtraSecretSlot = "date_of_birth" | "zip" | "recovery_code" | "private_answer";
/** A secret field's slot: the password, a one-time code or an extra secret. */
export type SecretSlot = "password" | "code" | ExtraSecretSlot;
/** The kind of value a sign-in field takes; the host fills it from the login of that kind. */
export type AutofillSlot = IdentifierKind | SecretSlot;

/**
 * A field of a sign-in screen. An identifier field lists every kind it accepts (`accepts`, from the
 * minter: a "username or email" field accepts both), and `slot` is the kind the host sends there:
 * one the login holds, by `identifierPreference`, or one the owner gave. A secret field names its
 * slot alone.
 */
export interface AutofillField {
  readonly selector: string;
  readonly slot: AutofillSlot;
  readonly accepts?: readonly IdentifierKind[] | undefined;
  /** How a `date_of_birth` field takes the date, or the one part of it a dropdown takes. */
  readonly format?: DateOfBirthFormat | undefined;
  /** The control a `date_of_birth` field was filled into, as the host found it. */
  readonly control?: DateControl | undefined;
  /** Host-only text from the current visible field label, never persisted in the recipe. */
  readonly privateAnswerPrompt?: string | undefined;
  /**
   * The accepted kinds the login held when the host filled the field, as kinds only: its saved
   * record's (`vault`) and the owner's answers this attempt (`given`).
   */
  readonly available?:
    | { readonly vault: readonly IdentifierKind[]; readonly given: readonly IdentifierKind[] }
    | undefined;
}

/** A sign-in screen as the minter names it: an identifier field lists the kinds it accepts. */
export interface AutofillStepRequest {
  readonly popup?: AutofillPopup | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  readonly fields: readonly (
    | { readonly selector: string; readonly accepts: readonly IdentifierKind[] }
    | {
        readonly selector: string;
        readonly slot: SecretSlot;
        readonly format?: DateOfBirthFormat | undefined;
        readonly control?: DateControl | undefined;
      }
  )[];
  readonly submit?: string | undefined;
  /** A two-factor method choice: every method offered, and `submit` the one picked. */
  readonly methods?:
    readonly { readonly method: SignInMethodChoice; readonly selector: string }[] | undefined;
}

/**
 * One sign-in screen: the fields the host fills and the control it clicks. A screen that advances
 * by itself names no submit; a method choice or a "Next" names only one.
 */
export interface AutofillStep {
  readonly popup?: AutofillPopup | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  /** A two-factor method choice: every method offered, and `submit` the one picked. */
  readonly methods?:
    readonly { readonly method: SignInMethodChoice; readonly selector: string }[] | undefined;
}

/** What the minter says shows the site signed in, which the host checks on the live page. */
export interface AutofillSignedIn {
  readonly selector?: string | undefined;
  readonly urlPath?: string | undefined;
  /** An account page on the site the host opens before it checks; the landing page otherwise. */
  readonly openPath?: string | undefined;
}

/** Where a control sits and its form and link destinations: what the host judges before typing. */
const Target = Schema.Struct({
  ownerUrl: Schema.NullOr(Schema.String),
  documentOrigin: Schema.String,
  actions: Schema.Array(Schema.String),
  methods: Schema.Array(Schema.String),
  /**
   * The method its form submits by with it: a submit button's own `formmethod` when it has one,
   * else the form's method; null outside a form. The submit's is the method of the submission the
   * host clicks.
   */
  submitMethod: Schema.optional(Schema.NullOr(Schema.String)),
  editable: Schema.Boolean,
  control: Schema.Literal("date", "text", "select", "combobox", "other"),
  empty: Schema.optional(Schema.Boolean),
});
type Target = typeof Target.Type;
/** A step's controls as the host judges them: each field's target and its submit's. */
export const Targets = Schema.Struct({
  fields: Schema.Array(Target),
  submit: Schema.NullOr(Target),
});

const Text = Schema.NullOr(Schema.String);
/** A control as Guardian judges it: its markup's own words, never a value. */
const Described = Schema.Struct({
  tag: Schema.String,
  role: Text,
  /** How its form submits (`get` or `post`, with any control's own `formmethod`). */
  formMethod: Text,
  type: Text,
  name: Text,
  id: Text,
  autocomplete: Text,
  inputmode: Text,
  label: Text,
  placeholder: Text,
  ariaLabel: Text,
  text: Text,
});

/** A control a step call could not find, or found moved to where the host refuses it. */
export const LocatedError = Schema.Struct({
  error: Schema.Literal(
    "not_found",
    "ambiguous_match",
    "target_changed",
    "not_editable",
    "popup_missing",
    "popup_ambiguous",
  ),
  target: Schema.Union(Schema.Number, Schema.Literal("submit", "popup")),
  /** The primary page then, which a fill call reports once it typed. */
  url: Schema.optional(Schema.String),
  searched: Schema.optional(Searched),
  /** A disabled submit: where it was found. */
  located: Schema.optional(FoundIn),
});
const Located = Schema.Union(
  LocatedError,
  Schema.Struct({
    fields: Schema.Array(Schema.Struct({ target: Target, described: Described })),
    submit: Schema.NullOr(Schema.Struct({ target: Target, described: Described })),
    located: Schema.optional(FoundAt),
    buttons: Schema.Array(Schema.String),
    popupTargetId: Schema.optional(Schema.String),
    url: Schema.String,
  }),
);
/** Why the host typed and clicked nothing. Nothing of the step reached the site. */
export type AutofillRefusal = {
  readonly outcome: "refused";
  readonly reason:
    | "not_found"
    | "ambiguous_match"
    | "selector_unsupported"
    | "not_editable"
    | "credential_target_refused"
    | "page_unavailable"
    | "typing_unavailable"
    | "popup_missing"
    | "popup_ambiguous";
  /** The field (by its index in the step) or the submit control the refusal is about. */
  readonly target?: number | "submit" | "popup";
  /**
   * Host diagnostics only, never a value: the failed call's own error, or which check refused
   * (its `phase`) with origins and counts as evidence (`withCheck`).
   */
  readonly failureDetail?: FailureDetail;
};

/**
 * The step's controls as the host found them, before anything is typed: where each sits, for the
 * host's own check and the fill's recheck, and how each is labelled, for Guardian.
 */
export interface AutofillInspection {
  /** Host-only target binding for this inspection/fill; never persisted or published. */
  readonly popupTargetId?: string | undefined;
  /**
   * Host-only: the id the page keeps this inspection's controls under, with every form destination
   * as found, which the fill's calls compare against and its guard reads; never persisted.
   */
  readonly judgment?: string | undefined;
  /**
   * Host-only, set when the host had typed into the browser's page before this inspection, which
   * may then find a typed value in any origin: the origins the browser's inspections judged before
   * that, which evidence may name besides the site's and configured sign-in origins
   * (`namedAfterTyping`).
   */
  readonly judgedBeforeTyping?: readonly string[] | undefined;
  /** The guarded live address, for entry selection; never part of the recorded recipe. */
  readonly url?: string;
  /** The page the step's controls are on, origin and path only. */
  readonly page: string;
  readonly targets: typeof Targets.Type;
  /** What the host judged the targets against, which each fill call judges them against again. */
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly screen: {
    readonly fields: readonly (typeof Described.Type & {
      readonly slot: AutofillSlot;
      readonly accepts?: readonly IdentifierKind[] | undefined;
      readonly format?: DateOfBirthFormat | undefined;
    })[];
    readonly submit: typeof Described.Type | null;
    /** Visible native and ARIA actions, links included, for a step that names no submit. */
    readonly buttons: readonly string[];
  };
}

/** Kernel's fill vocabulary: a field after the first failed one is never attempted. */
export type AutofillFieldStatus = "filled" | "failed" | "not_attempted";

/**
 * What one host fill did, with no value in it. `filled` typed the fields in order and says what
 * became of the submit: `none` when the step names none. `uncertain` lost the call's answer, so
 * the fields and the submit may have gone out. Nothing is ever retried by itself (Kernel's fill
 * rule too: a lost answer can follow writes that landed).
 */
export type AutofillStepReport =
  | AutofillRefusal
  | {
      readonly outcome: "filled";
      readonly fields: readonly {
        readonly slot: AutofillSlot;
        readonly status: AutofillFieldStatus;
      }[];
      /** `refused`: after the fill the host refused a control where it then sat or submitted. */
      readonly submit: "clicked" | "failed" | "not_attempted" | "refused" | "none";
      /**
       * The host clicked a submit that is `refused`: its guard stopped the submission as it fired,
       * after the page's own handlers ran on the click, so what the step filled may have gone out.
       */
      readonly clicked?: true;
      /** The primary page after the submit settled, byte-exact like every URL. */
      readonly url: string;
      /** Host diagnostics only: why a field or the submit was refused once something was typed. */
      readonly failureDetail?: FailureDetail;
      /** Host-only: a value reached the page, even one a field no longer holds. */
      readonly typed?: true;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "fill_call_failed";
      /** Host-only: a value may have reached the page. */
      readonly typed?: true;
      /** Host diagnostics only; finite facts alone when the failed call was a date's, whose code held it. */
      readonly failureDetail: FailureDetail;
    };

/** The host's check of the minter's signed-in indicator on the live page. */
export type AutofillSignedInCheck =
  | { readonly signedIn: true; readonly url: string }
  | {
      readonly signedIn: false;
      readonly failed:
        | "indicator_not_visible"
        | "path_mismatch"
        | "password_field_visible"
        | "challenge_form_visible"
        | "selector_unsupported"
        | "off_site"
        | "page_unavailable";
      readonly url?: string;
      readonly failureDetail?: FailureDetail;
    };

export interface AutofillPage {
  readonly execute: HostExecute;
  readonly targetId: string;
}

const trustedUrl = (
  siteOrigin: string,
  authenticationOrigins: readonly string[],
  value: string,
) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    (authenticationOrigins.includes(url.origin) || sameSite(siteOrigin, url))
  );
};

/**
 * The first control that sits or submits off the site and its configured sign-in origins, or a
 * field still to be typed (from index `from`) that takes no typing: where its own frame, document,
 * form actions and link destination are, naming only `named` origins once anything was typed.
 */
export const untrustedTarget = (
  targets: typeof Targets.Type,
  step: AutofillStep,
  trust: { readonly siteOrigin: string; readonly authenticationOrigins: readonly string[] },
  from: number,
  named?: ReadonlySet<string>,
) => {
  const trusted = (url: string) => trustedUrl(trust.siteOrigin, trust.authenticationOrigins, url);
  const untrustedPart = (target: Target, action: string) => {
    if (!trusted(target.ownerUrl ?? "")) return "frame";
    if (!trusted(target.documentOrigin)) return "document_origin";
    return target.actions.every(trusted) ? undefined : action;
  };
  const refusedAt = (index: number | "submit", target: Target, part: string) =>
    withCheck(refused("credential_target_refused", index), "destination", {
      part,
      ...targetEvidence(target, named),
    });
  for (const [index, target] of targets.fields.entries()) {
    const part = untrustedPart(target, "form_action");
    if (part !== undefined) return refusedAt(index, target, part);
    // A date also goes into an enabled select or dropdown, which takes a choice, not typing.
    const choosable =
      step.fields[index]?.slot === "date_of_birth" &&
      (target.control === "select" || target.control === "combobox");
    if (index >= from && !target.editable && !choosable)
      return withCheck(refused("not_editable", index), "not_editable", {
        control: target.control,
        ...targetEvidence(target, named),
      });
  }
  const part = targets.submit && untrustedPart(targets.submit, "submit_destination");
  return targets.submit && part ? refusedAt("submit", targets.submit, part) : undefined;
};

/**
 * Finds the step's controls on the live browser's primary tab and judges where they submit, before
 * any value is typed. The contract is Kernel's vault fill, with our own
 * vault and our own fill: the minter found the fields, and this trusted controller authorizes the
 * destination. A credential goes only into a field whose frame, form actions and submit's link
 * destination are on the site's registrable domain or a configured sign-in origin. A form that
 * submits by GET is allowed when it is clearly the login form, which Guardian judges; its values
 * land in a URL that stays byte-exact. Once the host typed into the page
 * (`judgedBeforeTyping` given), a refusal names only the origins `namedAfterTyping` allows.
 */
export const inspectAutofillStep = (input: {
  readonly step: AutofillStep;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly judgedBeforeTyping?: readonly string[] | undefined;
}): Effect.Effect<AutofillRefusal | AutofillInspection> =>
  Effect.gen(function* () {
    const { step, page, siteOrigin, authenticationOrigins } = input;
    if (
      step.popup !== undefined &&
      !trustedUrl(siteOrigin, authenticationOrigins, step.popup.origin)
    )
      return withCheck(refused("credential_target_refused"), "destination", {
        part: "popup",
        popupOrigin: urlOrigin(step.popup.origin),
      });
    const crossing = unsupportedSelector(step);
    if (crossing !== undefined)
      return withCheck(refused("selector_unsupported", crossing), "selector_unsupported");
    // This call's code holds no value, so its failure keeps its full detail.
    const judgment = randomUUID();
    const inspected = yield* page
      .execute(autofillStepCode(page.targetId, step, judgment), 15)
      .pipe(Effect.flatMap(Schema.decodeUnknown(Located)), Effect.either);
    if (inspected._tag === "Left")
      return {
        ...refused("page_unavailable"),
        failureDetail: failureDetail("autofill_step_failed", {
          operation: "autofill.inspect",
          error: inspected.left,
        }),
      };
    const found = inspected.right;
    const named = namedAfterTyping(input);
    if ("error" in found) return locatedRefusal(found, named);
    const targets = {
      fields: found.fields.map(({ target }) => target),
      submit: found.submit === null ? null : found.submit.target,
    };
    const untrusted = untrustedTarget(targets, step, input, 0, named);
    if (untrusted)
      return withEvidence(
        untrusted,
        foundEvidence(found.url, foundFor(found.located, untrusted.target), named),
      );
    const at = URL.parse(found.url);
    return {
      url: found.url,
      page: at === null ? "" : `${at.origin}${at.pathname}`,
      ...(found.popupTargetId === undefined ? {} : { popupTargetId: found.popupTargetId }),
      judgment,
      judgedBeforeTyping: input.judgedBeforeTyping,
      targets,
      siteOrigin,
      authenticationOrigins,
      screen: {
        fields: found.fields.map(({ described }, index) => {
          const field = step.fields[index];
          return {
            ...described,
            slot: field?.slot ?? "username",
            ...(field?.accepts === undefined ? {} : { accepts: field.accepts }),
            ...(field?.format === undefined ? {} : { format: field.format }),
          };
        }),
        submit: found.submit === null ? null : found.submit.described,
        buttons: found.buttons,
      },
    };
  });

/** The site's registrable domain, or its host where it has none, for the marker's frames. */
const siteHost = (siteOrigin: string) =>
  siteDomain(siteOrigin) ?? URL.parse(siteOrigin)?.hostname ?? "";

/** Opens the account page the check names, on the site only; the check's failure when it cannot. */
const openAccountPage = (openPath: string | undefined, page: AutofillPage, siteOrigin: string) =>
  Effect.gen(function* () {
    if (openPath === undefined) return undefined;
    const account = URL.parse(openPath, siteOrigin);
    if (account === null || account.origin !== siteOrigin)
      return { signedIn: false as const, failed: "off_site" as const };
    // This call's code holds no value, so its failure keeps its full detail.
    const opened = yield* Effect.either(openAutofillLogin({ page, url: account.href }));
    if (opened._tag === "Right") return undefined;
    return {
      signedIn: false as const,
      failed: "page_unavailable" as const,
      failureDetail: failureDetail("autofill_step_failed", {
        operation: "autofill.signed_in.open",
        error: opened.left,
      }),
    };
  });

/** A sign-in's recorded fields: selectors and, when present, slots of one-use challenges. */
export type AutofillScreens = readonly {
  readonly popup?: AutofillPopup | undefined;
  readonly fields: readonly { readonly selector: string; readonly slot?: AutofillSlot }[];
}[];

/**
 * Checks the minter's signed-in indicator on the live page: the selector is visible and the path
 * matches, the page is on the site, and no password field of the sign-in's own `screens` (the
 * recipe's in a run, the minter's in a mint) is left: one of their fields, or one in the form of a
 * visible one. It also refuses a visible recorded challenge, including in a provider frame, or a
 * challenge control on a site's active authentication route. An ordinary account search, support
 * or security-settings form does not count. Another form's password field does not count unless a recorded
 * selector matches in it. Screens with no field leave any visible password field failing it.
 */
export const checkAutofillSignedIn = (input: {
  readonly indicator: AutofillSignedIn;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly screens: AutofillScreens;
}): Effect.Effect<AutofillSignedInCheck> =>
  Effect.gen(function* () {
    const { indicator, page } = input;
    if (indicator.selector !== undefined && frameCrossing(indicator.selector))
      return { signedIn: false as const, failed: "selector_unsupported" as const };
    const opened = yield* openAccountPage(indicator.openPath, page, input.siteOrigin);
    if (opened !== undefined) return opened;
    // A screen with a frame-crossing selector never ran, so it holds none of the sign-in's fields.
    const signInFields = input.screens
      .filter((screen) => screen.popup === undefined)
      .flatMap((screen) => screen.fields.map((field) => field.selector))
      .filter((selector) => !frameCrossing(selector));
    const challengeFields = input.screens
      .filter((screen) => screen.popup === undefined)
      .flatMap((screen) => screen.fields)
      .filter((field) =>
        field.slot === "private_answer" || field.slot === "code" || field.slot === "recovery_code",
      )
      .map((field) => field.selector)
      .filter((selector) => !frameCrossing(selector));
    const read = yield* page
      .execute(
        autofillSignedInCode(
          page.targetId,
          indicator.selector,
          siteHost(input.siteOrigin),
          signInFields,
          challengeFields,
          input.screens.flatMap((screen) => (screen.popup === undefined ? [] : [screen.popup])),
        ),
        15,
      )
      .pipe(Effect.flatMap(Schema.decodeUnknown(SignedInPage)), Effect.either);
    if (read._tag === "Left")
      return {
        signedIn: false as const,
        failed: "page_unavailable" as const,
        failureDetail: failureDetail("autofill_step_failed", {
          operation: "autofill.signed_in",
          error: read.left,
        }),
      };
    const { url, indicator: visible, passwordVisible, challengeFormVisible } = read.right;
    const parsed = URL.parse(url);
    if (parsed === null || !sameSite(input.siteOrigin, parsed))
      return { signedIn: false as const, failed: "off_site" as const, url };
    if (visible === false)
      return { signedIn: false as const, failed: "indicator_not_visible" as const, url };
    if (indicator.urlPath !== undefined && parsed.pathname !== indicator.urlPath)
      return { signedIn: false as const, failed: "path_mismatch" as const, url };
    if (passwordVisible)
      return { signedIn: false as const, failed: "password_field_visible" as const, url };
    if (challengeFormVisible)
      return { signedIn: false as const, failed: "challenge_form_visible" as const, url };
    return { signedIn: true as const, url };
  });

export { openAutofillLogin };
