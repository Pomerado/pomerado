import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import { runLocalOperation } from "../execution/local-operation.js";
import { localFileReferences, makeLocalFileHook } from "../execution/local-files.js";
import { localDownloads } from "../execution/local-downloads.js";
import { makeRunFiles } from "../runtime/file-transfer.js";
import { makeRunDialogDecider } from "../inputs/dialog.js";
import { draftQuestionDeclarations } from "../mint/draft-questions.js";
import { noIncidents } from "../runtime/incidents.js";
import { siteDomain } from "../runtime/same-site.js";
import { localStartHooks, startPage } from "../runtime/start-state.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PomeradoRequest } from "./contracts.js";
import { makeRunSignIn } from "./session-sign-in.js";
import type { StandaloneSession } from "./session.js";
import { requestSite } from "./request-context.js";
import { beforeOperationFailure, returnedRun, runOutcomeFailure } from "./run-report.js";

/**
 * Runs an already-built artifact. Guardian reviewed its source when it was minted, so a run makes
 * no Guardian review and no model request, and needs no model key. An artifact that recorded a
 * sign-in signs in first with it, asking the owner for the login only when the session is not
 * signed in, and never runs signed out: its script's `ensureSignedIn` signs in again on the same
 * browser when a page load signed it out. A read or a confirmed write returns its output. A
 * sign-in that fails fails with its `SignInRunFailed`; any other run fails with a
 * `RunOutcomeFailure` that says what it did to the website and how to retry.
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
    const signIn =
      artifact.signIn === undefined
        ? undefined
        : makeRunSignIn(session, artifact.signIn, siteOrigin, request.authenticationOrigins ?? []);
    if (signIn !== undefined) yield* signIn.before;
    // A run starts at the site root, as its example did. It clears nothing: the CLI and each
    // served call run in a new browser context, and a library caller's scope keeps its session.
    yield* startPage(
      browser.execute,
      browser.targetId,
      siteOrigin,
      { siteData: "keep" },
      localStartHooks(browser.execute, browser.targetId),
    );
    // A run may place only the files its caller's input names.
    const references = localFileReferences(request.input);
    const files = yield* makeRunFiles({
      hook: yield* makeLocalFileHook({
        execute: browser.executeResponse,
        downloads: localDownloads(options.files?.downloads),
      }),
      execute: browser.executeResponse,
      siteOrigin,
      resolve: (reference) => (references.has(reference) ? reference : undefined),
      ...(options.files?.limits === undefined ? {} : { limits: options.files.limits }),
    });
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
      // Only the questions publication reviewed; an artifact saved before builds recorded them
      // asks only what its entrypoint declares as a plain literal.
      declaredQuestions:
        artifact.questions ??
        draftQuestionDeclarations(
          artifact.entrypoint,
          sources.find(([path]) => path === artifact.entrypoint)?.[1] ?? "",
        ),
      decideDialog: makeRunDialogDecider({
        ask,
        project: secrets.redact,
        // The request's effect is enough here: only a write's build publishes acceptedConfirms,
        // so a read tool has no record to accept from even when the request names no effect.
        readOnly: request.effect === "read",
        expectedConfirms: artifact.acceptedConfirms,
        incidents: noIncidents,
      }),
      ...(signIn === undefined ? {} : { signIn: signIn.hook() }),
      files,
    }).pipe(Effect.mapError(runOutcomeFailure(request.effect, "operation")));
    return yield* returnedRun(request.effect, result);
  }).pipe(Effect.mapError(beforeOperationFailure(request.effect)));
