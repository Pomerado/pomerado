import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
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
// alone and then presses its button. The site asks for a recovery code and a ZIP code on one form,
// and the host gives each run the login's next unused recovery code. Every value the screen takes
// is resolved before its first box is typed, so a ZIP code nobody gives types nothing, and the
// recovery code goes back unspent for the next run.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.test";
const codes = ["synthetic-recovery-1", "synthetic-recovery-2"];
const zip = "94105";

test.describe.configure({ timeout: 120_000 });

const form =
  '<form method="post" action="/recovery"><label>Recovery code<input id="recovery-code" name="recovery_code"></label><label>ZIP code<input id="zip" name="zip" autocomplete="postal-code"></label><button id="verify">Verify</button></form>';

/** The site: the form at /recovery, then /home once a code and the ZIP code went in. Each post. */
const serve = async (page: Page) => {
  const posted: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const sent = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
      posted.push(sent);
      const next = sent["zip"] === zip ? "/home" : "/recovery";
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next)})</script>` });
      return;
    }
    const home = new URL(request.url()).pathname === "/home";
    await route.fulfill({ contentType: "text/html", body: home ? '<p id="account">Your account</p>' : form });
  });
  return posted;
};

test("a recovery code goes back untyped when the ZIP code on its screen goes unanswered, and the next run uses it", async ({ page }) => {
  const posted = await serve(page);
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
  await page.goto(`${site}/recovery`);
  const shown = await Effect.runPromise(observe);
  if (shown === undefined) throw new Error("The scan read nothing");
  const appended = appendSignInStates(signInStatesOf({}, []), {
    states: [
      {
        fingerprint: shown.fingerprint,
        step: {
          page: `${site}/recovery`,
          fields: [
            { selector: "#recovery-code", slot: "recovery_code" },
            { selector: "#zip", slot: "zip" },
          ],
          submit: "#verify",
        },
      },
    ],
    signedIn: { selector: "#account" },
  });
  if ("refused" in appended) throw new Error(appended.refused);
  await page.goto("about:blank");

  // The host's ledger of the login's recovery codes: a code is held from the take until it is
  // given back, and each settle the replay reports.
  const held = new Set<string>();
  const settled: { readonly codes: readonly string[]; readonly reached: boolean }[] = [];
  const release = (taken: readonly TakenRecoveryCode[]) => {
    for (const { code } of taken) held.delete(code);
  };
  const signIn = (credentials: { readonly username: string; readonly password: string; readonly zip?: string }) =>
    Effect.runPromise(
      Effect.either(
        replaySignInStates({
          library: appended.library,
          observe,
          hooks,
          entryUrl: `${site}/recovery`,
          credentials,
          // Nobody answers: a ZIP code the login lacks goes unanswered.
          ask: makeInputAsker(() => Effect.succeed({} as InputAnswers)),
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
                settled.push({ codes: taken.map((each) => each.code), reached });
                if (!reached) release(taken);
              }),
          },
        }),
      ),
    );

  const unanswered = await signIn({ username: "owner", password: "synthetic-password" });
  expect(Either.isLeft(unanswered) && unanswered.left.code).toMatch(/^unanswered:/u);
  // Nothing was typed or posted, the host never heard a code spent, and the code went back.
  expect(await page.locator("#recovery-code").inputValue()).toBe("");
  expect(await page.locator("#zip").inputValue()).toBe("");
  expect(posted).toEqual([]);
  expect(settled).toEqual([]);
  expect([...held]).toEqual([]);

  const signedIn = await signIn({ username: "owner", password: "synthetic-password", zip });
  expect(Either.isRight(signedIn) && signedIn.right.outcome).toBe("signed_in");
  expect(posted).toEqual([{ recovery_code: codes[0], zip }]);
  // Every fill settles the codes it took, and only the recovery code's took one.
  expect(settled.filter((each) => each.codes.length > 0)).toEqual([{ codes: [codes[0]], reached: true }]);
});
