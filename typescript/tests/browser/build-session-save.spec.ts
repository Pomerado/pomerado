import { once } from "node:events";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import { primaryPageCode } from "../../src/runtime/host-execute.js";
import { makeBuildStart } from "../../src/standalone/mint-state.js";

// A signed-in build's session save on the native executor, whose browser calls return at most
// 1 MiB: the save keeps the tab's session storage when it fits, and otherwise the stored state
// alone, as the build saved it before it kept session storage.

const startSite = async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<h1>${new URL(request.url ?? "/", "http://site.test").pathname}</h1>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No site address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/**
 * Signs a build in with `session` and `local` characters of tab and site storage on the root, then
 * starts its example, which saves the session and restores it. Returns what the example's page
 * holds.
 */
const exampleAfterSignIn = (session: number, local: number) =>
  Effect.gen(function* () {
    const site = yield* Effect.acquireRelease(
      Effect.promise(() => startSite()),
      (started) => Effect.promise(() => started.close()),
    );
    const executor = yield* makePlaywrightExecutor({ headless: true });
    const page = (code: string) =>
      executor.execute(`${primaryPageCode(executor.targetId)}\n${code}`, 30);
    const start = makeBuildStart(
      executor,
      site.origin,
      page(`await primary.goto(${JSON.stringify(`${site.origin}/`)});`).pipe(Effect.asVoid),
      () => undefined,
    );
    yield* start.before({ purpose: "authenticate", target: "liveBrowser" });
    yield* page(`await primary.evaluate(([session, local]) => {
  sessionStorage.setItem("big", "s".repeat(session));
  localStorage.setItem("token", "member");
  localStorage.setItem("big", "l".repeat(local));
}, [${session}, ${local}]);`);
    // The sign-in step typed the login, and the site showed the build signed in.
    start.sent(
      {
        outcome: "filled",
        fields: [
          { slot: "username", status: "filled" },
          { slot: "password", status: "filled" },
        ],
        submit: "clicked",
        url: `${site.origin}/account`,
      },
      [
        { selector: "#username", accepts: ["username"] },
        { selector: "#password", slot: "password" },
      ],
    );
    expect(start.verified()).toBe(true);
    yield* start.before({ purpose: "example", target: "liveBrowser" });
    return yield* page(`return await primary.evaluate(() => ({
  path: location.pathname,
  token: localStorage.getItem("token"),
  local: localStorage.getItem("big")?.length ?? 0,
  session: sessionStorage.getItem("big")?.length ?? 0,
}));`);
  });

const run = (session: number, local: number) =>
  Effect.runPromise(Effect.scoped(exampleAfterSignIn(session, local)));

test("a session that fits one browser call is saved with the tab's session storage", async () => {
  test.setTimeout(90_000);
  expect(await run(100_000, 100_000)).toEqual({
    path: "/",
    token: "member",
    local: 100_000,
    session: 100_000,
  });
});

test("tab session storage that makes the save larger than one browser call is left out", async () => {
  test.setTimeout(90_000);
  // 1.2 MB of tab storage alone.
  expect(await run(1_200_000, 0)).toEqual({ path: "/", token: "member", local: 0, session: 0 });
  // 0.6 MB of each: the stored state still fits on its own.
  expect(await run(600_000, 600_000)).toEqual({
    path: "/",
    token: "member",
    local: 600_000,
    session: 0,
  });
});
