import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { loadAuthoringSkills, loadWorkspaceGuide } from "../../src/mint/skills.js";

const runPureFiles = (entrypoint: string, sources: readonly (readonly [string, string])[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources,
          input: {},
          target: "pureFiles",
        });
      }),
    ),
  );

/*
 * Every skill reference, as the agent copies it into its workspace, and every import the workspace
 * guide or a skill shows, must load against the SDK the local executor stages beside authored
 * source. It fails when an example or the guidance names an import the executor cannot resolve.
 */
it("loads every reference and every documented import against the runtime the local executor ships", async () => {
  const authoring = "typescript/authoring";
  const skills = await Effect.runPromise(loadAuthoringSkills(authoring));
  const guide = await Effect.runPromise(loadWorkspaceGuide(authoring));
  const modules = new Map<string, string>();
  // A reference names the repository's SDK paths; the workspace README maps them to the
  // workspace's own, two levels above src/.
  for (const name of new Set(skills.flatMap((skill) => Object.keys(skill.references ?? {}))))
    modules.set(
      `src/${name.replace(/\.ts$/u, ".mjs")}`,
      stripTypeScriptTypes(await readFile(join(authoring, "examples", name), "utf8"), {
        mode: "transform",
      }).replaceAll('"../../src/', '"../../'),
    );
  const documents = [
    ...guide.files.values(),
    ...skills.map((skill) => {
      if (typeof skill.content === "string") return skill.content;
      if (skill.content instanceof Uint8Array) return new TextDecoder().decode(skill.content);
      throw new Error(`Expected rendered text for skill ${skill.name}`);
    }),
  ];
  for (const content of documents)
    for (const [index, [, block]] of [
      ...content.matchAll(/```(?:js|javascript|ts|typescript)?\n([\s\S]*?)```/gu),
    ].entries()) {
      // An import statement, over several lines when it lists its names that way.
      const imports = [...(block ?? "").matchAll(/^import\s[^;]*?["'][^"']+["'];?/gmu)].map(
        ([statement]) => statement,
      );
      if (imports.length > 0)
        modules.set(`src/documented-${modules.size}-${index}.mjs`, imports.join("\n"));
    }
  expect([...modules.keys()].filter((path) => path.includes("documented-")).length).toBeGreaterThan(
    0,
  );
  // The real local executor loads every module from one authored entrypoint, which finds the
  // SDK at whichever path this layout resolves, so only the modules under test can fail.
  const entrypoint = "src/load-every-import.mjs";
  const entry = `import { Schema } from "effect";
const sdk = await import("../../runtime/index.js").catch(() => import("../runtime/index.js"));
const paths = ${JSON.stringify([...modules.keys()].map((path) => `./${path.slice("src/".length)}`))};
export default sdk.defineOperation(
  { input: Schema.Struct({}), output: Schema.Struct({ failed: Schema.Array(Schema.String) }) },
  async () => {
    const failed = [];
    for (const path of paths) {
      try {
        await import(path);
      } catch (error) {
        failed.push(path + ": " + String(error?.message ?? error).split("\\n")[0]);
      }
    }
    return { failed };
  },
);
`;
  const result = await runPureFiles(entrypoint, [...modules, [entrypoint, entry]]);
  expect(result.output).toEqual({ failed: [] });
}, 30_000);

/*
 * Before the executor staged authored source a level below the SDK, source in src/ reached the SDK
 * and the dependency folder one level up, a nested module two levels up, and its working folder
 * held package.json. Integrations saved that way keep running, against the same modules as the
 * documented path, with relative file paths still read from the authored root.
 */
it("runs source that reaches the SDK one level up from src/, as saved integrations may", async () => {
  const result = await runPureFiles("src/tool.mjs", [
    [
      "src/tool.mjs",
      `import { Schema } from "effect";
import * as dependency from "../node_modules/effect/dist/esm/index.js";
import { readFileSync } from "node:fs";
import * as documented from "../../runtime/index.js";
import * as runtime from "../runtime/index.js";
import * as browser from "../browser/index.js";
import { nested } from "./lib/nested.mjs";
export default runtime.defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ same: Schema.Boolean, note: Schema.String, type: Schema.String }),
  },
  async () => ({
    same:
      documented.defineOperation === runtime.defineOperation &&
      browser.OperationFailure === runtime.OperationFailure &&
      nested === runtime.defineOperation &&
      dependency.Schema === Schema,
    note: JSON.parse(readFileSync("src/note.json", "utf8")).note,
    type: JSON.parse(readFileSync("package.json", "utf8")).type,
  }),
);`,
    ],
    ["src/lib/nested.mjs", `export { defineOperation as nested } from "../../runtime/index.js";`],
    ["src/note.json", JSON.stringify({ note: "authored root" })],
  ]);
  expect(result.output).toEqual({ same: true, note: "authored root", type: "module" });
}, 30_000);

it("refuses authored files named like a folder the host stages beside them", async () => {
  const operation = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => ({}));`;
  for (const name of ["runtime", "browser", "privacy", "node_modules"]) {
    const result = await runPureFiles("src/tool.mjs", [
      ["src/tool.mjs", operation],
      [name, "export {};"],
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result, name).toMatchObject({
      message: expect.stringContaining(`Reviewed source cannot replace trusted SDK: ${name}`),
    });
  }
}, 30_000);
