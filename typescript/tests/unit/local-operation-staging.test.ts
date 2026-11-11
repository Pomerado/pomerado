import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { hostPlatform, type LocalPlatform } from "../../src/execution/local-platform.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { getRuntimeSources } from "../../src/execution/runtime-sources.js";

// Windows creates symbolic links only with administrator rights or Developer Mode, so a run there
// stages the trusted SDK without them. Authored source must still load the very modules the
// installed package holds, which `pomerado/runtime` names, or its error classes would not be the
// ones the child runner checks for.

const entrypoint = "src/tool.mjs";
const source = `import { lstatSync } from "node:fs";
import { Schema } from "effect";
import { InvalidInput } from "../../runtime/errors.js";
import { defineOperation } from "../../runtime/index.js";
import * as installed from "pomerado/runtime";
export default defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ sameErrorClass: Schema.Boolean, linkedRuntimeFile: Schema.Boolean }),
  },
  async () => ({
    sameErrorClass: InvalidInput === installed.InvalidInput,
    linkedRuntimeFile: lstatSync(new URL("../../runtime/errors.js", import.meta.url)).isSymbolicLink(),
  }),
);`;

/** A Windows host as local execution sees it, on whatever platform the tests run. */
const windows: LocalPlatform = {
  windows: true,
  environment: { SystemRoot: "C:\\Windows" },
  run: async (_file, args) => {
    try {
      process.kill(Number(args[1]), "SIGKILL");
    } catch {
      return { exitCode: 128, stdout: "" };
    }
    return { exitCode: 0, stdout: "" };
  },
};

const run = (platform: LocalPlatform) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: {},
          target: "pureFiles",
          platform,
        });
      }),
    ),
  );

// Each case starts a local operation child, which takes seconds on a loaded host.
describe("the staged trusted SDK", { timeout: 30_000 }, () => {
  it("on this host loads the installed classes, linked file by file on macOS and Linux", async () => {
    expect((await run(hostPlatform)).output).toEqual({
      sameErrorClass: true,
      linkedRuntimeFile: !hostPlatform.windows,
    });
  });

  it("on Windows uses no file symbolic link and still loads the installed classes", async () => {
    expect((await run(windows)).output).toEqual({
      sameErrorClass: true,
      linkedRuntimeFile: false,
    });
  });
});

// On Windows each staged SDK file is `export * from` the installed one, and `export *` leaves out a
// default export, so none of them may have one.
it("stages no SDK module with a default export", () => {
  const sources = getRuntimeSources();
  expect(sources.length).toBeGreaterThan(0);
  const withDefault = sources
    .filter(([, text]) => /\bexport\s+default\b|\bas\s+default\b/.test(text))
    .map(([path]) => path);
  expect(withDefault).toEqual([]);
});
