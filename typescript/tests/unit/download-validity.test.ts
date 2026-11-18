import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { makeRunFiles, type FileHostHook } from "../../src/runtime/file-transfer.js";
import type { KernelExecuteClient } from "../../src/runtime/kernel-operation.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { defineOperation } from "../../src/runtime/operation.js";

const bytes = (body: string | Uint8Array) =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;
/** Synthetic bytes: a file type's signature followed by filler. */
const binary = (...start: readonly (number | string)[]) =>
  new Uint8Array([
    ...start.flatMap((part) =>
      typeof part === "string" ? [...part].map((character) => character.charCodeAt(0)) : [part],
    ),
    ...new Array<number>(32).fill(7),
  ]);

/** A synthetic one-page PDF: its header, a body and its end marker. */
const pdf = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";
const signInPage = "<!doctype html><title>Sign in</title><form><input name=user></form>";

/**
 * Runs a script that clicks once inside `files.collect`, with a host whose capture finished
 * `download`, and returns what the script returned, or the error's name, message and dispatch.
 */
const collect = async (download: {
  readonly name: string;
  readonly body: string | Uint8Array;
  readonly media_type?: string;
}) => {
  const kept: string[] = [];
  const hook: FileHostHook = {
    open: () => Effect.fail(new Error("no caller files")),
    writeToBrowser: () => Effect.fail(new Error("no placement")),
    armDownloads: () => Effect.succeed("slot-1"),
    takeDownload: () =>
      Effect.succeed({
        name: download.name,
        bytes: bytes(download.body),
        ...(download.media_type === undefined ? {} : { media_type: download.media_type }),
      }),
    keep: (file) =>
      Effect.sync(() => {
        kept.push(file.name);
        return { id: `kept-${kept.length}` };
      }),
  };
  const kernel: KernelExecuteClient = {
    browsers: {
      playwright: { execute: async () => ({ success: true, result: true }) },
    },
  };
  const files = await Effect.runPromise(
    makeRunFiles({
      hook,
      execute: () => Effect.succeed({ success: true, result: null }),
      siteOrigin: "https://example.test",
      resolve: () => undefined,
    }),
  );
  const operation = defineOperation(
    { input: Schema.Struct({}), output: Schema.Unknown },
    async ({ kernel: client, sessionId, files: run }) => {
      try {
        const file = await run.collect(() =>
          client.browsers.playwright.execute(sessionId, {
            code: "await page.getByRole('link', { name: 'Report' }).click();",
          }),
        );
        return { file: file.$file };
      } catch (error) {
        const failure = error as Error & { readonly dispatch?: string };
        return { failed: failure.name, message: failure.message, dispatch: failure.dispatch };
      }
    },
  );
  const journal = await Effect.runPromise(makeEffectJournal);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      executeKernelOperation(operation, {}, { kernel, sessionId: "session-1", files }).pipe(
        Effect.provideService(ExecutionContext, {
          deadline: Deadline.after(60_000),
          journal,
          events: { emit: () => Effect.void },
          capture: { start: Effect.void, finish: Effect.void },
        }),
      ),
    ),
  );
  if (!Exit.isSuccess(exit)) throw new Error(`The run failed: ${String(exit.cause)}`);
  return { output: exit.value as Record<string, unknown>, kept };
};

