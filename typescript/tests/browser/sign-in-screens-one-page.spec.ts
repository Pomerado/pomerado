import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose recorded screens all show at one address, as one set that holds what
// different logins see there: the replay tells which recorded screen shows by the controls it
// shows and the controls of the screen it waited for that are gone.

const site = "https://app.example.test";
const host = "app.example.test";
const code = "246810";
const login = { username: "owner@app.example.test", password: "synthetic-password" };
// Several screens' waits, the marker's waits and a code: more than the default 30 s allows on a
// busy machine.
test.describe.configure({ timeout: 180_000 });

const form = (screen: string, body: string) =>
  `<form method="post" action="/login"><input type="hidden" name="screen" value="${screen}">${body}</form>`;

/** Each screen the site shows at /login. */
const screens: Readonly<Record<string, string>> = {
  both: form(
    "both",
    '<label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="guided-submit">Sign in</button>',
  ),
  continue: form("continue", '<p>One more step.</p><button id="continue">Continue to sign in</button>'),
  code: form(
    "code",
    '<label>Code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label><button id="verify">Verify</button>',
  ),
  password: form(
    "password",
    '<label>Password<input id="password" name="password" type="password"></label><button id="login-submit">Sign in</button>',
  ),
};

/**
 * The site: each screen of `flow` in turn at /login, each submit going on to the next, then the
 * account. It keeps each screen it was sent from, with the values sent.
 */
const serve = async (page: Page, flow: readonly string[]) => {
  const sent: string[] = [];
  let at = 0;
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const values = new URLSearchParams(request.postData() ?? "");
      sent.push(
        [values.get("screen"), values.get("email"), values.get("password"), values.get("code")]
          .filter((value) => value !== null)
          .join(" "),
      );
      at += 1;
      const next = at < flow.length ? "/login" : "/account";
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next)})</script>` });
    } else
      await route.fulfill({
        contentType: "text/html",
        body:
          new URL(request.url()).pathname === "/login"
            ? (screens[flow[at] ?? ""] ?? "")
            : '<p id="account">Signed in</p>',
      });
  });
  return sent;
};

const page = `${site}/login`;
const recorded = {
  both: {
    page,
    fields: [
      { selector: "#email", accepts: ["email"] },
      { selector: "#password", slot: "password" },
    ],
    submit: "#guided-submit",
    submittedBy: "host",
  },
  continue: { page, fields: [], submit: "#continue", submittedBy: "host" },
  code: { page, fields: [{ selector: "#code", slot: "code" }], submit: "#verify", submittedBy: "host" },
  password: {
    page,
    fields: [{ selector: "#password", slot: "password" }],
    submit: "#login-submit",
    submittedBy: "host",
    refills: ["password"],
  },
} as const;

type Recipe = Parameters<typeof signInForRun>[0]["recipe"];
const recipeOf = (...steps: (keyof typeof recorded)[]): Recipe =>
  ({ version: 14, steps: steps.map((step) => recorded[step]), signedIn: { selector: "#account" } }) as Recipe;

/** One run's sign-in with `recipe`, answering the login ask and each code ask. */
const run = async (browserPage: Page, recipe: Recipe) => {
  const browser = await hostPage(browserPage);
  const { keyboard } = await hostKeyboard(browserPage);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : "code");
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: page,
        browser: makeSignInBrowser({
          page: browser,
          keyboard,
          siteOrigin: site,
          authenticationOrigins: [],
          typing: { typed: false },
        }),
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  for (const value of [code, login.password]) expectNotCarried(browser.calls, value);
  const ended = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { ended, prompts };
};

const signedIn = { signedIn: true, alreadySignedIn: false };
const sends: Readonly<Record<string, string>> = {
  both: `both ${login.username} ${login.password}`,
  continue: "continue",
  code: `code ${code}`,
  password: `password ${login.password}`,
};

// One set that holds two logins' screens after the same button-only screen: a code for one, the
// password again for the other, with the screen added last as a merge of the second login's
// screens adds it.
const both = recipeOf("both", "continue", "code", "password");

for (const [name, recipe, flow] of [
  ["one login takes the code after the button-only screen", both, ["both", "continue", "code"]],
  ["another takes the password again after it", both, ["both", "continue", "password"]],
  ["a login the site shows no button-only screen goes on to the password", both, ["both", "password"]],
  ["a login whose email the site keeps starts at the password alone", both, ["password"]],
  [
    "a set that holds the password before the button-only screen goes on to the button",
    recipeOf("both", "password", "continue", "code"),
    ["both", "continue", "code"],
  ],
] as const)
  test(`a run whose sign-in screens share one page: ${name}`, async ({ page: browserPage }) => {
    const shown: readonly string[] = flow;
    const sent = await serve(browserPage, shown);
    const { ended, prompts } = await run(browserPage, recipe);
    expect(ended).toEqual(signedIn);
    expect(prompts).toEqual(shown.includes("code") ? ["login", "code"] : ["login"]);
    expect(sent).toEqual(shown.map((screen) => sends[screen]));
    await expect(browserPage.locator("#account")).toBeVisible();
  });

test("a run whose password screen comes back whole after its submit ends as that screen returned", async ({
  page: browserPage,
}) => {
  const sent = await serve(browserPage, ["both", "continue", "password", "password"]);
  const { ended } = await run(browserPage, both);
  expect(ended).toMatchObject({ reason: "credential_screen_returned" });
  expect(sent).toEqual([sends["both"], "continue", sends["password"]]);
});
