import { createHash } from "node:crypto";
import { Effect } from "effect";
import { LocalOperationFailure, type LocalOperationOutput } from "../execution/local-operation.js";
import {
  admitListCursor,
  randomListCursorKeys,
  sealListOutput,
  type ListCursorKeys,
  type ListCursorScope,
} from "../runtime/list-cursor.js";
import type { CursorRefusal } from "../runtime/list-page.js";
import { siteDomain } from "../runtime/same-site.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PomeradoRequest } from "./contracts.js";
import { runOutcomeFailure } from "./run-report.js";
import type { StandaloneSession } from "./session.js";

// The local host's list cursors. Without keys of its own, a process signs with a random key it
// keeps while it runs, so a served MCP's cursors work across its calls and end with it.

let processKeys: ListCursorKeys | undefined;

/** The keys this process signs with: the caller's, else one random key per process. */
export const localListCursorKeys = (configured: ListCursorKeys | undefined) =>
  configured ?? (processKeys ??= randomListCursorKeys());

/** A local tool's cursor scope on its site, dated now. */
export const localListScope = (
  session: Pick<StandaloneSession, "options">,
  operation: string,
  siteOrigin: string,
): ListCursorScope => {
  const domain = siteDomain(siteOrigin);
  return {
    keys: localListCursorKeys(session.options.listCursors?.keys),
    operation,
    siteOrigin,
    ...(domain === undefined ? {} : { siteDomain: domain }),
    now: session.options.listCursors?.now?.() ?? Date.now(),
  };
};

/** An artifact's cursors are bound to its site and its files, which a new build replaces. */
const artifactScope = (
  session: StandaloneSession,
  artifact: MintArtifact,
  siteOrigin: string,
): ListCursorScope => {
  const files = createHash("sha256");
  for (const { path, content } of [...artifact.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  ))
    files.update(path).update("\0").update(content).update("\0");
  return localListScope(
    session,
    `${siteOrigin}\0${artifact.entrypoint}\0${files.digest("hex")}`,
    siteOrigin,
  );
};

/** A refused cursor as the local runner's own refused input: nothing reached the site. */
export const refusedCursor = (admission: {
  readonly reason: CursorRefusal;
  readonly message: string;
}) =>
  new LocalOperationFailure(
    admission.message,
    { effect: "not_sent", commits: [] },
    "InvalidInput",
    "InvalidInput",
    undefined,
    { refusal: { field: "cursor", kind: admission.reason } },
  );

/**
 * The input a run of `artifact` starts with: its cursor checked and replaced by the position it
 * holds. A refused cursor fails the run as a refused input before anything reaches the site.
 */
export const admitArtifactCursor = (
  session: StandaloneSession,
  artifact: MintArtifact,
  siteOrigin: string,
  request: Pick<PomeradoRequest, "input"> & { readonly effect?: "read" | "write" },
) =>
  Effect.suspend(() => {
    const admission = admitListCursor(
      request.input ?? {},
      artifactScope(session, artifact, siteOrigin),
    );
    return admission.ok
      ? Effect.succeed(admission.input)
      : Effect.fail(runOutcomeFailure(request.effect, "operation")(refusedCursor(admission)));
  });

/** The run's output with its next cursor signed for the caller. */
export const sealArtifactOutput = (
  session: StandaloneSession,
  artifact: MintArtifact,
  siteOrigin: string,
  request: Pick<PomeradoRequest, "input">,
  result: LocalOperationOutput,
): LocalOperationOutput => ({
  ...result,
  output: sealListOutput(
    result.output,
    request.input ?? {},
    artifactScope(session, artifact, siteOrigin),
  ).output,
});
