import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import { runLocalOperation } from "../execution/local-operation.js";
import { makeDialogDecider } from "../inputs/dialog.js";
import { siteDomain } from "../runtime/same-site.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
export const runOperation = (
  session: StandaloneSession,
  context: RequestContext,
  artifact: MintArtifact,
  request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
) =>
  Effect.gen(function* () {
    const { options, browser, ask, secrets } = session;
    const workspace = yield* createLocalWorkspace();
    yield* seedLocalRuntime(workspace);
    const sources = artifact.files.map(({ path, content }) => [path, content] as const);
    yield* context.review(
      `operation/${artifact.entrypoint}`,
      new Map(sources.map(([path, text]) => [`operation/${path}`, text])),
      request.input ?? {},
      "example",
      "liveBrowser",
    );
    yield* context.navigate;
    const result = yield* runLocalOperation({
      workspace,
      entrypoint: artifact.entrypoint,
      sources,
      input: request.input ?? {},
      browser,
      siteOrigin: context.siteOrigin,
      ...(siteDomain(context.siteOrigin) === undefined
        ? {}
        : { siteDomain: siteDomain(context.siteOrigin) ?? "" }),
      timeoutMs: options.timeoutMs ?? 1_200_000,
      ask,
      decideDialog: makeDialogDecider(ask, secrets.redact),
    });
    return result.output;
  });
