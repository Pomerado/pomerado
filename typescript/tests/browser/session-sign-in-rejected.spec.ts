import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { InputRequestFailure, type InputRequest } from "../../src/runtime/input-request.js";
import { primaryPageCode } from "../../src/runtime/host-execute.js";
import { makeSession } from "../../src/standalone/session.js";
import { makeRunSignIn } from "../../src/standalone/session-sign-in.js";
import { shopSignIn } from "../support/session-sign-in-contract.js";
import { shopAccount, startShop } from "./shop-fixture.js";

// A login the site rejected during an automatic sign-in is never sent again by the next one: the
// next sign-in asks for a correction before it types anything.

const shopRecipe = (origin: string) => ({
  version: 1 as const,
  steps: [
    {
      page: `${origin}${shopSignIn.loginPath}`,
      fields: [
        { selector: shopSignIn.username, accepts: ["username" as const] },
        { selector: shopSignIn.password, slot: "password" as const },
      ],
      submit: shopSignIn.submit,
      submittedBy: "host" as const,
    },
  ],
  signedIn: { selector: shopSignIn.signedIn },
});

/**
 * Signs a run in from a signed-in browser with a login it never reads, then signs the shop out
 * twice and calls the script's sign-in after each. `password` answers each login question in
 * order, by its reason, or leaves it unanswered with `undefined`. Returns the questions' reasons,
 * the two answers and the login posts each sign-in sent.
 */
const signedOutTwice = async (
  password: (reason: string, nth: number) => string | undefined,
) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-sign-in-rejected-"));
  const shop = await startShop(directory);
  const server = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  const asked: string[] = [];
  const ask = makeInputAsker((request: InputRequest) =>
    Effect.suspend(() => {
      const question = request.questions[0];
      const reason = question?.type === "credential" ? question.reason : "other";
      asked.push(reason);
      const given = password(reason, asked.filter((seen) => seen === reason).length);
      if (given === undefined) return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
      return Effect.succeed({
        login: { username: shopAccount.username, password: given, saveLogin: false },
      });
    }),
  );
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            ask,
            browser: { endpoint: server.wsEndpoint() },
            policy: "Allow the controlled shop.",
          });
          const { browser } = session;
          const page = (code: string) =>
            browser.execute(`${primaryPageCode(browser.targetId)}\n${code}`, 30);
          // The browser starts signed in, and the shop sends a signed-in visit to its sign-in page
          // on to the account, so the run's own sign-in reads no login.
          yield* page(`await primary.goto(${JSON.stringify(`${shop.origin}/login`)});
await primary.fill("input[name=username]", ${JSON.stringify(shopAccount.username)});
await primary.fill("input[name=password]", ${JSON.stringify(shopAccount.password)});
await primary.click("button");
await primary.locator("#account").waitFor({ timeout: 10000 });`);
          shop.state.signedInLogin = "account";
          const signIn = makeRunSignIn(
            session,
            { recipe: shopRecipe(shop.origin), entryUrl: `${shop.origin}/login` },
            shop.origin,
            [],
          );
          yield* signIn.before;
          expect(asked).toEqual([]);
          const hook = signIn.hook();
          const bound = () => ({ untilMs: Date.now() + 120_000, stop: new AbortController().signal });
          yield* hook(bound());
          shop.state.signOutOn = "/orders";
          const answers: unknown[] = [];
          const posts: number[] = [];
          for (const _ of [1, 2]) {
            const postsBefore = shop.state.loginPosts;
            yield* page(`await primary.goto(${JSON.stringify(`${shop.origin}/orders`)});`);
            answers.push(yield* hook(bound()));
            posts.push(shop.state.loginPosts - postsBefore);
          }
          return { asked, answers, posts };
        }),
      ),
    );
  } finally {
    await server.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const wrong = `${shopAccount.password}-wrong`;

test("an automatic sign-in after one whose login the site rejected asks for a correction before it types", async () => {
  test.setTimeout(180_000);
  // The first login the run reads is wrong. The first correction goes unanswered, and the next
  // one gives the right password.
  const run = await signedOutTwice((reason, nth) =>
    reason === "missing_credentials" ? wrong : nth === 1 ? undefined : shopAccount.password,
  );
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "signed_in", signedInAgain: true },
  ]);
  // The wrong login goes out once. The next sign-in asks for the correction first and sends
  // only it.
  expect(run.posts).toEqual([1, 1]);
  expect(run.asked).toEqual(["missing_credentials", "invalid_credentials", "invalid_credentials"]);
});

test("a correction that repeats the login the site rejected is asked again before anything is typed", async () => {
  test.setTimeout(180_000);
  // As above, but the next sign-in's first correction gives the rejected password again.
  const run = await signedOutTwice((reason, nth) =>
    reason === "missing_credentials"
      ? wrong
      : nth === 1
        ? undefined
        : nth === 2
          ? wrong
          : shopAccount.password,
  );
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "signed_in", signedInAgain: true },
  ]);
  // The rejected password goes out only the first time.
  expect(run.posts).toEqual([1, 1]);
  expect(run.asked).toEqual([
    "missing_credentials",
    "invalid_credentials",
    "invalid_credentials",
    "invalid_credentials",
  ]);
});

test("corrections that keep repeating the login the site rejected refuse the sign-in, typing nothing", async () => {
  test.setTimeout(180_000);
  const run = await signedOutTwice((reason, nth) =>
    reason === "invalid_credentials" && nth === 1 ? undefined : wrong,
  );
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "refused", cause: "session_sign_in_failed" },
  ]);
  expect(run.posts).toEqual([1, 0]);
  expect(run.asked).toEqual([
    "missing_credentials",
    "invalid_credentials",
    "invalid_credentials",
    "invalid_credentials",
  ]);
});
