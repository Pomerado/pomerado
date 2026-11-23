import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, type SignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { HostedSignIn } from "../../src/runtime/autofill-replay-steps.js";
import { typedValues } from "../../src/runtime/autofill-values.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates, type SignInStatesOutcome } from "../../src/runtime/sign-in-states-replay.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in replayed from a library of states on local Chromium, with the host's own scan,
// inspection and fill, where the site asks something more once the password went in. Every host is
// synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://bank.example.test";
const username = "ada-owner";
const password = "synthetic-password";
const login: AutofillRecipeStep = {
  page: `${site}/login`,
  fields: [{ selector: "#username", accepts: ["username"] }, { selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
const loginPage =
  '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>';

const verify =
  '<form method="post" action="/verify"><label>Verification code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label><button id="verify">Verify</button></form>';

test.describe.configure({ timeout: 120_000 });

/** The site: each path's page, and where each form's post goes on to. Each post, in order. */
const serve = async (page: Page, pages: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>) => {
  const posts: string[] = [];
  await page.route(/^https:\/\//u, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "POST") {
      posts.push(`${pathname} ${request.postData() ?? ""}`);
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next[pathname])})</script>` });
    } else await route.fulfill({ contentType: "text/html", body: pages[pathname] ?? "<p>Not found</p>" });
  });
  return posts;
};

/** The host's hooks and scan on `page`, as a host gives them to a replay. */
const hostOn = async (page: Page) => {
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const browser = makeSignInBrowser({ page: host, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  const hooks: AutofillHooks<TestFailure> = {
    inspect: (step) => browser.inspect(step),
    // One-character code boxes take the code one character each, as the local host types it.
    fill: (input) => browser.fill({ ...input, values: typedValues(input.step, input.values) }),
    ...(browser.resubmit === undefined ? {} : { resubmit: browser.resubmit }),
    check: (indicator, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin),
    confirm: (indicator, _identifiers, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin),
    open: (url) => browser.open(url).pipe(Effect.mapError(() => new TestFailure({ code: "open" }))),
    markerVisible: (selector, screenPage, popup) =>
      browser.markerVisible(selector, screenPage, popup).pipe(Effect.mapError(() => new TestFailure({ code: "marker" }))),
  };
  return { hooks, observe: observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [], identifiers: [username] }) };
};

/** A build's library: each step on the page the host's scan read at its path. */
const recorded = async (page: Page, steps: readonly AutofillRecipeStep[]) => {
  const states = [];
  for (const step of steps) {
    await page.goto(step.page);
    const read = await Effect.runPromise((await hostOn(page)).observe);
    if (read === undefined) throw new Error("The scan read nothing");
    states.push({ fingerprint: read.fingerprint, step });
  }
  const appended = appendSignInStates(signInStatesOf({}, []), { states, signedIn: { selector: "#account" } });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};

/**
 * A run's replay of `library` from the login page, answering every ask with `answers`, with what
 * the host adds on its hooks (`hosted`). The ids of the questions asked, in order.
 */
const replay = async (
  page: Page,
  library: SignInStates,
  answers: InputAnswers,
  hosted?: (hooks: AutofillHooks<TestFailure>) => HostedSignIn<TestFailure>,
  credentials: WebsiteCredentials = { username, password },
) => {
  const { hooks, observe } = await hostOn(page);
  const asked: string[] = [];
  const ended = await Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe,
        hooks,
        entryUrl: `${site}/login`,
        credentials,
        ask: makeInputAsker((request) => Effect.sync(() => (asked.push(...request.questions.map((question) => question.id)), answers))),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "bank.example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 4_000, pollMs: 250 },
        sent: { current: false },
        ...(hosted === undefined ? {} : { hosted: hosted(hooks) }),
      }),
    ),
  );
  if (Either.isLeft(ended)) throw ended.left;
  return { ended: ended.right, asked };
};

/** The login's saved answer, and the host's own flag of it where its question shows again. */
const savedAnswer =
  (flagged: string[]) =>
  (hooks: AutofillHooks<TestFailure>): HostedSignIn<TestFailure> => ({
    privateAnswer: () => Effect.succeed({ slot: "private_answer", value: "synthetic-saved-answer" }),
    refuseShownAnswer: (ran) => {
      const step = ran.findLast((taken) => taken.fields.some((field) => field.slot === "private_answer"));
      return step === undefined
        ? Effect.void
        : hooks.inspect(step).pipe(Effect.map((shown) => void flagged.push("outcome" in shown ? "gone" : "shown")));
    },
  });

test("a saved security answer the site asks for again is flagged through the host's hook", async ({ page }) => {
  const question =
    '<form method="post" action="/question"><p id="question">What was the name of your first pet?</p><label>Answer<input id="answer" name="answer"></label><button id="next">Continue</button></form>';
  // The site takes the login and refuses every answer, asking the same question again.
  const posts = await serve(page, { "/login": loginPage, "/question": question }, { "/login": "/question", "/question": "/question" });
  const library = await recorded(page, [
    login,
    { page: `${site}/question`, fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }], submit: "#next" },
  ]);
  await page.goto("about:blank");
  posts.length = 0;
  const flagged: string[] = [];
  const { ended } = await replay(page, library, {}, savedAnswer(flagged));
  expect(ended.outcome).not.toBe("signed_in");
  expect(posts.filter((post) => post.startsWith("/question"))).toEqual(["/question answer=synthetic-saved-answer"]);
  expect(flagged).toEqual(["shown"]);
});

test("a code page the library never recorded, after the password, is answered once and signs in", async ({ page }) => {
  const code = "246810";
  const posts = await serve(
    page,
    { "/login": loginPage, "/verify": verify, "/home": '<p id="account">Your account</p>' },
    { "/login": "/verify", "/verify": "/home" },
  );
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(asked).toEqual(["code"]);
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([`/verify code=${code}`]);
  // The page's look, the state before it and the page as a recorded screen, for the host to have
  // the page recorded.
  expect(ended.unrecordedCode).toEqual({
    fingerprint: expect.objectContaining({ boxes: [expect.objectContaining({ kind: "code" })] }),
    after: library.states[0]?.key,
    step: {
      page: `${site}/verify`,
      fields: [{ selector: 'input[name="code"]', slot: "code" }],
      submit: 'form:has(input[name="code"]) :is(button[type="submit" i], input[type="submit" i], button:not([type]))',
    },
  });
  // A library that keeps the page signs in through it as a known state the next time.
  await page.goto("about:blank");
  posts.length = 0;
  const again = await replay(page, kept(library, ended.unrecordedCode), { code });
  expect(again.ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(again.ended.unrecordedCode).toBeUndefined();
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([`/verify code=${code}`]);
});

const seedCode = "135791";
const sentCode = "246810";

/**
 * A site whose page after the password is a code page the library never recorded, taking only the
 * code it sent: any other brings the page back as it was, with no error, or with `locks` naming a
 * locked account. Each replay of it from the login gets the host's own code, as from a saved
 * authenticator seed, wherever the replay lets the host give one, else the owner's, `owner` in
 * turn, each counted, and the host's read of the site's answer: the codes posted, in order.
 */
const seededCodePage = async (page: Page, locks = false) => {
  const lockedNotice = "<p>Too many attempts. Your account is locked.</p>";
  const codes = () => posts.filter((post) => post.startsWith("/verify"));
  const posts: string[] = await serve(
    page,
    {
      "/login": loginPage,
      get "/verify"() {
        return locks && codes().length > 0 ? lockedNotice + verify : verify;
      },
      "/home": '<p id="account">Your account</p>',
    },
    {
      "/login": "/verify",
      get "/verify"() {
        return posts.at(-1) === `/verify code=${sentCode}` ? "/home" : "/verify";
      },
    },
  );
  const library = await recorded(page, [login]);
  return async (owner: readonly string[]) => {
    await page.goto("about:blank");
    posts.length = 0;
    let asked = 0;
    const { ended } = await replay(page, library, {}, () => ({
      login: (base, step) => ({ ...base, seedAllowed: step.seedAllowed }),
      code: (held) =>
        Effect.sync(() => ({
          slot: "code" as const,
          value: (held as { seedAllowed?: boolean }).seedAllowed === true ? seedCode : (owner[asked++] ?? ""),
        })),
      siteAnswer: (texts) => Effect.succeed(texts?.some((text) => /locked/iu.test(text)) === true ? "locked" : undefined),
    }));
    return { ended, asked, codes: codes() };
  };
};

test("a code page the library never recorded that comes back with no error gets one more code, never the host's again", async ({ page }) => {
  const run = await seededCodePage(page);
  const signed = await run([sentCode]);
  expect(signed.ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(signed.asked).toBe(1);
  expect(signed.codes).toEqual([`/verify code=${seedCode}`, `/verify code=${sentCode}`]);
  // An owner's code the site refuses too ends the replay there, with no third code.
  const refused = await run(["975310", sentCode]);
  expect(refused.ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(refused.asked).toBe(1);
  expect(refused.codes).toEqual([`/verify code=${seedCode}`, "/verify code=975310"]);
});

test("a code page the library never recorded that comes back naming a locked account ends there, with no code asked again", async ({ page }) => {
  const run = await seededCodePage(page, true);
  const { ended, asked, codes } = await run([sentCode]);
  expect(ended).toMatchObject({ outcome: "unclear", reason: "account_locked" });
  expect(asked).toBe(0);
  expect(codes).toEqual([`/verify code=${seedCode}`]);
});

/** `library` with the code page a replay named, after the state before it, as a host keeps it. */
const kept = (library: SignInStates, named: SignInStatesOutcome["unrecordedCode"]) => {
  if (named?.step === undefined) throw new Error("No recorded code screen");
  const appended = appendSignInStates(library, {
    from: named.after,
    states: [{ fingerprint: named.fingerprint, step: named.step }],
    signedIn: { selector: "#account" },
  });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};

/**
 * A replay, from a library of the login alone, of a site whose page after the password is a code
 * page, as `verifyPage` gives it on each load, that leads to the account: it signs in. The library,
 * the outcome and each post.
 */
const codePageReplay = async (page: Page, verifyPage: () => string) => {
  const pages = {
    "/login": loginPage,
    get "/verify"() {
      return verifyPage();
    },
    "/home": '<p id="account">Your account</p>',
  };
  const posts = await serve(page, pages, { "/login": "/verify", "/verify": "/home" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended } = await replay(page, library, { code: "246810" });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  return { library, ended, posts };
};

test("a code page whose box gets a new id on each load is kept by its name, and the next replay signs in through it", async ({ page }) => {
  let loads = 0;
  const { library, ended, posts } = await codePageReplay(page, () => {
    loads += 1;
    return verify.replace('id="code" name="code"', `id="otp-${loads}a${loads}" name="otp"`);
  });
  await page.goto("about:blank");
  posts.length = 0;
  const again = await replay(page, kept(library, ended.unrecordedCode), { code: "246810" });
  expect(again.ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(again.ended.unrecordedCode).toBeUndefined();
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual(["/verify otp=246810"]);
  expect(ended.unrecordedCode?.step?.fields).toEqual([{ selector: 'input[name="otp"]', slot: "code" }]);
});

test("a code page of a row of boxes is kept box by box, and the next replay signs in through it", async ({ page }) => {
  const digits = [1, 2, 3, 4, 5, 6];
  const boxes = digits
    .map((box) => `<input name="d${box}" maxlength="1" inputmode="numeric"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`)
    .join("");
  const { library, ended, posts } = await codePageReplay(
    page,
    () => `<form method="post" action="/verify"><p>Enter the code</p>${boxes}<button>Verify</button></form>`,
  );
  const sent = "/verify d1=2&d2=4&d3=6&d4=8&d5=1&d6=0";
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([sent]);
  await page.goto("about:blank");
  posts.length = 0;
  const again = await replay(page, kept(library, ended.unrecordedCode), { code: "246810" });
  expect(again.ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(again.ended.unrecordedCode).toBeUndefined();
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([sent]);
  expect(ended.unrecordedCode?.step?.fields).toEqual(digits.map((box) => ({ selector: `input[name="d${box}"]`, slot: "code" })));
});

test("a code page whose box has only an id with a digit in it, as a generated id has, is named by its look alone", async ({ page }) => {
  const { library, ended } = await codePageReplay(page, () => verify.replace('id="code" name="code"', 'id="otp-1a1"'));
  expect(ended.unrecordedCode).toEqual({ fingerprint: expect.anything(), after: library.states[0]?.key });
});

test("a code page whose box's name also names a box in a shadow root is named by its look alone", async ({ page }) => {
  const promo =
    '<p id="promo"></p><script>document.getElementById("promo").attachShadow({ mode: "open" }).innerHTML = \'<label>Promo<input name="code"></label>\';</script>';
  const { library, ended } = await codePageReplay(page, () => verify + promo);
  expect(ended.unrecordedCode).toEqual({ fingerprint: expect.anything(), after: library.states[0]?.key });
});

test("a refused password beside a security question flags no saved answer", async ({ page }) => {
  const both = loginPage.replace(
    "<button",
    '<p id="question">What was the name of your first pet?</p><label>Answer<input id="answer" name="answer"></label><button',
  );
  await serve(page, { "/login": both }, { "/login": "/login" });
  const library = await recorded(page, [
    { ...login, fields: [...login.fields, { selector: "#answer", slot: "private_answer", questionSelector: "#question" }] },
  ]);
  await page.goto("about:blank");
  const flagged: string[] = [];
  const { ended } = await replay(page, library, {}, savedAnswer(flagged));
  expect(ended.outcome).not.toBe("signed_in");
  expect(flagged).toEqual([]);
});

test("a login page that comes back typed beside a new code box gets no code, and the password goes once", async ({ page }) => {
  const returned = loginPage
    .replace('name="username"', `name="username" value="${username}"`)
    .replace('type="password"', `type="password" value="${password}"`)
    .replace("<button", '<label>Code<input id="otp" name="otp" autocomplete="one-time-code"></label><button');
  const posts = await serve(page, { "/login": loginPage, "/login/again": returned }, { "/login": "/login/again" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code: "246810" });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(asked).toEqual([]);
  expect(posts).toHaveLength(1);
});

test("an email box whose own suggestion list covers its Continue signs in, alone or in a state a fuller one holds", async ({ page }) => {
  const identifier = `<form method="post" action="/login" style="position:relative"><p style="margin:0;height:40px"><label>Email<input id="username" name="username" aria-controls="suggest" aria-expanded="false"></label></p><ul id="suggest" role="listbox" hidden style="position:absolute;top:40px;left:0;width:400px;height:120px;margin:0;background:#fff"><li role="option">${username}@example.test</li></ul><p style="margin:0"><button id="next">Continue</button></p></form><script>
const box = document.getElementById("username"), list = document.getElementById("suggest");
box.addEventListener("input", () => { list.hidden = false; box.setAttribute("aria-expanded", "true"); });
box.addEventListener("keydown", (event) => { if (event.key === "Escape") { list.hidden = true; box.setAttribute("aria-expanded", "false"); } });
</script>`;
  const passwordPage =
    '<form method="post" action="/password"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>';
  // The same login page with its password box drawn, as a page that draws it once it knows the login.
  const both = identifier.replace("</p><ul", '</p><p style="margin:0;height:40px"><label>Password<input id="pw" type="password"></label></p><ul');
  const posts = await serve(
    page,
    { "/login": identifier, "/both": both, "/password": passwordPage, "/home": '<p id="account">Your account</p>' },
    { "/login": "/password", "/password": "/home" },
  );
  const emailStep: AutofillRecipeStep = { page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" };
  const passwordStep: AutofillRecipeStep = { page: `${site}/password`, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" };
  // With a fuller state that holds the email one, the press goes alone, with the box it typed.
  const fuller: AutofillRecipeStep = { ...emailStep, page: `${site}/both`, fields: [...emailStep.fields, { selector: "#pw", slot: "password" }] };
  for (const steps of [[emailStep, passwordStep], [emailStep, fuller, passwordStep]]) {
    const library = await recorded(page, steps);
    await page.goto("about:blank");
    posts.length = 0;
    const { ended } = await replay(page, library, {});
    expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
    expect(posts).toEqual([`/login username=${username}`, `/password password=${password}`]);
  }
});

test("a ZIP code page that signs in on its last digit, taking its button away, signs in", async ({ page }) => {
  // On the fifth digit the page shows the account in place of the form, so its Verify is gone.
  const zipPage =
    '<form method="post" action="/zip"><label>ZIP code<input id="zip" name="zip" autocomplete="postal-code"></label><button id="verify">Verify</button></form><script>document.getElementById("zip").addEventListener("input", (event) => { if (event.target.value.length === 5) document.body.innerHTML = \'<p id="account">Your account</p>\'; });</script>';
  const posts = await serve(page, { "/login": loginPage, "/zip": zipPage }, { "/login": "/zip" });
  const library = await recorded(page, [login, { page: `${site}/zip`, fields: [{ selector: "#zip", slot: "zip" }], submit: "#verify" }]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended } = await replay(page, library, { zip: "94105" });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts).toEqual([`/login username=${username}&password=${password}`]);
});

test("a sign-in whose button switches its form to GET as it fires is refused once, with no second press and no credential in an address", async ({ page }) => {
  // The button counts its clicks and switches its form to GET, which would put the password in
  // the address, so the fill's guard refuses the submission as the click fires.
  const switching = loginPage.replace(
    '<button id="sign-in">',
    `<button id="sign-in" onclick="window.clicks = (window.clicks || 0) + 1; this.form.method = 'get'">`,
  );
  const posts = await serve(page, { "/login": switching }, { "/login": "/login" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const addresses: string[] = [];
  page.on("request", (request) => addresses.push(request.url()));
  const { ended } = await replay(page, library, {});
  expect(ended).toMatchObject({ reason: "submit_refused" });
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
  expect(posts).toEqual([]);
  expect(addresses.filter((address) => address.includes(password) || address.includes(username))).toEqual([]);
});

test("a username state a fuller one holds, whose Continue switches its form to GET as it fires, gets no Enter after the refusal and no username in an address", async ({ page }) => {
  const identifier = `<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button id="next" onclick="window.clicks = (window.clicks || 0) + 1; this.form.method = 'get'">Continue</button></form>`;
  const both = identifier.replace("<button", '<label>Password<input id="pw" type="password"></label><button');
  const posts = await serve(page, { "/login": identifier, "/both": both }, { "/login": "/login" });
  const usernameStep: AutofillRecipeStep = { page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" };
  const library = await recorded(page, [
    usernameStep,
    { ...usernameStep, page: `${site}/both`, fields: [...usernameStep.fields, { selector: "#pw", slot: "password" }] },
  ]);
  await page.goto("about:blank");
  posts.length = 0;
  const addresses: string[] = [];
  page.on("request", (request) => addresses.push(request.url()));
  const { ended } = await replay(page, library, {});
  expect(ended).toMatchObject({ reason: "submit_refused" });
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
  expect(posts).toEqual([]);
  expect(addresses.filter((address) => address.includes(username))).toEqual([]);
});

test("a password page whose form switches to GET once the password is typed sends nothing, alone or in a state a fuller one holds, and no password in an address", async ({ page }) => {
  const passwordPage =
    '<form method="post" action="/password"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form><script>document.getElementById("password").addEventListener("input", (event) => { event.target.form.method = "get"; });</script>';
  // The same page with a code box drawn beside the password, as a page that asks for both.
  const both = passwordPage.replace("<button", '<label>Code<input id="otp" autocomplete="one-time-code"></label><button');
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button id="next">Next</button></form>';
  const posts = await serve(page, { "/login": identifier, "/password": passwordPage, "/both": both }, { "/login": "/password" });
  const usernameStep: AutofillRecipeStep = { page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" };
  const passwordStep: AutofillRecipeStep = { page: `${site}/password`, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" };
  const fuller: AutofillRecipeStep = { ...passwordStep, page: `${site}/both`, fields: [...passwordStep.fields, { selector: "#otp", slot: "code" }] };
  for (const steps of [[usernameStep, passwordStep], [usernameStep, passwordStep, fuller]]) {
    const library = await recorded(page, steps);
    await page.goto("about:blank");
    posts.length = 0;
    const addresses: string[] = [];
    const heard = (request: { url: () => string }) => void addresses.push(request.url());
    page.on("request", heard);
    const { ended } = await replay(page, library, {});
    page.off("request", heard);
    expect(ended.outcome).not.toBe("signed_in");
    expect(posts).toEqual([`/login username=${username}`]);
    expect(addresses.filter((address) => address.includes(password))).toEqual([]);
  }
});

test("a username box in a form with no button that turns to GET while the replay waits to press Enter gets no Enter and no username in an address", async ({ page }) => {
  // The form submits by POST until 4 s after the last key, then by GET.
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label></form><script>document.getElementById("username").addEventListener("input", () => { clearTimeout(window.turn); window.turn = setTimeout(() => { document.forms[0].method = "get"; }, 4000); });</script>';
  const posts = await serve(page, { "/login": identifier }, { "/login": "/login" });
  const library = await recorded(page, [{ page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }] }]);
  await page.goto("about:blank");
  posts.length = 0;
  const addresses: string[] = [];
  page.on("request", (request) => addresses.push(request.url()));
  const { ended } = await replay(page, library, {});
  expect(ended).toMatchObject({ reason: "credential_target_refused" });
  expect(posts).toEqual([]);
  expect(addresses.filter((address) => address.includes(username))).toEqual([]);
});

test("a sign-in whose button turns to GET after the username was typed and before the password's press gets no press and no credential in an address", async ({ page }) => {
  // About 2.35 s after the last key in the username box, past that box's own fill, the button names GET.
  const turning = loginPage.replace(
    "</form>",
    '</form><script>document.getElementById("username").addEventListener("input", () => { clearTimeout(window.turn); window.turn = setTimeout(() => document.getElementById("sign-in").setAttribute("formmethod", "get"), 2350); });</script>',
  );
  const posts = await serve(page, { "/login": turning }, { "/login": "/login" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const addresses: string[] = [];
  page.on("request", (request) => addresses.push(request.url()));
  const { ended } = await replay(page, library, {});
  expect(ended.outcome).not.toBe("signed_in");
  expect(posts).toEqual([]);
  expect(addresses.filter((address) => address.includes(username) || address.includes(password))).toEqual([]);
});

test("a username box in a form whose only button names GET for help, which turns to GET while the replay waits to press Enter, gets no Enter and no username in an address", async ({ page }) => {
  // The Help button names GET from the start; the form itself submits by POST until 4 s after the
  // last key, then by GET.
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button type="button" formmethod="get">Help</button></form><script>document.getElementById("username").addEventListener("input", () => { clearTimeout(window.turn); window.turn = setTimeout(() => { document.forms[0].method = "get"; }, 4000); });</script>';
  const posts = await serve(page, { "/login": identifier }, { "/login": "/login" });
  const library = await recorded(page, [{ page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }] }]);
  await page.goto("about:blank");
  posts.length = 0;
  const addresses: string[] = [];
  page.on("request", (request) => addresses.push(request.url()));
  const { ended } = await replay(page, library, {});
  expect(addresses.filter((address) => address.includes(username))).toEqual([]);
  expect(posts).toEqual([]);
  expect(ended).toMatchObject({ reason: "credential_target_refused" });
});

test("a sign-in form with a button that names GET for help, whose own method turns to GET after the username was typed and before the password's press, gets no press and no credential in an address", async ({ page }) => {
  const pages: Record<string, string> = {};
  const posts = await serve(page, pages, { "/login": "/login" });
  for (const after of [2300, 2350, 2400]) {
    // The Help button names GET from the start; the form turns to GET that long after the last key
    // in the username box, past that box's own fill.
    pages["/login"] = loginPage.replace(
      "</form>",
      `<button type="button" formmethod="get">Help</button></form><script>document.getElementById("username").addEventListener("input", () => { clearTimeout(window.turn); window.turn = setTimeout(() => { document.forms[0].method = "get"; }, ${after}); });</script>`,
    );
    const library = await recorded(page, [login]);
    await page.goto("about:blank");
    posts.length = 0;
    const addresses: string[] = [];
    const heard = (request: { url: () => string }) => void addresses.push(request.url());
    page.on("request", heard);
    const { ended } = await replay(page, library, {});
    page.off("request", heard);
    expect(ended.outcome).not.toBe("signed_in");
    expect(posts).toEqual([]);
    expect(addresses.filter((address) => address.includes(username) || address.includes(password))).toEqual([]);
  }
});

test("a username box outside the form its password and button post signs in", async ({ page }) => {
  const split =
    '<label>Username<input id="username" name="username"></label><form method="post" action="/login"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>';
  const posts = await serve(page, { "/login": split, "/home": '<p id="account">Your account</p>' }, { "/login": "/home" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended } = await replay(page, library, {});
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts).toEqual([`/login password=${password}`]);
});

test("a username box outside a form with no method, whose page sends the password with its own code, signs in", async ({ page }) => {
  // The form names no method, so it reads as GET all along; the page's code posts the password.
  const split =
    '<label>Username<input id="username" name="username"></label><form action="/login"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form><script>document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); fetch("/login", { method: "POST", body: new URLSearchParams(new FormData(event.target)) }).then(() => location.replace("/home")); });</script>';
  const posts = await serve(page, { "/login": split, "/home": '<p id="account">Your account</p>' }, { "/login": "/home" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended } = await replay(page, library, {});
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts).toEqual([`/login password=${password}`]);
});

test("a username box outside the password's form, which the page moves into that form and turns to GET after the username was typed, gets no press and no credential in an address", async ({ page }) => {
  const pages: Record<string, string> = {};
  const posts = await serve(page, pages, { "/login": "/login" });
  for (const after of [2300, 2400]) {
    pages["/login"] =
      `<label id="name">Username<input id="username" name="username"></label><form method="post" action="/login"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form><script>document.getElementById("username").addEventListener("input", () => { clearTimeout(window.turn); window.turn = setTimeout(() => { document.forms[0].prepend(document.getElementById("name")); document.forms[0].method = "get"; }, ${after}); });</script>`;
    const library = await recorded(page, [login]);
    await page.goto("about:blank");
    posts.length = 0;
    const addresses: string[] = [];
    const heard = (request: { url: () => string }) => void addresses.push(request.url());
    page.on("request", heard);
    const { ended } = await replay(page, library, {});
    page.off("request", heard);
    expect(addresses.filter((address) => address.includes(username) || address.includes(password))).toEqual([]);
    expect(posts).toEqual([]);
    expect(ended.outcome).not.toBe("signed_in");
  }
});

test("a username box in a form with no button that posts to another path on its site while the replay waits to press Enter has Enter sent there and signs in", async ({ page }) => {
  // The form posts to another path of the same site from 4 s after the last key.
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label></form><script>document.getElementById("username").addEventListener("input", () => { clearTimeout(window.turn); window.turn = setTimeout(() => { document.forms[0].action = "/login/next"; }, 4000); });</script>';
  const posts = await serve(page, { "/login": identifier, "/home": '<p id="account">Your account</p>' }, { "/login/next": "/home" });
  const library = await recorded(page, [{ page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }] }]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended } = await replay(page, library, {});
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts).toEqual([`/login/next username=${username}`]);
});

test("a code page right after the username, before any password, gets no code", async ({ page }) => {
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button id="next">Next</button></form>';
  const posts = await serve(page, { "/login": identifier, "/verify": verify }, { "/login": "/verify" });
  const library = await recorded(page, [{ page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" }]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code: "246810" });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(asked).toEqual([]);
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([]);
});

test("a code page right after the username of a login with no password is answered once and signs in", async ({ page }) => {
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button id="next">Next</button></form>';
  const posts = await serve(
    page,
    { "/login": identifier, "/verify": verify, "/home": '<p id="account">Your account</p>' },
    { "/login": "/verify", "/verify": "/home" },
  );
  const library = await recorded(page, [{ page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" }]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code: "246810" }, undefined, { username });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(asked).toEqual(["code"]);
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual(["/verify code=246810"]);
});

// A site that emailed a sign-in link when its states were learned shows a code box this time, where
// the link's page was. Its code is one the site sent, so a host's own, as from an authenticator
// seed, never goes in; with no code given, the link's own question is asked.
const checkEmail = '<h1>Check your email</h1><p>We sent you a link to sign in.</p>';
const emailedLink: AutofillRecipeStep = { page: `${site}/check-email`, fields: [], approval: "email_link" };

test("a code box where an emailed link's page was takes the site's code, never the host's own", async ({ page }) => {
  const posts = await serve(
    page,
    { "/login": loginPage, "/check-email": checkEmail, "/verify": verify, "/home": '<p id="account">Your account</p>' },
    { "/login": "/verify", "/verify": "/home" },
  );
  const library = await recorded(page, [login, emailedLink]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended } = await replay(page, library, {}, () => ({
    login: (base, step) => ({ ...base, seedAllowed: step.seedAllowed }),
    code: (held) =>
      Effect.succeed({ slot: "code" as const, value: (held as { seedAllowed?: boolean }).seedAllowed === true ? "111111" : "246810" }),
  }));
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual(["/verify code=246810"]);
});

test("a code box where an emailed link's page was, with no code given, asks for the link instead", async ({ page }) => {
  const link = `${site}/magic/AbCdEf0123456789`;
  const posts = await serve(
    page,
    { "/login": loginPage, "/check-email": checkEmail, "/verify": verify, "/magic/AbCdEf0123456789": '<p id="account">Your account</p>' },
    { "/login": "/verify" },
  );
  const library = await recorded(page, [login, { ...emailedLink, delivery: "paste" }]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { sign_in_link: link });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(asked).toEqual(["code", "sign_in_link"]);
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([]);
});

test("a page with a password box beside a code box after the username is no emailed link's page, at its address or another", async ({ page }) => {
  const named: AutofillRecipeStep = { page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" };
  const typed: AutofillRecipeStep = { page: `${site}/password`, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" };
  const both =
    '<form method="post" action="/both"><label>Password<input id="password" name="password" type="password"></label><label>Verification code<input id="otp" name="otp" autocomplete="one-time-code" inputmode="numeric"></label><button id="verify">Verify</button></form>';
  const pages: Record<string, string> = {
    "/login": '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button id="next">Next</button></form>',
    "/password": '<form method="post" action="/password"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
    "/check-email": checkEmail,
  };
  const posts = await serve(page, pages, { "/login": "/both" });
  // One sign-in sent the password after the username, and another was emailed a link, learned on
  // its own page or on the one this page now shows.
  for (const at of ["/check-email", "/both"]) {
    pages["/both"] = checkEmail;
    const linked = appendSignInStates(await recorded(page, [named, typed]), {
      states: (await recorded(page, [named, { ...emailedLink, page: `${site}${at}` }])).states,
      signedIn: { selector: "#account" },
    });
    if ("refused" in linked) throw new Error(linked.refused);
    pages["/both"] = both;
    await page.goto("about:blank");
    posts.length = 0;
    const { ended, asked } = await replay(page, linked.library, { code: "246810" });
    expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
    expect(asked).toEqual([]);
    expect(posts).toEqual([`/login username=${username}`]);
  }
});

/**
 * A page after the password asking to remember the device, recorded so, that asks about the
 * browser at the run, with a library of the login state and that page recorded in one sign-in
 * (`led`) and one where no sign-in learned the page after the login state (`apart`).
 */
const reworded = async (page: Page) => {
  const trust = (word: string) =>
    `<h1>Remember this ${word}?</h1><p>You won't need a code here next time.</p><form method="post" action="/trust"><button id="remember" name="remember" value="yes">Remember</button><button id="not-now" name="remember" value="no">Not now</button></form>`;
  const pages: Record<string, string> = { "/login": loginPage, "/trust": trust("device"), "/home": '<p id="account">Your account</p>' };
  const posts = await serve(page, pages, { "/login": "/trust", "/trust": "/home" });
  const step: AutofillRecipeStep = { page: `${site}/trust`, fields: [], submit: "#not-now" };
  const led = await recorded(page, [login, step]);
  const fingerprint = led.states[1]?.fingerprint;
  if (fingerprint === undefined) throw new Error("The page after the password was not recorded");
  const apart = appendSignInStates(await recorded(page, [login]), { states: [{ fingerprint, step }], signedIn: { selector: "#account" } });
  if ("refused" in apart) throw new Error(apart.refused);
  pages["/trust"] = trust("browser");
  await page.goto("about:blank");
  posts.length = 0;
  return { posts, led, apart: apart.library };
};

test("a page after the password whose question the site reworded is taken by its control where the login state led to it", async ({ page }) => {
  const { posts, led } = await reworded(page);
  const { ended } = await replay(page, led, {});
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts).toEqual([`/login username=${username}&password=${password}`, "/trust remember=no"]);
});

test("a reworded page after the password that no sign-in learned after the login state stays unknown", async ({ page }) => {
  const { posts, apart } = await reworded(page);
  const { ended } = await replay(page, apart, {});
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(posts).toEqual([`/login username=${username}&password=${password}`]);
});
