import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  makeRunFiles,
  type FileHostHook,
  type TakenDownload,
} from "../../src/runtime/file-transfer.js";

/*
 * A download over the host's own file caps is the host's limit, never the caller's input, and a
 * build's host marks the failed step with the cap it went over (`RunFiles.overCap`), so the build
 * can end on that limit instead of asking its owner to narrow the request.
 */

const unused = () => Effect.fail(new Error("Unused in this test"));

/** A host that hands the run each download in turn, as the browser finished it. */
const hookTaking = (downloads: readonly TakenDownload[]): FileHostHook => {
  let next = 0;
  return {
    open: unused,
    writeToBrowser: unused,
    armDownloads: () => Effect.succeed(`slot_${next}`),
    takeDownload: () => Effect.succeed(downloads[next++]),
    keep: () => Effect.succeed({ id: `file_${next}` }),
  };
};

const text = (bytes: number): TakenDownload => ({
  name: "report.csv",
  bytes: new TextEncoder().encode("a".repeat(bytes)),
  media_type: "text/csv",
});

const collectOne = (files: Effect.Effect.Success<ReturnType<typeof makeRunFiles>>) =>
  files.arm().pipe(Effect.flatMap((slot) => files.collect({ slot, timeoutMs: 1000 })));

it("names the per-file cap a download went over", async () => {
  const files = await Effect.runPromise(
    makeRunFiles({
      hook: hookTaking([{ tooLarge: true }]),
      execute: unused,
      siteOrigin: "https://files.example.test",
      resolve: () => undefined,
      limits: { fileBytes: 10, runFiles: 3, runBytes: 100 },
    }),
  );
  expect(files.overCap?.()).toBeUndefined();
  const refused = await Effect.runPromise(Effect.flip(collectOne(files)));
  expect(refused.reason).toBe("too_large");
  expect(files.overCap?.()).toEqual({ limit: "file", maxBytes: 10 });
});

it("names the run's caps when a download would take the run's files over them", async () => {
  const files = await Effect.runPromise(
    makeRunFiles({
      hook: hookTaking([text(8), { tooLarge: true }]),
      execute: unused,
      siteOrigin: "https://files.example.test",
      resolve: () => undefined,
      limits: { fileBytes: 10, runFiles: 3, runBytes: 15 },
    }),
  );
  await Effect.runPromise(collectOne(files));
  expect(files.overCap?.()).toBeUndefined();
  const refused = await Effect.runPromise(Effect.flip(collectOne(files)));
  expect(refused.reason).toBe("run_limit");
  expect(files.overCap?.()).toEqual({ limit: "run", maxBytes: 15, maxFiles: 3 });
});

it("names no cap once a later capture starts", async () => {
  const files = await Effect.runPromise(
    makeRunFiles({
      hook: hookTaking([{ tooLarge: true }, text(8)]),
      execute: unused,
      siteOrigin: "https://files.example.test",
      resolve: () => undefined,
      limits: { fileBytes: 10, runFiles: 3, runBytes: 100 },
    }),
  );
  await Effect.runPromise(Effect.flip(collectOne(files)));
  expect(files.overCap?.()).toEqual({ limit: "file", maxBytes: 10 });
  await Effect.runPromise(collectOne(files));
  expect(files.overCap?.()).toBeUndefined();
});

it("keeps a screenshot the page call returns within the caps, and names the cap one goes over", async () => {
  // A host without `screenshotFile` gets the PNG back from its page call, sized by the page.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const files = await Effect.runPromise(
    makeRunFiles({
      hook: hookTaking([]),
      execute: () => Effect.succeed({ success: true, result: { base64: png.toString("base64") } }),
      siteOrigin: "https://files.example.test",
      resolve: () => undefined,
      limits: { fileBytes: png.length, runFiles: 3, runBytes: png.length + 4 },
    }),
  );
  const shoot = () => files.screenshot?.({ timeoutMs: 1000 }) ?? Effect.die("No screenshot");
  const kept = await Effect.runPromise(shoot());
  expect(kept.$file).toMatchObject({ name: "screenshot.png", media_type: "image/png" });
  await Effect.runPromise(files.checkOutput({ kept }));
  const refused = await Effect.runPromise(Effect.flip(shoot()));
  expect(refused.reason).toBe("run_limit");
  expect(files.overCap?.()).toEqual({ limit: "run", maxBytes: png.length + 4, maxFiles: 3 });
});
