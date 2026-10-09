import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Schema } from "effect";
import { defineOperation } from "../../src/runtime/operation.js";
import {
  humanClickPaths,
  pointerTiming,
  withHumanClicks,
  type HumanClickOptions,
} from "../../src/browser/human-pointer.js";
import { failure, runExample } from "./authoring-fixture.js";

// A hosted script's clicks through the runtime, with the human-click page code on each call and a
// fake of the browser machine's input service. The fake turns each screen point into a Chromium
// mouse event at that point less the viewport's place on its screen, as an operating system's
// pointer does, so Chromium must generate the page's trusted events. Its sleeps are recorded, not
// slept.

/** Where the fake's screen puts the viewport: 87 px down, while the page's metrics say 0. */
const viewport = { x: 0, y: 87 };

type Action = {
  readonly type: string;
  readonly move_mouse?: { readonly x: number; readonly y: number };
  readonly click_mouse?: { readonly x: number; readonly y: number; readonly click_type: string };
  readonly sleep?: { readonly duration_ms: number };
};

interface FakeInput {
  readonly endpoint: string;
  readonly batches: Action[][];
  readonly files: Map<string, string>;
  readonly close: () => Promise<void>;
}

const body = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
};

const Batch = Schema.Struct({ actions: Schema.Array(Schema.Unknown) });
const FilePath = Schema.Struct({ path: Schema.String });

/**
 * The fake input service. `reach` false is a browser whose pointer moves never reach the page, as
 * a headless one's; `failPress` answers a batch that presses with a failure, after recording it.
 */
const fakeInput = async (
  page: Page,
  options: { readonly reach?: boolean; readonly failPress?: boolean } = {},
): Promise<FakeInput> => {
  const batches: Action[][] = [];
  const files = new Map<string, string>();
  const cdp = await page.context().newCDPSession(page);
  let pointer = { x: 520, y: 420 };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      const text = await body(request);
      if (url.pathname === "/computer/get_mouse_position") {
        response.end(JSON.stringify(pointer));
        return;
      }
      if (url.pathname === "/computer/batch") {
        const actions = Schema.decodeUnknownSync(Batch)(JSON.parse(text)).actions as Action[];
        batches.push(actions);
        if (options.failPress === true && actions.some((action) => action.click_mouse)) {
          response.statusCode = 500;
          response.end("{}");
          return;
        }
        // One DevTools session keeps the events in order; only the last is awaited.
        const sent: Promise<unknown>[] = [];
        for (const action of actions) {
          const at = action.move_mouse ?? action.click_mouse;
          if (at === undefined) continue;
          pointer = { x: at.x, y: at.y };
          if (options.reach === false) continue;
          const point = { x: at.x - viewport.x, y: at.y - viewport.y };
          const kind = action.click_mouse?.click_type;
          sent.push(
            cdp.send("Input.dispatchMouseEvent", {
              ...point,
              ...(kind === "down"
                ? { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 }
                : kind === "up"
                  ? { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 }
                  : { type: "mouseMoved", button: "none", buttons: 0 }),
            }),
          );
        }
        await Promise.all(sent);
        response.end();
        return;
      }
      if (url.pathname === "/fs/file_info") {
        const path = url.searchParams.get("path") ?? "";
        if (!files.has(path)) {
          response.statusCode = 404;
          response.end('{"message":"file not found"}');
          return;
        }
        response.end(JSON.stringify({ path, mod_time: new Date().toISOString() }));
        return;
      }
      if (url.pathname === "/fs/write_file") {
        files.set(url.searchParams.get("path") ?? "", text);
        response.statusCode = 201;
        response.end();
        return;
      }
      if (url.pathname === "/fs/delete_file") {
        files.delete(Schema.decodeUnknownSync(FilePath)(JSON.parse(text)).path);
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    batches,
    files,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cdp.detach();
    },
  };
};

/** A sign-in button 120 by 40 px at (300, 200), and every mouse event the page sees. */
const buttonPage = (page: Page, extra = "") =>
  page.setContent(`
    <style>body { margin: 0 } #go { position: absolute; left: 300px; top: 200px; width: 120px; height: 40px; border: 0; padding: 0; }</style>
    <button id="go">Continue</button>${extra}
    <script>
      window.seen = [];
      for (const type of ["mousemove", "mousedown", "mouseup", "click"])
        document.addEventListener(type, (event) => seen.push({
          type, trusted: event.isTrusted, x: event.clientX, y: event.clientY,
          on: event.target.id || event.target.tagName, at: performance.now(),
        }), true);
    </script>`);

