import type { CredentialQuestion } from "./input-request.js";

export type CredentialReason = (typeof CredentialQuestion.Type)["reason"];

/** How many tries a correction has left, this one included. */
export const correctionTriesLeft = (triesLeft: number) =>
  triesLeft <= 1 ? "This is your last try." : `You have ${triesLeft} tries left.`;

/**
 * What the sign-in screen that needs the login asks for, as the host inspected it: the kinds of
 * identifier its fields take, whether it shows a password field, and whether it also asks for a
 * code, which the host asks for on its own.
 */
export interface AskingScreen {
  readonly identifierKinds: readonly ("username" | "email" | "phone" | "account_number")[];
  readonly password: boolean;
  readonly code?: boolean;
}

/** The screen a sign-in step names, as its fields' slots and accepted kinds say. */
export const askingScreen = (step: {
  readonly fields: readonly {
    readonly slot?: string | undefined;
    readonly accepts?: readonly string[] | undefined;
  }[];
}): AskingScreen => {
  const kinds = new Set(step.fields.flatMap((field) => field.accepts ?? []));
  return {
    identifierKinds: (["username", "email", "phone", "account_number"] as const).filter((kind) =>
      kinds.has(kind),
    ),
    password: step.fields.some((field) => field.slot === "password"),
    code: step.fields.some((field) => field.slot === "code"),
  };
};

const identifierNames = {
  username: "username",
  email: "email address",
  phone: "phone number",
  account_number: "account number",
} as const;

/**
 * The sentence that says what the screen asks for, such as "The website's sign-in screen asks for
 * your email address and your password."; empty when the screen names nothing. A code comes last,
 * as one the owner is asked for next, so it is never typed into the login's own fields.
 */
const screenSentence = (screen: AskingScreen | undefined) => {
  if (screen === undefined) return "";
  const parts = [
    ...(screen.identifierKinds.length === 0
      ? []
      : [`your ${screen.identifierKinds.map((kind) => identifierNames[kind]).join(" or ")}`]),
    ...(screen.password ? ["your password"] : []),
  ];
  const code = screen.code === true ? "a sign-in code, which you'll be asked for next" : undefined;
  if (parts.length === 0)
    return code === undefined ? "" : `The website's sign-in screen asks for ${code}. `;
  const last = parts.pop();
  const listed = parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
  const then = code === undefined ? "" : `, then ${code}`;
  return `The website's sign-in screen asks for ${listed}${then}. `;
};

/**
 * The prompt each reason shows above the login fields; a correction shows its tries left. With
 * the screen that needs the login (`screen`), it first says what that screen asks for, so the
 * owner knows whether a password, an identifier or a code is wanted.
 */
export const credentialPrompt = (
  reason: CredentialReason,
  triesLeft?: number,
  screen?: AskingScreen,
) =>
  screenSentence(screen) +
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
