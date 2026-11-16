import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import type { AskBounds, InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";

// A write that declares no commit step hands its browser to a person, then asks its purchase
// confirm. The person may have placed the order, so the host counts the opened hand-off as a page
// call: the confirm can't reuse an earlier yes, and the step reads possibly sent.

const entrypoint = "operation/src/tool.mjs";
const questions = {
  finish: { type: "browser_handoff", prompt: "Finish the checkout.", show_inputs: [] },
  approve: { type: "confirm", prompt: "Place this order?" },
} as const;
const source = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Unknown, questions: ${JSON.stringify(questions)}, write: { confirmation: "message" } },
  async ({ ask }) => {
    await ask("finish");
    return await ask({ approve: { order: { currency: "USD", items: [{ name: "Synthetic drink", quantity: 1, price: "6.00" }], total: "6.00" } } });
  });`;

it("counts an opened hand-off as a page call for the step's later asks and its effect", async () => {
  const asked: { readonly request: InputRequest; readonly bounds?: AskBounds }[] = [];
  const ask = (request: InputRequest, bounds?: AskBounds) =>
    Effect.gen(function* () {
      asked.push({ request, ...(bounds === undefined ? {} : { bounds }) });
      yield* bounds?.opened?.({ requestId: request.id, expiresAt: "", rejoined: false }) ??
        Effect.void;
      const handoff = request.questions.some((question) => question.type === "browser_handoff");
      const answers: ValidAnswers = handoff
        ? { finish: { type: "browser_handoff", value: { done: true } } }
        : { approve: { type: "confirm", value: { confirmed: true } } };
      return answers;
    });
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: {},
          browser: {
            sessionId: "local",
            executeResponse: () => Effect.succeed({ success: true, result: null }),
          },
          dispatchAtFirstCall: true,
          declaredQuestions: questions,
          ask,
        });
      }),
    ),
  );
  expect(asked.map(({ bounds }) => bounds?.commitsUnsent)).toEqual([true, undefined]);
  expect(result.effect).toBe("possible");
});
