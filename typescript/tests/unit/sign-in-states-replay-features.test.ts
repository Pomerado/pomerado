import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { SignInChoice } from "../../src/destinations/autofill-contracts.js";
import type { SignInStates, SignInStatesChoices } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { featureSite, origin, type Screen, SiteFailure, stepOn, storedLibrary } from "../support/sign-in-states-site.js";

// Each sign-in feature a recipe step carries, replayed from a library of states that went through
// the store: the screen's step does on the page what the recipe's step did.

const answers: Readonly<Record<string, string>> = {
  code: "246810",
  private_answer: "made-up school",
  private_identifier: "4825-1937",
};

const replay = (
  site: ReturnType<typeof featureSite>,
  library: SignInStates,
  options: {
    readonly credentials?: WebsiteCredentials;
    readonly allowedChoices?: readonly SignInChoice[];
    readonly choices?: SignInStatesChoices;
  } = {},
) => {
  const asked: { readonly id: string; readonly prompt: string }[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(
          request.questions.map((question) => {
            asked.push({ id: question.id, prompt: question.prompt });
            return [question.id, answers[question.id] ?? ""];
          }),
        ) as InputAnswers,
    ),
  );
  return Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe: site.observe,
        hooks: site.hooks,
        entryUrl: `${origin}/sign-in`,
        credentials: options.credentials ?? { username: "owner@example.test", password: "secret-1" },
        ask,
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new SiteFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new SiteFailure({ code: "unavailable" }),
        },
        ...(options.allowedChoices === undefined ? {} : { hosted: { allowedChoices: options.allowedChoices } }),
        ...(options.choices === undefined ? {} : { choices: options.choices }),
        timing: { stepWaitMs: 300, pollMs: 2 },
        quiet: { quietMs: 20, capMs: 120, enterMs: 40 },
        sent: { current: false },
      }),
    ),
  ).then((outcome) => {
    if (Either.isLeft(outcome)) throw outcome.left;
    return { ...outcome.right, asked };
  });
};

const email = { selector: "#email", accepts: ["email" as const] };
const password = { selector: "#password", slot: "password" as const };
const code = { selector: "#code", slot: "code" as const };
const loginScreen = (more: Partial<Screen> = {}): Screen => ({
  path: "/sign-in",
  boxes: [
    { selector: "#email", kind: "identifier", takes: "email" },
    { selector: "#password", kind: "password" },
  ],
  controls: ["#sign-in"],
  ...more,
});
const login = stepOn(loginScreen(), { fields: [email, password], submit: "#sign-in" });
const codeScreen: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], controls: ["#verify"] };
/** A site that goes from `start` to each screen in turn, one press each, then signs in. */
const inTurn = (...screens: readonly Screen[]) => {
  const names = ["start", ...screens.slice(1).map((_screen, index) => `screen-${index + 1}`)];
  return featureSite(
    Object.fromEntries(screens.map((screen, index) => [names[index], screen])),
    (at) => names[names.indexOf(at) + 1] ?? "home",
  );
};

for (const [drawn, when] of [
  ["arrival", "on arrival"],
  ["filled", "once every box is typed"],
] as const)
  it(`clicks the covering notice's own control the screen recorded, when the notice shows ${when}`, async () => {
    const screen = loginScreen({ notice: { control: "#reject", drawn } });
    const library = storedLibrary([[screen, stepOn(screen, { fields: [email, password], submit: "#sign-in", dismiss: "#reject" })]]);
    const site = inTurn(screen);
    expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
    // Before anything is typed, as a recipe's step clicks it; else before the submit it covers.
    expect(site.actions).toEqual(
      drawn === "arrival"
        ? ["dismiss #reject", "type #email", "type #password", "press #sign-in"]
        : ["type #email", "type #password", "dismiss #reject", "press #sign-in"],
    );
  });

for (const via of ["keyboard", "click_layer"] as const)
  it(`sends a covered submit as the screen recorded it: ${via}`, async () => {
    // The site's own control over the submit takes a click through it by itself, as core clicks it.
    const screen = loginScreen(via === "keyboard" ? { covered: true } : {});
    const library = storedLibrary([[screen, stepOn(screen, { fields: [email, password], submit: "#sign-in", submitVia: via })]]);
    const site = inTurn(screen);
    expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
    expect(site.presses.map((press) => press.submitVia)).toEqual([via]);
  });

