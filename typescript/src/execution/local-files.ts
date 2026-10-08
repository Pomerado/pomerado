import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Schema, type Scope } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import type { FileHostHook, SourceFile } from "../runtime/file-transfer.js";
import { typeOfName } from "../runtime/file-types.js";
import { localError, localPromise } from "./local-path.js";

/**
 * The local host's files. A caller names a file on this machine by its `file:` URL; the native
 * browser's Playwright code runs on this machine, so a placed file is written to a run directory
 * here and a download is saved there by the browser's own download event. A collected file is
 * copied into `downloads`, where the caller reads it from its `file:` URL, or kept nowhere when
 * there is no such directory, as during a build, whose files only the run sees.
 */

/** Whether a value is a local file reference: a `file:` URL of an absolute path. */
export const isLocalFileReference = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.startsWith("file://")) return false;
  const url = URL.parse(value);
  return url !== null && url.protocol === "file:" && url.host === "" && !url.search && !url.hash;
};

/** Every local file reference in a value, wherever it sits. */
export const localFileReferences = (value: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (isLocalFileReference(item)) found.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit);
  };
  visit(value);
  return found;
};

/** The regular file a local reference names, with the type its name implies. */
export const openLocalFile = (reference: string): Effect.Effect<SourceFile, Error> =>
  Effect.gen(function* () {
    if (!isLocalFileReference(reference))
      return yield* Effect.fail(new Error("Not a local file reference"));
    const path = fileURLToPath(reference);
    const status = yield* localPromise(() => stat(path));
    if (!status.isFile()) return yield* Effect.fail(new Error("Not a regular file"));
    const name = basename(path);
    return {
      name,
      media_type: typeOfName(name),
      size: status.size,
      read: localPromise(() => readFile(path)),
    };
  });

const Saved = Schema.Union(
  Schema.Struct({ saved: Schema.Literal(true), name: Schema.String }),
  Schema.Struct({ saved: Schema.Literal(false) }),
);

/** Native page code that saves the first download any page of the context starts into `path`. */
const armCode = (slot: string, path: string) => `
const registry = (globalThis.__pomeradoDownloads ??= new Map());
const state = { listeners: [] };
const capture = (download) => {
  if (state.done !== undefined) return;
  const name = download.suggestedFilename();
  state.done = download.saveAs(${JSON.stringify(path)}).then(() => ({ saved: true, name }), () => ({ saved: false }));
};
const watch = (page) => {
  page.on("download", capture);
  state.listeners.push(() => page.off("download", capture));
};
for (const page of context.pages()) watch(page);
context.on("page", watch);
state.listeners.push(() => context.off("page", watch));
registry.set(${JSON.stringify(slot)}, state);
return true;`;

/** Native page code that waits up to `timeoutMs` for the slot's download, then ends its capture. */
const takeCode = (slot: string, timeoutMs: number) => `
const registry = globalThis.__pomeradoDownloads;
const state = registry?.get(${JSON.stringify(slot)});
if (state === undefined) return { saved: false };
registry.delete(${JSON.stringify(slot)});
for (const stop of state.listeners) stop();
const until = Date.now() + ${timeoutMs};
while (state.done === undefined && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
if (state.done === undefined) return { saved: false };
return await Promise.race([state.done, new Promise((resolve) => setTimeout(() => resolve({ saved: false }), Math.max(0, until - Date.now())))]);`;

/**
 * The native browser's file hook for one run, removing its run directory when the scope closes.
 * `execute` runs the host's page code on the run's browser.
 */
export const makeLocalFileHook = (options: {
  readonly execute: BrowserExecute;
  /** Where collected files are kept for the caller; none keeps no bytes. */
  readonly downloads?: string;
}): Effect.Effect<FileHostHook, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      localPromise(() => mkdtemp(join(tmpdir(), "pomerado-files-"))),
      (directory) =>
        localPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
    );
    const fresh = (kind: string) =>
      Effect.gen(function* () {
        const directory = join(root, kind, randomUUID());
        yield* localPromise(() => mkdir(directory, { recursive: true }));
        return directory;
      });
    const slots = new Map<string, string>();
    const run = (code: string, timeoutSec: number) =>
      options.execute(code, timeoutSec).pipe(
        Effect.flatMap((answer) =>
          answer.success ? Effect.succeed(answer.result) : Effect.fail(new Error(answer.error)),
        ),
      );
    return {
      open: openLocalFile,
      writeToBrowser: ({ name, bytes }) =>
        Effect.gen(function* () {
          const path = join(yield* fresh("placed"), name);
          yield* localPromise(() => writeFile(path, bytes, { flag: "wx" }));
          return path;
        }),
      armDownloads: () =>
        Effect.gen(function* () {
          const slot = randomUUID();
          const path = join(yield* fresh("downloads"), "download");
          slots.set(slot, path);
          yield* run(armCode(slot, path), 10);
          return slot;
        }),
      takeDownload: (slot, { timeoutMs, maxBytes }) =>
        Effect.gen(function* () {
          const path = slots.get(slot);
          slots.delete(slot);
          if (path === undefined) return yield* Effect.fail(new Error("Unknown download slot"));
          const timeoutSec = Math.min(300, Math.ceil(timeoutMs / 1000) + 5);
          const saved = yield* run(takeCode(slot, timeoutMs), timeoutSec).pipe(
            Effect.flatMap(Schema.decodeUnknown(Saved)),
            Effect.mapError(localError),
          );
          if (!saved.saved) return undefined;
          // The host reads only the path it chose, never one the page named.
          const status = yield* localPromise(() => lstat(path));
          if (!status.isFile()) return yield* Effect.fail(new Error("Download is not a file"));
          if (status.size > maxBytes) return { tooLarge: true as const };
          return { name: saved.name, bytes: yield* localPromise(() => readFile(path)) };
        }),
      keep: (file) =>
        Effect.gen(function* () {
          const id = randomUUID();
          const downloads = options.downloads;
          if (downloads === undefined) return { id };
          const directory = join(downloads, id);
          yield* localPromise(() => mkdir(directory, { recursive: true }));
          const path = join(directory, file.name);
          yield* localPromise(() => writeFile(path, file.bytes, { flag: "wx" }));
          return { id, download_url: pathToFileURL(path).href };
        }),
    } satisfies FileHostHook;
  });

/** The default directory the local host keeps a run's downloaded files in. */
export const defaultDownloadDirectory = () => join(tmpdir(), "pomerado-downloads");
