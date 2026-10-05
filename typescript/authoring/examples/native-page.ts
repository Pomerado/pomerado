import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";

// One execute call does all the browser work. Kernel runs the code on its own `page`, so outside
// values, such as the host's site origin, are written into the code with JSON.stringify.
export default defineOperation(
  {
    name: "read_invoice_heading",
    input: Schema.Struct({}),
    output: Schema.Struct({
      heading: Schema.NonEmptyString.annotations({ description: "The invoice list's heading" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        // Read the page already open once it is on the site: any https host on the host's site
        // domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const current = new URL(page.url());
        if (!onSite(current)) return null;
        const heading = page.getByRole("heading", { name: "Invoices", exact: true });
        await heading.waitFor({ state: "visible", timeout: 30000 });
        return (await heading.textContent())?.trim() || null;
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    if (typeof answer.result !== "string")
      throw new errors.OperationFailure("The page is not the invoice list", {
        dispatch: "not_sent",
      });
    return { heading: answer.result };
  },
);
