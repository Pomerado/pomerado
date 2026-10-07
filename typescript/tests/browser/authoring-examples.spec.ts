import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect, Either, Schema } from "effect";
import authEntry from "../../authoring/examples/auth-entry.js";
import chooseAirport from "../../authoring/examples/custom-selection.js";
import setDeparture from "../../authoring/examples/dates-and-dropdowns.js";
import attachDocument, { pickTravelDate } from "../../authoring/examples/dates-and-files.js";
import dialogPicker from "../../authoring/examples/dialog-picker.js";
import deleteInvoice from "../../authoring/examples/native-dialog.js";
import readHeading from "../../authoring/examples/native-page.js";
import readCatalog, { detailNavigation } from "../../authoring/examples/navigation.js";
import selectStatus from "../../authoring/examples/selection.js";
import readInvoiceIds from "../../authoring/examples/variants.js";
import createTask from "../../authoring/examples/write-readback.js";
import placeOrder, { fillStep, placeStep } from "../../authoring/examples/write-session.js";
import { defineOperation } from "../../src/runtime/operation.js";

import { runExample, failure } from "./authoring-fixture.js";

const dialogPickerFixture = async (page: Page, mode: "success" | "ambiguous" | "no_commit") => {
  await page.setContent(
    [
      "<button type='button' id='launcher'>Choose catalog item</button>",
      "<input aria-label='Selected catalog key' value='A' readonly>",
      "<output id='opens'>0</output><output id='commits'>0</output>",
      "<output id='stale-clicks'>0</output><output id='replacements'>0</output>",
      "<output id='early-clicks'>0</output><div id='mount'></div>",
      "<div role='dialog' aria-label='Catalog item picker' hidden>",
      "<input aria-label='Find catalog item'><div role='option' data-key='B'>B</div></div>",
      "<script>",
      "const mode = '" + mode + "';",
      "document.querySelector('[hidden] [role=option]').onclick = () => { document.querySelector('#stale-clicks').textContent++; };",
      "document.querySelector('#launcher').onclick = () => {",
      " document.querySelector('#opens').textContent++;",
      " setTimeout(() => {",
      "  const mount = document.querySelector('#mount');",
      "  mount.innerHTML = \"<div role='dialog' aria-label='Catalog item picker' data-query='old'><input aria-label='Find catalog item'><div role='option' data-key='B'>B</div></div>\";",
      "  const dialog = mount.querySelector('[role=dialog]');",
      "  dialog.onclick = (event) => {",
      "   const item = event.target.closest('[role=option]'); if (!item) return;",
      "   document.querySelector('#commits').textContent++;",
      "   if (dialog.dataset.query !== 'item b') document.querySelector('#early-clicks').textContent++;",
      "   if (mode !== 'no_commit') document.querySelector('[aria-label=\"Selected catalog key\"]').value = item.dataset.key;",
      "  };",
      "  dialog.querySelector('input').oninput = (event) => {",
      "   const current = event.target;",
      "   const replacement = current.cloneNode(); replacement.value = current.value;",
      "   current.replaceWith(replacement);",
      "   document.querySelector('#replacements').textContent++;",
      "   setTimeout(() => {",
      "    dialog.dataset.query = replacement.value;",
      "    dialog.querySelectorAll('[role=option]').forEach((item) => item.remove());",
      "    const count = mode === 'ambiguous' ? 2 : 1;",
      "    for (let i = 0; i < count; i++) {",
      "     const item = document.createElement('div'); item.setAttribute('role', 'option');",
      "     item.dataset.key = 'B'; item.textContent = 'B'; dialog.append(item);",
      "    }",
      "   }, 100);",
      "  };",
      " }, 70);",
      "};",
      "</script>",
    ].join(""),
  );
};

