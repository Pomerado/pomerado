import { randomUUID } from "node:crypto";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import { sameSite } from "../runtime/same-site.js";

/** The most origins one question asks the caller to trust, all or nothing. */
export const maximumAskedSignInOrigins = 3;

/** The question's id, which only the host asks. */
const questionId = "trust_sign_in_origin";

/**
 * The origins to ask the caller to trust, when a signed-in check found the login sent only to
 * `origins`: each an https origin, exactly as `URL.origin` writes it, off the site's registrable
 * domain, not one of the build's sign-in origins and not asked about before. One question asks
 * about one to three of them, all or nothing, so any that is not eligible, or more than three,
 * asks nothing. Until the sign-in sent a password or a code anywhere, the site included
 * (`receivedProof`), it asks about one alone: two or more that heard only the identifier, as when
 * an analytics script also captured the email a check before the password screen found, ask
 * nothing, and the check after the password screen asks as before. One alone is still asked
 * about, as a sign-in by approval or email link sends the identifier alone.
 */
export const signInOriginsToAsk = (
  origins: readonly string[],
  context: {
    readonly siteOrigin: string;
    readonly trusted: readonly string[];
    readonly asked: ReadonlySet<string>;
    readonly receivedProof: boolean;
  },
): readonly string[] | undefined => {
  if (origins.length === 0 || origins.length > maximumAskedSignInOrigins) return undefined;
  if (!context.receivedProof && origins.length > 1) return undefined;
  const eligible = origins.every((origin) => {
    const url = URL.parse(origin);
    return (
      url !== null &&
      url.protocol === "https:" &&
      url.origin === origin &&
      !sameSite(context.siteOrigin, url) &&
      !context.trusted.includes(origin) &&
      !context.asked.has(origin)
    );
  });
  return eligible ? [...origins] : undefined;
};

/** `a`, `a and b`, or `a, b and c`. */
export const listed = (origins: readonly string[]) =>
  origins.length < 2
    ? (origins[0] ?? "")
    : `${origins.slice(0, -1).join(", ")} and ${origins.at(-1) ?? ""}`;

/**
 * The host's one question whether `site` signs in through `origins`, the places its sign-in page
 * sent the login to. It names each exact origin, never a path, query or value. A yes trusts them
 * for signing in only and saves them with the tool; a no stops the build.
 */
export const trustSignInOriginsQuestion = (
  site: string,
  origins: readonly string[],
): InputRequest => {
  const one = origins.length === 1;
  return {
    id: randomUUID(),
    source: "system",
    questions: [
      {
        id: questionId,
        type: "confirm",
        prompt: `Does ${site} sign in through ${listed(origins)}? Its sign-in page sent the login you gave to ${one ? "that address, which is" : "those addresses, which are"} outside the website. Yes trusts ${one ? "it" : "them"} for signing in only and saves ${one ? "it" : "them"} with the tool, so its runs sign in the same way. No stops the build without publishing.`,
      },
    ],
  };
};

/** Whether the caller answered yes to the trust question; anything else is a no. */
export const trustsSignInOrigins = (answers: ValidAnswers) => {
  const answer = answers[questionId];
  return answer?.type === "confirm" && answer.value.confirmed;
};
