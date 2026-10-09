import { fileURLToPath } from "node:url";
import { Effect, Schema, Scope } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import type { LocalOperationJournal } from "../execution/local-operation.js";
import type { PlaywrightExecutor } from "../execution/playwright-execute.js";
import type { ConfirmSession } from "../browser/dialogs/expected.js";
import {
  identifierPreference,
  type AutofillSlot,
  type AutofillStepReport,
  type AutofillStepRequest,
} from "../destinations/autofill-step.js";
import { MintFailure, type ExecutionRequest } from "../mint/contracts.js";
import { makeSecretHandles } from "../mint/secret-handles.js";
import type { FileHandles } from "../mint/file-handles.js";
import { makeSignInRecorder } from "../mint/sign-in-recorder.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import type { OutcomeAssessment } from "../mint/outcome-review-contracts.js";
import type { WriteSessionMarks } from "../mint/write-session.js";
import { loadStandaloneAuthoring } from "../mint/skills.js";
import { screenMintText } from "../mint/workspace.js";
import { Deadline } from "../runtime/deadline.js";
import { failureDetail } from "../runtime/failure-detail.js";
import type { InputAsker } from "../runtime/input-request.js";
import { askingValueHooks } from "../runtime/sign-in-values.js";
import { mintSessionSignIns, signedInAtEntry } from "../runtime/session-sign-in.js";
import {
  localStartHooks,
  makeStartTracker,
  SavedSession,
  saveSessionCode,
  savedSessionStorageCapBytes,
  startPage,
  type StartState,
} from "../runtime/start-state.js";
import { makeAfterSubmit } from "./after-submit.js";
import { localSignInLogin, makeSignInBrowser, repeatedLoginFailure } from "./authentication.js";
import { makeMarkerChecks } from "./signed-in-marker.js";
import {
  makeBoundableAsk,
  makeLocalSessionSignIn,
  makeRejectableLogin,
  mintSessionSignInFailure,
} from "./session-sign-in.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import type { PomeradoRequest } from "./contracts.js";
const identifiers: ReadonlySet<AutofillSlot> = new Set(identifierPreference);
/** What the host does with a sign-in step Guardian allows, for its review. */
const signInStepNote =
  "The host fills the login's values, which never appear in this review, into the fields the step names and clicks the named submit on the sign-in screen of the authorized site.";
/** A marker that a page the build saw signed out shows cannot tell signed in from signed out. */
const markerOnSignedOutPage = {
  signedIn: false,
  failed: "marker_matches_signed_out_page",
  nextStep:
    "A page this build saw signed out shows this marker too, so it cannot tell the site signed in from signed out. The sign-in is still open. Choose an element only a signed-in user sees, test it with check_signed_in_marker, then check again.",
} as const;
/** A step that could not start its page: the browser call failed, so nothing ran. */
const unavailable = (operation: string) => (error: unknown) =>
  new MintFailure({
    code: "Unavailable",
    failureDetail: failureDetail("mint_host_dependency_failed", { operation, error }),
  });
/** Browser code that returns the context's cookies and site storage, IndexedDB included. */
export const saveStateCode = "return await context.storageState({ indexedDB: true });";
/**
 * Where a build's live steps start. The first step that is not reset loads the request's URL once.
 * A live example, a live test and a write session's first step reset the page and load the site
 * root; see `startStateFor`. A new sign-in drops the session saved after the last one, and a
 * check counts the build signed in only once a sign-in step sent the login (see `sent`).
 * `leavePage` runs before each reset, so the page the last step left is never taken for the
 * reset step's page, even when the reset fails. `afterClear` runs once a reset cleared the
 * browser's cookies and site storage, on that signed-out page. `afterSignedInReset` runs once a
 * reset restored the session saved after a verified sign-in, which the reset's load may have
 * signed out; it may reset the page the same way again with `reopen`. A reset that keeps the
 * browser's session, while a later sign-in is unsettled, runs neither.
 */
