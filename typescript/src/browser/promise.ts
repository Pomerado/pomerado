import { Effect } from "effect";
import type { ExecutionServices } from "../runtime/context.js";
import { timeoutDefaults } from "../runtime/deadline.js";
import type { Deadline } from "../runtime/deadline.js";
import { BrowserFailure, DeadlineExceeded } from "../runtime/errors.js";
import type { Dispatch, EventUnavailable } from "../runtime/errors.js";

export interface BrowserCall {
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
}

export interface PromiseOptions {
  readonly deadline?: Deadline;
  readonly timeoutMs?: number;
  readonly dispatch?: Dispatch;
}

export const browserPromise = <Value>(
  context: ExecutionServices,
  name: string,
  call: (options: BrowserCall) => Promise<Value>,
  options: PromiseOptions = {},
): Effect.Effect<Value, BrowserFailure | DeadlineExceeded | EventUnavailable> =>
  Effect.suspend(() => {
    const pwTimeoutSource = options.timeoutMs === undefined ? "action_default" : "explicit_option";
    const deadline = context.deadline
      .limitTo(options.deadline ?? context.deadline)
      .child(options.timeoutMs ?? timeoutDefaults.action);
    const dispatch = options.dispatch ?? "unknown";
    const remaining = deadline.remainingMs();
    if (remaining <= 0) {
      return Effect.fail(
        new DeadlineExceeded({ phase: name, dispatch: "not_sent", pwTimeoutSource }),
      );
    }
    return Effect.gen(function* () {
      yield* context.events.emit("browser.call_started", { name, remainingMs: remaining });
      if (deadline.remainingMs() <= 0) {
        return yield* new DeadlineExceeded({ phase: name, dispatch: "not_sent", pwTimeoutSource });
      }
      return yield* Effect.tryPromise({
        try: (signal) => call({ signal, remainingMs: () => Math.max(1, deadline.remainingMs()) }),
        catch: (cause) => new BrowserFailure({ operation: name, dispatch, cause }),
      }).pipe(
        Effect.timeoutFail({
          duration: deadline.remainingMs(),
          onTimeout: () => new DeadlineExceeded({ phase: name, dispatch, pwTimeoutSource }),
        }),
      );
    });
  });
