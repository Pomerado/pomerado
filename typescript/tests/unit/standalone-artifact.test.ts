import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
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

it.each([
  "MCP.mjs",
  "Mcp.Json",
  "readme.md/main.mjs",
  "Codex-MCP.toml",
  ".MCP.json",
  ".vscode/mcp.json",
  ".Cursor/mcp.json",
  ".codex/config.toml",
  ".GEMINI/settings.json",
  ".claude/settings.json",
])(
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

it("packages a client-neutral MCP server entry that holds no key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pomerado-integration-"));
  try {
    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const publish = yield* prepareIntegration({
            root,
            name: "example_reader",
            request: { url: "https://example.test", intent: "Read page", effect: "read" },
          });
          return yield* publish({
            entrypoint: "src/main.mjs",
            files: [{ path: "src/main.mjs", content: "export default {};" }],
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          });
        }),
      ),
    );
    const directory = join(await realpath(root), "example_reader");
    expect(published.configPath).toBe(join(directory, "mcp.json"));
    expect((await readdir(directory)).sort()).toEqual([
      "README.md",
      "deployment.json",
      "mcp.json",
      "mcp.mjs",
      "pomerado.json",
      "src",
    ]);
    const launcher = join(directory, "mcp.mjs");
    expect(JSON.parse(await readFile(published.configPath, "utf8"))).toEqual({
      mcpServers: {
        example_reader: {
          command: process.execPath,
          args: [launcher, expect.stringMatching(/^file:\/\/.+\/mcp-cli\.js$/)],
        },
      },
    });
    const readme = await readFile(join(directory, "README.md"), "utf8");
    for (const command of [
      "claude mcp add example_reader -- ",
      "codex mcp add example_reader -- ",
      "gemini mcp add example_reader ",
    ])
      expect(readme).toContain(command);
    // Running a minted integration makes no Guardian or model request, so it needs no key.
    expect(readme).toContain("The server needs no model key");
    expect(readme).not.toContain("OPENAI_API_KEY");
    expect(readme).not.toContain("env_vars");
    // A call starts at the URL's site root, as the example did, not at its path.
    expect(readme.replaceAll(/\s+/gu, " ")).toContain(
      "Each call starts at the site root of the URL in deployment.json and opens any deeper page itself.",
    );
    expect(readme).not.toContain("Each call opens the URL");
    // A run uses only the URL and the authority's tool hints from deployment.json.
    expect(readme.replaceAll(/\s+/gu, " ")).toContain(
      "A run doesn't check authority, intent or sign-in origins, and edits to src/ or deployment.json aren't reviewed.",
    );
    expect(readme).not.toContain("pinned");
    expect(readme).not.toContain("codex-mcp.toml");
    expect(await readFile(launcher, "utf8")).not.toContain("Codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
