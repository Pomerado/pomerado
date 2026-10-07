import { Duration, Effect, Schema } from "effect";
import {
  openAutofillLogin,
  type AutofillPage,
  type AutofillSignedIn,
  type AutofillSignedInCheck,
} from "../destinations/autofill-step.js";
import {
  evaluateSignedInMarker,
  type SignedInMarkerCheck,
  type SignedOutSnapshot,
} from "../destinations/signed-in-marker.js";
import { MintFailure, type SignedInMarkerCheckRequest } from "../mint/contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { primaryPageCode } from "../runtime/host-execute.js";

/** The most signed-out pages a build keeps, newest last. */
const keptPages = 4;

/**
 * Browser code that returns the primary tab's address and serialized document, with its scripts'
 * and styles' text left out: the match never reads them, and they would take most of the 1 MiB a
 * host call may return.
 */
const signedOutPageCode = (targetId: string) => `${primaryPageCode(targetId)}
return {
  url: primary.url(),
  dom: await primary.evaluate(() => {
    const root = document.documentElement.cloneNode(true);
    for (const element of root.querySelectorAll("script, style")) element.textContent = "";
    return "<!doctype html>" + root.outerHTML;
  }),
};`;
const SignedOutPage = Schema.Struct({ url: Schema.String, dom: Schema.String });

/**
 * The pages a build saw signed out, for its marker checks: a sign-in's first screen before
 * anything was typed, and a page a reset cleared of cookies and site storage. They stay in memory
 * for the build, and are never written or shown to a model. A page the host cannot read, such as
 * one whose document is still over 1 MiB, is skipped: a later check has fewer pages to compare, and
 * the step that took it does not fail.
 */
export const makeSignedOutPages = (page: AutofillPage) => {
  const pages: SignedOutSnapshot[] = [];
  return {
    /** Keeps the page the primary tab shows now. */
    take: page.execute(signedOutPageCode(page.targetId), 15).pipe(
      Effect.flatMap(Schema.decodeUnknown(SignedOutPage)),
      Effect.tap((read) =>
        Effect.sync(() => {
          pages.push(read);
          if (pages.length > keptPages) pages.shift();
        }),
      ),
      Effect.ignore,
    ),
    get pages(): readonly SignedOutSnapshot[] {
      return [...pages];
    },
  };
};

/** How long a loaded page may take to show the marker, as checks one interval apart. */
const markerSettle = { checks: 6, interval: Duration.millis(500) };

/**
 * The local host's `MintDependencies.checkSignedInMarker`: the marker against the build's
 * signed-out pages, on the live page as it is, after the host loads the marker's page (`openPath`,
 * else `urlPath`, else the site's root) again, and on the newest other page the build visited
 * signed in. It signs nothing in and sends no value. The loads move the primary tab, so the host
 * then opens the address it was on again; what that page held only in memory, such as a
 * half-filled form, is gone. A current page the host cannot read fails the check as unavailable.
 */
export const makeSignedInMarkerCheck =
  (input: {
    readonly page: AutofillPage;
    readonly siteOrigin: string;
    /** The live check, on the current page or on `openPath` once the host opened it. */
    readonly check: (indicator: AutofillSignedIn) => Effect.Effect<AutofillSignedInCheck>;
    readonly signedOutPages: () => readonly SignedOutSnapshot[];
    /** The paths, with their queries, of pages the build visited signed in, oldest first. */
    readonly signedInPaths: () => readonly string[];
  }) =>
  (marker: SignedInMarkerCheckRequest): Effect.Effect<SignedInMarkerCheck, MintFailure> =>
    Effect.gen(function* () {
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
      // A page that renders after it loads gets a few seconds to show the marker.
      const load = (path: string) =>
        Effect.gen(function* () {
          let checked = yield* input.check({ ...indicator, openPath: path });
          for (let check = 1; check < markerSettle.checks; check++) {
            if (checked.signedIn || checked.failed !== "indicator_not_visible") break;
            yield* Effect.sleep(markerSettle.interval);
            checked = yield* input.check(indicator);
          }
          return checked;
        });
      const freshPath = marker.openPath ?? marker.urlPath ?? "/";
      const freshLoad = yield* load(freshPath);
      const second = input.signedInPaths().findLast((path) => path !== freshPath);
      const secondPage = second === undefined ? undefined : yield* load(second);
      // Back to the page the agent was on, when it was on the site and the loads left it.
      const here = URL.parse(signedInNow.url ?? "");
      const left = new URL(second ?? freshPath, input.siteOrigin);
      if (here !== null && here.origin === left.origin && here.href !== left.href)
        yield* openAutofillLogin({ page: input.page, url: here.href }).pipe(Effect.ignore);
      return evaluateSignedInMarker({
        marker: indicator,
        signedOutSnapshots: input.signedOutPages(),
        signedInNow,
        freshLoad,
        secondPage,
      });
    });