test("current-page example checks the site and reads without navigating, in one call", async ({
  page,
}) => {
  const siteOrigin = "https://invoices.example.test";
  let requests = 0;
  await page.route("**/*", async (route) => {
    requests += 1;
    await route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" });
  });
  await page.goto(`${siteOrigin}/account`);
  const read = await runExample(page, readHeading, {}, { siteOrigin });
  expect(read.result).toEqual(Either.right({ heading: "Invoices" }));
  expect(read.calls).toHaveLength(1);
  // A sibling subdomain is the same site, as after an entry redirect from flights. to invoices.
  const sibling = await runExample(
    page,
    readHeading,
    {},
    { siteOrigin: "https://flights.example.test" },
  );
  expect(sibling.result).toEqual(Either.right({ heading: "Invoices" }));
  // Another registrable domain, and one that is only a suffix of the host's text, are not.
  for (const other of ["https://another.example.invalid", "https://ample.test"]) {
    const read = await runExample(page, readHeading, {}, { siteOrigin: other });
    expect(failure(read.result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  }
  expect(requests).toBe(1);
  expect(page.url()).toBe(`${siteOrigin}/account`);
});

// The site is the host's registrable domain, never the last labels of the origin: a multi-label
// public suffix or another tenant's page on a private suffix is another site, and a site with no
// registrable domain is its exact origin alone.
for (const [siteOrigin, pageUrl, reads] of [
  ["https://shop.example.co.uk", "https://www.example.co.uk/account", true],
  ["https://shop.example.co.uk", "https://other.co.uk/account", false],
  ["https://alice.github.io", "https://bob.github.io/account", false],
  ["https://localhost", "https://localhost/account", true],
  ["https://localhost", "https://app.localhost/account", false],
] as const)
  test(`current-page example for ${siteOrigin} ${reads ? "reads" : "refuses"} ${pageUrl}`, async ({
    page,
  }) => {
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" }),
    );
    await page.goto(pageUrl);
    const { result } = await runExample(page, readHeading, {}, { siteOrigin });
    if (reads) expect(result).toEqual(Either.right({ heading: "Invoices" }));
    else expect(failure(result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  });

for (const clears of [true, false]) {
  test(`catalog example ${clears ? "waits past" : "reports"} a verification page without navigating again`, async ({
    page,
  }) => {
    const siteOrigin = "https://catalog.example.invalid";
    let requests = 0;
    await page.route(`${siteOrigin}/**`, async (route) => {
      requests += 1;
      const ready = new URL(route.request().url()).searchParams.has("verified");
      await route.fulfill({
        contentType: "text/html",
        body: ready
          ? "<h1>Catalog</h1>"
          : `<p>Verifying your browser</p>${clears ? '<script>setTimeout(() => location.replace("/catalog?verified=1"), 80)</script>' : ""}`,
      });
    });
    const { result, calls } = await runExample(
      page,
      readCatalog,
      {},
      { siteOrigin, deadlineMs: clears ? 10_000 : 1_500 },
    );
    expect(calls.filter((code) => code.includes("page.goto"))).toHaveLength(1);
    expect(requests).toBe(clears ? 2 : 1);
    if (clears) expect(result).toEqual(Either.right({ heading: "Catalog" }));
    else expect(Either.isLeft(result)).toBe(true);
  });
}

// A records site reached the way a person does: its entry page has a search box, the search lists
// matching records as links, or says none match, and each record opens behind its own
// interstitial. record_7's page belongs to another record, and record_5's link lands on another
// path. record_8's results load late behind a busy region, and a search for record_down fails.
const recordsSite = async (page: Page, origin: string) => {
  const opened: string[] = [];
  const searches: string[] = [];
  const records = ["record_42", "record_420", "record_7", "record_5", "record_8"];
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/favicon.ico") opened.push(url.pathname);
    const html = (body: string) => route.fulfill({ contentType: "text/html", body });
    if (url.pathname === "/")
      return html(`<form role="search" action="/search">
          <input type="search" name="q" aria-label="Record ID"><button>Search</button>
        </form>`);
    if (url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      searches.push(query);
      if (query === "record_down")
        return route.fulfill({
          status: 503,
          contentType: "text/html",
          body: `<div role="alert">Search is unavailable. Try again later.</div>`,
        });
      const found = records.filter((id) => id.includes(query));
      const listed =
        found.map((id) => `<a href="/records/${id}">${id}</a>`).join("") ||
        `<p role="status">No matching records</p>`;
      if (query === "record_8")
        return html(`<section role="region" aria-label="Search results" aria-busy="true"><p>Loading results</p></section>
          <script>setTimeout(() => {
            const results = document.querySelector("section");
            results.innerHTML = ${JSON.stringify(listed)};
            results.setAttribute("aria-busy", "false");
          }, 800)</script>`);
      return html(`<section role="region" aria-label="Search results">${listed}</section>`);
    }
    if (url.pathname === "/records/record_5")
      return html(`<script>location.replace("/records/archived")</script>`);
    const shown = url.pathname === "/records/record_7" ? "record_42" : url.pathname.slice(9);
    return html(`<section role="region" aria-label="Continue to record" data-record-id="${shown}">
        <button onclick="this.closest('section').outerHTML = '<section role=region aria-label=\\'Record details\\' data-record-id=${shown}><h1>Quarterly report</h1></section>'">Continue</button>
      </section>`);
  });
  return { opened, searches };
};

test("detail example searches the site for the record, follows its link and checks its identity", async ({
  page,
}) => {
  const origin = "https://records.example.invalid";
  const site = await recordsSite(page, origin);
  const read = async (record_id: string) => {
    const run = await runExample(page, detailNavigation, { record_id }, { siteOrigin: origin });
    // No call opens a URL holding the caller's input: the record's page comes from its link.
    for (const code of run.calls) expect(code).not.toContain(`/records/${record_id}`);
    return run.result;
  };
  expect(await read("record_42")).toEqual(
    Either.right({ record_id: "record_42", title: "Quarterly report" }),
  );
  expect(site.searches).toEqual(["record_42"]);
  expect(site.opened).toEqual(["/", "/search", "/records/record_42"]);
  expect(failure(await read("record_7"))).toMatchObject({
    _tag: "OperationFailure",
    message: "identity_mismatch",
  });
  // The final path is checked against the link's own href.
  expect(failure(await read("record_5"))).toMatchObject({
    _tag: "OperationFailure",
    message: "target_mismatch",
  });
  // The site's search says no record matches, so the caller's value is at fault.
  expect(failure(await read("record_9"))).toMatchObject({
    _tag: "InvalidInput",
    message: "The site's search lists no record with this ID",
  });
  // Results still loading, or a search that failed, say nothing about the caller's value.
  expect(await read("record_8")).toEqual(
    Either.right({ record_id: "record_8", title: "Quarterly report" }),
  );
  expect(failure(await read("record_down"))).toMatchObject({
    _tag: "OperationFailure",
    message: "results_unavailable",
  });
  expect(site.searches).toEqual([
    "record_42",
    "record_7",
    "record_5",
    "record_9",
    "record_8",
    "record_down",
  ]);
});

const siteOrigin = "https://members.example.test";
test("auth entry waits for an identifier-first sibling destination after one click", async ({
  page,
}, testInfo) => {
  const loginOrigin = "https://login.example.test";
  let entries = 0;
  let loginPages = 0;
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<nav aria-label="Members"><a href="/member/login">Log in</a></nav>`,
      });
    if (new URL(route.request().url()).origin === siteOrigin) {
      entries++;
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(`${loginOrigin}/member/login`)});</script>`,
      });
    }
    loginPages++;
    await route.fulfill({
      contentType: "text/html",
      body: `<div id="mount"></div><script>requestAnimationFrame(() => requestAnimationFrame(() => { document.querySelector('#mount').innerHTML = '<form aria-label="Member login"><label>Username<input type="text"></label><button>Continue</button></form>'; }));</script>`,
    });
  });
  await page.goto(siteOrigin);
  const { result } = await runExample(page, authEntry, {}, { siteOrigin, deadlineMs: 2000 });
  expect(result).toEqual(
    Either.right({
      origin: loginOrigin,
      pathname: "/member/login",
      controls: [
        { tag: "input", type: "text" },
        { tag: "button", type: "" },
      ],
      coverage: "observed_login_form",
    }),
  );
  expect(entries).toBe(1);
  expect(loginPages).toBe(1);
  await testInfo.attach("navigation-result", {
    body: JSON.stringify({ entries, loginPages, result }),
    contentType: "application/json",
  });
});

