import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import type { ObservedState } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import { mintSessionSignIns } from "../../src/runtime/session-sign-in.js";
import { makeBoundableAsk, makeLocalSessionSignIn } from "../../src/standalone/session-sign-in.js";

// A build's sign-in is read as a state before each screen it fills, so its verified sign-in
// publishes as screens; one whose screen could not be read as a state publishes as unreadable.

const origin = "https://www.example.test";
const login: WebsiteCredentials = { username: "ada-owner", password: "synthetic-password" };
/** The login screen as the minter sends it: the identifier box takes the login's username. */
const loginScreen: SignInStep = {
  fields: [
    { selector: "#username", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const loginState: ObservedState = {
  fingerprint: {
    top: origin,
    boxes: [
      { frame: origin, kind: "identifier" },
      { frame: origin, kind: "password" },
    ],
    submit: true,
  },
  boxes: [
    { frame: origin, kind: "identifier", empty: true, submit: true },
    { frame: origin, kind: "password", empty: true, submit: true },
  ],
  texts: [],
};
const blank: ObservedState = {
  fingerprint: { top: origin, boxes: [], submit: false },
  boxes: [],
  texts: [],
};

/** A control on the site's own login form, as the host's inspection describes it. */
const target = {
  ownerUrl: `${origin}/login`,
  documentOrigin: origin,
  actions: [`${origin}/login`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
  empty: true,
};
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

/** A build's sign-in on a one-screen site whose page reads as each of `reads` in turn. */
const record = async (reads: readonly (ObservedState | undefined)[]) => {
  const left = [...reads];
  let observed = 0;
  let signedIn = false;
  const secrets = makeRunSecrets();
  const inspection = (step: AutofillStep): AutofillInspection => {
    return {
      url: `${origin}/login`,
      page: `${origin}/login`,
      targets: {
        fields: step.fields.map(() => target),
        submit: step.submit === undefined ? null : target,
      },
      siteOrigin: origin,
      authenticationOrigins: [],
      screen: {
        origin,
        fields: step.fields.map((field) => ({
          ...described,
          type: field.slot === "password" ? "password" : "text",
          slot: field.slot,
        })),
        submit: null,
        buttons: [],
      },
    };
  };
  const recorder = makeSignInRecorder({
    browser: {
      inspect: (step) => Effect.succeed(inspection(step)),
      fill: ({ step }) =>
        Effect.sync((): AutofillStepReport => {
          signedIn = true;
          return {
            outcome: "filled",
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked",
            url: `${origin}/account`,
          };
        }),
      confirm: () =>
        Effect.succeed<AutofillSignedInCheck>(
          signedIn
            ? { signedIn: true, url: `${origin}/account` }
            : { signedIn: false, failed: "indicator_not_visible", url: `${origin}/login` },
        ),
      authenticationOrigins: [],
      open: () => Effect.void,
      markerVisible: () => Effect.succeed(false),
      observe: () =>
        Effect.sync(() => {
          observed += 1;
          return left.shift();
        }),
    },
    login: {
      held: () => undefined,
      values: Effect.sync(() => {
        secrets.register(login.username);
        if (login.password !== undefined) secrets.register(login.password);
        return login;
      }),
      correct: () => Effect.die("the login takes no correction"),
    },
    ask: makeInputAsker(() => Effect.die("nothing is asked")),
    secrets,
    review: () => Effect.void,
    site: "example.test",
    signedOutPages: () => [],
  });
  const filled = await Effect.runPromise(recorder.step(loginScreen, `${origin}/login`, Effect.void));
  expect(filled.report?.outcome).toBe("filled");
  const checked = await Effect.runPromise(
    recorder.step({ signedIn: { selector: "#account" } }, undefined, Effect.void),
  );
  expect(checked.verified).toBe(true);
  return { published: recorder.published(), observed };
};

it("publishes a verified sign-in with its screens: each screen read as a state before its fill, and the marker", async () => {
  const { published, observed } = await record([loginState]);
  expect(observed).toBe(1);
  expect(published).not.toHaveProperty("unreadable");
  expect(published?.states?.states).toEqual([
    expect.objectContaining({
      kind: "state",
      fingerprint: loginState.fingerprint,
      step: published?.recipe.steps[0],
    }),
  ]);
  expect(published?.states?.signedIn).toEqual([
    expect.objectContaining({ kind: "signed_in", selector: "#account" }),
  ]);
  // The screens hold no value the sign-in typed.
  expect(JSON.stringify(published?.states)).not.toContain(login.username);
});

it("reads a screen again once when its first read finds nothing or a blank page", async () => {
  for (const first of [undefined, blank]) {
    const { published, observed } = await record([first, loginState]);
    expect(observed).toBe(2);
    expect(published?.states?.states).toHaveLength(1);
  }
});

it("publishes a sign-in whose screen read as no state twice as unreadable, with no screens", async () => {
  for (const reads of [[undefined, undefined], [blank, blank], []]) {
    const { published } = await record(reads);
    expect(published).toMatchObject({ unreadable: true, entryUrl: `${origin}/login` });
    expect(published).not.toHaveProperty("states");
  }
});

it("fails a build's sign-in again with an unreadable sign-in where the page reads signed out, typing nothing", async () => {
  const { published } = await record([]);
  if (published === undefined) throw new Error("no published sign-in");
  const calls: string[] = [];
  const untouched = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
      throw new Error(`The sign-in again called ${call}`);
    });
  const session = makeLocalSessionSignIn({
    browser: {
      inspect: () => untouched("inspect"),
      fill: () => untouched("fill"),
      confirm: () =>
        Effect.succeed<AutofillSignedInCheck>({
          signedIn: false,
          failed: "password_field_visible",
          url: `${origin}/login`,
        }),
      authenticationOrigins: [],
      open: () => untouched("open"),
      markerVisible: () => Effect.succeed(false),
    },
    recorded: () => published,
    login: {
      login: {
        held: () => login,
        values: Effect.succeed(login),
        correct: () => Effect.die("the login takes no correction"),
      },
    },
    asks: makeBoundableAsk(makeInputAsker(() => Effect.die("nothing is asked"))),
    secrets: makeRunSecrets(),
    site: "example.test",
    siteOrigin: origin,
    limits: mintSessionSignIns,
    scope: "check",
  });
  const again = await Effect.runPromise(Effect.either(session.ensureSignedIn("signed_out_mid_operation")));
  expect(Either.isLeft(again) && again.left).toMatchObject({
    refusal: "session_sign_in_failed",
    failure: { code: "MissingRecipe" },
  });
  expect(calls).toEqual([]);
});

it("reads a device approval's page as a state before the owner approves, as the site moves on once they do", async () => {
  const identifierScreen: SignInStep = {
    fields: [{ selector: "#username", accepts: ["username"] }],
    submit: "#next",
  };
  const pageState = (top: string, boxes: ObservedState["boxes"], message?: string): ObservedState => ({
    fingerprint: {
      top,
      boxes: boxes.map(({ frame, kind }) => ({ frame, kind })),
      submit: boxes.length > 0,
      ...(message === undefined ? {} : { message }),
    },
    boxes,
    texts: [],
  });
  const identifierPage = pageState(origin, [{ frame: origin, kind: "identifier", empty: true, submit: true }]);
  const approvalPage = pageState(origin, [], "~ the request on your device");
  const accountPage = pageState(origin, [], "~ back");
  /** The page the browser shows: the approval once the identifier went, the account once approved. */
  let at: "login" | "approval" | "account" = "login";
  const secrets = makeRunSecrets();
  const recorder = makeSignInRecorder({
    browser: {
      inspect: (step) =>
        Effect.succeed<AutofillInspection>({
          url: `${origin}/${at}`,
          page: `${origin}/${at}`,
          targets: {
            fields: step.fields.map(() => target),
            submit: step.submit === undefined ? null : target,
          },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({ ...described, slot: field.slot })),
            submit: null,
            buttons: [],
          },
        }),
      fill: ({ step }) =>
        Effect.sync((): AutofillStepReport => {
          at = "approval";
          return {
            outcome: "filled",
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked",
            url: `${origin}/approval`,
          };
        }),
      confirm: () =>
        Effect.succeed<AutofillSignedInCheck>(
          at === "account"
            ? { signedIn: true, url: `${origin}/account` }
            : { signedIn: false, failed: "indicator_not_visible", url: `${origin}/${at}` },
        ),
      authenticationOrigins: [],
      open: () => Effect.void,
      markerVisible: () => Effect.succeed(false),
      observe: () =>
        Effect.succeed(at === "login" ? identifierPage : at === "approval" ? approvalPage : accountPage),
    },
    login: {
      held: () => undefined,
      values: Effect.sync(() => {
        secrets.register(login.username);
        return login;
      }),
      correct: () => Effect.die("the login takes no correction"),
    },
    // The owner approves on their device, and the site moves on to the account.
    ask: makeInputAsker(() =>
      Effect.sync(() => {
        at = "account";
        return { approved: { confirmed: true } };
      }),
    ),
    secrets,
    review: () => Effect.void,
    site: "example.test",
    signedOutPages: () => [],
  });
  await Effect.runPromise(recorder.step(identifierScreen, `${origin}/login`, Effect.void));
  const approved = await Effect.runPromise(recorder.step({ approval: "device" }, undefined, Effect.void));
  expect(approved.approved).toBe(true);
  const checked = await Effect.runPromise(
    recorder.step({ signedIn: { selector: "#account" } }, undefined, Effect.void),
  );
  expect(checked.verified).toBe(true);
  const published = recorder.published();
  expect(published?.states?.states.map((state) => [state.step.approval, state.fingerprint])).toEqual([
    [undefined, identifierPage.fingerprint],
    ["device", approvalPage.fingerprint],
  ]);
});
