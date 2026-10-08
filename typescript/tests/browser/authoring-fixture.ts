import type { Page } from "playwright";
import { Effect, Either } from "effect";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { siteDomain } from "../../src/runtime/same-site.js";
import type {
  DialogDecider,
  KernelExecuteClient,
  KernelOperation,
} from "../../src/runtime/kernel-operation.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";

// The authoring examples, run through the runtime as the local runner wires a run, on the saved-DOM
// stand-in for Kernel, which runs each call's code as Kernel does, with `page` in scope, here on a
// local page. The site domain is
// the host's, computed from the site origin as the sandbox's browser binding carries it.
export const runExample = async <Input, EncodedInput, Output, EncodedOutput>(
  page: Page,
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  input: unknown,
  options: {
    readonly siteOrigin?: string;
    readonly deadlineMs?: number;
    readonly dialogs?: DialogDecider;
  } = {},
) => {
  const calls: string[] = [];
  const domain = options.siteOrigin === undefined ? undefined : siteDomain(options.siteOrigin);
  const local = makeLocalKernel(page);
  const kernel: KernelExecuteClient = {
    browsers: {
      playwright: {
        execute: (sessionId, body, requestOptions) => {
          calls.push(body.code);
          return local.browsers.playwright.execute(sessionId, body, requestOptions);
        },
      },
    },
  };
  const journal = await Effect.runPromise(makeEffectJournal);
  const result = await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        executeKernelOperation(operation, input, {
          kernel,
          sessionId: "session-1",
          ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
          ...(domain === undefined ? {} : { siteDomain: domain }),
          ...(options.dialogs === undefined ? {} : { dialogs: options.dialogs }),
        }).pipe(
          Effect.provideService(ExecutionContext, {
            deadline: Deadline.after(options.deadlineMs ?? 10_000),
            journal,
            events: { emit: () => Effect.void },
            capture: { start: Effect.void, finish: Effect.void },
          }),
        ),
      ),
    ),
  );
  return {
    result,
    calls,
    effect: await Effect.runPromise(journal.state),
    confirmation: await Effect.runPromise(journal.confirmation),
    commits: await Effect.runPromise(journal.commits),
  };
};

/** The typed failure, for matching its tag, message and dispatch. */
export const failure = (result: Either.Either<unknown, unknown>): unknown =>
  Either.isLeft(result) ? result.left : undefined;
