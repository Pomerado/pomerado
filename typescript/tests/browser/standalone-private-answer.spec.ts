import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import { makeLiveAuthentication } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { inspectAutofillStep } from "../../src/destinations/autofill-step.js";
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

test("asks separately for two private answers on the same sign-in screen", async ({ page }) => {
  test.slow();
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<form><label>What was your first school?<input id="school" name="schoolAnswer"></label><label>What street did you grow up on?<input id="street" name="streetAnswer"></label></form>',
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
        const answer = answers[prompts.length];
        prompts.push(request.questions[0]?.prompt ?? "");
        return { private_answer: answer };
      }),
    ),
    registerSecret: () => undefined,
    review: () => Effect.void,
  });

  await Effect.runPromise(auth.step({ fields: [
    { selector: "#school", slot: "private_answer" },
    { selector: "#street", slot: "private_answer" },
  ] }));
  expect(await page.locator("#school").inputValue()).toBe(answers[0]);
  expect(await page.locator("#street").inputValue()).toBe(answers[1]);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("first school");
  expect(prompts[1]).toContain("grow up on");
  for (const answer of answers) expectNotCarried(browser.calls, answer);
});


test("reads adjacent questions again while the private-answer label stays unchanged", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="question">  First   pet\'s name? </p><label>Security answer<input id="answer"></label>' }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const prompts: string[] = [];
  const auth = makeLiveAuthentication({
    page: browser, keyboard, siteOrigin: site, authenticationOrigins: [],
    ask: makeInputAsker((request) => Effect.sync(() => {
      prompts.push(request.questions[0]?.prompt ?? "");
      return { private_answer: "synthetic-private-answer" };
    })),
    registerSecret: () => undefined, review: () => Effect.void,
  });
  const step = { fields: [{ selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" }] };
  await Effect.runPromise(auth.step(step));
  await page.locator("#question").evaluate((element) => { element.textContent = "First school's name?"; });
  await Effect.runPromise(auth.step(step));
  expect(prompts).toEqual([`First pet's name? (${site})`, `First school's name? (${site})`]);
  expectNotCarried(browser.calls, "synthetic-private-answer");
});

test("the local signed-in check refuses while a recorded private-answer field still shows", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="identity">Signed in</p><form id="challenge"><label>Security answer<input id="answer"></label></form>' }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const auth = makeLiveAuthentication({
    page: browser, keyboard, siteOrigin: site, authenticationOrigins: [],
    ask: makeInputAsker(() => Effect.succeed({ private_answer: "synthetic-private-answer" })),
    registerSecret: () => undefined, review: () => Effect.void,
  });
  await Effect.runPromise(auth.step({ fields: [{ selector: "#answer", slot: "private_answer" }] }));
  expect(await Effect.runPromise(auth.signedIn({ selector: "#identity" }))).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/login`,
  });
  await page.locator("#challenge").evaluate((element) => { element.remove(); });
  expect(await Effect.runPromise(auth.signedIn({ selector: "#identity" }))).toEqual({
    signedIn: true,
    url: `${site}/login`,
  });
  expectNotCarried(browser.calls, "synthetic-private-answer");
});

test("question inspection omits uncertain text and never uses a different frame", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body: "" }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const inspect = async (questionSelector: string) => {
    const result = await Effect.runPromise(inspectAutofillStep({
      step: { fields: [{ selector: "#answer", slot: "private_answer", questionSelector }] },
      page: browser, siteOrigin: site, authenticationOrigins: [],
    }));
    expect(result).not.toHaveProperty("outcome");
    if ("outcome" in result) throw new Error("Inspection refused");
    return result.screen.fields[0];
  };
  await page.setContent('<label>Security answer<input id="answer"></label><p id="question">  First \n pet? <input value="synthetic-secret"></p>');
  expect(await inspect("#question")).toHaveProperty("questionText", "First pet?");
  expect(await inspect("#missing")).not.toHaveProperty("questionText");
  await page.locator("#question").evaluate((element) => { element.setAttribute("hidden", ""); });
  expect(await inspect("#question")).not.toHaveProperty("questionText");
  await page.locator("#question").evaluate((element) => { element.removeAttribute("hidden"); element.after(element.cloneNode(true)); });
  expect(await inspect("#question")).not.toHaveProperty("questionText");
  expect(await inspect("#answer")).not.toHaveProperty("questionText");
  expect(await inspect("iframe >> #question")).not.toHaveProperty("questionText");
  await page.setContent('<p id="question">Main frame question</p><iframe srcdoc="<label>Security answer<input id=answer></label>"></iframe>');
  expect(await inspect("#question")).not.toHaveProperty("questionText");
  await page.setContent('<label>Security answer<input id="answer"></label><p id="question"></p>');
  await page.locator("#question").evaluate((element) => { element.textContent = "q".repeat(2001); });
  expect(await inspect("#question")).not.toHaveProperty("questionText");
});

for (const changeAt of ["protected prompting", "focus", "insertion"] as const) {
test(`does not fill an answer when its observed question changes during ${changeAt}`, async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="question">First pet?</p><label>Security answer<input id="answer"></label>' }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const changeQuestion = () => page.locator("#question").evaluate((element) => {
    element.textContent = "First school?";
  });
  if (changeAt === "focus")
    await page.locator("#answer").evaluate((element) => {
      element.addEventListener("focus", () => {
        const question = document.getElementById("question");
        if (question) question.textContent = "First school?";
      });
    });
  const insertions: string[] = [];
  const auth = makeLiveAuthentication({
    page: browser,
    keyboard: {
      insertText: (target, text) =>
        (changeAt === "insertion" ? Effect.promise(changeQuestion) : Effect.void).pipe(
          Effect.flatMap(() => keyboard.insertText(target, text)),
          Effect.tap((answer) => { insertions.push(answer); }),
        ),
    },
    siteOrigin: site, authenticationOrigins: [],
    ask: makeInputAsker(() => Effect.promise(async () => {
      if (changeAt === "protected prompting") await changeQuestion();
      return { private_answer: "synthetic-first-pet" };
    })), registerSecret: () => undefined, review: () => Effect.void,
  });
  // A refused field fails the step as a host refusal that submitted nothing. Whenever the question
  // changed, the minter hears it as a change on the screen, not as a field that blocks typing.
  const failure = await Effect.runPromise(Effect.flip(auth.step({ fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }] })));
  expect(failure).toMatchObject({
    authentication: {
      code: "AutofillRefused",
      hostRefusal: { check: "change", field: 0, slot: "private_answer" },
      nothingSubmitted: true,
    },
  });
  expect(insertions).toEqual(changeAt === "protected prompting" ? [] : ["question_changed"]);
  expect(await page.locator("#answer").inputValue()).toBe("");
  expectNotCarried(browser.calls, "synthetic-first-pet");
});
}