test("auth entry follows the observed link and reports controls without values", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    requests.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/"
          ? // The employer link and collapsed duplicates come first in document order.
            `<nav aria-label="Employers"><a href="/employer/login">Log in</a></nav>
             <nav aria-label="Members">
               <ul hidden><li><a href="/member/register">Log in</a></li></ul>
               <a href="/member/register" style="display:block;width:0;height:0;overflow:hidden">Log in</a>
               <a href="/member/login">Log in</a>
             </nav>`
          : `<form aria-label="Member login">
              <label>Username<input type="text" value="private-user"></label>
              <label>Password<input type="password" value="private-password"></label>
              <button type="submit">Sign in</button>
            </form>`,
    });
  });
  await page.goto(siteOrigin);
  const { result, calls } = await runExample(page, authEntry, {}, { siteOrigin });
  expect(result).toEqual(
    Either.right({
      origin: siteOrigin,
      pathname: "/member/login",
      controls: [
        { tag: "input", type: "text" },
        { tag: "input", type: "password" },
        { tag: "button", type: "submit" },
      ],
      coverage: "observed_login_form",
    }),
  );
  expect(calls).toHaveLength(1);
  expect(requests).toEqual([`GET ${siteOrigin}/`, `GET ${siteOrigin}/member/login`]);
  expect(JSON.stringify(result)).not.toContain("private-");
});

