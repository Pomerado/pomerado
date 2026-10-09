import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { HttpFailure } from "../../src/runtime/site-http.js";
import type { HttpTransport, SiteHttpRequest } from "../../src/runtime/site-http.js";

// Authored tools import the SDK by its package path, `pomerado/runtime`, like a standard library.
// The local host stages that path for them and nothing else of the package.

const run = (options: {
  readonly entrypoint: string;
  readonly source: string;
  readonly input?: unknown;
  readonly http?: HttpTransport;
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint: options.entrypoint,
          sources: [[options.entrypoint, options.source]],
          input: options.input ?? {},
          siteOrigin: "https://shop.example",
          ...(options.http === undefined ? { target: "pureFiles" as const } : { http: options.http }),
        }).pipe(Effect.either);
      }),
    ),
  );

/** A site that answers every request with one JSON body, recording what it was sent. */
const jsonSite = (body: unknown) => {
  const sent: SiteHttpRequest[] = [];
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: ["session-cookies"],
    send: (request) => {
      sent.push(request);
      return Promise.resolve({
        status: 200,
        headers: { "content-type": ["application/json"] },
        body: new TextEncoder().encode(JSON.stringify(body)),
        transport: "kernel-curl",
        gaps: [],
      });
    },
  };
  return { transport, sent };
};

const httpVersion = `import { Effect, Schema } from "effect";
import { defineHttpOperation, readJson } from "pomerado/runtime";
const Found = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
export default defineHttpOperation({
  name: "find_products",
  input: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ names: Schema.Array(Schema.String) }),
  run: (input, http) =>
    Effect.gen(function* () {
      const url = "/api/search?q=" + encodeURIComponent(input.query);
      const found = yield* readJson(http, { url, method: "GET" }, Found);
      return { names: found.items.map((item) => item.name) };
    }),
});`;

it("runs an HTTP version that imports the SDK by its package path", async () => {
  const site = jsonSite({ items: [{ name: "Brass lamp" }, { name: "Paper lamp" }] });
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: httpVersion,
    input: { query: "lamp" },
    http: site.transport,
  });
  expect(result).toMatchObject({
    _tag: "Right",
    right: { output: { names: ["Brass lamp", "Paper lamp"] }, effect: "possible" },
  });
  // A site-relative URL resolves against the job's site.
  expect(site.sent.map((request) => request.url)).toEqual([
    "https://shop.example/api/search?q=lamp",
  ]);
}, 30_000);

it("runs the HTTP version reference as the workspace holds it", async () => {
  const reference = await readFile("typescript/authoring/examples/http-version.ts", "utf8");
  const site = jsonSite({
    data: { items: [{ product_id: "p-1", name: "Brass lamp", price_cents: 4200 }] },
  });
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: stripTypeScriptTypes(reference, { mode: "transform" }).replaceAll(
      '"../../src/',
      '"../../',
    ),
    input: { query: "lamp" },
    http: site.transport,
  });
  expect(result).toMatchObject({
    _tag: "Right",
    right: { output: { products: [{ id: "p-1", title: "Brass lamp", price_minor: 4200 }] } },
  });
  expect(site.sent.map((request) => new URL(request.url).host)).toEqual(["api.shop.example"]);
}, 30_000);

it("fails an HTTP version with the failure its host's transport reported", async () => {
  const transport: HttpTransport = {
    name: "saved-http",
    capabilities: [],
    send: () => Promise.reject(new HttpFailure({ code: "not_recorded", dispatch: "not_sent" })),
  };
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: httpVersion,
    input: { query: "lamp" },
    http: transport,
  });
  expect(result).toMatchObject({ _tag: "Left", left: { tag: "HttpFailure", code: "not_recorded" } });
}, 30_000);

it("refuses an HTTP version when the host gives it no transport, before anything is sent", async () => {
  const result = await run({ entrypoint: "src/tool-http.mjs", source: httpVersion });
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("no HTTP transport"),
      journal: { effect: "not_sent" },
    },
  });
}, 30_000);

it("gives the package path and the workspace path the same SDK modules", async () => {
  const result = await run({
    entrypoint: "src/tool.mjs",
    source: `import { Schema } from "effect";
import * as packaged from "pomerado/runtime";
import * as workspace from "../../runtime/index.js";
export default packaged.defineOperation(
  { input: Schema.Struct({}), output: Schema.Struct({ same: Schema.Boolean }) },
  async () => ({
    same:
      packaged.OperationFailure === workspace.OperationFailure &&
      packaged.SiteHttp === workspace.SiteHttp,
  }),
);`,
  });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { same: true } } });
}, 30_000);

it("refuses an import of the package's internal modules", async () => {
  const result = await run({
    entrypoint: "src/tool.mjs",
    source: `import { Schema } from "effect";
import { defineOperation } from "pomerado/core/runtime/operation";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => ({}));`,
  });
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
  });
}, 30_000);
