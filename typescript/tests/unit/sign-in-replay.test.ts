import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
} from "../../src/destinations/autofill-step.js";
import type { SignInRecipe, SignInRequest } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import {
  type InputAnswers,
  type InputRequest,
  InputRequestFailure,
  type Question,
} from "../../src/runtime/input-request.js";
import {
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
} from "../../src/runtime/sign-in-replay.js";
import { askingValueHooks } from "../../src/runtime/sign-in-values.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";

// A run's sign-in against a synthetic site: a login screen, then an optional method choice, code
// screen or security question, and an account page that shows `#account` once signed in. Each
// fill sends the page's form request carrying what it filled, as a browser would.

interface Login {
  readonly username: string;
  readonly password: string;
}

const origin = "https://www.example.test";
const site = "example.test";
const account: Login = { username: "ada-owner", password: "synthetic-password" };
const code = "482913";
const question = "What was the name of your first pet?";
const answer = "synthetic-pet";

interface SiteOptions {
  /** The session is signed in before the run. */
  readonly signedIn?: boolean;
  /** A signed-in session that opens the login page lands on the account page. */
  readonly redirectWhenSignedIn?: boolean;
  /** The login screen shows `#login-error` after a wrong password. */
  readonly marker?: boolean;
  readonly method?: boolean;
  readonly code?: boolean;
  readonly question?: boolean;
  /** The security question the screen shows on the next load. */
  readonly questions?: string[];
  /** The login screen sits on another origin of the site than the recipe recorded. */
  readonly loginOrigin?: string;
  /** The page's requests carry nothing: a fill sends no request the host hears. */
  readonly silent?: boolean;
  /** The login screen shows `#username-error` after a wrong username. */
  readonly usernameMarker?: boolean;
  /** The entry page fails to load. */
  readonly entryFails?: boolean;
}

const pages = {
  login: ["#username", "#password", "#sign-in"],
  method: ["#by-text", "#by-app"],
  code: ["#code", "#verify"],
  question: ["#question", "#answer", "#continue"],
  account: [] as string[],
} as const;
type Page = keyof typeof pages;

