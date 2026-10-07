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
        if (code.includes("outerHTML"))
          return { url: current, dom: "<!doctype html><html></html>" };
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
    get where() {
      const url = new URL(current);
      return `${url.pathname}${url.search}`;
    },
  };
};

/** The marker checks on `tab`, with the build's login sent unless `loginSent` says otherwise. */
const markerChecks = (
  tab: ReturnType<typeof modeledTab>,
  state: { loginSent: boolean } = { loginSent: true },
) =>
  makeMarkerChecks({
    page: tab.page,
    siteOrigin: origin,
    check: tab.check,
    signedIn: () => false,
    loginSent: () => state.loginSent,
  });

const accountMarker = { selector: "#account", openPath: "/account" };

describe("makeMarkerChecks", () => {
  it("loads the newest other page visited once the login was sent, then returns the tab", async () => {
    const tab = modeledTab({ at: "/account", shows: ["/account"] });
    const state = { loginSent: false };
    const markers = markerChecks(tab, state);
    // Before the login was sent, a page proves nothing about the account.
    markers.visited(`${origin}/help`);
    state.loginSent = true;
    markers.visited(`${origin}/search?q=lamp`);
    markers.visited(`${origin}/account`);
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

  it("forgets the pages visited before a later sign-in step, such as a code screen", async () => {
    const tab = modeledTab({ at: "/account", shows: ["/account"] });
    const markers = markerChecks(tab);
    markers.visited(`${origin}/sign-in/code`);
    markers.signInStep();
    markers.visited(`${origin}/account`);
    const checked = await Effect.runPromise(markers.check(accountMarker));
    expect(checked).not.toHaveProperty("secondPage");
    expect(tab.loads).toEqual(["/account"]);
  });

  it("loads no second page while the agent's page lacks the marker", async () => {
    const tab = modeledTab({ at: "/sign-in/code", shows: ["/account"] });
    const markers = markerChecks(tab);
    markers.visited(`${origin}/search`);
    markers.visited(`${origin}/sign-in/code`);
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
    markers.visited(`${origin}/search`);
    markers.visited(`${origin}/account`);
    markers.visited(`${origin}/orders`);
    await Effect.runPromise(markers.check(accountMarker));
    expect(tab.loads).toEqual(["/account", "/search", "/orders"]);
  });
});
