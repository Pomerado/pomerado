import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AutofillSignedIn } from "../../src/destinations/autofill-step.js";
import { makeMarkerChecks } from "../../src/standalone/signed-in-marker.js";

const origin = "https://www.shop.test";

/**
 * A primary tab on a modeled site: `shows` lists the paths whose page shows the marker. It
 * records each address the host loaded, by the live check's `openPath` or a host call's goto.
 */
const modeledTab = (options: { readonly at: string; readonly shows: readonly string[] }) => {
  let current = new URL(options.at, origin).href;
  const loads: string[] = [];
  let snapshots = 0;
  const open = (url: string) => {
    current = url;
    const loaded = new URL(url);
    loads.push(`${loaded.pathname}${loaded.search}`);
  };
  const page = {
    targetId: "primary",
    execute: (code: string) =>
      Effect.sync((): unknown => {
        const goto = /primary\.goto\(("[^"]*")/u.exec(code)?.[1];
        if (goto !== undefined) {
          open(JSON.parse(goto) as string);
          return current;
        }
        if (code.includes("outerHTML")) {
          snapshots += 1;
          return { url: current, dom: "<!doctype html><html><body><p>Shop</p></body></html>" };
        }
        throw new Error("Unexpected host call");
      }),
  };
  const check = (indicator: AutofillSignedIn) =>
    Effect.sync(() => {
      if (indicator.openPath !== undefined) open(new URL(indicator.openPath, origin).href);
      const path = new URL(current).pathname;
      return options.shows.includes(path)
        ? { signedIn: true as const, url: current }
        : { signedIn: false as const, failed: "indicator_not_visible" as const, url: current };
    });
  return {
    page,
    check,
    loads,
    get snapshots() {
      return snapshots;
    },
    get where() {
      const url = new URL(current);
      return `${url.pathname}${url.search}`;
    },
  };
};

/**
 * The marker checks on `tab`, with the build's login sent unless `state` says otherwise, and
 * nothing typed in the session unless `typing` says otherwise.
 */
const markerChecks = (
  tab: ReturnType<typeof modeledTab>,
  state: { loginSent: boolean; writeSessionStarted?: boolean } = { loginSent: true },
  typing = { typed: false },
) =>
  makeMarkerChecks({
    page: tab.page,
    siteOrigin: origin,
    check: tab.check,
    typing,
    loginSent: () => state.loginSent,
    writeSessionStarted: () => state.writeSessionStarted === true,
  });

const accountMarker = { selector: "#account", openPath: "/account" };

describe("makeMarkerChecks", () => {
  it("loads the newest other page explored once the login was sent, then returns the tab", async () => {
    const tab = modeledTab({ at: "/account", shows: ["/account"] });
    const state = { loginSent: false };
    const markers = markerChecks(tab, state);
    // Before the login was sent, a page proves nothing about the account.
    markers.explored(`${origin}/help`);
    state.loginSent = true;
    markers.explored(`${origin}/search?q=lamp`);
    markers.explored(`${origin}/account`);
    const checked = await Effect.runPromise(markers.check(accountMarker));
    expect(checked).toEqual({
      signedOutSnapshot: "unchecked",
      signedInNow: true,
      freshLoad: true,
      secondPage: false,
    });
    expect(tab.loads).toEqual(["/account", "/search?q=lamp", "/account"]);
    expect(tab.where).toBe("/account");
  });

  it("forgets the pages explored before a later sign-in step, such as a code screen", async () => {
    const tab = modeledTab({ at: "/account", shows: ["/account"] });
    const markers = markerChecks(tab);
    markers.explored(`${origin}/sign-in/code`);
    markers.signInStep();
    markers.explored(`${origin}/account`);
    const checked = await Effect.runPromise(markers.check(accountMarker));
    expect(checked).not.toHaveProperty("secondPage");
    expect(tab.loads).toEqual(["/account"]);
  });

  it("loads no second page while the agent's page lacks the marker", async () => {
    const tab = modeledTab({ at: "/sign-in/code", shows: ["/account"] });
    const markers = markerChecks(tab);
    markers.explored(`${origin}/search`);
    markers.explored(`${origin}/sign-in/code`);
    const checked = await Effect.runPromise(markers.check(accountMarker));
    expect(checked).toEqual({
      signedOutSnapshot: "unchecked",
      signedInNow: false,
      freshLoad: true,
    });
    expect(tab.loads).not.toContain("/search");
  });

  it("never takes the agent's own page or the page loaded fresh as the second page", async () => {
    const tab = modeledTab({ at: "/orders", shows: ["/account", "/orders"] });
    const markers = markerChecks(tab);
    markers.explored(`${origin}/search`);
    markers.explored(`${origin}/account`);
    markers.explored(`${origin}/orders`);
    await Effect.runPromise(markers.check(accountMarker));
    expect(tab.loads).toEqual(["/account", "/search", "/orders"]);
  });

  it("keeps the page before typing only while the host typed no sign-in value in the session", async () => {
    const fresh = modeledTab({ at: "/login", shows: ["/account"] });
    const first = markerChecks(fresh);
    await Effect.runPromise(first.beforeTyping);
    // Only the build's first sign-in screen's page is kept.
    await Effect.runPromise(first.beforeTyping);
    expect(fresh.snapshots).toBe(1);
    expect(await Effect.runPromise(first.check(accountMarker))).toHaveProperty(
      "signedOutSnapshot",
      "absent",
    );
    // An earlier build typed into this session's browser, so its page may be signed in.
    const typed = modeledTab({ at: "/login", shows: ["/account"] });
    const later = markerChecks(typed, { loginSent: true }, { typed: true });
    await Effect.runPromise(later.beforeTyping);
    expect(typed.snapshots).toBe(0);
    expect(await Effect.runPromise(later.check(accountMarker))).toHaveProperty(
      "signedOutSnapshot",
      "unchecked",
    );
  });

  it("loads no page once the write session started", async () => {
    const tab = modeledTab({ at: "/account", shows: ["/account"] });
    const markers = markerChecks(tab, { loginSent: true, writeSessionStarted: true });
    markers.explored(`${origin}/search`);
    const checked = await Effect.runPromise(Effect.either(markers.check(accountMarker)));
    expect(checked).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
    expect(tab.loads).toEqual([]);
  });

  it("loads openPath, or else the site's root, as the fresh page", async () => {
    const tab = modeledTab({ at: "/account", shows: ["/account"] });
    const markers = markerChecks(tab);
    const checked = await Effect.runPromise(
      markers.check({ selector: "#account", urlPath: "/account" }),
    );
    // The root is not the marker's path, as a run's reset finds it.
    expect(checked).toMatchObject({ signedInNow: true, freshLoad: false });
    expect(tab.loads[0]).toBe("/");
  });
});
