import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import type {
  PlaywrightExecutor,
  PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";
import { makeKernelCompatibility } from "../../src/runtime/kernel-compatibility.js";
import { inspectAutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import invoiceHeading from "../../authoring/examples/native-page.js";
import { detailNavigation } from "../../authoring/examples/navigation.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation.js";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

const native = <A>(
  run: (executor: PlaywrightExecutor) => Promise<A>,
  options: PlaywrightOptions = {},
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

const client = (executor: PlaywrightExecutor) =>
  makeKernelCompatibility(executor.sessionId, executor.executeResponse).browsers.playwright;

test("compiled native executor starts from an inline ES module parent", async () => {
  const script = `import { Effect } from 'effect';
import { makePlaywrightExecutor } from './dist/typescript/src/execution/playwright-execute.js';
const response = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const executor = yield* makePlaywrightExecutor();
  return yield* executor.executeResponse('return await page.title();', 2);
})));
console.log(JSON.stringify(response));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  expect(closed[0], errors).toBe(0);
  expect(JSON.parse(output)).toEqual({ success: true, result: "", stdout: "", stderr: "" });
});

// Actual Chromium establishes persistent targets, trusted credential events and context ownership.
test("generated calls retain their selected page and full success or failure response", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    const response = await kernel.execute(executor.sessionId, {
      code: `await page.setContent('<title>Native fixture</title><label>Name<input></label>');
        await page.getByLabel('Name').fill('Caller supplied');
        console.log('stdout fixture'); console.warn('stderr fixture');
        return {title: await page.title(), value: await page.getByLabel('Name').inputValue()};`,
      timeout_sec: 2,
    });
    expect(response).toEqual({
      success: true,
      result: { title: "Native fixture", value: "Caller supplied" },
      stdout: "stdout fixture\n",
      stderr: "stderr fixture\n",
    });
    const failed = await kernel.execute(executor.sessionId, {
      code: "console.info('before throw'); console.error('error stream'); throw new Error('fixture failure');",
    });
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("fixture failure");
    expect(failed.stdout).toBe("before throw\n");
    expect(failed.stderr).toContain("error stream\n");
    expect(failed.stderr).toContain("Error: fixture failure");
    const next = await kernel.execute(executor.sessionId, {
      code: "return await page.getByLabel('Name').inputValue();",
    });
    expect(next.result).toBe("Caller supplied");
    await expect(
      Effect.runPromise(executor.execute("throw new Error('host fixture failure');")),
    ).rejects.toThrow("host fixture failure");
  });
});

test("unsupported and oversized results fail without invalidating the browser", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    for (const code of [
      "return 1n;",
      "const value = {}; value.self = value; return value;",
      "return 'x'.repeat(1048577);",
      "console.log('x'.repeat(1048577)); return 'truncated success';",
    ]) {
      const response = await kernel.execute(executor.sessionId, { code });
      expect(response.success).toBe(false);
      expect(response.error).toBeTruthy();
      expect(response.result).toBeUndefined();
    }
    expect(await kernel.execute(executor.sessionId, { code: "return;" })).toEqual({
      success: true,
      stdout: "",
      stderr: "",
    });
    expect(
      (await kernel.execute(executor.sessionId, { code: "return [1, {ok: true}];" })).result,
    ).toEqual([1, { ok: true }]);
  });
});

test("popup and frame actions preserve the original selected page across calls", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    const response = await kernel.execute(executor.sessionId, {
      code: `await page.setContent('<title>Primary</title><iframe srcdoc="<p>Frame fixture</p>"></iframe><button onclick="window.open(&quot;about:blank&quot;)">Open</button>');
        const popupPending = page.waitForEvent('popup');
        await page.getByText('Open', {exact:true}).click();
        const popup = await popupPending;
        await popup.setContent('<title>Popup</title>');
        return {frame: await page.frameLocator('iframe').locator('p').innerText(), popup: await popup.title(), pages: context.pages().length};`,
    });
    expect(response.success, response.error).toBe(true);
    expect(response).toMatchObject({
      success: true,
      result: { frame: "Frame fixture", popup: "Popup", pages: 2 },
    });
    expect(
      (await kernel.execute(executor.sessionId, { code: "return await page.title();" })).result,
    ).toBe("Primary");
  });
});

test("remote attachment releases owned contexts and preserves the caller's browser", async () => {
  const server = await chromium.launchServer({ headless: true });
  const owner = await chromium.connect(server.wsEndpoint());
  try {
    const unrelated = await owner.newContext();
    const page = await unrelated.newPage();
    await page.setContent("<title>Caller context</title><button>Still usable</button>");
    const census = await owner.newBrowserCDPSession();
    try {
      const before = await census.send("Target.getBrowserContexts");
      await native(
        async (executor) => {
          const response = await client(executor).execute(executor.sessionId, {
            code: "await page.setContent('<title>Attached fixture</title>'); const extra = await browser.newContext(); await extra.newPage(); return await page.title();",
          });
          expect(response.result).toBe("Attached fixture");
          await Effect.runPromise(executor.close);
        },
        { endpoint: server.wsEndpoint() },
      );
      expect(await census.send("Target.getBrowserContexts")).toEqual(before);
      expect(owner.isConnected()).toBe(true);
      await page.getByText("Still usable").click();
      expect(await page.title()).toBe("Caller context");
    } finally {
      await census.detach();
    }
  } finally {
    await owner.close();
    await server.close();
  }
});

for (const mode of ["pending_abort", "infinite_abort", "infinite_timeout"] as const) {
  test(`${mode} stops execution without replay`, async () => {
    const written = Promise.withResolvers<void>();
    let writes = 0;
    const fixture = createServer((request, response) => {
      if (request.url === "/write") {
        writes++;
        response.end("Recorded");
        written.resolve();
      } else response.end("<title>Cancellation fixture</title>");
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("Fixture address missing");
    const origin = `http://127.0.0.1:${address.port}`;
    const server = await chromium.launchServer({ headless: true });
    const owner = await chromium.connect(server.wsEndpoint());
    try {
      const unrelated = await owner.newContext();
      const page = await unrelated.newPage();
      await page.setContent("<title>Unrelated</title>");
      await native(
        async (executor) => {
          const kernel = client(executor);
          const abort = new AbortController();
          const completion = kernel
            .execute(
              executor.sessionId,
              {
                code: `await page.goto(${JSON.stringify(origin)});
            await page.evaluate(() => fetch('/write', {method:'POST'}).then(response => response.text()));
            ${mode === "pending_abort" ? "await page.waitForTimeout(60000);" : "while(true) {}"}`,
                timeout_sec: mode === "infinite_timeout" ? 1 : 10,
              },
              { signal: abort.signal, maxRetries: 3 },
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          await written.promise;
          if (mode !== "infinite_timeout") abort.abort(new Error("Caller cancelled fixture"));
          expect(await completion).toBeInstanceOf(Error);
          await expect(
            kernel.execute(executor.sessionId, { code: "return 'replay';" }),
          ).rejects.toThrow("invalidated");
          expect(writes).toBe(1);
        },
        { endpoint: server.wsEndpoint() },
      );
      expect(await page.title()).toBe("Unrelated");
      expect(owner.isConnected()).toBe(true);
      const census = await owner.newBrowserCDPSession();
      try {
        expect((await census.send("Target.getBrowserContexts")).browserContextIds).toHaveLength(1);
      } finally {
        await census.detach();
      }
    } finally {
      await owner.close();
      await server.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
}

test("original autofill uses native trusted input and refuses a stale field binding", async () => {
  await native(async (executor) => {
    const site = "https://login.example.test";
    await Effect.runPromise(
      executor.execute(`
      await context.route('${site}/**', route => route.fulfill({contentType:'text/html', body:'<label>Password<input id="password" type="password"></label><input id="other">'}));
      await page.goto('${site}');
      await page.evaluate(() => { window.trustedInput = []; document.addEventListener('input', event => window.trustedInput.push(event.isTrusted)); });
    `),
    );
    const step = { fields: [{ selector: "#password", slot: "password" as const }] };
    const host = { targetId: executor.targetId, execute: executor.execute };
    const inspection = await Effect.runPromise(
      inspectAutofillStep({
        step,
        page: host,
        siteOrigin: site,
        authenticationOrigins: [],
      }),
    );
    if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["synthetic-native-secret"],
        inspection,
        page: host,
        keyboard: executor.keyboard,
        settleMs: 0,
      }),
    );
    expect(report.outcome).toBe("filled");
    const verification = await Effect.runPromise(
      executor.executeResponse(
        `return await page.evaluate(() => ({filled: document.querySelector('#password').value === 'synthetic-native-secret', trusted: window.trustedInput}));`,
      ),
    );
    expect(verification.result).toEqual({ filled: true, trusted: [true] });
    expect(JSON.stringify(verification)).not.toContain("synthetic-native-secret");
    await Effect.runPromise(executor.execute("await page.locator('#password').fill('');"));
    const stale = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["never-inserted"],
        inspection,
        page: host,
        settleMs: 0,
        keyboard: {
          insertText: (target, text) =>
            executor
              .execute("await page.locator('#other').focus();")
              .pipe(Effect.zipRight(executor.keyboard.insertText(target, text))),
        },
      }),
    );
    expect(stale.outcome).toBe("refused");
    expect(
      await Effect.runPromise(
        executor.execute("return await page.locator('#other').inputValue();"),
      ),
    ).toBe("");
  });
});

