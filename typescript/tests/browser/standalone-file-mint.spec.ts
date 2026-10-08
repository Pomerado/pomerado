import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import {
  call,
  executionIdOf,
  objects,
  patch,
  recordingGuardian,
  toolResult,
} from "./guardian-context-fixture.js";
import { act, mint } from "./standalone-mint-fixture.js";
import { receiptTool, startFileSite, statement, statementSha256 } from "./file-fixture.js";

const receipt = "Receipt 1042\nTotal 12.50\n";
const finish = (executionId: string, name: string, callId = "publish") =>
  call(
    "finish_build",
    {
      intent: "Publish the tool",
      entrypoint: "src/tool.mjs",
      executionId,
      metadata: { name, description: "Upload a receipt and download the statement" },
      coverage: "One live run on the caller's input",
    },
    callId,
  );
/** A model turn's removal of one file. */
const removal = (path: string) => ({
  type: "apply_patch_call" as const,
  callId: `remove_${path.replaceAll(/[^a-z0-9]/giu, "_")}`,
  status: "completed" as const,
  operation: { type: "delete_file" as const, path },
});
/** A probe that places the input's receipt into the Notes text field. */
const notesProbe = `import { Schema } from "effect";
import { defineOperation, FileInput } from "../runtime/index.js";
export default defineOperation({name:"probe",input:Schema.Struct({receipt:FileInput}),output:Schema.Unknown},
async ({input,files}) => ({ placed: await files.place(input.receipt, { field: 'page.getByLabel("Notes", { exact: true })' }) }));`;

test("a write build sees the caller's file as a handle, uploads it in its act step and publishes", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "A recorded build with three live steps, two refused steps and two finish_build calls",
  });
  test.setTimeout(90_000);
  const site = await startFileSite();
  const directory = await mkdtemp(join(tmpdir(), "pomerado-file-mint-"));
  const file = join(directory, "receipt.txt");
  await writeFile(file, receipt);
  const reference = pathToFileURL(file).href;
  const guardian = recordingGuardian();
  try {
    const { built, requests, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      intent: "Upload my receipt and download the statement",
      input: { receipt: reference },
      turns: [
        // Source never names a file by its handle.
        () => patch({ "explore/literal.mjs": notesProbe.replace("input.receipt", '"{{file.f1}}"') }),
        () => [call("execute", { ...act("explore/literal.mjs"), purpose: "explore" }, "literal")],
        () => [removal("explore/literal.mjs")],
        () => patch({ "src/tool.mjs": receiptTool(), "explore/notes.mjs": notesProbe }),
        () => [call("execute", { ...act("explore/notes.mjs"), purpose: "explore" }, "notes")],
        () => [call("execute", act("src/tool.mjs"), "upload")],
        // Published source never holds a handle either.
        () => patch({ "src/receipt.mjs": 'export const receipt = "{{file.f1}}";' }),
        (request) => [finish(executionIdOf(request, "upload"), "send_receipt", "held")],
        () => [removal("src/receipt.mjs")],
        (request) => [finish(executionIdOf(request, "upload"), "send_receipt")],
      ],
    });
    // The model saw a handle with the file's metadata, never the caller's path or the bytes.
    // The request reaches the model as nested JSON text; without its escapes it reads plainly.
    const prompt = JSON.stringify(requests[0]?.input).replaceAll("\\", "");
    expect(prompt).toContain('"businessInput":{"receipt":"{{file.f1}}"}');
    expect(prompt).toContain(
      `"files":[{"handle":"{{file.f1}}","name":"receipt.txt","media_type":"text/plain","size":${receipt.length}}]`,
    );
    for (const request of requests) {
      expect(JSON.stringify(request.input)).not.toContain(directory);
      expect(JSON.stringify(request.input)).not.toContain("Receipt 1042");
    }
    // Guardian reviewed the handle, never the path.
    for (const review of guardian.reviews) expect(JSON.stringify(review.input)).not.toContain(directory);
    // The host put the file nowhere but a file input, and refused a handle in source.
    expect(JSON.stringify(toolResult(last, "notes"))).toContain("not_file_input");
    expect(JSON.stringify(toolResult(last, "literal"))).toContain("holds a {{file.");
    // The act step uploaded the caller's bytes, once, and the download kept only its metadata.
    const sha256 = createHash("sha256").update(receipt).digest("hex");
    expect(site.received).toEqual([{ name: "receipt.txt", size: receipt.length, sha256 }]);
    const upload = toolResult(last, "upload");
    // The output's file object, not the schema that describes it.
    const kept = objects(upload)
      .flatMap((value) => objects(value["$file"]))
      .filter((value) => typeof value["sha256"] === "string");
    expect(kept).toEqual([
      expect.objectContaining({ name: "statement.csv", sha256: statementSha256 }),
    ]);
    expect(kept[0]).not.toHaveProperty("download_url");
    expect(JSON.stringify(upload)).not.toContain("2026-01-02,12.50");
    expect(toolResult(last, "held")).toMatchObject({
      status: "not_published",
      reason: "file_handle",
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(JSON.stringify(built.artifact?.inputSchema)).toContain('"format":"file"');
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a read build downloads the statement in its example and publishes the file output", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "A recorded build with one live example and a publication",
  });
  test.setTimeout(60_000);
  const site = await startFileSite();
  const tool = `import { Schema } from "effect";
import { defineOperation, FileOutput } from "../runtime/index.js";
export default defineOperation({name:"download_statement",input:Schema.Struct({}),output:Schema.Struct({statement:FileOutput})},
async ({kernel,sessionId,files}) => ({ statement: await files.collect(() => kernel.browsers.playwright.execute(sessionId,{code:"await page.getByRole('link', { name: 'Download statement' }).click();",timeout_sec:10})) }));`;
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian: recordingGuardian(),
      intent: "Download my statement",
      turns: [
        () => patch({ "src/tool.mjs": tool }),
        () => [call("execute", { ...act("src/tool.mjs"), purpose: "example" }, "example")],
        (request) => [finish(executionIdOf(request, "example"), "download_statement")],
      ],
    });
    // The example's result carries the file's metadata and sha256, never its bytes.
    const example = JSON.stringify(toolResult(last, "example"));
    expect(example).toContain(statementSha256);
    expect(example.replaceAll("\\", "")).toContain(`"size":${statement.length}`);
    expect(example).not.toContain("2026-01-02,12.50");
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(JSON.stringify(built.artifact?.outputSchema)).toContain('"format":"file"');
  } finally {
    await site.close();
  }
});
