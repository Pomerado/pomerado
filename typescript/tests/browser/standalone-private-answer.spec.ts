import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import { makeLiveAuthentication } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

test("asks the current private-answer question again on a later sign-in step", async ({ page }) => {
  // Two independent protected CDP fills are required to prove the first answer is not reused.
  test.slow();
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<form><label>What was your first school?<input id="answer" name="securityAnswer"></label></form>',
    }),
  );
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const answers = ["synthetic-school-one", "synthetic-street-two"];
  const prompts: string[] = [];
  const auth = makeLiveAuthentication({
    page: browser,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    ask: makeInputAsker((request) =>
      Effect.sync(() => {
        prompts.push(request.questions[0]?.prompt ?? "");
        return { private_answer: answers[prompts.length - 1] };
      }),
    ),
    registerSecret: () => undefined,
    review: () => Effect.void,
  });

  await Effect.runPromise(auth.step({ fields: [{ selector: "#answer", slot: "private_answer" }] }));
  expect(await page.locator("#answer").inputValue()).toBe(answers[0]);
  await page.setContent(
    '<form><label>What street did you grow up on?<input id="answer" name="securityAnswer"></label></form>',
  );
  await Effect.runPromise(auth.step({ fields: [{ selector: "#answer", slot: "private_answer" }] }));
  expect(await page.locator("#answer").inputValue()).toBe(answers[1]);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("first school");
  expect(prompts[1]).toContain("grow up on");
  for (const answer of answers) expectNotCarried(browser.calls, answer);
});