interface Seen {
  readonly type: string;
  readonly trusted: boolean;
  readonly x: number;
  readonly y: number;
  readonly on: string;
}
const seen = (page: Page) => page.evaluate(() => Reflect.get(window, "seen") as Seen[]);
const clicks = async (page: Page) => (await seen(page)).filter(({ type }) => type === "click");

/** A script that clicks the button through each body, one Kernel call each. */
const clicking = (...calls: readonly string[]) =>
  defineOperation(
    { name: "press_continue", input: Schema.Struct({}), output: Schema.Struct({}) },
    async ({ kernel, sessionId }) => {
      for (const code of calls) {
        const answer = await kernel.browsers.playwright.execute(sessionId, {
          code: `${code}\nreturn {};`,
          timeout_sec: 10,
        });
        if (answer.success !== true) throw new Error(String(answer.error));
      }
      return {};
    },
  );

const plainClick = 'await page.getByRole("button", { name: "Continue" }).click({ timeout: 2000 });';

const run = (page: Page, calls: readonly string[], options: HumanClickOptions) =>
  runExample(page, clicking(...calls), {}, { wrap: (kernel) => withHumanClicks(kernel, options) });

const pressed = (input: FakeInput) =>
  input.batches.flat().filter((action) => action.click_mouse !== undefined);

// The page code wraps Playwright's frame click once per process, as in Kernel's executor; each
// test starts from Playwright's own click.
test.afterEach(({ page }) => {
  const state: unknown = Reflect.get(globalThis, "__pomeradoHumanClick");
  const original: unknown = state === undefined ? undefined : Reflect.get(Object(state), "original");
  if (typeof original === "function")
    Reflect.set(Object.getPrototypeOf(page.mainFrame()), "click", original);
  Reflect.deleteProperty(globalThis, "__pomeradoHumanClick");
});

test("a plain click is the real pointer's: a trail, a pause, a held press, off the centre, though the metrics are 87 px off", async ({
  page,
}) => {
  await buttonPage(page);
  const input = await fakeInput(page);
  try {
    const { result } = await run(page, [plainClick, plainClick], { endpoint: input.endpoint, seed: 7 });
    expect(result._tag).toBe("Right");
    const events = await seen(page);
    const pageClicks = events.filter(({ type }) => type === "click");
    expect(pageClicks).toHaveLength(2);
    for (const click of pageClicks) {
      expect(click).toMatchObject({ trusted: true, on: "go" });
      // Within the middle half, never the exact centre (360, 220).
      expect(Math.abs(click.x - 360)).toBeLessThanOrEqual(30);
      expect(Math.abs(click.y - 220)).toBeLessThanOrEqual(10);
      expect(click.x === 360 && click.y === 220).toBe(false);
    }
    const firstDown = events.findIndex(({ type }) => type === "mousedown");
    expect(events.slice(0, firstDown).filter(({ type }) => type === "mousemove").length).toBeGreaterThan(5);
    // Each press is down, a held sleep, then up, after a pause on the target.
    const presses = input.batches.filter((actions) => actions.some((action) => action.click_mouse));
    expect(presses).toHaveLength(2);
    for (const actions of presses) {
      expect(actions.map(({ type }) => type)).toEqual(["sleep", "click_mouse", "sleep", "click_mouse"]);
      expect(actions[0]?.sleep?.duration_ms).toBeLessThanOrEqual(pointerTiming.pauseMs[1]);
      expect(actions[2]?.sleep?.duration_ms).toBeGreaterThanOrEqual(pointerTiming.pressMs[0]);
      expect(actions[2]?.sleep?.duration_ms).toBeLessThanOrEqual(pointerTiming.pressMs[1]);
    }
    // The first click measured the viewport from where its move landed; the second needed no
    // correcting move, so it moved once.
    const moveBatches = input.batches.filter((actions) => !actions.some((action) => action.click_mouse));
    expect(moveBatches).toHaveLength(3);
    expect(JSON.parse(input.files.get(humanClickPaths.stats) ?? "{}")).toEqual({ real: 2, fallback: {} });
    expect(input.files.has(humanClickPaths.click)).toBe(false);
  } finally {
    await input.close();
  }
});

