import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ExecutionRequest } from "../../src/mint/contracts.js";
import {
  exampleInputRefusal,
  preflightTestInput,
  repeatableReadFor,
  replayedWriteStep,
  stepInput,
  writeSessionBoundary,
  writeStepDigest,
  writeUpgradeApproval,
  type WriteStep,
} from "../../src/mint/step-checks.js";
import { portableMintProjection } from "../support/portable-mint.js";

const request = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.mjs",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
  ...overrides,
});
const agentTest = (input: unknown) =>
  request({
    purpose: "test",
    target: "liveBrowser",
    testInput: typeof input === "string" ? input : JSON.stringify(input),
  });
const chosen = { input: "agent_chosen" as const };

describe("preflightTestInput", () => {
  it("runs a read's live tests on inputs the agent picks, at most two", () => {
    const scope = (history: readonly { readonly input?: "agent_chosen" }[]) => ({
      buildEffect: "read" as const,
      executionHistory: history,
    });
    expect(preflightTestInput(agentTest({ amountMinor: 12 }), scope([]))).toBeUndefined();
    expect(preflightTestInput(agentTest({ amountMinor: 45 }), scope([chosen]))).toBeUndefined();
    expect(preflightTestInput(agentTest({ amountMinor: 78 }), scope([chosen, chosen]))).toEqual({
      supported: false,
      reason: expect.stringContaining("already ran 2 live tests with an input you chose"),
    });
    // A step without testInput is the caller's input, whatever the count.
    expect(preflightTestInput(request(), scope([chosen, chosen]))).toBeUndefined();
  });

  it("counts an agent-chosen input the operation rejected, and not a test Guardian denied", () => {
    // A rejected run is in the history with its mark; a denied test never ran and left none.
    const rejected = [{ ...chosen }, {}];
    expect(
      preflightTestInput(agentTest({ amountMinor: 45 }), {
        buildEffect: "read",
        executionHistory: rejected,
      }),
    ).toBeUndefined();
    expect(
      preflightTestInput(agentTest({ amountMinor: 78 }), {
        buildEffect: "read",
        executionHistory: [...rejected, chosen],
      }),
    ).toMatchObject({ supported: false });
  });

  it.each([
    ["an example", request({ testInput: "{}" }), "read"],
    ["an offline test", request({ purpose: "test", testInput: "{}" }), "read"],
    ["a live explore", request({ purpose: "explore", target: "liveBrowser", testInput: "{}" }), "read"],
    ["malformed JSON", agentTest("{x"), "read"],
    ["a write build's live test", agentTest({ amountMinor: 12 }), "write"],
  ] as const)("refuses an agent-chosen input on %s", (_, submitted, buildEffect) => {
    expect(preflightTestInput(submitted, { buildEffect, executionHistory: [] })).toMatchObject({
      supported: false,
      reason: expect.stringContaining("Nothing was executed."),
    });
  });
});

describe("exampleInputRefusal", () => {
  const exampleInput = JSON.stringify({ venue: "Venue X", date: "2026-10-04", partySize: 2 });
  it("lets a read's example run the agent's reading of an empty caller input", () => {
    expect(
      exampleInputRefusal(request({ exampleInput }), { buildEffect: "read", callerInput: {} }),
    ).toBeUndefined();
    expect(exampleInputRefusal(request(), { buildEffect: "write", callerInput: {} })).toBeUndefined();
  });

  it.each([
    ["the caller's own input", { exampleInput }, "read", { venue: "Venue Y" }],
    ["a write build", { exampleInput }, "write", {}],
    ["text that is not JSON", { exampleInput: '{"venue":' }, "read", {}],
    ["JSON that is not an input object", { exampleInput: "[2]" }, "read", {}],
    ["a purpose other than example", { exampleInput, purpose: "test" as const }, "read", {}],
    [
      "an explore",
      { exampleInput, purpose: "explore" as const, target: "liveBrowser" as const },
      "read",
      {},
    ],
  ] as const)("refuses exampleInput beside %s", (_, overrides, buildEffect, callerInput) => {
    const refusal = exampleInputRefusal(request(overrides), { buildEffect, callerInput });
    expect(refusal).toMatchObject({ supported: false });
    expect(refusal?.reason).toContain("exampleInput");
    expect(refusal?.reason).toContain("Nothing was executed.");
  });
});

describe("stepInput", () => {
  const run = (submitted: ExecutionRequest, callerInput: unknown) =>
    Effect.runPromise(Effect.either(stepInput(submitted, callerInput)));
  it("runs a read's example on the input the agent read from the prompt, marked intent_derived", async () => {
    const reservation = { venue: "Venue X", date: "2026-10-04", partySize: 2 };
    expect(await run(request({ exampleInput: JSON.stringify(reservation) }), {})).toMatchObject({
      _tag: "Right",
      right: { input: reservation, mark: "intent_derived" },
    });
  });

  it("runs an agent-chosen test input, marked agent_chosen, and otherwise the caller's input", async () => {
    expect(await run(agentTest({ amountMinor: 12 }), { amountMinor: 3700 })).toMatchObject({
      _tag: "Right",
      right: { input: { amountMinor: 12 }, mark: "agent_chosen" },
    });
    const plain = await run(request({ purpose: "test", target: "liveBrowser" }), { a: 1 });
    expect(plain).toEqual({ _tag: "Right", right: { input: { a: 1 } } });
  });

  it("refuses a test input that is not JSON as an invalid request", async () => {
    expect(await run(agentTest("{x"), {})).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidRequest" },
    });
  });
});

