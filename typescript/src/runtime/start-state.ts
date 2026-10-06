import { Effect } from "effect";
import { primaryPageCode, type HostExecute } from "./host-execute.js";

/**
 * How a live step's page starts. `none` continues the page as the previous step left it. The
 * others reset the browser and then load the site root: `clear` removes exploration cookies and
 * site storage, `restore` puts back the session saved right after sign-in, and `keep` keeps the
 * browser's cookies and storage as they are.
 */
export type StartState = "none" | "clear" | "restore" | "keep";

/** A build step's purpose, as the minting agent submits it. */
export type StepPurpose =
  "explore" | "authenticate" | "test" | "example" | "act" | "inspect" | "residual";

/** A step about to run: its purpose, and whether it runs on the live browser. */
export interface StartStep {
  readonly purpose: StepPurpose;
  readonly live: boolean;
}

/** A write session's first step is its first `act`; later steps continue its page. */
export const isFirstWriteStep = (purpose: StepPurpose, writeSessionStarted: boolean) =>
  purpose === "act" && !writeSessionStarted;

/**
 * A live example, a live test and a write session's first step start over at the site root, with
 * none of the page state exploration left. A signed-out build starts without its cookies and site
 * storage. A signed-in build starts from the session saved right after sign-in, or keeps its
 * session when none was saved. Every other step continues the current page.
 */
export const startStateFor = (
  step: StartStep & {
    readonly writeSessionStarted: boolean;
    readonly signedIn: boolean;
    readonly sessionSaved: boolean;
  },
): StartState => {
  const resets =
    step.live &&
    (step.purpose === "example" ||
      step.purpose === "test" ||
      isFirstWriteStep(step.purpose, step.writeSessionStarted));
  if (!resets) return "none";
  if (!step.signedIn) return "clear";
  return step.sessionSaved ? "restore" : "keep";
};

/**
 * The first live step after a settled sign-in saves the session before it runs, so the saved
 * session is the one right after sign-in, before exploration changes anything. A sign-in step
 * itself never saves.
 */
export const shouldSaveSession = (
  step: StartStep & {
    readonly signedIn: boolean;
    readonly signInSettled: boolean;
    readonly sessionSaved: boolean;
  },
) =>
  step.live &&
  step.purpose !== "authenticate" &&
  step.signedIn &&
  step.signInSettled &&
  !step.sessionSaved;

/**
 * One build's start state: whether its write session started, whether it is signed in, and the
 * session saved after its sign-in. A host calls `invalidate()` on each sign-in step and each new
 * browser, `verified()` when the site shows the build signed in, and `plan(step)` before each
 * step. When the plan says `save`, the host saves the session with `save(session)` before it
 * starts the page; a failed save stops the step, and the next step's plan asks again.
 */
export const makeStartTracker = <Session = unknown>() => {
  let writeSessionStarted = false;
  let signedIn = false;
  let signInSettled = false;
  let saved: { readonly session: Session } | undefined;
  return {
    /** A new sign-in or browser: nothing saved describes the browser until a verified sign-in. */
    invalidate: () => {
      saved = undefined;
      signInSettled = false;
    },
    /** The site shows the build signed in. */
    verified: () => {
      signedIn = true;
      signInSettled = true;
    },
    /** What to do before `step` runs. A write session's first step starts the session. */
    plan: (step: StartStep): { readonly save: boolean; readonly start: StartState } => {
      const save = shouldSaveSession({
        ...step,
        signedIn,
        signInSettled,
        sessionSaved: saved !== undefined,
      });
      const start = startStateFor({
        ...step,
        writeSessionStarted,
        signedIn,
        sessionSaved: save || saved !== undefined,
      });
      if (isFirstWriteStep(step.purpose, writeSessionStarted)) writeSessionStarted = true;
      return { save, start };
    },
    save: (session: Session) => {
      saved = { session };
    },
    /** The session saved after sign-in, until `invalidate()`. */
    get saved(): Session | undefined {
      return saved?.session;
    },
  };
};

/** Browser code that returns the context's cookies and site storage, IndexedDB included. */
export const saveSessionCode = "return await context.storageState({ indexedDB: true });";

