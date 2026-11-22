import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { TakenRecoveryCode } from "../../src/runtime/autofill-values.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in replayed from its screens on local Chromium, where the screen types each box
// alone and then presses its button. Every value a screen's boxes take, but a code or security
// answer, is resolved before its first box is typed, so a ZIP code nobody gives types nothing and
// the recovery code beside it goes back unspent for the next run. A value resolved early is held
// until its box is typed, so a screen the page grows into asks nothing again, and a recovery code
// whose box the replay never typed goes back unspent.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.test";
const codes = ["synthetic-recovery-1", "synthetic-recovery-2"];
const zip = "94105";
const password = "synthetic-password";

test.describe.configure({ timeout: 120_000 });

/** The site: `/verify` shows `form`, `/home` the account. Each post, and where it leads. */
const serve = async (page: Page, form: string, next: (sent: Record<string, string>) => string) => {
  const posted: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const sent = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
      posted.push(sent);
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next(sent))})</script>` });
      return;
    }
    const home = new URL(request.url()).pathname === "/home";
    await route.fulfill({ contentType: "text/html", body: home ? '<p id="account">Your account</p>' : form });
  });
  return posted;
};

/**
 * The host's hooks and scan on `page`, the screens of `/verify` as each `look` shows them after
 * it, and a replay with the host's ledger of the login's recovery codes: a code is held from the
 * take until it is given back. `settled` is each settle the replay reports with a code in it.
 */
const signInOn = async (
  page: Page,
  screens: readonly { readonly look?: string; readonly fields: AutofillRecipeStep["fields"] }[],
) => {
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const browser = makeSignInBrowser({ page: host, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  const hooks: AutofillHooks<TestFailure> = {
    inspect: (step) => browser.inspect(step),
    fill: (input) => browser.fill(input),
    check: (indicator, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin),
    confirm: (indicator, _identifiers, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin),
    open: (url) => browser.open(url).pipe(Effect.mapError(() => new TestFailure({ code: "open" }))),
    markerVisible: (selector, screenPage, popup) =>
      browser.markerVisible(selector, screenPage, popup).pipe(Effect.mapError(() => new TestFailure({ code: "marker" }))),
  };
  const observe = observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [] });
  const states = [];
  for (const { look, fields } of screens) {
    await page.goto(`${site}/verify`);
    if (look !== undefined) await page.evaluate(look);
    const shown = await Effect.runPromise(observe);
    if (shown === undefined) throw new Error("The scan read nothing");
    states.push({ fingerprint: shown.fingerprint, step: { page: `${site}/verify`, fields, submit: "#verify" } });
  }
  const appended = appendSignInStates(signInStatesOf({}, []), { states, signedIn: { selector: "#account" } });
  if ("refused" in appended) throw new Error(appended.refused);
  await page.goto("about:blank");
  const held = new Set<string>();
  const settled: { readonly codes: readonly string[]; readonly reached: boolean }[] = [];
  const asked: string[] = [];
  const release = (taken: readonly TakenRecoveryCode[]) => {
    for (const { code } of taken) held.delete(code);
  };
  const signIn = (
    credentials: { readonly username: string; readonly password: string; readonly zip?: string },
    answers: Readonly<Record<string, string>>,
    list = true,
  ) =>
    Effect.runPromise(
      Effect.either(
        replaySignInStates({
          library: appended.library,
          observe,
          hooks,
          entryUrl: `${site}/verify`,
          credentials,
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              const id = request.questions[0]?.id ?? "";
              asked.push(id);
              return (id in answers ? { [id]: answers[id] } : {}) as InputAnswers;
            }),
          ),
          broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
          site: "app.example.test",
          correlation: undefined,
          emit: () => Effect.void,
          failures: {
            unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
            unavailable: () => new TestFailure({ code: "unavailable" }),
          },
          timing: { stepWaitMs: 8_000, pollMs: 250 },
          sent: { current: false },
          // Without the list, the owner is asked for a recovery code.
          ...(list
            ? {
                hosted: {
                  recoveryCode: () =>
                    Effect.sync(() => {
                      const code = codes.find((each) => !held.has(each)) ?? "";
                      held.add(code);
                      return {
                        slot: "recovery_code" as const,
                        value: code,
                        recoveryCode: { code, remaining: codes.length - held.size },
                      };
                    }),
                  giveBack: (_login, taken) => Effect.sync(() => release(taken)),
                  settleRecoveryCodes: (taken, reached) =>
                    Effect.sync(() => {
                      if (taken.length > 0) settled.push({ codes: taken.map((each) => each.code), reached });
                      if (!reached) release(taken);
                    }),
                },
              }
            : {}),
        }),
      ),
    );
  return { signIn, held, settled, asked };
};

const recoveryForm = (script = "") =>
  `<form method="post" action="/verify"><label>Recovery code<input id="recovery-code" name="recovery_code"></label><label>ZIP code<input id="zip" name="zip" autocomplete="postal-code"></label><button id="verify">Verify</button></form>${script}`;
const recoveryFields = [
  { selector: "#recovery-code", slot: "recovery_code" },
  { selector: "#zip", slot: "zip" },
] as const;

test("a recovery code goes back untyped when the ZIP code on its screen goes unanswered, and the next run uses it", async ({ page }) => {
  const posted = await serve(page, recoveryForm(), (sent) => (sent["zip"] === zip ? "/home" : "/verify"));
  const { signIn, held, settled } = await signInOn(page, [{ fields: [...recoveryFields] }]);
  // Nobody answers: a ZIP code the login lacks goes unanswered.
  const unanswered = await signIn({ username: "owner", password }, {});
  expect(Either.isLeft(unanswered) && unanswered.left.code).toMatch(/^unanswered:/u);
  // Nothing was typed or posted, the host never heard a code spent, and the code went back.
  expect(await page.locator("#recovery-code").inputValue()).toBe("");
  expect(await page.locator("#zip").inputValue()).toBe("");
  expect(posted).toEqual([]);
  expect(settled).toEqual([]);
  expect([...held]).toEqual([]);

  const signedIn = await signIn({ username: "owner", password, zip }, {});
  expect(Either.isRight(signedIn) && signedIn.right.outcome).toBe("signed_in");
  expect(posted).toEqual([{ recovery_code: codes[0], zip }]);
  expect(settled).toEqual([{ codes: [codes[0]], reached: true }]);
});

test("a recovery code taken for a box the page moved on from goes back unspent", async ({ page }) => {
  // The ZIP code alone signs this login in: the page moves on once it is typed.
  const moves = '<script>document.getElementById("zip").addEventListener("input", (event) => { if (event.target.value.length === 5) setTimeout(() => location.replace("/home"), 300); });</script>';
  const posted = await serve(page, recoveryForm(moves), () => "/verify");
  const { signIn, held, settled } = await signInOn(page, [{ fields: [recoveryFields[1], recoveryFields[0]] }]);
  const signedIn = await signIn({ username: "owner", password, zip }, {});
  expect(Either.isRight(signedIn) && signedIn.right.outcome).toBe("signed_in");
  expect(posted).toEqual([]);
  expect(settled).toEqual([{ codes: [codes[0]], reached: false }]);
  expect([...held]).toEqual([]);
});

for (const slot of ["code", "recovery_code"] as const)
  test(`a ${slot === "code" ? "code" : "recovery code"} is asked once where typing the ZIP code draws a fuller screen`, async ({ page }) => {
    const answer = slot === "code" ? "123456" : "synthetic-recovery-typed";
    // Once the ZIP code is typed, the form adds a password box.
    const form = `<form method="post" action="/verify"><label>ZIP code<input id="zip" name="zip" autocomplete="postal-code"></label><label>${slot === "code" ? 'Verification code<input id="second" name="second" autocomplete="one-time-code" inputmode="numeric">' : 'Recovery code<input id="second" name="second">'}</label><span id="more"></span><button id="verify">Verify</button></form><script>window.more = () => { if (!document.getElementById("password")) document.getElementById("more").innerHTML = '<label>Password<input id="password" name="password" type="password"></label>'; }; document.getElementById("zip").addEventListener("input", (event) => { if (event.target.value.length === 5) window.more(); });</script>`;
    const posted = await serve(page, form, (sent) =>
      sent["zip"] === zip && sent["second"] === answer && sent["password"] === password ? "/home" : "/verify",
    );
    const zipBox = { selector: "#zip", slot: "zip" } as const;
    const second = { selector: "#second", slot } as const;
    const { signIn, asked } = await signInOn(page, [
      { fields: [zipBox, second] },
      { look: "window.more()", fields: [zipBox, second, { selector: "#password", slot: "password" }] },
    ]);
    const signedIn = await signIn({ username: "owner", password, zip }, { [slot]: answer }, false);
    expect(Either.isRight(signedIn) && signedIn.right.outcome).toBe("signed_in");
    expect(asked).toEqual([slot]);
    expect(posted).toEqual([{ zip, second: answer, password }]);
  });
