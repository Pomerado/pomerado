import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema, type Scope } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import type { CapturedDownload, FileHostHook, SourceFile } from "../runtime/file-transfer.js";
import { typeOfName } from "../runtime/file-types.js";
import { localError, localPromise } from "./local-path.js";
import type { LocalDownloads } from "./local-downloads.js";

/**
 * The local host's files. A caller names a file on this machine by its `file:` URL; the native
 * browser's Playwright code runs on this machine, so a placed file is written to a run directory
 * here and each download any page of the run's browser contexts starts is saved there by the
 * browser's own download event. A collected file is kept in `downloads`, where the caller reads
 * it from its `file:` URL until it expires, or kept nowhere when there are none, as during a
 * build, whose files only the run sees.
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

/**
 * A file's bytes, reading at most one more than the `size` it had: a file that grew since is
 * refused rather than read whole.
 */
const readAtMost = async (path: string, size: number) => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read !== size) throw new Error("The file changed while it was read");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, size);
  } finally {
    await handle.close();
  }
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
      read: localPromise(() => readAtMost(path, status.size)),
    };
  });

const Saved = Schema.Union(
  Schema.Struct({
    saved: Schema.Literal(true),
    name: Schema.String,
    contentType: Schema.optional(Schema.String),
  }),
  Schema.Struct({ saved: Schema.Literal(false) }),
);

/** Each download a capture saw, in the order they began, as `takeAllCode` reports them. */
const SavedAll = Schema.Array(
  Schema.Union(
    Schema.Struct({
      saved: Schema.Literal(true),
      name: Schema.String,
      url: Schema.String,
      contentType: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      ended: Schema.Literal("canceled", "unfinished"),
    }),
  ),
);

/**
 * Native page code that saves every download any page of any browser context of the run starts,
 * in the order they began, into `directory` under its place in that order, noting the
 * `Content-Type` of each response so a download's own is known. A context the run opens while
 * the capture is armed is watched from its start.
 */
const armCode = (slot: string, directory: string) => `
const registry = (globalThis.__pomeradoDownloads ??= new Map());
const state = { listeners: [], types: new Map(), downloads: [], changedAt: Date.now(), contexts: new Set() };
const capture = (download) => {
  if (state.closed === true) return;
  const url = download.url();
  const entry = { download, name: download.suggestedFilename(), url, contentType: state.types.get(url) };
  const ended = (result) => { entry.result = result; state.changedAt = Date.now(); };
  download.saveAs(${JSON.stringify(directory)} + "/" + state.downloads.length).then(() => ended({ saved: true }), () => ended({ saved: false }));
  state.downloads.push(entry);
  state.changedAt = Date.now();
};
const typed = (response) => {
  const type = response.headers()["content-type"];
  if (type !== undefined) state.types.set(response.url(), type);
};
const watchPage = (page) => {
  page.on("download", capture);
  state.listeners.push(() => page.off("download", capture));
};
const watchContext = (watched) => {
  if (state.contexts.has(watched)) return;
  state.contexts.add(watched);
  for (const page of watched.pages()) watchPage(page);
  watched.on("page", watchPage);
  watched.on("response", typed);
  state.listeners.push(() => watched.off("page", watchPage), () => watched.off("response", typed));
};
watchContext(context);
for (const watched of browser.contexts()) watchContext(watched);
browser.on("context", watchContext);
state.listeners.push(() => browser.off("context", watchContext));
registry.set(${JSON.stringify(slot)}, state);
return true;`;

/** Page code that ends the slot's capture and stops each download it saw still running. */
const endCaptureSource = (slot: string) => `
const registry = globalThis.__pomeradoDownloads;
const state = registry?.get(${JSON.stringify(slot)});
const end = () => {
  registry.delete(${JSON.stringify(slot)});
  state.closed = true;
  for (const stop of state.listeners) stop();
  for (const entry of state.downloads) if (entry.result === undefined) entry.download.cancel().catch(() => {});
};`;

/**
 * Native page code that waits up to `timeoutMs` for the first download the slot saw to finish,
 * then ends its capture.
 */
const takeCode = (slot: string, timeoutMs: number) => `${endCaptureSource(slot)}
if (state === undefined) return { saved: false };
const until = Date.now() + ${timeoutMs};
while (state.downloads[0]?.result === undefined && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
const first = state.downloads[0];
end();
if (first?.result?.saved !== true) return { saved: false };
return { saved: true, name: first.name, ...(first.contentType === undefined ? {} : { contentType: first.contentType }) };`;

