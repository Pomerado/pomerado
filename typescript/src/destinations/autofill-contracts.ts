import { Schema } from "effect";
import { signInMethodChoices } from "../runtime/authentication.js";
import { trustedUrl } from "../runtime/sign-in-origins.js";

/** A supported two-factor method; a run call may pick one. */
export const SignInMethod = Schema.Literal("sms", "call", "email", "totp", "push");
export type SignInMethod = typeof SignInMethod.Type;
/** `SignInMethod` or a recovery code; see `signInMethodChoices`. The shared contract's choice. */
export const SignInMethodChoice = Schema.Literal(...signInMethodChoices);
export type SignInMethodChoice = typeof SignInMethodChoice.Type;
/**
 * A way into the account that a sign-in screen's method choice may offer beside a code the site
 * sends: a password, or the identifier a control switches the screen to ask for. A run takes the
 * way its recorded sign-in picked, and asks nothing about it.
 */
const wayMethods = [
  "password",
  "identifier_username",
  "identifier_email",
  "identifier_phone",
  "identifier_account_number",
] as const;
/** Whether a method choice's method is a way in rather than a two-factor method. */
export const isWayMethod = Schema.is(Schema.Literal(...wayMethods));
/** A recorded method choice's method: a two-factor method, or from recipe version 14 a way in. */
export const RecipeMethodChoice = Schema.Literal(...signInMethodChoices, ...wayMethods);
export type RecipeMethodChoice = typeof RecipeMethodChoice.Type;
/**
 * The value a native select lists for a sign-in method, when that select is the method's control:
 * the host chooses it with the browser's own select action, which fires the page's change handler.
 */
export const MethodOption = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/**
 * A sign-in screen's action with a lasting effect on the account, which each run's caller allows
 * or not: signing out another device or session, or trusting this browser for later sign-ins. A
 * run presses such a screen's control only when its caller allowed that choice.
 */
export const SignInChoice = Schema.Literal("sign_out_other_device", "trust_this_device");
export type SignInChoice = typeof SignInChoice.Type;

/**
 * How a `date_of_birth` field takes the date: a whole date in one of these layouts, or, for a
 * month, day and year shown as separate fields or dropdowns, the one part a field takes (`MM`
 * zero-padded, `M` not, `MMM` and `MMMM` the month name, short or full, in the page's language or
 * English; `YY` a two-digit year). A native date input always takes `YYYY-MM-DD`; the host fills
 * each with the authoring library's `fillDate` (`browser/form-controls.ts`).
 */
export const DateOfBirthFormat = Schema.Literal(
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "M/D/YYYY",
  "D/M/YYYY",
  "MM-DD-YYYY",
  "DD-MM-YYYY",
  "DD.MM.YYYY",
  "YYYY/MM/DD",
  "MMDDYYYY",
  "DDMMYYYY",
  "YYYYMMDD",
  "YYYY",
  "YY",
  "MM",
  "M",
  "MMM",
  "MMMM",
  "DD",
  "D",
);
export type DateOfBirthFormat = typeof DateOfBirthFormat.Type;
/**
 * How a field that takes a phone number takes it: `national`, the number without its country
 * calling code, for a box that keeps only the local number and has no country picker, or a picker
 * that already shows the number's country as the screen loads. The host types the digits after
 * the saved number's calling code (`nationalDigits`); a number saved without one is typed as saved.
 */
export const PhoneFormat = Schema.Literal("national");
export type PhoneFormat = typeof PhoneFormat.Type;
/**
 * The control a `date_of_birth` field was filled into, as the host found it (`formControlShape`):
 * a native date input, a text box, a native select or a custom dropdown. The recipe records it,
 * value-free; a run finds the control's shape again and fills what it finds.
 */
export const DateControl = Schema.Literal("date", "text", "select", "combobox");
export type DateControl = typeof DateControl.Type;
/**
 * A sign-in screen holds at most this many fields besides its code fields: a date of birth may
 * take three. Its code fields have their own bound, `maximumCodeBoxes`.
 */
export const maximumStepFields = 6;
/**
 * A sign-in screen holds at most this many code fields: one, or one per box of a code split across
 * one-character boxes, up to the longest common one-time code. The host types one character of the
 * one code into each.
 */
export const maximumCodeBoxes = 12;
/**
 * Whether a step's fields fit a sign-in screen: at most `maximumStepFields` besides its code
 * fields, and at most `maximumCodeBoxes` code fields.
 */
export const stepFieldsFit = (fields: readonly object[]) => {
  const codes = fields.filter((field) => "slot" in field && field.slot === "code").length;
  return codes <= maximumCodeBoxes && fields.length - codes <= maximumStepFields;
};
/** Why a step's fields do not fit (`stepFieldsFit`). */
export const stepFieldsMessage = `a sign-in step names at most ${maximumStepFields} fields besides its code fields, and at most ${maximumCodeBoxes} code fields, one per box of a split code`;
/**
 * Identifier kinds a field may accept. `private_identifier` is any other identity field a sign-in
 * asks for, such as a national identity number or a PIN that is itself the sign-in identifier,
 * labelled as the site labels it (`PrivateIdentifierLabel`): the host keeps its value like a
 * password. A PIN entered in place of a password after another identifier is the `password` slot.
 */
