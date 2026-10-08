import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { call, executionIdOf, recordingGuardian } from "./guardian-context-fixture.js";
import { act, mint } from "./standalone-mint-fixture.js";

const orderHost = "www.order.test";

/**
 * A controlled HTTPS order page: its Place button raises a native confirm with `message`, and
 * only an accepted confirm posts the order and shows "Order placed".
 */
const startOrderSite = async (directory: string) => {
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    `/CN=${orderHost}`,
    "-days",
    "1",
  ]);
  const state = { message: "Place this order?", orders: 0 };
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      if (request.method === "POST") {
        state.orders += 1;
        response.end("placed");
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<title>Order</title><button id="place">Place order</button><script>
document.querySelector("#place").onclick = () => {
  if (confirm(${JSON.stringify(state.message)}))
    fetch("/order", { method: "POST" }).then(() => {
      document.body.innerHTML = "<div id=placed>Order placed</div>";
    });
};
</script>`,
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No order address");
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${orderHost} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  return {
    url: `https://${orderHost}:${address.port}/`,
    state,
    browser,
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * A write step that clicks Place, reports the confirm to decideDialog as step `place-order`,
 * applies the decision and reads the confirmation back.
 */
const placeOrder = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"place_order",input:Schema.Struct({}),output:Schema.Struct({placed:Schema.Boolean}),write:{confirmation:"message",commits:["place"]}},
async ({kernel,sessionId,decideDialog,enteringCommit,verified}) => {
  const raised = await kernel.browsers.playwright.execute(sessionId,{code:"const shown = new Promise((resolve) => page.once('dialog', (dialog) => { globalThis.dialog = dialog; resolve({ type: dialog.type(), message: dialog.message(), url: page.url() }); })); void page.locator('#place').click().catch(() => {}); return await shown;",timeout_sec:10});
  if(!raised.success) throw new Error("No confirm");
  const decision = await decideDialog({step:"place-order",...raised.result});
  enteringCommit("place");
  const answered = await kernel.browsers.playwright.execute(sessionId,{code:decision.choice === "accept" ? "await globalThis.dialog.accept(); await page.locator('#placed').waitFor(); return true;" : "await globalThis.dialog.dismiss(); return false;",timeout_sec:10});
  if(!answered.success) throw new Error("Order not confirmed");
  if(answered.result === true) verified({confirmation:"message"});
  return {placed:answered.result === true};
});`;

/** The question a native dialog puts to the owner or the caller. */
const dialogQuestion = (request: InputRequest) =>
  request.questions.some((question) => question.prompt.includes("respond to this dialog"));

/** Mints the order write, the owner accepting its confirm, and returns the published artifact. */
const mintOrder = async (site: Awaited<ReturnType<typeof startOrderSite>>) => {
  const { built, asked } = await mint({
    effect: "write",
    url: site.url,
    intent: "Place the order",
    guardian: recordingGuardian(),
    browser: { endpoint: site.browser.wsEndpoint() },
    answer: (request) => (dialogQuestion(request) ? { choice: "accept" } : {}),
    turns: [
      () => [
        {
          type: "apply_patch_call",
          callId: "patch_order",
          status: "completed",
          operation: {
            type: "create_file",
            path: "src/order.mjs",
            diff: `${placeOrder
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")}\n`,
          },
        },
      ],
      () => [call("execute", act("src/order.mjs", {}), "place")],
      (request) => [
        call(
          "finish_build",
          {
            intent: "Return the order write without running it",
            entrypoint: "src/order.mjs",
            executionId: executionIdOf(request, "place"),
            metadata: { name: "place_order", description: "Place the order once" },
            coverage: "One confirmed act session that accepted the order confirm",
          },
          "publish",
        ),
      ],
    ],
  });
  expect(built.build, JSON.stringify(built)).toBe("published");
  expect(asked.filter(dialogQuestion)).toHaveLength(1);
  if (built.artifact === undefined) throw new Error(JSON.stringify(built));
  return built.artifact;
};

/** Runs the artifact as a write, answering every dialog question with `choice`. */
const runOrder = async (
  site: Awaited<ReturnType<typeof startOrderSite>>,
  artifact: Awaited<ReturnType<typeof mintOrder>>,
  choice: "accept" | "dismiss",
) => {
  const asked: InputRequest[] = [];
  const output = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createPomerado({
          browser: { endpoint: site.browser.wsEndpoint() },
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              asked.push(request);
              return dialogQuestion(request) ? { choice } : {};
            }),
          ),
          timeoutMs: 60_000,
        });
        return yield* service.run(artifact, {
          url: site.url,
          intent: "Place the order",
          effect: "write",
          input: {},
        });
      }),
    ),
  );
  return { output, asked: asked.filter(dialogQuestion) };
};

const withOrderSite = async (
  use: (site: Awaited<ReturnType<typeof startOrderSite>>) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-confirm-"));
  const site = await startOrderSite(directory);
  try {
    await use(site);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("a write's run asks the caller about the confirm its build accepted", async () => {
  test.setTimeout(120_000);
  await withOrderSite(async (site) => {
    const artifact = await mintOrder(site);
    expect(site.state.orders).toBe(1);
    const run = await runOrder(site, artifact, "accept");
    expect(run.output).toEqual({ placed: true });
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]?.notice).toContain("Place this order?");
    expect(site.state.orders).toBe(2);
  });
});

