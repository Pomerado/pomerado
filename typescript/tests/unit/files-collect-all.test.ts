import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import {
  makeRunFiles,
  type CapturedDownload,
  type FileHostHook,
  type RunFiles,
} from "../../src/runtime/file-transfer.js";
import type { FileLimits } from "../../src/runtime/files.js";
import type { KernelExecuteClient } from "../../src/runtime/kernel-operation.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { defineOperation } from "../../src/runtime/operation.js";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A finished download the fake host saved, with its bytes. */
const finished = (
  name: string,
  content: string,
  extra: { readonly url?: string; readonly media_type?: string } = {},
): CapturedDownload => ({
  name,
  size: bytes(content).byteLength,
  read: Effect.succeed(bytes(content)),
  ...extra,
});

/**
 * A host whose capture saw `captured`, recording what the run asked of it. Without `captured`
 * it is an older host that cannot take every download.
 */
const fakeHost = (captured?: readonly CapturedDownload[]) => {
  const seen = { armed: 0, bounds: [] as unknown[], kept: [] as string[] };
  const hook: FileHostHook = {
    open: () => Effect.fail(new Error("no caller files")),
    writeToBrowser: () => Effect.fail(new Error("no placement")),
    armDownloads: () => Effect.sync(() => `slot-${++seen.armed}`),
    takeDownload: () => Effect.succeed(undefined),
    keep: (file) =>
      Effect.sync(() => {
        seen.kept.push(file.name);
        return { id: `kept-${seen.kept.length}` };
      }),
    ...(captured === undefined
      ? {}
      : {
          takeDownloads: (_slot, bounds) =>
            Effect.sync(() => {
              seen.bounds.push(bounds);
              return captured;
            }),
        }),
  };
  return { hook, seen };
};

/**
 * Runs a script that clicks once and calls `files.collectAll` with `options`, returning what it
 * returned or, when it threw, the error's name, message and dispatch.
 */
