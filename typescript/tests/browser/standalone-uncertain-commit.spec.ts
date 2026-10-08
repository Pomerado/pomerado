import { test, expect } from "@playwright/test";
import {
  call,
  currentOf,
  execution,
  executionIdOf,
  patch,
  probe,
  recordingGuardian,
  toolResult,
} from "./guardian-context-fixture.js";
import { act, executions, mint, saveNote, saveSite } from "./standalone-mint-fixture.js";

/** A step that clicks Save, waits for the save to finish, then fails. */
const saveThenFail = probe(
  "await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); throw new Error('Failed after the save');",
);
/** A step that reads the page title, then fails. */
const readThenFail = probe("await page.title(); throw new Error('Failed after the read');");
/** A step that fails before it calls the browser. */
const failEarly = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"fail_early",input:Schema.Unknown,output:Schema.Unknown},
async () => { throw new Error("Failed before the page"); });`;
/** A step that completes without calling the browser. */
const idle = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"idle",input:Schema.Unknown,output:Schema.Unknown},
async () => ({ idle: true }));`;
/** A step that never calls the browser and never returns. */
const hang = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"hang",input:Schema.Unknown,output:Schema.Unknown},
async () => { await new Promise(() => undefined); });`;
/** A write step that enters its commit mark, saves, then never returns. */
const saveThenHang = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save",input:Schema.Unknown,output:Schema.Unknown,write:{confirmation:"readback",commits:["save"]}},
async ({kernel,sessionId,enteringCommit}) => {
  enteringCommit("save");
  await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); return true;",timeout_sec:5});
  await new Promise(() => undefined);
});`;
/** A write step that only reads the save back and records it. */
const readBack = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save",input:Schema.Unknown,output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"readback",commits:["save"]}},
async ({kernel,sessionId,verified}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.title();",timeout_sec:5});
  if(response.result !== "Saved") throw new Error("Not saved");
  verified();
  return {saved:true};
});`;
/** A receipt's observations, which reach the minter as JSON text. */
const observationsOf = (receipt: Readonly<Record<string, unknown>> | undefined) => {
  const observations = receipt?.["observations"];
  return (typeof observations === "string" ? JSON.parse(observations) : observations) as
    | { readonly writeSession?: { readonly verifyFirst: boolean; readonly notice: string } }
    | undefined;
};
/** The start of the notice a failed act step carries when it may have committed. */
const verifyFirst = (reason: string) =>
  `This act step did not complete after ${reason}, so the write may already be committed. Before any further write, verify:`;

const finish = (entrypoint: string, executionId: string, callId: string) =>
  call(
    "finish_build",
    {
      intent: "Return the composed write without running it",
      entrypoint,
      executionId,
      metadata: { name: "save_note", description: "Save the requested note once" },
      coverage: "One act session on the fixture",
    },
    callId,
  );

test("a failed act step that posted tells the minter to verify before any further write", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/save.mjs": saveThenFail }),
        () => [call("execute", act("src/save.mjs"), "save")],
      ],
    });
    expect(fixture.writes()).toBe(1);
    const receipt = toolResult(last, "save");
    // The journal saw a browser call, so the step may have sent its write: the receipt says to
    // read back first. The host counts no requests, so it lists none.
    expect(receipt).toMatchObject({ status: "failed", effect: "possible" });
    const notice = observationsOf(receipt)?.writeSession?.notice;
    expect(observationsOf(receipt)?.writeSession?.verifyFirst).toBe(true);
    expect(notice).toContain(verifyFirst("the page sent requests the host could not count"));
    expect(notice).toContain("The host never resubmits a write for you.");
    expect(JSON.stringify(receipt)).not.toContain("stateChangingRequests");
  } finally {
    await site.close();
  }
});

test("a failed act step Guardian labelled a write is refused as a repeat while its outcome is unresolved", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/read.mjs": readThenFail }),
        () => [call("execute", act("src/read.mjs"), "first")],
        () => [call("execute", act("src/read.mjs"), "again")],
      ],
    });
    expect(toolResult(last, "first")).toMatchObject({ status: "failed", effect: "possible" });
    expect(toolResult(last, "again")).toMatchObject({ status: "unsupported" });
    expect(executions(guardian.reviews)).toHaveLength(1);
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("finish_build on a session that only read the page refuses the unentered commit mark after contract review", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/look.mjs": probe(), "src/tool.mjs": saveNote }),
        // The step fixes the session's input, so the composed contract decodes it.
        () => [call("execute", act("src/look.mjs", { note: "kept" }), "look")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "look"), "publish")],
      ],
    });
    expect(toolResult(last, "look")).toMatchObject({ status: "completed" });
    // The step called the browser, so it may have sent the write: the session passes the sent
    // check, and its contract's unentered commit mark is refused after contract review.
    expect(toolResult(last, "publish")).toMatchObject({
      status: "not_published",
      reason: "commit_marks_unentered",
    });
    expect(built.build).not.toBe("published");
    expect(executions(guardian.reviews).map((review) => currentOf(review)?.["purpose"])).toEqual([
      "act",
      "contract",
    ]);
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("finish_build on a session that never called the browser refuses the write before contract review", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/idle.mjs": idle, "src/tool.mjs": saveNote }),
        () => [call("execute", act("src/idle.mjs", { note: "kept" }), "idle")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "idle"), "publish")],
      ],
    });
    expect(toolResult(last, "idle")).toMatchObject({ status: "completed", effect: "not_sent" });
    // No step recorded a confirmation, entered a commit mark or called the browser, so the
    // session never sent its write: that is refused before the contract is read or reviewed.
    expect(toolResult(last, "publish")).toMatchObject({
      status: "not_published",
      reason: "write_not_submitted",
    });
    expect(built.build).not.toBe("published");
    expect(executions(guardian.reviews).map((review) => currentOf(review)?.["purpose"])).toEqual([
      "act",
    ]);
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("a completed act step that posted carries no list of state-changing requests", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/save.mjs": probe(
              "await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); return true;",
            ),
          }),
        () => [call("execute", act("src/save.mjs"), "save")],
      ],
    });
    expect(fixture.writes()).toBe(1);
    expect(toolResult(last, "save")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(toolResult(last, "save"))).not.toContain("stateChangingRequests");
  } finally {
    await site.close();
  }
});

test("a failed act step that never called the browser carries no read-back notice", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/early.mjs": failEarly }),
        () => [call("execute", act("src/early.mjs"), "early")],
      ],
    });
    const receipt = toolResult(last, "early");
    expect(receipt).toMatchObject({ status: "failed", effect: "not_sent" });
    expect(JSON.stringify(receipt)).not.toContain("writeSession");
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("an act step that returned no result tells the minter to verify, though it never called the browser", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/hang.mjs": hang }),
        () => [call("execute", execution("act", "src/hang.mjs", { timeoutSeconds: 2 }), "hang")],
      ],
    });
    const receipt = toolResult(last, "hang");
    expect(receipt).toMatchObject({ status: "failed", effect: "not_sent" });
    expect(observationsOf(receipt)?.writeSession?.verifyFirst).toBe(true);
    expect(observationsOf(receipt)?.writeSession?.notice).toContain(
      verifyFirst(
        "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered",
      ),
    );
  } finally {
    await site.close();
  }
});

test("a step that lost its result after entering its mark publishes once a read-back confirms the write", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/save.mjs": saveThenHang,
            "src/check.mjs": readBack,
            "src/tool.mjs": readBack,
          }),
        () => [call("execute", execution("act", "src/save.mjs", { timeoutSeconds: 12 }), "save")],
        () => [call("execute", act("src/check.mjs"), "check")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "check"), "publish")],
      ],
    });
    expect(fixture.writes()).toBe(1);
    const lost = toolResult(last, "save");
    expect(lost).toMatchObject({ status: "failed", effect: "possible" });
    expect(observationsOf(lost)?.writeSession?.verifyFirst).toBe(true);
    expect(toolResult(last, "check"), JSON.stringify(toolResult(last, "check"))).toMatchObject({
      status: "completed",
      confirmation: "readback",
    });
    // The mark the lost step streamed counts because the read-back confirmed the write.
    expect(built.build, JSON.stringify(toolResult(last, "publish"))).toBe("published");
  } finally {
    await site.close();
  }
});

test("a step that lost its result after entering its mark, with no read-back confirming it, publishes nothing", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/save.mjs": saveThenHang,
            "src/look.mjs": probe(),
            "src/tool.mjs": readBack,
          }),
        () => [call("execute", execution("act", "src/save.mjs", { timeoutSeconds: 12 }), "save")],
        () => [call("execute", act("src/look.mjs"), "look")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "look"), "publish")],
      ],
    });
    expect(fixture.writes()).toBe(1);
    const lost = toolResult(last, "save");
    expect(lost).toMatchObject({ status: "failed", effect: "possible" });
    expect(observationsOf(lost)?.writeSession?.verifyFirst).toBe(true);
    expect(toolResult(last, "look")).toMatchObject({ status: "completed" });
    // The lost step may have sent the write, so the session passes the sent check. Its streamed
    // mark counts only once a later step confirms the write, and none did.
    expect(toolResult(last, "publish")).toMatchObject({
      status: "not_published",
      reason: "commit_marks_unentered",
    });
    expect(built.build).not.toBe("published");
    expect(executions(guardian.reviews).map((review) => currentOf(review)?.["purpose"])).toEqual([
      "act",
      "act",
      "contract",
    ]);
  } finally {
    await site.close();
  }
});
