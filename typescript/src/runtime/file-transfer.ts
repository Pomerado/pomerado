import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Effect, Either, Ref, Schema } from "effect";
import type { BrowserExecute } from "./browser-execution.js";
import { acceptsSource, bytesMatchType, isProgram, sniffedType } from "./file-types.js";
import {
  defaultFileLimits,
  type DownloadCap,
  FileField,
  fileFormat,
  FileName,
  FileRefused,
  isFileObject,
  MediaType,
  ScreenshotTarget,
  SiteFileLimits,
  type FileChannel,
  type FileLimits,
  type FileObject,
  type FileRefusalReason,
  type PlacedFile,
} from "./files.js";
import { hostOnSiteSource, siteDomain } from "./same-site.js";

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
 * browser VM for a hosted browser, reached through its filesystem API. With `placeByBrowserPath`,
 * it is the browser's own machine, which may be another than the one the page code runs on. Bytes
 * never pass through a script's code, its result or the script's own process.
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
   * The path `writeToBrowser` returns is on the browser's own machine, which the page code's
   * Playwright may not share, as for a Chromium browser reached only through its DevTools
   * websocket that keeps its files on its own machine. The placement then sets the input through
   * a DevTools session on the frame's target with `DOM.setFileInputFiles`, so the browser reads
   * that path itself, instead of with `setInputFiles`, which reads it where Playwright runs.
   * Chromium only. Absent or false, the placement is unchanged.
   */
  readonly placeByBrowserPath?: boolean;
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
   * A new path on the machine the host's page code runs on, for `files.screenshot` to write its PNG
   * to, and the read of what it wrote, never more than `maxBytes` of it: a file over them is
   * `tooLarge`. For a host whose page calls return less than one file may hold, as the native
   * browser's 1 MiB result limit; without it, the page call returns the PNG itself.
   */
  readonly screenshotFile?: () => Effect.Effect<
    {
      readonly path: string;
      readonly read: (
        maxBytes: number,
      ) => Effect.Effect<Uint8Array | { readonly tooLarge: true }, Error>;
    },
    Error
  >;
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

/**
 * The optional `FileHostHook` flags this core honors. An older core ignores a flag it doesn't
 * know, so a host that may run on one reads this list before it relies on a flag.
 */
export const fileHostHookFlags: readonly (keyof FileHostHook)[] = ["placeByBrowserPath"];

/** A run's file service: the channel its script calls, and the check of its output. */
export interface RunFiles extends FileChannel {
  /** Fails unless every `$file` object in `output` is a file this run collected, unchanged. */
  readonly checkOutput: (output: unknown) => Effect.Effect<void, FileRefused>;
  /**
   * The cap the latest capture's download went over, with its size, else undefined: each `arm`
   * starts it again, and a run's files belong to one execution. A build's host marks a failed
   * execution with it only when that failure is the cap refusal (`ExecutionEvidence.fileCap`).
   * Optional, so a host's own file service may leave it out; `makeRunFiles` always sets it.
   */
  readonly overCap?: () => DownloadCap | undefined;
}

/** A refusal before any page call: nothing reached the page. */
const refuse = (reason: FileRefusalReason) => Effect.fail(new FileRefused({ reason }));

/**
 * Why a file breaks the limits its site states, else undefined: more bytes than `maxBytes` is
 * `too_large`, and a name that ends in none of `extensions`, compared without case, is
 * `not_accepted`.
 */
export const siteFileRefusal = (
  limits: SiteFileLimits,
  file: { readonly name: string; readonly size: number },
): "too_large" | "not_accepted" | undefined => {
  if (limits.maxBytes !== undefined && file.size > limits.maxBytes) return "too_large";
  const name = file.name.toLowerCase();
  if (
    limits.extensions !== undefined &&
    limits.extensions.length > 0 &&
    !limits.extensions.some((extension) => name.endsWith(extension.toLowerCase()))
  )
    return "not_accepted";
  return undefined;
};

/**
 * The limits a published file field declares beside `format: "file"` (`fileInputWithin`), else
 * undefined. A keyword that is not a valid limit is left out.
 */
