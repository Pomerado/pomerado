import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import type { InputAsker } from "../../src/runtime/input-request.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

const login = { username: "owner@bank.example.test", password: "synthetic-password" };
const site = "https://bank.example.test";

const localSignIn = async (page: Page, ask: InputAsker) => {
  const browser = await hostPage(page);
  const secrets = makeRunSecrets();
  const signIn = makeSignInBrowser({ page: browser, keyboard: (await hostKeyboard(page)).keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  const owner: InputAsker = (request, bounds) =>
    request.questions.some((q) => q.type === "credential")
      ? Effect.succeed({ login: { type: "credential" as const, value: { ...login, saveLogin: false } } })
      : ask(request, bounds);
  const held = localSignInLogin({ ask: owner, register: secrets.register, siteOrigin: site });
  const recorder = makeSignInRecorder({ browser: signIn, login: held, ask, secrets, review: () => Effect.void, site: "bank.example.test", signedOutPages: () => [] });
  await Effect.runPromise(held.values);
  return { recorder, fill: (step: SignInStep) => recorder.step(step, undefined, Effect.void) };
};

const requests: string[] = [];
const serve = async (page: Page, pages: Record<string, () => string>) => {
  for (const [path, body] of Object.entries(pages))
    await page.route(`${site}/${path}`, (route) => { const b = body(); requests.push(`${route.request().method()} /${path} ${(/id="question">([^<]*)/.exec(b)?.[1] ?? "").slice(-10)}`); return route.fulfill({ contentType: "text/html", body: b }); });
};

const record = async (page: Page, screens: readonly SignInStep[]) => {
  await page.goto(`${site}/login`);
  const auth = await localSignIn(page, makeInputAsker(() => Effect.succeed({ private_answer: "synthetic-answer" })));
  const [first, ...rest] = screens;
  if (first === undefined) throw new Error("no screen");
  await Effect.runPromise(auth.recorder.step(first, `${site}/login`, Effect.void));
  for (const screen of rest) {
    await page.waitForURL((url) => url.pathname !== "/login");
    const from = page.url();
    expect(await Effect.runPromise(auth.fill(screen))).toMatchObject({ report: { outcome: "filled" } });
    await page.waitForURL((url) => url.href !== from);
  }
  expect(await Effect.runPromise(auth.fill({ signedIn: { selector: "#identity" } } as unknown as SignInStep))).toMatchObject({ verified: true });
  return auth.recorder.published();
};

const replay = async (page: Page, states: unknown) => {
  await page.goto("about:blank");
  const prompts: string[] = [];
  const secrets = makeRunSecrets();
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      if (question?.type === "credential") return { login: { ...login, saveLogin: false } };
      prompts.push((question?.prompt ?? "").replace("bank.example.test asks this security question: ", ""));
      return { private_answer: "synthetic-answer" };
    }),
  );
  const { keyboard } = await hostKeyboard(page);
  const result = await Effect.runPromise(Effect.either(signInForRun({
    states: states as never,
    entryUrl: `${site}/login`,
    browser: makeSignInBrowser({ page: await hostPage(page), keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } }),
    login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
    ask,
    secrets,
    site: "bank.example.test",
    siteOrigin: site,
  })));
  return { prompts, result: Either.isRight(result) ? result.right : { failed: (result.left as { reason?: string }).reason } };
};

const loginPage = (action: string) =>
  `<form method="post" action="${action}"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>`;
const loginStep: SignInStep = { fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }], submit: "#sign-in" };
const answerStep: SignInStep = { fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }], submit: "#next" };
const fps = (published: unknown) => JSON.stringify((published as { states?: { states: { fingerprint: unknown }[] } })?.states?.states.map((s) => s.fingerprint) ?? null);

test("probe A: same question again, intro swapped for an error", async ({ page }) => {
  test.slow();
  const phase = { replay: false, checks: 0 };
  const question = "what was the name of your first pet?";
  const questionPage = (intro: string) =>
    `<form method="post" action="/check"><p>${intro}</p><p id="question">${question}</p><label>Security answer<input id="answer" name="answer"></label><button id="next">Continue</button></form>`;
  await serve(page, {
    login: () => loginPage("/question"),
    question: () => questionPage("answer your security question to continue."),
    check: () => {
      phase.checks += 1;
      return phase.replay && phase.checks <= 2 ? questionPage("that answer didn't match. try again.") : '<p id="identity">Signed in</p>';
    },
  });
  const published = await record(page, [loginStep, answerStep]);
  console.log("A states", fps(published));
  phase.replay = true;
  phase.checks = 0;
  console.log("A replay", JSON.stringify(await replay(page, published?.states)));
});

