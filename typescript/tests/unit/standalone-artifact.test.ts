import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { prepareIntegration } from "../../src/standalone/mcp-package.js";
import { readArtifact, writeArtifact } from "../../src/standalone/artifact-files.js";

it("preserves an artifact roundtrip and refuses metadata collisions before writing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-artifact-"));
  const artifact = {
    entrypoint: "src/main.mjs",
    files: [{ path: "src/main.mjs", content: "export default {};" }],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  };
  try {
    for (const path of [
      "pomerado.json",
      "/workspace/pomerado.json",
      "Pomerado.JSON",
      "pomerado.json/data.txt",
    ]) {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            writeArtifact(directory, {
              ...artifact,
              files: [...artifact.files, { path, content: "authored source" }],
            }),
          ),
        ),
      ).rejects.toThrow("metadata file");
      expect(await readdir(directory)).toEqual([]);
    }
    const restored = await Effect.runPromise(
      Effect.scoped(
        writeArtifact(directory, artifact).pipe(Effect.andThen(readArtifact(directory))),
      ),
    );
    expect(restored).toEqual(artifact);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["MCP.mjs", "readme.md/main.mjs"])(
  "refuses packaging collision %s and removes the incomplete integration",
  async (path) => {
    const root = await mkdtemp(join(tmpdir(), "pomerado-integration-"));
    try {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const publish = yield* prepareIntegration({
                root,
                name: "reserved_collision",
                request: { url: "https://example.test", intent: "Read page", effect: "read" },
              });
              return yield* publish({
                entrypoint: path,
                files: [{ path, content: "export default {};" }],
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              });
            }),
          ),
        ),
      ).rejects.toThrow("collides with an integration packaging file");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
