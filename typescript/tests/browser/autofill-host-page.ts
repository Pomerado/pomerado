import { expect } from "@playwright/test";
import type { Page, CDPSession } from "playwright";
import { runInThisContext } from "node:vm";
import { Effect } from "effect";
import type { AutofillPage } from "../../src/destinations/autofill-step.js";
import { isolatedLocatorPage } from "./isolated-locator-page.js";
import { makeCredentialKeyboard } from "../../src/destinations/credential-keyboard.js";
import { kernelPlaywrightUtilityWorld } from "../../src/destinations/cdp-contracts.js";

/** Every URL a report's failure detail names is an origin alone: no path, query or fragment. */
export const expectOriginsOnly = (report: object) => {
  const detail: unknown = Reflect.get(report, "failureDetail");
  const text = JSON.stringify({ ...Object(detail) });
  for (const url of text.match(/[a-z]+:\/\/[^\s",]+/g) ?? [])
    expect(url).toBe(new URL(url).origin);
};

/** One Kernel call the host made: its script, as a worker posts it to Kernel, and its answer. */
export interface HostCall {
  readonly script: string;
  readonly answer: unknown;
}

/** The values the host's keyboard typed on each page, which no later call's script may hold. */
const typed = new WeakMap<Page, Set<string>>();

/** Whether `text` holds `value` as typed, percent-encoded, or in a host's lower case. */
const holds = (text: string, value: string) => {
  const read = text.toLowerCase();
  return [value, encodeURIComponent(value)].some((form) =>
    read.includes(form.toLowerCase()),
  );
};

/** A script without its random keys and call ids, inside which a short code could turn up. */
const withoutIds = (script: string) =>
  script.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "",
  );

/** No call's script or answer holds `value` in any form a page could copy it into a URL. */
export const expectNotCarried = (calls: readonly HostCall[], value: string) => {
  expect(calls.length).toBeGreaterThan(0);
  for (const { script, answer } of calls) {
    expect(holds(withoutIds(script), value)).toBe(false);
    expect(holds(JSON.stringify(answer) ?? "", value)).toBe(false);
  }
};

/**
 * The host's call on a local page: Kernel's `page`, `context` and `browser`, as on a worker. It
 * keeps every call, and fails the test, without changing what the call does, when a script holds a
 * value the host's keyboard already typed on the page (no value but a date of
 * birth enters a Kernel call's script). Configured origins the host sends (`configured`), which a
 * value may sit inside, do not count.
 */
export const hostPage = async (
  page: Page,
  configured: readonly string[] = [],
): Promise<AutofillPage & { readonly calls: readonly HostCall[] }> => {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  const calls: HostCall[] = [];
  return {
    targetId: targetInfo.targetId,
    calls,
    execute: (code) =>
      Effect.tryPromise({
        try: async () => {
          const checked = configured.reduce(
            (script, origin) => script.replaceAll(JSON.stringify(origin), ""),
            withoutIds(code),
          );
          for (const value of typed.get(page) ?? [])
            expect
              .soft(
                holds(checked, value),
                "A typed value reached a Kernel call's script",
              )
              .toBe(false);
          const run: unknown = runInThisContext(
            `(async (page, context, browser) => {\n${code}\n})`,
          );
          if (typeof run !== "function")
            throw new Error("Call code unavailable");
          const kernel = await isolatedLocatorPage(page);
          let value: unknown;
          try {
            value = await Reflect.apply(run, undefined, [
              kernel.page,
              kernel.page.context(),
              page.context().browser(),
            ]);
          } finally {
            await kernel.close();
          }
          const result: unknown =
            value === undefined ? undefined : JSON.parse(JSON.stringify(value));
          calls.push({ script: code, answer: result });
          return result;
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  };
};

/**
 * The host's typing on a local page, over a DevTools session of its own, as the recorder's socket
 * types on a worker. Each value it is given to type counts as typed on the page from then on.
 */
export const hostKeyboard = async (page: Page) => {
  const candidates = [
    page.mainFrame(),
    ...page.frames().filter((frame) => {
      const url = frame.url();
      return (
        frame !== page.mainFrame() &&
        url.startsWith("https:") &&
        new URL(url).origin !== new URL(page.url()).origin
      );
    }),
  ];
  const sessions = new Map<string, CDPSession>();
  for (const [index, frame] of candidates.entries()) {
    try {
      sessions.set(`local-${index}`, await page.context().newCDPSession(frame));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("does not have a separate CDP session")
      )
        throw error;
    }
  }
  const native = makeCredentialKeyboard(
    {
      sessions: () => [...sessions.keys()],
      send: async (method, params, id) => {
        const session = sessions.get(id);
        if (session === undefined)
          throw new Error("Fixture CDP session missing");
        const send = session.send.bind(session);
        const result: unknown = await Reflect.apply(send, undefined, [
          method,
          params,
        ]);
        return result;
      },
    },
    undefined,
    kernelPlaywrightUtilityWorld,
  );
  const keyboard: typeof native = {
    insertText: (target, text) =>
      Effect.suspend(() => {
        const values = typed.get(page) ?? new Set<string>();
        if (text !== "") typed.set(page, values.add(text));
        return native.insertText(target, text);
      }),
  };
  return { keyboard };
};
