import { Schema } from "effect";
import { defineOperation, timeoutDefaults } from "../../src/browser/index.js";

const Picked = Schema.Union(
  Schema.Struct({ selected_key: Schema.NonEmptyString }),
  Schema.Struct({
    failure: Schema.Literal("query_mismatch", "option_identity_mismatch", "committed_key_mismatch"),
  }),
);

// These roles, names and data attributes describe one synthetic site's observed picker.
// A real site needs its own evidence for dialog ownership, query freshness and commitment.
export default defineOperation(
  {
    name: "select_catalog_item",
    input: Schema.Struct({
      query: Schema.NonEmptyString.annotations({ description: "Text to search the catalog for" }),
      key: Schema.NonEmptyString.annotations({
        description: "Catalog key of the item to select, as its option is named",
      }),
    }),
    output: Schema.Struct({
      selected_key: Schema.NonEmptyString.annotations({
        description: "Catalog key the page now shows as selected",
      }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        const query = ${JSON.stringify(input.query)};
        const key = ${JSON.stringify(input.key)};
        await page.getByRole("button", { name: "Choose catalog item", exact: true }).click({ timeout: ${timeoutDefaults.action} });
        // Locators are strict: two matching dialogs, inputs or options throw instead of guessing.
        const dialog = page.getByRole("dialog", { name: "Catalog item picker", exact: true });
        await dialog.waitFor({ state: "visible", timeout: ${timeoutDefaults.answerCap} });
        const search = dialog.getByRole("textbox", { name: "Find catalog item", exact: true });
        await search.fill(query, { timeout: ${timeoutDefaults.action} });
        // The site replaces the input and marks the dialog with the query its options belong
        // to. Old options can still be visible, so wait for that marker first.
        await dialog
          .and(page.locator("[data-query=" + JSON.stringify(query) + "]"))
          .waitFor({ timeout: ${timeoutDefaults.answerCap} });
        if ((await search.inputValue({ timeout: ${timeoutDefaults.action} })) !== query) return { failure: "query_mismatch" };
        const option = dialog.getByRole("option", { name: key, exact: true });
        await option.waitFor({ state: "visible", timeout: ${timeoutDefaults.answerCap} });
        if ((await option.getAttribute("data-key")) !== key || !(await option.isEnabled()))
          return { failure: "option_identity_mismatch" };
        await option.click({ timeout: ${timeoutDefaults.action} });
        // One click only. Missing commitment is reported, never clicked again.
        const committed = page.getByRole("textbox", { name: "Selected catalog key", exact: true });
        const until = Date.now() + ${timeoutDefaults.answerCap};
        while (Date.now() < until) {
          if ((await committed.inputValue({ timeout: 1000 })) === key) return { selected_key: key };
          await page.waitForTimeout(100);
        }
        return { failure: "committed_key_mismatch" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Picked)(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch: result.failure === "committed_key_mismatch" ? "sent" : "not_sent",
      });
    return result;
  },
);
