import { Duration, Effect, Schema } from "effect";
import {
  openAutofillLogin,
  type AutofillPage,
  type AutofillSignedIn,
  type AutofillSignedInCheck,
} from "../destinations/autofill-step.js";
import {
  evaluateSignedInMarker,
  matchSignedOutSnapshots,
  type SignedInMarkerCheck,
  type SignedOutSnapshot,
} from "../destinations/signed-in-marker.js";
import { MintFailure, type SignedInMarkerCheckRequest } from "../mint/contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { primaryPageCode } from "../runtime/host-execute.js";
import type { SessionTyping } from "./authentication.js";

/** The most signed-out pages a build keeps, newest last. */
const keptPages = 4;

/**
 * Browser code that returns the primary tab's address and serialized document, with its scripts'
 * and styles' text left out: the match never reads them, and they would take most of the 1 MiB a
 * host call may return. It returns null for a page that cannot show the site signed out, which a
 * selector would find nothing on whatever the marker:
 * - a page off the site's origin, such as a sign-in site's or a browser error page;
 * - a page that shows nothing, no text, form control or image in its body, such as the blank page
 *   a reset leaves when the root fails to load, or a client-rendered page's empty shell. It gets
 *   up to 3 seconds to render first, its load and a quiet network included, so a client-rendered
 *   page is read once it renders past a splash screen such as "Loading…".
 */
const signedOutPageCode = (targetId: string, siteOrigin: string) => `${primaryPageCode(targetId)}
const onSite = () => URL.parse(primary.url())?.origin === ${JSON.stringify(siteOrigin)};
if (!onSite()) return null;
const deadline = Date.now() + 3000;
const left = () => Math.max(0, deadline - Date.now());
await primary.waitForLoadState("load", { timeout: left() }).catch(() => undefined);
// A splash screen already shows something at load, so every page waits for a quiet network,
// by when a client-rendered header has usually rendered.
await primary.waitForLoadState("networkidle", { timeout: left() }).catch(() => undefined);
const shows = () =>
  primary
    .evaluate(() => {
      const body = document.body;
      if (body === null) return false;
      if (body.innerText.trim() !== "") return true;
      const shown = body.querySelectorAll(
        "input:not([type=hidden]), select, textarea, button, img, svg, canvas, video",
      );
      return [...shown].some((element) => element.checkVisibility());
    })
    .catch(() => false);
let rendered = await shows();
while (!rendered && left() > 0) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(250, left())));
  rendered = await shows();
}
if (!rendered || !onSite()) return null;
return {
  url: primary.url(),
  dom: await primary.evaluate(() => {
    const root = document.documentElement.cloneNode(true);
    for (const element of root.querySelectorAll("script, style")) element.textContent = "";
    return "<!doctype html>" + root.outerHTML;
  }),
};`;
const SignedOutPage = Schema.NullOr(Schema.Struct({ url: Schema.String, dom: Schema.String }));

/**
 * The pages a build saw signed out, for its marker checks: the page a sign-in screen is on before
 * anything was typed, and a page a reset cleared of cookies and site storage. They stay in memory
 * for the build, and are never written or shown to a model. A page that cannot show the site
 * (see `signedOutPageCode`) is skipped, and so is one the host cannot read, such as one whose
 * document is still over 1 MiB: a later check has fewer pages to compare, and with none it reports
 * the signed-out page unchecked. The step that took it does not fail.
 */
const makeSignedOutPages = (page: AutofillPage, siteOrigin: string) => {
  const pages: SignedOutSnapshot[] = [];
  return {
    /** Keeps the page the primary tab shows now. Returns whether it kept it. */
    take: page.execute(signedOutPageCode(page.targetId, siteOrigin), 15).pipe(
      Effect.flatMap(Schema.decodeUnknown(SignedOutPage)),
      Effect.map((read) => {
        if (read === null) return false;
        pages.push(read);
        if (pages.length > keptPages) pages.shift();
        return true;
      }),
      Effect.orElseSucceed(() => false),
    ),
    get pages(): readonly SignedOutSnapshot[] {
      return [...pages];
    },
  };
};

