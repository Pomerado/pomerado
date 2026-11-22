import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillStepReport } from "../../src/destinations/autofill-step.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { typedValues } from "../../src/runtime/autofill-values.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose recorded code screen has six one-digit boxes and a Verify button, but whose
// own script sends the code as the sixth box takes its digit, with no new document. The site takes
// a code once: a second check of it answers that the code expired and signs the session out. So the
// host must not click Verify after the page sent the code itself, nor, for the same boxes in a form
// with no Verify, press Enter after them while the site still checks the code.

const site = "https://site.example.test";
const host = "site.example.test";
const code = "246810";
const login = { username: "owner@site.example.test", password: "synthetic-password" };
// Six boxes filled one focus and one key at a time, the host's looks and the marker's wait:
// more than the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

const boxes = [1, 2, 3, 4, 5, 6]
  .map(
    (box) =>
      `<input id="otp-${box}" name="d${box}" class="otp" maxlength="1" inputmode="numeric" aria-label="Digit ${box}"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`,
  )
  .join("");

/**
 * The code screen: six boxes and a Verify button, or, `inForm`, the boxes alone in a form. The
 * sixth digit sends the code once, and so does each click of Verify, which is counted, and each
 * Enter in a box. An accepted code puts the account in place of the screen, or of the form, which
 * hides; an expired one signs the session out. Each box's key downs are kept, with whether each
 * was trusted.
 */
const codeScreen = (inForm: boolean) => `<main id="view"><p>Enter the code we sent you</p>${inForm ? `<form>${boxes}</form>` : `${boxes}<button id="verify" type="button">Verify</button>`}</main>
<script>
const view = document.getElementById("view");
const boxes = [...document.querySelectorAll(".otp")];
const typed = () => boxes.map((box) => box.value).join("");
window.clicks = 0;
window.keys = [];
let sent = false;
const check = () =>
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed() }) })
    .then((response) => {
      const form = document.querySelector("form");
      // A form hides itself and shows the account below it, its boxes left in the document.
      if (response.ok && form !== null) {
        form.hidden = true;
        view.insertAdjacentHTML("beforeend", '<p id="account">Signed in</p>');
      } else view.innerHTML = response.ok ? '<p id="account">Signed in</p>' : '<p id="signed-out">Your code expired</p>';
    });
boxes.forEach((box, index) => box.addEventListener("keydown", (event) => {
  window.keys.push({ box: index + 1, key: event.key, trusted: event.isTrusted });
  if (event.key === "Enter") check();
}));
boxes.forEach((box, index) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[index + 1]) boxes[index + 1].focus();
  if (sent || !/^[0-9]{6}$/.test(typed())) return;
  sent = true;
  check();
}));
document.getElementById("verify")?.addEventListener("click", () => {
  window.clicks += 1;
  check();
});
</script>`;

/**
 * A code screen with one code box in no form and no submit, beside a button that asks for a new
 * code. Its script sends the box's code on each of `sendsOn` in the box until the site answered,
 * never guarding against a second send while the site checks it: the input of its last digit, an
 * Enter, or the focus leaving it. The site's answer puts the account in place of the screen, which
 * takes the focus from the box. The keys pressed in the box are kept.
 */
const loneBox = (sendsOn: readonly ("input" | "Enter" | "blur")[]) => `<main id="view"><p>Enter the code we sent you</p>
<input id="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" aria-label="Verification code">
<button id="resend" type="button">Request a new code</button></main>
<script>
const box = document.getElementById("code");
const sendsOn = ${JSON.stringify(sendsOn)};
window.keys = [];
let answered = false;
const check = () =>
  !answered &&
  /^[0-9]{6}$/.test(box.value) &&
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: box.value }) })
    .then((response) => {
      answered = true;
      document.getElementById("view").innerHTML = response.ok ? '<p id="account">Signed in</p>' : '<p id="signed-out">Your code expired</p>';
    });
box.addEventListener("keydown", (event) => {
  window.keys.push(event.key);
  if (event.key === "Enter" && sendsOn.includes("Enter")) check();
});
for (const kind of ["input", "blur"]) box.addEventListener(kind, () => sendsOn.includes(kind) && check());
</script>`;