// The site's entry redirected to www., a sibling of the authorized origin: still the site.
test("auth entry starts from a sibling subdomain of the site", async ({ page }) => {
  const sibling = "https://www.example.test";
  await page.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/"
          ? '<nav aria-label="Members"><a href="/member/login">Log in</a></nav>'
          : '<form aria-label="Member login"><label>Username<input type="text"></label></form>',
    });
  });
  await page.goto(sibling);
  const { result } = await runExample(page, authEntry, {}, { siteOrigin });
  expect(result).toEqual(
    Either.right({
      origin: sibling,
      pathname: "/member/login",
      controls: [{ tag: "input", type: "text" }],
      coverage: "observed_login_form",
    }),
  );
});

for (const entry of ["absent", "ambiguous", "wrong-path", "other-site"] as const)
  test(`auth entry rejects ${entry} evidence without navigating`, async ({ page }) => {
    const markup = {
      absent: '<nav aria-label="Employers"><a href="/member/login">Log in</a></nav>',
      ambiguous:
        '<nav aria-label="Members"><a href="/member/login">Log in</a><a href="/member/login">Log in</a></nav>',
      "wrong-path": '<nav aria-label="Members"><a href="/member/register">Log in</a></nav>',
      "other-site": '<nav aria-label="Members"><a href="/member/login">Log in</a></nav>',
    };
    let requests = 0;
    await page.route("**/*", async (route) => {
      requests += 1;
      await route.fulfill({ contentType: "text/html", body: markup[entry] });
    });
    const start = entry === "other-site" ? "https://unexpected.example.invalid" : siteOrigin;
    await page.goto(start);
    const { result } = await runExample(page, authEntry, {}, { siteOrigin });
    expect(failure(result)).toMatchObject({ _tag: "OperationFailure" });
    expect(page.url()).toBe(`${start}/`);
    expect(requests).toBe(1);
  });

test("native select example selects a canonical value and reads it back", async ({ page }) => {
  await page.setContent(
    '<label for="status">Invoice status</label><select id="status" onchange="document.querySelector(\'output\').textContent++"><option value="open">Open</option><option value="paid">Paid</option></select><output>0</output>',
  );
  expect((await runExample(page, selectStatus, { status: "paid" })).result).toEqual(
    Either.right({ status: "paid" }),
  );
  await expect(page.locator("output")).toHaveText("1");
});

test("date and dropdown example fills a split date and a custom dropdown by label", async ({
  page,
}) => {
  const months = ["January", "February", "March", "April", "May", "June", "July"];
  await page.setContent(`
    <form role="search" aria-label="Find departures">
      <select name="month" aria-label="Month"><option value="">Month</option>${months.map((month, index) => `<option value="${index}">${month}</option>`).join("")}</select>
      <select name="day" aria-label="Day">${Array.from({ length: 31 }, (_, index) => `<option>${index + 1}</option>`).join("")}</select>
      <input name="year" aria-label="Year">
      <input role="combobox" aria-label="Cabin" readonly aria-expanded="false" aria-controls="cabins" name="cabin">
      <ul role="listbox" id="cabins" hidden><li role="option">Economy</li><li role="option">Business class</li></ul>
    </form>
    <script>
      const cabin = document.querySelector("[aria-label=Cabin]"); const list = document.querySelector("#cabins");
      cabin.onclick = () => { list.hidden = false; cabin.setAttribute("aria-expanded", "true"); };
      list.onclick = (event) => { cabin.value = event.target.textContent; list.hidden = true; cabin.setAttribute("aria-expanded", "false"); };
    </script>`);
  const form = () => page.evaluate(() => Object.fromEntries(new FormData(document.forms[0])));
  expect(
    (await runExample(page, setDeparture, { date: "2027-07-09", cabin: "business" })).result,
  ).toEqual(Either.right({ date: "2027-07-09", cabin: "business" }));
  expect(await form()).toEqual({ month: "6", day: "9", year: "2027", cabin: "Business class" });
  // A month the dropdown does not offer is refused before anything else changes.
  expect(
    failure(
      (await runExample(page, setDeparture, { date: "2027-08-01", cabin: "economy" })).result,
    ),
  ).toMatchObject({ _tag: "OperationFailure", message: "option_missing", dispatch: "not_sent" });
  expect(await form()).toEqual({ month: "6", day: "9", year: "2027", cabin: "Business class" });
});

