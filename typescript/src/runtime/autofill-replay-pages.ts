import type { AutofillSignedInCheck } from "../destinations/autofill-step.js";
import { placeOf, sessionOnPage, type SessionCheckRecipe } from "./session-sign-in.js";

/** Whether a page is neither a recorded screen nor the entry: the session went past the sign-in. */
export const leftSignInScreens = (
  onScreens: (page: string) => boolean,
  entryUrl: string,
  url: string | undefined,
) => {
  const here = placeOf(url);
  return here !== undefined && !onScreens(here) && here !== placeOf(entryUrl);
};

/** How long a page off the recorded screens must stay put before a sign-in reads it as its landing. */
export const landingSettleMs = 1_500;
/** The page's address when it is none of the recorded screens. */
export const offScreens = (onScreens: (page: string) => boolean, url: string | undefined) => {
  const here = placeOf(url);
  return here === undefined || onScreens(here) ? undefined : url;
};
/** A page off the recorded screens and since when it showed. */
export type OffScreens = { readonly url: string; readonly since: number };
/** The page off the recorded screens and since when it showed, or undefined while on them. */
export const stillOff = (previous: OffScreens | undefined, url: string | undefined, now: number) =>
  url === undefined ? undefined : previous?.url === url ? previous : { url, since: now };

/**
 * Whether the page is on the entry's address and every recorded screen sits there too, as a
 * sign-in in a dialog that never leaves the page it opened on: no address change can show it went
 * past its screens.
 */
const onSharedEntry = <S>(
  steps: readonly S[],
  matches: (page: string, recorded: S) => boolean,
  entryUrl: string,
  url: string | undefined,
) => {
  const here = placeOf(url);
  return (
    url !== undefined &&
    here !== undefined &&
    here === placeOf(entryUrl) &&
    steps.length > 0 &&
    steps.every((step) => matches(url, step))
  );
};

/**
 * A page on the shared entry address (`onSharedEntry`) that can't tell: the marker is missing, no
 * password field of the sign-in shows, and the marker's own path does not read it signed out. The
 * recorded screens' pages say nothing there, as they are all this page, so the screen wait that
 * reads it so first sees none of their fields (`landedInPlace`).
 */
export const cantTellInPlace = <S>(
  check: AutofillSignedInCheck,
  recipe: { readonly signedIn: SessionCheckRecipe["signedIn"]; readonly steps: readonly S[] },
  matches: (page: string, recorded: S) => boolean,
  entryUrl: string,
) =>
  !check.signedIn &&
  (check.failed === "indicator_not_visible" || check.failed === "path_mismatch") &&
  check.passwordFieldVisible !== true &&
  onSharedEntry(recipe.steps, matches, entryUrl, check.url) &&
  sessionOnPage(check, { signedIn: recipe.signedIn, steps: [] }) === "unknown";

/**
 * A page that can't tell, as `markerCantTell` reads it: the marker is missing or the page
 * is off the site, and `sessionOnPage` does not read it signed out, as on an account picker a site
 * shows before its marker. One of the sign-in's own recorded screens, or a page that shows its
 * password field, did not get past the sign-in, whatever path the marker names.
 */
export const cantTell = (
  check: AutofillSignedInCheck,
  recipe: Parameters<typeof sessionOnPage>[1],
  onScreens: (page: string) => boolean,
) =>
  !check.signedIn &&
  (check.failed === "indicator_not_visible" ||
    check.failed === "path_mismatch" ||
    check.failed === "off_site") &&
  !("passwordFieldVisible" in check && check.passwordFieldVisible === true) &&
  offScreens(onScreens, check.url) !== undefined &&
  sessionOnPage(check, recipe) === "unknown";
