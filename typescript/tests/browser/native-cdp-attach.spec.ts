import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import type {
  PlaywrightExecutor,
  PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";
import { makeKernelCompatibility } from "../../src/runtime/kernel-compatibility.js";
import invoiceHeading from "../../authoring/examples/native-page.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { makeRunFiles, type FileHostHook } from "../../src/runtime/file-transfer.js";
import { startFileSite } from "./file-fixture.js";

const native = <A>(
  run: (executor: PlaywrightExecutor) => Promise<A>,
  options: PlaywrightOptions,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makePlaywrightExecutor(options);
        return yield* Effect.tryPromise({
          try: () => run(executor),
          catch: (error) =>
            error instanceof Error ? error : new Error("Native fixture failed", { cause: error }),
        });
      }),
    ),
  );

/**
 * A Chromium reachable only through its DevTools websocket, as a cloud browser is. The test keeps
 * its own (pipe) connection to the same browser to set up pages and look at them afterwards.
 */
const devtoolsBrowser = async (args: readonly string[] = []) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-cdp-"));
  const context = await chromium.launchPersistentContext(join(directory, "profile"), {
    headless: true,
    args: ["--remote-debugging-port=0", ...args],
  });
  const [port, path] = (
    await readFile(join(directory, "profile", "DevToolsActivePort"), "utf8")
  ).split("\n");
  if (!port || !path) throw new Error("Missing DevTools endpoint");
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    url: `ws://127.0.0.1:${port}${path}`,
    context,
    page,
    close: async () => {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const targetIdOf = async (context: BrowserContext, page: Page) => {
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  return targetInfo.targetId;
};

const title = (executor: PlaywrightExecutor) =>
  Effect.runPromise(executor.execute("return await page.title();", 2));

test("CDP attach drives the browser's existing page instead of opening its own", async () => {
  const browser = await devtoolsBrowser();
  try {
    await browser.page.setContent("<title>Existing page</title>");
    const targetId = await targetIdOf(browser.context, browser.page);
    const seen = await native(
      async (executor) => ({ targetId: executor.targetId, title: await title(executor) }),
      { cdp: { url: browser.url } },
    );
    expect(seen).toEqual({ targetId, title: "Existing page" });
    expect(browser.context.pages()).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test("CDP attach drives the page its target id names", async () => {
  const browser = await devtoolsBrowser();
  try {
    await browser.page.setContent("<title>First page</title>");
    const second = await browser.context.newPage();
    await second.setContent("<title>Second page</title>");
    const targetId = await targetIdOf(browser.context, second);
    expect(await native(title, { cdp: { url: browser.url, targetId } })).toBe("Second page");
  } finally {
    await browser.close();
  }
});

test("CDP attach refuses a target id the browser doesn't have", async () => {
  const browser = await devtoolsBrowser();
  try {
    await expect(
      native(title, { cdp: { url: browser.url, targetId: "0123456789ABCDEF" } }),
    ).rejects.toThrow("CDP target not found");
  } finally {
    await browser.close();
  }
});

test("CDP attach refuses a page another client's context holds", async () => {
  const browser = await devtoolsBrowser();
  const other = await chromium.connectOverCDP(browser.url);
  try {
    const isolated = await other.newContext();
    const page = await isolated.newPage();
    const targetId = await targetIdOf(isolated, page);
    await expect(native(title, { cdp: { url: browser.url, targetId } })).rejects.toThrow(
      "CDP target not found",
    );
  } finally {
    await other.close();
    await browser.close();
  }
});

test("closing a CDP executor leaves the browser's page and drops the contexts its scripts made", async () => {
  const browser = await devtoolsBrowser();
  try {
    await browser.page.setContent("<title>Kept page</title>");
    const made = await native(
      (executor) =>
        Effect.runPromise(
          executor.execute(
            `const made = await browser.newContext();
            const page = await made.newPage();
            const session = await made.newCDPSession(page);
            const { targetInfo } = await session.send('Target.getTargetInfo');
            return targetInfo.browserContextId;`,
            2,
          ),
        ),
      { cdp: { url: browser.url } },
    );
    expect(await browser.page.title()).toBe("Kept page");
    const observer = await chromium.connectOverCDP(browser.url);
    try {
      const session = await observer.newBrowserCDPSession();
      await expect
        .poll(
          async () =>
            (await session.send("Target.getBrowserContexts")).browserContextIds.includes(
              String(made),
            ),
          { timeout: 1_000 },
        )
        .toBe(false);
    } finally {
      await observer.close();
    }
  } finally {
    await browser.close();
  }
});

test("a CDP browser that goes away fails the call it was running and every later one", async () => {
  const browser = await devtoolsBrowser();
  let closed = false;
  try {
    await native(
      async (executor) => {
        const pending = Effect.runPromise(
          executor.execute("await new Promise(resolve => setTimeout(resolve, 10000));", 5),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await browser.close();
        closed = true;
        expect(String(await pending)).toContain("disconnected; completion uncertain");
        await expect(title(executor)).rejects.toThrow("invalidated");
      },
      { cdp: { url: browser.url } },
    );
  } finally {
    if (!closed) await browser.close();
  }
});

test("a CDP executor can't also take a Playwright endpoint", async () => {
  await expect(
    native(title, { endpoint: "ws://127.0.0.1:9/never", cdp: { url: "ws://127.0.0.1:9/never" } }),
  ).rejects.toThrow("endpoint and cdp cannot both be set");
});

test("unchanged authored operations run on a CDP-attached page", async () => {
  const browser = await devtoolsBrowser();
  try {
    const site = "https://example.test";
    await browser.page.route(`${site}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" }),
    );
    await browser.page.goto(site);
    const heading = await native(
      async (executor) => {
        const journal = await Effect.runPromise(makeEffectJournal);
        const execution = {
          deadline: Deadline.after(2_000),
          journal,
          events: { emit: () => Effect.void },
          capture: { start: Effect.void, finish: Effect.void },
        };
        return Effect.runPromise(
          Effect.scoped(
            executeKernelOperation(
              invoiceHeading,
              {},
              {
                kernel: makeKernelCompatibility(executor.sessionId, executor.executeResponse),
                sessionId: executor.sessionId,
                siteOrigin: site,
              },
            ).pipe(Effect.provideService(ExecutionContext, execution)),
          ),
        );
      },
      { cdp: { url: browser.url } },
    );
    expect(heading).toEqual({ heading: "Invoices" });
  } finally {
    await browser.close();
  }
});

test("CDP attach runs on Patchright when asked", async () => {
  const browser = await devtoolsBrowser();
  try {
    await browser.page.setContent("<title>Existing page</title>");
    expect(await native(title, { cdp: { url: browser.url }, library: "patchright" })).toBe(
      "Existing page",
    );
  } finally {
    await browser.close();
  }
});

test("a host whose files live on the browser's own machine sets a file input in a cross-site frame's shadow root by that path, past Playwright's 50 MB transfer cap", async () => {
  const site = await startFileSite();
  const outer = await startFileSite({ frame: `${site.url}shadow-drop` });
  // The outer page is another site, so Chromium renders the site's frame in its own process.
  const browser = await devtoolsBrowser([
    "--site-per-process",
    "--host-resolver-rules=MAP outer.test 127.0.0.1",
  ]);
  const directory = await mkdtemp(join(tmpdir(), "pomerado-browser-files-"));
  // Over Playwright's 50 MB cap for bytes it reads itself and sends to a browser elsewhere.
  const bytes = new Uint8Array(51 * 1024 * 1024);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  const written: string[] = [];
  const hook: FileHostHook = {
    open: () =>
      Effect.succeed({
        name: "scan.pdf",
        media_type: "application/pdf",
        size: bytes.byteLength,
        read: Effect.succeed(bytes),
      }),
    writeToBrowser: (file) =>
      Effect.promise(async () => {
        const path = join(await mkdtemp(join(directory, "placed-")), file.name);
        await writeFile(path, file.bytes);
        written.push(path);
        return path;
      }),
    placeByBrowserPath: true,
    armDownloads: () => Effect.die("No capture here"),
    takeDownload: () => Effect.die("No capture here"),
    keep: () => Effect.die("No capture here"),
  };
  try {
    await browser.page.goto(outer.url.replace("127.0.0.1", "outer.test"));
    await browser.page.frameLocator("iframe").locator("input[type=file]").waitFor({ state: "attached" });
    // The site's frame has its own DevTools target, apart from the page's.
    const siteFrame = browser.page.frames().find((frame) => frame.url().endsWith("/shadow-drop"));
    if (siteFrame === undefined) throw new Error("No site frame");
    await (await browser.context.newCDPSession(siteFrame)).detach();
    const placed = await native(
      (executor) =>
        Effect.runPromise(
          makeRunFiles({
            hook,
            execute: executor.executeResponse,
            siteOrigin: new URL(site.url).origin,
            resolve: (reference) => reference,
            limits: { fileBytes: 64 * 1024 * 1024, runFiles: 1, runBytes: 64 * 1024 * 1024 },
          }).pipe(
            Effect.flatMap((files) =>
              files.place({
                reference: "scan",
                field: { selector: "iframe >> internal:control=enter-frame >> input[type=file]" },
                timeoutSec: 20,
              }),
            ),
          ),
        ),
      { cdp: { url: browser.url } },
    );
    expect(placed).toEqual({ name: "scan.pdf", media_type: "application/pdf", size: bytes.byteLength });
    expect(written).toHaveLength(1);
    // The page's own change handler sent what the browser read at that path.
    await expect
      .poll(() => site.received, { timeout: 20_000 })
      .toEqual([
        {
          name: "scan.pdf",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ]);
    // The marker the placement used to find the input is gone.
    expect(
      await browser.page
        .frameLocator("iframe")
        .locator("input[type=file]")
        .evaluate((node) => node.getAttributeNames()),
    ).toEqual(["type"]);
  } finally {
    await browser.close();
    await outer.close();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});
