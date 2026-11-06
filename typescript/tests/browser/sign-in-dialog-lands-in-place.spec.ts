import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A read's sign-in in a dialog on the site's home page: a Sign in button, the email, a code, then
// a "remember this device" screen the build met once. This time the site takes the code, signs in
// and closes the dialog without that screen. The page never leaves its address, and the recorded
// marker shows only on the account page, so no address change and no marker can end the wait for
// the missing screen.

const site = "https://site.example.test";
const host = "site.example.test";
const code = "246810";
const login = { username: "owner@site.example.test", password: "synthetic-password" };
// Two replays, a code screen and the wait for the missing screen: more than the default 30 s
// allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

/**
 * The home page and its dialog. The code screen's Verify sends the code: an accepted one closes
 * the dialog and the Sign in button, and a refused one shows the code screen again, empty, with an
 * error that is no recorded marker. Nothing loads a new document.
 */
const home = `<main id="home"><h1>Home</h1><button id="open" type="button">Sign in</button></main>
<div id="dialog" role="dialog" hidden></div>
<script>
const dialog = document.getElementById("dialog");
const post = (path, value) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
const codeScreen = (error) => {
  dialog.innerHTML = (error ? "<p>That code did not work</p>" : "") + '<label>Code<input id="otc" name="otc" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label><button id="verify" type="button">Verify</button>';
  document.getElementById("verify").addEventListener("click", async () => {
    if (!(await post("/api/code", document.getElementById("otc").value)).ok) return codeScreen(true);
    dialog.remove();
    document.getElementById("home").innerHTML = "<h1>Home</h1><p>Welcome back</p>";
  });
};
document.getElementById("open").addEventListener("click", () => {
  dialog.hidden = false;
  dialog.innerHTML = '<label>Email<input id="email" name="email" type="email"></label><button id="continue" type="button">Continue</button>';
  document.getElementById("continue").addEventListener("click", async () => {
    if ((await post("/api/email", document.getElementById("email").value)).ok) codeScreen(false);
  });
});
</script>`;

/**
 * The site: the home page at every path but the account page, which shows the account once a code
 * was accepted. It keeps each value the dialog sends, by its path, and accepts the code when
 * `accepts`.
 */
const serve = async (page: Page, accepts: boolean) => {
  const state = { signedIn: false, sent: [] as string[] };
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/api/")) {
      state.sent.push(path);
      const ok = path !== "/api/code" || accepts;
      if (path === "/api/code" && ok) state.signedIn = true;
      await route.fulfill({ status: ok ? 200 : 401, contentType: "application/json", body: "{}" });
    } else if (path === "/account")
      await route.fulfill({
        contentType: "text/html",
        body: state.signedIn ? `<p id="account">${login.username}</p>` : "<p>Please sign in</p>",
      });
    else await route.fulfill({ contentType: "text/html", body: home });
  });
  return state;
};

/** The recipe the build recorded: every screen on the home page, and the marker on the account's. */
const recipe = {
  version: 2,
  steps: [
    { page: `${site}/`, fields: [], submit: "#open", submittedBy: "host" },
    {
      page: `${site}/`,
      fields: [{ selector: "#email", accepts: ["email"] }],
      submit: "#continue",
      submittedBy: "host",
    },
    {
      page: `${site}/`,
      fields: [{ selector: "#otc", slot: "code" }],
      submit: "#verify",
      submittedBy: "host",
    },
    { page: `${site}/`, fields: [], submit: "#remember", submittedBy: "host" },
  ],
  signedIn: { selector: "#account" },
} as const;

/** One read's sign-in, answering the login ask and each code ask. */
const run = async (page: Page) => {
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
        entryUrl: `${site}/`,
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
        allowCantTell: true,
      }),
    ),
  );
  expectNotCarried(browser.calls, code);
  // How the sign-in ended, as the run reads it.
  const ended = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { ended, prompts };
};

const codePrompt = `Enter the sign-in code ${host} sent you.`;

test("a read's sign-in in a dialog that signs in after the code without its recorded later screen ends as can't tell on the same page, and the read goes on", async ({
  page,
}) => {
  const state = await serve(page, true);
  const { ended, prompts } = await run(page);
  expect(ended).toEqual({ signedIn: true, alreadySignedIn: false });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(state.sent).toEqual(["/api/email", "/api/code"]);
  // The read runs on the signed-in session.
  await page.goto(`${site}/account`);
  await expect(page.locator("#account")).toHaveText(login.username);
});

test("a read's sign-in in a dialog whose code is refused in place, the code box showing again, still ends on the missing screen", async ({
  page,
}) => {
  const state = await serve(page, false);
  const { ended, prompts } = await run(page);
  expect(ended).toEqual({ code: "RecipeFailed", reason: "not_found" });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(state.sent).toEqual(["/api/email", "/api/code"]);
});