/**
 * Native page code that waits for the slot's downloads, as `FileHostHook.takeDownloads` says,
 * then ends its capture and reports each one in the order they began.
 */
const takeAllCode = (
  slot: string,
  bounds: { readonly timeoutMs: number; readonly settleMs: number; readonly max: number },
) => `${endCaptureSource(slot)}
if (state === undefined) return null;
const until = Date.now() + ${bounds.timeoutMs};
while (Date.now() < until) {
  const ended = state.downloads.filter((entry) => entry.result !== undefined).length;
  if (ended >= ${bounds.max}) break;
  if (ended > 0 && ended === state.downloads.length && Date.now() - state.changedAt >= ${bounds.settleMs}) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const seen = [...state.downloads];
end();
return seen.map((entry) => entry.result === undefined
  ? { name: entry.name, url: entry.url, ended: "unfinished" }
  : entry.result.saved
    ? { saved: true, name: entry.name, url: entry.url, ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }) }
    : { name: entry.name, url: entry.url, ended: "canceled" });`;

/** How long the host gives page code that waits `waitMs` for downloads. */
const pageTimeoutSec = (waitMs: number) => Math.min(300, Math.ceil(waitMs / 1000) + 5);

/**
 * The native browser's file hook for one run, removing its run directory when the scope closes.
 * `execute` runs the host's page code on the run's browser.
 */
export const makeLocalFileHook = (options: {
  readonly execute: BrowserExecute;
  /** Where collected files are kept for the caller; none keeps no bytes. */
  readonly downloads?: LocalDownloads;
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
          const directory = yield* fresh("downloads");
          slots.set(slot, directory);
          yield* run(armCode(slot, directory), 10);
          return slot;
        }),
      takeDownload: (slot, { timeoutMs, maxBytes }) =>
        Effect.gen(function* () {
          const directory = slots.get(slot);
          slots.delete(slot);
          if (directory === undefined)
            return yield* Effect.fail(new Error("Unknown download slot"));
          const saved = yield* run(takeCode(slot, timeoutMs), pageTimeoutSec(timeoutMs)).pipe(
            Effect.flatMap(Schema.decodeUnknown(Saved)),
            Effect.mapError(localError),
          );
          if (!saved.saved) return undefined;
          // The host reads only the path it chose, never one the page named.
          const path = join(directory, "0");
          const status = yield* localPromise(() => lstat(path));
          if (!status.isFile()) return yield* Effect.fail(new Error("Download is not a file"));
          if (status.size > maxBytes) return { tooLarge: true as const };
          return {
            name: saved.name,
            bytes: yield* localPromise(() => readAtMost(path, status.size)),
            ...(saved.contentType === undefined ? {} : { media_type: saved.contentType }),
          };
        }),
      takeDownloads: (slot, bounds) =>
        Effect.gen(function* () {
          const directory = slots.get(slot);
          slots.delete(slot);
          if (directory === undefined)
            return yield* Effect.fail(new Error("Unknown download slot"));
          const seen = yield* run(
            takeAllCode(slot, bounds),
            pageTimeoutSec(bounds.timeoutMs + bounds.settleMs),
          ).pipe(Effect.flatMap(Schema.decodeUnknown(SavedAll)), Effect.mapError(localError));
          const captured: CapturedDownload[] = [];
          for (const [index, download] of seen.entries()) {
            if (!("saved" in download)) {
              captured.push(download);
              continue;
            }
            // The host reads only the paths it chose, by each download's place, never one the
            // page named.
            const path = join(directory, String(index));
            const status = yield* localPromise(() => lstat(path));
            if (!status.isFile()) return yield* Effect.fail(new Error("Download is not a file"));
            captured.push({
              name: download.name,
              url: download.url,
              ...(download.contentType === undefined ? {} : { media_type: download.contentType }),
              size: status.size,
              read: localPromise(() => readAtMost(path, status.size)),
            });
          }
          return captured;
        }),
      keep: (file) =>
        options.downloads === undefined
          ? Effect.succeed({ id: randomUUID() })
          : options.downloads.keep(file),
    } satisfies FileHostHook;
  });
