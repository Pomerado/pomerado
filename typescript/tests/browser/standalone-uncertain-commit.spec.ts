import { test, expect } from "@playwright/test";
import {
  call,
  currentOf,
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

test("a failed act step that posted reports a possible effect and nothing else about its commit", async () => {
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
    expect(receipt).toMatchObject({ status: "failed", effect: "possible" });
    const text = JSON.stringify(receipt);
    expect(text).not.toContain("writeSession");
    expect(text).not.toContain("verifyFirst");
    expect(text).not.toContain("stateChangingRequests");
  } finally {
    await site.close();
  }
});

test("an unchanged failed act step that only read the page is refused as a blind repeat", async () => {
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
    expect(JSON.stringify(toolResult(last, "again"))).toContain(
      "This act step is unchanged and just sent state-changing requests",
    );
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
