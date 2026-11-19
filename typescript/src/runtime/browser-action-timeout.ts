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
 * Each reason the runtime's page waits and pager fail with, at the start of the failure's message,
 * marked by which a page wait that ends without its answer gives: `cap` at its cap while the page
 * keeps progressing, `quiet` once the page stopped progressing. Every other reason is `false`.
 */
export const pageWaitReasons = {
  outcome_timeout: "cap",
  outcome_unknown: "quiet",
  outcome_ambiguous: false,
  outcome_refused: false,
  values_timeout: "cap",
  values_loading: "quiet",
  page_mismatch: "quiet",
  change_unknown: "quiet",
  ready_timeout: "cap",
  not_ready: "quiet",
  ready_ambiguous: false,
  pager_no_control: false,
  pager_step_timeout: false,
  pager_ambiguous: false,
  pager_stalled: false,
  pager_page_unreachable: false,
} as const;

const nativeTimeout =
  /^(?:TimeoutError:\s*)?(?:locator|page|frame)\.[A-Za-z]+: Timeout (\d+)ms exceeded\b/u;
const pageWaitTimeout = new RegExp(
  `^(?:(?:OutcomeWait|ValueWait|ReadyWait)Failure:\\s*)?(${Object.entries(pageWaitReasons)
    .flatMap(([reason, ran]) => (ran === false ? [] : [reason]))
    .join("|")}) after (\\d+) ms\\b`,
  "u",
);

/**
 * A settled timeout in Kernel's answer (`nativeActionTimeout`): the length of the timer that ran
 * out, and a page wait's reason.
 */
export const settledTimeout = (answer: {
  readonly success: boolean;
  readonly error?: string;
}): { readonly ms: number; readonly reason?: keyof typeof pageWaitReasons } | undefined => {
  if (answer.success !== false || typeof answer.error !== "string") return undefined;
  const native = nativeTimeout.exec(answer.error);
  if (native !== null) return { ms: Number(native[1]) };
  const wait = pageWaitTimeout.exec(answer.error);
  return wait === null
    ? undefined
    : { ms: Number(wait[2]), reason: wait[1] as keyof typeof pageWaitReasons };
};

/**
 * Only Kernel's failed response establishes a settled timeout: a native action's, or one of the
 * runtime's page waits that ended without its answer: no outcome, values still loading or a needed
 * one missing, or a control not ready to act on, within its cap or once the page stopped progressing.
 */
export const nativeActionTimeout = (answer: {
  readonly success: boolean;
  readonly error?: string;
}): string | undefined => (settledTimeout(answer) === undefined ? undefined : answer.error);