export const declaredFileLimits = (schema: unknown): SiteFileLimits | undefined => {
  if (typeof schema !== "object" || schema === null || Reflect.get(schema, "format") !== fileFormat)
    return undefined;
  const limit = <Key extends keyof typeof SiteFileLimits.fields>(key: Key) => {
    const decoded = Schema.decodeUnknownEither(SiteFileLimits)({ [key]: Reflect.get(schema, key) });
    return Either.isRight(decoded) ? decoded.right : {};
  };
  const limits = { ...limit("maxBytes"), ...limit("extensions") };
  return Object.keys(limits).length === 0 ? undefined : limits;
};

/** Where a schema walk stops: a deeper input, or `$ref` chain, is not followed. */
const maximumLimitDepth = 64;
const plainName = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * Each file the input names in a field whose published schema declares site limits, with the
 * field's path as an input issue names it (`applicant.resume`, `documents[0]`). It follows
 * properties, array items, `anyOf`, `oneOf`, `allOf` and `$ref`s into the schema's own `$defs`
 * or `definitions`.
 */
export const limitedInputFiles = (
  inputSchema: unknown,
  input: unknown,
): readonly {
  readonly path: string;
  readonly reference: string;
  readonly limits: SiteFileLimits;
}[] => {
  const found = new Map<string, { path: string; reference: string; limits: SiteFileLimits }>();
  const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const resolve = (schema: Readonly<Record<string, unknown>>) => {
    const reference = schema["$ref"];
    if (typeof reference !== "string") return schema;
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/u.exec(reference);
    const definitions = match === null || !record(inputSchema) ? undefined : inputSchema[match[1] ?? ""];
    const name = match?.[2]?.replaceAll("~1", "/").replaceAll("~0", "~");
    const target = record(definitions) && name !== undefined ? definitions[name] : undefined;
    return record(target) ? target : undefined;
  };
  const visit = (node: unknown, value: unknown, path: string, depth: number): void => {
    if (depth > maximumLimitDepth || !record(node)) return;
    const schema = resolve(node);
    if (schema === undefined) return;
    if (schema !== node) return visit(schema, value, path, depth + 1);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = schema[key];
      if (Array.isArray(branches))
        for (const branch of branches) visit(branch, value, path, depth + 1);
    }
    const limits = declaredFileLimits(schema);
    if (limits !== undefined && typeof value === "string" && !found.has(path))
      found.set(path, { path, reference: value, limits });
    const properties = schema["properties"];
    if (record(properties) && record(value))
      for (const [name, property] of Object.entries(properties))
        if (Object.hasOwn(value, name))
          visit(
            property,
            value[name],
            plainName.test(name)
              ? `${path === "" ? "" : `${path}.`}${name}`
              : `${path}[${JSON.stringify(name)}]`,
            depth + 1,
          );
    const items = schema["items"];
    if (Array.isArray(value))
      value.forEach((item: unknown, index) =>
        visit(
          Array.isArray(items) ? (items[index] ?? schema["additionalItems"]) : items,
          item,
          `${path}[${index}]`,
          depth + 1,
        ),
      );
  };
  visit(inputSchema, input, "", 0);
  return [...found.values()];
};

/**
 * What a caller reads when its file breaks the limits the site states for `path`: the input, the
 * limit and what to send instead, never the file's name or contents. It starts "Caller input
 * error:", as a refusal of the input alone, checked before any site action, does.
 */
export const siteFileRefusalMessage = (
  path: string,
  limits: SiteFileLimits,
  refused: { readonly reason: "too_large" | "not_accepted"; readonly size: number },
) =>
  refused.reason === "too_large"
    ? `Caller input error: ${path} is ${refused.size} bytes, over the site's limit of ${limits.maxBytes} bytes for this file. Send a smaller file.`
    : `Caller input error: ${path} is not a file type the site takes for this input, which takes only ${(limits.extensions ?? []).join(", ")}. Send a file of one of those types.`;

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

const Placement = Schema.Union(
  Schema.Struct({
    refused: Schema.Literal("field_not_found", "not_file_input", "other_site", "not_accepted"),
  }),
  Schema.Struct({
    chosen: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Number })),
  }),
);

/** The page locator a field names, written by the host from data, never the script's code. */
const fieldLocator = (field: FileField) =>
  "label" in field
    ? `page.getByLabel(${JSON.stringify(field.label)}, { exact: ${field.exact !== false} })`
    : `page.locator(${JSON.stringify(field.selector)})`;

