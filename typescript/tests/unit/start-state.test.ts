import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { HostExecute } from "../../src/runtime/host-execute.js";
import {
  isFirstWriteStep,
  makeStartTracker,
  saveSessionCode,
  shouldSaveSession,
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
          startStateFor({ purpose, live: false, writeSessionStarted: false, signedIn, sessionSaved }),
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
  it("saves once after a verified sign-in and restores before each example", () => {
    const tracker = makeStartTracker<string>();
    expect(tracker.plan(live("explore"))).toEqual({ save: false, start: "none" });
    tracker.invalidate();
    tracker.verified();
    expect(tracker.plan(live("explore"))).toEqual({ save: true, start: "none" });
    tracker.save("signed-in");
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "restore" });
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "restore" });
    expect(tracker.saved).toBe("signed-in");
  });
  it("restores a session saved by the step that is about to reset", () => {
    const tracker = makeStartTracker();
    tracker.verified();
    expect(tracker.plan(live("example"))).toEqual({ save: true, start: "restore" });
  });
  it("asks again for a save that did not happen", () => {
    const tracker = makeStartTracker();
    tracker.verified();
    expect(tracker.plan(live("explore")).save).toBe(true);
    expect(tracker.plan(live("explore")).save).toBe(true);
  });
  it("drops the saved session on a new sign-in until it is verified", () => {
    const tracker = makeStartTracker<string>();
    tracker.verified();
    tracker.plan(live("explore"));
    tracker.save("first");
    tracker.invalidate();
    expect(tracker.saved).toBeUndefined();
    // Still signed in, but nothing saved describes the browser: keep its session.
    expect(tracker.plan(live("example"))).toEqual({ save: false, start: "keep" });
    tracker.verified();
    expect(tracker.plan(live("explore"))).toEqual({ save: true, start: "none" });
    tracker.save("second");
    expect(tracker.saved).toBe("second");
  });
  it("starts the write session once, on its first act", () => {
    const tracker = makeStartTracker();
    expect(tracker.plan(live("act"))).toEqual({ save: false, start: "clear" });
    expect(tracker.plan(live("act"))).toEqual({ save: false, start: "none" });
  });
});

// The build's wiring on a modeled browser that names each call it receives.
const modeledBuild = (
  options: {
    readonly saveFailures?: number;
    readonly resetFails?: boolean;
    readonly rootLoads?: boolean;
  } = {},
) => {
  const targetId = "primary-target";
  const calls: string[] = [];
  const resets: string[] = [];
  let saveFailures = options.saveFailures ?? 0;
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
        calls.push(`reset:${/const siteData = "(\w+)"/u.exec(code)?.[1] ?? "?"}`);
        resets.push(code);
        return options.resetFails === true ? Effect.fail(new Error("Reset failed")) : Effect.void;
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
    ["https://login.site.test"],
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
  return { start, step, calls, resets };
};

describe("makeBuildStart", () => {
  it("resets before a live example but not an exploration, saving nothing signed out", async () => {
    const build = modeledBuild();
    await build.step("explore");
    await build.step("example");
    await build.step("explore");
    // The exploration runs on its retained page; the example resets first. A later exploration
    // continues the example's page rather than loading the request's URL again.
    expect(build.calls).toEqual(["entry", "run", "reset:clear", "root", "run", "run"]);
    expect(build.resets[0]).toContain(JSON.stringify(["https://site.test", "https://login.site.test"]));
  });

  it("saves the signed-in session once and restores it before each signed-in example", async () => {
    const build = modeledBuild();
    await build.step("authenticate");
    build.start.verified();
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
    await build.step("authenticate");
    build.start.verified();
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
    outcomes.push(await build.step("authenticate"));
    build.start.verified();
    for (const purpose of ["explore", "explore", "example", "example"] as const)
      outcomes.push(await build.step(purpose));
    expect(outcomes.map((outcome) => outcome._tag)).toEqual([
      "Right",
      "Left",
      "Right",
      "Right",
      "Right",
    ]);
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
    const build = modeledBuild({ resetFails: true });
    const outcome = await build.step("example");
    expect(outcome._tag).toBe("Left");
    expect(build.calls).toEqual(["reset:clear"]);
  });

  it("stops a root that fails to load and still runs the step", async () => {
    const build = modeledBuild({ rootLoads: false });
    expect((await build.step("example"))._tag).toBe("Right");
    expect(build.calls).toEqual(["reset:clear", "root", "stop", "run"]);
  });

  it("keeps the session after a new sign-in until it is verified and saved again", async () => {
    const build = modeledBuild();
    await build.step("authenticate");
    build.start.verified();
    await build.step("example");
    await build.step("authenticate");
    await build.step("example");
    build.start.verified();
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

  it("resets a write session's first step only", async () => {
    const build = modeledBuild();
    await build.step("act");
    await build.step("act");
    expect(build.calls).toEqual(["reset:clear", "root", "run", "run"]);
  });

  it("leaves the browser alone for a step that does not run on it", async () => {
    const build = modeledBuild();
    await build.step("example", "pureFiles");
    expect(build.calls).toEqual(["run"]);
  });
});
