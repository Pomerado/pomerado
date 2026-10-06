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
 * One build's start state: whether its write session started, whether it is signed in, what its
 * current sign-in sent, and the session saved after that sign-in. A host calls `signIn()` on each
 * sign-in step, `sent(...)` for what a sign-in step submitted, `verified()` when the site shows
 * the build signed in, `plan(step)` before each step and `dispatched(step)` once the step's page
 * is ready. When the plan says `save`, the host saves the session with `save(session)` before it
 * starts the page. A failed save or page start stops the step and changes nothing, so the next
 * step's plan asks again.
 */
export const makeStartTracker = <Session = unknown>() => {
  let writeSessionStarted = false;
  let signedIn = false;
  let signInSettled = false;
  let signInOpen = false;
  let sentIdentifier = false;
  let sentProof = false;
  let saved: { readonly session: Session } | undefined;
  const invalidate = () => {
    saved = undefined;
    signInSettled = false;
    signInOpen = false;
    sentIdentifier = false;
    sentProof = false;
  };
  return {
    /** A new browser: nothing saved or sent describes it until a new verified sign-in. */
    invalidate,
    /**
     * A sign-in step. The first one after a verified sign-in, or the build's first, starts a new
     * sign-in, which drops the saved session and what the last sign-in sent. Later steps of the
     * same sign-in, each screen of it, add to what it sent.
     */
    signIn: () => {
      if (signInOpen) return;
      invalidate();
      signInOpen = true;
    },
    /**
     * What a sign-in step submitted: the login's identifier, or what proves it (a password, a
     * code or an approval the user completed).
     */
    sent: (kind: "identifier" | "proof") => {
      if (kind === "identifier") sentIdentifier = true;
      else sentProof = true;
    },
    /** Whether this sign-in sent the login's identifier and what proves it. */
    get submitted() {
      return sentIdentifier && sentProof;
    },
    /**
     * The site shows the build signed in. It counts only once the sign-in submitted the login, so
     * a page that already showed an account proves nothing. Returns whether it counted.
     */
    verified: () => {
      if (!(sentIdentifier && sentProof)) return false;
      signedIn = true;
      signInSettled = true;
      signInOpen = false;
      return true;
    },
    /** What to do before `step` runs. Planning changes nothing. */
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
      return { save, start };
    },
    /** The step's page is ready and it runs now: a write session's first step starts it. */
    dispatched: (step: StartStep) => {
      if (isFirstWriteStep(step.purpose, writeSessionStarted)) writeSessionStarted = true;
    },
    save: (session: Session) => {
      saved = { session };
    },
    /** The session saved after sign-in, until a new sign-in or browser. */
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

/**
 * How a reset leaves the browser's site data. `restore` puts back `session`, the value
 * `saveSessionCode` returned.
 */
export type PageStart =
  | { readonly siteData: "clear" | "keep" }
  | { readonly siteData: "restore"; readonly session: unknown };

/**
 * Browser code that closes every other tab and leaves the primary tab on a blank document at the
 * site root. Unless site data is kept, it also clears the tab's session storage, the site's data,
 * and every cookie and every visited origin's storage, and then puts back the saved session for a
 * `restore`. It sends no request: the blank root is served locally, since session storage belongs
 * to the tab and only a document of that origin can clear it.
 */
export const resetPageCode = (
  targetId: string,
  origin: string,
  start: PageStart,
) => `${primaryPageCode(targetId)}
const primaryOrigin = ${JSON.stringify(origin)};
const siteData = ${JSON.stringify(start.siteData)};
const cleared = ${JSON.stringify(start.siteData === "keep" ? [] : [origin])};
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
 * leaves the reset in place: the step still runs and may navigate deeper itself. A `restore`
 * without a saved session fails before it touches the browser.
 */
export const startPage = (
  execute: HostExecute,
  targetId: string,
  origin: string,
  start: PageStart,
  hooks: StartPageHooks,
): Effect.Effect<void, Error> =>
  start.siteData === "restore" && start.session === undefined
    ? Effect.fail(new Error("No saved session to restore"))
    : execute(resetPageCode(targetId, origin, start), 60).pipe(
        Effect.zipRight(hooks.beforeEntry),
        Effect.zipRight(hooks.navigateRoot(new URL("/", origin).href)),
      );
