import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillPage,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import type { SignInBrowser, SignInRequest } from "../../src/destinations/sign-in-recipe.js";
import { MintFailure, type SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";
import { askingValueHooks } from "../../src/runtime/sign-in-values.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";

const site = "example.test";
const origin = "https://www.example.test";
const account = { username: "ada-owner", password: "synthetic-password" } as const;

const target = {
  ownerUrl: `${origin}/login`,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  submitMethod: "post",
  editable: true,
  control: "text",
} as const;
const described = {
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
};

/** The form request a fill's submit sends, carrying each of `values`. */
const formRequest = (values: readonly string[]): SignInRequest => ({
  url: `${origin}/session`,
  method: "POST",
  body: new URLSearchParams(values.map((value, index) => [`field${index}`, value])).toString(),
  channel: "navigation",
  frame: "main",
  resourceType: "document",
});

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text.replaceAll("+", " "));
  } catch {
    return text;
  }
};

interface Options {
  /** The login the build already holds. */
  readonly held?: WebsiteCredentials;
  /** The logins the owner gives as corrections, in order. */
  readonly corrections?: readonly WebsiteCredentials[];
  /** What each fill's submit sends; the form request carrying every value by default. */
  readonly send?: (step: AutofillStep, values: readonly string[]) => readonly SignInRequest[];
  /** What each fill reports; every field filled and the submit clicked by default. */
  readonly report?: (step: AutofillStep) => AutofillStepReport;
  /** The live address the host finds a screen at. */
  readonly liveUrl?: string;
  /** The page the host finds a screen on, origin and path. */
  readonly page?: string;
  /** Whether the page still shows a recorded challenge of the current sign-in. */
  readonly challengeAsks?: boolean;
  /** The questions each inspected private-answer field shows, in order. */
  readonly questions?: string[];
  /** The owner's answers to each question by id, in order. */
  readonly answers?: Record<string, string[]>;
  readonly approve?: boolean;
  readonly refuseIndicator?: boolean;
  /** The configured sign-in origins off the site. */
  readonly authenticationOrigins?: readonly string[];
}

