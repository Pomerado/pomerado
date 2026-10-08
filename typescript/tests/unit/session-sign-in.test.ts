import { Effect, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";
import {
  boundedSignInAsker,
  boundedSignInHooks,
  executorBrowserRefusal,
  mintSessionSignIns,
  runSessionSignIns,
  sessionOnPage,
  sessionSignInAllowance,
  signedInAtEntry,
  type BoundedSignInHooks,
} from "../../src/runtime/session-sign-in.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import {
  mintSessionSignInFailure,
  SessionSignInFailed,
} from "../../src/standalone/session-sign-in.js";

it("allows a mint one automatic sign-in per check and four per attempt", () => {
  expect(sessionSignInAllowance(mintSessionSignIns, { attempt: 0, scope: 0 })).toBe("allowed");
  expect(sessionSignInAllowance(mintSessionSignIns, { attempt: 1, scope: 1 })).toBe(
    "session_not_kept",
  );
  expect(sessionSignInAllowance(mintSessionSignIns, { attempt: 3, scope: 0 })).toBe("allowed");
  expect(sessionSignInAllowance(mintSessionSignIns, { attempt: 4, scope: 0 })).toBe(
    "session_not_kept",
  );
});

it("allows a run three automatic sign-ins per try and four per attempt", () => {
  expect(sessionSignInAllowance(runSessionSignIns, { attempt: 2, scope: 2 })).toBe("allowed");
  expect(sessionSignInAllowance(runSessionSignIns, { attempt: 3, scope: 3 })).toBe(
    "session_not_kept",
  );
  // A second try starts its own count, inside what the attempt has left.
  expect(sessionSignInAllowance(runSessionSignIns, { attempt: 3, scope: 0 })).toBe("allowed");
  expect(sessionSignInAllowance(runSessionSignIns, { attempt: 4, scope: 0 })).toBe(
    "session_not_kept",
  );
});

it("reads a page as signed out only on the marker's own evidence and page", () => {
  const recipe = { steps: [{ page: "https://login.example.test/sign-in" }], signedIn: {} };
  const onAccount = { steps: recipe.steps, signedIn: { urlPath: "/account" } };
  expect(sessionOnPage({ signedIn: true, url: "https://example.test/a" }, recipe)).toBe(
    "signed_in",
  );
  for (const failed of [
    "indicator_not_visible",
    "path_mismatch",
    "password_field_visible",
  ] as const) {
    expect(sessionOnPage({ signedIn: false, failed, url: "https://example.test/a" }, recipe)).toBe(
      "signed_out",
    );
    expect(
      sessionOnPage({ signedIn: false, failed, url: "https://example.test/account" }, onAccount),
    ).toBe("signed_out");
    // A marker recorded on the account page says nothing on the login page the host opened.
    expect(
      sessionOnPage({ signedIn: false, failed, url: "https://example.test/login" }, onAccount),
    ).toBe("unknown");
  }
  for (const failed of ["page_unavailable", "selector_unsupported"] as const)
    expect(sessionOnPage({ signedIn: false, failed }, recipe)).toBe("unknown");
  // An off-site page is signed out only when it is a recorded sign-in screen.
  expect(
    sessionOnPage(
      { signedIn: false, failed: "off_site", url: "https://login.example.test/sign-in?next=1" },
      recipe,
    ),
  ).toBe("signed_out");
  expect(
    sessionOnPage(
      { signedIn: false, failed: "off_site", url: "https://pay.example.test/" },
      recipe,
    ),
  ).toBe("unknown");
});

it("fills a login into an execution's browser only while that execution waits in its own sign-in", () => {
  const browser = { id: "attached" };
  const other = { id: "other" };
  expect(executorBrowserRefusal(browser, { attached: browser, waitingInSignIn: undefined })).toBe(
    "run_sign_in_executor_attached",
  );
  // Another browser's waiting execution does not open this one.
  expect(executorBrowserRefusal(browser, { attached: browser, waitingInSignIn: other })).toBe(
    "run_sign_in_executor_attached",
  );
  expect(
    executorBrowserRefusal(browser, { attached: browser, waitingInSignIn: browser }),
  ).toBeUndefined();
  // A browser no execution was given, or whose execution stopped, signs in.
  expect(
    executorBrowserRefusal(browser, { attached: undefined, waitingInSignIn: undefined }),
  ).toBeUndefined();
});