export const IdentifierKinds = Schema.Literal(
  "username",
  "email",
  "phone",
  "account_number",
  "private_identifier",
);
/**
 * A private identifier field's own label as the site shows it, such as "National ID number": what
 * the owner is asked for and what the saved login shows. Never the value. One line: no control or
 * format character (a newline, NEL, NUL or a bidi control) and no line or paragraph separator.
 */
export const PrivateIdentifierLabel = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
  Schema.filter((label) => label.trim() === label && !/[\p{C}\p{Zl}\p{Zp}]/u.test(label), {
    message: () =>
      "a label is one line of the site's own words, without surrounding spaces or control characters",
  }),
);
/**
 * Whether an identifier field's kinds and label agree: a `private_identifier` field accepts that
 * kind alone and names its label; no other identifier field names a label.
 */
export const privateIdentifierFits = (field: {
  readonly accepts: readonly string[];
  readonly label?: string | undefined;
}) =>
  field.accepts.includes("private_identifier")
    ? field.accepts.length === 1 && field.label !== undefined
    : field.label === undefined;
/** Why an identifier field's kinds and label do not agree (`privateIdentifierFits`). */
export const privateIdentifierMessage =
  "a private_identifier field accepts that kind alone, with the site's label for it; no other identifier field names a label";
/**
 * Whether a step's fields name at most one `private_identifier` field: a login holds one private
 * identifier, so a second such field would be typed the same value. A PIN entered in place of a
 * password after another identifier is the `password` slot.
 */
export const onePrivateIdentifier = (fields: readonly object[]) =>
  fields.filter(
    (field) =>
      "accepts" in field &&
      Array.isArray(field.accepts) &&
      field.accepts.includes("private_identifier"),
  ).length <= 1;
/** Why a step's fields do not fit (`onePrivateIdentifier`). */
export const onePrivateIdentifierMessage =
  "a sign-in step names at most one private_identifier field; a PIN entered in place of a password after another identifier is the password slot";
/** Secret slots a field may take. */
export const SecretSlots = Schema.Literal(
  "password",
  "code",
  "date_of_birth",
  "zip",
  "recovery_code",
  "private_answer",
);

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/** A value-free, slot-specific error marker observed on a sign-in screen. */
export const RejectedMarker = Schema.Struct({
  // A one-use answer cannot be corrected from a recorded rejection marker.
  slot: Schema.Union(
    IdentifierKinds,
    Schema.Literal("password", "code", "date_of_birth", "zip", "recovery_code"),
  ),
  selector: Selector,
});
export type RejectedMarker = typeof RejectedMarker.Type;
/** A stable relation to the primary page, never a provider or CDP target id. */
export const AutofillPopup = Schema.Struct({
  opener: Schema.Literal("primary"),
  origin: Schema.String.pipe(
    Schema.maxLength(2_000),
    Schema.filter((value) => {
      const url = URL.parse(value);
      return url !== null && url.protocol === "https:" && url.origin === value;
    }),
  ),
});
export type AutofillPopup = typeof AutofillPopup.Type;

/**
 * The key a sign-in step presses in its last field to submit that field's form, for a form with no
 * submit control that submits on Enter (HTML implicit submission, or its own script on the key).
 */
export const SubmitKey = Schema.Literal("Enter");
export type SubmitKey = typeof SubmitKey.Type;

/** An off-page sign-in the owner completes before confirming through the protected input. */
export const AutofillApproval = Schema.Literal("email_link", "device");
export type AutofillApproval = typeof AutofillApproval.Type;

/**
 * How an email-link approval reaches the browser: `paste` for a site whose emailed link signs in
 * only the browser that opens it. The owner pastes the link into the host's protected question,
 * and the host opens it in its own browser (`pastedSignInLink`). Without it, the owner opens the
 * link and confirms.
 */
export const AutofillApprovalDelivery = Schema.Literal("paste");
export type AutofillApprovalDelivery = typeof AutofillApprovalDelivery.Type;

/** The owner's protected question for an emailed sign-in link (`delivery: "paste"`). */
export const pastedLinkPrompt = (site: string) =>
  `Paste the newest sign-in link ${site} emailed you, without opening it. Pomerado keeps it private and opens it only in its own browser.`;

/**
 * The link an owner pasted for an email-link approval, as the host opens it, without the angle
 * brackets or quotes around it: an https address with no user name or password, on the site or one
 * of the sign-in origins the approval screen's inspection trusted (`trustedUrl`). Anything else is
 * undefined, and the host never opens it.
 */
export const pastedSignInLink = (
  pasted: string,
  trust: { readonly siteOrigin: string; readonly authenticationOrigins: readonly string[] },
) => {
  // A link pasted from an email may come inside angle brackets or quotes.
  const url = URL.parse(pasted.trim().replace(/^[<"']+|[>"']+$/gu, ""));
  return url !== null &&
    url.protocol === "https:" &&
    trustedUrl(trust.siteOrigin, trust.authenticationOrigins, url.href)
    ? url.href
    : undefined;
};

/**
 * The number a device approval's screen shows for the owner to pick on their device, as its
 * `matchSelector` element's trimmed text: 1 to 3 digits, else no number reaches the owner.
 */
export const approvalNumberPattern = /^[0-9]{1,3}$/u;
/** The element text as an approval number, when it is one (`approvalNumberPattern`). */
export const approvalNumberOf = (text: string | undefined) => {
  const trimmed = text?.trim();
  return trimmed !== undefined && approvalNumberPattern.test(trimmed) ? trimmed : undefined;
};
