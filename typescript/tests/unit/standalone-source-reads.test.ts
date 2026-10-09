import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { sourceInspector } from "../../src/standalone/request-context.js";

/** Guardian's reads over a review's own files, with the local host's trusted SDK. */
const reader = async (sources: ReadonlyMap<string, string>) => {
  const trustedSources = new Map(await Effect.runPromise(localRuntimeAssets));
  const readSource = sourceInspector({ trustedSources, secrets: makeRunSecrets() }, sources);
  return {
    trustedSources,
    read: (path: string) =>
      Effect.runPromise(
        readSource(path, 0).pipe(
          Effect.match({
            onFailure: (failure) => ({ failure: failure.code }),
            onSuccess: (chunk) => ({ source: (JSON.parse(chunk) as { source: string }).source }),
          }),
        ),
      ),
  };
};

describe("Guardian's source reads on the local host", () => {
  it("reads the SDK under operation/, where authored source imports it", async () => {
    const { trustedSources, read } = await reader(
      new Map([["operation/src/index.js", 'import "../../runtime/index.js";\n']]),
    );
    for (const path of ["runtime/index.js", "browser/form-controls.js"]) {
      const sdk = trustedSources.get(path);
      expect(sdk).toBeDefined();
      expect(await read(`operation/${path}`)).toEqual({ source: sdk });
      expect(await read(path)).toEqual({ source: sdk });
    }
  });

  it("ships every SDK module the SDK's own files import", async () => {
    const { trustedSources } = await reader(new Map());
    const missing: string[] = [];
    for (const [path, source] of trustedSources)
      for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
        const imported = new URL(specifier ?? "", `file:///sdk/${path}`).pathname.slice(5);
        if (!trustedSources.has(imported)) missing.push(`${path} -> ${imported}`);
      }
    expect(missing).toEqual([]);
  });

  it("reads an authored file before the SDK file at the same path", async () => {
    const { read } = await reader(
      new Map([["operation/runtime/index.js", "export const authored = true;\n"]]),
    );
    expect(await read("operation/runtime/index.js")).toEqual({
      source: "export const authored = true;\n",
    });
  });

  it("finds no file outside the review's files and the SDK", async () => {
    const { read } = await reader(new Map());
    for (const path of ["operation/src/missing.js", "executed/runtime/index.js"])
      expect(await read(path)).toEqual({ failure: "SourceUnavailable" });
  });
});