describe("a collected download whose bytes contradict what it claims", () => {
  it.each([
    {
      case: "a sign-in page the server sent as a PDF",
      download: { name: "report.pdf", body: signInPage, media_type: "application/pdf" },
      says: "The server sent it as application/pdf, but its 67 bytes are not a PDF: they look like an HTML or XML page.",
    },
    {
      case: "a JSON error the server sent as a PDF under a name with no extension",
      download: { name: "report", body: '{"error":"expired"}', media_type: "application/pdf" },
      says: "The server sent it as application/pdf, but its 19 bytes are not a PDF: they look like JSON.",
    },
    {
      case: "an HTML page named .pdf that the server sent as a generic stream",
      download: { name: "report.pdf", body: signInPage, media_type: "application/octet-stream" },
      says: "Its name ends in .pdf, but its 67 bytes are not a PDF: they look like an HTML or XML page.",
    },
    {
      case: "a PDF cut short before its end marker",
      download: { name: "report.pdf", body: pdf.slice(0, 40), media_type: "application/pdf" },
      says: "The server sent it as application/pdf, but its 40 bytes do not end with a %%EOF end marker, so the PDF is cut short or damaged.",
    },
    {
      case: "a linearized PDF cut short after its first page's end marker",
      download: {
        name: "report.pdf",
        body: `${pdf}${"2 0 obj << /Type /Page >> endobj\n".repeat(64)}`,
        media_type: "application/pdf",
      },
      says: "The server sent it as application/pdf, but its 2189 bytes do not end with a %%EOF end marker, so the PDF is cut short or damaged.",
    },
    {
      case: "an empty download the server sent as a PDF",
      download: { name: "report", body: "", media_type: "application/pdf" },
      says: "The server sent it as application/pdf, but the download is empty.",
    },
    {
      case: "an empty download named as a PDF",
      download: { name: "report.pdf", body: "" },
      says: "Its name ends in .pdf, but the download is empty.",
    },
  ])("refuses $case as the tool's failure, keeping nothing", async ({ download, says }) => {
    const { output, kept } = await collect(download);
    // The tool's own failure, which a repair can fix, never the caller's input.
    expect(output).toEqual({
      failed: "OperationFailure",
      message: `The host refused the file: invalid_download. ${says}`,
      dispatch: "unknown",
    });
    expect(kept).toEqual([]);
  });

  it.each([
    {
      case: "a whole PDF the server sent as one",
      download: { name: "report.pdf", body: pdf, media_type: "application/pdf" },
      media_type: "application/pdf",
    },
    {
      case: "a PDF with a line before its header, as readers accept",
      download: { name: "report.pdf", body: `\n${pdf}`, media_type: "application/pdf" },
      media_type: "application/pdf",
    },
    {
      case: "a CSV export the server sent as a legacy spreadsheet",
      download: {
        name: "report.csv",
        body: "date,amount\n2026-01-02,12.50\n",
        media_type: "application/vnd.ms-excel",
      },
      media_type: "application/vnd.ms-excel",
    },
    {
      case: "an HTML table named as a legacy spreadsheet",
      download: { name: "report.xls", body: "<table><tr><td>1</td></tr></table>" },
      media_type: "application/octet-stream",
    },
    {
      case: "a web page the server sent as one",
      download: { name: "receipt.html", body: signInPage, media_type: "text/html" },
      media_type: "text/html",
    },
    {
      case: "a PDF padded with NUL bytes past its end marker",
      download: { name: "report.pdf", body: `${pdf}${"\0".repeat(4096)}`, media_type: "application/pdf" },
      media_type: "application/pdf",
    },
    {
      case: "a PDF named as an image, under the type its bytes prove",
      download: { name: "card.png", body: pdf },
      media_type: "application/pdf",
    },
    {
      case: "a PNG named .jpg",
      download: { name: "photo.jpg", body: binary(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a) },
      media_type: "image/png",
    },
    {
      case: "a WebP named .jpg",
      download: { name: "photo.jpg", body: binary("RIFF", 0, 0, 0, 0, "WEBP") },
      media_type: "image/webp",
    },
    {
      case: "an AVIF named .jpg",
      download: { name: "photo.jpg", body: binary(0, 0, 0, 0x1c, "ftypavif") },
      media_type: "application/octet-stream",
    },
    {
      case: "a JPEG the server sent as a PNG",
      download: { name: "photo", body: binary(0xff, 0xd8, 0xff, 0xe0), media_type: "image/png" },
      media_type: "image/jpeg",
    },
    {
      case: "a zip the server sent as gzip",
      download: { name: "export.zip", body: binary("PK", 3, 4), media_type: "application/gzip" },
      media_type: "application/zip",
    },
    {
      case: "an empty CSV export",
      download: { name: "export.csv", body: "", media_type: "text/csv" },
      media_type: "text/csv",
    },
    {
      case: "an empty download that claims no type",
      download: { name: "export", body: "" },
      media_type: "application/octet-stream",
    },
  ])("keeps $case", async ({ download, media_type }) => {
    const { output, kept } = await collect(download);
    expect(output).toMatchObject({ file: { name: download.name, media_type } });
    expect(kept).toEqual([download.name]);
  });
});
