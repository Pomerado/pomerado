import { Cause, Effect, Either, Exit } from "effect";
import { expect, it } from "vitest";
import type { SignInLogin, SignInRecipeStep } from "../../src/destinations/sign-in-recipe.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import {
  correctRejectedLogin,
  logicalRejectedField,
  makeReplayRetryState,
  makeRunLogin,
  recordedRejections,
} from "../../src/runtime/sign-in-values.js";

// A run's login, its corrections and the recipe's recorded rejection markers.

const login = { username: "synthetic-user", password: "synthetic-password" };

const steps: readonly SignInRecipeStep[] = [
  {
    page: "https://example.test/login",
    fields: [],
    rejectedMarkers: [
      { slot: "password", selector: "#password-error" },
      { slot: "email", selector: "#email-error" },
    ],
  },
];

it("refuses a partial rejection when another marker cannot be read", async () => {
  const visible = (selector: string) =>
    selector === "#password-error" ? Effect.succeed(true) : Effect.fail(new Error("unavailable"));
  expect(await Effect.runPromise(recordedRejections(visible, steps))).toBe("unavailable");
});

it("collects every visible field once, with credentials before one-time codes", async () => {
  const recorded: readonly SignInRecipeStep[] = [
    {
      page: "https://example.test/code",
      fields: [],
      rejectedMarkers: [
        { slot: "code", selector: "#code-error" },
        { slot: "email", selector: "#email-error" },
        { slot: "password", selector: "#hidden-error" },
      ],
    },
    ...steps,
  ];
  const visible = (selector: string, page: string) =>
    Effect.succeed(selector !== "#hidden-error" && page.startsWith("https://example.test/"));
  expect(await Effect.runPromise(recordedRejections(visible, recorded))).toEqual([
    "email",
    "password",
    "code",
  ]);
});

it("returns no rejections when no marker shows", async () => {
  expect(
    await Effect.runPromise(recordedRejections(() => Effect.succeed(false), steps)),
  ).toEqual([]);
});

it.each([
  ["a typed failure", () => Effect.fail(new Error("Marker unavailable"))],
  ["a defect", () => Effect.die(new Error("Marker unavailable"))],
  [
    "a synchronous exception",
    () => {
      throw new Error("Marker unavailable");
    },
  ],
] as const)("fails closed on %s", async (_name, visible) => {
  expect(await Effect.runPromise(recordedRejections(visible, steps))).toBe("unavailable");
});

it("keeps an interruption rather than treating it as a recipe failure", async () => {
  const result = await Effect.runPromise(
    Effect.exit(recordedRejections(() => Effect.interrupt, steps)),
  );
  expect(Exit.isFailure(result) && Cause.isInterrupted(result.cause)).toBe(true);
});

it.each(["username", "email", "phone", "account_number"] as const)(
  "counts the %s field the username went into as the username",
  (primaryKind) => {
    const rejected = ["username", primaryKind, "username", primaryKind] as const;
    expect(new Set(rejected.map((slot) => logicalRejectedField(slot, primaryKind)))).toEqual(
      new Set(["username"]),
    );
  },
);

it.each(["password", "code", "date_of_birth", "zip", "recovery_code"] as const)(
  "keeps %s apart from the username",
  (slot) => expect(logicalRejectedField(slot, "email")).toBe(slot),
);

it("keeps another identifier kind apart from the one the username went into", () => {
  expect(logicalRejectedField("phone", "email")).toBe("phone");
  expect(logicalRejectedField("email")).toBe("email");
});

/** A login whose read and correction come from `reads` and `corrections`, counting each. */
const fakeLogin = (
  read: () => Effect.Effect<WebsiteCredentials, string>,
  corrections: WebsiteCredentials[] = [],
) => {
  let reads = 0;
  const asked: string[] = [];
  const value: SignInLogin<string> = {
    held: () => undefined,
    values: Effect.suspend(() => {
      reads += 1;
      return read();
    }),
    correct: (field) =>
      Effect.sync(() => {
        asked.push(field);
        return corrections.shift() ?? login;
      }),
  };
  return { value, reads: () => reads, asked };
};

it("reads a run's login once, keeping a failed read failed, and holds a correction", async () => {
  const failing = fakeLogin(() => Effect.fail("unanswered"));
  const run = await Effect.runPromise(makeRunLogin(failing.value));
  expect(run.held()).toBeUndefined();
  for (const _ of [1, 2, 3])
    expect(await Effect.runPromise(Effect.either(run.values))).toEqual(Either.left("unanswered"));
  expect(failing.reads()).toBe(1);

  const reading = fakeLogin(() => Effect.succeed(login));
  const held = await Effect.runPromise(makeRunLogin(reading.value));
  expect(await Effect.runPromise(held.values)).toEqual(login);
  expect(await Effect.runPromise(held.values)).toEqual(login);
  expect(reading.reads()).toBe(1);
  const corrected = { ...login, password: "synthetic-corrected" };
  held.hold(corrected);
  expect(held.held()).toEqual(corrected);
  expect(await Effect.runPromise(held.values)).toEqual(corrected);
});

const rejectedLogin = (retry = makeReplayRetryState()) => {
  retry.rejectedValues.password = new Set([login.password]);
  return retry;
};

it("asks a correction again while it repeats the rejected password, never returning it", async () => {
  const retry = rejectedLogin();
  const correction = { ...login, password: "synthetic-corrected" };
  const owner = fakeLogin(() => Effect.succeed(login), [login, correction]);
  const result = await Effect.runPromise(
    Effect.either(
      correctRejectedLogin({
        fields: ["password"],
        retry,
        ask: () => owner.value.correct("password", login),
        reject: (field) => `rejected:${field}`,
      }),
    ),
  );
  expect(result).toEqual(Either.right(correction));
  expect(owner.asked).toEqual(["password", "password"]);
  expect(retry.correctionRequests).toEqual({ password: 2 });
});

it("fails for the field whose two corrections ran out, without asking a third time", async () => {
  const retry = rejectedLogin();
  retry.correctionRequests.password = 1;
  const owner = fakeLogin(() => Effect.succeed(login), [login, login]);
  const result = await Effect.runPromise(
    Effect.either(
      correctRejectedLogin({
        fields: ["password"],
        retry,
        ask: () => owner.value.correct("password", login),
        reject: (field) => `rejected:${field}`,
      }),
    ),
  );
  expect(result).toEqual(Either.left("rejected:password"));
  expect(owner.asked).toEqual(["password"]);
});

it("counts a rejected email the username went into against the username's corrections", async () => {
  const retry = makeReplayRetryState();
  retry.primary.kind = "email";
  retry.rejectedValues.username = new Set([login.username]);
  retry.correctionRequests.username = 2;
  const owner = fakeLogin(() => Effect.succeed(login));
  const result = await Effect.runPromise(
    Effect.either(
      correctRejectedLogin({
        fields: ["email"],
        retry,
        ask: () => owner.value.correct("email", login),
        reject: (field) => `rejected:${field}`,
      }),
    ),
  );
  expect(result).toEqual(Either.left("rejected:email"));
  expect(owner.asked).toEqual([]);
});
