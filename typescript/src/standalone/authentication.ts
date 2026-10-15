import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { AutofillPopup } from "../destinations/autofill-contracts.js";
import { fillAutofillStep } from "../destinations/autofill-fill.js";
import { autofillPageCode } from "../destinations/autofill-page-code.js";
import {
  checkAutofillSignedIn,
  inspectAutofillStep,
  openAutofillLogin,
  type AutofillInspection,
  type AutofillPage,
  type AutofillStep,
} from "../destinations/autofill-step.js";
import { rememberTyping } from "../destinations/autofill-typed-page.js";
import type { CredentialKeyboard } from "../destinations/credential-keyboard.js";
import type {
  SignInBrowser,
  SignInLogin,
  SignInRequest,
} from "../destinations/sign-in-recipe.js";
import { MintFailure } from "../mint/contracts.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { primaryPageCode } from "../runtime/host-execute.js";
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import { sameSite } from "../runtime/same-site.js";
import { trustedUrl } from "../runtime/sign-in-origins.js";
import type { SignInReplayBrowser } from "../runtime/sign-in-replay.js";

/**
 * Whether the host typed a sign-in value into the session browser's page. It lasts for the
 * session, since page code may have kept what was typed for any later screen.
 */
export interface SessionTyping {
  typed: boolean;
}

/**
 * Whether a recorded rejection marker shows on its screen: on the screen's own origin, in a frame
 * on that origin or a configured sign-in origin, read only as visible or not. A screen off the
 * site, or a recorded popup that is gone, shows none.
 */
const markerVisible = (input: {
  readonly selector: string;
  readonly screenPage: string;
  readonly popup?: AutofillPopup | undefined;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
}) => {
  if (input.selector.includes(">>") || input.selector.includes("internal:"))
    return Effect.succeed(false);
  const expected = URL.parse(input.screenPage)?.origin;
  if (
    expected === undefined ||
    !trustedUrl(input.siteOrigin, input.authenticationOrigins, input.screenPage)
  )
    return Effect.succeed(false);
  return input.page
    .execute(
      `${autofillPageCode(input.page.targetId, input.popup)}
const expected = ${JSON.stringify(expected)};
if (new URL(primary.url()).origin !== expected) return false;
const origins = ${JSON.stringify([expected, ...input.authenticationOrigins])};
for (const frame of primary.frames()) {
  let origin;
  try { origin = new URL(frame.url()).origin; } catch { continue; }
  if (!origins.includes(origin)) continue;
  const marker = frame.locator(${JSON.stringify(input.selector)});
  const count = Math.min(await marker.count(), 100);
  for (let index = 0; index < count; index++)
    if (await marker.nth(index).isVisible()) return true;
}
return false;`,
      15,
    )
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknown(
          Schema.Union(
            Schema.Boolean,
            Schema.Struct({ error: Schema.Literal("popup_missing"), target: Schema.Literal("popup") }),
          ),
        ),
      ),
      Effect.map((visible) => visible === true),
    );
};

/** The browser's cookie domains and the origins it holds storage or frames for. */
const SiteDataInventory = Schema.Struct({
  domains: Schema.Array(Schema.String),
  origins: Schema.Array(Schema.String),
});

/**
 * Clears the site's own data from the session browser: the cookies of every domain on the site's
 * registrable domain (`sameSite`), and the storage of each such origin, its tab session storage
 * included, then leaves the tab blank for the replay to open its entry again. Other sites'
 * cookies and storage stay, and no other tab is closed.
 */
const clearSiteData = (page: AutofillPage, siteOrigin: string) =>
  page
    .execute(
      `const state = await context.storageState();
const origins = new Set(state.origins.map((entry) => entry.origin));
for (const tab of context.pages())
  for (const frame of tab.frames()) {
    try { origins.add(new URL(frame.url()).origin); } catch {}
  }
return { domains: [...new Set(state.cookies.map((cookie) => cookie.domain))], origins: [...origins] };`,
      15,
    )
    .pipe(
      Effect.flatMap(Schema.decodeUnknown(SiteDataInventory)),
      Effect.flatMap((inventory) => {
        const onSite = (url: URL | null) => url !== null && sameSite(siteOrigin, url);
        const domains = inventory.domains.filter((domain) =>
          onSite(URL.parse(`https://${domain.startsWith(".") ? domain.slice(1) : domain}`)),
        );
        const origins = [
          ...new Set([
            siteOrigin,
            ...inventory.origins.filter(
              (origin) => URL.parse(origin)?.origin === origin && onSite(URL.parse(origin)),
            ),
          ]),
        ];
        return page.execute(
          `${primaryPageCode(page.targetId)}
const domains = ${JSON.stringify(domains)};
const origins = ${JSON.stringify(origins)};
const session = await context.newCDPSession(primary);
try {
  await session.send("Page.stopLoading");
  for (const origin of origins)
    await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
} finally {
  await session.detach();
}
for (const domain of domains) await context.clearCookies({ domain });
// The tab keeps each origin's session storage across navigations: an inert document on each
// origin clears it without loading the website.
const local = (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" });
const navigation = await context.newCDPSession(primary);
await navigation.send("Network.setBypassServiceWorker", { bypass: true });
try {
  for (const origin of origins) {
    await primary.route(origin + "/**", local);
    try {
      await primary.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
      await primary.evaluate(() => sessionStorage.clear());
    } finally {
      await primary.unroute(origin + "/**", local);
    }
  }
} finally {
  await navigation.send("Network.setBypassServiceWorker", { bypass: false });
  await navigation.detach();
}
await primary.goto("about:blank", { timeout: 10_000 });`,
          60,
        );
      }),
      Effect.asVoid,
    );

