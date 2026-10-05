import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";

const RecordId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/));
const Detail = Schema.Union(
  Schema.Struct({ title: Schema.NonEmptyString }),
  Schema.Struct({
    failure: Schema.Literal(
      "detail_unavailable",
      "identity_mismatch",
      "interstitial_unowned",
      "target_mismatch",
    ),
  }),
);

// The path, roles and identity attributes represent one observed site contract.
// They are not heuristics to apply to unrelated detail pages.
export const detailNavigation = defineOperation(
  {
    name: "read_record_detail",
    input: Schema.Struct({
      record_id: RecordId.annotations({
        description: "ID of the record to read, as in its URL",
        examples: ["record_42"],
      }),
    }),
    output: Schema.Struct({
      record_id: RecordId.annotations({ description: "ID of the record read" }),
      title: Schema.NonEmptyString.annotations({ description: "The record's title" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const target = new URL(`/records/${input.record_id}`, siteOrigin);
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 90,
      code: `
        const target = ${JSON.stringify(target.href)};
        const targetPath = ${JSON.stringify(target.pathname)};
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const recordId = ${JSON.stringify(input.record_id)};
        const detail = page.getByRole("region", { name: "Record details", exact: true });
        const interstitial = page.getByRole("region", { name: "Continue to record", exact: true });
        const proceed = interstitial.getByRole("button", { name: "Continue", exact: true });
        // Classify the page. The site, path and the page's own record id must all match the request.
        const classify = async () => {
          const current = new URL(page.url());
          if (!onSite(current)) return "target_mismatch";
          if (current.pathname !== targetPath) return "target_mismatch";
          const details = await detail.count();
          const interstitials = await interstitial.count();
          if (details + interstitials > 1) return "detail_unavailable";
          if (details === 1)
            return (await detail.getAttribute("data-record-id")) === recordId
              ? "detail"
              : "identity_mismatch";
          if (interstitials === 1) {
            if ((await interstitial.getAttribute("data-record-id")) !== recordId)
              return "identity_mismatch";
            return (await proceed.count()) === 1 ? "interstitial" : "interstitial_unowned";
          }
          return "loading";
        };
        // Poll while the page is in a pending state. Polling only observes.
        const settle = async (pending) => {
          const until = Date.now() + 30000;
          let state = await classify();
          while (pending.includes(state) && Date.now() < until) {
            await page.waitForTimeout(100);
            state = await classify();
          }
          return state;
        };
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
        let state = await settle(["loading"]);
        // Continue only through an interstitial whose own identity matches the request.
        if (state === "interstitial") {
          await proceed.click({ timeout: 30000 });
          state = await settle(["loading", "interstitial"]);
        }
        if (state !== "detail")
          return { failure: state === "loading" || state === "interstitial" ? "detail_unavailable" : state };
        const heading = detail.getByRole("heading", { level: 1 });
        if ((await heading.count()) !== 1) return { failure: "detail_unavailable" };
        const title = (await heading.innerText()).trim();
        return title ? { title } : { failure: "detail_unavailable" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Detail)(answer.result);
    if ("failure" in result) throw new errors.OperationFailure(result.failure);
    return { record_id: input.record_id, title: result.title };
  },
);

// A bounded first-page read. A fast exploration load does not remove the readiness wait.
export default defineOperation(
  {
    name: "read_catalog_heading",
    input: Schema.Struct({}),
    output: Schema.Struct({
      heading: Schema.NonEmptyString.annotations({ description: "The catalog page's heading" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, errors, waitPastChallenge }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const site = new URL(siteOrigin);
    const readHeading = `
      // On the site: any https host on the host's site domain, else the site origin alone.
      const siteDomain = ${JSON.stringify(siteDomain ?? null)};
      const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
        : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
      const current = new URL(page.url());
      if (!onSite(current)) return { failure: "unsupported_page" };
      if (current.pathname !== "/catalog") return { failure: "unsupported_page" };
      const text = (await page.getByRole("heading", { name: "Catalog", exact: true }).innerText()).trim();
      return text === "Catalog" ? { heading: text } : { failure: "unsupported_page" };
    `;
    const first = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        await page.goto(${JSON.stringify(`${site.origin}/catalog`)}, { waitUntil: "domcontentloaded", timeout: 30000 });
        const heading = page.getByRole("heading", { name: "Catalog", exact: true });
        // This site's observed verification page says "Verifying your browser".
        const challenge = page.getByText("Verifying your browser", { exact: true });
        await heading.or(challenge).waitFor({ timeout: 30000 });
        if (await challenge.isVisible()) return { challenge: true };
        ${readHeading}
      `,
    });
    if (!first.success)
      throw new errors.OperationFailure(String(first.error), { stderr: first.stderr });
    let answer: unknown = first.result;
    if (typeof answer === "object" && answer !== null && "challenge" in answer) {
      // Give Kernel's solver its window. This throws ChallengeFailure when the page stays
      // blocked; the host then moves to a new browser mode on an empty profile. Never
      // click or reload it.
      await waitPastChallenge({
        ready: `return await page.getByRole("heading", { name: "Catalog", exact: true }).isVisible();`,
      });
      const next = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 30,
        code: readHeading,
      });
      if (!next.success)
        throw new errors.OperationFailure(String(next.error), { stderr: next.stderr });
      answer = next.result;
    }
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ heading: Schema.NonEmptyString }),
        Schema.Struct({ failure: Schema.Literal("unsupported_page") }),
      ),
    )(answer);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, { dispatch: "not_sent" });
    return result;
  },
);
