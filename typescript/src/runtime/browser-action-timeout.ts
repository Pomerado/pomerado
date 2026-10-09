import type { Dispatch } from "./errors.js";
import type { OperationFailure } from "./kernel-operation.js";

/** A completed provider call whose native browser action timed out, not a lost execution. */
export class BrowserActionTimeout extends Error {
  readonly _tag = "BrowserActionTimeout";
  readonly dispatch: Dispatch;
  constructor(failure: OperationFailure) {
    super(failure.message, { cause: failure });
    this.name = "BrowserActionTimeout";
    this.dispatch = failure.dispatch;
  }
}

/**
 * Only Kernel's failed response establishes a settled timeout: a native action's, or the authoring
 * library's `waitForOutcome` that saw no outcome within its own timeout.
 */
export const nativeActionTimeout = (answer: {
  readonly success: boolean;
  readonly error?: string;
}): string | undefined =>
  answer.success === false &&
  typeof answer.error === "string" &&
  (/^(?:TimeoutError:\s*)?(?:locator|page|frame)\.[A-Za-z]+: Timeout \d+ms exceeded\b/u.test(
    answer.error,
  ) ||
    /^(?:OutcomeWaitFailure:\s*)?outcome_timeout after \d+ ms:/u.test(answer.error))
    ? answer.error
    : undefined;
