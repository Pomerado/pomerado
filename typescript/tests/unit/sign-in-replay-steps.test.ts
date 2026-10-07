import { Effect, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeReplayScreenWait, type SignInReplayBrowser } from "../../src/runtime/sign-in-replay-steps.js";

it.each(["not_found", "not_editable"] as const)(
  "keeps a required account choice when it is %s beside ready password fields",
  async (reason) => {
    const page = "https://example.test/login";
    const choice = { fields: [], submit: "#authorized-plan" } satisfies AutofillStep;
    const password = {
      fields: [{ slot: "password", selector: "#password" }],
      submit: "#submit",
    } satisfies AutofillStep;
    const later = { ...password, page };
    const browser: SignInReplayBrowser<never> = {
      inspect: (step) =>
        Effect.succeed(
          step.fields[0]?.selector === "#password"
            ? {
                page,
                siteOrigin: "https://example.test",
                authenticationOrigins: [],
                targets: { fields: [], submit: null },
                screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
              }
            : { outcome: "refused", reason },
        ),
      confirm: () =>
        Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page }),
      fill: () => Effect.dieMessage("Unexpected fill"),
      open: () => Effect.dieMessage("Unexpected open"),
      markerVisible: () => Effect.dieMessage("Unexpected marker"),
      onRequest: () => () => undefined,
      authenticationOrigins: [],
    };
    const wait = makeReplayScreenWait(
      {
        browser,
        entryUrl: page,
        recipe: {
          version: 1,
          steps: [{ ...choice, page }, later],
          signedIn: { selector: "#identity" },
        },
      },
      { anythingSent: false },
      { stepWaitMs: 0, pollMs: 1 },
      () => password,
    );
    const result = await Effect.runPromise(
      wait(choice, 0, page, [later]).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(result).toEqual({ found: { outcome: "refused", reason } });
  },
);
