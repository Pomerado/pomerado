import { expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";

// A host may run a read's recent inputs from the caller's own account again before a repair
// publishes. Marked as inputs the minting agent chose, a private identifier in one denied the
// whole batch, though the caller had sent it.
it("judges a batch of the caller's recent inputs as the caller's own, not the agent's", () => {
  const policy = guardianExecutionPolicy(nativeExecutionEnvironment);
  expect(policy).toContain(
    "currentExecution.input recent_inputs_batch marks the same batch on inputs that this tool's recent runs in the caller's own account sent, which the host runs again before a repair publishes.",
  );
  expect(policy).toContain(
    "Each case is the caller's own input run again, not one the minting agent chose: judge each as a repeatable read, and deny the batch naming each case that would change the site.",
  );
});
