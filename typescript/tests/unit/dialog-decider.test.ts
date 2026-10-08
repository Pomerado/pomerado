import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  keepingAcceptedConfirms,
  makeDialogDecider,
  makeRunDialogDecider,
} from "../../src/inputs/dialog.js";
import { expectedConfirmDigest, type ObservedConfirm } from "../../src/browser/dialogs/expected.js";
import { noIncidents, type DialogIncident } from "../../src/runtime/incidents.js";
import { InputRequestFailure, type InputRequest } from "../../src/runtime/input-request.js";
import type { DialogReport } from "../../src/runtime/kernel-operation.js";

const report = (type: DialogReport["type"], message = "Place this order?") => ({
  interactionId: "interaction-1",
  step: "place-order",
  type,
  message,
  url: "https://shop.example/cart",
});

/** An asker that answers every dialog question with `choice`, and a prompt's text with `text`. */
const answering = (choice: "accept" | "dismiss", text = "typed") => {
  const asked: InputRequest[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return request.questions[0]?.id === "text" ? { text } : { choice };
    }),
  );
  return { ask, asked };
};

it("asks the caller about every dialog type and returns the caller's choice", async () => {
  for (const type of ["alert", "confirm", "prompt", "beforeunload"] as const) {
    const { ask, asked } = answering("dismiss");
    const decide = makeDialogDecider(ask, (text) => text.replaceAll("order", "[private]"));
    expect(await Effect.runPromise(decide(report(type)))).toEqual({ choice: "dismiss" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.notice).toBe(
      `${type} from https://shop.example/cart\nPlace this [private]?`,
    );
  }
});

it("accepts a confirm the caller accepts, and asks a prompt's text after an accept", async () => {
  const confirm = answering("accept");
  expect(await Effect.runPromise(makeDialogDecider(confirm.ask, String)(report("confirm")))).toEqual(
    { choice: "accept" },
  );
  const prompt = answering("accept", "gift note");
  expect(await Effect.runPromise(makeDialogDecider(prompt.ask, String)(report("prompt")))).toEqual({
    choice: "accept",
    promptText: "gift note",
  });
  expect(prompt.asked).toHaveLength(2);
});

it("fails the decision when the caller's answer never comes", async () => {
  const ask = makeInputAsker(() => Effect.fail(new InputRequestFailure({ code: "NoResponse" })));
  const decided = await Effect.runPromise(
    Effect.either(makeDialogDecider(ask, String)(report("confirm"))),
  );
  expect(Either.isLeft(decided) && decided.left).toMatchObject({
    _tag: "DialogFailure",
    reason: "unavailable",
  });
});

const recorded = expectedConfirmDigest({
  message: "Place this order?",
  origin: "https://shop.example",
  step: "place-order",
});
const runDecider = (
  ask: ReturnType<typeof answering>["ask"],
  options: { readonly readOnly?: boolean; readonly incidents?: DialogIncident[] } = {},
) =>
  makeRunDialogDecider({
    ask,
    project: String,
    readOnly: options.readOnly ?? false,
    expectedConfirms: [recorded],
    incidents:
      options.incidents === undefined
        ? noIncidents
        : {
            record: (incident) =>
              Effect.sync(() => {
                options.incidents?.push(incident);
              }),
          },
  });

it("accepts the confirm a write's build accepted, at its step, without asking", async () => {
  const { ask, asked } = answering("dismiss");
  const incidents: DialogIncident[] = [];
  const decide = runDecider(ask, { incidents });
  expect(await Effect.runPromise(decide(report("confirm", "Place  this order?")))).toEqual({
    choice: "accept",
  });
  expect(asked).toEqual([]);
  expect(incidents).toMatchObject([{ reason: "dialog_expected_confirm_accepted" }]);
  // One record accepts one popup: the same confirm again asks.
  expect(await Effect.runPromise(decide(report("confirm")))).toEqual({ choice: "dismiss" });
  expect(asked).toHaveLength(1);
});

it("asks the caller about every other dialog, as before", async () => {
  const { ask, asked } = answering("accept");
  const decide = runDecider(ask);
  for (const shown of [
    report("confirm", "Remove this item?"),
    { ...report("confirm"), step: "remove-item" },
    { ...report("confirm"), url: "https://other.example/cart" },
    report("alert"),
    report("beforeunload"),
  ])
    expect(await Effect.runPromise(decide(shown))).toEqual({ choice: "accept" });
  expect(asked).toHaveLength(5);
  // A tool published without a record asks about every confirm, as before.
  const older = answering("dismiss");
  const unrecorded = makeRunDialogDecider({
    ask: older.ask,
    project: String,
    readOnly: false,
    expectedConfirms: undefined,
    incidents: noIncidents,
  });
  expect(await Effect.runPromise(unrecorded(report("confirm")))).toEqual({ choice: "dismiss" });
  expect(older.asked).toHaveLength(1);
  // A read tool never accepts from the record.
  const read = answering("dismiss");
  expect(await Effect.runPromise(runDecider(read.ask, { readOnly: true })(report("confirm")))).toEqual(
    { choice: "dismiss" },
  );
  expect(read.asked).toHaveLength(1);
});

it("dismisses, never accepts, a dialog whose answer never comes", async () => {
  const incidents: DialogIncident[] = [];
  const unanswered = makeInputAsker(() =>
    Effect.fail(new InputRequestFailure({ code: "NoResponse" })),
  );
  const decide = runDecider(unanswered, { incidents });
  for (const type of ["confirm", "alert", "prompt"] as const)
    expect(await Effect.runPromise(decide(report(type, "Remove this item?")))).toEqual({
      choice: "dismiss",
    });
  expect(incidents.map((incident) => [incident.reason, incident.subCause])).toEqual([
    ["dialog_decision_expired", "confirm_dismiss"],
    ["dialog_decision_expired", "alert_dismiss"],
    ["dialog_decision_expired", "prompt_dismiss"],
  ]);
  // A prompt accepted without its text is dismissed too.
  const noText = makeInputAsker((request) =>
    request.questions[0]?.id === "text"
      ? Effect.fail(new InputRequestFailure({ code: "NoResponse" }))
      : Effect.succeed({ choice: "accept" }),
  );
  expect(await Effect.runPromise(runDecider(noText)(report("prompt")))).toEqual({
    choice: "dismiss",
  });
});

it("keeps the confirms the owner accepts while building, as the page showed them", async () => {
  const accepted: ObservedConfirm[] = [];
  const { ask } = answering("accept");
  const decide = keepingAcceptedConfirms(makeDialogDecider(ask, String), accepted);
  await Effect.runPromise(decide(report("confirm")));
  await Effect.runPromise(decide(report("alert")));
  await Effect.runPromise(decide({ ...report("confirm"), url: "http://shop.example/cart" }));
  expect(accepted).toEqual([
    { message: "Place this order?", origin: "https://shop.example", step: "place-order" },
  ]);
  const dismissing = answering("dismiss");
  const none: ObservedConfirm[] = [];
  await Effect.runPromise(
    keepingAcceptedConfirms(makeDialogDecider(dismissing.ask, String), none)(report("confirm")),
  );
  expect(none).toEqual([]);
});
