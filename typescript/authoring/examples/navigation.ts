import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";

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

// Reaches the record through the site's own controls: its search, then the result's own link.
// This site's search loads a results page that is busy until it lists each record as a link named
// by its ID, or says none match, and shows an alert when the search fails. Adapt every role, name
// and attribute from your own session's evidence.
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
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const recordId = ${JSON.stringify(input.record_id)};
        // Poll while the page is in a pending state. Polling only observes.
        const settle = async (classify, pending) => {
          const until = Date.now() + 30000;
          let state = await classify();
          while (pending.includes(state) && Date.now() < until) {
            await page.waitForTimeout(100);
            state = await classify();
          }
          return state;
        };
        // The entry page holds no caller input. Type the identifier into the site's own search.
        await page.goto(${JSON.stringify(siteOrigin)}, { waitUntil: "domcontentloaded", timeout: 30000 });
        const search = page.getByRole("search").getByRole("searchbox", { name: "Record ID", exact: true });
        if ((await search.count()) !== 1) return { failure: "search_unavailable" };
        await search.fill(recordId, { timeout: 30000 });
        await search.press("Enter", { timeout: 30000 });
        const results = page.getByRole("region", { name: "Search results", exact: true });
        const links = results.getByRole("link", { name: recordId, exact: true });
        const noMatch = results.getByRole("status").filter({ hasText: /^No matching records$/ });
        // The search has finished only when the site shows its outcome: one matching link, or its
        // own word that nothing matches. A busy, failed or unknown page proves nothing either way.
        const searched = async () => {
          if ((await page.getByRole("alert").count()) > 0) return "results_unavailable";
          if ((await results.count()) !== 1) return "loading";
          if ((await results.getAttribute("aria-busy")) === "true") return "loading";
          const found = await links.count();
          if (found > 1) return "result_ambiguous";
          if (found === 1) return "found";
          return (await noMatch.count()) === 1 ? "no_match" : "loading";
        };
        const outcome = await settle(searched, ["loading"]);
        // Only the site's own empty result says the record does not exist.
        if (outcome === "no_match") return { refused: "The site's search lists no record with this ID" };
        if (outcome !== "found")
          return { failure: outcome === "loading" ? "results_unavailable" : outcome };
        const resultsUrl = page.url();
        // The final page is checked against the link's own href, a URL the site produced.
        const target = new URL(await links.getAttribute("href"), resultsUrl);
        if (!onSite(target)) return { failure: "target_mismatch" };
        const targetPath = target.pathname;
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
        await links.click({ timeout: 30000 });
        await page.waitForURL((url) => url.href !== resultsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        let state = await settle(classify, ["loading"]);
        // Continue only through an interstitial whose own identity matches the request.
        if (state === "interstitial") {
          await proceed.click({ timeout: 30000 });
          state = await settle(classify, ["loading", "interstitial"]);
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
    if ("refused" in result) throw new errors.InvalidInput(result.refused);
    if ("failure" in result) throw new errors.OperationFailure(result.failure);
    return { record_id: input.record_id, title: result.title };
  },
);

// A details tool whose input is the record's page URL, such as a link the caller copied from the
// site, opens it unchanged: never rebuilt, trimmed or reached through the site's search. Only an
// https URL on the tool's site is opened, and the page's own record id is read back.
export const detailFromUrl = defineOperation(
  {
    name: "read_record_detail_from_url",
    input: Schema.Struct({
      record_url: Schema.String.annotations({
        description: "The record's page URL on the site, as the caller copied it",
        examples: ["https://records.example.com/records/record_42"],
      }),
    }),
    output: Schema.Struct({
      record_id: RecordId.annotations({ description: "ID of the record the page shows" }),
      title: Schema.NonEmptyString.annotations({ description: "The record's title" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const requested = URL.parse(input.record_url);
    const onSite = (url: URL) =>
      siteDomain === undefined
        ? url.origin === siteOrigin
        : url.protocol === "https:" &&
          (url.hostname === siteDomain || url.hostname.endsWith(`.${siteDomain}`));
    if (requested === null || requested.protocol !== "https:" || !onSite(requested))
      throw new errors.InvalidInput("record_url must be an https page on this site");
    // The record the link names, as the site's own links name it; the page must show the same one.
    const expected = requested.pathname.split("/").at(-1) ?? "";
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const expected = ${JSON.stringify(expected)};
        // The caller's URL exactly as given.
        await page.goto(${JSON.stringify(input.record_url)}, { waitUntil: "domcontentloaded", timeout: 30000 });
        const detail = page.getByRole("region", { name: "Record details", exact: true });
        const interstitial = page.getByRole("region", { name: "Continue to record", exact: true });
        const proceed = interstitial.getByRole("button", { name: "Continue", exact: true });
        // The site may serve the record under another of its routes; its own record id decides.
        const classify = async () => {
          if (!onSite(new URL(page.url()))) return { state: "target_mismatch" };
          if ((await detail.count()) === 1)
            return { state: "detail", id: await detail.getAttribute("data-record-id") };
          if ((await interstitial.count()) === 1)
            return { state: "interstitial", id: await interstitial.getAttribute("data-record-id") };
          return { state: "loading" };
        };
        const settle = async () => {
          const until = Date.now() + 30000;
          let seen = await classify();
          while (seen.state === "loading" && Date.now() < until) {
            await page.waitForTimeout(100);
            seen = await classify();
          }
          return seen;
        };
        let seen = await settle();
        if (seen.state === "interstitial" && seen.id === expected && (await proceed.count()) === 1) {
          await proceed.click({ timeout: 30000 });
          seen = await settle();
        }
        if (seen.state === "target_mismatch") return { failure: "target_mismatch" };
        if (seen.state !== "detail" && seen.state !== "interstitial") return { failure: "detail_unavailable" };
        if (seen.id !== expected) return { failure: "identity_mismatch" };
        if (seen.state !== "detail") return { failure: "interstitial_unowned" };
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
    return { record_id: expected, title: result.title };
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