/**
 * The local host's sign-in browser on the session's page, for a build's recorder and a run's
 * replay: core's inspection, fill and signed-in check, with the page's requests from the
 * executor, the entry page's load and the recorded rejection markers. Once the host typed into
 * the page, each later screen is judged as typed into (`rememberTyping`); `typing` carries that
 * across every build and run on the same browser. `trusted` adds the origins the caller trusted for
 * sign-in during a build to `authenticationOrigins`, read at each call, so one counts from the
 * next call on.
 */
export const makeSignInBrowser = (options: {
  readonly page: AutofillPage;
  readonly keyboard: CredentialKeyboard;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly trusted?: () => readonly string[];
  readonly onRequest: (listener: (request: SignInRequest) => void) => () => void;
  readonly typing: SessionTyping;
}): SignInBrowser<never> &
  Pick<SignInReplayBrowser<Error>, "open" | "markerVisible" | "clearSiteData"> => {
  const { page, siteOrigin, typing } = options;
  const signInOrigins = () =>
    options.trusted === undefined
      ? options.authenticationOrigins
      : [...new Set([...options.authenticationOrigins, ...options.trusted()])];
  const calls = rememberTyping({
    inspect: (request) =>
      inspectAutofillStep({
        ...request,
        page,
        siteOrigin,
        authenticationOrigins: signInOrigins(),
      }),
    fill: (input: {
      readonly step: AutofillStep;
      readonly inspection: AutofillInspection;
      readonly values: readonly string[];
    }) =>
      fillAutofillStep({ ...input, page, keyboard: options.keyboard }).pipe(
        // The session's record counts what `rememberTyping` counts: a fill that typed.
        Effect.tap((report) =>
          Effect.sync(() => {
            if (report.outcome !== "refused" && report.typed === true) typing.typed = true;
          }),
        ),
      ),
    typed: typing.typed,
  });
  return {
    inspect: calls.inspect,
    fill: calls.fill,
    // The account page opens on `openOrigin`, the login's workspace, only when it is an exact
    // origin on the site's registrable domain.
    confirm: (indicator, screens, challengeScreens, openOrigin) => {
      const opens = openOrigin === undefined ? siteOrigin : openOrigin;
      const at = URL.parse(opens);
      if (at === null || at.origin !== opens || !sameSite(siteOrigin, at))
        return Effect.succeed({ signedIn: false as const, failed: "off_site" as const });
      return checkAutofillSignedIn({
        indicator,
        page,
        siteOrigin: opens,
        authenticationOrigins: signInOrigins(),
        screens,
        challengeScreens,
      });
    },
    onRequest: options.onRequest,
    get authenticationOrigins() {
      return signInOrigins();
    },
    open: (url) => openAutofillLogin({ page, url }),
    clearSiteData: () => clearSiteData(page, siteOrigin),
    markerVisible: (selector, screenPage, popup) =>
      markerVisible({
        selector,
        screenPage,
        popup,
        page,
        siteOrigin,
        authenticationOrigins: signInOrigins(),
      }),
  };
};

/** Why the owner is asked for a login, above its fields and in the request's notice. */
const loginWords = {
  missing_credentials: {
    prompt: "Sign in to the website so this request can continue.",
    notice: "Pomerado needs a login for this website to continue.",
  },
  invalid_credentials: {
    prompt: "The website rejected the login. Enter a correction to continue.",
    notice:
      "The website rejected the login you gave, so Pomerado won't try it again. Enter the correct login to continue.",
  },
} as const;

const loginFailure = (cause: unknown) =>
  new MintFailure({
    code: "Unavailable",
    ...(cause instanceof InputRequestFailure && cause.code === "NoResponse"
      ? { noResponse: { possibleCommit: false } }
      : {}),
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "standalone.login",
      phase: "sign_in_input",
      error: cause,
    }),
  });

/** A corrected login that repeated, twice, a value the site rejected, so nothing was sent. */
export const repeatedLoginFailure = (field: CredentialRejectedField) =>
  loginFailure(new Error(`The corrected login repeats the ${field} the site rejected`));

/**
 * The local host's login for one build: one `credential` question, asked when a screen first
 * needs it, and one more after the site rejected it. Nothing is saved, and the answer is masked
 * for the session (`register`) before any screen can send it.
 */
export const localSignInLogin = (options: {
  readonly ask: InputAsker;
  readonly register: (value: string) => void;
  readonly siteOrigin: string;
}): SignInLogin<MintFailure> => {
  let held: WebsiteCredentials | undefined;
  const askLogin = (reason: keyof typeof loginWords, username?: string) =>
    Effect.gen(function* () {
      const words = loginWords[reason];
      const answers = yield* options
        .ask({
          id: randomUUID(),
          source: "system",
          notice: words.notice,
          questions: [
            {
              id: "login",
              type: "credential",
              prompt: words.prompt,
              fields: "username_password",
              reason,
              allowSave: false,
              siteOrigin: options.siteOrigin,
              ...(username === undefined || username === "" ? {} : { username }),
            },
          ],
        })
        .pipe(Effect.mapError(loginFailure));
      const answer = answers["login"];
      if (
        answer?.type !== "credential" ||
        answer.value.username === undefined ||
        answer.value.password === undefined
      )
        return yield* loginFailure(new Error("The login answer holds no username and password"));
      options.register(answer.value.username);
      options.register(answer.value.password);
      held = { username: answer.value.username, password: answer.value.password };
      return held;
    });
  return {
    held: () => held,
    values: Effect.suspend(() =>
      held === undefined ? askLogin("missing_credentials") : Effect.succeed(held),
    ),
    correct: (_field, rejected) => askLogin("invalid_credentials", rejected.username),
  };
};