it("picks the login's method from a native select by its option", async () => {
  const methodScreen: Screen = {
    path: "/verify-by",
    boxes: [],
    controls: ["#method"],
    message: "how should we send your code",
    labels: ["send my code by"],
  };
  const methods = [
    { method: "totp" as const, selector: "#method", option: "app" },
    { method: "email" as const, selector: "#method", option: "mail" },
  ];
  const library = storedLibrary([
    [loginScreen(), login],
    [methodScreen, stepOn(methodScreen, { fields: [], submit: "#method", methods })],
    [codeScreen, stepOn(codeScreen, { fields: [code], submit: "#verify" })],
  ]);
  // The select shows the code box only once the method's own option is chosen.
  const site = featureSite({ start: loginScreen(), method: methodScreen, code: codeScreen }, (at, _pressed, step) =>
    at === "start" ? "method" : at === "method" ? (step.option === "mail" ? "code" : undefined) : "home",
  );
  expect(await replay(site, library, { choices: { method: "email" } })).toMatchObject({ outcome: "signed_in" });
  expect(site.actions).toContain("select #method mail");
  expect(site.typed.map(({ slot }) => slot)).toEqual(["email", "password", "code"]);
});

it("presses a lasting choice only when the caller allowed it, and otherwise stops before it", async () => {
  const trustScreen: Screen = {
    path: "/trust",
    boxes: [],
    controls: ["#trust"],
    message: "trust this browser",
    labels: ["trust"],
  };
  const library = storedLibrary([
    [loginScreen(), login],
    [trustScreen, stepOn(trustScreen, { fields: [], submit: "#trust", choice: "trust_this_device" })],
  ]);
  const allowed = inTurn(loginScreen(), trustScreen);
  expect(await replay(allowed, library, { allowedChoices: ["trust_this_device"] })).toMatchObject({
    outcome: "signed_in",
  });
  expect(allowed.presses.at(-1)).toMatchObject({ submit: "#trust", choice: "trust_this_device" });
  const refused = inTurn(loginScreen(), trustScreen);
  expect(await replay(refused, library)).toMatchObject({ reason: "sign_in_choice_not_allowed" });
  expect(refused.actions).not.toContain("press #trust");
});

it("types the login's private identifier, and asks for one it lacks by the site's own label", async () => {
  const screen: Screen = {
    path: "/sign-in",
    boxes: [
      { selector: "#pin", kind: "identifier", takes: "other" },
      { selector: "#password", kind: "password" },
    ],
    controls: ["#sign-in"],
  };
  const pin = { selector: "#pin", accepts: ["private_identifier" as const], label: "Member PIN" };
  const library = storedLibrary([[screen, stepOn(screen, { fields: [pin, password], submit: "#sign-in" })]]);
  const held = inTurn(screen);
  const kept = { username: "member-one", privateIdentifier: "7391-0264", password: "secret-1" };
  expect(await replay(held, library, { credentials: kept })).toMatchObject({ outcome: "signed_in", asked: [] });
  expect(held.typed[0]).toEqual({ slot: "private_identifier", value: "7391-0264" });
  const lacking = inTurn(screen);
  const ended = await replay(lacking, library, { credentials: { username: "member-one", password: "secret-1" } });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(ended.asked).toEqual([{ id: "private_identifier", prompt: expect.stringContaining("Enter the Member PIN ") }]);
  expect(lacking.typed[0]).toEqual({ slot: "private_identifier", value: answers["private_identifier"] });
});

it("types a phone number without its calling code into a box the screen recorded as national", async () => {
  const screen: Screen = {
    path: "/sign-in",
    boxes: [
      { selector: "#phone", kind: "identifier", takes: "phone" },
      { selector: "#password", kind: "password" },
    ],
    controls: ["#sign-in"],
  };
  const phone = { selector: "#phone", accepts: ["phone" as const], format: "national" as const };
  const library = storedLibrary([[screen, stepOn(screen, { fields: [phone, password], submit: "#sign-in" })]]);
  const site = inTurn(screen);
  const credentials = {
    username: "+14155550134",
    phone: "+14155550134",
    primaryIdentifierKind: "phone" as const,
    password: "secret-1",
  };
  expect(await replay(site, library, { credentials })).toMatchObject({ outcome: "signed_in" });
  expect(site.typed[0]).toEqual({ slot: "phone", value: "4155550134" });
});