test("native autofill preserves an approved cross-site frame binding", async () => {
  const server = await chromium.launchServer({ headless: true, args: ["--site-per-process"] });
  try {
    await native(
      async (executor) => {
        const site = "https://login.example.test";
        const authOrigin = "https://approved-sign-in.test";
        await Effect.runPromise(
          executor.execute(`
      await context.route('${site}/**', route => route.fulfill({contentType:'text/html', body:'<iframe src="${authOrigin}"></iframe>'}));
      await context.route('${authOrigin}/**', route => route.fulfill({contentType:'text/html', body:'<input id="frame-password" type="password">'}));
      await page.goto('${site}');
      await page.frameLocator('iframe').locator('#frame-password').waitFor();
      const frame = page.frames().find(frame => frame.url().startsWith('${authOrigin}'));
      const cdp = await context.newCDPSession(frame); await cdp.detach();
    `),
        );
        const step = { fields: [{ selector: "#frame-password", slot: "password" as const }] };
        const host = { targetId: executor.targetId, execute: executor.execute };
        const inspection = await Effect.runPromise(
          inspectAutofillStep({
            step,
            page: host,
            siteOrigin: site,
            authenticationOrigins: [authOrigin],
          }),
        );
        if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
        const report = await Effect.runPromise(
          fillAutofillStep({
            step,
            values: ["synthetic-frame-secret"],
            inspection,
            page: host,
            keyboard: executor.keyboard,
            settleMs: 0,
          }),
        );
        expect(report.outcome).toBe("filled");
        expect(
          await Effect.runPromise(
            executor.execute(
              `return await page.frameLocator('iframe').locator('#frame-password').evaluate(input => input.value === 'synthetic-frame-secret');`,
            ),
          ),
        ).toBe(true);
      },
      { endpoint: server.wsEndpoint() },
    );
  } finally {
    await server.close();
  }
});

