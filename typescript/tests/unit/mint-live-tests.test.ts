import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type LiveTestBatch,
  type LiveTestBatchResult,
  type LiveTestHost,
  type MintDependencies,
} from "../../src/mint/contracts.js";
import type { LiveTestOutcome } from "../../src/mint/live-tests.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

// A read signed out designs its own live test cases, runs them as batches and reads every result;
// publication review gets the host's own record of them. These drive the minter's live_tests tool
// through scripted model turns.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);
const read = { effect: "read", siteOrigin: "https://shop.example.test" } as const;

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ intent: `Synthetic ${name} purpose`, ...input }),
      status: "completed",
    },
  ],
});
const prose = (): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
});
/** The JSON a tool call returned, as the next model request carries it. */
const resultOf = (request: ModelRequest | undefined, callId: string): Record<string, unknown> => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  const item = input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  ) as { readonly output?: unknown } | undefined;
  const output = item?.output;
  const text =
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? String(output.text)
        : JSON.stringify(output);
  return JSON.parse(text) as Record<string, unknown>;
};

const example = {
  purpose: "example",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 60,
};
const finish = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "search_catalog", description: "Search a synthetic catalog" },
  coverage: "The example searched one query.",
};
const plan = { action: "plan", entrypoint: "src/tool.ts", cases: null, maxWorkers: null };
const runAll = { action: "run", entrypoint: "src/tool.ts", cases: null, maxWorkers: 3 };

