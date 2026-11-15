import { Data, Effect } from "effect";
import { expect, it } from "vitest";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";
import type { AnsweredLoginFields } from "../../src/runtime/login-values.js";
import { makeLoginFieldAsk, type CodeChannel } from "../../src/runtime/login-field-asks.js";

class UnavailableField extends Data.TaggedError("UnavailableField")<{
  readonly operation: string;
}> {}

/** The prompt of the one code question the owner is asked, answered with `123456`. */
const codePrompt = async (notice?: string, instruction?: string, channel?: CodeChannel) => {
  const given: { current: AnsweredLoginFields } = { current: {} };
  const { ask } = makeLoginFieldAsk({
    broker: { register: () => Effect.void },
    unavailable: (operation) => new UnavailableField({ operation }),
    site: "example.test",
    given,
  });
  const requests: InputRequest[] = [];
  const asker: InputAsker = (request) =>
    Effect.sync(() => {
      requests.push(request);
      return { code: { type: "secret", value: "123456" } };
    });
  await Effect.runPromise(ask(asker, "code", notice, false, 0, undefined, instruction, channel));
  const [question] = requests[0]?.questions ?? [];
  return question?.prompt ?? "";
};

const clock = "Codes expire in a few minutes, so enter it as soon as it arrives.";

it("tells the owner a sent code expires in minutes, first and when asked again", async () => {
  expect(await codePrompt()).toBe(`Enter the sign-in code example.test sent you. ${clock}`);
  expect(await codePrompt("The site refused the last code.")).toBe(
    `The site refused the last code. Enter the newest sign-in code example.test sent you. ${clock}`,
  );
  expect(await codePrompt(undefined, "Call 1-800-555-0100 within 5 minutes.")).toBe(
    `example.test shows this on its sign-in screen: “Call 1-800-555-0100 within 5 minutes.” Follow it, then enter the code here. ${clock}`,
  );
});

it.each([
  [
    { kind: "text", destination: "(•••) •••-1234" },
    `Enter the sign-in code example.test texted to (•••) •••-1234. ${clock}`,
  ],
  [
    { kind: "text", destination: "ending in 9876" },
    `Enter the sign-in code example.test texted to the number ending in 9876. ${clock}`,
  ],
  [{ kind: "text" }, `Enter the sign-in code example.test texted you. ${clock}`],
  [
    { kind: "email", destination: "a•••@example.com" },
    `Enter the sign-in code example.test emailed to a•••@example.com. ${clock}`,
  ],
  [
    { kind: "call", destination: "(•••) •••-4321" },
    `Enter the sign-in code example.test read out in a call to (•••) •••-4321. ${clock}`,
  ],
  [
    { kind: "authenticator" },
    "Enter the sign-in code your authenticator app shows for example.test. It changes about every 30 seconds, so enter the one it shows now.",
  ],
] as const)("names how the code came: %j", async (channel, prompt) => {
  expect(await codePrompt(undefined, undefined, channel)).toBe(prompt);
});

it("names how the newest code came when asked again", async () => {
  expect(
    await codePrompt("The site refused the last code.", undefined, {
      kind: "email",
      destination: "a•••@example.com",
    }),
  ).toBe(
    `The site refused the last code. Enter the newest sign-in code example.test emailed to a•••@example.com. ${clock}`,
  );
});
