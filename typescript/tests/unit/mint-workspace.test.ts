import type { Editor } from "@openai/agents";
import type { SandboxSession } from "@openai/agents/sandbox";
import { portableJobSession, portableMintProjection } from "../support/portable-mint.js";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { makeMintWorkspace } from "../../src/mint/workspace.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

const unused = Effect.die("Workspace editor test does not use this dependency");

const editorWorkspace = (
  workspace: SandboxSession,
  createEditor: (editor: Editor) => Editor,
  editAction: <A>(run: () => Promise<A>) => Promise<A> = (run) => run(),
) =>
  makeMintWorkspace(
    {
      workspace: {
        state: workspace.state,
        createEditor: () => {
          const editor = workspace.createEditor?.();
          if (!editor) throw new Error("Expected an SDK editor");
          return createEditor(editor);
        },
        readFile: (args) => workspace.readFile?.(args) ?? Promise.reject(new Error("No readFile")),
        pathExists: (path) =>
          workspace.pathExists?.(path) ?? Promise.reject(new Error("No pathExists")),
        applyManifest: (manifest) =>
          workspace.applyManifest?.(manifest) ?? Promise.reject(new Error("No applyManifest")),
        materializeEntry: (args) =>
          workspace.materializeEntry?.(args) ?? Promise.reject(new Error("No materializeEntry")),
      },
      projection: portableMintProjection(),
      instructions: "Synthetic instructions.",
      skills: [],
      model: { run: () => unused },
      preflight: () => unused,
      reviewAndExecute: () => unused,
      claimExample: unused,
      authorizeResidual: unused,
      publish: () => unused,
    } satisfies MintDependencies,
    () => Effect.succeed("unused"),
    Effect.runPromise,
    editAction,
  );

// Create, update and delete share one edit wrapper; an update stands for all three.
it("reports an uncertain edit when the workspace writes before throwing", async () => {
  const workspace = await portableJobSession({ "src/tool.mjs": "export const value = 0;" });
  cleanup.push(workspace.close);
  let calls = 0;
  const modelWorkspace = editorWorkspace(workspace, (original) => ({
    ...original,
    updateFile: async (operation) => {
      calls++;
      await original.updateFile(operation);
      throw new Error("private-canary after write");
    },
  }));
  const editor = modelWorkspace.createEditor?.();
  if (!editor) throw new Error("Expected a model editor");
  const result = await editor.updateFile({
    type: "update_file",
    path: "src/tool.mjs",
    diff: "@@\n-export const value = 0;\n+export const value = 1;\n",
  });
  expect(result).toMatchObject({ status: "failed" });
  expect(result?.output).not.toContain("private-canary");
  expect(calls).toBe(1);
  expect(await workspace.readFile({ path: "src/tool.mjs" })).toBe("export const value = 1;");
});

it("does not claim success from an explicit failed SDK edit result", async () => {
  const workspace = await portableJobSession({});
  cleanup.push(workspace.close);
  const modelWorkspace = editorWorkspace(workspace, () => ({
    createFile: async () => ({ status: "failed", output: "private-canary from SDK" }),
    updateFile: async () => ({ status: "completed" }),
    deleteFile: async () => undefined,
  }));
  const editor = modelWorkspace.createEditor?.();
  if (!editor) throw new Error("Expected a model editor");
  const failed = await editor.createFile({
    type: "create_file",
    path: "src/new.mjs",
    diff: "+export const value = 1;\n",
  });
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed?.output).not.toContain("private-canary");
  expect(
    await editor.updateFile({ type: "update_file", path: "src/new.mjs", diff: "@@\n" }),
  ).toMatchObject({ status: "completed", output: "Workspace edit completed." });
  expect(await editor.deleteFile({ type: "delete_file", path: "src/new.mjs" })).toMatchObject({
    status: "completed",
    output: "Workspace edit completed.",
  });
});