/**
 * Page code that sets `element`, the file input in `frame`, to `path` on the browser's own machine
 * with `DOM.setFileInputFiles`. It marks the element with a one-time attribute, finds the marked
 * node in the DevTools document of the target that renders the frame (the frame's own target when
 * it runs in its own process, else its nearest ancestor's, the page's at the top), whose tree
 * holds every shadow root and same-process frame below, and removes the mark either way.
 */
const setByBrowserPathCode = (path: string, marker: string) => `
  const marker = ${JSON.stringify(marker)};
  await element.evaluate((node, marker) => node.setAttribute("data-placing-file", marker), marker);
  let session;
  try {
    for (let owner = frame; session === undefined; owner = owner.parentFrame()) {
      if (owner.parentFrame() === null) session = await page.context().newCDPSession(page);
      else session = await page.context().newCDPSession(owner).catch(() => undefined);
    }
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const pending = [root];
    let input;
    while (input === undefined && pending.length > 0) {
      const node = pending.pop();
      const attributes = node.attributes ?? [];
      for (let index = 0; index + 1 < attributes.length; index += 2)
        if (attributes[index] === "data-placing-file" && attributes[index + 1] === marker) input = node;
      pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument === undefined ? [] : [node.contentDocument]));
    }
    if (input === undefined) throw new Error("The file input is not in the frame's document");
    await session.send("DOM.setFileInputFiles", { files: [${JSON.stringify(path)}], backendNodeId: input.backendNodeId });
  } finally {
    await element.evaluate((node) => node.removeAttribute("data-placing-file")).catch(() => undefined);
    await session?.detach().catch(() => undefined);
  }`;

/**
 * Page code that finds the one element `field` names and, only when it is a file input whose
 * frame is on the site and whose `accept` takes the file, sets that same element to `path`, then
 * reads back the names and sizes it holds. The frame's address comes from Playwright, not from
 * the page. A frame is on the site at the site's own origin, or on an https host of its
 * registrable domain. With `byBrowserPath`, the browser reads `path` on its own machine
 * (`setByBrowserPathCode`); else Playwright's `setInputFiles` reads it where the page code runs.
 */
const placeCode = (options: {
  readonly field: FileField;
  readonly path: string;
  readonly file: { readonly name: string; readonly mediaType: string };
  readonly siteOrigin: string;
  readonly siteDomain: string | undefined;
  readonly timeoutMs: number;
  readonly byBrowserPath: boolean;
}) => `
const accepts = ${acceptsSource};
const field = ${fieldLocator(options.field)};
try { await field.first().waitFor({ state: "attached", timeout: ${options.timeoutMs} }); } catch { return { refused: "field_not_found" }; }
if ((await field.count()) !== 1) return { refused: "field_not_found" };
const element = await field.elementHandle({ timeout: ${options.timeoutMs} });
try {
  const facts = await element.evaluate((node) => ({ file: node instanceof HTMLInputElement && node.type === "file", accept: node.getAttribute("accept") ?? "" }));
  if (!facts.file) return { refused: "not_file_input" };
  const frame = await element.ownerFrame();
  const address = (() => { try { return new URL(frame === null ? "" : frame.url()); } catch { return null; } })();
  const onSiteHost = ${options.siteDomain === undefined ? "() => false" : hostOnSiteSource(options.siteDomain)};
  const onSite = address !== null && (address.origin === ${JSON.stringify(options.siteOrigin)} || (address.protocol === "https:" && onSiteHost(address.hostname)));
  if (!onSite) return { refused: "other_site" };
  if (!accepts(facts.accept, ${JSON.stringify(options.file)})) return { refused: "not_accepted" };${
    options.byBrowserPath
      ? setByBrowserPathCode(options.path, randomUUID())
      : `
  await element.setInputFiles(${JSON.stringify(options.path)}, { timeout: ${options.timeoutMs} });`
  }
  return { chosen: await element.evaluate((node) => [...node.files].map((file) => ({ name: file.name, size: file.size }))) };
} finally {
  await element.dispose();
}`;

const Screenshot = Schema.Union(
  Schema.Struct({ refused: Schema.Literal("field_not_found") }),
  Schema.Struct({ saved: Schema.Literal(true) }),
  Schema.Struct({ tooLarge: Schema.Literal(true) }),
  Schema.Struct({ base64: Schema.String }),
);

/**
 * Page code that takes a PNG screenshot of the page, or of the one element `target.selector`
 * names once it is visible, and writes it to `sink` when that is a path, else returns it as
 * base64 when it holds at most `sink` bytes. The selector is data in the host's own locator.
 */
