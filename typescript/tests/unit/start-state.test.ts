import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  AutofillFieldStatus,
  AutofillSlot,
  AutofillStepReport,
  AutofillStepRequest,
  IdentifierKind,
} from "../../src/destinations/autofill-step.js";
import type { HostExecute } from "../../src/runtime/host-execute.js";
import {
  isFirstWriteStep,
  localStartHooks,
  makeStartTracker,
  saveSessionCode,
  shouldSaveSession,
  startPage,
  startStateFor,
  stopLoadingCode,
  type StepPurpose,
} from "../../src/runtime/start-state.js";
import { makeBuildStart } from "../../src/standalone/mint-state.js";

const purposes: readonly StepPurpose[] = [
  "explore",
  "authenticate",
  "test",
  "example",
  "act",
  "inspect",
  "residual",
];

describe("startStateFor", () => {
  const signedOut = { writeSessionStarted: false, signedIn: false, sessionSaved: false };
  it.each(purposes)("starts a live %s as the table says when signed out", (purpose) => {
    const resets = purpose === "example" || purpose === "test" || purpose === "act";
    expect(startStateFor({ purpose, live: true, ...signedOut })).toBe(resets ? "clear" : "none");
  });
  it.each(purposes)("never resets a %s that does not run on the live browser", (purpose) => {
    for (const signedIn of [false, true])
      for (const sessionSaved of [false, true])
        expect(
          startStateFor({
            purpose,
            live: false,
            writeSessionStarted: false,
            signedIn,
            sessionSaved,
          }),
        ).toBe("none");
  });
  it.each(["example", "test", "act"] as const)(
    "restores a signed-in %s's saved session, else keeps its session",
    (purpose) => {
      const step = { purpose, live: true, writeSessionStarted: false, signedIn: true };
      expect(startStateFor({ ...step, sessionSaved: true })).toBe("restore");
      expect(startStateFor({ ...step, sessionSaved: false })).toBe("keep");
    },
  );
  it("continues the page for a write session's later steps", () => {
    for (const signedIn of [false, true])
      expect(
        startStateFor({
          purpose: "act",
          live: true,
          writeSessionStarted: true,
          signedIn,
          sessionSaved: signedIn,
        }),
      ).toBe("none");
  });
  it("still resets examples and tests once a write session started", () => {
    const step = { live: true, writeSessionStarted: true, signedIn: false, sessionSaved: false };
    expect(startStateFor({ ...step, purpose: "example" })).toBe("clear");
    expect(startStateFor({ ...step, purpose: "test" })).toBe("clear");
  });
});

describe("isFirstWriteStep", () => {
  it("is the first act before a write session, and nothing else", () => {
    expect(isFirstWriteStep("act", false)).toBe(true);
    expect(isFirstWriteStep("act", true)).toBe(false);
    for (const purpose of purposes.filter((candidate) => candidate !== "act"))
      expect(isFirstWriteStep(purpose, false)).toBe(false);
  });
});

describe("shouldSaveSession", () => {
  const due = { live: true, signedIn: true, signInSettled: true, sessionSaved: false };
  it.each(purposes.filter((purpose) => purpose !== "authenticate"))(
    "saves before a live %s after a settled sign-in",
    (purpose) => {
      expect(shouldSaveSession({ purpose, ...due })).toBe(true);
    },
  );
  it("never saves on a sign-in step, offline, signed out, mid sign-in or a second time", () => {
    expect(shouldSaveSession({ purpose: "authenticate", ...due })).toBe(false);
    expect(shouldSaveSession({ purpose: "explore", ...due, live: false })).toBe(false);
    expect(shouldSaveSession({ purpose: "explore", ...due, signedIn: false })).toBe(false);
    expect(shouldSaveSession({ purpose: "explore", ...due, signInSettled: false })).toBe(false);
    expect(shouldSaveSession({ purpose: "explore", ...due, sessionSaved: true })).toBe(false);
  });
});

