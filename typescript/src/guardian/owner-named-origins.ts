import { sameSite } from "../runtime/same-site.js";
import type { PendingExecution } from "./review.js";

/**
 * Each https origin off the allowed sites that the owner's own words name: where the owner says
 * the requested work lives, such as their own tenant or instance of a product on another
 * registrable domain than its marketing or login site. Guardian reviews work there like work on
 * the site (`trusted_authority.ownerNamedOrigins`).
 *
 * Only text the owner wrote counts: `requestedIntent` (the intent without an approved write
 * upgrade's question) and the answers `answersForReview` marks `typed` (a text answer, a choice's
 * own text that repeats no offered option, a confirm's text other than the offered default). An
 * option label or question prompt the minting model wrote never names one, even when the owner
 * picks, types back or approves it, and neither does website content. Each entry is a
 * `URL.origin` (`https://host` or `https://host:port`, punycode for an IDN), once, in the order
 * first named; empty when none. Pure and derived from screened text, so every caller computes the
 * same list from the same pending review.
 */
export const ownerNamedOrigins = (
  pending: Pick<PendingExecution, "requestedIntent" | "answeredQuestions" | "allowedOrigins">,
): readonly string[] => {
  const { requestedIntent = "", answeredQuestions = [], allowedOrigins } = pending;
  const typed = answeredQuestions.flatMap(({ answer, typed }): readonly string[] =>
    typed !== true
      ? []
      : typeof answer === "string"
        ? [answer]
        : "confirmed" in answer
          ? [answer.text ?? ""]
          : [],
  );
  const named = new Set<string>();
  for (const text of [requestedIntent, ...typed])
    for (const [match] of text.matchAll(/https:\/\/[^\s"'`<>()[\]{}]+/giu)) {
      // Sentence punctuation after a URL is not part of it.
      const url = URL.parse(match.replace(/[.,;:!?]+$/u, ""));
      if (url !== null && !allowedOrigins.some((origin) => sameSite(origin, url)))
        named.add(url.origin);
    }
  return [...named];
};