/**
 * The site: the code screen at /verify, `screen` or the six boxes. It keeps each code check and
 * answers it `checkMs` later, the first as accepted and any later one as expired.
 */
const serve = async (page: Page, { inForm = false, checkMs = 600, screen = codeScreen(inForm) } = {}) => {
  const checks: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/code") {
      const body: unknown = JSON.parse(request.postData() ?? "{}");
      const value: unknown = Reflect.get(Object(body), "code");
      checks.push(typeof value === "string" ? value : "");
      const first = checks.length === 1;
      await new Promise((resolve) => setTimeout(resolve, checkMs));
      await route.fulfill({
        status: first ? 200 : 401,
        contentType: "application/json",
        body: "{}",
      });
    } else await route.fulfill({ contentType: "text/html", body: screen });
  });
  return checks;
};

/** The recipe the build recorded: one code screen, its six boxes and its Verify button. */
const recipe = {
  version: 2,
  steps: [
    {
      page: `${site}/verify`,
      fields: [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })),
      submit: "#verify",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/** One run's sign-in, answering each code ask, with every fill's report. */
const run = async (page: Page) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const reports: AutofillStepReport[] = [];
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/verify`,
        browser: {
          ...signIn,
          fill: (input) => signIn.fill(input).pipe(Effect.tap((report) => reports.push(report))),
        },
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expectNotCarried(browser.calls, code);
  const ended = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { ended, reports };
};

test("a run signs in through six code boxes that send the code themselves, and never clicks Verify after them", async ({
  page,
}) => {
  const checks = await serve(page);
  const { ended, reports } = await run(page);
  expect(ended).toEqual({ signedIn: true, alreadySignedIn: false });
  expect(checks).toEqual([code]);
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(0);
  // The local host types by keyboard: each digit went into its own box as one trusted key.
  expect(await page.evaluate(() => Reflect.get(window, "keys"))).toEqual(
    Array.from(code, (key, at) => ({ box: at + 1, key, trusted: true })),
  );
  await expect(page.locator("#account")).toBeVisible();
  // The host clicked nothing and found the code screen closed in place, and the sign-in's own
  // check found the account, so the replay counted the screen as sent by the page.
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    outcome: "filled",
    fields: recipe.steps[0].fields.map(() => ({ slot: "code", status: "filled" })),
    closedInPlace: true,
  });
  expect(reports[0]).not.toHaveProperty("clicked");
  expect(JSON.stringify(reports)).not.toContain(code);
});

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

/**
 * A sign-in of the screen as one recorded state with no submit, typing `fields`, on a host that
 * presses Enter after typing such a state (`resubmit`) and reads the tab's own requests for a code
 * the page sent (`codeSent`).
 */
const runStates = async (
  page: Page,
  fields: readonly { readonly selector: string; readonly slot: "code" }[] = recipe.steps[0].fields,
) => {
  await page.goto(`${site}/verify`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const signIn = makeSignInBrowser({ page: browser, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  const observe = observeSignInState({ page: browser, siteOrigin: site, authenticationOrigins: [] });
  const scanned = await Effect.runPromise(observe);
  if (scanned === undefined) throw new Error("The scan read nothing");
  const recorded = appendSignInStates(signInStatesOf({}, []), {
    states: [{ fingerprint: scanned.fingerprint, step: { page: `${site}/verify`, fields } }],
    signedIn: recipe.signedIn,
  });
  if ("refused" in recorded) throw new Error(recorded.refused);
  const requests: { readonly at: number; readonly body: string }[] = [];
  page.on("request", (request) => requests.push({ at: Date.now(), body: request.postData() ?? "" }));
  const codeSent = (typed: { readonly since: number; readonly code: string }) =>
    Effect.succeed(requests.some(({ at, body }) => at >= typed.since && body.includes(JSON.stringify(typed.code))));
  const failed = (code: string) => () => new TestFailure({ code });
  const hooks: AutofillHooks<TestFailure> = {
    inspect: signIn.inspect,
    fill: (input) => {
      const filling = { ...input, values: typedValues(input.step, input.values), codeSent };
      return signIn.fill(filling);
    },
    ...(signIn.resubmit === undefined ? {} : { resubmit: signIn.resubmit }),
    check: (indicator, screens, challengeScreens) => signIn.confirm(indicator, screens, challengeScreens ?? screens),
    confirm: (indicator, _identifiers, screens, challengeScreens) =>
      signIn.confirm(indicator, screens, challengeScreens ?? screens),
    open: (url) => signIn.open(url).pipe(Effect.mapError(failed("open"))),
    markerVisible: (selector, screenPage, popup) =>
      signIn.markerVisible(selector, screenPage, popup).pipe(Effect.mapError(failed("marker"))),
  };
  const ended = await Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library: recorded.library,
        observe,
        hooks,
        entryUrl: `${site}/verify`,
        credentials: login,
        ask: makeInputAsker((request) => Effect.succeed({ [request.questions[0]?.id ?? "code"]: code })),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: host,
        correlation: undefined,
        emit: () => Effect.void,
        failures: { unanswered: failed("unanswered"), unavailable: failed("unavailable") },
        timing: { stepWaitMs: 15_000, pollMs: 250 },
        sent: { current: false },
      }),
    ),
  );
  expectNotCarried(browser.calls, code);
  return Either.isRight(ended) ? ended.right.outcome : ended.left.code;
};

test("a recorded code state with no submit, whose boxes send the code while the site checks it, gets the code once and no Enter", async ({
  page,
}) => {
  // The site takes 9 s to check, longer than the host waits before an Enter after typing.
  const checks = await serve(page, { inForm: true, checkMs: 9_000 });
  expect(await runStates(page)).toBe("signed_in");
  expect(checks).toEqual([code]);
  expect(await page.evaluate(() => Reflect.get(window, "keys"))).toEqual(
    Array.from(code, (key, at) => ({ box: at + 1, key, trusted: true })),
  );
  await expect(page.locator("#account")).toBeVisible();
});

const loneCode = [{ selector: "#code", slot: "code" as const }];

for (const [sendsOn, pressed] of [
  ["Enter", ["Enter"]],
  ["blur", ["Enter", "Tab"]],
] as const)
  test(`a recorded code state with one box in no form and no submit, whose page sends the code on ${sendsOn}, gets it sent once`, async ({
    page,
  }) => {
    // The page sends nothing as the last digit goes in. An Enter in the box goes first, then once
    // the page still holds, Tab out of the box; an Enter the page sent on is never followed by Tab.
    const checks = await serve(page, { screen: loneBox(sendsOn === "Enter" ? ["Enter", "blur"] : ["blur"]) });
    expect(await runStates(page, loneCode)).toBe("signed_in");
    expect(checks).toEqual([code]);
    expect(await page.evaluate(() => Reflect.get(window, "keys"))).toEqual([...code, ...pressed]);
    await expect(page.locator("#account")).toBeVisible();
  });

test("a recorded code state with one box in no form and no submit, whose box sends the code while the site checks it, gets nothing pressed", async ({
  page,
}) => {
  // The page also sends on an Enter or on the focus leaving the box, so any press after its own
  // send would check the code twice and sign the session out.
  const checks = await serve(page, { screen: loneBox(["input", "Enter", "blur"]), checkMs: 9_000 });
  expect(await runStates(page, loneCode)).toBe("signed_in");
  expect(checks).toEqual([code]);
  expect(await page.evaluate(() => Reflect.get(window, "keys"))).toEqual([...code]);
  await expect(page.locator("#account")).toBeVisible();
});
