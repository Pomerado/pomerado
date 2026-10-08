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

test("an automatic sign-in after one whose login the site rejected asks for a correction before it types", async () => {
  test.setTimeout(180_000);
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
  let corrections = 0;
  // The first login the run reads is wrong. The first correction goes unanswered, and the next
  // one gives the right password.
  const ask = makeInputAsker((request: InputRequest) =>
    Effect.suspend(() => {
      const question = request.questions[0];
      const reason = question?.type === "credential" ? question.reason : "other";
      asked.push(reason);
      if (reason === "invalid_credentials" && corrections++ === 0)
        return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
      return Effect.succeed({
        login: {
          username: shopAccount.username,
          password:
            reason === "missing_credentials" ? `${shopAccount.password}-wrong` : shopAccount.password,
          saveLogin: false,
        },
      });
    }),
  );
  try {
    await Effect.runPromise(
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
          const signedOut = () => {
            shop.state.signOutOn = "/orders";
            return page(`await primary.goto(${JSON.stringify(`${shop.origin}/orders`)});`);
          };
          const postsBefore = shop.state.loginPosts;
          // Signed out: the wrong login goes out once, and its correction goes unanswered.
          yield* signedOut();
          expect(yield* hook(bound())).toEqual({ outcome: "refused", cause: "session_sign_in_failed" });
          expect(shop.state.loginPosts).toBe(postsBefore + 1);
          // Still signed out: the next sign-in asks for the correction first and sends only it.
          yield* page(`await primary.goto(${JSON.stringify(`${shop.origin}/orders`)});`);
          expect(yield* hook(bound())).toEqual({ outcome: "signed_in", signedInAgain: true });
          expect(shop.state.loginPosts).toBe(postsBefore + 2);
          expect(asked).toEqual(["missing_credentials", "invalid_credentials", "invalid_credentials"]);
        }),
      ),
    );
  } finally {
    await server.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