/** The host's own failure for a step past the bound, with the shared detail. */
class Expired extends Error {
  constructor(readonly detail: unknown) {
    super("expired");
  }
}

// The host's filling ends at the sign-in's bound, on the injected clock: a step that would start
// later types nothing and opens nothing, and a question asked later waits for no answer.
it("starts no fill, page or question once a sign-in's bound passed", async () => {
  const typed: string[] = [];
  const opened: string[] = [];
  const hooks: BoundedSignInHooks<Error> & { readonly extra: string } = {
    inspect: () => Effect.dieMessage("Unexpected inspect"),
    fill: ({ values }) =>
      Effect.sync(() => {
        typed.push(...values);
        return { outcome: "refused", reason: "typing_unavailable" } as const;
      }),
    open: (url) => Effect.sync(() => void opened.push(url)),
    extra: "kept",
  };
  const asked: (number | undefined)[] = [];
  const ask: InputAsker = (_request, bounds) =>
    Effect.sync(() => {
      asked.push(bounds?.sourceEndsAt);
      return {};
    });
  const request: InputRequest = {
    id: "2c7e9a14-5b3d-4f6e-8a1c-9d0b2e4f6a8c",
    source: "agent",
    questions: [{ id: "note", type: "text", prompt: "A note", maxLength: 10 }],
  };
  const step = {
    step: { fields: [{ selector: "#password", slot: "password" as const }] },
    values: ["first"],
    inspection: {
      page: "https://example.test/login",
      siteOrigin: "https://example.test",
      authenticationOrigins: [],
      targets: { fields: [], submit: null },
      screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
    },
  };
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const bound = { untilMs: 60_000, stop: new AbortController().signal };
      const bounded = boundedSignInHooks(hooks, bound, (detail) => new Expired(detail));
      const boundedAsk = boundedSignInAsker(ask, bound);
      yield* bounded.open("https://example.test/login");
      yield* bounded.fill(step);
      yield* boundedAsk(request, { sourceEndsAt: 600_000 });
      yield* TestClock.adjust("60 seconds");
      const late = yield* bounded.fill({ ...step, values: ["late"] });
      const lateOpen = yield* Effect.either(bounded.open("https://example.test/account"));
      const lateInspect = yield* Effect.either(bounded.inspect(step.step));
      const lateAsk = yield* Effect.either(boundedAsk(request));
      return { late, lateOpen, lateInspect: lateInspect._tag, lateAsk: lateAsk._tag, bounded };
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  expect({ typed, opened, asked }).toEqual({
    typed: ["first"],
    opened: ["https://example.test/login"],
    asked: [60_000],
  });
  expect(outcome).toMatchObject({
    late: {
      outcome: "refused",
      reason: "typing_unavailable",
      failureDetail: {
        subCause: "autofill_step_failed",
        operation: "autofill.replay",
        phase: "automatic_sign_in",
        context: { outcome: "session_sign_in_expired" },
      },
    },
    lateOpen: { _tag: "Left", left: { detail: { context: { outcome: "session_sign_in_expired" } } } },
    lateInspect: "Left",
    lateAsk: "Left",
    // The hooks the bound does not gate stay the host's own.
    bounded: { extra: "kept" },
  });
});

it("stops a sign-in's steps once its stop is raised, before its time bound", async () => {
  const opened: string[] = [];
  const stop = new AbortController();
  const hooks: BoundedSignInHooks<Error> = {
    inspect: () => Effect.dieMessage("Unexpected inspect"),
    fill: () => Effect.dieMessage("Unexpected fill"),
    open: (url) => Effect.sync(() => void opened.push(url)),
  };
  const bounded = boundedSignInHooks(
    hooks,
    { untilMs: Number.MAX_SAFE_INTEGER, stop: stop.signal },
    (detail) => new Expired(detail),
  );
  await Effect.runPromise(bounded.open("https://example.test/login"));
  stop.abort();
  const late = await Effect.runPromise(Effect.either(bounded.open("https://example.test/login")));
  expect(late._tag).toBe("Left");
  expect(opened).toEqual(["https://example.test/login"]);
});

