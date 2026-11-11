import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { openLocalFile, takeAllSettled } from "../../src/execution/local-files.js";

it("reads a caller's file only at the size it had when opened, refusing one that grew since", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-local-files-qa-"));
  try {
    const path = join(directory, "receipt.txt");
    await writeFile(path, "Receipt 1042\n");
    const same = await Effect.runPromise(openLocalFile(pathToFileURL(path).href));
    expect(new TextDecoder().decode(await Effect.runPromise(same.read))).toBe("Receipt 1042\n");
    const grown = await Effect.runPromise(openLocalFile(pathToFileURL(path).href));
    await appendFile(path, "x".repeat(1 << 20));
    await expect(Effect.runPromise(grown.read)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("waits for the first downloads to begin, not the first to end, when a take is bounded by max", () => {
  const bounds = { max: 2, settleMs: 1_000 };
  // A, B and C began in that order; B and C ended first while A still runs.
  const a: { result?: unknown } = {};
  const downloads = [a, { result: { saved: true } }, { result: { saved: true } }];
  expect(takeAllSettled(downloads, bounds, 0)).toBe(false);
  a.result = { saved: true };
  expect(takeAllSettled(downloads, bounds, 0)).toBe(true);
});

it("ends an unbounded take once every download that began ended and none began or ended since", () => {
  const bounds = { max: 10, settleMs: 1_000 };
  const downloads = [{ result: { saved: true } }, { result: { saved: false } }];
  expect(takeAllSettled(downloads, bounds, 999)).toBe(false);
  expect(takeAllSettled(downloads, bounds, 1_000)).toBe(true);
  expect(takeAllSettled([...downloads, {}], bounds, 5_000)).toBe(false);
  expect(takeAllSettled([], bounds, 5_000)).toBe(false);
});
