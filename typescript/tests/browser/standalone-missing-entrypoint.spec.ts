import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import {
  call,
  execution,
  html,
  message,
  patch,
  probe,
  scripted,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";

for (const entrypoint of ["src/missing.mjs", "/workspace/src/missing.mjs"]) {
  test(`missing entrypoint ${entrypoint} is rejected before Guardian`, async ({
    channel,
    headless,
    launchOptions,
  }) => {
    const site = await startSite((_request, response) => html(response, "<h1>Fixture</h1>"));
    const browser = await chromium.launchServer({
      ...launchOptions,
      headless,
      ...(channel === undefined ? {} : { channel }),
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    let guardianCalls = 0;
    let feedback: Readonly<Record<string, unknown>> | undefined;
    const minter = scripted((request, index) => {
      if (index === 0) return [call("execute", execution("explore", entrypoint))];
      feedback = toolResult(request, "execute");
      abort.abort();
      return [message("Stopped after preflight feedback.")];
    });
    const guardian = scripted(() => {
      guardianCalls++;
      abort.abort();
      return [message("Unexpected Guardian call.")];
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createPomerado({
              browser: { endpoint: browser.wsEndpoint() },
              timeoutMs: 5_000,
              minterProvider: minter,
              guardianProvider: guardian,
              ask: () => Effect.die(new Error("Unexpected question")),
            });
            return yield* service.mint({
              url: site.url,
              intent: "Read the fixture heading",
              input: {},
              effect: "read",
            });
          }),
        ),
        { signal: abort.signal },
      ).catch(() => undefined);
      expect(guardianCalls).toBe(0);
      expect(feedback).toMatchObject({
        status: "unsupported",
        effect: "not_sent",
        observations: expect.stringMatching(/entrypoint.*does not exist/i),
      });
    } finally {
      clearTimeout(timer);
      await browser.close();
      await site.close();
    }
  });
}

test("an existing entrypoint still reaches Guardian", async ({ channel, headless, launchOptions }) => {
  const site = await startSite((_request, response) => html(response, "<h1>Fixture</h1>"));
  const browser = await chromium.launchServer({
    ...launchOptions,
    headless,
    ...(channel === undefined ? {} : { channel }),
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  let guardianCalls = 0;
  const minter = scripted((_request, index) =>
    index === 0
      ? patch({ "src/tool.mjs": probe() })
      : [call("execute", execution("explore", "/workspace/src/tool.mjs"))],
  );
  const guardian = scripted(() => {
    guardianCalls++;
    abort.abort();
    return [message("Stopped at the unchanged Guardian boundary.")];
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            browser: { endpoint: browser.wsEndpoint() },
            timeoutMs: 5_000,
            minterProvider: minter,
            guardianProvider: guardian,
            ask: () => Effect.die(new Error("Unexpected question")),
          });
          return yield* service.mint({
            url: site.url,
            intent: "Read the fixture heading",
            input: {},
            effect: "read",
          });
        }),
      ),
      { signal: abort.signal },
    ).catch(() => undefined);
    expect(guardianCalls).toBe(1);
  } finally {
    clearTimeout(timer);
    await browser.close();
    await site.close();
  }
});