describe("replayedWriteStep", () => {
  const checkout = "export const fill = `await page.fill('#qty','2');`;";
  const place = `import { fill } from "./checkout.mjs";\nexport default { code: fill + "await page.click('#place');" };`;
  const files = new Map([
    ["src/checkout.mjs", checkout],
    ["src/place-step.mjs", place],
    ["src/read-back-step.mjs", "export default { code: 'return document.title;' };"],
  ]);
  const act = (entrypoint: string) => request({ purpose: "act", target: "liveBrowser", entrypoint });
  const step = (entrypoint: string, stateChanging: boolean, from = files): WriteStep => ({
    entrypoint,
    sourceDigest: writeStepDigest(from, entrypoint),
    stateChanging,
  });

  it("refuses an unchanged act step straight after it sent state-changing requests", () => {
    expect(
      replayedWriteStep(act("src/place-step.mjs"), files, [step("src/place-step.mjs", true)]),
    ).toContain("could commit the write twice");
  });

  it("refuses an unchanged commit step again after an unrelated scratch edit", () => {
    const steps = [step("src/place-step.mjs", true)];
    const withScope = new Map(files)
      .set("src/place-step.mjs", `${place}\nexport const scope = 'global';\n`)
      .set("scratch/notes.mjs", "export const note = 'placed once';\n");
    const edited = [step("src/place-step.mjs", true, withScope)];
    withScope.set("scratch/notes.mjs", "export const note = 'still placed once';\n");
    expect(replayedWriteStep(act("src/place-step.mjs"), withScope, edited)).toBeDefined();
    expect(replayedWriteStep(act("src/place-step.mjs"), files, steps)).toBeDefined();
  });

  it("lets the step run again once another act step has read the outcome", () => {
    expect(
      replayedWriteStep(act("src/place-step.mjs"), files, [
        step("src/place-step.mjs", true),
        step("src/read-back-step.mjs", false),
      ]),
    ).toBeUndefined();
  });

  it("lets a step through that sent nothing state-changing, changed source or is not an act", () => {
    expect(
      replayedWriteStep(act("src/place-step.mjs"), files, [step("src/place-step.mjs", false)]),
    ).toBeUndefined();
    const changed = new Map(files).set("src/checkout.mjs", `${checkout}\n// quantity 3`);
    expect(
      replayedWriteStep(act("src/place-step.mjs"), changed, [step("src/place-step.mjs", true)]),
    ).toBeUndefined();
    expect(
      replayedWriteStep(
        request({ purpose: "explore", target: "liveBrowser", entrypoint: "src/place-step.mjs" }),
        files,
        [step("src/place-step.mjs", true)],
      ),
    ).toBeUndefined();
  });
});

describe("writeSessionBoundary", () => {
  const live = (purpose: ExecutionRequest["purpose"]) =>
    request({ purpose, target: "liveBrowser" });
  it("keeps act steps to a write build's live session", () => {
    expect(
      writeSessionBoundary(live("act"), { buildEffect: "read", writeSessionStarted: false }),
    ).toContain("Purpose act is a live step");
    expect(
      writeSessionBoundary(request({ purpose: "act" }), {
        buildEffect: "write",
        writeSessionStarted: false,
      }),
    ).toBeDefined();
    expect(
      writeSessionBoundary(live("act"), { buildEffect: "write", writeSessionStarted: true }),
    ).toBeUndefined();
  });

  it("refuses a write build's live example and test, and live explores once its session started", () => {
    const write = { buildEffect: "write" as const, writeSessionStarted: false };
    expect(writeSessionBoundary(live("example"), write)).toContain("never as a live example");
    expect(writeSessionBoundary(live("test"), write)).toContain("never as a live example");
    expect(writeSessionBoundary(live("explore"), write)).toBeUndefined();
    expect(
      writeSessionBoundary(live("explore"), { ...write, writeSessionStarted: true }),
    ).toContain("live exploration is over");
    expect(writeSessionBoundary(request({ purpose: "test" }), write)).toBeUndefined();
    for (const purpose of ["example", "test", "explore"] as const)
      expect(
        writeSessionBoundary(live(purpose), { buildEffect: "read", writeSessionStarted: false }),
      ).toBeUndefined();
  });
});

describe("read/write switches", () => {
  it("treats a read build with no claimed example as repeatable", () => {
    expect(repeatableReadFor("read", false)).toBe(true);
    expect(repeatableReadFor("read", true)).toBe(false);
    expect(repeatableReadFor("write", false)).toBe(false);
    expect(repeatableReadFor(undefined, false)).toBe(false);
  });

  it("screens the approved question of a repeatable read's upgrade and refuses any other", async () => {
    const projection = portableMintProjection(["private-account-7"]);
    expect(
      await Effect.runPromise(
        writeUpgradeApproval(
          projection,
          { buildEffect: "read", repeatableRead: true },
          "Save the note for private-account-7?",
        ),
      ),
    ).toBe("Save the note for [private]?");
    for (const state of [
      { buildEffect: "write" as const, repeatableRead: false },
      { buildEffect: "read" as const, repeatableRead: false },
    ])
      expect(
        await Effect.runPromise(
          Effect.either(writeUpgradeApproval(projection, state, "Save the note?")),
        ),
      ).toMatchObject({
        _tag: "Left",
        left: {
          code: "Unavailable",
          failureDetail: { context: { check: "not_a_repeatable_read" } },
        },
      });
  });
});
