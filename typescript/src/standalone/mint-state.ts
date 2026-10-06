import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import type { LocalOperationJournal } from "../execution/local-operation.js";
import type { PlaywrightExecutor } from "../execution/playwright-execute.js";
import type { ExecutionRequest } from "../mint/contracts.js";
import { makeSecretHandles } from "../mint/secret-handles.js";
import { loadStandaloneAuthoring } from "../mint/skills.js";
import { Deadline } from "../runtime/deadline.js";
import type { InputAsker } from "../runtime/input-request.js";
import {
  localStartHooks,
  makeStartTracker,
  saveSessionCode,
  startPage,
} from "../runtime/start-state.js";
import { makeLiveAuthentication } from "./authentication.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import type { PomeradoRequest } from "./contracts.js";
/**
 * Where a build's live steps start. The first step that is not reset loads the request's URL once.
 * A live example, a live test and a write session's first step reset the page and load the site
 * root; see `startStateFor`. Sign-in steps drop the session saved after the last sign-in.
 */
export const makeBuildStart = (
  browser: Pick<PlaywrightExecutor, "execute" | "targetId">,
  siteOrigin: string,
  enterRequest: Effect.Effect<void, Error>,
  origins: readonly string[],
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
    /** The site showed the build signed in. */
    verified: tracker.verified,
    /** Saves the session when due, then resets the page or enters the site, before `step` runs. */
    before: (step: Pick<ExecutionRequest, "purpose" | "target">) =>
      Effect.gen(function* () {
        const live = step.target === "liveBrowser";
        if (step.purpose === "authenticate") tracker.invalidate();
        const plan = tracker.plan({ purpose: step.purpose, live });
        if (plan.save) tracker.save(yield* browser.execute(saveSessionCode, 60));
        if (plan.start === "none") {
          if (live) yield* enter;
          return;
        }
        yield* startPage(
          browser.execute,
          browser.targetId,
          siteOrigin,
          { siteData: plan.start, session: tracker.saved, origins },
          hooks,
        );
        entered = true;
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
    let claimed = false;
    let buildEffect: "read" | "write" | undefined =
      request.effect === "read" || request.effect === "write" ? request.effect : undefined;
    const start = makeBuildStart(
      browser,
      context.siteOrigin,
      context.navigate,
      request.authenticationOrigins ?? [],
    );
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
