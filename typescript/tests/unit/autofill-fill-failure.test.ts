import { Effect } from "effect";
import { expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";

const inspection: AutofillInspection = {
  page: "https://member.example.com/login",
  targets: { fields: [], submit: null },
  siteOrigin: "https://member.example.com",
  authenticationOrigins: [],
  screen: { origin: "https://member.example.com", fields: [], submit: null, buttons: [] },
};

const lostReply = (step: AutofillStep, values: readonly string[], siteMutation: () => void) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: {
        targetId: "primary",
        execute: () =>
          Effect.suspend(() => {
            siteMutation();
            return Effect.fail(new Error("The page executed, but its reply was lost"));
          }),
      },
      keyboard: { insertText: () => Effect.succeed("inserted" as const) },
    }),
  );

it("reports uncertainty when the first date fill ran but its reply was lost", async () => {
  let dateOnSite = "";
  const report = await lostReply(
    { fields: [{ slot: "date_of_birth", selector: "#birth-date" }] },
    ["1990-01-01"],
    () => {
      dateOnSite = "1990-01-01";
    },
  );
  expect(dateOnSite).toBe("1990-01-01");
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed" });
});

it("reports uncertainty when a submit-only method choice ran but its reply was lost", async () => {
  let chosenMethod: string | undefined;
  const report = await lostReply({ fields: [], submit: "#text-message" }, [], () => {
    chosenMethod = "sms";
  });
  expect(chosenMethod).toBe("sms");
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed" });
});

it("refuses an initial focus whose reply was lost before any credential reached the site", async () => {
  const report = await lostReply(
    { fields: [{ slot: "password", selector: "#password" }], submit: "#sign-in" },
    ["synthetic-password"],
    () => {},
  );
  expect(report).toMatchObject({ outcome: "refused", reason: "page_unavailable" });
});

it("keeps atomic insertion uncertain when it reached the site but its reply was lost", async () => {
  let siteValue = "";
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: { fields: [{ slot: "password", selector: "#password" }] },
      values: ["synthetic-password"],
      inspection,
      page: {
        targetId: "primary",
        execute: () => Effect.succeed({ focused: true, url: inspection.page }),
      },
      keyboard: {
        insertText: (_target, value) =>
          Effect.suspend(() => {
            siteValue = value;
            return Effect.fail(new Error("Private insertion reply lost"));
          }),
      },
    }),
  );
  expect(siteValue).toBe("synthetic-password");
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed" });
});