test("ARIA listbox example waits for this query's delayed options and reads the committed choice", async ({
  page,
}) => {
  await page.setContent(`
    <input role="combobox" aria-label="Airport" aria-expanded="false" aria-controls="choices">
    <output role="status" aria-label="Selected airport" id="selected">A</output><output id="commits">0</output>
    <ul role="listbox" id="unrelated"><li role="option" data-key="B" onclick="throw Error('wrong popup')">Wrong</li></ul>
    <ul role="listbox" id="choices" data-query="old" style="display:none;min-height:20px"><li role="option" data-key="B">Stale B</li></ul>
    <script>
      const control = document.querySelector("input"); const popup = document.querySelector("#choices");
      control.onclick = () => { control.setAttribute("aria-expanded", "true"); popup.style.display = "block"; };
      control.oninput = () => setTimeout(() => {
        popup.innerHTML = '<li role="option" data-key="B">Airport B</li><li role="option" data-key="C">Airport C</li>';
        popup.dataset.query = control.value;
      }, 150);
      popup.onclick = (event) => {
        const key = event.target.dataset.key; if (!key) return;
        document.querySelector("#commits").textContent++;
        popup.setAttribute("data-query-at-commit", popup.dataset.query);
        control.setAttribute("aria-label", "Selected airport " + key);
        document.querySelector("#selected").textContent = key;
      };
    </script>`);
  expect((await runExample(page, chooseAirport, { code: "B", query: "airport b" })).result).toEqual(
    Either.right({ code: "B" }),
  );
  await expect(page.locator("#choices")).toHaveAttribute("data-query-at-commit", "airport b");
  await expect(page.locator("#commits")).toHaveText("1");
});

test("dialog picker waits for fresh choices and commits exactly once", async ({ page }) => {
  await dialogPickerFixture(page, "success");
  const { result, calls } = await runExample(page, dialogPicker, { query: "item b", key: "B" });
  expect(result).toEqual(Either.right({ selected_key: "B" }));
  expect(calls).toHaveLength(1);
  await expect(page.locator("#opens")).toHaveText("1");
  await expect(page.locator("#commits")).toHaveText("1");
  await expect(page.locator("#stale-clicks")).toHaveText("0");
  await expect(page.locator("#early-clicks")).toHaveText("0");
  await expect(page.getByRole("textbox", { name: "Selected catalog key" })).toHaveValue("B");
});

for (const mode of ["ambiguous", "no_commit"] as const)
  test(`dialog picker ${mode} fails without clicking again`, async ({ page }) => {
    await dialogPickerFixture(page, mode);
    const { result } = await runExample(
      page,
      dialogPicker,
      { query: "item b", key: "B" },
      { deadlineMs: 1_500 },
    );
    expect(Either.isLeft(result)).toBe(true);
    await expect(page.locator("#opens")).toHaveText("1");
    await expect(page.locator("#commits")).toHaveText(mode === "no_commit" ? "1" : "0");
    await expect(page.getByRole("textbox", { name: "Selected catalog key" })).toHaveValue("A");
  });

for (const confirmation of ["saved", "missing", "stale-id"] as const)
  test(`write example submits once and waits for its own response: ${confirmation}`, async ({
    page,
  }) => {
    const origin = "https://tasks.example.invalid";
    const requested = { title: "Review draft", assignee: "demo-user" };
    let submissions = 0;
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        submissions += 1;
        await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
        return;
      }
      if (request.url() === `${origin}/tasks/new`) {
        await route.fulfill({
          contentType: "text/html",
          body: `<form aria-label="New task" method="post" action="/tasks">
            <label>Title<input name="title"></label><label>Assignee<input name="assignee"></label>
            <button>Create task</button>
          </form><script>
            document.querySelector("form").addEventListener("submit", async (event) => {
              event.preventDefault();
              const response = await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
              location.href = response.headers.get("location");
            });
          </script>`,
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body:
          confirmation === "missing"
            ? "<p>Task saved</p>"
            : `<section role="region" aria-label="Saved task">
                <label>Task ID<input readonly value="${confirmation === "stale-id" ? "old-task" : "task-123"}"></label>
                <label>Title<input readonly value="${requested.title}"></label>
                <label>Assignee<input readonly value="${requested.assignee}"></label>
              </section>`,
      });
    });
    await page.goto(`${origin}/tasks/new`);
    const { result, calls, effect, ...recorded } = await runExample(page, createTask, requested, {
      siteOrigin: origin,
    });
    expect(submissions).toBe(1);
    expect(calls).toHaveLength(1);
    expect(createTask.write).toEqual({ confirmation: "readback", commits: ["create-task"] });
    // Only the matched read-back records the write as landed, and as a read-back; the one
    // submission entered its commit mark either way.
    expect({ effect, ...recorded }).toEqual(
      confirmation === "saved"
        ? {
            effect: "verified",
            confirmation: "readback",
            commits: [{ name: "create-task", state: "confirmed" }],
          }
        : {
            effect: "may_have_dispatched",
            confirmation: undefined,
            commits: [{ name: "create-task", state: "sent" }],
          },
    );
    if (confirmation === "saved")
      expect(result).toEqual(Either.right({ id: "task-123", ...requested }));
    else expect(failure(result)).toMatchObject({ _tag: "OperationFailure", dispatch: "sent" });
  });

