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

// A run's sign-in replayed from its screens on local Chromium, on a site that can't send a text:
// its code page shows a notice with OK over four code boxes. The sign-in that recorded the screens
// pressed OK, then More options, where the owner picked a phone call, and typed that code into the
// four boxes. A run that meets the same notice goes the same way, the owner picking the method
// again, and the site gets one call and one code.

const site = "https://rides.example.test";
const code = "4826";
const login = { username: "rider@rides.example.test", password: "synthetic-password" };

test.describe.configure({ timeout: 120_000 });

const boxes = [0, 1, 2, 3]
  .map((box) => `<input id="otp-${box}" name="otp${box}" maxlength="1" inputmode="numeric" aria-label="Code digit ${box + 1} of 4">`)
  .join("");

/**
 * The sign-in at /login: a text-message button; the code page, whose text the site can't send, so
 * a notice with OK covers it; More options, a sheet of other methods; and the same four boxes for
 * a code sent by a phone call, with Verify. Sends post to /api/send, codes to /api/code.
 */
const screen = `<main><h1 id="title">Welcome back. Sign in to your account:</h1><div id="boxes" hidden>${boxes}</div><div id="actions"><button id="sms" type="button">Send code via SMS</button></div></main>
<script>
const title = document.getElementById("title");
const actions = document.getElementById("actions");
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const show = (heading, buttons) => {
  title.textContent = heading;
  document.getElementById("boxes").hidden = false;
  actions.innerHTML = buttons;
};
const sheet = (html) => document.body.insertAdjacentHTML("beforeend", '<div id="sheet" role="dialog">' + html + "</div>");
document.addEventListener("click", async (event) => {
  const id = event.target.id;
  if (id === "sms") {
    await post("/api/send", { method: "sms" });
    show("Enter the 4-digit code sent via SMS", '<button id="more" type="button">More options</button><button id="next" type="button" disabled>Next</button>');
    sheet("<p>We couldn't send a text message. Try another way.</p><button id=\\"ok\\" type=\\"button\\">OK</button>");
  } else if (id === "ok" || id === "call") document.getElementById("sheet").remove();
  if (id === "more") sheet('<h2>More options</h2><button id="email" type="button">Email</button><button id="call" type="button">Phone call</button>');
  if (id === "call") {
    await post("/api/send", { method: "call" });
    show("Enter the 4-digit code sent via phone call", '<button id="verify" type="button">Verify</button>');
  }
  if (id === "verify") {
    const typed = [0, 1, 2, 3].map((box) => document.getElementById("otp-" + box).value).join("");
    if ((await post("/api/code", { code: typed })).ok) location.replace("/home");
  }
});
</script>`;

/**
 * The site, with each method a send asked for and each code posted, in order, and a reset that
 * clears them and signs the session out.
 */
const serve = async (page: Page) => {
  const sends: string[] = [];
  const codes: string[] = [];
  let signedIn = false;
  const reset = () => {
    sends.length = 0;
    codes.length = 0;
    signedIn = false;
  };
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = Object(JSON.parse(request.postData() ?? "{}"));
      if (path === "/api/send") sends.push(String(Reflect.get(body, "method")));
      if (path === "/api/code") codes.push(String(Reflect.get(body, "code")));
      signedIn ||= path === "/api/code" && Reflect.get(body, "code") === code;
      const refused = path === "/api/send" ? Reflect.get(body, "method") === "sms" : !signedIn;
      await route.fulfill({ status: refused ? 400 : 200, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: path === "/home" && signedIn ? '<p id="account">Your rides</p>' : screen,
    });
  });
  return { sends, codes, reset };
};

const press = (name: string) => `role=button[name="${name}" s]`;
const methods = {
  sms: { method: "sms", selector: press("Send code via SMS") },
  email: { method: "email", selector: press("Email") },
  call: { method: "call", selector: press("Phone call") },
} as const;

test("a code page whose text the site couldn't send goes on as recorded, to the owner's other method and its code", async ({
  page,
}) => {
  const { sends, codes, reset } = await serve(page);
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const observe = observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [] });
  // The recording: each screen noted as the page showed it, then its step taken by hand.
  await page.goto(`${site}/login`);
  const steps: AutofillRecipeStep[] = [
    { page: `${site}/login`, fields: [], submit: methods.sms.selector, methods: [methods.sms] },
    { page: `${site}/login`, fields: [], submit: press("OK") },
    { page: `${site}/login`, fields: [], submit: press("More options") },
    { page: `${site}/login`, fields: [], submit: methods.call.selector, methods: [methods.email, methods.call] },
    { page: `${site}/login`, fields: [0, 1, 2, 3].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })), submit: "#verify" },
  ];
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
  reset();
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
  expect(Either.isRight(ended) ? ended.right : ended.left).toEqual({ alreadySignedIn: false });
  expectNotCarried(host.calls, code);
  // The text went unsent; the owner picked the call from both methods, and its code went once.
  expect(asked).toEqual(["method: Text message", "method: Email, Phone call", "secret"]);
  expect(sends).toEqual(["sms", "call"]);
  expect(codes).toEqual([code]);
});