it("types the password again on a later screen that recorded it as a refill", async () => {
  const again: Screen = {
    path: "/verify",
    boxes: [
      { selector: "#password", kind: "password" },
      { selector: "#code", kind: "code" },
    ],
    controls: ["#verify"],
  };
  const library = storedLibrary([
    [loginScreen(), login],
    [again, stepOn(again, { fields: [password, code], submit: "#verify", refills: ["password"] })],
  ]);
  const site = inTurn(loginScreen(), again);
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.typed.map(({ slot }) => slot)).toEqual(["email", "password", "password", "code"]);
});

it("asks the security question the screen shows, and types the answer", async () => {
  const question = "What was the name of your first school?";
  const screen: Screen = {
    path: "/question",
    boxes: [{ selector: "#answer", kind: "identifier", takes: "other", question: { selector: "#question", text: question } }],
    controls: ["#question", "#go"],
  };
  const answer = { selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" };
  const library = storedLibrary([
    [loginScreen(), login],
    [screen, stepOn(screen, { fields: [answer], submit: "#go" })],
  ]);
  const site = inTurn(loginScreen(), screen);
  const ended = await replay(site, library);
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(ended.asked).toEqual([{ id: "private_answer", prompt: `example.test asks this security question: ${question}` }]);
  expect(site.typed.at(-1)).toEqual({ slot: "private_answer", value: answers["private_answer"] });
});

// A library recorded with the page's words, as a host records by default: the second question's
// page is told by its notice beside the same box. A run answers each question the site asks once.
it("never answers a security question twice, though the library keeps a page's words", async () => {
  const [school, teacher] = ["What was the name of your first school?", "What was the name of your first teacher?"];
  const asks = (text: string, message?: string): Screen => ({
    path: "/question",
    boxes: [{ selector: "#answer", kind: "identifier", takes: "other", question: { selector: "#question", text } }],
    controls: ["#question", "#go"],
    ...(message === undefined ? {} : { message }),
  });
  const answer = stepOn(asks(school), {
    fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }],
    submit: "#go",
  });
  const library = storedLibrary([
    [loginScreen(), login],
    [asks(school), answer],
    [asks(teacher, "One more to go"), answer],
  ]);
  const questions = (ended: { readonly asked: readonly { readonly prompt: string }[] }) =>
    ended.asked.map(({ prompt }) => prompt.replace("example.test asks this security question: ", ""));
  const both = await replay(inTurn(loginScreen(), asks(school), asks(teacher, "One more to go")), library);
  expect(both).toMatchObject({ outcome: "signed_in" });
  expect(questions(both)).toEqual([school, teacher]);
  const again = await replay(inTurn(loginScreen(), asks(school), asks(school, "One more to go")), library);
  expect(again).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(questions(again)).toEqual([school]);
});

it("types the kind the login holds into a box that takes several", async () => {
  const screen: Screen = {
    path: "/sign-in",
    boxes: [
      { selector: "#id", kind: "identifier", takes: "other" },
      { selector: "#password", kind: "password" },
    ],
    controls: ["#sign-in"],
  };
  const either = { selector: "#id", accepts: ["email" as const, "account_number" as const] };
  const library = storedLibrary([[screen, stepOn(screen, { fields: [either, password], submit: "#sign-in" })]]);
  for (const [credentials, held] of [
    [{ username: "owner@example.test", password: "secret-1" }, { slot: "email", value: "owner@example.test" }],
    [
      { username: "7012345678", accountNumber: "7012345678", primaryIdentifierKind: "account_number" as const, password: "secret-1" },
      { slot: "account_number", value: "7012345678" },
    ],
  ] as const) {
    const site = inTurn(screen);
    expect(await replay(site, library, { credentials })).toMatchObject({ outcome: "signed_in", asked: [] });
    expect(site.typed[0]).toEqual(held);
  }
});