test("write example waits for a delayed submit control and its own receipt before returning", async ({
  page,
}) => {
  test.setTimeout(30_000);
  test.info().annotations.push({
    type: "slow",
    description: "The controlled twelve-second submit delay reproduces the old receipt/write race.",
  });
  const origin = "https://tasks.example.invalid";
  const requested = { title: "Review draft", assignee: "demo-user" };
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body:
        route.request().url() === `${origin}/tasks/new`
          ? `<form aria-label="New task" method="post" action="/tasks">
              <label>Title<input name="title"></label><label>Assignee<input name="assignee"></label>
              <button disabled>Create task</button>
            </form><script>
              setTimeout(() => { document.querySelector("button").disabled = false; }, 12000);
              document.querySelector("form").addEventListener("submit", async (event) => {
                event.preventDefault();
                const response = await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
                location.href = response.headers.get("location");
              });
            </script>`
          : `<section role="region" aria-label="Saved task">
              <label>Task ID<input readonly value="task-123"></label>
              <label>Title<input readonly value="${requested.title}"></label>
              <label>Assignee<input readonly value="${requested.assignee}"></label>
            </section>`,
    });
  });
  await page.goto(`${origin}/tasks/new`);
  const { result, calls } = await runExample(page, createTask, requested, {
    siteOrigin: origin,
    deadlineMs: 25_000,
  });
  expect(result).toEqual(Either.right({ id: "task-123", ...requested }));
  expect(submissions).toBe(1);
  expect(calls).toHaveLength(1);
});

