import { once } from "node:events";
import { createServer } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { Effect } from "effect";
import type { HostExecute } from "../../src/runtime/host-execute.js";
import {
  localStartHooks,
  saveSessionCode,
  startPage,
  stopLoadingCode,
  type PageStart,
} from "../../src/runtime/start-state.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The page reset a live example, live test or write session's first step starts from, on local
// Chromium against a local site that counts each path it serves.

const startSite = async () => {
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://site.test").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.setHeader("Content-Type", "text/html");
    response.end(`<h1>${path}</h1>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No site address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits: (path: string) => hits.get(path) ?? 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
type Site = Awaited<ReturnType<typeof startSite>>;

/** The host's browser calls on `page`, as the native executor runs them. */
const host = async (page: Page) => {
  const kernel = makeLocalKernel(page);
  const calls: string[] = [];
  const execute: HostExecute = (code, timeoutSec) =>
    Effect.sync(() => calls.push(code)).pipe(
      Effect.zipRight(
        Effect.promise(() =>
      kernel.browsers.playwright.execute("local", {
        code,
        ...(timeoutSec === undefined ? {} : { timeout_sec: timeoutSec }),
          }),
        ),
      ),
      Effect.flatMap((response) =>
        response.success
          ? Effect.succeed(response.result)
          : Effect.fail(new Error(response.error ?? "Browser call failed")),
      ),
    );
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.detach();
  return { execute, targetId: targetInfo.targetId, calls };
};

interface Reset {
  readonly reset: (start: PageStart) => Promise<void>;
  readonly save: () => Promise<unknown>;
  /** Whether a call stopped the primary tab's loading after a failed root load. */
  readonly stopped: () => boolean;
}
const withSite = async (page: Page, run: (site: Site, browser: Reset) => Promise<void>) => {
  const site = await startSite();
  const { execute, targetId, calls } = await host(page);
  try {
    await run(site, {
      reset: (start) =>
        Effect.runPromise(
          startPage(execute, targetId, site.origin, start, localStartHooks(execute, targetId)),
        ),
      save: () => Effect.runPromise(execute(saveSessionCode, 60)),
      stopped: () => calls.includes(stopLoadingCode(targetId)),
    });
  } finally {
    await site.close();
  }
};

test("resets to the site root with no exploration cookies, storage or tabs", async ({ page }) => {
  await withSite(page, async (site, { reset }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => {
      document.cookie = "recent=SFO-NYC; max-age=3600";
      localStorage.setItem("recent", "SFO-NYC");
      sessionStorage.setItem("recent", "SFO-NYC");
    });
    await page.context().newPage();
    await reset({ siteData: "clear", origins: [] });
    expect(page.context().pages().map((open) => open.url())).toEqual([`${site.origin}/`]);
    expect(await page.context().cookies()).toEqual([]);
    await page.goto(`${site.origin}/claims`);
    expect(await page.evaluate(() => localStorage.getItem("recent"))).toBeNull();
    // Session storage belongs to the tab, so clearing the origin's data alone would keep it.
    expect(await page.evaluate(() => sessionStorage.getItem("recent"))).toBeNull();
  });
});

test("keeps a restored session and lets the step go deeper when the root fails to load", async ({
  page,
}) => {
  await withSite(page, async (site, { reset, save, stopped }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => localStorage.setItem("login", "member"));
    const session = await save();
    await page.evaluate(() => localStorage.setItem("login", "changed"));
    await page.context().route(`${site.origin}/`, (route) => route.abort("failed"));
    await reset({ siteData: "restore", session, origins: [] });
    await page.goto(`${site.origin}/claims`, { waitUntil: "domcontentloaded" });
    expect(page.url()).toBe(`${site.origin}/claims`);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("login"))).toBe("member");
    expect(site.hits("/")).toBe(0);
    expect(stopped()).toBe(true);
  });
});

test("keeps the session while returning to the site root", async ({ page }) => {
  await withSite(page, async (site, { reset, stopped }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => {
      document.cookie = "login=member; max-age=3600";
      localStorage.setItem("login", "member");
      sessionStorage.setItem("login", "member");
    });
    await reset({ siteData: "keep", origins: [] });
    expect(page.url()).toBe(`${site.origin}/`);
    expect(stopped()).toBe(false);
    expect(site.hits("/")).toBe(1);
    expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual(["login"]);
    expect(
      await page.evaluate(() => ({
        local: localStorage.getItem("login"),
        session: sessionStorage.getItem("login"),
      })),
    ).toEqual({ local: "member", session: "member" });
  });
});

test("clears the site's tab storage when exploration left the site before the reset", async ({
  page,
}) => {
  await withSite(page, async (site, { reset }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => sessionStorage.setItem("recent", "SFO-NYC"));
    await page.goto("about:blank");
    await reset({ siteData: "clear", origins: [] });
    // Cleanup stays local, then the root is loaded once.
    expect(site.hits("/")).toBe(1);
    await page.goto(`${site.origin}/claims`);
    expect(await page.evaluate(() => sessionStorage.getItem("recent"))).toBeNull();
  });
});

test("clears storage exploration left on another origin before a signed-out step", async ({
  page,
}) => {
  const other = "https://second.example.test";
  await withSite(page, async (_site, { reset }) => {
    await page.route(`${other}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html></html>" }),
    );
    await page.goto(`${other}/`);
    await page.evaluate(() => localStorage.setItem("recent", "SFO-NYC"));
    await reset({ siteData: "clear", origins: [other] });
    await page.goto(`${other}/`);
    expect(await page.evaluate(() => localStorage.getItem("recent"))).toBeNull();
  });
});

test("restores the session saved after sign-in and drops what exploration added", async ({
  page,
}) => {
  await withSite(page, async (site, { reset, save }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => {
      document.cookie = "login=member-1; max-age=3600";
      localStorage.setItem("token", "member-1");
    });
    const session = await save();
    await page.evaluate(() => {
      document.cookie = "recent=SFO-NYC; max-age=3600";
      localStorage.setItem("token", "changed");
      localStorage.setItem("recent", "SFO-NYC");
      sessionStorage.setItem("recent", "SFO-NYC");
    });
    await reset({ siteData: "restore", session, origins: [] });
    expect(
      (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`),
    ).toEqual(["login=member-1"]);
    await page.goto(`${site.origin}/claims`);
    expect(
      await page.evaluate(() => ({
        token: localStorage.getItem("token"),
        recent: localStorage.getItem("recent"),
        session: sessionStorage.getItem("recent"),
      })),
    ).toEqual({ token: "member-1", recent: null, session: null });
  });
});
