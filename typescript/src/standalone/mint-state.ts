import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import type { LocalOperationJournal } from "../execution/local-operation.js";
import type { ExecutionRequest } from "../mint/contracts.js";
import { makeSecretHandles } from "../mint/secret-handles.js";
import { loadStandaloneAuthoring } from "../mint/skills.js";
import { Deadline } from "../runtime/deadline.js";
import type { InputAsker } from "../runtime/input-request.js";
import { makeAfterSubmit } from "./after-submit.js";
import { makeLiveAuthentication } from "./authentication.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import type { PomeradoRequest } from "./contracts.js";
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
    let navigationStarted = false;
    const navigate = Effect.suspend(() =>
      navigationStarted
        ? Effect.void
        : context.navigate.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                navigationStarted = true;
              }),
            ),
          ),
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
      afterSubmit,
      navigate,
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