/** A recorder over a synthetic site, with what it asked, filled, reviewed and checked. */
const harness = (options: Options = {}) => {
  let current = options.held;
  const corrections = [...(options.corrections ?? [])];
  const asked: InputRequest[] = [];
  const logins: string[] = [];
  const filled: { readonly step: AutofillStep; readonly values: readonly string[] }[] = [];
  /** The very value lists each fill was given, as the recorder holds them after. */
  const given: (readonly string[])[] = [];
  const reviewed: AutofillStep[] = [];
  const confirmed: unknown[] = [];
  const listeners = new Set<(request: SignInRequest) => void>();
  const questions = [...(options.questions ?? [])];
  const answers = Object.fromEntries(
    Object.entries(options.answers ?? {}).map(([id, values]) => [id, [...values]]),
  );
  const browser: SignInBrowser<never> = {
    inspect: (step) =>
      Effect.sync((): AutofillInspection => ({
        url: options.liveUrl ?? `${origin}/login`,
        page: options.page ?? `${origin}/login`,
        targets: { fields: step.fields.map(() => target), submit: target },
        siteOrigin: origin,
        authenticationOrigins: [],
        screen: {
          origin,
          fields: step.fields.map((field) => ({
            ...described,
            slot: field.slot,
            ...(field.slot === "private_answer" && questions.length > 0
              ? { questionText: questions.shift() ?? "" }
              : {}),
          })),
          submit: described,
          buttons: [],
        },
      })),
    fill: ({ step, values }) =>
      Effect.sync(() => {
        filled.push({ step, values: [...values] });
        given.push(values);
        for (const request of options.send?.(step, values) ?? [formRequest(values)])
          for (const listener of [...listeners]) listener(request);
        return (
          options.report?.(step) ?? {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${origin}/next`,
          }
        );
      }),
    confirm: (indicator, screens, challengeScreens) =>
      Effect.sync((): AutofillSignedInCheck => {
        confirmed.push({ indicator, screens, challengeScreens });
        return options.challengeAsks === true && challengeScreens.length > 0
          ? { signedIn: false, failed: "challenge_form_visible", url: `${origin}/account` }
          : { signedIn: true, url: `${origin}/account` };
      }),
    onRequest: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    authenticationOrigins: options.authenticationOrigins ?? [],
  };
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          question.type === "confirm"
            ? { type: "confirm" as const, value: { confirmed: options.approve ?? true } }
            : {
                type: question.type === "text" ? ("text" as const) : ("secret" as const),
                value: answers[question.id]?.shift() ?? "",
              },
        ]),
      );
    });
  const recorder = makeSignInRecorder({
    browser,
    login: {
      held: () => current,
      values: Effect.sync(() => {
        logins.push("missing_credentials");
        current = account;
        return account;
      }),
      correct: (field, held) =>
        Effect.sync(() => {
          logins.push(`invalid_credentials:${field}`);
          current = corrections.shift() ?? held;
          return current;
        }),
    },
    values: askingValueHooks({ ask, register: () => {}, site, siteOrigin: origin }),
    review: (step) =>
      Effect.sync(() => {
        reviewed.push(step);
      }),
    site,
    carries: (expected, texts) =>
      Effect.succeed(
        expected.length > 0 &&
          expected.every((value) =>
            texts.some((text) => text.includes(value) || decoded(text).includes(value)),
          ),
      ),
    ...(options.refuseIndicator === true
      ? {
          refuseIndicator: () => ({
            signedIn: false,
            failed: "marker_matches_signed_out_page",
          }),
        }
      : {}),
  });
  /** Runs `use` with the recorder, in its own scope. */
  const run = <A, E>(use: (made: Effect.Effect.Success<typeof recorder>) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(recorder, use)));
  return { run, asked, logins, filled, given, reviewed, confirmed, listeners };
};

const identifierAndPassword: SignInStep = {
  fields: [
    { selector: "#user", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const passwordOnly: SignInStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
const signedIn: SignInStep = { signedIn: { selector: "#account-menu" } };

it("records a value-free recipe once a request carried the login, entered from the login URL", async () => {
  const host = harness();
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      const screen = yield* recorder.step(
        identifierAndPassword,
        `${origin}/login?next=%2Faccount#top`,
        Effect.void,
      );
      expect(screen.report).toMatchObject({ outcome: "filled", submit: "clicked" });
      expect(screen.result["nextStep"]).toContain("clicked the submit");
      const checked = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
      return recorder.published();
    }),
  );
  expect(published).toEqual({
    recipe: {
      version: 1,
      steps: [
        {
          page: `${origin}/login`,
          fields: [
            { selector: "#user", accepts: ["username"] },
            { selector: "#password", slot: "password" },
          ],
          submit: "#sign-in",
          submittedBy: "host",
        },
      ],
      signedIn: { selector: "#account-menu" },
    },
    entryUrl: `${origin}/login?next=%2Faccount`,
  });
  expect(JSON.stringify(published)).not.toContain(account.username);
  expect(JSON.stringify(published)).not.toContain(account.password);
  // One login question for the build, asked once the screen was reviewed.
  expect(host.logins).toEqual(["missing_credentials"]);
  expect(host.reviewed).toHaveLength(1);
  // The sign-in is over: the host stopped hearing the page's requests.
  expect(host.listeners.size).toBe(0);
});

it("enters from the first screen's live address, without its fragment, when no login URL was given", async () => {
  const host = harness({ liveUrl: `${origin}/login?flow=web#state` });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.entryUrl).toBe(`${origin}/login?flow=web`);
});

it("enters from a login URL without the credentials or fragment it held", async () => {
  const host = harness();
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(
        identifierAndPassword,
        "https://visitor:synthetic-secret@www.example.test/login?next=%2F#top",
        Effect.void,
      );
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.entryUrl).toBe(`${origin}/login?next=%2F`);
});

