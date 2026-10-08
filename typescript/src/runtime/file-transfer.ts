import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Effect, Either, Ref, Schema } from "effect";
import type { BrowserExecute } from "./browser-execution.js";
import { accepts, bytesMatchType, isProgram, sniffedType } from "./file-types.js";
import {
  defaultFileLimits,
  FileName,
  FileRefused,
  isFileObject,
  MediaType,
  type FileChannel,
  type FileLimits,
  type FileObject,
  type FileRefusalReason,
  type PlacedFile,
} from "./files.js";
import { sameSite } from "./same-site.js";

/** A caller's file as the host found it: its metadata now, its bytes when read. */
export interface SourceFile {
  readonly name: string;
  /** The declared media type, or the one the name implies. */
  readonly media_type: string;
  readonly size: number;
  /** All the file's bytes; the host reads them only once the file passed the size caps. */
  readonly read: Effect.Effect<Uint8Array, Error>;
}

/** A finished download a host read back from the browser's machine. */
export type TakenDownload =
  | {
      readonly name: string;
      readonly bytes: Uint8Array;
      /** The `Content-Type` the server sent with the download, when the host saw it. */
      readonly media_type?: string;
    }
  /** The download is larger than the most the host may read. */
  | { readonly tooLarge: true };

/**
 * Where a host keeps file bytes; it implements this and `makeRunFiles` does the rest. The browser's
 * machine is wherever the page's Playwright code runs: the local machine for the native browser, a
 * browser VM for a hosted browser, reached through its filesystem API. Bytes never pass through a
 * script's code, its result or the script's own process.
 */
export interface FileHostHook {
  /** The caller's file a reference names. Fails when there is none. */
  readonly open: (reference: string) => Effect.Effect<SourceFile, Error>;
  /**
   * Writes bytes onto the browser's machine as a file named exactly `name`, in a directory no other
   * file uses, and returns its absolute path there, which the page's `setInputFiles` reads.
   */
  readonly writeToBrowser: (file: {
    readonly name: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<string, Error>;
  /**
   * Directs the browser's downloads into a new directory only this capture uses and returns a
   * slot naming it. A hosted browser sets its download directory (Chromium's
   * `Browser.setDownloadBehavior`); the native browser saves each download Playwright reports.
   */
  readonly armDownloads: () => Effect.Effect<string, Error>;
  /**
   * The first download that finished in the slot, waiting up to `timeoutMs`, with its suggested
   * name, its bytes, never more than `maxBytes` of them, and the server's `Content-Type` when the
   * host saw it; undefined when none finished in time. It ends the slot's capture either way.
   * The file's type comes from its first bytes, else that `Content-Type`, never its name.
   */
  readonly takeDownload: (
    slot: string,
    bounds: { readonly timeoutMs: number; readonly maxBytes: number },
  ) => Effect.Effect<TakenDownload | undefined, Error>;
  /**
   * Keeps a collected file for the run's caller and returns its id, and when the host serves the
   * bytes, where and until when.
   */
  readonly keep: (file: {
    readonly name: string;
    readonly media_type: string;
    readonly size: number;
    readonly sha256: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<
    { readonly id: string; readonly download_url?: string; readonly expires_at?: string },
    Error
  >;
}

/** A run's file service: the channel its script calls, and the check of its output. */
export interface RunFiles extends FileChannel {
  /** Fails unless every `$file` object in `output` is a file this run collected, unchanged. */
  readonly checkOutput: (output: unknown) => Effect.Effect<void, FileRefused>;
}

const refuse = (reason: FileRefusalReason) => Effect.fail(new FileRefused({ reason }));

/** A name a browser can be given: the host's, else a plain fallback. */
const safeName = (name: string, fallback: string) =>
  Either.isRight(Schema.decodeUnknownEither(FileName)(name)) ? name : fallback;

/** A server's `Content-Type` as a media type without parameters, when it is a valid one. */
const serverType = (contentType: string | undefined) => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type !== undefined && Either.isRight(Schema.decodeUnknownEither(MediaType)(type))
    ? type
    : undefined;
};

const FieldFacts = Schema.Union(
  Schema.Struct({ found: Schema.Number }),
  Schema.Struct({
    found: Schema.Literal(1),
    file: Schema.Boolean,
    accept: Schema.String,
    url: Schema.String,
  }),
);
const Chosen = Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Number }));