// Delayed fields and a submit that enables only after the call ended reproduce a write firing
// after the call expired. A 4 s deadline scales every bound the example derives from
// remainingMs, so the race plays out in about three seconds instead of sixty-five.
test("write example settles a delayed submit before its outer call expires", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "The example's smallest safe call is three seconds, and the submit enables only after it ends.",
  });
  const origin = "https://tasks.example.invalid";
  const requested = { title: "Review draft", assignee: "demo-user" };
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<form aria-label="New task" method="post" action="/tasks">
          <span id="title"></span><span id="assignee"></span><button disabled>Create task</button>
        </form><script>
          setTimeout(() => { document.querySelector("#title").innerHTML = '<label>Title<input name="title"></label>'; }, 50);
          setTimeout(() => { document.querySelector("#assignee").innerHTML = '<label>Assignee<input name="assignee"></label>'; }, 100);
          setTimeout(() => { document.querySelector("button").disabled = false; }, 2800);
          document.querySelector("form").addEventListener("submit", async (event) => {
            event.preventDefault();
            await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
          });
        </script>`,
    });
  });
  await page.goto(`${origin}/tasks/new`);
  const submitEnablesAt = Date.now() + 2_800;
  const { result } = await runExample(page, createTask, requested, {
    siteOrigin: origin,
    deadlineMs: 4_000,
  });
  expect(Either.isLeft(result)).toBe(true);
  expect(submissions).toBe(0);
  // 1.5 s past the moment the submit enables: a click left pending would have posted by now.
  await page.waitForTimeout(Math.max(0, submitEnablesAt + 1_500 - Date.now()));
  expect(submissions).toBe(0);
});

/** The checkout the write-session example was written against: fill, review, place, confirm. */
const checkoutSite = async (page: Page, origin: string, orders: string[]) => {
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/checkout")
      return route.fulfill({
        contentType: "text/html",
        body: `<form aria-label="Checkout" method="get" action="/checkout/review">
          <label>Item<input name="item"></label><label>Quantity<input name="quantity"></label>
          <label><input type="checkbox" name="giftWrap"> Gift wrap</label><button>Continue</button>
        </form>`,
      });
    if (url.pathname === "/checkout/review")
      return route.fulfill({
        contentType: "text/html",
        body: `<form method="post" action="/orders"><input type="hidden" name="item" value="${url.searchParams.get("item") ?? ""}"><button>Place order</button></form>`,
      });
    // The site answers the order's own POST with its confirmation.
    if (url.pathname === "/orders" && request.method() === "POST") {
      orders.push(new URLSearchParams(request.postData() ?? "").get("item") ?? "");
      return route.fulfill({
        contentType: "text/html",
        body: `<p role="status" aria-label="Order confirmation">Order ORD-${1000 + orders.length} is placed.</p>`,
      });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });
};

test("write-session example commits once across its act steps and reads the site's confirmation back", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "lamp", quantity: 2, gift_wrap: false };
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const filled = await runExample(page, fillStep, input, { siteOrigin: origin });
  expect(filled).toMatchObject({
    result: Either.right({ review_shown: true }),
    confirmation: undefined,
  });
  expect(orders).toEqual([]);
  // The next step continues on the review page the first one left.
  const placed = await runExample(page, placeStep, input, { siteOrigin: origin });
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    effect: "verified",
    confirmation: "readback",
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp"]);
  // The composed script runs the same calls from a blank page and declares its confirmation.
  expect(placeOrder.write).toEqual({ confirmation: "readback", commits: ["place-order"] });
  await page.goto("about:blank");
  const composed = await runExample(page, placeOrder, input, { siteOrigin: origin });
  expect(composed).toMatchObject({ confirmation: "readback", effect: "verified" });
  expect(orders).toEqual(["lamp", "lamp"]);
});

/** A write that saves an address, then places an order, each its own marked commit step. */
const markedWrite = (placeOrder: "click" | "refused") =>
  defineOperation(
    {
      name: "place_order",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message", commits: ["save-address", "place-order"] },
    },
    async ({ kernel, sessionId, enteringCommit, verified, errors }) => {
      enteringCommit("save-address");
      await kernel.browsers.playwright.execute(sessionId, { code: 'await page.click("#save");' });
      // A check that refuses the order stops the step before its commit is marked.
      if (placeOrder === "refused")
        throw new errors.OperationFailure("order total changed", { dispatch: "not_sent" });
      enteringCommit("place-order");
      await kernel.browsers.playwright.execute(sessionId, { code: 'await page.click("#place");' });
      verified({ confirmation: "message" });
      return {};
    },
  );

test("a write's commit marks read not_sent until their call runs, then sent, then confirmed", async ({
  page,
}) => {
  await page.setContent(
    "<button id='save' onclick=\"document.querySelector('#saved').textContent++\">Save address</button>" +
      "<button id='place' onclick=\"document.querySelector('#placed').textContent++\">Place order</button>" +
      "<output id='saved'>0</output><output id='placed'>0</output>",
  );
  const refused = await runExample(page, markedWrite("refused"), {});
  expect(failure(refused.result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  expect(refused.commits).toEqual([
    { name: "save-address", state: "sent" },
    { name: "place-order", state: "not_sent" },
  ]);
  await expect(page.locator("#placed")).toHaveText("0");
  const placed = await runExample(page, markedWrite("click"), {});
  expect(placed).toMatchObject({ result: Either.right({}), effect: "verified" });
  expect(placed.commits).toEqual([
    { name: "save-address", state: "confirmed" },
    { name: "place-order", state: "confirmed" },
  ]);
  await expect(page.locator("#placed")).toHaveText("1");
});

test("a commit mark the script never declared is still reported once entered", async ({ page }) => {
  const undeclared = defineOperation(
    {
      name: "confirm_booking",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message" },
    },
    async ({ enteringCommit }) => {
      enteringCommit("confirm-booking");
      return {};
    },
  );
  expect((await runExample(page, undeclared, {})).commits).toEqual([
    { name: "confirm-booking", state: "sent" },
  ]);
});

/** A write that proves its effect, then optionally makes one more browser call. */
const provingWrite = (
  write: { readonly confirmation: "message" | "readback" | "unverifiable" },
  after: "return" | "another_call",
) =>
  defineOperation(
    { name: "proving_write", input: Schema.Struct({}), output: Schema.Struct({}), write },
    async ({ kernel, sessionId, verified }) => {
      verified(write.confirmation === "message" ? { confirmation: "message" } : undefined);
      if (after === "another_call")
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
      return {};
    },
  );

test("verified records the write's proof, a later call reopens it, and unverifiable refuses it", async ({
  page,
}) => {
  expect(
    await runExample(page, provingWrite({ confirmation: "message" }, "return"), {}),
  ).toMatchObject({
    result: Either.right({}),
    effect: "verified",
    confirmation: "message",
  });
  expect(
    await runExample(page, provingWrite({ confirmation: "readback" }, "return"), {}),
  ).toMatchObject({
    effect: "verified",
    confirmation: "readback",
  });
  expect(
    await runExample(page, provingWrite({ confirmation: "readback" }, "another_call"), {}),
  ).toMatchObject({
    result: Either.right({}),
    effect: "may_have_dispatched",
    confirmation: undefined,
  });
  const refused = await runExample(
    page,
    provingWrite({ confirmation: "unverifiable" }, "return"),
    {},
  );
  expect(failure(refused.result)).toMatchObject({
    _tag: "WriteConfirmationRefused",
    recorded: "readback",
  });
  expect(refused.confirmation).toBeUndefined();
});

test("a call after verified turns a confirmed commit mark back to sent", async ({ page }) => {
  const reopened = defineOperation(
    {
      name: "place_order",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message", commits: ["place-order"] },
    },
    async ({ kernel, sessionId, enteringCommit, verified }) => {
      enteringCommit("place-order");
      verified({ confirmation: "message" });
      await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
      return {};
    },
  );
  expect(await runExample(page, reopened, {})).toMatchObject({
    effect: "may_have_dispatched",
    confirmation: undefined,
    commits: [{ name: "place-order", state: "sent" }],
  });
});

const table = (id: string) =>
  `<table aria-label="Invoices"><tbody><tr data-invoice-id="${id}"><td>Old layout</td></tr></tbody></table>`;
const cards = (id: string) =>
  `<ul aria-label="Invoices"><li data-invoice-id="${id}">New layout</li></ul>`;
for (const fixture of [
  { name: "old layout", html: table("invoice_137"), ids: ["invoice_137"] },
  { name: "new layout", html: cards("invoice_982"), ids: ["invoice_982"] },
  {
    name: "ambiguous layouts",
    html: table("invoice_137") + cards("invoice_982"),
    reason: "ambiguous",
  },
  { name: "unsupported page", html: "<main>No invoices</main>", reason: "unsupported" },
  {
    name: "loading state",
    html: '<div role="progressbar"></div>' + cards("invoice_982"),
    reason: "loading",
  },
  {
    name: "identity mismatch",
    html: table("invoice_137") + table("invoice_463"),
    reason: "identity_mismatch",
  },
])
  test(`variant example chooses a layout from one observation: ${fixture.name}`, async ({
    page,
  }) => {
    await page.setContent(fixture.html);
    const { result } = await runExample(page, readInvoiceIds, {});
    if (fixture.ids) expect(result).toEqual(Either.right({ ids: fixture.ids }));
    else
      expect(failure(result)).toMatchObject({ _tag: "OperationFailure", message: fixture.reason });
  });

test("calendar example moves to the requested month and reads the committed date", async ({
  page,
}) => {
  await page.setContent(`
    <input aria-label="Travel date" readonly>
    <div role="dialog" aria-label="Choose date" hidden>
      <button>Previous month</button><button>Next month</button><div id="panel"></div>
    </div>
    <script>
      let month = 9;
      const render = () => {
        const id = "2026-" + String(month).padStart(2, "0");
        document.querySelector("#panel").innerHTML = '<section data-month="' + id + '">' +
          [1, 15].map((day) => '<button data-date="' + id + "-" + String(day).padStart(2, "0") + '">' + day + "</button>").join("") + "</section>";
      };
      render();
      document.querySelector("input").onclick = () => { document.querySelector("[role=dialog]").hidden = false; };
      document.querySelector("[role=dialog]").onclick = (event) => {
        const target = event.target;
        if (target.textContent === "Next month") { month++; render(); }
        else if (target.textContent === "Previous month") { month--; render(); }
        else if (target.dataset.date) document.querySelector("input").value = target.dataset.date;
      };
    </script>`);
  expect((await runExample(page, pickTravelDate, { date: "2026-11-15" })).result).toEqual(
    Either.right({ date: "2026-11-15" }),
  );
  expect(
    failure((await runExample(page, pickTravelDate, { date: "2026-11-03" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "day_ambiguous" });
});

test("upload example decodes base64 in the call and reads back the chosen file", async ({
  page,
}) => {
  await page.setContent('<label>Documents<input type="file"></label>');
  const contentBase64 = Buffer.from("synthetic report").toString("base64");
  const input = { name: "report.txt", mime_type: "text/plain", content_base64: contentBase64 };
  expect((await runExample(page, attachDocument, input)).result).toEqual(
    Either.right({ name: "report.txt", size: 16 }),
  );
  expect(failure((await runExample(page, attachDocument, input)).result)).toMatchObject({
    _tag: "OperationFailure",
    message: "already_selected",
  });
});

test("dialog example keeps the confirm open for the host and applies accept in the next call", async ({
  page,
}) => {
  await page.setContent(`<table><tr><td>INV-7</td><td>
        <button onclick="if (confirm('Delete invoice INV-7?')) this.closest('tr').remove()">Delete</button>
      </td></tr></table>`);
  const asked: unknown[] = [];
  const { result, calls } = await runExample(
    page,
    deleteInvoice,
    { invoice_id: "INV-7" },
    {
      dialogs: ({ interactionId: _id, ...report }) =>
        Effect.sync(() => {
          asked.push(report);
          return { choice: "accept" as const };
        }),
    },
  );
  expect(result).toEqual(Either.right({ deleted: true }));
  expect(asked).toEqual([
    {
      step: "delete-invoice",
      type: "confirm",
      message: "Delete invoice INV-7?",
      url: "about:blank",
    },
  ]);
  expect(calls).toHaveLength(2);
  await expect(page.getByRole("row")).toHaveCount(0);
});