export const makeBuildStart = (
  browser: Pick<PlaywrightExecutor, "execute" | "targetId">,
  siteOrigin: string,
  enterRequest: Effect.Effect<void, Error>,
  leavePage: () => void,
  afterClear: Effect.Effect<void> = Effect.void,
  afterSignedInReset: (
    reopen: Effect.Effect<void, MintFailure>,
  ) => Effect.Effect<void, MintFailure> = () => Effect.void,
) => {
  const tracker = makeStartTracker<SavedSession>();
  const hooks = localStartHooks(browser.execute, browser.targetId);
  // The context's storage and the tab's session storage, which is left out past its cap. A
  // browser call returns at most 1 MiB, so when both together fail, the save reads the stored
  // state alone, as it did before it kept session storage: it fails only where that read fails.
  const readSession = browser.execute(saveSessionCode(browser.targetId, siteOrigin), 60).pipe(
    Effect.flatMap(Schema.decodeUnknown(SavedSession)),
    Effect.orElse(() =>
      browser
        .execute(saveStateCode, 60)
        .pipe(Effect.map((state): SavedSession => ({ state, sessionStorage: [] }))),
    ),
    Effect.map(
      (saved): SavedSession =>
        Buffer.byteLength(JSON.stringify(saved.sessionStorage)) <= savedSessionStorageCapBytes
          ? saved
          : { ...saved, sessionStorage: [] },
    ),
    Effect.mapError(unavailable("standalone.saveSession")),
  );
  let entered = false;
  const enter = Effect.suspend(() =>
    entered
      ? Effect.void
      : enterRequest.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              entered = true;
            }),
          ),
        ),
  );
  return {
    /** Loads the request's URL, unless a live step already loaded a page. */
    enter,
    /** Saves the session as it is now, for the next reset that restores one. */
    saveSession: readSession.pipe(Effect.map(tracker.save)),
    /** A sign-in step; see `makeStartTracker`. */
    signIn: tracker.signIn,
    /**
     * What a host fill step may have sent. The host can't see the request itself, so every field
     * the fill typed counts, whatever became of its submit: the page may send what was typed
     * itself. A submit the page kept disabled was never clicked, so that step sent nothing. A fill
     * whose answer was lost counts every field the step asked for. The signed-in check stays the
     * gate.
     */
    sent: (report: AutofillStepReport, requested: AutofillStepRequest["fields"]) => {
      const slots =
        report.outcome === "filled" && report.submit !== "stayed_disabled"
          ? report.fields.filter((field) => field.status === "filled").map((field) => field.slot)
          : report.outcome === "uncertain"
            ? requested.map((field) => ("slot" in field ? field.slot : "username"))
            : [];
      for (const slot of slots) {
        if (identifiers.has(slot)) tracker.sent("identifier");
        if (slot === "password" || slot === "code") tracker.sent("proof");
      }
    },
    /** The user completed the sign-in's approval. */
    approved: () => tracker.sent("proof"),
    /**
     * An explore made a completed typing call on the site with a code the site sent for the
     * sign-in under way.
     */
    typedCode: () => tracker.sent("proof"),
    /** Whether the current sign-in sent the login. */
    get submitted() {
      return tracker.submitted;
    },
    /** The site showed the build signed in. Returns whether it counted. */
    verified: tracker.verified,
    /** Whether `step` starts on a reset page, not the one the last step left. Changes nothing. */
    resets: (step: Pick<ExecutionRequest, "purpose" | "target">) =>
      tracker.plan({ purpose: step.purpose, live: step.target === "liveBrowser" }).start !== "none",
    /** Saves the session when due, then resets the page or enters the site, before `step` runs. */
    before: (step: Pick<ExecutionRequest, "purpose" | "target">) =>
      Effect.gen(function* () {
        const live = step.target === "liveBrowser";
        const planned = { purpose: step.purpose, live };
        if (step.purpose === "authenticate") tracker.signIn();
        const plan = tracker.plan(planned);
        if (plan.save) tracker.save(yield* readSession);
        if (plan.start === "none") {
          if (live) yield* enter;
        } else {
          const start: Exclude<StartState, "none"> = plan.start;
          leavePage();
          // The saved session as it is when the reset runs: a sign-in after it saves a new one.
          const reset = Effect.suspend(() =>
            startPage(
              browser.execute,
              browser.targetId,
              siteOrigin,
              start === "restore"
                ? { siteData: "restore", session: tracker.saved }
                : { siteData: start },
              hooks,
            ),
          ).pipe(Effect.mapError(unavailable("standalone.startPage")));
          yield* reset;
          entered = true;
          if (start === "clear") yield* afterClear;
          else if (start === "restore") yield* afterSignedInReset(reset);
        }
        tracker.dispatched(planned);
      }),
  };
};
export const mintState = (
  session: StandaloneSession,
  context: RequestContext,
  request: PomeradoRequest,
  /** The handles the request's input holds where the caller's files stood. */
  fileHandles: FileHandles,
) =>
  Effect.gen(function* () {
    const { options, ask, browser, secrets } = session;
    const workspace = yield* createLocalWorkspace();
    yield* seedLocalRuntime(workspace);
    const authoring = yield* loadStandaloneAuthoring(
      fileURLToPath(new URL("../../authoring/", import.meta.url)),
    );
    for (const [path, text] of authoring.files) yield* workspace.write(path, text);
    const handles = makeSecretHandles();
    const deadline = Deadline.after(options.timeoutMs);
    const mintAsk: InputAsker = (candidate, bounds) =>
      Effect.acquireUseRelease(
        Effect.sync(() => deadline.suspend()),
        () => ask(candidate, bounds),
        (resume) => Effect.sync(resume),
      );
    const runs = new Map<
      string,
      {
        readonly sources: readonly (readonly [string, string])[];
        readonly entrypoint: string;
        readonly input: unknown;
        /** The agent's exampleInput the step ran because the caller sent none. */
        readonly intentDerivedInput?: Readonly<Record<string, unknown>>;
        readonly output: unknown;
        readonly purpose: ExecutionRequest["purpose"];
        readonly journal: LocalOperationJournal;
        /** Guardian's label of the step's website effect. */
        readonly action?: GuardianAction;
        /**
         * An act or example step dispatched once the build's open sign-in sent the login and before
         * any check verified it: the host cannot tell whether it ran signed in.
         */
        readonly afterUnverifiedSignIn?: true;
      }
    >();
    /** The outcome reviewer's newest assessment of each write, by execution. */
    const assessments = new Map<string, OutcomeAssessment>();
    /**
     * The build's one write session: whether its first act step dispatched, and the agent's
     * `exampleInput` it runs when the caller sent none (fixed by the first act step that passed
     * one), its act steps in order for publication's checks, and the confirm popups its act
     * steps accepted.
     */
    const writeSession: {
      started: boolean;
      input: Readonly<Record<string, unknown>> | undefined;
      readonly steps: (WriteSessionMarks & { readonly executionId: string })[];
    } & ConfirmSession = {
      started: false,
      input: undefined,
      steps: [],
      acceptedConfirms: [],
      confirmSteps: new Set(),
    };
    /** Each one-time login URL publication already asked about, so finishing again publishes it. */
    const oneTimeLoginUrlsAsked = new Set<string>();
    const afterSubmit = makeAfterSubmit({ workspace, screen: secrets.json });
    // The build's automatic sign-ins, counted for the whole attempt: a task update that moves
    // the build to another site starts no new allowance.
    const signInsSpent = { attempt: 0, scope: 0 };
    /**
     * Everything bound to the build's site: the sign-in browser and recorder, the marker checks
     * and the build's start. A task update that moves the build to another site binds them anew.
     */
    const bindSite = (siteOrigin: string, authenticationOrigins: readonly string[]) =>
      Effect.gen(function* () {
        /**
         * The site's sign-in origins: the request's, then each the caller trusted when the host
         * asked, which count for sign-in only, never for Guardian's allowed origins. Each origin
         * is asked about once.
         */
        const trusted: string[] = [];
        const signInOrigins = {
          trusted,
          asked: new Set<string>(),
          all: (): readonly string[] => [...new Set([...authenticationOrigins, ...trusted])],
        };
        const signInBrowser = makeSignInBrowser({
          page: browser,
          keyboard: browser.keyboard,
          siteOrigin: siteOrigin,
          authenticationOrigins,
          trusted: () => trusted,
          onRequest: browser.onRequest,
          typing: session.signInTyping,
        });
        // The site as the owner's questions name it: its host, without `www.`.
        const site = new URL(siteOrigin).hostname.replace(/^www\./u, "");
        // One login and one set of value questions for the build's sign-ins, the automatic ones
        // too, whose questions a script's bound limits.
        const signInAsks = makeBoundableAsk(mintAsk);
        // A login value an automatic sign-in sent and the site rejected is not sent again, by any
        // sign-in.
        const login = makeRejectableLogin(
          localSignInLogin({
            ask: signInAsks.ask,
            register: secrets.register,
            siteOrigin: siteOrigin,
          }),
          repeatedLoginFailure,
        );
        const values = askingValueHooks({
          ask: signInAsks.ask,
          register: secrets.register,
          site,
          siteOrigin: siteOrigin,
        });
        const recorder = yield* makeSignInRecorder<Error>({
          browser: signInBrowser,
          login: login.login,
          values,
          // The screen may show a value the caller gave, such as the typed email on a password
          // screen; it reaches Guardian masked. The source check still refuses any value left.
          review: (step, inspection) =>
            screenMintText(
              { projection: session.projection },
              { step, screen: inspection.screen },
            ).pipe(
              Effect.flatMap((source) =>
                context.review(
                  {
                    entrypoint: "operation/sign-in-step.json",
                    sources: new Map([["operation/sign-in-step.json", source]]),
                    input: {},
                    currentExecution: { purpose: "authenticate", target: "liveBrowser" },
                    note: signInStepNote,
                  },
                  "not_sent",
                ),
              ),
              Effect.asVoid,
            ),
          site,
          carries: secrets.carries,
          refuseIndicator: (indicator) =>
            markers.signedOutShows(indicator) ? markerOnSignedOutPage : undefined,
        });
        const markers = makeMarkerChecks({
          page: browser,
          siteOrigin: siteOrigin,
          // The live check on the build's screens; it ends no sign-in.
          check: (indicator) => {
            const { screens, challengeScreens } = recorder.screens();
            return signInBrowser.confirm(indicator, screens, challengeScreens);
          },
          typing: session.signInTyping,
          loginSent: () => start.submitted || context.signedIn,
          writeSessionStarted: () => writeSession.started,
          observe: context.observe,
        });
        /** Set once the entry page's own load signed a fresh sign-in out again. */
        const lostOnLoad = { current: false };
        const start = makeBuildStart(
          browser,
          siteOrigin,
          context.navigate,
          context.leavePage,
          markers.afterClear,
          // A reset reloads the site, which signs out a site that keeps its session only in page
          // memory: the host signs in again before the step can reach the browser.
          (reopen) =>
            signedInAtEntry({
              ensureSignedIn: sessionSignIn
                .ensureSignedIn("signed_out_at_start")
                .pipe(Effect.mapError(mintSessionSignInFailure)),
              reopen,
              lostOnLoad,
            }).pipe(Effect.asVoid),
        );
        // The build's automatic sign-ins with the sign-in it recorded and verified last.
        const sessionSignIn = makeLocalSessionSignIn({
          browser: signInBrowser,
          recorded: recorder.published,
          login,
          values,
          asks: signInAsks,
          carries: secrets.carries,
          site,
          siteOrigin: siteOrigin,
          limits: mintSessionSignIns,
          scope: "check",
          spent: signInsSpent,
          saveSession: start.saveSession,
        });
        /**
         * The origins a signed-in check found the login sent only to, off the site and its sign-in
         * origins, since the last verified sign-in: what an unpublished build names to its caller.
         */
        const untrustedSignInOrigins = new Set<string>();
        return { recorder, markers, start, sessionSignIn, untrustedSignInOrigins, signInOrigins };
      });
    let bound = yield* bindSite(context.siteOrigin, context.authenticationOrigins);
    // A later binding lives as long as the first: until the request's scope closes.
    const scope = yield* Effect.scope;
    return {
      session,
      context,
      request,
      workspace,
      authoring,
      handles,
      fileHandles,
      deadline,
      mintAsk,
      runs,
      assessments,
      writeSession,
      oneTimeLoginUrlsAsked,
      afterSubmit,
      get recorder() {
        return bound.recorder;
      },
      get markers() {
        return bound.markers;
      },
      get start() {
        return bound.start;
      },
      get sessionSignIn() {
        return bound.sessionSignIn;
      },
      get untrustedSignInOrigins() {
        return bound.untrustedSignInOrigins;
      },
      get signInOrigins() {
        return bound.signInOrigins;
      },
      /**
       * What an unpublished build names to its caller: the origins its checks named since the last
       * verified sign-in, then the ones the open sign-in's requests carried the login to, so a
       * build that never checked its sign-in names them too.
       */
      namedSignInOrigins: (): readonly string[] => [
        ...new Set([...bound.untrustedSignInOrigins, ...bound.recorder.untrustedOrigins()]),
      ],
      /**
       * Binds the build to another site, for a task update the host applies, with no sign-in
       * origins of its own; nothing switches unless it succeeds.
       */
      rebindSite: (siteOrigin: string) =>
        bindSite(siteOrigin, []).pipe(
          Scope.extend(scope),
          Effect.map((rebound) => {
            bound = rebound;
          }),
        ),
    };
  });
export type MintState = Effect.Effect.Success<ReturnType<typeof mintState>>;