/** A synthetic site and what the run did on it. */
const fakeSite = (options: SiteOptions = {}) => {
  const state = {
    page: "login" as Page,
    signedIn: options.signedIn === true,
    loginError: false,
    usernameError: false,
    codeError: false,
    question: options.questions?.[0] ?? question,
    loads: 0,
  };
  const fills: { readonly page: Page; readonly values: readonly string[] }[] = [];
  const opened: string[] = [];
  const listeners = new Set<(request: SignInRequest) => void>();
  const pageOrigin = (page: Page) => (page === "login" ? (options.loginOrigin ?? origin) : origin);
  const shows = (selector: string) => (pages[state.page] as readonly string[]).includes(selector);
  const navigate = (page: Page) => {
    state.page = page;
    state.question = options.questions?.[state.loads++] ?? state.question;
  };
  const afterLogin = (): Page =>
    options.method ? "method" : options.code ? "code" : options.question ? "question" : "account";
  const browser: SignInReplayBrowser<Error> = {
    inspect: (step) =>
      Effect.sync((): AutofillInspection | { readonly outcome: "refused"; readonly reason: "not_found" } => {
        const selectors = [...step.fields.map((field) => field.selector), ...(step.submit === undefined ? [] : [step.submit])];
        if (selectors.length === 0 || !selectors.every(shows)) return { outcome: "refused", reason: "not_found" };
        const at = pageOrigin(state.page);
        const target = {
          ownerUrl: `${at}/${state.page}`,
          documentOrigin: at,
          actions: [`${at}/${state.page}`],
          methods: ["post"],
          editable: true,
          control: "text" as const,
          empty: !(state.page === "login" && state.loginError),
        };
        return {
          url: `${at}/${state.page}`,
          page: `${at}/${state.page}`,
          targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin: at,
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
              ...(field.slot === "private_answer" ? { questionText: state.question } : {}),
            })),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step, values }) =>
      Effect.sync(() => {
        const page = state.page;
        fills.push({ page, values: [...values] });
        const request: SignInRequest = {
          url: `${pageOrigin(page)}/${page}`,
          method: "POST",
          body: new URLSearchParams(values.map((value, index) => [`field${index}`, value])).toString(),
          channel: "navigation",
          frame: "main",
          resourceType: "document",
        };
        if (options.silent !== true) for (const listener of [...listeners]) listener(request);
        if (page === "login") {
          const right = values[0] === account.username && values[1] === account.password;
          state.loginError = !right && options.marker === true;
          state.usernameError = values[0] !== account.username && options.usernameMarker === true;
          if (right) navigate(afterLogin());
          if (right && afterLogin() === "account") state.signedIn = true;
        } else if (page === "method") navigate("code");
        else if (page === "code") {
          state.codeError = values[0] !== code;
          if (!state.codeError) {
            state.signedIn = true;
            navigate("account");
          }
        } else if (page === "question" && values[0] === answer) {
          state.signedIn = true;
          navigate("account");
        } else navigate(page);
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: `${origin}/${state.page}`,
        };
      }),
    confirm: (indicator) =>
      Effect.sync((): AutofillSignedInCheck => {
        if (indicator.openPath !== undefined) navigate("account");
        const url = `${pageOrigin(state.page)}/${state.page}`;
        return state.signedIn && state.page === "account"
          ? { signedIn: true, url }
          : { signedIn: false, failed: "indicator_not_visible", url };
      }),
    onRequest: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    authenticationOrigins: [],
    open: (url) =>
      options.entryFails === true
        ? Effect.fail(new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`))
        : Effect.sync(() => {
            opened.push(url);
            state.loginError = false;
            state.usernameError = false;
            navigate(state.signedIn && options.redirectWhenSignedIn === true ? "account" : "login");
          }),
    markerVisible: (selector) =>
      Effect.sync(
        () =>
          (selector === "#login-error" && state.page === "login" && state.loginError) ||
          (selector === "#username-error" && state.page === "login" && state.usernameError) ||
          (selector === "#code-error" && state.page === "code" && state.codeError),
      ),
  };
  return { browser, state, fills, opened, listening: () => listeners.size };
};

const loginStep = {
  page: `${origin}/login`,
  fields: [
    { selector: "#username", accepts: ["username" as const] },
    { selector: "#password", slot: "password" as const },
  ],
  submit: "#sign-in",
  submittedBy: "host" as const,
};
const recipeOf = (...later: SignInRecipe["steps"][number][]): SignInRecipe => ({
  version: 1,
  steps: [loginStep, ...later],
  signedIn: { selector: "#account" },
});

/** The owner's answers: logins in order, then codes and security answers. */
const owner = (answers: { readonly logins?: Login[]; readonly codes?: string[]; readonly answers?: string[]; readonly method?: string; readonly fail?: boolean } = {}) => {
  const asked: InputRequest[] = [];
  const logins = [...(answers.logins ?? [account])];
  const codes = [...(answers.codes ?? [code])];
  const privateAnswers = [...(answers.answers ?? [answer])];
  const ask = makeInputAsker((request) =>
    Effect.suspend(() => {
      asked.push(request);
      if (answers.fail === true) return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
      const reply = (question: Question) => {
        if (question.type === "credential") {
          const login = logins.shift() ?? account;
          return { ...login, saveLogin: false };
        }
        if (question.type === "choice") return answers.method ?? question.options[0]?.id;
        if (question.type === "confirm") return { confirmed: true };
        if (question.id === "code") return codes.shift() ?? code;
        return privateAnswers.shift() ?? answer;
      };
      return Effect.succeed(
        Object.fromEntries(request.questions.map((question) => [question.id, reply(question)])) as InputAnswers,
      );
    }),
  );
  return { ask, asked };
};

const signIn = (
  recipe: SignInRecipe,
  fake: ReturnType<typeof fakeSite>,
  ask: ReturnType<typeof owner>["ask"],
  entryUrl = `${origin}/login`,
) => {
  const secrets = makeRunSecrets();
  return Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl,
        browser: fake.browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: origin }),
        values: askingValueHooks({ ask, register: secrets.register, site, siteOrigin: origin }),
        carries: secrets.carries,
        site,
        siteOrigin: origin,
        timing: { stepWaitMs: 60, pollMs: 2 },
      }),
    ),
  );
};
const kinds = (asked: readonly InputRequest[]) =>
  asked.map(({ questions }) =>
    questions.map((question) => (question.type === "credential" ? `credential:${question.reason}` : question.id)).join(","),
  );

it("checks without values first and asks nothing when the session is already signed in", async () => {
  const fake = fakeSite({ signedIn: true, redirectWhenSignedIn: true });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: true }));
  expect(asked).toEqual([]);
  expect(fake.fills).toEqual([]);
  expect(fake.opened).toEqual([`${origin}/login`]);
  expect(fake.listening()).toBe(0);
});

it("asks one login question once the check finds the sign-in screen, then replays with it", async () => {
  const fake = fakeSite();
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
  expect(asked[0]?.questions[0]).toMatchObject({ type: "credential", allowSave: false, siteOrigin: origin });
  expect(fake.fills).toEqual([{ page: "login", values: [account.username, account.password] }]);
  // The check and the replay each open the entry page, and nothing listens afterwards.
  expect(fake.opened).toHaveLength(2);
  expect(fake.listening()).toBe(0);
});

it("corrects a rejected password without sending it again, asking again for a correction that repeats it", async () => {
  const fake = fakeSite();
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, wrong, account] });
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  // The correction names the username, and the repeated password is never filled.
  expect(asked[1]?.questions[0]).toMatchObject({ username: account.username });
  expect(fake.fills.map(({ values }) => values[1])).toEqual([wrong.password, account.password]);
});

it("fails CredentialsRejected once both corrections of the password were rejected", async () => {
  const fake = fakeSite({ marker: true });
  const logins = ["one", "two", "three", "four"].map((suffix) => ({ ...account, password: `synthetic-${suffix}` }));
  const { ask, asked } = owner({ logins });
  const result = await signIn(
    { ...recipeOf(), steps: [{ ...loginStep, rejectedMarkers: [{ slot: "password", selector: "#login-error" }] }] },
    fake,
    ask,
  );
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  expect(fake.fills.map(({ values }) => values[1])).toEqual(logins.slice(0, 3).map(({ password }) => password));
  // The failure holds no value.
  expect(JSON.stringify(Either.isLeft(result) ? result.left : null)).not.toContain("synthetic-");
});

it("asks for the code a code screen needs, and a fresh one for a rejected code, never the rejected one", async () => {
  const fake = fakeSite({ code: true });
  const { ask, asked } = owner({ codes: ["111111", "111111", code] });
  const codeStep = { page: `${origin}/code`, fields: [{ selector: "#code", slot: "code" as const }], submit: "#verify", rejectedMarkers: [{ slot: "code" as const, selector: "#code-error" }] };
  expect(await signIn(recipeOf(codeStep), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code", "code", "code"]);
  expect(asked[2]?.questions[0]?.prompt).toContain("did not accept the last code");
  expect(fake.fills.filter(({ page }) => page === "code").map(({ values }) => values[0])).toEqual(["111111", code]);
});

it("asks a recipe's method choice and clicks the recorded control of the method picked", async () => {
  const fake = fakeSite({ method: true, code: true });
  const { ask, asked } = owner({ method: "option_1" });
  const methodStep = {
    page: `${origin}/method`,
    fields: [],
    submit: "#by-text",
    methods: [
      { method: "sms" as const, selector: "#by-text" },
      { method: "totp" as const, selector: "#by-app" },
    ],
  };
  const codeStep = { page: `${origin}/code`, fields: [{ selector: "#code", slot: "code" as const }], submit: "#verify" };
  expect(await signIn(recipeOf(methodStep, codeStep), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "method", "code"]);
  expect(asked[1]?.questions[0]).toMatchObject({
    type: "choice",
    prompt: `How should ${site} confirm it's you?`,
    options: [
      { id: "option_0", label: "Text message" },
      { id: "option_1", label: "Authenticator app" },
    ],
  });
});