describe("makeStartTracker", () => {
  const live = (purpose: StepPurpose) => ({ purpose, live: true });
  /** A sign-in whose steps sent the login's identifier and its password. */
  const signIn = (
    tracker: Pick<ReturnType<typeof makeStartTracker>, "signIn" | "sent" | "verified">,
  ) => {
    tracker.signIn();
    tracker.sent("identifier");
    tracker.sent("proof");
    return tracker.verified();
  };
  it("saves once after a verified sign-in and restores before each example", () => {
    const tracker = makeStartTracker<string>();
    expect(tracker.plan(live("explore"))).toEqual({ save: false, start: "none" });
    expect(signIn(tracker)).toBe(true);
    expect(tracker.plan(live("explore"))).toEqual({ save: true, start: "none" });
    tracker.save("signed-in");
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "restore" });
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "restore" });
    expect(tracker.saved).toBe("signed-in");
  });
  it("restores a session saved by the step that is about to reset", () => {
    const tracker = makeStartTracker();
    signIn(tracker);
    expect(tracker.plan(live("example"))).toEqual({ save: true, start: "restore" });
  });
  it("asks again for a save that did not happen", () => {
    const tracker = makeStartTracker();
    signIn(tracker);
    expect(tracker.plan(live("explore")).save).toBe(true);
    expect(tracker.plan(live("explore")).save).toBe(true);
  });
  it("counts a sign-in only once it sent an identifier and a password, code or approval", () => {
    const tracker = makeStartTracker();
    // A page that shows the account proves nothing before a sign-in step sent the login.
    expect(tracker.verified()).toBe(false);
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "clear" });
    tracker.signIn();
    tracker.sent("identifier");
    expect(tracker.submitted).toBe(false);
    expect(tracker.verified()).toBe(false);
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "clear" });
    tracker.signIn();
    tracker.sent("proof");
    expect(tracker.submitted).toBe(true);
    expect(tracker.verified()).toBe(true);
    expect(tracker.plan(live("example"))).toEqual({ save: true, start: "restore" });
  });
  it("drops the saved session and what was sent on a new sign-in until it is verified", () => {
    const tracker = makeStartTracker<string>();
    signIn(tracker);
    tracker.save("first");
    tracker.signIn();
    expect(tracker.saved).toBeUndefined();
    expect(tracker.submitted).toBe(false);
    expect(tracker.verified()).toBe(false);
    // Still signed in, but nothing saved describes the browser: keep its session.
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "keep" });
    tracker.sent("identifier");
    tracker.sent("proof");
    expect(tracker.verified()).toBe(true);
    expect(tracker.plan(live("explore"))).toEqual({ save: true, start: "none" });
    tracker.save("second");
    expect(tracker.saved).toBe("second");
  });
  it("refuses a check again after a confirmed sign-in and drops its session", () => {
    const tracker = makeStartTracker<string>();
    signIn(tracker);
    tracker.save("first");
    // A confirmed sign-in is over: what it sent counts for no later check.
    expect(tracker.submitted).toBe(false);
    expect(tracker.verified()).toBe(false);
    expect(tracker.saved).toBe("first");
    // A check is a sign-in step too, so it drops the session saved after the last sign-in.
    tracker.signIn();
    expect(tracker.saved).toBeUndefined();
    expect(tracker.verified()).toBe(false);
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "keep" });
  });
  it("adds each screen of an open sign-in to what it sent", () => {
    const tracker = makeStartTracker();
    tracker.signIn();
    tracker.sent("identifier");
    tracker.signIn();
    tracker.sent("proof");
    expect(tracker.verified()).toBe(true);
  });
  it("keeps no new-browser method a local build never calls", () => {
    expect(Object.keys(makeStartTracker())).not.toContain("invalidate");
  });
  it("starts the write session once its first act is dispatched, not when it is planned", () => {
    const tracker = makeStartTracker();
    expect(tracker.plan(live("act"))).toEqual({ save: false, start: "clear" });
    // A plan whose save or reset failed leaves the next act to reset again.
    expect(tracker.plan(live("act"))).toEqual({ save: false, start: "clear" });
    tracker.dispatched(live("act"));
    expect(tracker.plan(live("act"))).toEqual({ save: false, start: "none" });
  });
});

