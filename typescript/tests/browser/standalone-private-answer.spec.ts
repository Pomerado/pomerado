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
      hostRefusal: { check: "change", field: 0, slot: "private_answer", cause: "question_changed" },
      nothingSubmitted: true,
    },
  });
  expect(insertions).toEqual(changeAt === "protected prompting" ? [] : ["question_changed"]);
  expect(await page.locator("#answer").inputValue()).toBe("");
  expectNotCarried(browser.calls, "synthetic-first-pet");
});
}

// A sign-in the check showed signed in is over, so its code screen's selector no longer counts. A
// later sign-in that skipped the code, as on a remembered device, lands on an account page whose
// gift-card box matches that selector, and the site is signed in.
test("a later sign-in's check ignores an earlier sign-in's code selector on an account control", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="identity">Signed in</p><form id="challenge"><label>Verification code<input name="code"></label></form>' }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const auth = makeLiveAuthentication({
    page: browser, keyboard, siteOrigin: site, authenticationOrigins: [],
    ask: makeInputAsker((request) => Effect.succeed(Object.fromEntries(request.questions.map(
      (question) => [question.id, question.id === "code" ? "482913" : "synthetic-password"])))),
    registerSecret: () => undefined, review: () => Effect.void,
  });
  const indicator = { selector: "#identity" };
  await Effect.runPromise(auth.step({ fields: [{ selector: 'input[name="code"]', slot: "code" }] }));
  expect(await Effect.runPromise(auth.signedIn(indicator))).toMatchObject({ failed: "challenge_form_visible" });
  await page.locator("#challenge").evaluate((element) => { element.remove(); });
  expect(await Effect.runPromise(auth.signedIn(indicator))).toMatchObject({ signedIn: true });
  await page.setContent('<form><label>Password<input id="password" type="password"></label></form>');
  await Effect.runPromise(auth.step({ fields: [{ selector: "#password", slot: "password" }] }));
  await page.setContent('<p id="identity">Signed in</p><form><label>Gift card code<input name="code"></label><button>Redeem</button></form>');
  expect(await Effect.runPromise(auth.signedIn(indicator))).toEqual({ signedIn: true, url: `${site}/login` });
});

// A redeem box on the account page can share the code field's generic label and name. The id the
// host recorded when it inspected the code field tells them apart, and the code form itself still
// asks.
test("a recorded code field's id tells it from a redeem box with the same label and name", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<form><label>Code<input name="code" id="otp"></label><button>Verify</button></form>' }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const auth = makeLiveAuthentication({
    page: browser, keyboard, siteOrigin: site, authenticationOrigins: [],
    ask: makeInputAsker(() => Effect.succeed({ code: "482913" })),
    registerSecret: () => undefined, review: () => Effect.void,
  });
  const indicator = { selector: "#identity" };
  await Effect.runPromise(auth.step({ fields: [{ selector: 'role=textbox[name="Code"]', slot: "code" }] }));
  await page.setContent('<p id="identity">Signed in</p><form><label>Code<input name="code" id="otp"></label></form>');
  expect(await Effect.runPromise(auth.signedIn(indicator))).toMatchObject({ failed: "challenge_form_visible" });
  await page.setContent('<p id="identity">Signed in</p><form><label>Code<input name="code" id="redeem"></label><button>Redeem</button></form>');
  expect(await Effect.runPromise(auth.signedIn(indicator))).toEqual({ signedIn: true, url: `${site}/login` });
});

// The prompt holds at most 2,000 characters, so a long question is cut to leave room for the
// site's origin, and the owner is still asked.
test("asks a question too long for the prompt with the site's origin, cut to fit", async ({ page }) => {
  const site = "https://bank.example.test";
  const question = `${"Which of these did you pick ".repeat(80).trim()}?`.slice(-1982);
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    `<p id="question">${question}</p><label>Security answer<input id="answer"></label>` }));
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
  await Effect.runPromise(auth.step({ fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }] }));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]?.length).toBeLessThanOrEqual(2000);
  expect(prompts[0]?.startsWith(question.slice(0, 1900))).toBe(true);
  expect(prompts[0]?.endsWith(`… (${site})`)).toBe(true);
  expect(await page.locator("#answer").inputValue()).toBe("synthetic-private-answer");
});

// A recorded question the host could not read, as with no one visible match, is said so in the
// prompt rather than left for the field's label to stand in for.
test("says in the prompt that a recorded question could not be read", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p class="question">First pet?</p><p class="question">First school?</p><label>Security answer<input id="answer"></label>' }));
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
  await Effect.runPromise(auth.step({ fields: [{ selector: "#answer", slot: "private_answer", questionSelector: ".question" }] }));
  expect(prompts).toEqual([
    `Enter your security answer for ${site}. The question it answers could not be read from the page. The answer field reads "Security answer".`,
  ]);
});

/**
 * Fills a code screen through local sign-in, by `selector`, then checks the signed-in page
 * `account`, as a check right after the code screen does in the same sign-in.
 */
const codeThenAccount = async (
  page: import("@playwright/test").Page,
  codeForm: string,
  selector: string,
  account: string,
) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body: codeForm }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const auth = makeLiveAuthentication({
    page: browser, keyboard, siteOrigin: site, authenticationOrigins: [],
    ask: makeInputAsker(() => Effect.succeed({ code: "482913" })),
    registerSecret: () => undefined, review: () => Effect.void,
  });
  await Effect.runPromise(auth.step({ fields: [{ selector, slot: "code" }] }));
  await page.setContent(`<p id="identity">Signed in</p>${account}`);
  return Effect.runPromise(auth.signedIn({ selector: "#identity" }));
};

// The check right after a code screen runs in the same sign-in. A control on the signed-in page
// that the code's selector also matches, such as one a role name pattern matches, is no challenge
// unless it is the same control: the same words name it, with the type and autocomplete
// inspection recorded.
const codeForm = '<form><label>Verification code<input name="code" autocomplete="one-time-code"></label><button type="button">Verify</button></form>';
const roleCodeForm = '<form><label>Code<input name="otp"></label><button type="button">Verify</button></form>';
for (const [name, form, selector, account, failed] of [
  ["an editable gift-card box", codeForm, 'input[name="code"]', '<form><label>Gift card code<input name="code"></label><button>Redeem</button></form>', undefined],
  ["a Promo code textbox", roleCodeForm, 'role=textbox[name=/code/i]', '<form><label>Promo code<input name="promo"></label><button>Apply</button></form>', undefined],
  ["the code form itself, still showing", codeForm, 'input[name="code"]', codeForm, "challenge_form_visible"],
  ["the role-named code field itself, still showing", roleCodeForm, 'role=textbox[name=/code/i]', roleCodeForm, "challenge_form_visible"],
] as const)
  test(`a check right after a code screen ${failed === undefined ? "passes" : "refuses"} with ${name} on the page`, async ({ page }) => {
    expect(await codeThenAccount(page, form, selector, account)).toEqual(
      failed === undefined
        ? { signedIn: true, url: "https://bank.example.test/login" }
        : { signedIn: false, failed, url: "https://bank.example.test/login" },
    );
  });
