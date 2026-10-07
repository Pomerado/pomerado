import { describe, expect, it } from "vitest";
import { runnableOperationFiles, savedOperationFiles } from "../../src/mint/operation-source.js";

/** The paths a local build saves from `files` for `entrypoint`, sorted. */
const saved = (files: Readonly<Record<string, string>>, entrypoint = "src/tool.mjs") =>
  [...savedOperationFiles(new Map(Object.entries(files)), entrypoint).keys()].sort();

const workspace = {
  "src/tool.mjs": 'import { query } from "./query.mjs";\nexport default query;',
  "src/query.mjs": "export const query = 1;",
  "explore/look.mjs": "export const look = 1;",
  "test/check.mjs": "export const check = 1;",
  "scratch/notes.txt": "notes",
  "skills/publication/SKILL.md": "not source",
  "captures/page.html": "<p>capture</p>",
};
/** Every file under src/, explore/, test/ and scratch/ in `workspace`. */
const everyCandidate = [
  "explore/look.mjs",
  "scratch/notes.txt",
  "src/query.mjs",
  "src/tool.mjs",
  "test/check.mjs",
];

describe("the files a local build saves", () => {
  it("keeps every file under src/, whatever its extension, and no probe nothing imports", () => {
    expect(
      saved({
        ...workspace,
        "src/query.graphql": "query { reports }",
        "src/util.cjs": "module.exports = { pad: (value) => value };",
        "src/shape.mts": "export const shape = 1;",
        "src/labels.txt": "Reports",
      }),
    ).toEqual([
      "src/labels.txt",
      "src/query.graphql",
      "src/query.mjs",
      "src/shape.mts",
      "src/tool.mjs",
      "src/util.cjs",
    ]);
  });

  it("follows the entrypoint's imports into explore/, test/ and scratch/, whatever their extension", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": [
          'import { pad } from "../explore/pad.cjs";',
          'import { shape } from "../scratch/shape.mts";',
          'const data = await import("../test/data.json", { with: { type: "json" } });',
          "export default [pad, shape, data];",
        ].join("\n"),
        "explore/pad.cjs": "module.exports = { pad: (value) => value };",
        "scratch/shape.mts": 'export { shape } from "./shape-value.mts";',
        "scratch/shape-value.mts": "export const shape = 1;",
        "test/data.json": "{}",
      }),
    ).toEqual([
      "explore/pad.cjs",
      "scratch/shape-value.mts",
      "scratch/shape.mts",
      "src/query.mjs",
      "src/tool.mjs",
      "test/data.json",
    ]);
  });

  // Node loads an extensionless file in a module scope as ESM, so its own imports are followed.
  it("follows the imports of an extensionless module", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": 'import { helper } from "../explore/helper";\nexport default helper;',
        "explore/helper": 'import { other } from "./other.js";\nexport const helper = other;',
        "explore/other.js": "export const other = 1;",
      }),
    ).toEqual(["explore/helper", "explore/other.js", "src/query.mjs", "src/tool.mjs"]);
  });

  it("keeps every candidate file when an extensionless file is not JavaScript", () => {
    expect(saved({ ...workspace, "src/NOTES": "Read the reports page first." })).toEqual(
      [...everyCandidate, "src/NOTES"].sort(),
    );
  });

  it("does not follow an import of the host's runtime or a file outside the four folders", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": [
          'import { defineOperation } from "../runtime/index.js";',
          'import { note } from "../skills/note.mjs";',
          "export default defineOperation(note);",
        ].join("\n"),
        "skills/note.mjs": "export const note = 1;",
      }),
    ).toEqual(["src/query.mjs", "src/tool.mjs"]);
  });

  it("keeps an entrypoint outside src/ with the files it imports", () => {
    expect(
      saved(
        { ...workspace, "explore/run.mjs": 'export { look } from "./look.mjs";' },
        "explore/run.mjs",
      ),
    ).toEqual(["explore/look.mjs", "explore/run.mjs", "src/query.mjs", "src/tool.mjs"]);
  });

  it.each([
    [
      "reads a file with fs",
      'import { readFileSync } from "node:fs";\nexport default readFileSync(new URL("../explore/data.json", import.meta.url), "utf8");',
    ],
    [
      "loads a module with createRequire",
      'import { createRequire } from "node:module";\nexport default createRequire(import.meta.url)("../explore/look.mjs");',
    ],
    ["imports a package path", 'import data from "#data";\nexport default data;'],
    [
      "imports a computed path",
      'const name = "look";\nexport default await import(`../explore/${name}.mjs`);',
    ],
  ])("keeps every candidate file when a saved module %s", (_case, source) => {
    expect(saved({ ...workspace, "src/tool.mjs": source })).toEqual(everyCandidate);
  });

  it("keeps every candidate file when a module the entrypoint imports uses a loader", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": 'import { look } from "../explore/look.mjs";\nexport default look;',
        "explore/look.mjs": 'import fs from "node:fs";\nexport const look = fs.readFileSync;',
      }),
    ).toEqual(everyCandidate);
  });

  it("keeps every candidate file when the workspace has a package manifest", () => {
    expect(saved({ ...workspace, "src/package.json": '{"imports":{"#q":"./query.mjs"}}' })).toEqual(
      [...everyCandidate, "src/package.json"].sort(),
    );
  });
});

/** The paths of saved files the operation could run, sorted. */
const runnable = (files: Readonly<Record<string, string>>, entrypoint = "src/tool.mjs") =>
  [...runnableOperationFiles(new Map(Object.entries(files)), entrypoint).keys()].sort();

describe("the saved files the operation could run", () => {
  it("are the saved files when every one is reached through imports", () => {
    const files = {
      ...workspace,
      "src/tool.mjs": 'import { pad } from "../explore/pad.cjs";\nexport default pad;',
      "explore/pad.cjs": "module.exports = { pad: 1 };",
    };
    expect(runnable(files)).toEqual(saved(files));
  });

  // A package manifest saves every candidate as a precaution; a probe no import names is not run.
  it("leave out a probe saved only because the workspace has a package manifest", () => {
    const files = { ...workspace, "scratch/package.json": "{}" };
    expect(saved(files)).toContain("explore/look.mjs");
    expect(runnable(files)).toEqual(["src/query.mjs", "src/tool.mjs"]);
  });

  it.each([
    [
      "reads a file with fs",
      'import { readFileSync } from "node:fs";\nexport default readFileSync(new URL("../explore/data.json", import.meta.url), "utf8");',
    ],
    ["imports a package path", 'import data from "#data";\nexport default data;'],
    [
      "imports a computed path",
      'const name = "look";\nexport default await import(`../explore/${name}.mjs`);',
    ],
  ])("are every saved file when a module the operation runs %s", (_case, source) => {
    expect(runnable({ ...workspace, "src/tool.mjs": source })).toEqual(everyCandidate);
  });
});