const collectAll = async (
  hook: FileHostHook,
  options: { readonly max?: number; readonly limits?: FileLimits } = {},
) => {
  const calls: string[] = [];
  const kernel: KernelExecuteClient = {
    browsers: {
      playwright: {
        execute: async (_session, request) => {
          calls.push(request.code);
          return { success: true, result: true };
        },
      },
    },
  };
  const files: RunFiles = await Effect.runPromise(
    makeRunFiles({
      hook,
      execute: () => Effect.succeed({ success: true, result: null }),
      siteOrigin: "https://example.test",
      resolve: () => undefined,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    }),
  );
  const operation = defineOperation(
    { input: Schema.Struct({}), output: Schema.Unknown },
    async ({ kernel: client, sessionId, files: run }) => {
      try {
        return {
          downloads: await run.collectAll(
            () =>
              client.browsers.playwright.execute(sessionId, {
                code: "await page.getByRole('link', { name: 'Download all' }).click();",
              }),
            options.max === undefined ? undefined : { max: options.max },
          ),
        };
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
  return { output: exit.value as Record<string, unknown>, calls, files };
};

const csv = "date,amount\n2026-01-02,12.50\n";
const sha256Of = async (text: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes(text))).toString("hex");

describe("files.collectAll", () => {
  it("returns every download the trigger started in the order they began, and reports each one it took no file from", async () => {
    const { hook, seen } = fakeHost([
      finished("statement-1.csv", csv, {
        url: "https://example.test/statements/1.csv",
        media_type: "text/csv",
      }),
      { name: "statement-2.csv", url: "https://example.test/statements/2.csv", ended: "canceled" },
      finished("statement-3.csv", csv, { url: "https://example.test/statements/3.csv?page=2" }),
      { name: "statement-4.csv", ended: "unfinished" },
      finished("run.csv", "#!/bin/sh\necho hi\n", { url: "https://example.test/run.csv" }),
      // A data: address carries the file's own bytes, so the script never sees it.
      finished("inline.csv", csv, { url: `data:text/csv,${encodeURIComponent(csv)}` }),
    ]);
    const { output, calls, files } = await collectAll(hook);
    const sha256 = await sha256Of(csv);
    const file = (id: string, name: string, media_type: string) => ({
      $file: { id, name, media_type, size: csv.length, sha256 },
    });
    expect(output).toEqual({
      downloads: [
        {
          file: file("kept-1", "statement-1.csv", "text/csv"),
          url: "https://example.test/statements/1.csv",
        },
        { failed: "canceled", name: "statement-2.csv", url: "https://example.test/statements/2.csv" },
        {
          file: file("kept-2", "statement-3.csv", "application/octet-stream"),
          url: "https://example.test/statements/3.csv?page=2",
        },
        { failed: "unfinished", name: "statement-4.csv" },
        { failed: "executable", name: "run.csv", url: "https://example.test/run.csv" },
        { file: file("kept-3", "inline.csv", "application/octet-stream") },
      ],
    });
    // One capture around the trigger's one call, bounded by what the run's caps leave.
    expect(calls).toHaveLength(1);
    expect(seen.armed).toBe(1);
    expect(seen.bounds).toEqual([{ timeoutMs: 30_000, settleMs: 1_000, max: 10 }]);
    expect(seen.kept).toEqual(["statement-1.csv", "statement-3.csv", "inline.csv"]);
    // Each collected file may stand in the run's output, as a collected one does.
    await Effect.runPromise(files.checkOutput(output));
  });

  it("fails the run as the host's limit, naming the cap and which downloads are over it", async () => {
    const overFile = await collectAll(
      fakeHost([
        finished("a.csv", csv),
        finished("b.csv", csv.repeat(4)),
        finished("c.csv", csv.repeat(4)),
      ]).hook,
      { limits: { fileBytes: csv.length * 2, runFiles: 10, runBytes: 1024 } },
    );
    expect(overFile.output).toEqual({
      failed: "OperationFailure",
      message: expect.stringMatching(/2 and 3 of 3.*too_large/u),
      dispatch: "unknown",
    });
    const overRun = await collectAll(
      fakeHost([finished("a.csv", csv), finished("b.csv", csv), finished("c.csv", csv)]).hook,
      { limits: { fileBytes: 1024, runFiles: 2, runBytes: 1024 } },
    );
    expect(overRun.output).toEqual({
      failed: "OperationFailure",
      message: expect.stringMatching(/3 of 3.*run_limit/u),
      dispatch: "unknown",
    });
  });

  it("takes at most max downloads and reports each one past it", async () => {
    const { hook, seen } = fakeHost([finished("a.csv", csv), finished("b.csv", csv)]);
    const { output } = await collectAll(hook, { max: 1 });
    expect(output["downloads"]).toEqual([
      { file: expect.objectContaining({ $file: expect.objectContaining({ name: "a.csv" }) }) },
      { failed: "over_max", name: "b.csv" },
    ]);
    expect(seen.bounds).toEqual([{ timeoutMs: 30_000, settleMs: 1_000, max: 1 }]);
    expect(seen.kept).toEqual(["a.csv"]);
  });

  it("refuses a trigger that started no download, as files.collect does", async () => {
    const { output } = await collectAll(fakeHost([]).hook);
    expect(output).toEqual({
      failed: "OperationFailure",
      message: expect.stringContaining("no_download"),
      dispatch: "unknown",
    });
  });

  it("fails closed on a host that cannot take every download, before it arms or runs the trigger", async () => {
    const { hook, seen } = fakeHost();
    const { output, calls } = await collectAll(hook);
    expect(output).toEqual({
      failed: "OperationFailure",
      message: expect.stringContaining("files.collectAll"),
      dispatch: "not_sent",
    });
    expect(calls).toEqual([]);
    expect(seen.armed).toBe(0);
  });
});
