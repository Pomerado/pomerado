import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import { runLocalOperation } from "../execution/local-operation.js";
import { makeRunDialogDecider } from "../inputs/dialog.js";
import { noIncidents } from "../runtime/incidents.js";
import { siteDomain } from "../runtime/same-site.js";
import { signInForRun } from "../runtime/sign-in-replay.js";
import { askingValueHooks } from "../runtime/sign-in-values.js";
import { localStartHooks, startPage } from "../runtime/start-state.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import { localSignInLogin, makeSignInBrowser } from "./authentication.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import { requestSite } from "./request-context.js";

/**
 * Runs an already-built artifact. Guardian reviewed its source when it was minted, so a run makes
 * no Guardian review and no model request, and needs no model key. An artifact that recorded a
 * sign-in signs in first with it, asking the owner for the login only when the session is not
 * signed in, and never runs signed out.
 */
export const runOperation = (
  session: StandaloneSession,
  artifact: MintArtifact,
  request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
) =>
  Effect.gen(function* () {
    const { options, browser, ask, secrets } = session;
    const { siteOrigin } = yield* requestSite(session, request);
    const workspace = yield* createLocalWorkspace();
    yield* seedLocalRuntime(workspace);
    const sources = artifact.files.map(({ path, content }) => [path, content] as const);
    if (artifact.signIn !== undefined) {
      const authenticationOrigins = request.authenticationOrigins ?? [];
      // The site as the owner's questions name it: its host, without `www.`.
      const site = new URL(siteOrigin).hostname.replace(/^www\./u, "");
      yield* signInForRun({
        recipe: artifact.signIn.recipe,
        entryUrl: artifact.signIn.entryUrl,
        browser: makeSignInBrowser({
          page: browser,
          keyboard: browser.keyboard,
          siteOrigin,
          authenticationOrigins,
          onRequest: browser.onRequest,
          typing: session.signInTyping,
        }),
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin }),
        values: askingValueHooks({ ask, register: secrets.register, site, siteOrigin }),
        carries: secrets.carries,
        site,
        siteOrigin,
      });
    }
    // A run starts at the site root, as its example did. It clears nothing: the CLI and each
    // served call run in a new browser context, and a library caller's scope keeps its session.
    yield* startPage(
      browser.execute,
      browser.targetId,
      siteOrigin,
      { siteData: "keep" },
      localStartHooks(browser.execute, browser.targetId),
    );
    const result = yield* runLocalOperation({
      workspace,
      entrypoint: artifact.entrypoint,
      sources,
      input: request.input ?? {},
      browser,
      siteOrigin,
      ...(siteDomain(siteOrigin) === undefined ? {} : { siteDomain: siteDomain(siteOrigin) ?? "" }),
      timeoutMs: options.timeoutMs ?? 1_200_000,
      ask,
      decideDialog: makeRunDialogDecider({
        ask,
        project: secrets.redact,
        // The request's effect is enough here: only a write's build publishes acceptedConfirms,
        // so a read tool has no record to accept from even when the request names no effect.
        readOnly: request.effect === "read",
        expectedConfirms: artifact.acceptedConfirms,
        incidents: noIncidents,
      }),
    });
    return result.output;
  });
