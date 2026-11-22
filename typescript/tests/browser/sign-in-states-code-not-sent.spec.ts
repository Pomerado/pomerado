import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import {
  appendSignInStates,
  noteSignInState,
  observedSignInOf,
  signInStatesOf,
} from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in replayed from its screens on local Chromium. The sign-in that recorded them met a
// site that couldn't send a text: its code page showed a notice with OK over four code boxes. It
// pressed OK, then More options, where the owner picked a phone call, and typed that code into the
// four boxes. A run that meets the same notice goes the same way, the owner picking the method
// again. A run whose text the site did send types that code into the same four boxes and presses
// nothing else.

const site = "https://rides.example.test";
const code = "4826";
const login = { username: "rider@rides.example.test", password: "synthetic-password" };

test.describe.configure({ timeout: 120_000 });

const boxes = [0, 1, 2, 3]
  .map((box) => `<input id="otp-${box}" name="otp${box}" maxlength="1" inputmode="numeric" aria-label="Code digit ${box + 1} of 4">`)
  .join("");

/**
 * The sign-in at /login: a text-message button; the code page, with a notice with OK over it when
 * the site couldn't send the text; More options, a sheet of other methods; and the same four boxes
 * for a code sent by a phone call. Each code page has Verify. Sends post to /api/send, codes to
 * /api/code.
 */
const screen = `<main><h1 id="title">Welcome back. Sign in to your account:</h1><div id="boxes" hidden>${boxes}</div><div id="actions"><button id="sms" type="button">Send code via SMS</button></div></main>
<script>
const title = document.getElementById("title");
const actions = document.getElementById("actions");
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const show = (heading, buttons) => {
  title.textContent = heading;
  document.getElementById("boxes").hidden = false;
  actions.innerHTML = buttons + '<button id="verify" type="button">Verify</button>';
};
const sheet = (html) => document.body.insertAdjacentHTML("beforeend", '<div id="sheet" role="dialog">' + html + "</div>");
document.addEventListener("click", async (event) => {
  const id = event.target.id;
  if (id === "sms") {
    const sent = (await post("/api/send", { method: "sms" })).ok;
    show("Enter the 4-digit code sent via SMS", '<button id="more" type="button">More options</button>');
    if (!sent) sheet("<p>We couldn't send a text message. Try another way.</p><button id=\\"ok\\" type=\\"button\\">OK</button>");
  } else if (id === "ok" || id === "call") document.getElementById("sheet").remove();
  if (id === "more") sheet('<h2>More options</h2><button id="email" type="button">Email</button><button id="call" type="button">Phone call</button>');
  if (id === "call") {
    await post("/api/send", { method: "call" });
    show("Enter the 4-digit code sent via phone call", "");
  }
  if (id === "verify") {
    const typed = [0, 1, 2, 3].map((box) => document.getElementById("otp-" + box).value).join("");
    if ((await post("/api/code", { code: typed })).ok) location.replace("/home");
  }
});
</script>`;

/**
 * The site, with each method a send asked for and each code posted, in order. It can't send a text
 * until `texts` is set.
 */
const serve = async (page: Page) => {
  const served = { sends: [] as string[], codes: [] as string[], texts: false, signedIn: false };
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = Object(JSON.parse(request.postData() ?? "{}"));
      if (path === "/api/send") served.sends.push(String(Reflect.get(body, "method")));
      if (path === "/api/code") served.codes.push(String(Reflect.get(body, "code")));
      served.signedIn ||= path === "/api/code" && Reflect.get(body, "code") === code;
      const refused = path === "/api/send" ? Reflect.get(body, "method") === "sms" && !served.texts : !served.signedIn;
      await route.fulfill({ status: refused ? 400 : 200, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: path === "/home" && served.signedIn ? '<p id="account">Your rides</p>' : screen,
    });
  });
  return served;
};

const press = (name: string) => `role=button[name="${name}" s]`;
const methods = {
  sms: { method: "sms", selector: press("Send code via SMS") },
  email: { method: "email", selector: press("Email") },
  call: { method: "call", selector: press("Phone call") },
} as const;
const steps: AutofillRecipeStep[] = [
  { page: `${site}/login`, fields: [], submit: methods.sms.selector, methods: [methods.sms] },
  { page: `${site}/login`, fields: [], submit: press("OK") },
  { page: `${site}/login`, fields: [], submit: press("More options") },
  { page: `${site}/login`, fields: [], submit: methods.call.selector, methods: [methods.email, methods.call] },
  { page: `${site}/login`, fields: [0, 1, 2, 3].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })), submit: "#verify" },
];

/**
 * Records the sign-in on a site that can't send a text, each screen noted as the page showed it
 * and its step then taken by hand, then replays it from its screens once the site's `texts` are
 * set as given: the outcome, the questions asked, and the site's sends and codes in the replay.
 */
const recordThenSignIn = async (page: Page, texts: boolean) => {
  const served = await serve(page);
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const observe = observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [] });
  await page.goto(`${site}/login`);
  const signIn = { steps: [] as object[] };
  for (const [index, step] of steps.entries()) {
    await expect(page.locator(step.submit ?? "body")).toBeVisible();
    const read = await Effect.runPromise(observe);
    if (read === undefined) throw new Error("The scan read nothing");
    signIn.steps.push({ ...step });
    noteSignInState(signIn, read);
    if (index === steps.length - 1) for (const [at, digit] of [...code].entries()) await page.fill(`#otp-${at}`, digit);
    await page.locator(step.submit ?? "").click();
  }
  await expect(page.locator("#account")).toBeVisible();
  const observed = observedSignInOf(signIn.steps, { steps, signedIn: { selector: "#account" } });
  if ("missingFingerprint" in observed) throw new Error(`No note at step ${observed.missingFingerprint}`);
  const appended = appendSignInStates(signInStatesOf({}, []), observed);
  if ("refused" in appended) throw new Error(appended.refused);
  Object.assign(served, { sends: [], codes: [], texts, signedIn: false });
  await page.goto("about:blank");

  const asked: string[] = [];
  const secrets = makeRunSecrets();
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const [question] = request.questions;
      if (question?.type === "credential") return { [question.id]: { ...login, saveLogin: false } };
      if (question?.type === "choice") {
        asked.push(`${question.id}: ${question.options.map((option) => option.label).join(", ")}`);
        const picked = question.options.find((option) => option.label !== "Email");
        return { [question.id]: picked?.id ?? "" };
      }
      asked.push(question?.type ?? "none");
      return { [question?.id ?? "code"]: code };
    }),
  );
  const browser = makeSignInBrowser({ page: host, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  const ended = await Effect.runPromise(
    Effect.either(
      signInForRun({
        states: appended.library,
        entryUrl: `${site}/login`,
        browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: "rides.example.test",
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expectNotCarried(host.calls, code);
  return { ended: Either.isRight(ended) ? ended.right : ended.left, asked, sends: served.sends, codes: served.codes };
};

test("a code page whose text the site couldn't send goes on as recorded, to the owner's other method and its code", async ({
  page,
}) => {
  expect(await recordThenSignIn(page, false)).toEqual({
    ended: { alreadySignedIn: false },
    // The owner picked the call from both methods, and its code went once.
    asked: ["method: Text message", "method: Email, Phone call", "secret"],
    sends: ["sms", "call"],
    codes: [code],
  });
});

test("a code page whose text the site did send gets that code in its boxes, and nothing else is pressed", async ({ page }) => {
  expect(await recordThenSignIn(page, true)).toEqual({
    ended: { alreadySignedIn: false },
    asked: ["method: Text message", "secret"],
    sends: ["sms"],
    codes: [code],
  });
});