/**
 * Browser code that stops the primary tab's loading. A failed goto can reject before Chromium
 * commits its error document; stopping it keeps that late commit from cancelling the next goto.
 */
export const stopLoadingCode = (targetId: string) => `${primaryPageCode(targetId)}
const stopped = await context.newCDPSession(primary);
try { await stopped.send("Page.stopLoading"); } finally { await stopped.detach(); }`;

/** How a reset leaves the browser's site data, and what it clears or restores. */
export interface PageStart {
  readonly siteData: Exclude<StartState, "none">;
  /** What a `restore` puts back: the value `saveSessionCode` returned. */
  readonly session?: unknown;
  /** Origins whose site data a `clear` or `restore` removes with the site's own. */
  readonly origins: readonly string[];
}

/**
 * Browser code that closes every other tab and leaves the primary tab on a blank document at the
 * site root. Unless site data is kept, it also clears the tab's session storage, the data of the
 * site and each given origin, and every cookie and every visited origin's storage, and then puts
 * back the saved session for a `restore`. It sends no request: the blank root is served locally,
 * since session storage belongs to the tab and only a document of that origin can clear it.
 */
export const resetPageCode = (targetId: string, origin: string, start: PageStart) => `${primaryPageCode(targetId)}
const primaryOrigin = ${JSON.stringify(origin)};
const siteData = ${JSON.stringify(start.siteData)};
const cleared = ${JSON.stringify(start.siteData === "keep" ? [] : [...new Set([origin, ...start.origins])])};
const restored = ${JSON.stringify(start.siteData === "restore" ? (start.session ?? null) : null)};
for (const other of context.pages()) if (other !== primary) await other.close();
if (siteData !== "keep")
  for (const frame of primary.frames())
    await frame.evaluate(() => sessionStorage.clear()).catch(() => undefined);
const session = await context.newCDPSession(primary);
try {
  await session.send("Page.stopLoading");
  for (const cleaning of cleared)
    await session.send("Storage.clearDataForOrigin", { origin: cleaning, storageTypes: "all" });
} finally {
  await session.detach();
}
const sameOrigin = (url) => url.origin === primaryOrigin;
const blank = (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" });
const navigation = await context.newCDPSession(primary);
await navigation.send("Network.setBypassServiceWorker", { bypass: true });
await primary.route(sameOrigin, blank);
try {
  await primary.goto(primaryOrigin + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
  if (siteData !== "keep") await primary.evaluate(() => sessionStorage.clear());
} finally {
  await primary.unroute(sameOrigin, blank);
  await navigation.send("Network.setBypassServiceWorker", { bypass: false });
  await navigation.detach();
}
if (siteData !== "keep") await context.setStorageState(restored ?? { cookies: [], origins: [] });`;

/** What a host does around a reset: before the site root loads, and loading it. */
export interface StartPageHooks {
  /** Runs after the old page is cleared, before the root loads. */
  readonly beforeEntry: Effect.Effect<void, Error>;
  /** Loads `url` on the primary tab. A load that fails leaves the tab stopped, not failed. */
  readonly navigateRoot: (url: string) => Effect.Effect<void, Error>;
}

/** The local browser's hooks: nothing before entry, and a plain goto that is stopped on failure. */
export const localStartHooks = (execute: HostExecute, targetId: string): StartPageHooks => ({
  beforeEntry: Effect.void,
  navigateRoot: (url) =>
    execute(
      `${primaryPageCode(targetId)}
try {
  await primary.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return true;
} catch {
  return false;
}`,
      40,
    ).pipe(
      Effect.flatMap((loaded) =>
        loaded === true ? Effect.void : execute(stopLoadingCode(targetId), 10),
      ),
      Effect.asVoid,
    ),
});

/**
 * Resets the primary tab as `start` says and then loads the site root. A root that does not load
 * leaves the reset in place: the step still runs and may navigate deeper itself.
 */
export const startPage = (
  execute: HostExecute,
  targetId: string,
  origin: string,
  start: PageStart,
  hooks: StartPageHooks,
): Effect.Effect<void, Error> =>
  execute(resetPageCode(targetId, origin, start), 60).pipe(
    Effect.zipRight(hooks.beforeEntry),
    Effect.zipRight(hooks.navigateRoot(new URL("/", origin).href)),
  );