const screenshotCode = (target: ScreenshotTarget, waitMs: number, sink: string | number) => {
  const element = target.selector !== undefined;
  // Playwright reads a timeout of 0 as no timeout at all.
  const timeoutMs = Math.max(1, Math.floor(waitMs));
  const options = [
    `type: "png"`,
    `timeout: ${timeoutMs}`,
    ...(target.fullPage === true && !element ? ["fullPage: true"] : []),
    ...(typeof sink === "string" ? [`path: ${JSON.stringify(sink)}`] : []),
  ];
  return `
const target = ${element ? `page.locator(${JSON.stringify(target.selector)})` : "page"};${
    element
      ? `
try { await target.waitFor({ state: "visible", timeout: ${timeoutMs} }); } catch { return { refused: "field_not_found" }; }`
      : ""
  }
const image = await target.screenshot({ ${options.join(", ")} });
return ${typeof sink === "string" ? "{ saved: true }" : `image.length > ${sink} ? { tooLarge: true } : { base64: image.toString("base64") }`};`;
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
    /** The latest download refused over the caps, with the cap it went over. */
    let overCap: DownloadCap | undefined;
    const refuseOverCap = (reason: "too_large" | "run_limit") =>
      Effect.suspend(() => {
        overCap =
          reason === "too_large"
            ? { limit: "file", maxBytes: limits.fileBytes }
            : { limit: "run", maxBytes: limits.runBytes, maxFiles: limits.runFiles };
        return refuse(reason);
      });
    const used = yield* Ref.make({ files: 0, bytes: 0 });
    const collected = yield* Ref.make<readonly FileObject[]>([]);
    const slots = new Set<string>();
    /** Whether one more file of `size` bytes fits the run's caps. */
    const fits = (size: number) =>
      Ref.get(used).pipe(
        Effect.map(
          (current) =>
            current.files + 1 <= limits.runFiles && current.bytes + size <= limits.runBytes,
        ),
      );
    /** Counts a placed or collected file against the run's caps. */
    const count = (size: number) =>
      Ref.update(used, (current) => ({ files: current.files + 1, bytes: current.bytes + size }));
    const run = (code: string, timeoutSec: number) =>
      options.execute(code, timeoutSec).pipe(
        Effect.flatMap((answer) =>
          answer.success ? Effect.succeed(answer.result) : Effect.fail(new Error(answer.error)),
        ),
      );
    const place: RunFiles["place"] = ({ reference, field, timeoutSec, maxBytes, extensions }) =>
      Effect.gen(function* () {
        // The field is data the host writes into its own locator; anything else is refused.
        if (Either.isLeft(Schema.decodeUnknownEither(FileField)(field)))
          return yield* refuse("field_not_found");
        const resolved = options.resolve(reference);
        if (resolved === undefined) return yield* refuse("unknown_reference");
        const siteOrigin = options.siteOrigin;
        if (siteOrigin === undefined) return yield* refuse("other_site");
        const source = yield* options.hook
          .open(resolved)
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        // The site's own limits, when the script names them, refuse the file before a byte is read.
        const outside = siteFileRefusal(
          {
            ...(maxBytes === undefined ? {} : { maxBytes }),
            ...(extensions === undefined ? {} : { extensions }),
          },
          source,
        );
        if (outside !== undefined) return yield* refuse(outside);
        if (source.size > limits.fileBytes) return yield* refuse("too_large");
        if (!(yield* fits(source.size))) return yield* refuse("run_limit");
        const bytes = yield* source.read.pipe(
          Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
        );
        if (bytes.byteLength !== source.size) return yield* refuse("unavailable");
        const name = safeName(source.name, "file");
        if (isProgram(bytes, name)) return yield* refuse("executable");
        if (!bytesMatchType(bytes, source.media_type)) return yield* refuse("type_mismatch");
        const path = yield* options.hook
          .writeToBrowser({ name, bytes })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        // From here the page call may set the input, so a failure may have started an upload.
        const sent = (reason: FileRefusalReason) =>
          Effect.fail(new FileRefused({ reason, dispatched: true }));
        const placement = yield* run(
          placeCode({
            field,
            path,
            file: { name, mediaType: source.media_type },
            siteOrigin,
            siteDomain: siteDomain(siteOrigin),
            timeoutMs: timeoutSec * 1000,
            byBrowserPath: options.hook.placeByBrowserPath === true,
          }),
          timeoutSec * 2 + 5,
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Placement)),
          Effect.catchAll(() => sent("unavailable")),
        );
        // A check that failed in the page refused before the input was set.
        if ("refused" in placement) return yield* refuse(placement.refused);
        if (!placement.chosen.some((file) => file.name === name && file.size === bytes.byteLength))
          return yield* sent("unavailable");
        yield* count(bytes.byteLength);
        return {
          name,
          media_type: source.media_type,
          size: bytes.byteLength,
        } satisfies PlacedFile;
      });
    // Each capture starts with no refusal, so `overCap` names only the latest one's.
    const arm: RunFiles["arm"] = () =>
      Effect.sync(() => {
        overCap = undefined;
      }).pipe(
        Effect.zipRight(options.hook.armDownloads()),
        Effect.tap((slot) => Effect.sync(() => slots.add(slot))),
        Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
      );
    /** Keeps a file within the run's caps for its caller, as one the run collected. */
    const keepCollected = (name: string, bytes: Uint8Array, contentType?: string) =>
      Effect.gen(function* () {
        if (!(yield* fits(bytes.byteLength))) return yield* refuseOverCap("run_limit");
        yield* count(bytes.byteLength);
        // The bytes decide the type when they prove one, else the server's; never the name.
        const media_type =
          sniffedType(bytes) ?? serverType(contentType) ?? "application/octet-stream";
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const size = bytes.byteLength;
        const kept = yield* options.hook
          .keep({ name, media_type, size, sha256, bytes })
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
    const collect: RunFiles["collect"] = ({ slot, timeoutMs }) =>
      Effect.gen(function* () {
        if (!slots.delete(slot)) return yield* refuse("unknown_reference");
        const current = yield* Ref.get(used);
        const room = Math.min(limits.fileBytes, limits.runBytes - current.bytes);
        const taken = yield* options.hook
          .takeDownload(slot, { timeoutMs, maxBytes: Math.max(0, room) })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        if (taken === undefined) return yield* refuse("no_download");
        if ("tooLarge" in taken)
          return yield* refuseOverCap(room < limits.fileBytes ? "run_limit" : "too_large");
        const name = safeName(taken.name, "download");
        if (isProgram(taken.bytes, name)) return yield* refuse("executable");
        return yield* keepCollected(name, taken.bytes, taken.media_type);
      });
    const screenshot: NonNullable<RunFiles["screenshot"]> = ({ timeoutMs, ...request }) =>
      Effect.gen(function* () {
        overCap = undefined;
        const unavailable = () => new FileRefused({ reason: "unavailable" });
        // Decoding keeps only the target's own fields, the selector as data.
        const target = Schema.decodeUnknownEither(ScreenshotTarget)(request);
        if (Either.isLeft(target)) return yield* refuse("field_not_found");
        const current = yield* Ref.get(used);
        const room = Math.max(0, Math.min(limits.fileBytes, limits.runBytes - current.bytes));
        const file =
          options.hook.screenshotFile === undefined
            ? undefined
            : yield* options.hook.screenshotFile().pipe(Effect.mapError(unavailable));
        const shot = yield* run(
          screenshotCode(target.right, timeoutMs, file?.path ?? room),
          Math.min(300, Math.ceil(timeoutMs / 500) + 5),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Screenshot)),
          Effect.mapError(unavailable),
        );
        if ("refused" in shot) return yield* refuse(shot.refused);
        const taken =
          "base64" in shot
            ? new Uint8Array(Buffer.from(shot.base64, "base64"))
            : "tooLarge" in shot
              ? shot
              : file === undefined
                ? yield* Effect.fail(unavailable())
                : yield* file.read(room).pipe(Effect.mapError(unavailable));
        if (!(taken instanceof Uint8Array))
          return yield* refuseOverCap(room < limits.fileBytes ? "run_limit" : "too_large");
        return yield* keepCollected("screenshot.png", taken);
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
    return { place, arm, collect, screenshot, checkOutput, overCap: () => overCap };
  });

/** Every `$file` object in an output, wherever it sits. */
export const outputFiles = (output: unknown): readonly unknown[] => {
  if (Array.isArray(output)) return output.flatMap(outputFiles);
  if (typeof output !== "object" || output === null) return [];
  if (isFileObject(output)) return [output];
  return Object.values(output).flatMap(outputFiles);
};