const questionStep = {
  page: `${origin}/question`,
  fields: [{ selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" }],
  submit: "#continue",
  submittedBy: "host" as const,
};

it("asks a security answer on every run, from the question the screen shows then", async () => {
  const recipe: SignInRecipe = { ...recipeOf(), version: 3, steps: [loginStep, questionStep] };
  const prompts: string[] = [];
  for (const shown of ["What was the name of your first pet?", "Which city were you born in?"]) {
    const fake = fakeSite({ question: true, questions: [question, shown] });
    const { ask, asked } = owner();
    expect(await signIn(recipe, fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
    expect(kinds(asked)).toEqual(["credential:missing_credentials", "private_answer"]);
    prompts.push(asked[1]?.questions[0]?.prompt ?? "");
    expect(fake.fills.at(-1)).toEqual({ page: "question", values: [answer] });
  }
  expect(prompts).toEqual([
    `What was the name of your first pet? (${origin})`,
    `Which city were you born in? (${origin})`,
  ]);
});

it("fails CredentialsRejected when the security question shows again after its answer", async () => {
  const fake = fakeSite({ question: true });
  const { ask } = owner({ answers: ["synthetic-wrong-pet"] });
  const recipe: SignInRecipe = { ...recipeOf(), version: 3, steps: [loginStep, questionStep] };
  expect(await signIn(recipe, fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "private_answer" })),
  );
  expect(fake.fills.filter(({ page }) => page === "question")).toHaveLength(1);
});

it("fails RecipeFailed when a recorded screen shows on another origin than the recipe's", async () => {
  const fake = fakeSite({ loginOrigin: "https://login.example.test" });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "screen_origin_changed" })),
  );
  expect(fake.fills).toEqual([]);
  expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
});