/** Page code that finds the one element `field` locates and reports what it is and where. */
const inspectFieldCode = (field: string, timeoutMs: number) => `
const field = (${field});
try { await field.first().waitFor({ state: "attached", timeout: ${timeoutMs} }); } catch { return { found: 0 }; }
const found = await field.count();
if (found !== 1) return { found };
return await field.evaluate((node) => ({
  found: 1,
  file: node.tagName === "INPUT" && node.type === "file",
  accept: node.getAttribute("accept") ?? "",
  url: node.ownerDocument.location.href,
}));`;

/** Page code that sets the file input to the placed file and reads back what it holds. */
const setFieldCode = (field: string, path: string, timeoutMs: number) => `
const field = (${field});
await field.setInputFiles(${JSON.stringify(path)}, { timeout: ${timeoutMs} });
return await field.evaluate((node) => [...node.files].map((file) => ({ name: file.name, size: file.size })));`;

const onSite = (siteOrigin: string | undefined, address: string) => {
  const url = URL.parse(address);
  return (
    siteOrigin !== undefined && url !== null && (url.origin === siteOrigin || sameSite(siteOrigin, url))
  );
};

/**
 * One run's files over a host's hook. A script's reference is resolved by `resolve`, which names
 * the hook's reference for each one the run may use, such as the references in its input. A file
 * goes only into one `<input type="file">` on the tool's site, after its size, type, the input's
 * `accept` and the run's caps allow it; a program never moves. A download is kept only within
 * the caps and when it is no program. `execute` runs the host's own page code on the run's browser.
 */