it("refuses a screen whose address names the account before anything is asked or typed", async () => {
  const host = harness({ held: account, page: `${origin}/accounts/${account.username}/sign-in` });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      const refused = yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return refused;
    }),
  );
  expect(result.result).toMatchObject({
    step: { outcome: "refused", reason: "page_names_contact" },
  });
  expect(host.filled).toEqual([]);
  expect(host.asked).toEqual([]);
  expect(host.listeners.size).toBe(0);
});

it("keeps a sign-in open through a marker check while its recorded challenge still asks", async () => {
  const host = harness({ held: account, challengeAsks: true });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      // A marker check reads the screens, as `check_signed_in_marker` does, and ends nothing.
      expect(recorder.screens().challengeScreens).toHaveLength(1);
      expect(recorder.screens().challengeScreens).toHaveLength(1);
      const checked = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return checked;
    }),
  );
  expect(result.verified).toBeUndefined();
  expect(result.result).toMatchObject({ signedIn: false, failed: "challenge_form_visible" });
});

it("refuses a signed-in check until a request carried the identifier and a password or code", async () => {
  // The page's own request carries nothing the host filled.
  const host = harness({ send: () => [formRequest(["unrelated"])] });
  const checked = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const result = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return result;
    }),
  );
  expect(checked.verified).toBeUndefined();
  expect(checked.result).toMatchObject({ signedIn: false, failed: "credentials_not_submitted" });
  expect(host.confirmed).toEqual([]);
});

it("counts a script's sign-in request only when it carries every filled value", async () => {
  const fetchRequest = (values: readonly string[]): SignInRequest => ({
    url: `https://api.example.test/sign-in`,
    method: "POST",
    body: JSON.stringify(values),
    channel: "http",
    resourceType: "fetch",
  });
  const partial = harness({ send: (_step, values) => [fetchRequest(values.slice(0, 1))] });
  expect(
    await partial.run((recorder) =>
      Effect.gen(function* () {
        yield* recorder.step(identifierAndPassword, undefined, Effect.void);
        return (yield* recorder.step(signedIn, undefined, Effect.void)).result;
      }),
    ),
  ).toMatchObject({ failed: "credentials_not_submitted" });
  const whole = harness({ send: (_step, values) => [fetchRequest(values)] });
  expect(
    await whole.run((recorder) =>
      Effect.gen(function* () {
        yield* recorder.step(identifierAndPassword, undefined, Effect.void);
        return yield* recorder.step(signedIn, undefined, Effect.void);
      }),
    ),
  ).toMatchObject({ verified: true });
});

/** An identity service off the site that a sign-in script posts the login to. */
const identity = "https://identity.provider.test";
/** The script's request to it, carrying the login's identifier and password. */
const identityRequest = (values: readonly string[]): SignInRequest => ({
  url: `${identity}/v1/sign-in?key=public-key`,
  method: "POST",
  body: JSON.stringify({ email: values[0], password: values[1] }),
  channel: "http",
  resourceType: "fetch",
});

it("names the origin off the site a script sent the whole login to, and counts nothing sent", async () => {
  // A request to another off-site origin that carries only part of the login is not named.
  const partial = (values: readonly string[]): SignInRequest => ({
    url: "https://telemetry.other.test/collect",
    method: "POST",
    body: JSON.stringify({ field: values[0] }),
    channel: "http",
    resourceType: "xhr",
  });
  const untrusted = harness({
    send: (_step, values) => [partial(values), identityRequest(values)],
  });
  const checked = await untrusted.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const result = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return result;
    }),
  );
  expect(checked.verified).toBeUndefined();
  expect(checked.untrustedSignInOrigins).toEqual([identity]);
  // Exactly the origin, with no path, query or value.
  expect(checked.result).toMatchObject({
    signedIn: false,
    failed: "credentials_not_submitted",
    untrustedSignInOrigins: [identity],
  });
  expect(checked.result["nextStep"]).toContain("untrustedSignInOrigins");
  expect(JSON.stringify(checked.result)).not.toContain(account.password);
  expect(JSON.stringify(checked.result)).not.toContain(account.username);
  expect(JSON.stringify(checked.result)).not.toContain("/v1/sign-in");
  expect(untrusted.confirmed).toEqual([]);
  // A login the page's own request never carried names no origin.
  const unsent = harness({ send: () => [formRequest(["unrelated"])] });
  const plain = await unsent.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      return (yield* recorder.step(signedIn, undefined, Effect.void)).result;
    }),
  );
  expect(plain).toMatchObject({ failed: "credentials_not_submitted" });
  expect(plain).not.toHaveProperty("untrustedSignInOrigins");
});