it.each([
  ["an unknown version", { ...recipeOf(), version: 4 }, "unknown_version"],
  ["a version 1 recipe naming a question", { ...recipeOf(), steps: [loginStep, questionStep] }, "invalid"],
])("refuses %s with MissingRecipe before opening anything", async (_case, recipe, reason) => {
  const fake = fakeSite();
  const { ask, asked } = owner();
  expect(await signIn(recipe as SignInRecipe, fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "MissingRecipe", reason })),
  );
  expect(fake.opened).toEqual([]);
  expect(asked).toEqual([]);
});

it("refuses an entry page off the site before opening anything", async () => {
  const fake = fakeSite();
  const { ask } = owner();
  expect(await signIn(recipeOf(), fake, ask, "https://elsewhere.test/login")).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_off_site" })),
  );
  expect(fake.opened).toEqual([]);
});

it("fails NeedsInput when the owner leaves the login question unanswered", async () => {
  const fake = fakeSite();
  const { ask } = owner({ fail: true });
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "login" })),
  );
  expect(fake.fills).toEqual([]);
});

it("says what each failure means without naming a value", () => {
  expect(new SignInRunFailed({ code: "CredentialsRejected", reason: "date_of_birth" }).message).toBe(
    "The website rejected the date of birth given for this sign-in, and the run sends it no more. Run the tool again with the right value.",
  );
  expect(new SignInRunFailed({ code: "RecipeFailed", reason: "screen_origin_changed" }).message).toBe(
    "The saved sign-in no longer matches the website (screen origin changed). Build the tool again to record its sign-in.",
  );
  expect(new SignInRunFailed({ code: "MissingRecipe", reason: "unknown_version" }).message).toBe(
    "The tool's saved sign-in can't be read (unknown version), so the tool doesn't run signed out. Build the tool again.",
  );
  // A changed security question or a page that didn't load is no fault of the recipe.
  expect(new SignInRunFailed({ code: "NeedsInput", reason: "question_changed" }).message).not.toContain(
    "Build the tool again",
  );
  expect(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_page_unavailable" }).message).not.toContain(
    "Build the tool again",
  );
});

it("fills a recorded step's identifier with the kind the login holds", async () => {
  const fake = fakeSite();
  const { ask } = owner();
  const accepts: AutofillStep["fields"][number]["accepts"] = ["email", "username"];
  const recipe = { ...recipeOf(), steps: [{ ...loginStep, fields: [{ selector: "#username", accepts }, loginStep.fields[1]] }] } as SignInRecipe;
  expect(await signIn(recipe, fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.fills).toEqual([{ page: "login", values: [account.username, account.password] }]);
});

const codeScreen = {
  page: `${origin}/code`,
  fields: [{ selector: "#code", slot: "code" as const }],
  submit: "#verify",
};
/** What each fill of the login screen sent, in order. */
const loginFills = (fake: ReturnType<typeof fakeSite>) =>
  fake.fills.filter(({ page }) => page === "login").map(({ values }) => values);

it("never fills a password the login screen rejected by showing again before a later screen, even when a correction repeats it", async () => {
  const fake = fakeSite({ code: true });
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, wrong, account] });
  expect(await signIn(recipeOf(codeScreen), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  // The code screen never showed: the login screen came back, so the password it took was
  // rejected, and the correction that repeated it was asked again instead of filled.
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
    "code",
  ]);
  expect(loginFills(fake).map((values) => values[1])).toEqual([wrong.password, account.password]);
});

it("does not count a sign-in whose page sent no request carrying the values, even when the marker shows", async () => {
  const fake = fakeSite({ silent: true });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "sign_in_check_failed" })),
  );
  // The page showed the account, but no request it sent carried the login.
  expect(fake.state.signedIn).toBe(true);
  expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
});

it("never fills a username its recorded marker rejected, even when a correction repeats it", async () => {
  const fake = fakeSite({ usernameMarker: true });
  const wrong = { username: "synthetic-wrong-user", password: account.password };
  const { ask, asked } = owner({ logins: [wrong, wrong, account] });
  const recipe: SignInRecipe = {
    ...recipeOf(),
    steps: [{ ...loginStep, rejectedMarkers: [{ slot: "username", selector: "#username-error" }] }],
  };
  expect(await signIn(recipe, fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  expect(loginFills(fake).map((values) => values[0])).toEqual([wrong.username, account.username]);
});

it("fails RecipeFailed, value-free, when the entry page does not load", async () => {
  const fake = fakeSite({ entryFails: true });
  const { ask, asked } = owner();
  const result = await signIn(recipeOf(), fake, ask);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_page_unavailable" })),
  );
  expect(Either.isLeft(result) && result.left.message).toBe(
    "The sign-in page didn't load, so the run stopped before the tool ran. Check that the website is reachable, then run the tool again.",
  );
  expect(asked).toEqual([]);
  expect(fake.fills).toEqual([]);
});
