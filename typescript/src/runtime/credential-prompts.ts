import type { CodeChannel } from "../destinations/autofill-contracts.js";
import type { CredentialQuestion } from "./input-request.js";

export type CredentialReason = (typeof CredentialQuestion.Type)["reason"];

/** How many tries a correction has left, this one included. */
export const correctionTriesLeft = (triesLeft: number) =>
  triesLeft <= 1 ? "This is your last try." : `You have ${triesLeft} tries left.`;

type IdentifierAsk = "username" | "email" | "phone" | "account_number";
const identifierOrder = ["username", "email", "phone", "account_number"] as const;

/**
 * What the sign-in screen that needs the login shows, as the host inspected it: the kinds of
 * identifier its fields take and whether it shows a password field. A code on it is never part of
 * the login: the host asks for a code on its own, when it is needed.
 */
export interface AskingScreen {
  readonly identifierKinds: readonly IdentifierAsk[];
  readonly password: boolean;
}

/** One recorded sign-in screen as a login question lists it: what it asks for, never a value. */
export interface RecordedAsk extends AskingScreen {
  /** A code it asks for, by where the code comes from when the recording named it. */
  readonly code?: CodeChannel | "unnamed" | undefined;
}

/**
 * What a login question says the sign-in asks for. A build names the screen that needs the login
 * (`screen`): only what that screen shows, and, when the question also asks for a value that
 * screen does not show, that the owner may give it now so they are asked only once
 * (`passwordOptional` when the answer may leave the password out). A sign-in again with recorded
 * screens (`recorded`) may list them in order, since they are known.
 */
export type LoginAsk =
  | { readonly screen: AskingScreen; readonly passwordOptional?: boolean }
  | { readonly recorded: readonly RecordedAsk[] };

/** Kinds a set of accepted kinds names, in the host's order. */
const identifiers = (kinds: ReadonlySet<string>) =>
  identifierOrder.filter((kind) => kinds.has(kind));

/** The screen a sign-in step names, as its fields' slots and accepted kinds say. */
export const askingScreen = (step: {
  readonly fields: readonly {
    readonly slot?: string | undefined;
    readonly accepts?: readonly string[] | undefined;
  }[];
}): AskingScreen => ({
  identifierKinds: identifiers(new Set(step.fields.flatMap((field) => field.accepts ?? []))),
  password: step.fields.some((field) => field.slot === "password"),
});

/** A recorded sign-in's screens as a login question lists them, skipping those that ask nothing. */
export const recordedAsks = (
  steps: readonly {
    readonly fields: readonly (
      | { readonly accepts: readonly string[] }
      | { readonly slot: string; readonly channel?: CodeChannel | undefined }
    )[];
  }[],
): readonly RecordedAsk[] =>
  steps.flatMap((step) => {
    const kinds = new Set(step.fields.flatMap((field) => ("accepts" in field ? field.accepts : [])));
    const slots = step.fields.flatMap((field) => ("slot" in field ? [field] : []));
    const code = slots.find((field) => field.slot === "code");
    const ask: RecordedAsk = {
      identifierKinds: identifiers(kinds),
      password: slots.some((field) => field.slot === "password"),
      ...(code === undefined ? {} : { code: code.channel ?? "unnamed" }),
    };
    return ask.identifierKinds.length > 0 || ask.password || ask.code !== undefined ? [ask] : [];
  });

const identifierNames = {
  username: "username",
  email: "email address",
  phone: "phone number",
  account_number: "account number",
} as const;

const codeNames: Record<CodeChannel | "unnamed", string> = {
  sms: "a code texted to your phone",
  email: "a code sent to your email",
  call: "a code read out in a phone call",
  totp: "a code from your authenticator app",
  unnamed: "a sign-in code",
};

/** "a", "a and b" or "a, b and c". */
const listed = (parts: readonly string[]) =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** What one screen asks for, such as "your email address and your password"; empty for none. */
const screenParts = (screen: AskingScreen) => [
  ...(screen.identifierKinds.length === 0
    ? []
    : [`your ${screen.identifierKinds.map((kind) => identifierNames[kind]).join(" or ")}`]),
  ...(screen.password ? ["your password"] : []),
];

/**
 * The sentences that say what the sign-in asks for, ending in a space; empty when it names
 * nothing. A build's screen names only what it shows, then any value the question also asks for,
 * which the owner may give now so they are asked only once. A recorded sign-in lists its screens.
 */
const askSentences = (ask: LoginAsk | undefined) => {
  if (ask === undefined) return "";
  if ("recorded" in ask) {
    const screens = ask.recorded
      .map((screen) =>
        listed([
          ...screenParts(screen),
          ...(screen.code === undefined ? [] : [codeNames[screen.code]]),
        ]),
      )
      .filter((part) => part !== "");
    return screens.length === 0
      ? ""
      : `This tool's recorded sign-in asks for ${screens.join(", then ")}. `;
  }
  const shown = screenParts(ask.screen);
  if (shown.length === 0) return "";
  const also = [
    ...(ask.screen.identifierKinds.length === 0 ? ["the username you sign in with"] : []),
    ...(ask.screen.password ? [] : ["your password"]),
  ];
  const more =
    also.length === 0
      ? ""
      : ask.passwordOptional === true && ask.screen.identifierKinds.length > 0
        ? " Enter your password too if you sign in with one, so you're asked only once."
        : ` Enter ${listed(also)} too, so you're asked only once.`;
  return `This sign-in screen asks for ${listed(shown)}.${more} `;
};

/**
 * The prompt each reason shows above the login fields; a correction shows its tries left. With
 * what the sign-in asks for (`ask`), it first says so: what the screen that needs the login shows,
 * or the recorded sign-in's screens, so the owner knows whether a password, an identifier or both
 * are wanted. A code is never part of it, since the host asks for a code on its own.
 */
export const credentialPrompt = (reason: CredentialReason, triesLeft?: number, ask?: LoginAsk) =>
  askSentences(ask) +
  (reason === "missing_credentials"
    ? "Sign in to the website so this request can continue."
    : reason === "invalid_credentials"
      ? `The website rejected the login. Enter a correction to continue.${
          triesLeft === undefined ? "" : ` ${correctionTriesLeft(triesLeft)}`
        }`
      : "The temporary password expired. Enter the password again to continue.");

/**
 * The host's standard message for why a login is asked, shown wherever the host asks for it and
 * never written by a model. A rejected login says plainly that the one given did not work and is
 * not tried again.
 */
export const credentialMessage = (reason: CredentialReason) =>
  reason === "missing_credentials"
    ? "Pomerado needs a login for this website to continue."
    : reason === "invalid_credentials"
      ? "The website rejected the login you gave, so Pomerado won't try it again. Enter the correct login to continue."
      : "The website's temporary password expired. Enter the current one to continue.";