test("a browser whose pointer moves never reach the page clicks as Playwright does, and counts it", async ({
  page,
}) => {
  await buttonPage(page);
  const input = await fakeInput(page, { reach: false });
  try {
    const { result } = await run(page, [plainClick], { endpoint: input.endpoint, seed: 7, eventWaitMs: 150 });
    expect(result._tag).toBe("Right");
    expect(await clicks(page)).toEqual([expect.objectContaining({ x: 360, y: 220, on: "go" })]);
    expect(pressed(input)).toEqual([]);
    expect(JSON.parse(input.files.get(humanClickPaths.stats) ?? "{}")).toEqual({
      real: 0,
      fallback: { no_events: 1 },
    });
  } finally {
    await input.close();
  }
});

test("without the input service, as on the local host, a click is Playwright's", async ({ page }) => {
  await buttonPage(page);
  const { result } = await run(page, [plainClick], { seed: 7 });
  expect(result._tag).toBe("Right");
  expect(await clicks(page)).toEqual([expect.objectContaining({ x: 360, y: 220, on: "go" })]);
});

test("a click with its own position stays Playwright's and moves no real pointer", async ({ page }) => {
  await buttonPage(page);
  const input = await fakeInput(page);
  try {
    const { result } = await run(
      page,
      ['await page.locator("#go").click({ position: { x: 5, y: 5 }, timeout: 2000 });'],
      { endpoint: input.endpoint, seed: 7 },
    );
    expect(result._tag).toBe("Right");
    expect(await clicks(page)).toEqual([expect.objectContaining({ x: 305, y: 205, on: "go" })]);
    expect(input.batches).toEqual([]);
  } finally {
    await input.close();
  }
});

test("a button covered everywhere but its centre is clicked at its centre by Playwright, never pressed elsewhere", async ({
  page,
}) => {
  // Four covers leave only a 6 by 6 px hole at the centre, where Playwright's own check looks.
  const cover = (style: string) =>
    `<div class="cover" style="position:absolute;${style};background:rgba(0,0,0,.1)"></div>`;
  await buttonPage(
    page,
    [
      cover("left:300px;top:200px;width:57px;height:40px"),
      cover("left:363px;top:200px;width:57px;height:40px"),
      cover("left:357px;top:200px;width:6px;height:17px"),
      cover("left:357px;top:223px;width:6px;height:17px"),
    ].join(""),
  );
  const input = await fakeInput(page);
  try {
    const { result } = await run(page, [plainClick], { endpoint: input.endpoint, seed: 7 });
    expect(result._tag).toBe("Right");
    expect(await clicks(page)).toEqual([expect.objectContaining({ x: 360, y: 220, on: "go" })]);
    expect(input.batches).toEqual([]);
    expect(JSON.parse(input.files.get(humanClickPaths.stats) ?? "{}")).toEqual({
      real: 0,
      fallback: { covered: 1 },
    });
  } finally {
    await input.close();
  }
});

test("while the host holds the pointer, a click stays Playwright's", async ({ page }) => {
  await buttonPage(page);
  const input = await fakeInput(page);
  input.files.set(humanClickPaths.hold, "hold");
  try {
    const { result } = await run(page, [plainClick], { endpoint: input.endpoint, seed: 7 });
    expect(result._tag).toBe("Right");
    expect(await clicks(page)).toEqual([expect.objectContaining({ x: 360, y: 220 })]);
    expect(input.batches).toEqual([]);
  } finally {
    await input.close();
  }
});

test("a press that fails may have clicked, so the script fails and nothing clicks again", async ({
  page,
}) => {
  await buttonPage(page);
  const input = await fakeInput(page, { failPress: true });
  try {
    const { result } = await run(page, [plainClick], { endpoint: input.endpoint, seed: 7 });
    expect(result._tag).toBe("Left");
    expect(String(Reflect.get(Object(failure(result)), "message"))).toContain(
      "real click may have happened",
    );
    expect(await clicks(page)).toEqual([]);
    // The press, then a release in case the button went down.
    expect(pressed(input).map((action) => action.click_mouse?.click_type)).toEqual(["down", "up", "up"]);
    expect(input.files.has(humanClickPaths.click)).toBe(false);
  } finally {
    await input.close();
  }
});
