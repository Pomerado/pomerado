import { Duration, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import type { SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { appendSignInStates } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers, Question } from "../../src/runtime/input-request.js";
import {
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
} from "../../src/runtime/sign-in-replay.js";
import type { AutofillReplayTiming } from "../../src/runtime/autofill-replay-steps.js";
import { parseHtml } from "../../src/runtime/html.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";
import { runSignInBefore } from "../../src/standalone/session-sign-in.js";

// A run's sign-in through the screens a site may put after the login: a date of birth, a combined
// password and code screen, a method choice, an approval, a screen the site skips this time, an
// account page the recipe opens, a submit the page keeps disabled and a security question that
// changes. Each site is a script: the screens and what a fill of each does.

const origin = "https://www.example.test";
const site = "example.test";
const login = { username: "ada-owner", password: "synthetic-password" };
const code = "482913";

/** What a fill of a screen did: where the page went, and what it shows and holds then. */
interface FillReply {
  readonly next?: string;
  /** The session is signed in from now on. */
  readonly signIn?: boolean;
  /** The rejection markers the page shows afterwards. */
  readonly markers?: readonly string[];
  /** The fields that still hold a value afterwards; every other field shows empty. */
  readonly kept?: readonly string[];
  /** The fill's own report, in place of a filled screen whose submit was clicked. */
  readonly report?: AutofillStepReport;
}
interface SiteScript {
  /** Each page's visible controls, by page name. */
  readonly screens: Readonly<Record<string, readonly string[]>>;
  /** The page the entry address opens. */
  readonly entry: string;
  /** What a fill of `page` with `values` does. */
  readonly fill: (page: string, values: readonly string[], count: number) => FillReply;
  /** The pages that show the signed-in marker once the session is signed in. */
  readonly signedInPages?: readonly string[];
  /** The text each page's elements show, by page name and selector. */
  readonly texts?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Markup a page shows besides its listed controls, whose one match of a selector is a control. */
  readonly markup?: Readonly<Record<string, string>>;
}

/** A scripted site and the run's trace on it: page loads, fills and the owner's questions. */
const scriptedSite = (script: SiteScript) => {
  const state = {
    page: script.entry,
    signedIn: false,
    markers: new Set<string>(),
    kept: new Set<string>(),
  };
  const trace: string[] = [];
  const fills: { readonly page: string; readonly values: readonly string[] }[] = [];
  const at = (page: string) => `${origin}/${page}`;
  const go = (page: string) => {
    state.page = page;
    state.markers = new Set();
    state.kept = new Set();
  };
  const markup = (page: string) => {
    const html = script.markup?.[page];
    return html === undefined ? undefined : parseHtml(`<html><body>${html}</body></html>`);
  };
  const shows = (selector: string) =>
    script.screens[state.page]?.includes(selector) === true ||
    markup(state.page)?.select(selector).length === 1;
  const browser: SignInReplayBrowser<never> = {
    inspect: (step) =>
      Effect.sync((): AutofillInspection | { readonly outcome: "refused"; readonly reason: "not_found" } => {
        const selectors = [
          ...step.fields.map((field) => field.selector),
          ...(step.submit === undefined ? [] : [step.submit]),
        ];
        if (!selectors.every(shows)) return { outcome: "refused", reason: "not_found" };
        const target = (selector: string) => ({
          ownerUrl: at(state.page),
          documentOrigin: origin,
          actions: [at(state.page)],
          methods: ["post"],
          editable: true,
          control: "text" as const,
          empty: !state.kept.has(selector),
        });
        return {
          url: at(state.page),
          page: at(state.page),
          targets: {
            fields: step.fields.map((field) => target(field.selector)),
            submit: step.submit === undefined ? null : target(step.submit),
          },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({
              tag: "input",
              role: null,
              formMethod: "post",
              type: "text",
              name: null,
              id: null,
              autocomplete: null,
              inputmode: null,
              label: "Field",
              placeholder: null,
              ariaLabel: null,
              text: null,
              slot: field.slot,
              ...(field.slot === "private_answer" ? { questionText: "First pet?" } : {}),
            })),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step, values }) =>
      Effect.sync((): AutofillStepReport => {
        const page = state.page;
        const count = fills.filter((fill) => fill.page === page).length;
        fills.push({ page, values: [...values] });
        trace.push(`fill:${page}`);
        const reply = script.fill(page, values, count);
        const report = reply.report ?? {
          outcome: "filled",
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked",
          url: at(reply.next ?? page),
        };
        if (reply.signIn === true) state.signedIn = true;
        if (reply.next !== undefined) go(reply.next);
        state.markers = new Set(reply.markers ?? []);
        state.kept = new Set(reply.kept ?? []);
        return report;
      }),
    confirm: (indicator) =>
      Effect.sync((): AutofillSignedInCheck => {
        if (indicator.openPath !== undefined) {
          trace.push(`open:${indicator.openPath}`);
          go(indicator.openPath.replace(/^\//u, ""));
        }
        return state.signedIn && (script.signedInPages ?? ["account"]).includes(state.page)
          ? { signedIn: true, url: at(state.page) }
          : { signedIn: false, failed: "indicator_not_visible", url: at(state.page) };
      }),
    authenticationOrigins: [],
    open: (url) =>
      Effect.sync(() => {
        trace.push(`open:${new URL(url).pathname}`);
        go(script.entry);
      }),
    markerVisible: (selector) => Effect.sync(() => state.markers.has(selector)),
    approvalNumber: (selector) => Effect.sync(() => script.texts?.[state.page]?.[selector]),
  };
  return {
    browser,
    state,
    trace,
    fills,
    /** Signs the session in and shows the account, as the owner's approval does. */
    approve: () => {
      state.signedIn = true;
      go("account");
    },
    filled: (page: string) => fills.filter((fill) => fill.page === page).map(({ values }) => values),
  };
};
type ScriptedSite = ReturnType<typeof scriptedSite>;

/** The owner's answers, each question in turn; every question goes on the site's trace. */
interface Answers {
  readonly codes?: string[];
  readonly dates?: string[];
  readonly method?: string;
  readonly confirm?: boolean;
  /** The sign-in link the owner pastes. */
  readonly link?: string;
  /** The owner gives no code when asked for one. */
  readonly noCode?: boolean;
}
const owner = (fake: ScriptedSite, answers: Answers = {}) => {
  const codes = [...(answers.codes ?? [code])];
  const dates = [...(answers.dates ?? [])];
  const prompts: string[] = [];
  const reply = (question: Question) => {
    prompts.push(question.prompt);
    if (question.type === "credential") {
      fake.trace.push(`ask:${question.reason}`);
      return { ...login, saveLogin: false };
    }
    fake.trace.push(`ask:${question.id}`);
    if (question.type === "choice") return answers.method ?? question.options[0]?.id;
    if (question.type === "confirm") {
      if (answers.confirm !== false) fake.approve();
      return { confirmed: answers.confirm !== false };
    }
    if (question.id === "code") return answers.noCode === true ? undefined : (codes.shift() ?? code);
    if (question.id === "date_of_birth") return dates.shift() ?? "1990-04-12";
    if (question.id === "sign_in_link") return answers.link ?? "synthetic-answer";
    return "synthetic-answer";
  };
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(request.questions.map((question) => [question.id, reply(question)])) as InputAnswers,
    ),
  );
  return { ask, prompts };
};

const fastTiming: AutofillReplayTiming = { stepWaitMs: 60, pollMs: 2 };
const signIn = (
  recipe: SignInRecipe,
  fake: ScriptedSite,
  answers: Answers = {},
  timing: AutofillReplayTiming = fastTiming,
  allowCantTell = false,
) => {
  const secrets = makeRunSecrets();
  const { ask, prompts } = owner(fake, answers);
  return Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${origin}/${fake.state.page}`,
        browser: fake.browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: origin }),
        ask,
        secrets,
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
        site,
        siteOrigin: origin,
        timing,
        ...(allowCantTell ? { allowCantTell } : {}),
      }),
    ),
  ).then((result) => ({ result, prompts }));
};
/** The owner's questions and the fills, in order, without the page loads. */
const steps = (fake: ScriptedSite) => fake.trace.filter((entry) => !entry.startsWith("open:"));

const loginScreen = ["#username", "#password", "#sign-in"];
const loginStep = {
  page: `${origin}/login`,
  fields: [
    { selector: "#username", accepts: ["username" as const] },
    { selector: "#password", slot: "password" as const },
  ],
  submit: "#sign-in",
  submittedBy: "host" as const,
};
const signedLogin = (values: readonly string[]) =>
  values[0] === login.username && values[1] === login.password;
const codeStep = {
  page: `${origin}/code`,
  fields: [{ selector: "#code", slot: "code" as const }],
  submit: "#verify",
};
const methodStep = {
  page: `${origin}/method`,
  fields: [],
  submit: "#by-text",
  methods: [
    { method: "sms" as const, selector: "#by-text" },
    { method: "totp" as const, selector: "#by-app" },
  ],
};
const recipe = (...steps: SignInRecipe["steps"][number][]): SignInRecipe => ({
  version: 2,
  steps: steps as SignInRecipe["steps"],
  signedIn: { selector: "#account" },
});

// A date of birth the site rejects is corrected on its own screen, never sent again.
const dateSite = () =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, verify: ["#dob", "#confirm"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "verify" }
          : {}
        : values[0] === "1990-04-12"
          ? { next: "account", signIn: true }
          : { markers: ["#dob-error"] },
  });
const dateStep = {
  page: `${origin}/verify`,
  fields: [{ selector: "#dob", slot: "date_of_birth" as const }],
  submit: "#confirm",
  rejectedMarkers: [{ slot: "date_of_birth" as const, selector: "#dob-error" }],
};

it("corrects a rejected date of birth on the screen that took it, asking again for a correction that repeats it", async () => {
  const fake = dateSite();
  const { result } = await signIn(recipe(loginStep, dateStep), fake, {
    dates: ["1990-01-01", "1990-01-01", "1990-04-12"],
  });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual([
    "ask:missing_credentials",
    "fill:login",
    "ask:date_of_birth",
    "fill:verify",
    "ask:date_of_birth",
    "ask:date_of_birth",
    "fill:verify",
  ]);
  expect(fake.filled("verify")).toEqual([["1990-01-01"], ["1990-04-12"]]);
  expect(fake.filled("login")).toHaveLength(1);
});

it("fails CredentialsRejected for a date of birth once its two corrections were rejected", async () => {
  const fake = dateSite();
  const { result } = await signIn(recipe(loginStep, dateStep), fake, {
    dates: ["1990-01-01", "1990-02-02", "1990-03-03"],
  });
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "date_of_birth" })),
  );
  expect(fake.filled("verify")).toEqual([["1990-01-01"], ["1990-02-02"], ["1990-03-03"]]);
});

// A screen that takes the password and a code together: a rejected code clears the password.
const combinedSite = () =>
  scriptedSite({
    entry: "identify",
    screens: { identify: ["#username", "#next"], verify: ["#password", "#code", "#verify"], account: [] },
    fill: (page, values) =>
      page === "identify"
        ? { next: "verify" }
        : values[0] === login.password && values[1] === code
          ? { next: "account", signIn: true }
          : { markers: ["#code-error"] },
  });
const identifyStep = {
  page: `${origin}/identify`,
  fields: [{ selector: "#username", accepts: ["username" as const] }],
  submit: "#next",
};
const combinedStep = {
  page: `${origin}/verify`,
  fields: [
    { selector: "#password", slot: "password" as const },
    { selector: "#code", slot: "code" as const },
  ],
  submit: "#verify",
};

it("fills a combined screen again with a fresh code and its emptied password after the code was rejected", async () => {
  const fake = combinedSite();
  const marked = { ...combinedStep, rejectedMarkers: [{ slot: "code" as const, selector: "#code-error" }] };
  const { result } = await signIn(recipe(identifyStep, marked), fake, { codes: ["111111", code] });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.filled("verify")).toEqual([
    [login.password, "111111"],
    [login.password, code],
  ]);
});

it("fails RecipeFailed when a combined screen empties its password with no marker saying which half was wrong", async () => {
  const fake = combinedSite();
  const { result } = await signIn(recipe(identifyStep, combinedStep), fake, { codes: ["111111", code] });
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "ambiguous_combined_rejection" })),
  );
  expect(fake.filled("verify")).toEqual([[login.password, "111111"]]);
});

it("goes on past a recorded method choice the site skips this time", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, method: ["#by-text", "#by-app"], code: ["#code", "#verify"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "code" }
          : {}
        : { next: "account", signIn: values[0] === code },
  });
  const { result } = await signIn(recipe(loginStep, methodStep, codeStep), fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login", "ask:code", "fill:code"]);
});

it("omits the recorded password when the identifier goes straight to the method choice", async () => {
  const passwordStep = {
    page: `${origin}/password`,
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#sign-in",
  };
  const fake = scriptedSite({
    entry: "identify",
    screens: {
      identify: ["#username", "#next"],
      password: ["#password", "#sign-in"],
      method: ["#by-text", "#by-app"],
      code: ["#code", "#verify"],
      account: [],
    },
    fill: (page, values) =>
      page === "identify"
        ? { next: "method" }
        : page === "method"
          ? { next: "code" }
          : { next: "account", signIn: values[0] === code },
  });
  const { result } = await signIn(recipe(identifyStep, passwordStep, methodStep, codeStep), fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.fills.map(({ page }) => page)).toEqual(["identify", "method", "code"]);
  expect(fake.fills.flatMap(({ values }) => values)).not.toContain(login.password);
});

// After the login the site trusts the device and lands on its home page, which doesn't show the
// marker; the account page the recipe names does. No check of the session opens that page.
const skippedCodeSite = () =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, code: ["#code", "#verify"], home: [], account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "home", signIn: true } : {}),
  });
const accountRecipe = () => ({
  ...recipe(loginStep, codeStep),
  signedIn: { selector: "#account", openPath: "/account" },
});

it("signs a read in once the site lands off the recorded screens past a skipped code screen, opening no account page", { timeout: 20_000 }, async () => {
  const fake = skippedCodeSite();
  // The code screen's wait runs to its deadline, and the marker wait then ends once the landing
  // page stayed put 1.5 s.
  const { result } = await signIn(accountRecipe(), fake, {}, { stepWaitMs: 2_000, pollMs: 20 }, true);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.trace).toEqual(["open:/login", "ask:missing_credentials", "open:/login", "fill:login"]);
});

// A write's sign-in still needs its marker: it waits out the skipped code screen, then its sign-in
// check, whose last check alone opens the account page, finds the session.
it("waits out a write's skipped code screen when its landing shows no marker, then signs in at the last check, which alone opens the account page", { timeout: 20_000 }, async () => {
  const fake = skippedCodeSite();
  const { result } = await signIn(accountRecipe(), fake, {}, { stepWaitMs: 2_000, pollMs: 20 });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.trace).toEqual([
    "open:/login",
    "ask:missing_credentials",
    "open:/login",
    "fill:login",
    "open:/account",
  ]);
});

// The local host sets `startedEmpty` on a new browser's sign-in, so a read's check without values never takes
// a blank login page for a signed-in one: it waits for the form the page draws late, then asks.
it("asks a read's login when its entry page draws the form late, since a local sign-in on a new browser sets startedEmpty", { timeout: 20_000 }, async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "account", signIn: true } : {}),
  });
  let openedAt = Date.now();
  const drawnAfterMs = 2_500;
  const browser: SignInReplayBrowser<never> = {
    ...fake.browser,
    open: (url) =>
      fake.browser.open(url).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            openedAt = Date.now();
          }),
        ),
      ),
    inspect: (step) =>
      Date.now() - openedAt < drawnAfterMs
        ? Effect.succeed({ outcome: "refused" as const, reason: "not_found" as const })
        : fake.browser.inspect(step),
  };
  const { result } = await signIn(
    recipe(loginStep),
    { ...fake, browser },
    {},
    { stepWaitMs: 8_000, pollMs: 20 },
    true,
  );
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.trace).toEqual(["open:/login", "ask:missing_credentials", "open:/login", "fill:login"]);
});

/**
 * A run's first sign-in as a library scope makes it, on a browser this host already typed a sign-in
 * into (`typed`) or on a new one. The marker shows only on the recipe's account page.
 */
const signInBefore = (
  fake: ScriptedSite,
  browser: SignInReplayBrowser<never>,
  typed: boolean,
  allowCantTell: boolean,
  accountPage = true,
) => {
  const secrets = makeRunSecrets();
  const { ask } = owner(fake);
  return Effect.runPromise(
    Effect.either(
      runSignInBefore(() => typed, {
        recipe: {
          ...recipe(loginStep),
          signedIn: { selector: "#account", ...(accountPage ? { openPath: "/account" } : {}) },
        },
        entryUrl: `${origin}/login`,
        browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: origin }),
        ask,
        secrets,
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
        site,
        siteOrigin: origin,
        timing: { stepWaitMs: 3_000, pollMs: 20 },
        ...(allowCantTell ? { allowCantTell } : {}),
      }),
    ),
  );
};

/**
 * A site whose session the browser already holds: its login address sends a signed-in browser on
 * to its home page (`redirect`), or shows it a page of its own with no form (`static`).
 */
const signedInSite = (login: "redirect" | "static") => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, home: [], account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "account", signIn: true } : {}),
  });
  fake.state.signedIn = true;
  const browser: SignInReplayBrowser<never> = {
    ...fake.browser,
    open: (url) =>
      fake.browser.open(url).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (login === "redirect" && fake.state.signedIn) fake.state.page = "home";
          }),
        ),
      ),
    inspect: (step) =>
      login === "static" && fake.state.signedIn && fake.state.page === "login"
        ? Effect.succeed({ outcome: "refused" as const, reason: "not_found" as const })
        : fake.browser.inspect(step),
  };
  return { fake, browser };
};

it.each([
  ["a write whose login address sends it home", "redirect", false],
  ["a read whose login address shows a page of its own", "static", true],
] as const)(
  "signs nothing in on a browser this host already signed in, for %s, once the account page shows the marker",
  { timeout: 20_000 },
  async (_, login, read) => {
    const { fake, browser } = signedInSite(login);
    const result = await signInBefore(fake, browser, true, read);
    expect(result).toEqual(Either.right({ alreadySignedIn: true }));
    expect(fake.trace).toEqual(["open:/account"]);
  },
);

// A library scope's later run reuses the browser this host already signed in (`typed`), which is no
// browser that started empty: a read whose login address sends the signed-in browser on to a page
// of its own signs in on that page that can't tell, as any browser with a session may.
it("signs a read in where its login address sends a browser this host already signed in, which started no empty browser", { timeout: 20_000 }, async () => {
  const { fake, browser } = signedInSite("redirect");
  const result = await signInBefore(fake, browser, true, true, false);
  expect(result).toEqual(Either.right({ alreadySignedIn: true }));
  expect(fake.trace).toEqual(["open:/login"]);
});

// On a browser this host already signed in whose session ended, the local host reads no page
// state, so its untouched entry page never ends a read's check without values: it waits for the
// login form the page draws late, then asks.
it("asks a read's login on a browser this host typed into whose session ended, when its login form draws late", { timeout: 20_000 }, async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "account", signIn: true } : {}),
  });
  let openedAt = Date.now();
  const browser: SignInReplayBrowser<never> = {
    ...fake.browser,
    open: (url) =>
      fake.browser.open(url).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            openedAt = Date.now();
          }),
        ),
      ),
    inspect: (step) =>
      Date.now() - openedAt < 2_500
        ? Effect.succeed({ outcome: "refused" as const, reason: "not_found" as const })
        : fake.browser.inspect(step),
  };
  const result = await signInBefore(fake, browser, true, true);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.trace).toEqual([
    "open:/account",
    "open:/login",
    "ask:missing_credentials",
    "open:/login",
    "fill:login",
  ]);
});

it("replays after the account page on a browser this host typed into whose session ended", { timeout: 20_000 }, async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "account", signIn: true } : {}),
  });
  const result = await signInBefore(fake, fake.browser, true, false);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.trace).toEqual([
    "open:/account",
    "open:/login",
    "ask:missing_credentials",
    "open:/login",
    "fill:login",
  ]);
});

it("opens no account page first on a new browser", { timeout: 20_000 }, async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "account", signIn: true } : {}),
  });
  const result = await signInBefore(fake, fake.browser, false, false);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.trace).toEqual(["open:/login", "ask:missing_credentials", "open:/login", "fill:login"]);
});

it("never fills a password a later screen asks for again after it went out", async () => {
  // The same box on another page is another screen, not the login screen shown again.
  const againStep = {
    page: `${origin}/again`,
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#again",
  };
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, again: ["#password", "#again"], account: [] },
    fill: (page, values) =>
      page === "login" && signedLogin(values) ? { next: "again" } : { next: "account", signIn: true },
  });
  const { result } = await signIn(recipe(loginStep, againStep), fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_already_filled" })),
  );
  expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
});

it("ends with no verdict when the screen just submitted shows again as a later recorded screen with no error marker", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: () => ({}),
  });
  const { result } = await signIn(recipe(loginStep, loginStep), fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_screen_returned" })),
  );
  expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
});

// A site that asks for the password again with a one-time code: the first password submit is
// answered with a screen that shows the password field empty beside a code field.
const lateCodeStep = {
  page: `${origin}/login-code`,
  fields: [
    { selector: "#password", slot: "password" as const },
    { selector: "#code", slot: "code" as const },
  ],
  refills: ["password" as const],
  submit: "#sign-in",
};
const lateCodeRecipe = (...steps: SignInRecipe["steps"][number][]): SignInRecipe => ({
  version: 5,
  steps: steps as SignInRecipe["steps"],
  signedIn: { selector: "#account" },
});
const lateCodeSite = (codeScreen: readonly string[] = ["#password", "#code", "#sign-in"]) =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, "login-code": codeScreen, account: [] },
    fill: (page, values) => {
      if (page === "login") return signedLogin(values) ? { next: "login-code" } : {};
      if (values[0] === login.password && values[1] === code)
        return { next: "account", signIn: true };
      return { markers: ["#code-error"] };
    },
  });

// A site whose next screen asks for the password again on its own, which the recipe records as a
// refill (`refills`): the replay enters it once there, and never a third time.
const againRefill = {
  page: `${origin}/again`,
  fields: [{ selector: "#password-again", slot: "password" as const }],
  refills: ["password" as const],
  rejectedMarkers: [{ slot: "password" as const, selector: "#password-error" }],
  submit: "#again",
};
const againSite = (accepted: boolean) =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, again: ["#password-again", "#again"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "again" }
          : {}
        : accepted && values[0] === login.password
          ? { next: "account", signIn: true }
          : { markers: ["#password-error"] },
  });

it("enters the password again on a later screen the recipe records as asking for it again", async () => {
  const fake = againSite(true);
  const { result } = await signIn(lateCodeRecipe(loginStep, againRefill), fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.filled("again")).toEqual([[login.password]]);
});

it("takes the site's error after a recorded refill of the password as its rejection, never sending it a third time", async () => {
  const fake = againSite(false);
  const { result } = await signIn(lateCodeRecipe(loginStep, againRefill), fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })),
  );
  const passwords = fake.fills.flatMap(({ values }) =>
    values.filter((value) => value === login.password),
  );
  expect(passwords).toHaveLength(2);
});

it("takes the site's error on a login screen still showing as a rejection before a recorded refill of the password in its box", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: () => ({ markers: ["#password-error"] }),
  });
  const sameBox = {
    ...againRefill,
    page: `${origin}/login`,
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#sign-in",
  };
  const { result } = await signIn(lateCodeRecipe(loginStep, sameBox), fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })),
  );
  expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
});

it("enters the password again with the code on a screen the recipe records as asking for both", async () => {
  const fake = lateCodeSite();
  const { result } = await signIn(lateCodeRecipe(loginStep, lateCodeStep), fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.filled("login")).toEqual([[login.username, login.password]]);
  expect(fake.filled("login-code")).toEqual([[login.password, code]]);
});

it("never sends the password a third time when the code the screen took with it is rejected", async () => {
  const fake = lateCodeSite();
  const marked = {
    ...lateCodeStep,
    rejectedMarkers: [{ slot: "code" as const, selector: "#code-error" }],
  };
  const { result } = await signIn(lateCodeRecipe(loginStep, marked), fake, {
    codes: ["111111", code],
  });
  expect(Either.isLeft(result)).toBe(true);
  const passwords = fake.fills.flatMap(({ values }) =>
    values.filter((value) => value === login.password),
  );
  expect(passwords).toHaveLength(2);
});

it("refuses a recorded refill on a screen whose second factor already went out", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: {
      login: loginScreen,
      code: ["#code", "#verify"],
      "login-code": ["#password", "#code", "#sign-in"],
      account: [],
    },
    fill: (page, values) =>
      page === "login"
        ? { next: "code" }
        : page === "code"
          ? { next: "login-code" }
          : values[0] === login.password
            ? { next: "account", signIn: true }
            : {},
  });
  const { result } = await signIn(lateCodeRecipe(loginStep, codeStep, lateCodeStep), fake, {
    codes: [code, "222222"],
  });
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_already_filled" })),
  );
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "code"]);
});

it("never sends the password a third time through two screens the recipe records as asking for it again", async () => {
  const recoveryStep = {
    page: `${origin}/login-recovery`,
    fields: [
      { selector: "#password", slot: "password" as const },
      { selector: "#recovery", slot: "recovery_code" as const },
    ],
    refills: ["password" as const],
    submit: "#sign-in",
  };
  const fake = scriptedSite({
    entry: "login",
    screens: {
      login: loginScreen,
      "login-recovery": ["#password", "#recovery", "#sign-in"],
      "login-code": ["#password", "#code", "#sign-in"],
      account: [],
    },
    fill: (page) =>
      page === "login"
        ? { next: "login-recovery" }
        : page === "login-recovery"
          ? { next: "login-code" }
          : { next: "account", signIn: true },
  });
  const { result } = await signIn(lateCodeRecipe(loginStep, recoveryStep, lateCodeStep), fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_already_filled" })),
  );
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "login-recovery"]);
  const passwords = fake.fills.flatMap(({ values }) =>
    values.filter((value) => value === login.password),
  );
  expect(passwords).toHaveLength(2);
});

it("asks and fills no third code after two fresh codes were rejected", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, code: ["#code", "#verify"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "code" }
          : {}
        : values[0] === code
          ? { next: "account", signIn: true }
          : { markers: ["#code-error"] },
  });
  const marked = { ...codeStep, rejectedMarkers: [{ slot: "code" as const, selector: "#code-error" }] };
  const { result } = await signIn(recipe(loginStep, marked), fake, {
    codes: ["111111", "222222", "333333", code],
  });
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "code" })));
  expect(fake.filled("code")).toEqual([["111111"], ["222222"], ["333333"]]);
  expect(steps(fake).filter((entry) => entry === "ask:code")).toHaveLength(3);
});

it("reads the login before it picks a method on a recipe whose first screen is the method choice", async () => {
  const fake = scriptedSite({
    entry: "method",
    screens: { method: ["#by-text", "#by-app"], code: ["#code", "#verify"], account: [] },
    fill: (page, values) =>
      page === "method" ? { next: "code" } : { next: "account", signIn: values[0] === code },
  });
  const { result } = await signIn(recipe(methodStep, codeStep), fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  // The value-free check found the choice and stopped before picking, which may send a code.
  expect(fake.trace).toEqual([
    "open:/method",
    "ask:missing_credentials",
    "open:/method",
    "ask:method",
    "fill:method",
    "ask:code",
    "fill:code",
  ]);
});

// An approval off the page: on another device, by an email link, or a push the owner picked.
const approvalSite = (then: string, shown?: string) =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, approve: [], method: ["#by-push", "#by-text"], account: [] },
    fill: (page, values) => (page === "login" && signedLogin(values) ? { next: then } : { next: "approve" }),
    ...(shown === undefined ? {} : { texts: { approve: { "#match": shown } } }),
  });

it.each([
  ["device", "Approve the sign-in request example.test sent to your device, then confirm here."],
  ["email_link", "Open the sign-in link example.test emailed you, then confirm here."],
] as const)("asks the owner to confirm a recorded %s approval, then checks the sign-in", async (approval, prompt) => {
  const fake = approvalSite("approve");
  const { result, prompts } = await signIn(
    recipe(loginStep, { page: `${origin}/approve`, fields: [], approval }),
    fake,
  );
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login", "ask:approved"]);
  expect(prompts.at(-1)).toBe(prompt);
});

// A site's approval page holds a code of its own for each sign-in, so the page a new browser shows
// is never the recorded one: any other page on the recorded page's origin is the approval's screen.
it("asks once for an approval shown on another page of its recorded origin", async () => {
  const fake = approvalSite("checkpoint/BBB");
  const { result } = await signIn(
    recipe(loginStep, { page: `${origin}/checkpoint/AAA`, fields: [], approval: "device" }),
    fake,
  );
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login", "ask:approved"]);
});

// A number-matching approval: the owner picks on the device the number the approval screen shows.
it("names the number a device approval's matchSelector shows", async () => {
  const fake = approvalSite("approve", "42");
  const { result, prompts } = await signIn(
    recipe(loginStep, {
      page: `${origin}/approve`,
      fields: [],
      approval: "device",
      matchSelector: "#match",
    }),
    fake,
  );
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(prompts.at(-1)).toBe(
    "Approve the sign-in request example.test sent to your device, then confirm here. If it asks you to choose a number, pick 42.",
  );
});

// An emailed link that signs in only the browser that opens it: a step recorded with
// `delivery: "paste"` asks the owner for the link and opens it on the run's own browser, and only
// on the site.
const pastedLinkSite = (link: string, fake: ScriptedSite = approvalSite("approve")) => {
  const signIn = fake.approve;
  const open = fake.browser.open;
  return {
    ...fake,
    // The owner's yes alone signs nothing in.
    approve: () => undefined,
    browser: {
      ...fake.browser,
      open: (url: string) =>
        url === link
          ? Effect.sync(() => {
              fake.trace.push(`open:${new URL(url).pathname}`);
              signIn();
            })
          : open(url),
    },
  };
};
const pasteStep = {
  page: `${origin}/approve`,
  fields: [],
  approval: "email_link" as const,
  delivery: "paste" as const,
};

it("asks the owner to paste a recorded email link and opens it on the run's browser", async () => {
  const link = `${origin}/magic/AbCdEf0123456789`;
  const fake = pastedLinkSite(link);
  const { result } = await signIn(recipe(loginStep, pasteStep), fake, { link });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login", "ask:sign_in_link"]);
  expect(fake.trace).toContain("open:/magic/AbCdEf0123456789");
});

// A site that emailed a link when the tool was built may text or email a code this time, on the
// screen where the link's approval was recorded: the code goes in, and nobody is asked for a link.
const codeInPlaceOfLinkSite = () =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, approve: [], account: [] },
    markup: {
      approve:
        '<form><input name="code" inputmode="numeric" maxlength="6"><button type="submit">Submit</button></form>',
    },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "approve" }
          : {}
        : values[0] === code
          ? { next: "account", signIn: true }
          : {},
  });

it.each([
  ["pasted", pasteStep],
  ["opened", { page: `${origin}/approve`, fields: [], approval: "email_link" as const }],
] as const)(
  "types the code a recorded %s email link's screen asks for this time, asking for no link",
  async (_kind, approval) => {
    const fake = codeInPlaceOfLinkSite();
    const { result } = await signIn(recipe(loginStep, approval), fake);
    expect(result).toEqual(Either.right({ alreadySignedIn: false }));
    expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login", "ask:code", "fill:approve"]);
    expect(fake.filled("approve")).toEqual([[code]]);
  },
);

// A host's own code, as from a saved authenticator seed, never goes into a code box on a recorded
// emailed link's screen: the recording says the site emails, so the seed's code would be refused.
it("never types the host's own code into the code box on a recorded email link's screen", async () => {
  const seedCode = "111111";
  const fake = codeInPlaceOfLinkSite();
  const { ask } = owner(fake);
  const hooks: AutofillHooks<never> = {
    inspect: fake.browser.inspect,
    fill: fake.browser.fill,
    check: (indicator, screens) => fake.browser.confirm(indicator, screens, screens),
    confirm: (indicator, _identifiers, screens) => fake.browser.confirm(indicator, screens, screens),
    open: fake.browser.open,
    markerVisible: fake.browser.markerVisible,
  };
  const outcome = await Effect.runPromise(
    Effect.scoped(
      replayAutofillRecipe({
        recipe: recipe(loginStep, pasteStep),
        hooks,
        entryUrl: `${origin}/login`,
        credentials: login,
        ask,
        broker: {
          register: () => Effect.void,
          registeredSecretMatches: () => Effect.succeed([]),
        },
        site,
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: () => new SignInRunFailed({ code: "NeedsInput", reason: "code" }),
          unavailable: () => new SignInRunFailed({ code: "NeedsInput", reason: "unavailable" }),
        },
        sent: { current: false },
        timing: fastTiming,
        hosted: {
          login: (base, step) => ({ ...base, seedAllowed: step.seedAllowed }),
          code: (held) =>
            Effect.succeed({
              slot: "code" as const,
              value: (held as { seedAllowed?: boolean }).seedAllowed === true ? seedCode : code,
            }),
        },
      }),
    ),
  );
  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(fake.filled("approve")).toEqual([[code]]);
});

// A code box beside a recorded emailed link may be for a code the owner can't give, such as an
// authenticator app's: with no code given, the owner is asked for the link, as before.
it("asks for a recorded email link when its screen's code box gets no code", async () => {
  const link = `${origin}/magic/AbCdEf0123456789`;
  const fake = pastedLinkSite(link, codeInPlaceOfLinkSite());
  const { result } = await signIn(recipe(loginStep, pasteStep), fake, { link, noCode: true });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual([
    "ask:missing_credentials",
    "fill:login",
    "ask:code",
    "ask:sign_in_link",
  ]);
  expect(fake.filled("approve")).toEqual([]);
  expect(fake.trace).toContain("open:/magic/AbCdEf0123456789");
});

it("fails RecipeFailed when the owner declines a recorded approval", async () => {
  const fake = approvalSite("approve");
  const { result } = await signIn(
    recipe(loginStep, { page: `${origin}/approve`, fields: [], approval: "device" }),
    fake,
    { confirm: false },
  );
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "approval_declined" })));
});

const pushStep = {
  page: `${origin}/method`,
  fields: [],
  submit: "#by-push",
  methods: [
    { method: "push" as const, selector: "#by-push" },
    { method: "sms" as const, selector: "#by-text" },
  ],
};

it("asks the owner to confirm a push once they pick it, then checks the sign-in", async () => {
  const fake = approvalSite("method");
  const { result, prompts } = await signIn(recipe(loginStep, pushStep), fake, { method: "option_0" });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual([
    "ask:missing_credentials",
    "fill:login",
    "ask:method",
    "fill:method",
    "ask:approved",
  ]);
  expect(prompts.at(-1)).toBe("Approve the sign-in request example.test sent you, then confirm here.");
});

it("fails RecipeFailed when the owner declines a push they picked", async () => {
  const fake = approvalSite("method");
  const { result } = await signIn(recipe(loginStep, pushStep), fake, { method: "option_0", confirm: false });
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "push_declined" })));
});

it("waits again for a fieldless screen whose submit the page kept disabled, then clicks it", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, notice: ["#continue"], account: [] },
    fill: (page, values, count) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "notice" }
          : {}
        : count === 0
          ? {
              report: {
                outcome: "filled",
                fields: [],
                submit: "stayed_disabled",
                url: `${origin}/notice`,
              },
            }
          : { next: "account", signIn: true },
  });
  const { result } = await signIn(
    recipe(loginStep, { page: `${origin}/notice`, fields: [], submit: "#continue" }),
    fake,
    {},
    { stepWaitMs: 2_000, pollMs: 2 },
  );
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.filled("notice")).toHaveLength(2);
});

it("fails RecipeFailed with the fill's refusal when a security question changes before its answer is typed", async () => {
  const questionStep = {
    page: `${origin}/question`,
    fields: [{ selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" }],
    submit: "#continue",
  };
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, question: ["#question", "#answer", "#continue"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "question" }
          : {}
        : {
            report: {
              outcome: "refused",
              reason: "credential_target_refused",
              target: 0,
              failureDetail: {
                subCause: "autofill_step_failed",
                context: { check: "change", cause: "question_changed" },
              },
            },
          },
  });
  const { result } = await signIn({ ...recipe(loginStep, questionStep), version: 3 }, fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_target_refused" })),
  );
});

// Only a fieldless step waits again: a step with fields still wants something besides them.
it("ends a screen with fields whose submit the page kept disabled", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: () => ({
      report: {
        outcome: "filled",
        fields: [
          { slot: "username", status: "filled" },
          { slot: "password", status: "filled" },
        ],
        submit: "stayed_disabled",
        url: `${origin}/login`,
      },
    }),
  });
  const { result } = await signIn(recipe(loginStep), fake);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "submit_stayed_disabled" })),
  );
  expect(fake.filled("login")).toHaveLength(1);
});

// A code widget that sends itself when its last box is filled: the host clicks nothing, and the
// page moving on says the code may have gone out, so the recipe's own check decides what it did.
const pageSentStep = {
  page: `${origin}/code`,
  fields: [{ selector: "#code", slot: "code" as const }],
};
const sentByPage = (page: string): AutofillStepReport => ({
  outcome: "filled",
  fields: [{ slot: "code", status: "filled" }],
  submit: "page",
  url: `${origin}/${page}`,
});
/** Its site: the right code shows the account, and any other draws the code box again, empty. */
const pageSentSite = () =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, code: ["#code"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "code" }
          : {}
        : values[0] === code
          ? { next: "account", signIn: true, report: sentByPage("account") }
          : { report: sentByPage("code") },
  });
const codeRefusedPrompts = (prompts: readonly string[]) =>
  prompts.filter((prompt) => prompt.includes("The site refused the last code."));

it("signs in through the recipe's check when a code screen sends its code itself", async () => {
  const fake = pageSentSite();
  const { result, prompts } = await signIn(recipe(loginStep, pageSentStep), fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login", "ask:code", "fill:code"]);
  expect(codeRefusedPrompts(prompts)).toEqual([]);
});

it("asks for one new code, saying the site refused the last, when a code screen that sent its code itself shows its box again", async () => {
  const fake = pageSentSite();
  const { result, prompts } = await signIn(recipe(loginStep, pageSentStep), fake, {
    codes: ["111111", code],
  });
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(steps(fake)).toEqual([
    "ask:missing_credentials",
    "fill:login",
    "ask:code",
    "fill:code",
    "ask:code",
    "fill:code",
  ]);
  expect(fake.filled("code")).toEqual([["111111"], [code]]);
  expect(codeRefusedPrompts(prompts)).toHaveLength(1);
});

it("takes a code screen that sent its code itself and shows its box again as a refused code, though no request carried it", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, code: ["#code"], account: [] },
    fill: (page, values) =>
      page === "login"
        ? signedLogin(values)
          ? { next: "code" }
          : {}
        : { report: sentByPage("code") },
  });
  const { result, prompts } = await signIn(recipe(loginStep, pageSentStep), fake);
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "code" })));
  // The box showing again refuses the code: it is asked again, saying so, and an answer that
  // repeats the refused code is never filled.
  expect(steps(fake)).toEqual([
    "ask:missing_credentials",
    "fill:login",
    "ask:code",
    "fill:code",
    "ask:code",
    "ask:code",
  ]);
  expect(codeRefusedPrompts(prompts)).toHaveLength(2);
});

it("never takes a code screen that sent its code itself for signed in while the site keeps showing it", async () => {
  const fake = pageSentSite();
  const { result } = await signIn(recipe(loginStep, pageSentStep), fake, {
    codes: ["111111", "222222", "333333", code],
  });
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "code" })));
  expect(fake.filled("code")).toEqual([["111111"], ["222222"], ["333333"]]);
});

// An approval before any request carried the login's identifier is refused, never asked.
it("refuses an approval before any request carried the identifier", async () => {
  const fake = scriptedSite({
    entry: "approve",
    screens: { approve: [], account: [] },
    fill: () => ({}),
  });
  const { result } = await signIn(
    recipe({ page: `${origin}/approve`, fields: [], approval: "device" }),
    fake,
  );
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "identifier_not_submitted" })),
  );
  expect(steps(fake)).toEqual(["ask:missing_credentials"]);
});


// A screen a cookie or consent notice covered records the notice's own control as `dismiss`: the
// replay hands it to the host's fill, which clicks it before typing when the page shows it.
const coveredSite = () =>
  scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: (_page, values) => (signedLogin(values) ? { next: "account", signIn: true } : {}),
  });
const coveredRecipe: SignInRecipe = {
  version: 6,
  steps: [{ ...loginStep, dismiss: "#consent-accept" }],
  signedIn: { selector: "#account" },
};

it("hands a recorded screen's dismiss to the host's fill", async () => {
  const fake = coveredSite();
  const dismissed: (string | undefined)[] = [];
  const fill = fake.browser.fill;
  fake.browser = {
    ...fake.browser,
    fill: (input) => {
      dismissed.push(input.step.dismiss);
      return fill(input);
    },
  };
  const { result } = await signIn(coveredRecipe, fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  expect(dismissed).toEqual(["#consent-accept"]);
});

it("ends a replay whose submit a notice still caught as blocked, having sent nothing", async () => {
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: () => ({
      report: {
        outcome: "filled",
        fields: [
          { slot: "username", status: "filled" },
          { slot: "password", status: "filled" },
        ],
        submit: "blocked",
        blockedBy: { tag: "div", id: "consent", role: null, ariaLabel: null, className: null },
        url: `${origin}/login`,
      },
    }),
  });
  const { result } = await signIn(coveredRecipe, fake);
  expect(result).toMatchObject(Either.left({ reason: "submit_blocked" }));
  expect(steps(fake)).toEqual(["ask:missing_credentials", "fill:login"]);
});

// A run of an integration whose build recorded screens signs in through them, on core's replay of
// states: the page read as a state (`observe`) picks the known one, and the step taken there.

/** Each scripted page as a sign-in state: its controls as empty boxes on the site's origin. */
const observeOn = (fake: ScriptedSite): NonNullable<SignInReplayBrowser<never>["observe"]> => () =>
  Effect.sync(() => {
    const boxes = (fake.state.page === "login" ? (["identifier", "password"] as const) : []).map(
      (kind) => ({ frame: origin, kind, empty: true, submit: true }),
    );
    return {
      fingerprint: {
        top: origin,
        boxes: boxes.map(({ frame, kind }) => ({ frame, kind })),
        submit: boxes.length > 0,
        ...(boxes.length === 0 ? { message: `~ ${fake.state.page}` } : {}),
      },
      boxes,
      texts: [],
    };
  });
const loginScreens = () => {
  const added = appendSignInStates(
    { states: [], transitions: [], signedIn: [] },
    {
      states: [
        {
          fingerprint: {
            top: origin,
            boxes: [
              { frame: origin, kind: "identifier" },
              { frame: origin, kind: "password" },
            ],
            submit: true,
          },
          step: loginStep,
        },
      ],
      signedIn: { selector: "#account" },
    },
  );
  if ("refused" in added) throw new Error(added.refused);
  return added.library;
};
const screensSignIn = (fake: ScriptedSite) => {
  const secrets = makeRunSecrets();
  const { ask } = owner(fake);
  return Effect.runPromise(
    Effect.either(
      signInForRun({
        states: loginScreens(),
        entryUrl: `${origin}/login`,
        browser: { ...fake.browser, observe: observeOn(fake) },
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: origin }),
        ask,
        secrets,
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
        site,
        siteOrigin: origin,
        timing: fastTiming,
      }),
    ),
  );
};

it("signs a run in through its screens, going on with the login from the screen the check without it stopped on", async () => {
  // A replay of screens types each box alone, then presses the submit.
  const typed: string[] = [];
  const fake = scriptedSite({
    entry: "login",
    screens: { login: loginScreen, account: [] },
    fill: (_page, values) => {
      typed.push(...values);
      return values.length === 0 && signedLogin(typed) ? { next: "account", signIn: true } : {};
    },
  });
  const result = await screensSignIn(fake);
  expect(result).toEqual(Either.right({ alreadySignedIn: false }));
  // The check that types nothing opened the entry and stopped on the login screen; the replay with
  // the login went on from there without opening it again.
  expect(fake.trace).toEqual([
    "open:/login",
    "ask:missing_credentials",
    "fill:login",
    "fill:login",
    "fill:login",
  ]);
  expect(fake.filled("login")).toEqual([[login.username], [login.password], []]);
});

it("fails a run whose site shows a screen its screens don't know, before typing anything", async () => {
  const fake = scriptedSite({
    entry: "landing",
    screens: { landing: ["#start"], login: loginScreen, account: [] },
    fill: () => ({}),
  });
  const result = await screensSignIn(fake);
  expect(Either.isLeft(result) && result.left).toMatchObject({
    code: "RecipeFailed",
    reason: "unknown_state",
  });
  expect(fake.fills).toEqual([]);
});
