import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AutofillSignedIn } from "../../src/destinations/autofill-step.js";
import { makeMarkerChecks } from "../../src/standalone/signed-in-marker.js";

const origin = "https://www.shop.test";

/**
 * A primary tab on a modeled site: `shows` lists the paths whose page shows the marker, and
 * `formAnswer` says the page it starts on answered a form directly. Its signed-out pages settle
 * before the host reads them, unless `settled` is false. It records each address the host
 * loaded, by the live check's `openPath` or a host call's goto, which fails once `failGoto` is
 * set.
 */
const modeledTab = (options: {
  readonly at: string;
  readonly shows: readonly string[];
  readonly formAnswer?: boolean;
  readonly failGoto?: boolean;
  readonly settled?: boolean;
}) => {
  let current = new URL(options.at, origin).href;
  const loads: string[] = [];
  let snapshots = 0;
  let observed = 0;
  const open = (url: string) => {
    current = url;
    const loaded = new URL(url);
    loads.push(`${loaded.pathname}${loaded.search}`);
  };
  const page = {
    targetId: "primary",
    execute: (code: string) =>
      Effect.suspend((): Effect.Effect<unknown, Error> => {
        const goto = /primary\.goto\(("[^"]*")/u.exec(code)?.[1];
        if (goto !== undefined && options.failGoto === true)
          return Effect.fail(new Error("Navigation failed"));
        return Effect.sync((): unknown => {
          if (goto !== undefined) {
            open(JSON.parse(goto) as string);
            return current;
          }
          if (code.includes("getNavigationHistory")) return options.formAnswer === true;
          if (code.includes("outerHTML")) {
            snapshots += 1;
            return {
              url: current,
              dom: "<!doctype html><html><body><p>Shop</p></body></html>",
              settled: options.settled ?? true,
            };
          }
          throw new Error("Unexpected host call");
        });
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
    observe: Effect.sync(() => {
      observed += 1;
    }),
    get observed() {
      return observed;
    },
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
    observe: tab.observe,
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

  it("counts a signed-out page the host never saw settle only when it shows the marker", async () => {
    const tab = modeledTab({ at: "/", shows: ["/account"], settled: false });
    const markers = markerChecks(tab);
    await Effect.runPromise(markers.afterClear);
    expect(tab.snapshots).toBe(1);
    // The page may have shown more after the host read it, so it proves no marker absent.
    expect(await Effect.runPromise(markers.check(accountMarker))).toHaveProperty(
      "signedOutSnapshot",
      "unchecked",
    );
    // What it showed, it showed signed out.
    const shown = { selector: "p", openPath: "/account" };
    expect(markers.signedOutShows(shown)).toBe(true);
    expect(await Effect.runPromise(markers.check(shown))).toHaveProperty(
      "signedOutSnapshot",
      "matches",
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

  it("returns the tab only to a page that showed the marker and did not answer a form", async () => {
    // A code screen shows no marker, so its address is never loaded again.
    const code = modeledTab({ at: "/sign-in/code", shows: ["/account"] });
    await Effect.runPromise(markerChecks(code).check(accountMarker));
    expect(code.loads).toEqual(["/account"]);
    expect(code.where).toBe("/account");
    // The direct answer to a form, which its address alone would not load again.
    const answer = modeledTab({ at: "/orders", shows: ["/account", "/orders"], formAnswer: true });
    await Effect.runPromise(markerChecks(answer).check(accountMarker));
    expect(answer.loads).toEqual(["/account"]);
    expect(answer.where).toBe("/account");
    // Either way the next review reads the page the tab shows.
    expect([code.observed, answer.observed]).toEqual([1, 1]);
  });

  it("fails the check when the agent's page does not open again", async () => {
    const tab = modeledTab({ at: "/orders", shows: ["/account", "/orders"], failGoto: true });
    const checked = await Effect.runPromise(Effect.either(markerChecks(tab).check(accountMarker)));
    expect(checked).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
    expect(tab.observed).toBe(1);
  });
});