it("verifies a script's sign-in request to a configured sign-in origin off the site", async () => {
  const trusted = harness({
    authenticationOrigins: [identity],
    send: (_step, values) => [identityRequest(values)],
  });
  const verified = await trusted.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const result = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeDefined();
      return result;
    }),
  );
  expect(verified).toMatchObject({ verified: true, result: { signedIn: true } });
});

it("verifies once the caller trusts the origin the script sent the whole login to, with no second fill, and records the configured sign-in's recipe", async () => {
  const send = (_step: AutofillStep, values: readonly string[]) => [identityRequest(values)];
  const untrusted = harness({ send });
  const trustedLater = await untrusted.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBeUndefined();
      expect(recorder.untrustedOrigins()).toEqual([identity]);
      // An origin no request carried the login to credits nothing.
      recorder.trustOrigins(["https://other.provider.test"]);
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBeUndefined();
      recorder.trustOrigins([identity]);
      expect(recorder.untrustedOrigins()).toEqual([]);
      const checked = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
      return recorder.published();
    }),
  );
  expect(untrusted.filled).toHaveLength(1);
  const configured = harness({ authenticationOrigins: [identity], send });
  const trustedUpFront = await configured.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(trustedLater).toBeDefined();
  expect(trustedLater).toEqual(trustedUpFront);
});

it("takes a code an exploration typed as the proof after a sent identifier", async () => {
  const host = harness();
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(
        { fields: [{ selector: "#user", accepts: ["username"] }], submit: "#next" },
        undefined,
        Effect.void,
      );
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBeUndefined();
      recorder.codeTyped();
      return yield* recorder.step(signedIn, undefined, Effect.void);
    }),
  );
  expect(result.verified).toBe(true);
});

it("confirms an approval after a sent identifier, records it as version 2, and verifies with it", async () => {
  const host = harness();
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      const early = yield* recorder.step({ approval: "device" }, undefined, Effect.void);
      expect(early.result).toMatchObject({ approved: false, failed: "identifier_not_submitted" });
      yield* recorder.step(
        { fields: [{ selector: "#user", accepts: ["username"] }], submit: "#next" },
        undefined,
        Effect.void,
      );
      const approved = yield* recorder.step({ approval: "device" }, undefined, Effect.void);
      expect(approved).toMatchObject({ approved: true, result: { approved: true } });
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBe(true);
      return recorder.published();
    }),
  );
  expect(host.asked.at(-1)?.questions).toEqual([
    {
      id: "approved",
      type: "confirm",
      prompt: "Approve the site's sign-in request on your device, then confirm here.",
    },
  ]);
  expect(published?.recipe).toMatchObject({
    version: 2,
    steps: [{ submit: "#next" }, { page: `${origin}/login`, fields: [], approval: "device" }],
  });
});

it("keeps the sign-in open when the host refuses an indicator a signed-out page showed", async () => {
  const host = harness({ refuseIndicator: true });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const refused = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(refused.result).toMatchObject({ failed: "marker_matches_signed_out_page" });
      expect(recorder.published()).toBeUndefined();
      return refused;
    }),
  );
  expect(result.verified).toBeUndefined();
  expect(host.listeners.size).toBe(0);
});

