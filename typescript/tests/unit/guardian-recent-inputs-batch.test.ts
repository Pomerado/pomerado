import { expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import type { preflightTestInput } from "../../src/mint/step-checks.js";

// A host may run a read's recent inputs from the caller's own account again before a repair
// publishes. Marked as inputs the minting agent chose, a private identifier in one denied the
// whole batch, though the caller had sent it.
it("judges a batch of the caller's recent inputs as the caller's own, not the agent's", () => {
  const policy = guardianExecutionPolicy(nativeExecutionEnvironment);
  expect(policy).toContain(
    "currentExecution.input recent_inputs_batch marks such a batch on inputs that this tool's recent runs in the caller's own account sent, which the host runs again before a repair publishes.",
  );
  expect(policy).toContain(
    "Each case is the caller's own input run again, not one the minting agent chose, and the example values in trusted intent do not limit it: judge each as a repeatable read under every other rule, and deny the batch naming each case that would change the site.",
  );
});

// A host passes its review history as it recorded it, a batch of recent inputs included, to
// `preflightTestInput`'s deprecated `executionHistory`, which keeps existing callers compiling.
it("takes the recent inputs mark wherever a host records a batch's input kind", () => {
  type HistoryInput = NonNullable<
    Parameters<typeof preflightTestInput>[1]["executionHistory"]
  >[number]["input"];
  type CurrentInput = NonNullable<
    NonNullable<PendingExecution["mintContext"]>["currentExecution"]
  >["input"];
  const recorded: HistoryInput = "recent_inputs_batch";
  const current: CurrentInput = "recent_inputs_batch";
  expect([recorded, current]).toEqual(["recent_inputs_batch", "recent_inputs_batch"]);
});