test("unchanged authored operations run through schema validation and native execution", async () => {
  await native(async (executor) => {
    const site = "https://example.test";
    await Effect.runPromise(
      executor.execute(`
      await context.route('${site}/**', route => route.fulfill({contentType:'text/html', body:'<h1>Invoices</h1><section role="region" aria-label="Record details" data-record-id="alpha"><h1>Requested record</h1></section>'}));
      await page.goto('${site}');
    `),
    );
    const journal = await Effect.runPromise(makeEffectJournal);
    const execution = {
      deadline: Deadline.after(5000),
      journal,
      events: { emit: () => Effect.void },
      capture: { start: Effect.void, finish: Effect.void },
    };
    const browser = {
      kernel: makeKernelCompatibility(executor.sessionId, executor.executeResponse),
      sessionId: executor.sessionId,
      siteOrigin: site,
    };
    expect(
      await Effect.runPromise(
        Effect.scoped(
          executeKernelOperation(invoiceHeading, {}, browser).pipe(
            Effect.provideService(ExecutionContext, execution),
          ),
        ),
      ),
    ).toEqual({ heading: "Invoices" });
    expect(
      await Effect.runPromise(
        Effect.scoped(
          executeKernelOperation(detailNavigation, { recordId: "alpha" }, browser).pipe(
            Effect.provideService(ExecutionContext, execution),
          ),
        ),
      ),
    ).toEqual({ recordId: "alpha", title: "Requested record" });
    const refusedInput = await Effect.runPromise(
      Effect.scoped(
        executeKernelOperation(detailNavigation, { recordId: "bad/id" }, browser).pipe(
          Effect.provideService(ExecutionContext, execution),
          Effect.either,
        ),
      ),
    );
    expect(refusedInput).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
  });
});