describe("signedInAtEntry", () => {
  /** The start check with each check's answer in turn, recording each reopen. */
  const entry = (
    answers: readonly { readonly signedInAgain: boolean; readonly alreadySignedIn: boolean }[],
    lostOnLoad = { current: false },
  ) => {
    const calls: string[] = [];
    let next = 0;
    const run = signedInAtEntry({
      ensureSignedIn: Effect.sync(() => {
        calls.push("check");
        return answers[next++] ?? { signedInAgain: false, alreadySignedIn: false };
      }),
      reopen: Effect.sync(() => void calls.push("reopen")),
      lostOnLoad,
    });
    return { run: () => Effect.runPromise(run), calls, lostOnLoad };
  };
  const signedIn = { signedInAgain: true, alreadySignedIn: false };
  const still = { signedInAgain: true, alreadySignedIn: true };
  const asWas = { signedInAgain: false, alreadySignedIn: false };

  it("leaves a page still signed in as it is", async () => {
    const start = entry([asWas]);
    expect(await start.run()).toBe(false);
    expect(start.calls).toEqual(["check"]);
  });

  it("reopens the entry page once a check that typed nothing moved it", async () => {
    const start = entry([still]);
    expect(await start.run()).toBe(false);
    expect(start.calls).toEqual(["check", "reopen"]);
  });

  it("signs in, reopens the entry page and checks it once more", async () => {
    const start = entry([signedIn, asWas]);
    expect(await start.run()).toBe(false);
    expect(start.calls).toEqual(["check", "reopen", "check"]);
    expect(start.lostOnLoad.current).toBe(false);
  });

  it("marks a session the entry page's load signs out again as kept in page memory", async () => {
    const start = entry([signedIn, signedIn]);
    expect(await start.run()).toBe(true);
    expect(start.calls).toEqual(["check", "reopen", "check"]);
    expect(start.lostOnLoad.current).toBe(true);
  });

  it("starts a page-memory session where its sign-in left it, with no reopen", async () => {
    const start = entry([signedIn], { current: true });
    expect(await start.run()).toBe(true);
    expect(start.calls).toEqual(["check"]);
  });

  it("reopens again when the second check found the site still signed in", async () => {
    const start = entry([signedIn, still]);
    expect(await start.run()).toBe(false);
    expect(start.calls).toEqual(["check", "reopen", "check", "reopen"]);
  });
});

describe("mintSessionSignInFailure", () => {
  const failed = (refusal: "session_not_kept" | "session_sign_in_failed", failure?: unknown) =>
    new SessionSignInFailed({
      refusal,
      trigger: "signed_out_at_start",
      reason: refusal === "session_not_kept" ? "session_not_kept" : "replay_failed",
      ...(failure === undefined ? {} : { failure }),
    });

  it("ends a build whose sign-ins are spent with its session not kept", () => {
    expect(mintSessionSignInFailure(failed("session_not_kept"))).toMatchObject({
      code: "Unavailable",
      sessionLoss: "session_not_kept",
      failureDetail: { context: { outcome: "session_not_kept", cause: "signed_out_at_start" } },
    });
  });

  it("takes a login the site rejected down the build's rejection path", () => {
    const rejected = new SignInRunFailed({ code: "CredentialsRejected", reason: "password" });
    expect(mintSessionSignInFailure(failed("session_sign_in_failed", rejected))).toMatchObject({
      code: "CredentialsRejected",
      rejectedCredential: "password",
    });
  });

  it("ends a build whose sign-in question went unanswered as unanswered", () => {
    const unanswered = new SignInRunFailed({ code: "NeedsInput", reason: "code" });
    expect(mintSessionSignInFailure(failed("session_sign_in_failed", unanswered))).toMatchObject({
      code: "Unavailable",
      noResponse: { possibleCommit: false },
    });
  });

  it("leaves the host unavailable on any other failure, naming why", () => {
    const changed = new SignInRunFailed({ code: "RecipeFailed", reason: "not_found" });
    expect(mintSessionSignInFailure(failed("session_sign_in_failed", changed))).toMatchObject({
      code: "Unavailable",
      failureDetail: {
        operation: "autofill.replay",
        phase: "automatic_sign_in",
        context: { outcome: "session_sign_in_failed", reason: "replay_failed" },
      },
    });
  });
});