it("leaves a file unchanged and says the patch did not apply when it does not match", async () => {
  const workspace = await portableJobSession({ "src/tool.mjs": "export const value = 0;" });
  cleanup.push(workspace.close);
  const editor = editorWorkspace(workspace, (original) => original).createEditor?.();
  if (!editor) throw new Error("Expected a model editor");
  const result = await editor.updateFile({
    type: "update_file",
    path: "src/tool.mjs",
    diff: "@@\n-export const absent = 1;\n+export const value = 2;\n",
  });
  expect(result).toMatchObject({ status: "failed" });
  expect(result?.output).toContain("patch did not apply");
  expect(await workspace.readFile({ path: "src/tool.mjs" })).toBe("export const value = 0;");
  const exists = await editor.createFile({
    type: "create_file",
    path: "src/tool.mjs",
    diff: "+export const value = 3;\n",
  });
  expect(exists).toMatchObject({ status: "failed" });
  expect(exists?.output).toContain("(EEXIST)");
  expect(await workspace.readFile({ path: "src/tool.mjs" })).toBe("export const value = 0;");
});

it("says a missing file or an oversized file was not edited, and changes nothing", async () => {
  const workspace = await portableJobSession({ "src/tool.mjs": "export const value = 0;" });
  cleanup.push(workspace.close);
  const editor = editorWorkspace(workspace, (original) => original).createEditor?.();
  if (!editor) throw new Error("Expected a model editor");
  const unchanged = "The file is unchanged.";
  for (const result of [
    await editor.updateFile({ type: "update_file", path: "src/missing.mjs", diff: "@@\n+x\n" }),
    await editor.deleteFile({ type: "delete_file", path: "src/missing.mjs" }),
  ]) {
    expect(result).toMatchObject({ status: "failed" });
    expect(result?.output).toContain("(ENOENT)");
    expect(result?.output).toContain(unchanged);
  }
  const oversized = await editor.createFile({
    type: "create_file",
    path: "src/large.mjs",
    diff: `+${"x".repeat(8 * 1024 * 1024 + 1)}\n`,
  });
  expect(oversized).toMatchObject({ status: "failed" });
  expect(oversized?.output).toContain("(EFBIG)");
  expect(oversized?.output).toContain("may hold at most 8388608 bytes");
  expect(oversized?.output).toContain(unchanged);
  expect(await workspace.pathExists?.("src/missing.mjs")).toBe(false);
  expect(await workspace.pathExists?.("src/large.mjs")).toBe(false);
  expect(await workspace.readFile({ path: "src/tool.mjs" })).toBe("export const value = 0;");
});

it("does not invoke the SDK editor for path or admission refusal", async () => {
  const workspace = await portableJobSession({ "src/tool.mjs": "export const value = 0;" });
  cleanup.push(workspace.close);
  let editorCalls = 0;
  let admissionCalls = 0;
  const modelWorkspace = editorWorkspace(
    workspace,
    () => ({
      createFile: async () => {
        editorCalls++;
        throw new Error("SDK editor must not run");
      },
      updateFile: async () => {
        editorCalls++;
        throw new Error("SDK editor must not run");
      },
      deleteFile: async () => {
        editorCalls++;
        throw new Error("SDK editor must not run");
      },
    }),
    async () => {
      admissionCalls++;
      throw new Error("admission unavailable");
    },
  );
  const editor = modelWorkspace.createEditor?.();
  if (!editor) throw new Error("Expected a model editor");
  const blocked = [
    await editor.createFile({ type: "create_file", path: "../escape.mjs", diff: "+x\n" }),
    await editor.updateFile({
      type: "update_file",
      path: "src/tool.mjs",
      moveTo: "README.md",
      diff: "@@\n",
    }),
    await editor.deleteFile({ type: "delete_file", path: "src/tool.mjs" }),
  ];
  for (const result of blocked)
    expect(result).toMatchObject({
      status: "failed",
      output: "Workspace edit unavailable or outside allowed source paths.",
    });
  expect(admissionCalls).toBe(1);
  expect(editorCalls).toBe(0);
  expect(await workspace.readFile({ path: "src/tool.mjs" })).toBe("export const value = 0;");
});
