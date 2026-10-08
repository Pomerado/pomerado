import { Effect } from "effect";
import { expect, it } from "vitest";
import type { SignInLogin } from "../../src/destinations/sign-in-recipe.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import { makeRejectableLogin } from "../../src/standalone/session-sign-in.js";

// The login a build's or run's sign-ins share, once the site rejected part of it.

const login = { username: "member@example.test", password: "right-password" };

/** A held login whose corrections the owner answers from `answers`, in order. */
const owner = (answers: readonly WebsiteCredentials[]) => {
  let held: WebsiteCredentials | undefined = login;
  const asked: string[] = [];
  const base: SignInLogin<Error> = {
    held: () => held,
    values: Effect.sync(() => held ?? login),
    correct: (field) =>
      Effect.sync(() => {
        asked.push(field);
        held = { ...(answers[asked.length - 1] ?? login) };
        return held;
      }),
  };
  return { base, asked };
};

const valuesOf = (rejectable: ReturnType<typeof makeRejectableLogin<Error>>) =>
  Effect.runPromise(Effect.either(rejectable.login.values));

it("keeps a login nothing of which was rejected", async () => {
  const { base, asked } = owner([]);
  const rejectable = makeRejectableLogin(base, (field) => new Error(`repeated ${field}`));
  expect(rejectable.login.held()).toEqual(login);
  expect(await valuesOf(rejectable)).toMatchObject({ _tag: "Right", right: login });
  expect(asked).toEqual([]);
});

it("holds no login whose password the site rejected, and asks for a correction instead", async () => {
  const corrected = { ...login, password: "new-password" };
  const { base, asked } = owner([corrected]);
  const rejectable = makeRejectableLogin(base, (field) => new Error(`repeated ${field}`));
  rejectable.reject("password");
  expect(rejectable.login.held()).toBeUndefined();
  expect(await valuesOf(rejectable)).toMatchObject({ _tag: "Right", right: corrected });
  expect(asked).toEqual(["password"]);
  // The correction is the login now.
  expect(rejectable.login.held()).toEqual(corrected);
});

it("asks again once for a correction that repeats a rejected value, then refuses it", async () => {
  const { base, asked } = owner([login, { ...login, password: "new-password" }]);
  const rejectable = makeRejectableLogin(base, (field) => new Error(`repeated ${field}`));
  rejectable.reject("password");
  expect(await valuesOf(rejectable)).toMatchObject({
    _tag: "Right",
    right: { password: "new-password" },
  });
  expect(asked).toEqual(["password", "password"]);
  const stubborn = owner([login, login]);
  const refusing = makeRejectableLogin(stubborn.base, (field) => new Error(`repeated ${field}`));
  refusing.reject("password");
  const refused = await valuesOf(refusing);
  expect(refused._tag === "Left" && refused.left.message).toBe("repeated password");
  expect(stubborn.asked).toEqual(["password", "password"]);
});

it("withholds a rejected username with any password", async () => {
  const sameUser = { ...login, password: "other-password" };
  const { base, asked } = owner([sameUser, { username: "other@example.test", password: "p" }]);
  const rejectable = makeRejectableLogin(base, (field) => new Error(`repeated ${field}`));
  rejectable.reject("username");
  expect(rejectable.login.held()).toBeUndefined();
  expect(await valuesOf(rejectable)).toMatchObject({
    _tag: "Right",
    right: { username: "other@example.test" },
  });
  expect(asked).toEqual(["username", "username"]);
});

it("marks nothing for a field that is no part of the login", async () => {
  const { base, asked } = owner([]);
  const rejectable = makeRejectableLogin(base, (field) => new Error(`repeated ${field}`));
  // A caller that is not type-checked may still name a code.
  (rejectable.reject as (field: string) => void)("code");
  expect(rejectable.login.held()).toEqual(login);
  expect(await valuesOf(rejectable)).toMatchObject({ _tag: "Right", right: login });
  expect(asked).toEqual([]);
});
