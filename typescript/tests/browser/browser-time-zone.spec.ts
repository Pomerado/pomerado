import { chromium, expect, test } from "@playwright/test";
import { Effect } from "effect";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import { zonedClock } from "../../src/runtime/time-zone.js";

// A delivery tracker writes its estimate as a bare clock time in the browser's own zone. A tool
// that reads the text, takes the zone the host read from the browser as its context's
// `browserTimeZone`, and runs `zonedClock` on both returns the moment the site holds.
// `browserTimeZone()` from `browserTimeZoneCode` still reads the same zone in a call. The browser
// browses from Newfoundland, a zone the script's own process never has.
test("returns the moment a page's bare clock time stands for, in the browser's zone", async () => {
  const arrival = Date.parse("2026-11-16T00:15:00Z");
  const server = await chromium.launchServer({
    headless: true,
    env: { ...process.env, TZ: "America/St_Johns" },
  });
  const page = `<p class="eta"></p><script>document.querySelector(".eta").textContent = new Date(${arrival}).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });</script>`;
  const call = `await page.setContent(${JSON.stringify(page)});
return { eta: await page.locator(".eta").textContent(), pageZone: await browserTimeZone(), frameZone: await browserTimeZone(page.mainFrame()) };`;
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* makePlaywrightExecutor({ endpoint: server.wsEndpoint() });
          return yield* runLocalOperation({
            workspace: yield* createLocalWorkspace(),
            entrypoint: "operation/src/tool.mjs",
            sources: [
              [
                "operation/src/tool.mjs",
                `import { Schema } from "effect";
import { browserTimeZoneCode, defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Unknown }, async ({ kernel, sessionId, browserTimeZone }) => {
  const answer = await kernel.browsers.playwright.execute(sessionId, { timeout_sec: 10, code: browserTimeZoneCode + ${JSON.stringify(call)} });
  return { ...answer.result, zone: browserTimeZone };
});`,
              ],
            ],
            input: {},
            browser,
            ...(browser.timeZone === undefined ? {} : { browserTimeZone: browser.timeZone }),
          });
        }),
      ),
    );
    const read = result.output as { eta: string; zone: string; pageZone: string; frameZone: string };
    // The space before PM may be a no-break one, as sites' own formatting often writes it.
    expect({ ...read, eta: read.eta.replace(/\s/gu, " ") }).toEqual({
      eta: "8:45 PM",
      zone: "America/St_Johns",
      pageZone: "America/St_Johns",
      frameZone: "America/St_Johns",
    });
    const eta = zonedClock("nearest", read.eta, read.zone, arrival - 20 * 60_000);
    expect(eta).toBe("2026-11-15T20:45:00-03:30");
    expect(Date.parse(eta)).toBe(arrival);
  } finally {
    await server.close();
  }
});
