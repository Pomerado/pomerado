import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeDialogDecider } from "../../src/inputs/dialog.js";
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
