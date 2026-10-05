import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";

const AirportCode = Schema.String.pipe(Schema.pattern(/^[A-Z]{1,4}$/));

// An observed ARIA combobox that owns one listbox through aria-controls. The data-key,
// data-query and "Selected airport" status are this site's evidence, not general rules.
export default defineOperation(
  {
    name: "choose_airport",
    input: Schema.Struct({
      code: AirportCode.annotations({
        description: "Code of the airport to choose, one to four capital letters",
      }),
      query: Schema.NonEmptyString.annotations({
        description: "Text to type into the airport search, such as a city name",
      }),
    }),
    output: Schema.Struct({
      code: AirportCode.annotations({ description: "Code of the airport the site now shows" }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        const code = ${JSON.stringify(input.code)};
        const query = ${JSON.stringify(input.query)};
        const combobox = page.getByRole("combobox", { name: "Airport", exact: true });
        // Search only inside the listbox this control owns, never the whole page.
        const popupId = await combobox.getAttribute("aria-controls", { timeout: 30000 });
        if (!popupId) return { failure: "ownership_unknown" };
        const popup = page.locator("[id=" + JSON.stringify(popupId) + "]");
        if ((await combobox.getAttribute("aria-expanded")) !== "true")
          await combobox.click({ timeout: 30000 });
        await combobox.fill(query, { timeout: 30000 });
        // Old options can stay visible, so wait until the listbox answers this query.
        await popup
          .and(page.locator("[data-query=" + JSON.stringify(query) + "]"))
          .waitFor({ state: "visible", timeout: 30000 });
        const option = popup.locator("[role=option][data-key=" + JSON.stringify(code) + "]");
        if ((await option.count()) !== 1) return { failure: "option_missing" };
        if ((await option.getAttribute("aria-disabled")) === "true")
          return { failure: "option_disabled" };
        await option.click({ timeout: 30000 });
        // The control's name can change after a choice, so read the committed code from the
        // site's status instead of the combobox.
        const selected = page.getByRole("status", { name: "Selected airport", exact: true });
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          if ((await selected.textContent()) === code) return { code };
          await page.waitForTimeout(100);
        }
        return { failure: "not_committed" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ code: AirportCode }),
        Schema.Struct({
          failure: Schema.Literal(
            "ownership_unknown",
            "option_missing",
            "option_disabled",
            "not_committed",
          ),
        }),
      ),
    )(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch: result.failure === "not_committed" ? "sent" : "not_sent",
      });
    return result;
  },
);