/** A search tool's declared schemas, as the host reads them offline. */
const schemas = {
  input: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      sort: { enum: ["relevance", "price_low", "price_high"] },
      in_stock: { type: "boolean" },
      cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  output: {
    type: "object",
    required: ["results", "has_next_page", "next_cursor"],
    properties: {
      results: { type: "array", items: { type: "object" } },
      has_next_page: { type: "boolean" },
      next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
};

const cases = {
  cases: [
    { id: "repeat-1", purpose: "The example on a fresh browser.", input: { query: "lamp" }, expect: "result" },
    {
      id: "sort-price",
      purpose: "Sorting by price reorders the results.",
      input: { query: "lamp", sort: "price_low" },
      expect: "result",
    },
    { id: "nothing", purpose: "A query with no results.", input: { query: "zzqx" }, expect: "empty" },
    {
      id: "page-2",
      purpose: "Page two through the cursor page one returned.",
      input: { query: "lamp" },
      expect: "result",
      next_page: true,
    },
  ],
  notTested: [{ what: "A sort the site does not offer", reason: "Every sort is offered." }],
};

/** A host that runs each case through `outcomes`, recording each batch it was asked to run. */
const liveTestHost = (
  outcomes: Readonly<Record<string, LiveTestOutcome>>,
  result?: LiveTestBatchResult,
) => {
  const batches: LiveTestBatch[] = [];
  const host: LiveTestHost = {
    maxWorkers: 3,
    schemas: () => Effect.succeed(schemas),
    run: (batch) =>
      Effect.sync(() => {
        batches.push(batch);
        return (
          result ?? {
            status: "ran" as const,
            reviewId: "review_batch",
            lanes: Math.min(batch.workers, batch.cases.length),
            cases: batch.cases.map((testCase, index) => ({
              id: testCase.id,
              outcome: outcomes[testCase.id] ?? {
                status: "completed" as const,
                output: { results: [{ name: "Lamp" }], has_next_page: true, next_cursor: "c2" },
              },
              durationMs: 20_000,
              lane: index % batch.workers,
            })),
          }
        );
      }),
  };
  return { host, batches };
};

const writeWorkspace = async (root: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const toolSource = "export default { name: 'search_catalog' };\n";

/** Publication requests and the host evidence each received. */
const publications = () => {
  const seen: { coverage: string; liveTests?: object }[] = [];
  const publish: MintDependencies["publish"] = (request, _evidence, hostEvidence) =>
    Effect.sync(() => {
      seen.push({
        coverage: request.coverage,
        ...(hostEvidence?.liveTests === undefined ? {} : { liveTests: hostEvidence.liveTests }),
      });
      return { publicationRef: "published_revision", diagnostics: [] };
    });
  return { seen, publish };
};

const completedExample: MintDependencies["reviewAndExecute"] = (_input, beforeDispatch) =>
  (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
    Effect.as({
      executionId: "execution_one",
      status: "completed" as const,
      effect: "verified" as const,
      resultRef: "protected_result",
      observations: { results: 3 },
    }),
  );

it("runs the cases a read designed as one batch and hands publication the host's record", async () => {
  const { host, batches } = liveTestHost({
    "sort-price": {
      status: "failed",
      errorClass: "TimeoutError",
      message: "locator.click: Timeout 5000ms exceeded",
      frame: "src/tool.ts:12",
    },
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      if (index === 1) await writeWorkspace(root, { "test/cases.json": JSON.stringify(cases) });
      return (
        [
          call("live_tests", plan, "plan"),
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource });
  const outcome = await f.run();

  // Before any case exists, the plan sends the agent to design its own; the host builds no
  // checklist from the schemas.
  const planned = resultOf(f.requests[1], "plan");
  expect(planned["cases"]).toEqual([]);
  expect(planned).not.toHaveProperty("checklist");
  expect(String(planned["instruction"])).toContain("testing skill");

  // The first passing example's receipt reminds the agent of its cases.
  const receipt = resultOf(f.requests[2], "example");
  expect(receipt["testPlan"]).toMatchObject({ plannedCases: 4 });

  // One batch, every case, with the next page's cursor fields (the string cursor, never the
  // boolean beside it), at most three at once.
  expect(batches).toHaveLength(1);
  expect(batches[0]?.workers).toBe(3);
  expect(batches[0]?.cases.map((testCase) => testCase.id)).toEqual([
    "repeat-1",
    "sort-price",
    "nothing",
    "page-2",
  ]);
  expect(batches[0]?.cases.find((testCase) => testCase.id === "page-2")?.nextPage).toEqual({
    inputField: "cursor",
    outputField: "next_cursor",
  });

  // The agent sees every result, a failure with the line that threw.
  const ran = resultOf(f.requests[3], "run");
  expect(ran["status"]).toBe("ran");
  expect(ran["cases"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "repeat-1", purpose: "The example on a fresh browser.", status: "pass" }),
      expect.objectContaining({ id: "nothing", status: "pass", got: "empty" }),
      expect.objectContaining({
        id: "sort-price",
        status: "fail",
        errorClass: "TimeoutError",
        frame: "src/tool.ts:12",
      }),
    ]),
  );

  // A failing case never refuses publication by itself: the review reads the host's record.
  expect(outcome.build).toBe("published");
  expect(published.seen).toHaveLength(1);
  // The record lists each case with its purpose, input and verdict, and what was not tested.
  const record = published.seen[0]?.liveTests as {
    cases: { id: string; status: string; input: unknown }[];
    notTested: unknown;
  };
  expect(record).not.toHaveProperty("checklist");
  expect(record.cases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sort-price",
        purpose: "Sorting by price reorders the results.",
        status: "fail",
        input: { query: "lamp", sort: "price_low" },
      }),
    ]),
  );
  expect(record.notTested).toEqual(cases.notTested);
  expect(published.seen[0]?.coverage).toContain("4 cases (3 pass, 1 fail, 0 inconclusive)");
});

