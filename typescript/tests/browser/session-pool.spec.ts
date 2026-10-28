import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import { makeKernelCompatibility } from "../../src/runtime/kernel-compatibility.js";
import { sessionPoolCode } from "../../src/browser/index.js";

// Actual Chromium keeps each new context's cookies apart and reports the page's own data calls,
// which is what tells a walled session from a missing item.

/**
 * A site whose item pages render from a data call. Past `wallAfter` data calls, the data call
 * answers 429 and the page never shows the item: counted per cookie session, or, with `byAddress`,
 * across every session.
 */
const wallingSite = async (options: { readonly wallAfter: number; readonly byAddress?: boolean }) => {
  const calls = new Map<string, number>();
  let total = 0;
  const sessions = new Set<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://site.test");
    const cookie = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    if (url.pathname.startsWith("/item/")) {
      const sid = cookie ?? randomUUID();
      sessions.add(sid);
      response.writeHead(200, {
        "content-type": "text/html",
        ...(cookie === undefined ? { "set-cookie": `sid=${sid}; Path=/` } : {}),
      });
      const id = url.pathname.slice("/item/".length);
      response.end(`<!doctype html><title>Item</title><main></main><script>
        fetch("/api/item/${id}").then(async (answer) => {
          if (!answer.ok) return;
          const item = await answer.json();
          const ready = document.createElement("h1");
          ready.id = "ready";
          ready.textContent = item.name;
          document.querySelector("main").append(ready);
        });
      </script>`);
      return;
    }
    if (url.pathname.startsWith("/api/item/")) {
      const key = options.byAddress === true ? "address" : (cookie ?? "none");
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      total += 1;
      if (count > options.wallAfter) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: `Item ${url.pathname.slice("/api/item/".length)}` }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    sessions,
    total: () => total,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const readItems = (origin: string, items: readonly string[], options: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makePlaywrightExecutor();
        const kernel = makeKernelCompatibility(executor.sessionId, executor.executeResponse).browsers
          .playwright;
        return yield* Effect.promise(async () => {
          const response = await kernel.execute(executor.sessionId, {
            code: `${sessionPoolCode}
const run = await readWithSessions(${JSON.stringify(items)}, async ({ page, item, expect }) => {
  await page.goto(${JSON.stringify(origin)} + "/item/" + item);
  await expect(page.locator("#ready"));
  return await page.locator("#ready").textContent();
}, ${JSON.stringify(options)});
return { ...run, contextsLeft: browser.contexts().length };`,
            timeout_sec: 10,
          });
          if (!response.success) throw new Error(response.error);
          return response.result as {
            readonly results: readonly { readonly ok: boolean; readonly value?: string; readonly error?: string }[];
            readonly stopped: { readonly reason: string } | null;
            readonly limitScope: string;
            readonly sessions: { readonly opened: number; readonly walls: number };
            readonly contextsLeft: number;
          };
        });
      }),
    ),
  );

const fast = { siteDomain: "localhost", staggerMs: 20, sessionIntervalMs: 0, expectTimeoutMs: 250 };

test("reads a list across cookie sessions, replacing each walled session with a fresh one", async () => {
  const site = await wallingSite({ wallAfter: 2 });
  try {
    const items = ["1", "2", "3", "4", "5", "6"];
    const run = await readItems(site.origin, items, { ...fast, start: 2, max: 2 });

    expect(run.results.map((result) => result.value)).toEqual(items.map((item) => `Item ${item}`));
    expect(run.stopped).toBeNull();
    expect(run.limitScope).toBe("per_session");
    expect(run.sessions.walls).toBeGreaterThan(0);
    expect(site.sessions.size).toBe(run.sessions.opened);
    expect(run.contextsLeft).toBe(1);
  } finally {
    await site.close();
  }
});

test("stops as limited by address when a fresh session walls at once too", async () => {
  const site = await wallingSite({ wallAfter: 3, byAddress: true });
  try {
    const items = ["1", "2", "3", "4", "5", "6"];
    const run = await readItems(site.origin, items, { ...fast, start: 1, max: 1 });

    expect(run.stopped).toMatchObject({ reason: "ip_limited" });
    expect(run.limitScope).toBe("per_ip");
    expect(run.results.slice(0, 3).map((result) => result.value)).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(run.results.slice(4).every((result) => result.error === "not_read")).toBe(true);
    expect(site.total()).toBe(5);
    expect(run.contextsLeft).toBe(1);
  } finally {
    await site.close();
  }
});