it("refuses an indicator, a selector or a page that names the account, typing nothing", async () => {
  const host = harness({ held: account });
  await host.run((recorder) =>
    Effect.gen(function* () {
      const named = yield* recorder.step(
        {
          fields: [{ selector: `[data-user="${account.username}"]`, accepts: ["username"] }],
          submit: "#next",
        },
        undefined,
        Effect.void,
      );
      expect(named.result).toMatchObject({
        step: { outcome: "refused", reason: "selector_names_contact", target: 0 },
      });
      const masked = yield* recorder.step(
        {
          fields: [],
          submit: "#sms",
          methods: [{ method: "sms", selector: "button:has-text('Text ***-***-1234')" }],
        },
        undefined,
        Effect.void,
      );
      expect(masked.result).toMatchObject({ step: { reason: "selector_names_contact" } });
      expect(host.filled).toEqual([]);
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const indicator = yield* recorder.step(
        { signedIn: { selector: `text=${account.username}` } },
        undefined,
        Effect.void,
      );
      expect(indicator.result).toMatchObject({ failed: "indicator_holds_identity" });
    }),
  );
});

it("refuses a password screen before any identifier screen while the build holds no login", async () => {
  const host = harness();
  const result = await host.run((recorder) => recorder.step(passwordOnly, undefined, Effect.void));
  expect(result.result).toMatchObject({
    step: { outcome: "refused", reason: "login_identifier_unobserved" },
  });
  expect(host.logins).toEqual([]);
  expect(host.filled).toEqual([]);
});

it("fills a password twice at most in one sign-in, and a ZIP once", async () => {
  const host = harness({ held: account, answers: { zip: ["94110"] } });
  await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(passwordOnly, undefined, Effect.void);
      const third = yield* recorder.step(passwordOnly, undefined, Effect.void);
      expect(third.result).toMatchObject({
        step: { outcome: "refused", reason: "credential_already_filled", target: 0 },
      });
      const zip = { fields: [{ selector: "#zip", slot: "zip" as const }], submit: "#go" };
      yield* recorder.step(zip, undefined, Effect.void);
      expect((yield* recorder.step(zip, undefined, Effect.void)).result).toMatchObject({
        step: { reason: "credential_already_filled" },
      });
    }),
  );
  expect(host.filled).toHaveLength(3);
});

it("accepts a rejected value only once it was sent, and corrects a password once in place", async () => {
  const corrected = { ...account, password: "corrected-password" };
  const host = harness({ corrections: [corrected, { ...corrected, password: "third" }] });
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      const early = yield* recorder.step(
        { rejected: { slot: "password" } },
        undefined,
        Effect.void,
      );
      expect(early.result).toMatchObject({ step: { reason: "nothing_rejected" } });
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const correction = yield* recorder.step(
        { rejected: { slot: "password" } },
        undefined,
        Effect.void,
      );
      expect(correction.result).toMatchObject({ corrected: true });
      // The corrected login starts a new sign-in, filled with the new password.
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      return yield* Effect.exit(
        recorder.step({ rejected: { slot: "password" } }, undefined, Effect.void),
      );
    }),
  );
  expect(host.filled.map(({ values }) => values[1])).toEqual([
    account.password,
    corrected.password,
  ]);
  expect(host.logins).toEqual(["missing_credentials", "invalid_credentials:password"]);
  expect(exit).toEqual(
    Exit.fail(
      expect.objectContaining({ code: "CredentialsRejected", rejectedCredential: "password" }),
    ),
  );
});

it("ends the build when the correction repeats the rejected password", async () => {
  const host = harness({ corrections: [account] });
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      return yield* Effect.exit(
        recorder.step({ rejected: { slot: "password" } }, undefined, Effect.void),
      );
    }),
  );
  expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error).toBeInstanceOf(
    MintFailure,
  );
  expect(exit).toEqual(Exit.fail(expect.objectContaining({ code: "CredentialsRejected" })));
});

it("asks a new code after the site rejected one, and ends once three were rejected", async () => {
  const host = harness({ held: account, answers: { code: ["111111", "222222", "333333"] } });
  const code = { fields: [{ selector: "#code", slot: "code" as const }], submit: "#verify" };
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      for (let round = 0; round < 2; round++) {
        yield* recorder.step(code, undefined, Effect.void);
        expect(
          (yield* recorder.step({ rejected: { slot: "code" } }, undefined, Effect.void)).result,
        ).toMatchObject({ rejected: "code" });
      }
      yield* recorder.step(code, undefined, Effect.void);
      return yield* Effect.exit(
        recorder.step({ rejected: { slot: "code" } }, undefined, Effect.void),
      );
    }),
  );
  expect(host.filled.slice(1).map(({ values }) => values[0])).toEqual([
    "111111",
    "222222",
    "333333",
  ]);
  expect(host.asked.map(({ questions }) => questions[0]?.prompt)).toEqual([
    "Enter the sign-in code example.test sent you.",
    `The site did not accept the last code, so it needs a new one. Enter the sign-in code example.test sent you.`,
    `The site did not accept the last code, so it needs a new one. Enter the sign-in code example.test sent you.`,
  ]);
  expect(exit).toEqual(
    Exit.fail(expect.objectContaining({ code: "CredentialsRejected", rejectedCredential: "code" })),
  );
});