export const makeRunFiles = (options: {
  readonly hook: FileHostHook;
  readonly execute: BrowserExecute;
  readonly siteOrigin: string | undefined;
  readonly resolve: (reference: string) => string | undefined;
  readonly limits?: FileLimits;
}): Effect.Effect<RunFiles> =>
  Effect.gen(function* () {
    const limits = options.limits ?? defaultFileLimits;
    const used = yield* Ref.make({ files: 0, bytes: 0 });
    const collected = yield* Ref.make<readonly FileObject[]>([]);
    const slots = new Set<string>();
    /** Counts a file against the run's caps, or refuses it when it does not fit. */
    const reserve = (size: number) =>
      Ref.modify(used, (current) =>
        current.files + 1 > limits.runFiles || current.bytes + size > limits.runBytes
          ? [false, current]
          : [true, { files: current.files + 1, bytes: current.bytes + size }],
      ).pipe(Effect.flatMap((fits) => (fits ? Effect.void : refuse("run_limit"))));
    const run = (code: string, timeoutSec: number) =>
      options.execute(code, timeoutSec).pipe(
        Effect.flatMap((answer) =>
          answer.success ? Effect.succeed(answer.result) : Effect.fail(new Error(answer.error)),
        ),
      );
    const place: RunFiles["place"] = ({ reference, field, timeoutSec }) =>
      Effect.gen(function* () {
        const resolved = options.resolve(reference);
        if (resolved === undefined) return yield* refuse("unknown_reference");
        const source = yield* options.hook
          .open(resolved)
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        if (source.size > limits.fileBytes) return yield* refuse("too_large");
        const timeoutMs = timeoutSec * 1000;
        const facts = yield* run(inspectFieldCode(field, timeoutMs), timeoutSec + 5).pipe(
          Effect.flatMap(Schema.decodeUnknown(FieldFacts)),
          Effect.mapError(() => new FileRefused({ reason: "field_not_found" })),
        );
        if (!("file" in facts)) return yield* refuse("field_not_found");
        if (!facts.file) return yield* refuse("not_file_input");
        if (!onSite(options.siteOrigin, facts.url)) return yield* refuse("other_site");
        const bytes = yield* source.read.pipe(
          Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
        );
        if (bytes.byteLength !== source.size) return yield* refuse("unavailable");
        const name = safeName(source.name, "file");
        if (isProgram(bytes, name)) return yield* refuse("executable");
        if (!bytesMatchType(bytes, source.media_type)) return yield* refuse("type_mismatch");
        if (!accepts(facts.accept, { name, mediaType: source.media_type }))
          return yield* refuse("not_accepted");
        yield* reserve(bytes.byteLength);
        const path = yield* options.hook
          .writeToBrowser({ name, bytes })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        const chosen = yield* run(setFieldCode(field, path, timeoutMs), timeoutSec + 5).pipe(
          Effect.flatMap(Schema.decodeUnknown(Chosen)),
          Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
        );
        if (!chosen.some((file) => file.name === name && file.size === bytes.byteLength))
          return yield* refuse("unavailable");
        return {
          name,
          media_type: source.media_type,
          size: bytes.byteLength,
        } satisfies PlacedFile;
      });
    const arm: RunFiles["arm"] = () =>
      options.hook.armDownloads().pipe(
        Effect.tap((slot) => Effect.sync(() => slots.add(slot))),
        Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
      );
    const collect: RunFiles["collect"] = ({ slot, timeoutMs }) =>
      Effect.gen(function* () {
        if (!slots.delete(slot)) return yield* refuse("unknown_reference");
        const current = yield* Ref.get(used);
        const room = Math.min(limits.fileBytes, limits.runBytes - current.bytes);
        const taken = yield* options.hook
          .takeDownload(slot, { timeoutMs, maxBytes: Math.max(0, room) })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        if (taken === undefined) return yield* refuse("no_download");
        if ("tooLarge" in taken) return yield* refuse(room < limits.fileBytes ? "run_limit" : "too_large");
        const name = safeName(taken.name, "download");
        if (isProgram(taken.bytes, name)) return yield* refuse("executable");
        yield* reserve(taken.bytes.byteLength);
        // The bytes decide the type when they prove one, else the server's; never the name.
        const media_type =
          sniffedType(taken.bytes) ?? serverType(taken.media_type) ?? "application/octet-stream";
        const sha256 = createHash("sha256").update(taken.bytes).digest("hex");
        const size = taken.bytes.byteLength;
        const kept = yield* options.hook
          .keep({ name, media_type, size, sha256, bytes: taken.bytes })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        const file: FileObject = {
          $file: {
            id: kept.id,
            name,
            media_type,
            size,
            sha256,
            ...(kept.download_url === undefined ? {} : { download_url: kept.download_url }),
            ...(kept.expires_at === undefined ? {} : { expires_at: kept.expires_at }),
          },
        };
        yield* Ref.update(collected, (files) => [...files, file]);
        return file;
      });
    const checkOutput: RunFiles["checkOutput"] = (output) =>
      Ref.get(collected).pipe(
        Effect.flatMap((files) =>
          outputFiles(output).every((claimed) =>
            files.some((file) => isDeepStrictEqual(file, claimed)),
          )
            ? Effect.void
            : refuse("not_collected"),
        ),
      );
    return { place, arm, collect, checkOutput };
  });

/** Every `$file` object in an output, wherever it sits. */
export const outputFiles = (output: unknown): readonly unknown[] => {
  if (Array.isArray(output)) return output.flatMap(outputFiles);
  if (typeof output !== "object" || output === null) return [];
  if (isFileObject(output)) return [output];
  return Object.values(output).flatMap(outputFiles);
};