/**
 * Browser code that says whether the primary tab shows the direct answer to a form it submitted,
 * with no redirect after it. Opening that address again would send a GET in place of what the
 * form sent, such as a POST, so it may load another page. A history it cannot read counts too.
 */
const formAnswerCode = (targetId: string) => `${primaryPageCode(targetId)}
const history = await context.newCDPSession(primary);
let submitted = true;
try {
  const { currentIndex, entries } = await history.send("Page.getNavigationHistory");
  submitted = entries[currentIndex]?.transitionType === "form_submit";
} finally {
  await history.detach().catch(() => undefined);
}
if (!submitted) return false;
return await primary.evaluate(
  () => (performance.getEntriesByType("navigation")[0]?.redirectCount ?? 0) === 0,
);`;

/** How long a loaded page may take to show the marker, as checks one interval apart. */
const markerSettle = { checks: 6, interval: Duration.millis(500) };

/** The most pages a build notes as explored signed in, newest last. */
const keptPaths = 10;

/** A page's path with its query, as the build notes the pages it explored. */
const pathOf = (url: URL) => `${url.pathname}${url.search}`;

/**
 * The local host's `MintDependencies.checkSignedInMarker`, and the pages it compares. It tests the
 * marker against the build's signed-out pages, on the live page as it is, after the host loads
 * the marker's page (`openPath`, else the site's root) again, and on the newest other page the
 * build explored once its sign-in sent the login. It signs nothing in and sends no value. The
 * loads move the primary tab. When the agent's page showed the marker and is not the
 * direct answer to a form, the host then opens its address again, and what that page held only in
 * memory, such as a half-filled form, is gone; otherwise the tab stays where the loads left it, as
 * the tool's text allows. Either way the host reads the page again for the next review. A current
 * page the host cannot read fails the check as unavailable, and so does an address that does not
 * open again, and a check once the write session started: its act steps continue the page as it
 * is.
 */