it("records a private answer's question selector in version 1, never its question or answer", async () => {
  const host = harness({
    held: account,
    questions: ["What was your first pet's name?"],
    answers: { private_answer: ["synthetic-answer"] },
  });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(
        {
          fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }],
          submit: "#continue",
        },
        undefined,
        Effect.void,
      );
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.recipe.version).toBe(1);
  expect(published?.recipe.steps[1]?.fields).toEqual([
    { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
  ]);
  expect(host.asked.at(-1)?.questions[0]?.prompt).toBe(
    `What was your first pet's name? (${origin})`,
  );
  const text = JSON.stringify(published);
  for (const secret of ["first pet", "synthetic-answer", account.password, "Field"])
    expect(text).not.toContain(secret);
});

it("discards a private answer from the values it filled once the fill is over", async () => {
  const host = harness({
    held: account,
    questions: ["What was your first pet's name?"],
    answers: { private_answer: ["synthetic-answer"] },
  });
  await host.run((recorder) =>
    recorder.step(
      {
        fields: [
          { selector: "#user", accepts: ["username"] },
          { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
        ],
        submit: "#continue",
      },
      undefined,
      Effect.void,
    ),
  );
  // The fill typed the answer, and the list the host filled from no longer holds it.
  expect(host.filled[0]?.values).toEqual([account.username, "synthetic-answer"]);
  expect(host.given[0]).toEqual([account.username, ""]);
});

it("publishes only the latest verified sign-in, and none once a later one started", async () => {
  const host = harness({ held: account });
  await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeDefined();
      // A later sign-in's screen reached the page, so the verified one no longer describes it.
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
    }),
  );
});

it("judges a later build's first screen as typed into once an earlier build typed on the session's page", async () => {
  // The password screen as the host's inspection finds it, then its field taking the focus.
  const located = {
    fields: [{ target, described: { ...described, type: "password", id: "password" } }],
    submit: { target, described: { ...described, tag: "button", type: "submit", id: "sign-in" } },
    buttons: ["Sign in"],
    url: `${origin}/login`,
  };
  const page = (answers: unknown[]): AutofillPage => ({
    targetId: "primary",
    execute: () => Effect.sync(() => answers.shift() ?? { error: "not_found", target: 0 }),
  });
  const typing = { typed: false };
  const browserOn = (answers: unknown[]) =>
    makeSignInBrowser({
      page: page(answers),
      // The insertion reached the page, but its answer was lost.
      keyboard: { insertText: () => Effect.fail(new Error("Insertion reply lost")) },
      siteOrigin: origin,
      authenticationOrigins: [],
      onRequest: () => () => {},
      typing,
    });
  const step = {
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#sign-in",
  };
  const earlier = browserOn([located, { focused: true, url: `${origin}/login` }]);
  const inspected = await Effect.runPromise(earlier.inspect(step));
  if ("outcome" in inspected) throw new Error("Inspection refused");
  expect(inspected.judgedBeforeTyping).toBeUndefined();
  const report = await Effect.runPromise(
    earlier.fill({ step, values: ["synthetic-password"], inspection: inspected }),
  );
  expect(report).toMatchObject({ outcome: "uncertain", typed: true });
  expect(typing.typed).toBe(true);
  // A later build's browser on the same session starts as typed into.
  const later = await Effect.runPromise(browserOn([located]).inspect(step));
  expect(later).toMatchObject({ judgedBeforeTyping: [] });
});
