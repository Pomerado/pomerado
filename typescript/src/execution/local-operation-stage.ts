import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  localError,
  localFilePath,
  localPromise,
  localRelativePath,
  localSourceBundleLimit,
  localSourceFileLimit,
} from "./local-path.js";
import { localRuntimeAssets } from "./local-runtime-assets.js";
import type { LocalOperationOptions } from "./local-operation.js";

const installedDependencies = Effect.try({
  try: () => {
    const effect = realpathSync(fileURLToPath(import.meta.resolve("effect/package.json")));
    let current = dirname(fileURLToPath(import.meta.url));
    while (true) {
      const dependencies = join(current, "node_modules");
      const candidate = join(dependencies, "effect", "package.json");
      if (existsSync(candidate) && realpathSync(candidate) === effect) return dependencies;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("Installed local runtime dependencies are unavailable");
      current = parent;
    }
  },
  catch: localError,
});

export const stageSources = (options: LocalOperationOptions) =>
  Effect.gen(function* () {
    const directory = yield* localPromise(() => mkdtemp(join(tmpdir(), "pomerado-operation-")));
    yield* Effect.addFinalizer(() =>
      localPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
    );
    const seen = new Set<string>();
    let total = 0;
    const authored: Array<readonly [string, string]> = [];
    for (const [supplied, text] of options.sources) {
      const path = yield* Effect.try({ try: () => localRelativePath(supplied), catch: localError });
      if (seen.has(path))
        return yield* Effect.fail(new Error(`Duplicate reviewed source: ${path}`));
      seen.add(path);
      if (
        ["runtime/", "browser/", "filesystem/", "privacy/", "testing/", "node_modules/"].some(
          (prefix) => path.startsWith(prefix),
        )
      )
        return yield* Effect.fail(new Error(`Reviewed source cannot replace trusted SDK: ${path}`));
      total += Buffer.byteLength(text);
      if (Buffer.byteLength(text) > localSourceFileLimit || total > localSourceBundleLimit)
        return yield* Effect.fail(new Error("Reviewed source exceeds local execution size limit"));
      authored.push([path, text]);
    }
    const entrypoint = yield* Effect.try({
      try: () => localRelativePath(options.entrypoint),
      catch: localError,
    });
    if (!seen.has(entrypoint))
      return yield* Effect.fail(new Error("Entrypoint is absent from reviewed source snapshot"));
    // Authored source sits a level below the SDK, so src/ reaches it at ../../runtime/index.js.
    const operation = join(directory, "operation");
    yield* localPromise(() => mkdir(operation));
    for (const [path, text] of authored) {
      const destination = yield* localFilePath(operation, path, true);
      yield* localPromise(() => writeFile(destination, text, { flag: "wx", mode: 0o400 }));
    }
    const assets = yield* localRuntimeAssets;
    for (const [path, text] of assets) {
      const destination = yield* localFilePath(directory, path, true);
      if (path === "runtime/index.js")
        yield* localPromise(() => writeFile(destination, text, { flag: "wx", mode: 0o400 }));
      else {
        // Realpaths keep authored error classes identical to the child runner's installed SDK.
        const installed = import.meta.url.endsWith(".ts") ? path.replace(/\.js$/, ".ts") : path;
        const trusted = fileURLToPath(new URL(`../${installed}`, import.meta.url));
        yield* localPromise(() => symlink(trusted, destination, "file"));
      }
    }
    // Source saved when authored files sat beside the SDK reaches it one level up from src/. The
    // same directories appear there, so those imports load the same modules.
    for (const shared of new Set(assets.map(([path]) => path.split("/")[0] ?? path)))
      yield* localPromise(() => symlink(join("..", shared), join(operation, shared), "dir"));
    yield* localPromise(() =>
      writeFile(join(directory, "package.json"), '{"type":"module"}', {
        flag: "wx",
        mode: 0o400,
      }),
    );
    // Dependencies stay in the installed package; authored source bytes are copied unchanged.
    const dependencies = yield* installedDependencies;
    yield* localPromise(() => symlink(dependencies, join(directory, "node_modules"), "dir"));
    // The child runs from the authored root, so relative file paths resolve as they did before.
    return { directory: operation, entrypoint: join(operation, entrypoint) };
  });