it("marks results stale in the publication record when the source changed after they ran", async () => {
  const { host } = liveTestHost({});
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // The agent edits the source after the batch and publishes without running it again.
      if (index === 3) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// edited\n` });
      return (
        [
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("execute", example, "again"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      repeatableRead: true,
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  const record = published.seen[0]?.liveTests as { cases: { id: string; status: string }[] };
  expect(record.cases.map((testCase) => testCase.status)).toEqual([
    "stale",
    "stale",
    "stale",
    "stale",
  ]);
});

it("tells the agent when the host could not read the schemas its verdicts and next pages need", async () => {
  const { host, batches } = liveTestHost({});
  const unreadable: LiveTestHost = {
    ...host,
    schemas: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
  };
  const f = await fixture(
    (_request, index) => [call("live_tests", runAll, "run")][index] ?? prose(),
    { liveTests: unreadable, deadline: Deadline.after(30 * 60_000) },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  const single = { cases: cases.cases.filter((testCase) => testCase.next_page !== true) };
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(single) });
  await f.run();
  expect(batches).toHaveLength(1);
  const ran = resultOf(f.requests[1], "run");
  expect(ran["status"]).toBe("ran");
  expect(String(ran["schemaProblem"])).toContain("could not read src/tool.ts's input and output schemas");
});

it("keeps a failing case in the publication record after the minter deletes or changes it", async () => {
  const { host, batches } = liveTestHost({
    "sort-price": { status: "failed", errorClass: "TimeoutError", frame: "src/tool.ts:12" },
  });
  const published = publications();
  let root = "";
  // Without the failing sort case, and with the failing no-results case on another query.
  const trimmed = {
    ...cases,
    cases: cases.cases
      .filter((testCase) => testCase.id !== "sort-price")
      .map((testCase) =>
        testCase.id === "nothing" ? { ...testCase, input: { query: "zzqy" } } : testCase,
      ),
  };
  const f = await fixture(
    async (_request, index) => {
      if (index === 1) await writeWorkspace(root, { "test/cases.json": JSON.stringify(trimmed) });
      return (
        [
          call("live_tests", runAll, "first"),
          call("live_tests", runAll, "second"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(2);
  const record = published.seen[0]?.liveTests as {
    cases: { id: string }[];
    retired: Record<string, unknown>[];
  };
  expect(record.cases.map((testCase) => testCase.id)).not.toContain("sort-price");
  expect(record.retired).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sort-price",
        retiredBecause: "deleted from the cases file",
        lastVerdict: "fail",
        frame: "src/tool.ts:12",
        input: { query: "lamp", sort: "price_low" },
        onPublishedSource: true,
      }),
      expect.objectContaining({
        id: "nothing",
        retiredBecause: "changed after it failed",
        lastVerdict: "fail",
        input: { query: "zzqx" },
      }),
    ]),
  );
  expect(published.seen[0]?.coverage).toContain("2 retired cases (2 last failed)");
});

it("publishes with the gaps when too little time is left for a batch, and the record says so", async () => {
  const { host, batches } = liveTestHost({});
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      // Less than the batch's margin before the attempt's end.
      deadline: Deadline.after(2 * 60_000 + 30_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(0);
  expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "no_time" });
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toMatchObject({ outOfTime: true });
  expect(published.seen[0]?.coverage).toContain("ran out of time");
});

it("says time ran out only when the attempt's end, not the batch's own cap, stopped a case", async () => {
  const stopped = { status: "inconclusive" as const, reason: "deadline" as const };
  const record = async (attemptMs: number) => {
    const { host, batches } = liveTestHost({ "sort-price": stopped });
    const published = publications();
    const f = await fixture(
      (_request, index) =>
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose(),
      {
        liveTests: host,
        deadline: Deadline.after(attemptMs),
        reviewAndExecute: completedExample,
        publish: published.publish,
      },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
    await f.run();
    expect(batches).toHaveLength(1);
    return published.seen[0]?.liveTests as { outOfTime?: boolean };
  };
  // Half an hour left: the batch's own ten-minute cap stopped the case, so testing can go on.
  expect((await record(30 * 60_000)).outOfTime).toBeUndefined();
  // Five minutes left: the attempt's end set the batch's deadline.
  expect((await record(5 * 60_000)).outOfTime).toBe(true);
});

it("runs nothing when Guardian denies the batch, and says why", async () => {
  const { host, batches } = liveTestHost(
    {},
    {
      status: "review_denied",
      reviewId: "review_denied_batch",
      rationale: "Case repeat-1 guesses an order number.",
    },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(1);
  expect(resultOf(f.requests[1], "run")).toMatchObject({
    status: "review_denied",
    rationale: "Case repeat-1 guesses an order number.",
  });
  const record = published.seen[0]?.liveTests as { cases: { status: string }[] };
  expect(record.cases.every((testCase) => testCase.status === "not_run")).toBe(true);
});

it("sends a signed-in read back to one live test at a time", async () => {
  const { host, batches } = liveTestHost({});
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "execute",
          { ...example, purpose: "authenticate", entrypoint: "src/sign-in.ts" },
          "sign_in",
        ),
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: (input, beforeDispatch) =>
        input.purpose === "authenticate"
          ? (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
              Effect.as({
                executionId: "sign_in_one",
                status: "completed" as const,
                effect: "verified" as const,
                authentication: { state: "authenticated" as const, effect: "verified" as const },
                observations: {},
              }),
            )
          : completedExample(input, beforeDispatch),
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(batches).toHaveLength(0);
  expect(resultOf(f.requests[2], "run")).toMatchObject({ status: "unavailable" });
  expect(published.seen[0]?.liveTests).toBeUndefined();
});
