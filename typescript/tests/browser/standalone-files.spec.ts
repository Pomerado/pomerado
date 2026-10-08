import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Effect, Exit, Schema, Scope } from "effect";
import { makeIntegrationMcp } from "../../src/standalone/mcp-server.js";
import { contractJsonSchema } from "../../src/runtime/operation.js";
import { FileInput, FileOutput } from "../../src/runtime/files.js";
import { receiptTool, startFileSite, statement, statementSha256 } from "./file-fixture.js";

const receipt = "Receipt 1042\nTotal 12.50\n";

/**
 * Serves one tool over MCP in this process, keeping downloads under `downloads`: by default the
 * receipt write, or a read with `source` that takes a receipt and returns what it placed.
 */
const serve = async (
  url: string,
  downloads: string,
  read?: { readonly source: string },
) => {
  const scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    makeIntegrationMcp({
      artifact: {
        files: [{ path: "src/tool.mjs", content: read?.source ?? receiptTool() }],
        entrypoint: "src/tool.mjs",
        inputSchema: contractJsonSchema(Schema.Struct({ receipt: FileInput })),
        outputSchema:
          read === undefined
            ? contractJsonSchema(Schema.Struct({ received: Schema.String, statement: FileOutput }))
            : { type: "object" },
      },
      deployment: {
        name: "send_receipt",
        description: "Upload a receipt and download the statement",
        request: {
          url,
          intent: "Upload a receipt and download the statement",
          effect: read === undefined ? "write" : "read",
        },
      },
      pomerado: { files: { downloads } },
    }).pipe(Scope.extend(scope)),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "file-qa", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

/** A tool that places `reference` (its input's receipt by default) into `field`. */
const placeTool = (field: string, reference = "input.receipt") => `import { Schema } from "effect";
import { defineOperation, FileInput } from "../runtime/index.js";
export default defineOperation({name:"place_receipt",input:Schema.Struct({receipt:FileInput}),output:Schema.Unknown},
async ({input,files}) => ({ placed: await files.place(${reference}, { field: ${JSON.stringify(field)} }) }));`;

test("an MCP tool call uploads the caller's file and returns the downloaded statement", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "One native run that both uploads and downloads through Chromium",
  });
  const site = await startFileSite();
  const directory = await mkdtemp(join(tmpdir(), "pomerado-files-qa-"));
  const downloads = join(directory, "downloads");
  const file = join(directory, "receipt.txt");
  await writeFile(file, receipt);
  const served = await serve(site.url, downloads);
  try {
    const result = await served.client.callTool({
      name: "send_receipt",
      arguments: { input: { receipt: pathToFileURL(file).href }, idempotency_key: "first" },
    });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const output = result.structuredContent as {
      received: string;
      statement: { $file: Record<string, unknown> };
    };
    // The site received the caller's bytes, under the file's own name.
    const sha256 = createHash("sha256").update(receipt).digest("hex");
    expect(site.received).toEqual([{ name: "receipt.txt", size: receipt.length, sha256 }]);
    expect(output.received).toBe(`receipt.txt ${receipt.length} ${sha256}`);
    // The download comes back as a file object; its bytes wait at its URL, not in the result.
    expect(output.statement.$file).toMatchObject({
      name: "statement.csv",
      media_type: "text/csv",
      size: statement.length,
      sha256: statementSha256,
    });
    expect(JSON.stringify(result)).not.toContain("2026-01-02,12.50");
    const url = String(output.statement.$file["download_url"]);
    expect(fileURLToPath(url).startsWith(downloads)).toBe(true);
    expect(await readFile(fileURLToPath(url), "utf8")).toBe(statement);
  } finally {
    await served.close();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a run places only a file its caller's input names, and only when its bytes pass", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Four native runs through two served tools, each run on a fresh page",
  });
  test.setTimeout(90_000);
  const site = await startFileSite();
  const directory = await mkdtemp(join(tmpdir(), "pomerado-files-qa-"));
  const write = async (name: string, content: string) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return pathToFileURL(path).href;
  };
  const file = await write("receipt.txt", receipt);
  const other = await write("other.txt", "not the caller's\n");
  // A "PDF" whose bytes are text, and a script named as text.
  const fakePdf = await write("receipt.pdf", receipt);
  const script = await write("notes.txt", "#!/bin/sh\necho hi\n");
  const downloads = join(directory, "downloads");
  const label = (name: string) => `page.getByLabel(${JSON.stringify(name)}, { exact: true })`;
  const receiptField = await serve(site.url, downloads, { source: placeTool(label("Receipt")) });
  const unnamed = await serve(site.url, downloads, {
    source: placeTool(label("Receipt"), JSON.stringify(other)),
  });
  const place = (served: Awaited<ReturnType<typeof serve>>, reference: string) =>
    served.client.callTool({ name: "send_receipt", arguments: { input: { receipt: reference } } });
  try {
    const placed = await place(receiptField, file);
    expect(placed.structuredContent, JSON.stringify(placed)).toEqual({
      placed: { name: "receipt.txt", media_type: "text/plain", size: receipt.length },
    });
    for (const [served, reference] of [
      [unnamed, file],
      [receiptField, fakePdf],
      [receiptField, script],
    ] as const) {
      const refused = await place(served, reference);
      expect(refused.structuredContent, JSON.stringify(refused)).toMatchObject({
        status: "failed",
        possible_commit: false,
      });
    }
    expect(site.received).toEqual([]);
  } finally {
    await receiptField.close();
    await unnamed.close();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});
