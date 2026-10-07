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
  type RecordedReview,
} from "./guardian-context-fixture.js";
import {
  act,
  effectsOf,
  executions,
  mint,
  noteSite,
  readNote,
  saveNote,
  saveSite,
  saveStep,
} from "./standalone-mint-fixture.js";

const submittedInput = (review: RecordedReview | undefined) =>
  (review?.input["submitted_call"] as Readonly<Record<string, unknown>> | undefined)?.["input"];
const finish = (entrypoint: string, executionId: string, callId: string) =>
  call(
    "finish_build",
    {
      intent: "Return the composed write without running it",
      entrypoint,
      executionId,
      metadata: { name: "save_note", description: "Save the requested note once" },
      coverage: "One confirmed act session on the note the request gave",
    },
    callId,
  );

test("Guardian's denial of a request-derived input records nothing, and the corrected input runs the session", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const stated = JSON.stringify({ note: "kept" });
  // Guardian allows an act step only on the note the request states.
  const guardian = recordingGuardian({
    decide: (review) =>
      currentOf(review)?.["purpose"] !== "act" || submittedInput(review) === stated
        ? "allow"
        : "deny",
  });
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/read.mjs": readNote, "src/save.mjs": saveNote }),
        () => [call("execute", act("src/read.mjs", { note: "invented" }), "invented")],
        () => [call("execute", act("src/read.mjs", stated), "corrected")],
        () => [call("execute", act("src/save.mjs"), "save")],
      ],
    });
    expect(JSON.stringify(toolResult(last, "invented"))).toContain("ReviewDenied");
    expect(toolResult(last, "corrected")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "save")).toMatchObject({ status: "completed" });
    // The denied input was never recorded: the corrected one, not the denied one, runs.
    const acts = executions(guardian.reviews);
    expect(acts.map(submittedInput)).toEqual([
      JSON.stringify({ note: "invented" }),
      stated,
      stated,
    ]);
    expect(acts.map((review) => currentOf(review)?.["input"])).toEqual([
      "intent_derived",
      "intent_derived",
      "intent_derived",
    ]);
    expect(fixture.saved).toEqual(["kept"]);
  } finally {
    await site.close();
  }
});

test("publication refuses a contract that rejects the session's input, and publishes once it decodes it", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
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
            "src/save.mjs": saveNote,
            // The session ran a text note; this contract declares a number.
            "src/numbered.mjs": saveNote.replace(
              "input:Schema.Struct({note:Schema.String})",
              "input:Schema.Struct({note:Schema.Number})",
            ),
            "src/tool.mjs": saveNote,
          }),
        () => [call("execute", act("src/save.mjs", { note: "kept" }), "save")],
        (request) => [finish("src/numbered.mjs", executionIdOf(request, "save"), "mismatch")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "save"), "publish")],
      ],
    });
    expect(toolResult(last, "save")).toMatchObject({ status: "completed" });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(toolResult(last, "mismatch")).toMatchObject({
      status: "not_published",
      reason: "contract_input_mismatch",
    });
    expect(fixture.saved).toEqual(["kept"]);
  } finally {
    await site.close();
  }
});

test("a build with nothing to recover refuses inspect and residual before review", async () => {
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
        () => patch({ "src/act.mjs": saveStep }),
        () => [call("execute", execution("inspect", "src/act.mjs"), "inspect")],
        () => [call("execute", execution("residual", "src/act.mjs"), "residual")],
      ],
    });
    for (const purpose of ["inspect", "residual"]) {
      expect(toolResult(last, purpose), purpose).toMatchObject({ status: "unsupported" });
      expect(JSON.stringify(toolResult(last, purpose)), purpose).toContain(
        `${purpose} is for a write maintenance recovering a possible write; this build has none to recover.`,
      );
    }
    expect(executions(guardian.reviews)).toEqual([]);
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("a write session refuses an authenticate step that would run the agent's own source", async () => {
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
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        // Before the session starts, an authored sign-in still runs.
        () => [call("execute", execution("authenticate", "src/look.mjs"), "before")],
        () => [call("execute", execution("act", "src/look.mjs"), "started")],
        () => [call("execute", execution("authenticate", "src/act.mjs"), "during")],
      ],
    });
    expect(toolResult(last, "before")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "started")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "during")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "during"))).toContain(
      "only through a signInStep the host fills",
    );
    expect(fixture.writes()).toBe(0);
    const [before, started] = executions(guardian.reviews);
    expect(executions(guardian.reviews)).toHaveLength(2);
    expect(effectsOf(before)[0]).toMatch(/^Signing in on the site's own sign-in page/u);
    expect(currentOf(started!)?.["purpose"]).toBe("act");
  } finally {
    await site.close();
  }
});
