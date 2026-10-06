import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Effect } from "effect";
import { prepareIntegration } from "../../src/standalone/mcp-package.js";

const operation = (sdk: string) => `import { Schema } from "effect";
import { defineOperation } from "${sdk}";
import { heading } from "./lib/heading.mjs";
export default defineOperation({name:"read_saved",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:heading(response.result)};
});`;

/** A saved integration as `pomerado-mcp mint` writes it; 0.2.0 wrote the same files. */
const saveIntegration = (root: string, name: string, url: string, files: Record<string, string>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const publish = yield* prepareIntegration({
          root,
          name,
          request: { url, intent: "Read the saved fixture heading", effect: "read" },
        });
        yield* publish({
          entrypoint: "src/tool.mjs",
          files: Object.entries(files).map(([path, content]) => ({ path, content })),
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: {
            type: "object",
            properties: { heading: { type: "string" } },
            required: ["heading"],
            additionalProperties: false,
          },
        });
        return join(root, name);
      }),
    ),
  );

const terminal = async (args: readonly string[]) => {
  const child = spawn(process.execPath, ["dist/typescript/src/standalone/cli.js", ...args], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  return { code: closed[0], stdout, stderr };
};

/** Serves the saved launcher with the built runtime, as its mcp.json does, and calls the tool. */
const serveAndCall = async (directory: string, name: string) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(directory, "mcp.mjs"),
      pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href,
    ],
    env: { PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "pomerado-saved-integration", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const result = await client.callTool({ name, arguments: { input: {} } });
    return { tools, result, stderr };
  } finally {
    await client.close();
  }
};

const cases = [
  {
    // An entrypoint in src/ reached the SDK one level up, and a nested module two levels up,
    // under the layout 0.2.0's executor used.
    title: "an integration saved with 0.2.0's one-level-up SDK imports still runs and serves",
    files: {
      "src/tool.mjs": operation("../runtime/index.js"),
      "src/lib/heading.mjs": `import { defineOperation } from "../../runtime/index.js";
export const heading = (value) => (typeof defineOperation === "function" ? String(value).trim() : "");`,
    },
  },
  {
    title: "an integration saved with the documented SDK import runs and serves",
    files: {
      "src/tool.mjs": operation("../../runtime/index.js"),
      "src/lib/heading.mjs": `import { defineOperation } from "../../../runtime/index.js";
export const heading = (value) => (typeof defineOperation === "function" ? String(value).trim() : "");`,
    },
  },
];

for (const { title, files } of cases)
  test(title, async () => {
    test.setTimeout(60_000);
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<h1>  Saved fixture  </h1>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const url = `http://127.0.0.1:${address.port}/`;
    const root = await mkdtemp(join(tmpdir(), "pomerado-saved-imports-"));
    try {
      const directory = await saveIntegration(root, "read_saved", url, files);
      const ran = await terminal(["run", "--artifact", directory, "--url", url]);
      expect(ran.code, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual({ heading: "Saved fixture" });
      const served = await serveAndCall(directory, "read_saved");
      expect(served.tools).toContain("read_saved");
      expect(served.result, served.stderr).toMatchObject({
        structuredContent: { heading: "Saved fixture" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
