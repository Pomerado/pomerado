import { describe, expect, it } from "vitest";
import {
  nativeActionTimeout,
  pageWaitReasons,
  settledTimeout,
} from "../../src/runtime/browser-action-timeout.js";

/** The reading of a page wait's failure from before its reasons were one table. */
const before =
  /^(?:(?:OutcomeWait|ValueWait|ReadyWait)Failure:\s*)?(?:outcome_(?:timeout|unknown)|values_(?:loading|timeout)|page_mismatch|change_unknown|not_ready|ready_timeout) after \d+ ms\b/u;

const names = ["", "OutcomeWaitFailure: ", "ValueWaitFailure:", "ReadyWaitFailure:  ", "PagerFailure: ", "Error: "];
const rests = [
  " after 9105 ms, 8000 ms without progress: total missing",
  " after 30000 ms",
  " after 30000ms",
  ": results 2 visible of 2",
];

describe("a settled timeout in Kernel's answer", () => {
  it.each([...Object.keys(pageWaitReasons), "values_unavailable", "outcome_timeouts"])(
    "reads a failure with %s as before",
    (reason) => {
      for (const error of names.flatMap((name) => rests.map((rest) => name + reason + rest))) {
        const timedOut = before.test(error);
        expect(nativeActionTimeout({ success: false, error })).toBe(timedOut ? error : undefined);
        expect(settledTimeout({ success: false, error })?.reason).toBe(timedOut ? reason : undefined);
      }
    },
  );

  it.each([
    ["TimeoutError: locator.click: Timeout 30000ms exceeded.", 30_000],
    ["frame.waitForSelector: Timeout 5000ms exceeded.", 5_000],
    ["ValueWaitFailure: page_mismatch after 9105 ms, 8000 ms without progress: total missing", 9_105],
    ["page.goto: net::ERR_TIMED_OUT at https://shop.example/search", undefined],
  ])("reads the timer that ran out in %j", (error, ms) => {
    expect(settledTimeout({ success: false, error })?.ms).toBe(ms);
    expect(settledTimeout({ success: true, error })).toBeUndefined();
  });
});
