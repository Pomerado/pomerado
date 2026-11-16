import { expect, test } from "@playwright/test";
import { browserTimeZoneCode, zonedClock } from "../../src/runtime/time-zone.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// A browser browsing from Newfoundland, whose zone the script's own process never has.
test.use({ timezoneId: "America/St_Johns" });

// A delivery tracker writes its estimate as a bare clock time in the browser's own zone. A tool
// that reads the text and `browserTimeZone()` in one call, and `zonedClock` on both, returns the
// moment the site holds. Chromium must set the zone: only the page runs in it.
test("returns the moment a page's bare clock time stands for, in the browser's zone", async ({ page }) => {
  const arrival = Date.parse("2026-11-16T00:15:00Z");
  await page.setContent(`<p class="eta"></p><script>
    document.querySelector(".eta").textContent = new Date(${arrival}).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  </script>`);
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${browserTimeZoneCode}
return { eta: await page.locator(".eta").textContent(), zone: await browserTimeZone(), frameZone: await browserTimeZone(page.mainFrame()) };`,
  });
  expect(answer.success).toBe(true);
  const read = answer.result as { eta: string; zone: string; frameZone: string };
  // The space before PM may be a no-break one, as sites' own formatting often writes it.
  expect({ ...read, eta: read.eta.replace(/\s/gu, " ") }).toEqual({
    eta: "8:45 PM",
    zone: "America/St_Johns",
    frameZone: "America/St_Johns",
  });
  const eta = zonedClock("nearest", read.eta, read.zone, arrival - 20 * 60_000);
  expect(eta).toBe("2026-11-15T20:45:00-03:30");
  expect(Date.parse(eta)).toBe(arrival);
});