// The build's wiring on a modeled browser that names each call it receives.
const modeledBuild = (
  options: {
    readonly saveFailures?: number;
    readonly resetFailures?: number;
    readonly rootLoads?: boolean;
  } = {},
) => {
  const targetId = "primary-target";
  const calls: string[] = [];
  const resets: string[] = [];
  let saveFailures = options.saveFailures ?? 0;
  let resetFailures = options.resetFailures ?? 0;
  const execute: HostExecute = (code) =>
    Effect.suspend((): Effect.Effect<unknown, Error> => {
      if (code === saveSessionCode) {
        if (saveFailures > 0) {
          saveFailures--;
          calls.push("save failed");
          return Effect.fail(new Error("Save failed"));
        }
        calls.push("save");
        return Effect.succeed({ cookies: [{ name: "login", value: "member" }], origins: [] });
      }
      if (code === stopLoadingCode(targetId)) {
        calls.push("stop");
        return Effect.void;
      }
      if (code.includes("Storage.clearDataForOrigin")) {
        const siteData = /const siteData = "(\w+)"/u.exec(code)?.[1] ?? "?";
        resets.push(code);
        if (resetFailures > 0) {
          resetFailures--;
          calls.push(`reset:${siteData} failed`);
          return Effect.fail(new Error("Reset failed"));
        }
        calls.push(`reset:${siteData}`);
        return Effect.void;
      }
      calls.push("root");
      return Effect.succeed(options.rootLoads ?? true);
    });
  const start = makeBuildStart(
    { execute, targetId },
    "https://site.test",
    Effect.sync(() => {
      calls.push("entry");
    }),
  );
  const step = (purpose: StepPurpose, target: "liveBrowser" | "pureFiles" = "liveBrowser") =>
    Effect.runPromise(
      Effect.either(
        start.before({ purpose, target }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              calls.push("run");
            }),
          ),
        ),
      ),
    );
  /** A sign-in step that sent the login, and the host's check that verifies it. */
  const signIn = async () => {
    const outcome = await step("authenticate");
    start.sent(
      filled([
        ["username", "filled"],
        ["password", "filled"],
      ]),
      asked("username", "password"),
    );
    expect(start.verified()).toBe(true);
    return outcome;
  };
  return { start, step, signIn, calls, resets };
};
/** A sign-in step's requested fields, one per slot. */
const asked = (...slots: readonly AutofillSlot[]): AutofillStepRequest["fields"] =>
  slots.map((slot) =>
    slot === "password" || slot === "code" || slot === "date_of_birth"
      ? { selector: `#${slot}`, slot }
      : { selector: `#${slot}`, accepts: [slot as IdentifierKind] },
  );
/** What a host fill reports: each field's slot and status, and its submit. */
const filled = (
  fields: readonly (readonly [AutofillSlot, AutofillFieldStatus])[],
  submit: "clicked" | "failed" | "not_attempted" | "refused" | "stayed_disabled" | "none" = "clicked",
): AutofillStepReport => ({
  outcome: "filled",
  fields: fields.map(([slot, status]) => ({ slot, status })),
  submit,
  url: "https://site.test/account",
});

