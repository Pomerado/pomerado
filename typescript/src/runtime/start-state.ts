import { Effect, Schema } from "effect";
import { getDomain } from "tldts";
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
 * sign-in step, a signed-in check included, `sent(...)` for what a sign-in step may have sent,
 * `verified()` when the site shows the build signed in, `plan(step)` before each step and
 * `dispatched(step)` once the step's page is ready. When the plan says `save`, the host saves the
 * session with `save(session)` before it starts the page. A failed save or page start stops the
 * step and changes nothing, so the next step's plan asks again.
 */
export const makeStartTracker = <Session = unknown>() => {
  let writeSessionStarted = false;
  let signedIn = false;
  let signInSettled = false;
  let signInOpen = false;
  let sentIdentifier = false;
  let sentProof = false;
  let saved: { readonly session: Session } | undefined;
  return {
    /**
     * A sign-in step, a signed-in check included. The first one after a verified sign-in, or the
     * build's first, starts a new sign-in: nothing saved describes the browser until that sign-in
     * is verified, and nothing sent counts for it yet. Later steps of the same sign-in, each
     * screen of it, add to what it sent.
     */
    signIn: () => {
      if (signInOpen) return;
      saved = undefined;
      signInSettled = false;
      sentIdentifier = false;
      sentProof = false;
      signInOpen = true;
    },
    /**
     * What a sign-in step may have sent: the login's identifier, or what proves it (a password, a
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
     * The site shows the build signed in. It counts only once the sign-in sent the login, so a
     * page that already showed an account proves nothing. A verified sign-in is over: what it
     * sent counts for no later check. Returns whether it counted.
     */
    verified: () => {
      if (!(sentIdentifier && sentProof)) return false;
      signedIn = true;
      signInSettled = true;
      signInOpen = false;
      sentIdentifier = false;
      sentProof = false;
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
    /** The session saved after sign-in, until the next sign-in step. */
    get saved(): Session | undefined {
      return saved?.session;
    },
  };
};

/**
 * The primary tab's session storage the save kept, per same-site origin, in the order read: what
 * Playwright's storage state leaves out.
 */
export const SavedSessionStorage = Schema.Array(
  Schema.Struct({
    origin: Schema.String,
    entries: Schema.Array(Schema.Tuple(Schema.String, Schema.String)),
  }),
);
export type SavedSessionStorage = typeof SavedSessionStorage.Type;

/** Saved session storage past this many bytes is left out of the save. */
export const savedSessionStorageCapBytes = 1024 * 1024;

/** What `saveSessionCode` returns: the context's storage state and the tab's session storage. */
export const SavedSession = Schema.Struct({
  state: Schema.Unknown,
  sessionStorage: SavedSessionStorage,
});
export type SavedSession = typeof SavedSession.Type;

/**
 * One browser call that reads the context's storage state and the primary tab's session storage,
 * from its main frame and the frames on the site's registrable domain only, one read per origin.
 */
export const saveSessionCode = (targetId: string, primaryOrigin: string) => {
  const url = new URL(primaryOrigin);
  const site = getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  return `${primaryPageCode(targetId)}
const scheme = ${JSON.stringify(url.protocol)};
const site = ${JSON.stringify(site)};
const sameSite = (href) => {
  try {
    const url = new URL(href);
    return url.protocol === scheme && (url.hostname === site || url.hostname.endsWith("." + site));
  } catch {
    return false;
  }
};
const state = await context.storageState({ indexedDB: true });
const sessionStorage = [];
const read = new Set();
for (const frame of primary.frames()) {
  if (!sameSite(frame.url()) || read.has(new URL(frame.url()).origin)) continue;
  const stored = await frame
    .evaluate(() => {
      const entries = [];
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (key !== null) entries.push([key, sessionStorage.getItem(key) ?? ""]);
      }
      return { origin: location.origin, entries };
    })
    .catch(() => undefined);
  if (stored === undefined || !sameSite(stored.origin + "/") || read.has(stored.origin)) continue;
  read.add(stored.origin);
  if (stored.entries.length > 0) sessionStorage.push(stored);
}
return { state, sessionStorage };`;
};

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
  | { readonly siteData: "restore"; readonly session: SavedSession | undefined };

/**
 * One browser call that closes every other tab and leaves the primary tab blank. Unless site data
 * is kept, it then clears every cookie, the tab's session storage and the storage of every origin
 * the browser visited, and puts back `restored` and `restoredSessionStorage` when given. It sends
 * no request: session storage that only a site document can clear or set is cleared, then set
 * again, on a blank document of that origin that Playwright serves locally in the same tab, and
 * Playwright restores each origin's other storage the same way. `origins` are cleared besides the
 * primary one. Cookies whose names start with one of `keptCookiePrefixes`, which a host supplies,
 * are kept across a clear and put back last, over a restored one of the same name, domain and
 * path. `cleanupOnly` leaves the tab on about:blank.
 */
export const resetPageCode = (
  targetId: string,
  primaryOrigin: string,
  siteData: "keep" | "clear" | "restore",
  restored: unknown,
  restoredSessionStorage: SavedSessionStorage = [],
  origins: readonly string[] = [],
  cleanupOnly = false,
  keptCookiePrefixes: readonly string[] = [],
) => `${primaryPageCode(targetId)}
const primaryOrigin = ${JSON.stringify(primaryOrigin)};
const cleared = ${JSON.stringify([...new Set([primaryOrigin, ...origins])])};
const siteData = ${JSON.stringify(siteData)};
const restored = ${JSON.stringify(siteData === "restore" ? restored : null)};
const tabStorage = new Map(${JSON.stringify(
  siteData === "restore"
    ? restoredSessionStorage.map(({ origin, entries }) => [origin, entries])
    : [],
)});
const keptPrefixes = ${JSON.stringify(siteData !== "keep" ? keptCookiePrefixes : [])};
// A jar that cannot be read keeps nothing: the reset wipes it as it would without the keep.
const kept = keptPrefixes.length === 0
  ? []
  : (await context.cookies().catch(() => [])).filter((cookie) =>
      keptPrefixes.some((prefix) => cookie.name.startsWith(prefix)));
for (const other of context.pages()) if (other !== primary) await other.close();
if (siteData !== "keep")
  for (const frame of primary.frames())
    await frame.evaluate(() => sessionStorage.clear()).catch(() => undefined);
const session = await context.newCDPSession(primary);
try {
  await session.send("Page.stopLoading");
  if (siteData !== "keep")
    for (const origin of cleared)
      await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
} finally {
  await session.detach();
}
// An inert same-origin document clears the old page without loading the website before
// its session is restored. Returning to an origin also exposes its tab session storage, so a
// saved same-site origin's entries go back the same way, the site origin's last.
const local = (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" });
const navigation = await context.newCDPSession(primary);
await navigation.send("Network.setBypassServiceWorker", { bypass: true });
try {
  for (const origin of [...[...tabStorage.keys()].filter((origin) => origin !== primaryOrigin), primaryOrigin]) {
    await primary.route(origin + "/**", local);
    try {
      await primary.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (siteData !== "keep")
        await primary.evaluate((entries) => {
          sessionStorage.clear();
          for (const [key, value] of entries) sessionStorage.setItem(key, value);
        }, tabStorage.get(origin) ?? []);
    } finally {
      await primary.unroute(origin + "/**", local);
    }
  }
} finally {
  await navigation.send("Network.setBypassServiceWorker", { bypass: false });
  await navigation.detach();
}
if (siteData !== "keep")
  await context.setStorageState(restored ?? { cookies: [], origins: [] });
// One at a time, since Chromium refuses a whole call over one cookie it rejects. The reset has
// done its job by now, so a refused cookie only loses its own clearance.
for (const cookie of kept) await context.addCookies([cookie]).catch(() => undefined);
${cleanupOnly ? 'await primary.goto("about:blank", { timeout: 10_000 });' : ""}`;

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
    : execute(
        resetPageCode(
          targetId,
          origin,
          start.siteData,
          start.siteData === "restore" ? start.session?.state : undefined,
          start.siteData === "restore" ? start.session?.sessionStorage : undefined,
        ),
        60,
      ).pipe(
        Effect.zipRight(hooks.beforeEntry),
        Effect.zipRight(hooks.navigateRoot(new URL("/", origin).href)),
      );
