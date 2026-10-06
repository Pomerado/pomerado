import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import { runLocalOperation } from "../execution/local-operation.js";
import { makeDialogDecider } from "../inputs/dialog.js";
import { siteDomain } from "../runtime/same-site.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import { requestSite } from "./request-context.js";
/**
 * Runs an already-built artifact. Guardian reviewed its source when it was minted, so a run makes
 * no Guardian review and no model request, and needs no model key.
 */
export const runOperation = (
  session: StandaloneSession,
  artifact: MintArtifact,
  request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
) =>
  Effect.gen(function* () {
    const { options, browser, ask, secrets } = session;
    const { siteOrigin, navigate } = yield* requestSite(session, request);
    const workspace = yield* createLocalWorkspace();
    yield* seedLocalRuntime(workspace);
    const sources = artifact.files.map(({ path, content }) => [path, content] as const);
    yield* navigate;
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
      decideDialog: makeDialogDecider(ask, secrets.redact),
    });
    return result.output;
  });