for (const between of [false, true])
  test(`probe G: two questions under a generic heading${between ? " with a page between" : " in a row"}`, async ({ page }) => {
    test.slow();
    const shown = { questions: ["what was the name of your first pet?", "what was the name of your first street?"], at: 0 };
    await serve(page, {
      login: () => loginPage("/question"),
      question: () => {
        const q = shown.questions[shown.at % 2];
        shown.at += 1;
        const action = shown.at % 2 === 0 ? "/account" : between ? "/between" : "/question";
        return `<form method="post" action="${action}"><h1>security check</h1><p id="question">${q}</p><label>Security answer<input id="answer" name="answer"></label><button id="next">Continue</button></form>`;
      },
      between: () => '<form method="post" action="/question"><p>one more question</p><button id="more">Continue</button></form>',
      account: () => '<p id="identity">Signed in</p>',
    });
    await page.goto(`${site}/login`);
    const auth = await localSignIn(page, makeInputAsker(() => Effect.succeed({ private_answer: "synthetic-answer" })));
    await Effect.runPromise(auth.recorder.step(loginStep, `${site}/login`, Effect.void));
    await page.getByText(shown.questions[0] as string).waitFor();
    expect(await Effect.runPromise(auth.fill(answerStep))).toMatchObject({ report: { outcome: "filled" } });
    if (between) {
      await page.getByText("one more question").waitFor();
      expect(await Effect.runPromise(auth.fill({ fields: [], submit: "#more" }))).toMatchObject({ report: { outcome: "filled" } });
    }
    await page.getByText(shown.questions[1] as string).waitFor();
    expect(await Effect.runPromise(auth.fill(answerStep))).toMatchObject({ report: { outcome: "filled" } });
    await page.getByText("Signed in").waitFor();
    expect(await Effect.runPromise(auth.fill({ signedIn: { selector: "#identity" } } as unknown as SignInStep))).toMatchObject({ verified: true });
    const published = auth.recorder.published();
    console.log(`G${between ? "b" : ""} states`, fps(published));
    shown.at = 0;
    console.log(`G${between ? "b" : ""} same`, JSON.stringify(await replay(page, published?.states)));
    shown.at = 0;
    shown.questions = ["what was the name of your first school?", "what was the name of your first teacher?"];
    requests.length = 0;
    console.log(`G${between ? "b" : ""} other`, JSON.stringify(await replay(page, published?.states)), JSON.stringify(requests));
    shown.at = 0;
    shown.questions = ["what was the name of your first school?", "what was the name of your first school?"];
    console.log(`G${between ? "b" : ""} repeat`, JSON.stringify(await replay(page, published?.states)));
  });

test("probe B: unknown boxless one-button page after a boxless question", async ({ page }) => {
  test.slow();
  const phase = { replay: false };
  await serve(page, {
    login: () => loginPage("/question"),
    question: () => `<div><h2 id="question">what was the name of your first pet?</h2><input id="answer" aria-label="Answer"><div role="button" id="next" onclick="location.href='/after'">Continue</div></div>`,
    after: () => (phase.replay ? '<div><p>your password expires soon.</p><button id="ok" onclick="location.href=\'/account\'">Continue</button></div>' : '<p id="identity">Signed in</p>'),
    account: () => '<p id="identity">Signed in</p>',
  });
  const published = await record(page, [loginStep, answerStep]);
  console.log("B states", fps(published));
  phase.replay = true;
  console.log("B replay", JSON.stringify(await replay(page, published?.states)));
});

test("probe C: identifier-first, the email page again with a notice", async ({ page }) => {
  test.slow();
  const phase = { replay: false };
  await serve(page, {
    login: () => '<form method="post" action="/question"><label>Email<input id="email" name="email" type="email"></label><button id="continue">Continue</button></form>',
    question: () => (phase.replay
      ? '<form method="post" action="/question"><p>we couldn\'t find that account.</p><label>Email<input id="email" name="email" type="email"></label><button id="continue">Continue</button></form>'
      : '<form method="post" action="/password"><p id="question">what was the name of your first pet?</p><label>Security answer<input id="answer" name="answer"></label><button id="next">Continue</button></form>'),
    password: () => '<form method="post" action="/account"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
    account: () => '<p id="identity">Signed in</p>',
  });
  const published = await record(page, [
    { fields: [{ selector: "#email", accepts: ["email"] }], submit: "#continue" },
    answerStep,
    { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
  ]);
  console.log("C states", fps(published));
  phase.replay = true;
  console.log("C replay", JSON.stringify(await replay(page, published?.states)));
});

test("probe D: boxless question page whose control is a link", async ({ page }) => {
  test.slow();
  const shown = { question: "what was the name of your first pet?" };
  await serve(page, {
    login: () => loginPage("/question"),
    question: () => `<div><h2 id="question">${shown.question}</h2><input id="answer" aria-label="Answer"><a id="next" href="/account">Continue</a></div>`,
    account: () => '<p id="identity">Signed in</p>',
  });
  const published = await record(page, [loginStep, answerStep]);
  console.log("D states", fps(published));
  shown.question = "what was the name of your first school?";
  console.log("D replay", JSON.stringify(await replay(page, published?.states)));
});