const writeFixture = async () => {
  const written = Promise.withResolvers<void>();
  let writes = 0;
  let credentialRequests = 0;
  const fixture = createServer((request, response) => {
    if (request.url === "/write") {
      writes++;
      written.resolve();
      response.end("Recorded");
    } else if (request.url?.startsWith("/credential")) {
      credentialRequests++;
      response.end("Observed");
    } else
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          '<input id="password" type="password" oninput="fetch(\'/credential?value=\'+encodeURIComponent(this.value))">',
        );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  if (address === null || typeof address === "string") throw new Error("Fixture address missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    written: written.promise,
    writes: () => writes,
    credentialRequests: () => credentialRequests,
    close: async () => {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    },
  };
};

test("lost native browser reports cleanup uncertainty and prevents replay", async () => {
  const fixture = await writeFixture();
  const server = await chromium.launchServer({ headless: true });
  try {
    await expect(
      native(
        async (executor) => {
          const kernel = client(executor);
          const pending = kernel
            .execute(executor.sessionId, {
              code: `await page.goto(${JSON.stringify(fixture.origin)}); await page.evaluate(()=>fetch('/write',{method:'POST'})); await page.waitForTimeout(60000);`,
            })
            .then(
              (response) => response,
              (error: unknown) => error,
            );
          await fixture.written;
          await server.close();
          const failure = await pending;
          if (failure instanceof Error) expect(String(failure)).toContain("cleanup unconfirmed");
          else expect(failure).toMatchObject({ success: false });
          await expect(
            kernel.execute(executor.sessionId, { code: "return 'retry';" }),
          ).rejects.toThrow("invalidated");
          await expect(Effect.runPromise(executor.close)).rejects.toThrow("cleanup unconfirmed");
          expect(fixture.writes()).toBe(1);
        },
        { endpoint: server.wsEndpoint() },
      ),
    ).rejects.toThrow("cleanup unconfirmed");
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("credential queued behind cancelled browser work is never inserted", async () => {
  const fixture = await writeFixture();
  const server = await chromium.launchServer({ headless: true });
  const owner = await chromium.connect(server.wsEndpoint());
  try {
    const unrelated = await owner.newContext();
    const page = await unrelated.newPage();
    await page.setContent("<title>Caller context</title>");
    await native(
      async (executor) => {
        const kernel = client(executor);
        const abort = new AbortController();
        const bindingKey = "__pomerado_queued_fixture";
        await Effect.runPromise(
          executor.execute(`await page.goto(${JSON.stringify(fixture.origin)});
        await page.locator('#password').focus();
        await page.locator('#password').evaluate((field,key)=>{field.setAttribute(key,'');field[key]={document:field.ownerDocument,frame:field.ownerDocument.defaultView};},${JSON.stringify(bindingKey)});`),
        );
        expect(
          await Effect.runPromise(
            executor.keyboard.insertText(
              { bindingKey, documentOrigin: fixture.origin },
              "native-control",
            ),
          ),
        ).toBe(true);
        await expect.poll(fixture.credentialRequests).toBe(1);
        await Effect.runPromise(
          executor.execute(`
          await page.locator('#password').evaluate((field,key)=>{field.value='';field.focus();field.setAttribute(key,'');field[key]={document:field.ownerDocument,frame:field.ownerDocument.defaultView};},${JSON.stringify(bindingKey)});`),
        );
        const pending = kernel
          .execute(
            executor.sessionId,
            {
              code: "await page.evaluate(()=>fetch('/write',{method:'POST'}));await page.waitForTimeout(60000);",
            },
            { signal: abort.signal },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await fixture.written;
        const queued = Effect.runPromise(
          executor.keyboard.insertText(
            { bindingKey, documentOrigin: fixture.origin },
            "synthetic-queued-secret",
          ),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        abort.abort(new Error("Caller cancelled pending browser work"));
        expect(await pending).toBeInstanceOf(Error);
        const credentialFailure = await queued;
        expect(credentialFailure).toBeInstanceOf(Error);
        expect(String(credentialFailure)).toContain("invalidated");
        expect(fixture.writes()).toBe(1);
        expect(fixture.credentialRequests()).toBe(1);
      },
      { endpoint: server.wsEndpoint() },
    );
    expect(await page.title()).toBe("Caller context");
  } finally {
    await owner.close();
    await server.close();
    await fixture.close();
  }
});

test("native page code does not inherit host variables through process.env", async () => {
  const key = "POMERADO_NATIVE_HOST_ONLY_FIXTURE";
  const previous = process.env[key];
  process.env[key] = "synthetic-host-only-value";
  try {
    await native(async (executor) => {
      const response = await client(executor).execute(executor.sessionId, {
        code: `return process.env[${JSON.stringify(key)}] ?? null;`,
      });
      expect(response).toMatchObject({ success: true, result: null });
    });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("local operation preserves authored typed challenge failures", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint: "operation/src/tool.mjs",
          sources: [
            [
              "operation/src/tool.mjs",
              `import { Schema } from "effect";
import { defineOperation, ChallengeFailure } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => {
  throw new ChallengeFailure({ code: "Unavailable" });
});`,
            ],
          ],
          input: {},
          target: "pureFiles",
        }).pipe(Effect.either);
      }),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      name: "LocalOperationFailure",
      tag: "ChallengeFailure",
      code: "Unavailable",
      journal: { effect: "not_sent", commits: [] },
    },
  });
});