export const makeMarkerChecks = (input: {
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  /** The live check, on the current page or on `openPath` once the host opened it. */
  readonly check: (indicator: AutofillSignedIn) => Effect.Effect<AutofillSignedInCheck>;
  /**
   * Whether the host typed a sign-in value into this session's browser, in this build or an
   * earlier one. Builds in a session share the browser's cookies, so after that a page may show
   * the site signed in, even before this build's own sign-in.
   */
  readonly typing: SessionTyping;
  /** Whether the build's current sign-in sent the login, or a sign-in of the build is verified. */
  readonly loginSent: () => boolean;
  /** Whether the build's write session started: its act steps continue the page as it is. */
  readonly writeSessionStarted: () => boolean;
  /** Reads the page the tab shows for the next review, once a check moved it. */
  readonly observe: Effect.Effect<void>;
}) => {
  const signedOut = makeSignedOutPages(input.page, input.siteOrigin);
  /** Pages the build explored once its sign-in sent the login, as paths, oldest first. */
  const exploredPaths: string[] = [];
  let firstScreen = true;
  // A page that renders after it loads gets a few seconds to show the marker.
  const load = (indicator: AutofillSignedIn, path: string) =>
    Effect.gen(function* () {
      let checked = yield* input.check({ ...indicator, openPath: path });
      for (let check = 1; check < markerSettle.checks; check++) {
        if (checked.signedIn || checked.failed !== "indicator_not_visible") break;
        yield* Effect.sleep(markerSettle.interval);
        checked = yield* input.check(indicator);
      }
      return checked;
    });
  return {
    /** Keeps the page a reset cleared of cookies and site storage. */
    afterClear: Effect.asVoid(signedOut.take),
    /**
     * Keeps the page a sign-in screen is on, once the host found the screen's fields there and
     * Guardian allowed the step, before the host types: the build's first such page, while the
     * host has typed no sign-in value in this session. Nothing was typed on it, so it shows the
     * site signed out.
     */
    beforeTyping: Effect.suspend(() =>
      !firstScreen || input.typing.typed
        ? Effect.void
        : signedOut.take.pipe(
            Effect.map((kept) => {
              if (kept) firstScreen = false;
            }),
          ),
    ),
    /**
     * A sign-in screen, a rejected value, an approval or a code an exploration typed: the pages
     * explored before it may be screens of the sign-in under way, such as a code's, so none of them
     * is loaded as a signed-in page.
     */
    signInStep: () => {
      exploredPaths.length = 0;
    },
    /**
     * Notes the page an exploration left, once the build's sign-in sent the login. Guardian
     * reviewed that exploration as one that reads, so loading its page again repeats a read. The
     * page an act step left is never noted.
     */
    explored: (url: string | undefined) => {
      const page = URL.parse(url ?? "");
      if (!input.loginSent() || page === null || page.origin !== input.siteOrigin) return;
      const path = pathOf(page);
      const seen = exploredPaths.indexOf(path);
      if (seen !== -1) exploredPaths.splice(seen, 1);
      exploredPaths.push(path);
      if (exploredPaths.length > keptPaths) exploredPaths.shift();
    },
    /** Whether a page the build kept as signed out shows `marker`, as the check matches it. */
    signedOutShows: (marker: AutofillSignedIn) =>
      matchSignedOutSnapshots(marker, signedOut.pages) === "matches",
    check: (marker: SignedInMarkerCheckRequest): Effect.Effect<SignedInMarkerCheck, MintFailure> =>
      Effect.gen(function* () {
        // The write session's next act step continues the page as it is, so no load may move it.
        if (input.writeSessionStarted())
          return yield* new MintFailure({
            code: "Unavailable",
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "standalone.checkSignedInMarker",
              error: new Error("The write session started, so the check loads no page"),
            }),
          });
        const indicator = { selector: marker.selector, urlPath: marker.urlPath };
        const signedInNow = yield* input.check(indicator);
        if (!signedInNow.signedIn && signedInNow.failed === "page_unavailable")
          return yield* new MintFailure({
            code: "Unavailable",
            failureDetail:
              signedInNow.failureDetail ??
              failureDetail("mint_host_dependency_failed", {
                operation: "standalone.checkSignedInMarker",
                error: new Error("The current page could not be read"),
              }),
          });
        const here = URL.parse(signedInNow.url ?? "");
        // The tab returns to the agent's page only when that page showed the marker, so it is a
        // signed-in page of the site, not a sign-in screen, and its address loads it again: not
        // the direct answer to a form.
        const formAnswer = input.page
          .execute(formAnswerCode(input.page.targetId), 15)
          .pipe(Effect.map((answer) => answer !== false));
        const returnTo =
          signedInNow.signedIn &&
          here !== null &&
          !(yield* Effect.orElseSucceed(formAnswer, () => true))
            ? here
            : undefined;
        // The tool's text: `openPath`, or the site's origin.
        const freshPath = marker.openPath ?? "/";
        const freshLoad = yield* load(indicator, freshPath);
        const fresh = new URL(freshPath, input.siteOrigin);
        // Another page, once the page the agent is on shows the marker: before that, the sign-in
        // may still be under way. Neither the page loaded fresh nor the agent's own page counts.
        const second = !signedInNow.signedIn
          ? undefined
          : exploredPaths.findLast(
              (path) =>
                path !== pathOf(fresh) &&
                (here === null || here.origin !== input.siteOrigin || path !== pathOf(here)),
            );
        const secondPage = second === undefined ? undefined : yield* load(indicator, second);
        const left = (secondPage ?? freshLoad).url;
        const reopened =
          returnTo === undefined || left === returnTo.href
            ? undefined
            : yield* Effect.either(openAutofillLogin({ page: input.page, url: returnTo.href }));
        yield* input.observe;
        // The agent then reads the page, as the tool's failure says, before it checks again.
        if (reopened?._tag === "Left")
          return yield* new MintFailure({
            code: "Unavailable",
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "standalone.checkSignedInMarker.return",
              error: reopened.left,
            }),
          });
        return evaluateSignedInMarker({
          marker: indicator,
          signedOutSnapshots: signedOut.pages,
          signedInNow,
          freshLoad,
          secondPage,
        });
      }),
  };
};
