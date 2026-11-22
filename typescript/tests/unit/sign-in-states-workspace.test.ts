import { Data, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { AutofillInspection, AutofillSignedInCheck } from "../../src/destinations/autofill-step.js";
import {
  appendSignInStates,
  type ObservedState,
  type SignInStates,
  signInStatesOf,
} from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { workspaceHost } from "../../src/runtime/workspace-origin.js";

// A sign-in replayed from a library of states whose header names a workspace, on a synthetic
// workspace SaaS: the identifier state is on the shared host app.example.com, and the site then
// sends each account to its own workspace host for the password (acme. or globex.), a state
// recorded on `workspace`. Every host is synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.com";
const acme = "https://acme.example.com";
const globex = "https://globex.example.com";
const parent = "example.com";
const password = "synthetic-password";
const accounts: Readonly<Record<string, string>> = { "ada-owner": acme, "grace-owner": globex };

const screens: Readonly<Record<string, { readonly box?: "identifier" | "password"; readonly controls: readonly string[] }>> = {
  "/login": { box: "identifier", controls: ["#username", "#next"] },
  "/login/password": { box: "password", controls: ["#password", "#sign-in"] },
  "/home": { controls: [] },
};

/** An origin as the scan names it: `workspace` for a workspace host of the relation. */
const named = (origin: string) => (origin !== site && workspaceHost(site, parent, origin) ? "workspace" : origin);

/** The site, opening on `opensOn` when given (a page the browser was left on), else the URL. */
const workspaceSite = (opensOn?: string, signedInOn?: string) => {
  const state = {
    at: new URL(`${site}/login`),
    signedInOn,
    typed: undefined as string | undefined,
  };
  const fills: string[] = [];
  const opened: string[] = [];
  const page = () => `${state.at.origin}${state.at.pathname}`;
  const screen = () => screens[state.at.pathname];
  const shows = (selector: string) => screen()?.controls.includes(selector) === true;
  const here = (): AutofillSignedInCheck =>
    state.at.pathname === "/home" && state.at.origin === state.signedInOn
      ? { signedIn: true, url: state.at.href }
      : { signedIn: false, failed: "indicator_not_visible", url: state.at.href };
  const hooks: AutofillHooks<TestFailure> = {
    inspect: (step) =>
      Effect.sync(() => {
        const selectors = [...step.fields.map((field) => field.selector), ...(step.submit === undefined ? [] : [step.submit])];
        if (selectors.length === 0 || !selectors.every(shows)) return { outcome: "refused" as const, reason: "not_found" as const };
        const target = {
          ownerUrl: page(),
          documentOrigin: state.at.origin,
          actions: [page()],
          methods: ["post"],
          editable: true,
          control: "text" as const,
        };
        const inspection: AutofillInspection = {
          url: page(),
          page: page(),
          targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
          siteOrigin: site,
          authenticationOrigins: [],
          screen: { origin: state.at.origin, fields: [], submit: null, buttons: [] },
        };
        return inspection;
      }),
    fill: ({ step, values }) =>
      Effect.sync(() => {
        // Each box is typed alone, then the submit pressed with nothing typed.
        if (step.fields.length > 0) {
          fills.push(page());
          state.typed = values[0];
        }
        if (step.submit !== undefined) {
          if (state.at.pathname === "/login") state.at = new URL(`${accounts[state.typed ?? ""] ?? site}/login/password`);
          else if (state.at.pathname === "/login/password" && state.typed === password) {
            state.signedInOn = state.at.origin;
            state.at = new URL(`${state.at.origin}/home`);
          }
          state.typed = undefined;
        }
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: step.submit === undefined ? ("none" as const) : ("clicked" as const),
          url: state.at.href,
        };
      }),
    check: () => Effect.sync(here),
    confirm: (indicator, _identifiers, _screens, _challenges, at) =>
      Effect.sync(() => {
        if (indicator.openPath !== undefined) state.at = new URL(indicator.openPath, at?.origin ?? site);
        return here();
      }),
    open: (url) =>
      Effect.sync(() => {
        opened.push(url);
        state.at = new URL(opensOn ?? url);
      }),
    markerVisible: () => Effect.succeed(false),
  };
  const observe = Effect.sync((): ObservedState => {
    const top = named(state.at.origin);
    const box = screen()?.box;
    const boxes = box === undefined ? [] : [{ frame: top, kind: box }];
    return {
      fingerprint: box === undefined ? { top, boxes, submit: false, message: "welcome", buttons: [] } : { top, boxes, submit: true },
      boxes: boxes.map((shown) => ({ ...shown, empty: true, submit: true })),
      texts: [],
    };
  });
  return { hooks, observe, state, fills, opened };
};

