import { Schema } from "effect";
import { defineOperation, outcomeWaitCode } from "../../src/browser/index.js";

const RecordId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/));
const Detail = Schema.Union(
  Schema.Struct({ title: Schema.NonEmptyString }),
  Schema.Struct({ refused: Schema.NonEmptyString }),
  Schema.Struct({
    failure: Schema.Literal(
      "search_unavailable",
      "results_unavailable",
      "result_ambiguous",
      "detail_unavailable",
      "identity_mismatch",
      "interstitial_unowned",
      "target_mismatch",
    ),
  }),
);

// Reaches the record the way a person does: the site's own search, then the result's own link,
// never a page URL built from the identifier. This site's search loads a results page that is
// busy until it lists each record as a link named by its ID, or says none match, and shows an
// alert when the search fails. Adapt every role, name and attribute from your own session's
// evidence.
export const detailNavigation = defineOperation(
  {
    name: "read_record_detail",
    input: Schema.Struct({
      record_id: RecordId.annotations({
        description: "ID of the record to read, as the site shows it",
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
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        ${outcomeWaitCode}
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const recordId = ${JSON.stringify(input.record_id)};
        // The outcome a wait settles on, or the one that stayed ambiguous; undefined after a timeout.
        const settle = async (outcomes, options) => {
          try {
            return { shown: await waitForOutcome(outcomes, options) };
          } catch (error) {
            if (error.name !== "OutcomeWaitFailure") throw error;
            return { ambiguous: error.outcome };
          }
        };
        // The entry page holds no caller input. Type the identifier into the site's own search.
        await page.goto(${JSON.stringify(siteOrigin)}, { waitUntil: "domcontentloaded", timeout: 30000 });
        const search = page.getByRole("search").getByRole("searchbox", { name: "Record ID", exact: true });
        if ((await search.count()) !== 1) return { failure: "search_unavailable" };
        await search.fill(recordId, { timeout: 30000 });
        // The search has finished only when the site shows its answer to this search, once its
        // results stop being busy: its error, its own word that nothing matches, or one matching
        // link. Pressing Enter is the wait's action, so nothing shown before it is the answer.
        const results = page
          .getByRole("region", { name: "Search results", exact: true })
          .and(page.locator(':not([aria-busy="true"])'));
        const links = results.getByRole("link", { name: recordId, exact: true });
        const searched = await settle({
          failed: page.getByRole("alert"),
          none: results.getByRole("status").filter({ hasText: /^No matching records$/ }),
          found: links,
        }, { action: () => search.press("Enter", { timeout: 30000 }) });
        // Only the site's own empty result says the record does not exist.
        if (searched.shown === "none") return { refused: "The site's search lists no record with this ID" };
        if (searched.shown !== "found")
          return { failure: searched.ambiguous === "found" ? "result_ambiguous" : "results_unavailable" };
        const resultsUrl = page.url();
        // The final page is checked against the link's own href, a URL the site produced.
        const target = new URL(await links.getAttribute("href"), resultsUrl);
        if (!onSite(target)) return { failure: "target_mismatch" };
        const targetPath = target.pathname;
        const detail = page.getByRole("region", { name: "Record details", exact: true });
        const interstitial = page.getByRole("region", { name: "Continue to record", exact: true });
        const proceed = interstitial.getByRole("button", { name: "Continue", exact: true });
        // Wait for the record's page, then check that the site, path and the page's own record
        // id all match the request.
        const offTarget = () => {
          const current = new URL(page.url());
          return !onSite(current) || current.pathname !== targetPath;
        };
        const reached = async (outcomes) => {
          // A page already off the target fails at once; one that moves there while loading fails after.
          if (offTarget()) return "target_mismatch";
          const { shown } = await settle(outcomes);
          if (offTarget()) return "target_mismatch";
          if (shown === undefined) return "detail_unavailable";
          const shownId = await (shown === "detail" ? detail : interstitial).getAttribute("data-record-id");
          if (shownId !== recordId) return "identity_mismatch";
          if (shown === "interstitial" && (await proceed.count()) !== 1) return "interstitial_unowned";
          return shown;
        };
        await links.click({ timeout: 30000 });
        await page.waitForURL((url) => url.href !== resultsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        let state = await reached({ detail, interstitial });
        // Continue only through an interstitial whose own identity matches the request.
        if (state === "interstitial") {
          await proceed.click({ timeout: 30000 });
          state = await reached({ detail });
        }
        if (state !== "detail") return { failure: state };
        const heading = detail.getByRole("heading", { level: 1 });
        if ((await heading.count()) !== 1) return { failure: "detail_unavailable" };
        const title = (await heading.innerText()).trim();
        return title ? { title } : { failure: "detail_unavailable" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Detail)(answer.result);
    if ("refused" in result) throw new errors.InvalidInput(result.refused);
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
        ${outcomeWaitCode}
        await page.goto(${JSON.stringify(`${site.origin}/catalog`)}, { waitUntil: "domcontentloaded", timeout: 30000 });
        // This site's observed verification page says "Verifying your browser". It wins over the
        // heading when both show.
        const shown = await waitForOutcome({
          challenge: page.getByText("Verifying your browser", { exact: true }),
          heading: page.getByRole("heading", { name: "Catalog", exact: true }),
        });
        if (shown === "challenge") return { challenge: true };
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
