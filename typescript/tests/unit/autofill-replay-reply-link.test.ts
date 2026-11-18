import { Data, Duration, Effect } from "effect";
import { expect, it } from "vitest";
import type { AutofillInspection } from "../../src/destinations/autofill-step.js";
import { signInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { SiteAnswer } from "../../src/runtime/autofill-replay-steps.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A site that answers a submitted credential screen with an emailed sign-in link instead of signing
// in: its answer leaves that screen showing, and the link signs in only the browser that opens it. A
// host that reads the site's answer as such a link (`hosted.siteAnswer`) has the replay ask the owner
// to paste it and open it, and the usual check after the screens decides. Without that read, the
// replay ends as a returned screen always has.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const account = `${origin}/account`;
const link = `${origin}/magic/example?token=xxxxxxxxxxxxxxxx`;
const passwordScreen = signInRecipe(
  [
    {
      page: login,
      fields: [
        { selector: "#user", slot: "username", accepts: ["username"] },
        { selector: "#password", slot: "password" },
      ],
      submit: "#sign-in",
    },
  ],
  { selector: "#account" },
);
// An identifier screen, then a password screen of its own.
const identifierFirst = signInRecipe(
  [
    {
      page: login,
      fields: [{ selector: "#user", slot: "username", accepts: ["username"] }],
      submit: "#next",
    },
    { page: login, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
  ],
  { selector: "#account" },
);
// An identifier screen alone, as a site that only ever signs in by an emailed link records.
const identifierOnly = signInRecipe(
  [
    {
      page: login,
      fields: [{ selector: "#user", slot: "username", accepts: ["username"] }],
      submit: "#next",
    },
  ],
  { selector: "#account" },
);
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};

/**
 * One replay of `recipe` on the site, whose login page shows `shown` (the username and password
 * fields by default) and which signs in at once when `signsIn`, else keeps its page after each
 * submit, its password field gone after one when `passwordGone`, with the host's read of its answer
 * (`siteAnswer`: `none` reads no answer, and undefined passes no read): what it asked, what it
 * opened, how many times the host read the answer and how it ended.
 */
const replay = (options: {
  readonly recipe?: typeof passwordScreen;
  readonly shown?: readonly string[];
  readonly signsIn?: true;
  readonly passwordGone?: true;
  readonly siteAnswer?: SiteAnswer | "none";
}) => {
  const state = { page: login, shown: new Set(options.shown ?? ["#user", "#password"]) };
  const asked: string[] = [];
  const opened: string[] = [];
  const reads = { current: 0 };
  const check = () =>
    Effect.sync(() =>
      state.page === account
        ? ({ signedIn: true, url: account } as const)
        : ({ signedIn: false, failed: "indicator_not_visible", url: state.page } as const),
    );
  const hooks: AutofillHooks<TestFailure> = {
    open: (url) =>
      Effect.sync(() => {
        opened.push(url);
        if (url === link) state.page = account;
      }),
    check,
    confirm: check,
    inspect: (step) =>
      Effect.sync(() =>
        state.page === login &&
        step.fields.length > 0 &&
        step.fields.every((field) => state.shown.has(field.selector))
          ? ({
              page: login,
              siteOrigin: origin,
              authenticationOrigins: [],
              targets: {
                fields: step.fields.map(() => target),
                submit: { ...target, editable: false, control: "other" as const },
              },
              screen: { origin, fields: [], submit: null, buttons: [] },
            } satisfies AutofillInspection)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        if (options.signsIn === true) state.page = account;
        if (options.passwordGone === true) state.shown.delete("#password");
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: login,
        };
      }),
  };
  const ask = makeInputAsker((request) =>
    Effect.sync(() =>
      Object.fromEntries(
        request.questions.map((question) => {
          asked.push(question.id);
          return [question.id, link];
        }),
      ),
    ),
  );
  const read = options.siteAnswer;
  return Effect.runPromise(
    replayAutofillRecipe({
      recipe: options.recipe ?? passwordScreen,
      hooks,
      entryUrl: login,
      credentials: { username: "synthetic-owner", password: "synthetic-password" },
      ask,
      broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
      site: "example.test",
      correlation: undefined,
      emit: () => Effect.void,
      failures: {
        unanswered: () => new TestFailure({ code: "Unanswered" }),
        unavailable: () => new TestFailure({ code: "Unavailable" }),
      },
      timing: {
        stepWaitMs: 60,
        pollMs: 2,
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
      },
      sent: { current: false },
      ...(read === undefined
        ? {}
        : {
            hosted: {
              siteAnswer: () =>
                Effect.sync(() => {
                  reads.current += 1;
                  return read === "none" ? undefined : read;
                }),
            },
          }),
    }).pipe(Effect.scoped),
  ).then((outcome) => ({ outcome, asked, opened, reads: reads.current }));
};

it("asks for the emailed link the site's answer to the password asked for, opens it and signs in", async () => {
  const signedIn = await replay({ siteAnswer: "link" });
  expect(signedIn.asked).toEqual(["sign_in_link"]);
  expect(signedIn.opened).toEqual([login, link]);
  expect(signedIn.outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(signedIn.reads).toBe(1);
});

// An identifier screen that came back is the site's answer too, as a site that emails its sign-in
// link for the identifier alone answers, after a password screen recorded or none.
it("asks for the emailed link the site's answer to an identifier screen asked for", async () => {
  for (const recipe of [identifierFirst, identifierOnly]) {
    const signedIn = await replay({ recipe, shown: ["#user"], siteAnswer: "link" });
    expect(signedIn.asked).toEqual(["sign_in_link"]);
    expect(signedIn.opened).toEqual([login, link]);
    expect(signedIn.outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
    expect(signedIn.reads).toBe(1);
  }
});

// An answer the host reads as no link, such as a wrong password, or no read at all, leaves the
// returned screen's ending as it was, and a sign-in the site took asks the host nothing.
it("asks nothing when the site's answer asked for no link, or the site signed in", async () => {
  for (const siteAnswer of ["none", undefined] as const) {
    const returned = await replay(siteAnswer === undefined ? {} : { siteAnswer });
    expect(returned.asked).toEqual([]);
    expect(returned.opened).toEqual([login]);
    expect(returned.outcome).toEqual({ outcome: "unclear", reason: "credential_screen_returned" });
  }
  const signedIn = await replay({ signsIn: true, siteAnswer: "link" });
  expect(signedIn.asked).toEqual([]);
  expect(signedIn.outcome).toMatchObject({ outcome: "signed_in" });
  expect(signedIn.reads).toBe(0);
});

// A screen that did not come back is no answer to read: a password screen whose field is gone
// after its submit never consults the host.
it("never reads the site's answer when the submitted screen did not come back", async () => {
  const passwordGone = await replay({ passwordGone: true, siteAnswer: "link" });
  expect(passwordGone.asked).toEqual([]);
  expect(passwordGone.reads).toBe(0);
  expect(passwordGone.outcome).not.toMatchObject({ outcome: "signed_in" });
});
