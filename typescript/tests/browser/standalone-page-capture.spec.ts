import { test, expect } from "@playwright/test";
import {
  call,
  contextOf,
  execution,
  html,
  patch,
  probe,
  recordingGuardian,
  startSite,
  toolResult,
  type RecordedReview,
} from "./guardian-context-fixture.js";
import { executions, mint } from "./standalone-mint-fixture.js";

const capturePath = "captures/current-page.aria.yml";
/** The page capture Guardian read in `review`, all its chunks, as text. */
const captureOf = (review: RecordedReview | undefined) =>
  (review?.reads ?? [])
    .filter((read) => read["path"] === capturePath)
    .map((read) => String(read["source"]))
    .join("");
const secretQuestion = {
  intent: "Ask for the private code",
  questions: [{ id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" }],
};
const escaped = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

test("a secret the page shows with its whitespace collapsed, or form-encoded in its URL, never reaches Guardian", async () => {
  test.setTimeout(90_000);
  const secret = "correct  horse  battery";
  // The form sends the code in the URL, and the next page shows it back in a password field.
  const site = await startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/done") {
      const code = url.searchParams.get("code") ?? "";
      html(
        response,
        `<title>Done</title><h1>Done</h1><input type="password" aria-label="Code" value="${escaped(code)}">`,
      );
      return;
    }
    html(
      response,
      `<title>Code</title><form method="get" action="/done"><input type="password" name="code" aria-label="Code"><button>Go</button></form>`,
    );
  });
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: secret }),
      turns: [
        () =>
          patch({
            "explore/fill.mjs": probe(
              "await page.getByLabel('Code').fill('{{secret.s1}}'); return 1;",
            ),
            "explore/submit.mjs": probe(
              `await Promise.all([page.waitForURL("**/done**"), page.getByRole("button").click()]); return 1;`,
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/fill.mjs"), "fill")],
        () => [call("execute", execution("explore", "explore/submit.mjs"), "submit")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "submit"), JSON.stringify(toolResult(last, "submit"))).toMatchObject({
      status: "completed",
    });
    const look = executions(guardian.reviews)[2];
    expect(contextOf(look!)?.["currentPage"]).toMatchObject({ path: "/done?code=[private]" });
    expect(captureOf(look)).toContain('textbox "Code": [private]');
    // No form of the secret reaches Guardian or the minter: as given, as the page's snapshot
    // shows it, or as the form wrote it into the URL.
    for (const shown of [secret, "correct horse battery", "correct++horse++battery"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  } finally {
    await site.close();
  }
});

test("a username with an apostrophe never reaches Guardian, in a quoted snapshot key or a URL's query", async () => {
  test.setTimeout(90_000);
  const username = "o'brien@example.com";
  // The form sends the login, the site redirects with it in the query as written, and the page's
  // heading holds ": ", so the snapshot single-quotes its key and doubles the apostrophe.
  const site = await startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/signin") {
      response.statusCode = 302;
      response.setHeader("Location", `/account?u=${url.searchParams.get("login") ?? ""}`);
      response.end();
      return;
    }
    if (url.pathname === "/account") {
      html(
        response,
        `<title>Account</title><h1>Account: ${escaped(url.searchParams.get("u") ?? "")}</h1>`,
      );
      return;
    }
    html(
      response,
      `<title>Sign in</title><form method="get" action="/signin"><input name="login" aria-label="Login"><button>Go</button></form>`,
    );
  });
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: username }),
      turns: [
        () =>
          patch({
            "explore/fill.mjs": probe(
              "await page.getByLabel('Login').fill('{{secret.s1}}'); return 1;",
            ),
            "explore/submit.mjs": probe(
              `await Promise.all([page.waitForURL("**/account**"), page.getByRole("button").click()]); return 1;`,
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/fill.mjs"), "fill")],
        () => [call("execute", execution("explore", "explore/submit.mjs"), "submit")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "submit"), JSON.stringify(toolResult(last, "submit"))).toMatchObject({
      status: "completed",
    });
    const look = executions(guardian.reviews)[2];
    expect(contextOf(look!)?.["currentPage"]).toMatchObject({ path: "/account?u=[private]" });
    expect(captureOf(look)).toContain(`'heading "Account: [private]" [level=1]'`);
    for (const shown of ["o'brien", "o''brien", "o%27brien"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  } finally {
    await site.close();
  }
});

test("a secret the browser writes into a URL's path, with | encoded, never reaches Guardian", async () => {
  test.setTimeout(90_000);
  const secret = "a$b|c";
  // The site redirects to a path holding the login as written; the browser writes | as %7C there
  // and leaves $ as it is, which no query or encodeURIComponent form matches.
  const site = await startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/signin") {
      response.statusCode = 302;
      response.setHeader("Location", `/u/${url.searchParams.get("login") ?? ""}`);
      response.end();
      return;
    }
    if (url.pathname.startsWith("/u/")) {
      html(response, "<title>Profile</title><h1>Profile</h1>");
      return;
    }
    html(
      response,
      `<title>Sign in</title><form method="get" action="/signin"><input name="login" aria-label="Login"><button>Go</button></form>`,
    );
  });
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: secret }),
      turns: [
        () =>
          patch({
            "explore/fill.mjs": probe(
              "await page.getByLabel('Login').fill('{{secret.s1}}'); return 1;",
            ),
            "explore/submit.mjs": probe(
              `await Promise.all([page.waitForURL("**/u/**"), page.getByRole("button").click()]); return 1;`,
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/fill.mjs"), "fill")],
        () => [call("execute", execution("explore", "explore/submit.mjs"), "submit")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "submit"), JSON.stringify(toolResult(last, "submit"))).toMatchObject({
      status: "completed",
    });
    const look = executions(guardian.reviews)[2];
    expect(contextOf(look!)?.["currentPage"]).toMatchObject({ path: "/u/[private]" });
    for (const shown of [secret, "a$b%7Cc", "a$b%7cc"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  } finally {
    await site.close();
  }
});

test("a separator hidden from assistive technology, and an unnamed form's edge, still split the capture, so a notice stays with its own button", async () => {
  test.setTimeout(90_000);
  // An unnamed form, with a select inside its label, ends with its button; a divider hidden from
  // the accessibility tree follows it, then a logo-only button, another hidden divider, a notice
  // and another button. The snapshot drops the dividers, the form and the wrappers.
  const site = await startSite((_request, response) =>
    html(
      response,
      `<title>Checkout</title><main><form><input aria-label="Email"><label>Country <select><option>Canada</option><option>Norway</option></select></label>` +
        `<button type="button">Continue to payment</button></form>` +
        `<x-divider role="separator" aria-hidden="true" style="display:block;border-top:1px solid">or</x-divider>` +
        `<div><button type="button" aria-label="Wallet app"><svg aria-hidden="true" width="16" height="16"></svg></button><hr aria-hidden="true">` +
        `<div>By continuing, you agree to open a store account.</div><button type="button">Continue with wallet</button></div></main>`,
    ),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    // The second step's review reads the page the first one left.
    expect(captureOf(executions(guardian.reviews)[1])).toContain(
      [
        "- main:",
        "  - form:",
        '    - textbox "Email"',
        "    - text: Country",
        '    - combobox "Country":',
        '      - option "Canada" [selected]',
        '      - option "Norway"',
        '    - button "Continue to payment"',
        "  - separator [aria-hidden]",
        '  - button "Wallet app"',
        "  - separator [aria-hidden]",
        "  - text: By continuing, you agree to open a store account.",
        '  - button "Continue with wallet"',
      ].join("\n"),
    );
  } finally {
    await site.close();
  }
});

test("an unnamed form's custom fields, labelled in their open shadow roots or by slotted text, show inside its edge in the capture", async () => {
  test.setTimeout(90_000);
  // A form-associated field draws its own textbox, and another custom element holds a native
  // input, each labelled in its open shadow root; a notice past a hidden divider follows the form.
  // Fields that show light-DOM text through a slot follow: a label slotted before an input and
  // help text, a select after its slotted label, a button showing slotted text before more text,
  // a slotted label over fallback text, and such a field just before a form.
  const site = await startSite((_request, response) =>
    html(
      response,
      `<title>Checkout</title><script>const define = (name, shadow, formAssociated) => customElements.define(name, ` +
        `class extends HTMLElement { static formAssociated = formAssociated; connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = shadow; } });` +
        `define("x-phone", '<label id="label">Phone</label><div role="textbox" contenteditable aria-labelledby="label"></div>', true);` +
        `define("x-input", '<label for="input">Email</label><input id="input">');` +
        `define("x-text", '<label><slot name="label"></slot><input></label><small>We send the receipt here.</small>');` +
        `define("x-select", '<slot></slot><select><option>Small</option><option>Large</option></select>');` +
        `define("x-named", '<label><slot name="label">Field</slot><input></label>');` +
        `define("x-submit", '<input type="hidden"><button><slot></slot></button> Secure checkout');</script>` +
        `<main><h1>Check out as a guest</h1><form><x-phone></x-phone><x-input></x-input>` +
        `<button type="button">Continue to payment</button></form><hr aria-hidden="true">` +
        `<div>Signing in opens a store account.</div><button type="button">Sign in</button>` +
        `<form><x-text><span slot="label">Mobile number</span></x-text><x-submit>Place order</x-submit></form>` +
        `<p>Orders ship in two days.</p><form><x-select>Size</x-select><button type="button">Add</button></form>` +
        `<p>Sizes run small.</p><x-text><span slot="label">Coupon</span></x-text>` +
        `<form><x-named><span slot="label">Name</span></x-named><button type="button">Save</button></form>` +
        `<p>Names show on the receipt.</p></main>`,
    ),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    expect(captureOf(executions(guardian.reviews)[1])).toContain(
      [
        "  - form:",
        "    - text: Phone",
        '    - textbox "Phone"',
        "    - text: Email",
        '    - textbox "Email"',
        '    - button "Continue to payment"',
        "  - separator [aria-hidden]",
        "  - text: Signing in opens a store account.",
        '  - button "Sign in"',
        "  - form:",
        "    - text: Mobile number",
        '    - textbox "Mobile number"',
        "    - text: We send the receipt here.",
        '    - button "Place order"',
        "  - text: Secure checkout",
        "  - paragraph: Orders ship in two days.",
        "  - form:",
        "    - text: Size",
        "    - combobox:",
        '      - option "Small" [selected]',
        '      - option "Large"',
        '    - button "Add"',
        "  - paragraph: Sizes run small.",
        "  - text: Coupon",
        '  - textbox "Coupon"',
        "  - form:",
        "    - text: We send the receipt here. Name",
        '    - textbox "Name"',
        '    - button "Save"',
        "  - paragraph: Names show on the receipt.",
      ].join("\n"),
    );
  } finally {
    await site.close();
  }
});

test("text the page holds only out of view reads as hidden in the capture, and a shown copy does not", async () => {
  test.setTimeout(90_000);
  // An announcement kept off screen beside an aria-hidden icon; a shown error and a shown count,
  // each with an off-screen copy, the count's holding its number in an element; a price whose
  // off-screen copy sits beside the aria-hidden digits it shows; and shown text with off-screen
  // copies that are aria-hidden or not displayed. The page also holds a divider hidden from
  // assistive technology, and redefines how an array turns into JSON, as an old script library
  // does.
  const offScreen = "position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden";
  const announcement = "Time is up. You can no longer add items.";
  const site = await startSite((_request, response) =>
    html(
      response,
      `<title>Order</title><script>Array.prototype.toJSON = function () { return "[]"; };</script>` +
        `<main><h1>Add to your order</h1><hr aria-hidden="true"><div role="status">3 hours left</div>` +
        `<div><svg aria-hidden="true" width="8" height="8"></svg><span style="${offScreen}" aria-live="assertive">${announcement}</span></div>` +
        `<div role="alert">Card declined</div><div style="${offScreen}">Card declined</div>` +
        `<p>Showing 24 results</p><div style="${offScreen}">Showing <span>24</span> results</div>` +
        `<p><span style="${offScreen}">$9.99</span><span aria-hidden="true">$9<sup>99</sup></span></p>` +
        `<p>Saved</p><span style="${offScreen}" aria-hidden="true">Saved</span><span style="${offScreen};display:none">Saved</span></main>`,
    ),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    expect(captureOf(executions(guardian.reviews)[1])).toContain(
      `  - status: 3 hours left\n  - text: [hidden: ${announcement}]\n  - alert: Card declined\n  - text: Card declined\n  - paragraph: Showing 24 results\n  - text: Showing 24 results\n  - paragraph: $9.99\n  - paragraph: Saved`,
    );
  } finally {
    await site.close();
  }
});

test("a page over the element limit is not captured, and the browser keeps working", async () => {
  test.setTimeout(90_000);
  const items = Array.from(
    { length: 4_000 },
    (_, index) => `<li><a href="/item/${index}">Item ${index}</a><button>Add</button></li>`,
  ).join("");
  const site = await startSite((_request, response) =>
    html(response, `<title>Catalog</title><ul>${items}</ul>`),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "first")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    const second = executions(guardian.reviews)[1];
    // Guardian still knows where the page is, and why it has no capture.
    expect(contextOf(second!)?.["currentPage"]).toMatchObject({ path: "/" });
    expect(captureOf(second)).toMatch(
      /^Page too large to capture: [\d,]+ elements, over the 10,000 the host reads\.$/u,
    );
    expect(captureOf(second)).not.toContain("Item 1");
  } finally {
    await site.close();
  }
});

test("a capture cut at 256 KiB keeps no prefix of a secret the cut split, even one given later", async () => {
  test.setTimeout(90_000);
  const secret = "fixture-private-value";
  // The snapshot reads "- paragraph: " and then the text, so the 256 KiB cut falls inside the
  // secret, after its first ten characters.
  const filler = "x".repeat(256 * 1024 - "- paragraph: ".length - 10);
  const site = await startSite((_request, response) =>
    html(response, `<title>Long</title><p>${filler}${secret} tail</p>`),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: secret }),
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        // The owner gives the value only after the page was captured.
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    const capture = captureOf(executions(guardian.reviews)[1]);
    expect(capture.endsWith("\n…[truncated at 256 KiB]")).toBe(true);
    expect(capture.slice(0, capture.lastIndexOf("\n…"))).toMatch(/x$/u);
    expect(JSON.stringify(guardian.reviews)).not.toContain("fixture-p");
  } finally {
    await site.close();
  }
});

test("a page that stays busy is not captured, and the browser outlives it", async () => {
  test.setTimeout(120_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Busy</title><h1>Busy</h1>"),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            // The page's main thread stays busy for longer than the host waits for a capture.
            "explore/busy.mjs": probe(
              "await page.evaluate(() => { setTimeout(() => { const end = Date.now() + 25000; while (Date.now() < end); }, 0); }); await new Promise((resolve) => setTimeout(resolve, 300)); return 1;",
            ),
            // The next step waits for the page to answer again.
            "explore/after.mjs": probe().replace("timeout_sec:5", "timeout_sec:60"),
          }),
        () => [call("execute", execution("explore", "explore/busy.mjs"), "busy")],
        () => [
          call(
            "execute",
            execution("explore", "explore/after.mjs", { timeoutSeconds: 60 }),
            "after",
          ),
        ],
      ],
    });
    expect(toolResult(last, "busy")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "after"), JSON.stringify(toolResult(last, "after"))).toMatchObject({
      status: "completed",
    });
    const after = executions(guardian.reviews)[1];
    expect(contextOf(after!)?.["currentPage"]).toMatchObject({ path: "/" });
    expect(captureOf(after)).toMatch(/^Page not captured: /u);
  } finally {
    await site.close();
  }
});
