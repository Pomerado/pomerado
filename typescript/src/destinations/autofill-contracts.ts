import { Schema } from "effect";
import { signInMethodChoices } from "../runtime/authentication.js";

/** A supported two-factor method; a run call may pick one. */
export const SignInMethod = Schema.Literal("sms", "call", "email", "totp", "push");
export type SignInMethod = typeof SignInMethod.Type;
/** `SignInMethod` or a recovery code; see `signInMethodChoices`. The shared contract's choice. */
export const SignInMethodChoice = Schema.Literal(...signInMethodChoices);
export type SignInMethodChoice = typeof SignInMethodChoice.Type;

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
 * The control a `date_of_birth` field was filled into, as the host found it (`formControlShape`):
 * a native date input, a text box, a native select or a custom dropdown. The recipe records it,
 * value-free; a run finds the control's shape again and fills what it finds.
 */
export const DateControl = Schema.Literal("date", "text", "select", "combobox");
export type DateControl = typeof DateControl.Type;
/** A sign-in screen holds at most this many fields: a date of birth may take three. */
export const maximumStepFields = 6;
/** Identifier kinds a field may accept. */
export const IdentifierKinds = Schema.Literal("username", "email", "phone", "account_number");
/** Secret slots a field may take. */
export const SecretSlots = Schema.Literal(
  "password",
  "code",
  "date_of_birth",
  "zip",
  "recovery_code",
);

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/** A value-free, slot-specific error marker observed on a sign-in screen. */
export const RejectedMarker = Schema.Struct({
  slot: Schema.Union(IdentifierKinds, SecretSlots),
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

/** An off-page sign-in the owner completes before confirming through the protected input. */
export const AutofillApproval = Schema.Literal("email_link", "device");
export type AutofillApproval = typeof AutofillApproval.Type;
