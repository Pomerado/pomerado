import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import type { SignInLogin } from "../../src/destinations/sign-in-recipe.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose site shows the recorded screens in another order than the recipe holds
// them, or shows a screen recorded after the others before them. The replay tries the next
// recorded screen first, as always, and only where that one never shows acts on another recorded
// screen the page shows, an earlier one included.

const site = "https://app.example.test";
const host = "app.example.test";
const code = "246810";
const login = { username: "owner@app.example.test", password: "synthetic-password" };
// A sign-in screen, several recorded screens' waits, the marker's waits and a code: more than the
// default 30 s allows on a busy machine.
test.describe.configure({ timeout: 180_000 });

/** Each screen at its own path, each sending its one value as `value`. */
const screens: Readonly<Record<string, string>> = {
  "/login":
    '<form method="post" action="/login"><label>Email<input id="email" name="value"></label><button id="next">Next</button></form>',
  "/password":
    '<form method="post" action="/password"><label>Password<input id="password" name="value" type="password"></label><button id="continue">Continue</button></form>',
  "/verify":
    '<form method="post" action="/verify"><label>Code<input id="code" name="value" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label><button id="verify">Verify</button></form>',
  "/confirm":
    '<form method="post" action="/confirm"><p>Keep this browser signed in?</p><input type="hidden" name="value" value="kept"><button id="keep">Continue</button></form>',
  "/ways":
    '<form method="post" action="/ways"><button id="with-password" name="value" value="/password">Use your password</button><button id="with-email" name="value" value="/verify">Email me a code</button></form>',
};

/**
 * The site: the email screen at /login, then each screen of `flow` in turn, then the account. A
 * way choice at /ways goes on to the screen its button names, and that screen to the account. It
 * keeps each value a screen sends, by the screen's path.
 */
const serve = async (page: Page, flow: readonly string[]) => {
  const sent: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const value = new URLSearchParams(request.postData() ?? "").get("value") ?? "";
      sent.push(`${path} ${value}`);
      const at = path === "/login" ? 0 : flow.includes(path) ? flow.indexOf(path) + 1 : flow.length;
      const next = path === "/ways" ? value : (flow[at] ?? "/account");
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next)})</script>` });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: screens[path] ?? '<p id="account">Signed in</p>',
      });
  });
  return sent;
};

const recorded = {
  email: { page: `${site}/login`, fields: [{ selector: "#email", accepts: ["email"] }], submit: "#next", submittedBy: "host" },
  password: { page: `${site}/password`, fields: [{ selector: "#password", slot: "password" }], submit: "#continue", submittedBy: "host" },
  code: { page: `${site}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify", submittedBy: "host" },
  confirm: { page: `${site}/confirm`, fields: [], submit: "#keep", submittedBy: "host" },
  ways: {
    page: `${site}/ways`,
    fields: [],
    submit: "#with-password",
    methods: [
      { method: "password", selector: "#with-password" },
      { method: "email", selector: "#with-email" },
    ],
  },
} as const;

type Recipe = NonNullable<Parameters<typeof signInForRun>[0]["recipe"]>;
const recipeOf = (...steps: (keyof typeof recorded)[]): Recipe =>
  ({ version: 14, steps: steps.map((step) => recorded[step]), signedIn: { selector: "#account" } }) as Recipe;

/** A login that holds no password, as one that signs in with a code does. */
const codeLogin: SignInLogin<unknown> = {
  held: () => undefined,
  values: Effect.succeed({ username: login.username }),
  correct: () => Effect.die("the login takes no correction"),
};

/** One run's sign-in with `recipe`, answering the login ask and each code ask. */
const run = async (page: Page, recipe: Recipe, given?: SignInLogin<unknown>) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : (question?.prompt ?? ""));
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: makeSignInBrowser({
          page: browser,
          keyboard,
          siteOrigin: site,
          authenticationOrigins: [],
          typing: { typed: false },
        }),
        login: given ?? localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  for (const value of [code, login.password]) expectNotCarried(browser.calls, value);
  // How the sign-in ended, as the run reads it.
  const ended = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { ended, prompts };
};

const codePrompt = `Enter the sign-in code ${host} sent you.`;
const signedIn = { signedIn: true, alreadySignedIn: false };

test("a run signs in when the site shows the recorded password and code screens the other way round", async ({
  page,
}) => {
  const sent = await serve(page, ["/verify", "/password"]);
  const { ended, prompts } = await run(page, recipeOf("email", "password", "code"));
  expect(ended).toEqual(signedIn);
  expect(prompts).toEqual(["login", codePrompt]);
  expect(sent).toEqual([`/login ${login.username}`, `/verify ${code}`, `/password ${login.password}`]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a run goes back to a recorded screen the site shows late, then on to the recorded screens after it", async ({
  page,
}) => {
  const sent = await serve(page, ["/verify", "/password", "/confirm"]);
  const { ended, prompts } = await run(page, recipeOf("email", "password", "code", "confirm"));
  expect(ended).toEqual(signedIn);
  expect(prompts).toEqual(["login", codePrompt]);
  expect(sent).toEqual([
    `/login ${login.username}`,
    `/verify ${code}`,
    `/password ${login.password}`,
    "/confirm kept",
  ]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a run signs in when the site shows a screen recorded after the others between two of them", async ({
  page,
}) => {
  const sent = await serve(page, ["/confirm", "/password"]);
  const { ended, prompts } = await run(page, recipeOf("email", "password", "confirm"));
  expect(ended).toEqual(signedIn);
  expect(prompts).toEqual(["login"]);
  expect(sent).toEqual([`/login ${login.username}`, "/confirm kept", `/password ${login.password}`]);
  await expect(page.locator("#account")).toBeVisible();
});

/** What each screen sends. */
const sends: Readonly<Record<string, string>> = {
  "/password": `/password ${login.password}`,
  "/verify": `/verify ${code}`,
  "/confirm": "/confirm kept",
};

for (const [order, recipe, flow] of [
  ["password then code", recipeOf("email", "password", "code"), ["/password", "/verify"]],
  ["code then password", recipeOf("email", "code", "password"), ["/verify", "/password"]],
  ["one screen more", recipeOf("email", "password", "confirm"), ["/password", "/confirm"]],
] as const)
  test(`a run whose site shows its recorded screens in order (${order}) walks them as recorded`, async ({
    page,
  }) => {
    const shown: readonly string[] = flow;
    const sent = await serve(page, shown);
    const { ended, prompts } = await run(page, recipe);
    expect(ended).toEqual(signedIn);
    expect(prompts).toEqual(shown.includes("/verify") ? ["login", codePrompt] : ["login"]);
    expect(sent).toEqual([`/login ${login.username}`, ...shown.map((path) => sends[path])]);
  });

test("a login with no password picks the code at a choice recorded with the password, and signs in on the recorded code screen", async ({
  page,
}) => {
  const sent = await serve(page, ["/ways"]);
  const { ended, prompts } = await run(page, recipeOf("email", "ways", "password", "code"), codeLogin);
  expect(ended).toEqual(signedIn);
  expect(prompts).toEqual([codePrompt]);
  expect(sent).toEqual([`/login ${login.username}`, "/ways /verify", `/verify ${code}`]);
});

test("a login with a password still takes the password at that choice", async ({ page }) => {
  const sent = await serve(page, ["/ways"]);
  const { ended, prompts } = await run(page, recipeOf("email", "ways", "password", "code"));
  expect(ended).toEqual(signedIn);
  expect(prompts).toEqual(["login"]);
  expect(sent).toEqual([`/login ${login.username}`, "/ways /password", `/password ${login.password}`]);
});
