import { Data, Duration, Effect } from "effect";
import { expect, it } from "vitest";
import type { AutofillInspection } from "../../src/destinations/autofill-step.js";
import { signInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A site that answers a password with an emailed sign-in link instead of signing in: its answer
// leaves the password screen showing, and the link signs in only the browser that opens it. A host
// that reads the site's answer as asking for that link (`hosted.replyAskedLink`) has the replay ask
// the owner to paste it, open it and check the marker. Without that read, the replay ends as the
// returned password screen always has.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const account = `${origin}/account`;
const link = `${origin}/magic/example?token=xxxxxxxxxxxxxxxx`;
const recipe = signInRecipe(
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
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};

/**
 * One replay on the site, which signs in at once when `signsIn`, else keeps the password screen
 * with the host's read of its answer (`replyAskedLink`, none when undefined): what it asked, what
 * it opened, how many times the host read the answer and how it ended.
 */
const replay = (options: { readonly signsIn?: true; readonly replyAskedLink?: boolean }) => {
  const state = { page: login };
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
        state.page === login && step.fields.length > 0
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
  const read = options.replyAskedLink;
  return Effect.runPromise(
    replayAutofillRecipe({
      recipe,
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
              replyAskedLink: () =>
                Effect.sync(() => {
                  reads.current += 1;
                  return read;
                }),
            },
          }),
    }).pipe(Effect.scoped),
  ).then((outcome) => ({ outcome, asked, opened, reads: reads.current }));
};

it("asks for the emailed link the site's answer to the password asked for, opens it and signs in", async () => {
  const signedIn = await replay({ replyAskedLink: true });
  expect(signedIn.asked).toEqual(["sign_in_link"]);
  expect(signedIn.opened).toEqual([login, link]);
  expect(signedIn.outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(signedIn.reads).toBe(1);
});

// An answer the host reads as no link, such as a wrong password, or no read at all, leaves the
// returned password screen's ending as it was, and a sign-in the site took asks the host nothing.
it("asks nothing when the site's answer asked for no link, or the site signed in", async () => {
  for (const replyAskedLink of [false, undefined]) {
    const returned = await replay(replyAskedLink === undefined ? {} : { replyAskedLink });
    expect(returned.asked).toEqual([]);
    expect(returned.opened).toEqual([login]);
    expect(returned.outcome).toEqual({ outcome: "unclear", reason: "credential_screen_returned" });
  }
  const signedIn = await replay({ signsIn: true, replyAskedLink: true });
  expect(signedIn.asked).toEqual([]);
  expect(signedIn.outcome).toMatchObject({ outcome: "signed_in" });
  expect(signedIn.reads).toBe(0);
});