/** The identifier on the shared host, then the password on the login's own workspace host. */
const library: SignInStates = (() => {
  const appended = appendSignInStates(signInStatesOf({ workspace: { parent } }, []), {
    states: [
      {
        fingerprint: { top: site, boxes: [{ frame: site, kind: "identifier" }], submit: true },
        step: { page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" },
      },
      {
        fingerprint: { top: "workspace", boxes: [{ frame: "workspace", kind: "password" }], submit: true },
        step: {
          origin: "workspace",
          page: "/login/password",
          fields: [{ selector: "#password", slot: "password" }],
          submit: "#sign-in",
        },
      },
    ],
    signedIn: { selector: "#account", openPath: "/home" },
  });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
})();

/** `library` with the identifier state also recorded on a workspace host, as a site that remembers it. */
const remembered: SignInStates = (() => {
  const appended = appendSignInStates(library, {
    states: [
      {
        fingerprint: { top: "workspace", boxes: [{ frame: "workspace", kind: "identifier" }], submit: true },
        step: { origin: "workspace", page: "/login", fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" },
      },
    ],
    signedIn: { selector: "#account", openPath: "/home" },
  });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
})();

const signIn = (
  fake: ReturnType<typeof workspaceSite>,
  username = "ada-owner",
  pinned?: string,
  events: { readonly kind: string; readonly origin: string }[] = [],
  replayed: SignInStates = library,
) =>
  Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library: replayed,
        observe: fake.observe,
        hooks: fake.hooks,
        entryUrl: `${site}/login`,
        credentials: { username, password },
        ask: makeInputAsker(() => Effect.succeed({} as InputAnswers)),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "app.example.com",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        workspace: {
          siteOrigin: site,
          parent,
          pinned,
          observe: (event) => Effect.sync(() => void events.push(event)),
        },
        timing: { stepWaitMs: 200, pollMs: 2 },
        quiet: { quietMs: 20, capMs: 120, enterMs: 40 },
        sent: { current: false },
      }),
    ),
  ).then((outcome) => {
    if (Either.isLeft(outcome)) throw outcome.left;
    return outcome.right;
  });

it("types the password on the workspace host the site sent this login to, and pins it", async () => {
  const fake = workspaceSite();
  const events: { readonly kind: string; readonly origin: string }[] = [];
  const ended = await signIn(fake, "ada-owner", undefined, events);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, workspaceOrigin: acme });
  expect(ended.visited).toEqual(library.states.map((state) => state.key));
  expect(fake.fills).toEqual([`${site}/login`, `${acme}/login/password`]);
  expect(events).toEqual([{ kind: "admitted", origin: acme }]);
});

it("replays the same library on another account's own workspace", async () => {
  const fake = workspaceSite();
  const ended = await signIn(fake, "grace-owner");
  expect(ended).toMatchObject({ outcome: "signed_in", workspaceOrigin: globex });
  expect(fake.fills).toEqual([`${site}/login`, `${globex}/login/password`]);
});

it("never types the password on a workspace host the browser was left on before anything was sent", async () => {
  // Another account's workspace, left from an earlier session, shows the password state first.
  const fake = workspaceSite(`${globex}/login/password`);
  const events: { readonly kind: string; readonly origin: string }[] = [];
  const ended = await signIn(fake, "ada-owner", acme, events);
  // At once, as at a recipe screen, for the run to clear the browser and sign in again.
  expect(ended).toMatchObject({ outcome: "unsent", reason: "workspace_unverified", visited: [] });
  expect(fake.fills).toEqual([]);
  expect(events).toEqual([{ kind: "refused", origin: globex }]);
});

it("goes on at the login's pinned workspace, typing the password there", async () => {
  // The site remembers the workspace: the browser opens on its password page.
  const fake = workspaceSite(`${acme}/login/password`);
  const ended = await signIn(fake, "ada-owner", acme);
  expect(ended).toMatchObject({ outcome: "signed_in", workspaceOrigin: acme });
  expect(fake.fills).toEqual([`${acme}/login/password`]);
});

it("still finds the login's session on its pinned workspace before it ends at a refused host", async () => {
  // Another account's workspace shows its identifier state, while this login's own session on its
  // pinned workspace is still good.
  const fake = workspaceSite(`${globex}/login`, acme);
  const events: { readonly kind: string; readonly origin: string }[] = [];
  const ended = await signIn(fake, "ada-owner", acme, events, remembered);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: true });
  expect(fake.fills).toEqual([]);
});
