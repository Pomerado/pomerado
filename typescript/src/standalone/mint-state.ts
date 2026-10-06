import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import type { LocalOperationJournal } from "../execution/local-operation.js";
import type { PlaywrightExecutor } from "../execution/playwright-execute.js";
import {
  identifierPreference,
  type AutofillSlot,
  type AutofillStepReport,
  type AutofillStepRequest,
} from "../destinations/autofill-step.js";
import { MintFailure, type ExecutionRequest } from "../mint/contracts.js";
import { makeSecretHandles } from "../mint/secret-handles.js";
import { loadStandaloneAuthoring } from "../mint/skills.js";
import { Deadline } from "../runtime/deadline.js";
import { failureDetail } from "../runtime/failure-detail.js";
import type { InputAsker } from "../runtime/input-request.js";
import {
  localStartHooks,
  makeStartTracker,
  saveSessionCode,
  startPage,
} from "../runtime/start-state.js";
import { makeAfterSubmit } from "./after-submit.js";
import { makeLiveAuthentication } from "./authentication.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import type { PomeradoRequest } from "./contracts.js";
const identifiers: ReadonlySet<AutofillSlot> = new Set(identifierPreference);
/** A step that could not start its page: the browser call failed, so nothing ran. */
const unavailable = (operation: string) => (error: unknown) =>
  new MintFailure({
    code: "Unavailable",
    failureDetail: failureDetail("mint_host_dependency_failed", { operation, error }),
  });
/**
 * Where a build's live steps start. The first step that is not reset loads the request's URL once.
 * A live example, a live test and a write session's first step reset the page and load the site
 * root; see `startStateFor`. A new sign-in drops the session saved after the last one, and a
 * check counts the build signed in only once a sign-in step sent the login (see `sent`).
 */
export const makeBuildStart = (
  browser: Pick<PlaywrightExecutor, "execute" | "targetId">,
  siteOrigin: string,
  enterRequest: Effect.Effect<void, Error>,
) => {
  const tracker = makeStartTracker();
  const hooks = localStartHooks(browser.execute, browser.targetId);
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
    /** A sign-in step; see `makeStartTracker`. */
    signIn: tracker.signIn,
    /**
     * What a host fill step may have sent. Without a request recorder, every field the fill typed
     * counts, whatever became of its submit: the page may send what was typed itself. A submit the
     * page kept disabled was never clicked, so that step sent nothing. A fill whose answer was lost
     * counts every field the step asked for. The signed-in check stays the gate.
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
    /** An explore typed a code the site sent for the sign-in under way into its code screen. */
    typedCode: () => tracker.sent("proof"),
    /** Whether the current sign-in sent the login. */
    get submitted() {
      return tracker.submitted;
    },
    /** The site showed the build signed in. Returns whether it counted. */
    verified: tracker.verified,
    /** Saves the session when due, then resets the page or enters the site, before `step` runs. */
    before: (step: Pick<ExecutionRequest, "purpose" | "target">) =>
      Effect.gen(function* () {
        const live = step.target === "liveBrowser";
        const planned = { purpose: step.purpose, live };
        if (step.purpose === "authenticate") tracker.signIn();
        const plan = tracker.plan(planned);
        if (plan.save)
          tracker.save(
            yield* browser
              .execute(saveSessionCode, 60)
              .pipe(Effect.mapError(unavailable("standalone.saveSession"))),
          );
        if (plan.start === "none") {
          if (live) yield* enter;
        } else {
          yield* startPage(
            browser.execute,
            browser.targetId,
            siteOrigin,
            plan.start === "restore"
              ? { siteData: "restore", session: tracker.saved }
              : { siteData: plan.start },
            hooks,
          ).pipe(Effect.mapError(unavailable("standalone.startPage")));
          entered = true;
        }
        tracker.dispatched(planned);
      }),
  };
};
export const mintState = (
  session: StandaloneSession,
  context: RequestContext,
  request: PomeradoRequest,
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
        readonly output: unknown;
        readonly purpose: ExecutionRequest["purpose"];
        readonly journal: LocalOperationJournal;
      }
    >();
    const auth = makeLiveAuthentication({
      page: browser,
      keyboard: browser.keyboard,
      siteOrigin: context.siteOrigin,
      authenticationOrigins: request.authenticationOrigins ?? [],
      ask: mintAsk,
      registerSecret: secrets.register,
      review: (step, inspection) =>
        context
          .review(
            "operation/sign-in-step.json",
            new Map([
              ["operation/sign-in-step.json", JSON.stringify({ step, screen: inspection.screen })],
            ]),
            {},
            "authenticate",
            "liveBrowser",
          )
          .pipe(Effect.asVoid),
    });
    const afterSubmit = makeAfterSubmit({ workspace, screen: secrets.json });
    let claimed = false;
    let buildEffect: "read" | "write" | undefined =
      request.effect === "read" || request.effect === "write" ? request.effect : undefined;
    const start = makeBuildStart(browser, context.siteOrigin, context.navigate);
    return {
      session,
      context,
      request,
      workspace,
      authoring,
      handles,
      deadline,
      mintAsk,
      runs,
      auth,
      start,
      afterSubmit,
      get claimed() {
        return claimed;
      },
      claim() {
        claimed = true;
      },
      get buildEffect() {
        return buildEffect;
      },
      setBuildEffect(effect: "read" | "write") {
        buildEffect = effect;
      },
    };
  });
export type MintState = Effect.Effect.Success<ReturnType<typeof mintState>>;