describe("makeBuildStart", () => {
  it("resets before a live example but not an exploration, saving nothing signed out", async () => {
    const build = modeledBuild();
    await build.step("explore");
    await build.step("example");
    await build.step("explore");
    // The exploration runs on its retained page; the example resets first. A later exploration
    // continues the example's page rather than loading the request's URL again.
    expect(build.calls).toEqual(["entry", "run", "reset:clear", "root", "run", "run"]);
  });

  it("saves the signed-in session once and restores it before each signed-in example", async () => {
    const build = modeledBuild();
    await build.signIn();
    for (const purpose of ["explore", "example", "example"] as const) await build.step(purpose);
    expect(build.calls).toEqual([
      "entry",
      "run",
      "save",
      "run",
      "reset:restore",
      "root",
      "run",
      "reset:restore",
      "root",
      "run",
    ]);
    expect(build.resets[0]).toContain('"login"');
  });

  it("restores the signed-in session and the root before each live test", async () => {
    const build = modeledBuild();
    await build.signIn();
    for (const purpose of ["explore", "test", "test"] as const) await build.step(purpose);
    expect(build.calls).toEqual([
      "entry",
      "run",
      "save",
      "run",
      "reset:restore",
      "root",
      "run",
      "reset:restore",
      "root",
      "run",
    ]);
  });

  it("runs nothing signed in until the session after sign-in is saved", async () => {
    const build = modeledBuild({ saveFailures: 1 });
    const outcomes = [];
    outcomes.push(await build.signIn());
    for (const purpose of ["explore", "explore", "example", "example"] as const)
      outcomes.push(await build.step(purpose));
    expect(outcomes.map((outcome) => outcome._tag)).toEqual([
      "Right",
      "Left",
      "Right",
      "Right",
      "Right",
    ]);
    expect(outcomes[1]).toMatchObject({ left: { code: "Unavailable" } });
    expect(build.calls).toEqual([
      "entry",
      "run",
      "save failed",
      "save",
      "run",
      "reset:restore",
      "root",
      "run",
      "reset:restore",
      "root",
      "run",
    ]);
  });

  it("stops a live example whose reset fails before its source runs", async () => {
    const build = modeledBuild({ resetFailures: 1 });
    const outcome = await build.step("example");
    expect(outcome).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
    expect(build.calls).toEqual(["reset:clear failed"]);
  });

  it("stops a root that fails to load and still runs the step", async () => {
    const build = modeledBuild({ rootLoads: false });
    expect((await build.step("example"))._tag).toBe("Right");
    expect(build.calls).toEqual(["reset:clear", "root", "stop", "run"]);
  });

  it("keeps the session after a new sign-in until it is verified and saved again", async () => {
    const build = modeledBuild();
    await build.signIn();
    await build.step("example");
    await build.step("authenticate");
    await build.step("example");
    build.start.sent(
      filled([
        ["email", "filled"],
        ["code", "filled"],
      ]),
      asked("email", "code"),
    );
    expect(build.start.verified()).toBe(true);
    await build.step("example");
    expect(build.calls).toEqual([
      "entry",
      "run",
      "save",
      "reset:restore",
      "root",
      "run",
      "run",
      "reset:keep",
      "root",
      "run",
      "save",
      "reset:restore",
      "root",
      "run",
    ]);
  });

  it("leaves an example signed out when a page showed the account before any sign-in", async () => {
    const build = modeledBuild();
    await build.step("explore");
    expect(build.start.submitted).toBe(false);
    expect(build.start.verified()).toBe(false);
    await build.step("example");
    expect(build.calls).toEqual(["entry", "run", "reset:clear", "root", "run"]);
  });

  it("counts what a fill typed, whatever became of a submit it could click, and an uncertain step's fields", async () => {
    const login = asked("username", "password");
    const uncertain = {
      outcome: "uncertain",
      reason: "fill_call_failed",
    } as unknown as AutofillStepReport;
    const counted: readonly (readonly [AutofillStepReport, AutofillStepRequest["fields"]])[] = [
      // The page may send what was typed itself, as a form that submits on its own does.
      ...(["clicked", "refused", "failed", "not_attempted", "none"] as const).map(
        (submit) =>
          [
            filled(
              [
                ["username", "filled"],
                ["password", "filled"],
              ],
              submit,
            ),
            login,
          ] as const,
      ),
      // A lost answer may have typed every field the step asked for.
      [uncertain, login],
    ];
    for (const [report, fields] of counted) {
      const build = modeledBuild();
      await build.step("authenticate");
      build.start.sent(report, fields);
      expect(build.start.submitted).toBe(true);
    }
    const uncounted: readonly (readonly [AutofillStepReport, AutofillStepRequest["fields"]])[] = [
      [
        filled([
          ["username", "filled"],
          ["password", "failed"],
        ]),
        login,
      ],
      // A submit the page kept disabled was never clicked, so nothing went out.
      [
        filled(
          [
            ["username", "filled"],
            ["password", "filled"],
          ],
          "stayed_disabled",
        ),
        login,
      ],
      [
        filled([
          ["username", "filled"],
          ["date_of_birth", "filled"],
        ]),
        asked("username", "date_of_birth"),
      ],
      [uncertain, asked("username")],
      [{ outcome: "refused", reason: "not_found" } as unknown as AutofillStepReport, login],
    ];
    for (const [report, fields] of uncounted) {
      const build = modeledBuild();
      await build.step("authenticate");
      build.start.sent(report, fields);
      expect(build.start.submitted).toBe(false);
    }
    // Screen by screen; or an approval after the login.
    const build = modeledBuild();
    await build.step("authenticate");
    build.start.sent(filled([["phone", "filled"]], "none"), asked("phone"));
    await build.step("authenticate");
    build.start.sent(filled([["code", "filled"]]), asked("code"));
    expect(build.start.submitted).toBe(true);
    const approval = modeledBuild();
    await approval.step("authenticate");
    approval.start.sent(filled([["account_number", "filled"]]), asked("account_number"));
    approval.start.approved();
    expect(approval.start.submitted).toBe(true);
    // Or a code the site sent, which the agent's explore typed into the code screen.
    const typed = modeledBuild();
    await typed.step("authenticate");
    typed.start.sent(filled([["username", "filled"]]), asked("username"));
    expect(typed.start.submitted).toBe(false);
    typed.start.typedCode();
    expect(typed.start.submitted).toBe(true);
  });

  it("drops the session on a check again after a confirmed sign-in, and keeps the browser's", async () => {
    const build = modeledBuild();
    await build.signIn();
    await build.step("example");
    // The check is a sign-in step: it starts a new sign-in, which nothing has sent yet.
    build.start.signIn();
    expect(build.start.submitted).toBe(false);
    expect(build.start.verified()).toBe(false);
    await build.step("example");
    expect(build.calls).toEqual([
      "entry",
      "run",
      "save",
      "reset:restore",
      "root",
      "run",
      "reset:keep",
      "root",
      "run",
    ]);
  });

  it("resets a write session's first step only", async () => {
    const build = modeledBuild();
    await build.step("act");
    await build.step("act");
    expect(build.calls).toEqual(["reset:clear", "root", "run", "run"]);
  });

  it("resets a write session's first step again when the reset before it failed", async () => {
    const build = modeledBuild({ resetFailures: 1 });
    const outcomes = [];
    for (const purpose of ["act", "act", "act"] as const) outcomes.push(await build.step(purpose));
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Left", "Right", "Right"]);
    expect(build.calls).toEqual(["reset:clear failed", "reset:clear", "root", "run", "run"]);
  });

  it("resets a write session's first step again when the save before it failed", async () => {
    const build = modeledBuild({ saveFailures: 1 });
    await build.signIn();
    const outcomes = [];
    for (const purpose of ["act", "act", "act"] as const) outcomes.push(await build.step(purpose));
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Left", "Right", "Right"]);
    expect(build.calls).toEqual([
      "entry",
      "run",
      "save failed",
      "save",
      "reset:restore",
      "root",
      "run",
      "run",
    ]);
  });

  it("leaves the browser alone for a step that does not run on it", async () => {
    const build = modeledBuild();
    await build.step("example", "pureFiles");
    expect(build.calls).toEqual(["run"]);
  });
});

describe("startPage", () => {
  it("refuses to restore a session that was never saved, before any browser call", async () => {
    const calls: string[] = [];
    const execute: HostExecute = (code) =>
      Effect.sync(() => {
        calls.push(code);
        return true;
      });
    const outcome = await Effect.runPromise(
      Effect.either(
        startPage(
          execute,
          "primary-target",
          "https://site.test",
          { siteData: "restore", session: undefined },
          localStartHooks(execute, "primary-target"),
        ),
      ),
    );
    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { message: "No saved session to restore" },
    });
    expect(calls).toEqual([]);
  });
});
