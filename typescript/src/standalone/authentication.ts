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
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
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
}): SignInBrowser<never> & Pick<SignInReplayBrowser<Error>, "open" | "markerVisible"> => {
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
    confirm: (indicator, screens, challengeScreens) =>
      checkAutofillSignedIn({
        indicator,
        page,
        siteOrigin,
        authenticationOrigins: signInOrigins(),
        screens,
        challengeScreens,
      }),
    onRequest: options.onRequest,
    get authenticationOrigins() {
      return signInOrigins();
    },
    open: (url) => openAutofillLogin({ page, url }),
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
