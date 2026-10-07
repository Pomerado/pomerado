import { Effect, Option } from "effect";
import { ExecutionContext } from "../../src/runtime/context.js";
import { runKernelScript } from "../../src/runtime/kernel-operation.js";
import type { KernelExecuteClient, KernelOperation } from "../../src/runtime/kernel-operation.js";
import {
  decodeKernelOperationInput,
  validateKernelOperationOutput,
} from "../../src/runtime/kernel-operation-validation.js";
import { ScriptInput } from "../../src/runtime/script-input.js";

type ScriptBrowser = Omit<
  Parameters<typeof runKernelScript>[2],
  "deadline" | "journal" | "scriptInput"
>;

/**
 * One run of a Kernel script wired as the local runner wires it
 * (`execution/local-operation-child.ts`): the write's commit steps declared, the input decoded,
 * each call marked as a possible dispatch before it is sent, and the output validated. The
 * deadline and journal come from the execution context, and the caller's questions from
 * `ScriptInput` when one is provided.
 */
export const runKernelOperation = <Input, EncodedInput, Output, EncodedOutput>(
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  rawInput: unknown,
  browser: ScriptBrowser,
) =>
  Effect.gen(function* () {
    const { deadline, journal } = yield* ExecutionContext;
    yield* journal.declareCommits(operation.write?.commits ?? []);
    const input = yield* decodeKernelOperationInput(operation, rawInput);
    const kernel: KernelExecuteClient = {
      browsers: {
        playwright: {
          execute: (sessionId, body, options) => {
            Effect.runSync(journal.enteringDispatch);
            return browser.kernel.browsers.playwright.execute(sessionId, body, options);
          },
        },
      },
    };
    const scriptInput = yield* Effect.serviceOption(ScriptInput);
    const output = yield* runKernelScript(operation, input, {
      ...browser,
      kernel,
      deadline,
      journal,
      ...(Option.isSome(scriptInput) ? { scriptInput: scriptInput.value } : {}),
    });
    return yield* validateKernelOperationOutput(operation, output);
  });
