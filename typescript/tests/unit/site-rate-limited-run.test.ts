import { Effect } from "effect";
import { expect, it } from "vitest";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

// A synthetic search whose site answers with its own notice that it is limiting requests. The
// script throws the declared error with the site's words, so its host gets the site's limit as
// the run's code, apart from the tool's own failure.

const entrypoint = "operation/src/tool.mjs";
const limitedSearch = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ query: Schema.String }), output: Schema.Struct({ results: Schema.Array(Schema.String) }) },
  async ({ kernel, sessionId, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, { code: "return readResults();" });
    if (answer.result.notice !== undefined) throw new errors.SiteRateLimited(answer.result.notice);
    return { results: answer.result.items };
  });`;
const browser = {
  sessionId: "local",
  executeResponse: () =>
    Effect.succeed({ success: true, result: { notice: "Too many requests. Try again later." } }),
};

it("reports the site's limit, with the site's words, when a script throws SiteRateLimited", async () => {
  const failure = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, limitedSearch]],
          input: { query: "lamps" },
          browser,
        });
      }),
    ).pipe(Effect.flip),
  );
  expect(failure).toBeInstanceOf(LocalOperationFailure);
  expect(failure).toMatchObject({
    code: "SiteRateLimited",
    message: "Too many requests. Try again later.",
  });
}, 30_000);
