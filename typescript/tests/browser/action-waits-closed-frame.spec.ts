import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The outcome race, run as a Kernel call body runs it (`page` in scope), on a page that removes a
// cross-site frame while the wait reads it. The frame must run in its own process, as a
// cross-site frame does in a browser with site isolation: Playwright then reports a read of the
// frame after it went as a closed target, not as a detached frame. A trace reads every frame
// around each call, which would hold up the click until the frame went, so this file runs
// without one.
test.use({ launchOptions: { args: ["--site-per-process"] }, trace: "off" });

const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${waitCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://apply.example.test";
const checkOrigin = "https://verification.test";

/**
 * An application form with a cross-site verification frame. 300 ms after Submit is clicked, the
 * page removes the frame and shows its heading. With `busy`, the page's script runs through those
 * 300 ms, so a look that listed the frames as it started reads the main page once it ends, and
 * then the frame, which is gone by then.
 */
const applicationSite = async (page: Page, { busy }: { busy: boolean }) => {
  await page.context().route(`${checkOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Verifying you are human</p>" }),
  );
  await page.context().route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <button type="button" id="submit">Submit application</button>
        <iframe id="verification" title="Verification" src="${checkOrigin}/widget"></iframe>
        <script>
          const received = () => {
            document.querySelector("#verification").remove();
            document.body.insertAdjacentHTML("beforeend", "<h1>Application received</h1>");
          };
          document.querySelector("#submit").onclick = ${
            busy
              ? `() => setTimeout(() => {
                  const until = Date.now() + 300;
                  while (Date.now() < until);
                  received();
                })`
              : `() => setTimeout(received, 300)`
          };
        </script>`,
    }),
  );
  await page.goto(`${origin}/`);
  await page.frameLocator("#verification").getByText("Verifying you are human").waitFor();
};

// The received heading or the site's error, after Submit. The error check reads every frame, as
// a status check over a page that embeds a widget does. The wait reads the outcomes highest
// priority last, so each look runs the check first. The action does not wait on the page after
// the click, and returns once the site's script began. `before` runs as Submit is clicked.
const submit = (before = "") => `
  return await waitForOutcome({
    done: page.getByRole("heading", { name: "Application received" }),
    failed: {
      check: async () => {
        for (const frame of page.frames()) {
          const errors = await frame.$$eval("[role=alert]", (nodes) => nodes.map((node) => node.textContent));
          if (errors.length > 0) return errors[0];
        }
        return false;
      },
    },
  }, {
    action: async () => {
      ${before}
      await page.locator("#submit").click({ noWaitAfter: true });
      await waitSleep(50);
    },
    noProgressMs: 2000,
    timeout: 4000,
  });`;

test("a check reading a frame that closes loses that look, and the next look sees the outcome", async ({
  page,
}) => {
  await applicationSite(page, { busy: true });
  expect(await call(page, submit())).toEqual({ result: "done" });
});

test("a main page that closes during the wait still fails it", async ({ page }) => {
  await applicationSite(page, { busy: false });
  // It closes before the heading shows, while the wait reads the page and its frame.
  const answer = await call(page, submit(`setTimeout(() => page.close().catch(() => undefined), 100);`));
  expect(answer.error).toMatch(/Target page, context or browser has been closed/u);
});

test("a check that throws the site's words about something closed fails the wait with them at once", async ({
  page,
}) => {
  await applicationSite(page, { busy: false });
  const begun = Date.now();
  const answer = await call(page, `
    return await waitForOutcome({
      done: page.getByRole("heading", { name: "Application received" }),
      failed: { check: async () => { throw new Error("This job posting has been closed"); } },
    }, { noProgressMs: 2000, timeout: 4000 });`);
  expect(answer.error).toMatch(/This job posting has been closed$/u);
  expect(Date.now() - begun).toBeLessThan(1500);
});

/** A sign-in popup whose Cancel button closes it 100 ms after the click. */
const signInPopup = async (page: Page) => {
  await page.context().route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().endsWith("/sign-in")
        ? `<button type="button" id="cancel">Cancel</button>
           <script>document.querySelector("#cancel").onclick = () => setTimeout(() => window.close(), 100);</script>`
        : `<button type="button" id="sign-in" onclick="window.open('/sign-in', 'sign-in', 'popup')">Sign in</button>`,
    }),
  );
  await page.goto(`${origin}/`);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("#sign-in").click()]);
  await popup.locator("#cancel").waitFor();
};

test("a wait reading a popup that closes fails at once with the closed target", async ({ page }) => {
  await signInPopup(page);
  const begun = Date.now();
  const answer = await call(page, `
    const popup = page.context().pages().find((each) => each !== page);
    return await waitForOutcome({
      done: popup.getByRole("heading", { name: "Signed in" }),
    }, { action: () => popup.locator("#cancel").click(), noProgressMs: 4000, timeout: 6000 });`);
  expect(answer.error).toMatch(/Target page, context or browser has been closed/u);
  expect(Date.now() - begun).toBeLessThan(2000);
});

test("a ready wait on a control in a popup that closed fails at once with the closed target", async ({ page }) => {
  await signInPopup(page);
  const begun = Date.now();
  const answer = await call(page, `
    const popup = page.context().pages().find((each) => each !== page);
    await Promise.all([popup.waitForEvent("close"), popup.locator("#cancel").click()]);
    return await waitForReady(popup.locator("#cancel"), { noProgressMs: 3000, timeout: 4000 });`);
  expect(answer.error).toMatch(/Target page, context or browser has been closed/u);
  expect(Date.now() - begun).toBeLessThan(2000);
});
