import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Effect } from "effect";
import { localError, localPromise } from "./local-path.js";
import type { LocalWorkspace } from "./local-workspace.js";

// This SDK is shared by native mint workspaces and execution children; it has no HTTP transport.
const runtimeFiles = [
  "browser/dialogs/action",
  "browser/dialogs/contracts",
  "browser/dialogs/service",
  "browser/form-controls",
  "privacy/common-values",
  "privacy/credential-policy",
  "privacy/secret-keys",
  "privacy/url-spans",
  "runtime/authentication",
  "runtime/browser-action-timeout",
  "runtime/browser-execution",
  "browser/index",
  "runtime/capture-diagnostic",
  "runtime/challenge",
  "runtime/context",
  "runtime/deadline",
  "runtime/diagnostic-reasons",
  "runtime/dialogs",
  "runtime/errors",
  "runtime/failure-detail",
  "runtime/input-request",
  "runtime/kernel-execute-client",
  "runtime/kernel-operation-validation",
  "runtime/kernel-operation",
  "runtime/operation-failure",
  "runtime/operation",
  "runtime/script-input",
  "runtime/sign-in-rejection",
  "runtime/variants",
] as const;

/** Trusted SDK assets are separate from the exact reviewed authored-source snapshot. */
export const localRuntimeAssets: Effect.Effect<readonly (readonly [string, string])[], Error> =
  Effect.gen(function* () {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const source = import.meta.url.endsWith(".ts");
    const files = yield* Effect.forEach(runtimeFiles, (path) =>
      Effect.gen(function* () {
        const filename = `${path}.${source ? "ts" : "js"}`;
        const text = yield* localPromise(() => readFile(join(root, filename), "utf8"));
        const code = source
          ? yield* Effect.try({
              try: () => stripTypeScriptTypes(text, { mode: "transform", sourceUrl: filename }),
              catch: localError,
            })
          : text;
        return [`${path}.js`, code] as const;
      }),
    );
    // Authored operations keep their established ../../runtime/index.js import.
    return [...files, ["runtime/index.js", 'export * from "../browser/index.js";\n'] as const];
  });
export const seedLocalRuntime = (workspace: LocalWorkspace) =>
  localRuntimeAssets.pipe(
    Effect.flatMap((files) =>
      Effect.forEach(files, ([path, text]) => workspace.install(path, text), { discard: true }),
    ),
  );
