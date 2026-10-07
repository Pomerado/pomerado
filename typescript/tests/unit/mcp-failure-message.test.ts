import { Cause, Effect } from "effect";
import { expect, it } from "vitest";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { makeMcpJobs, mcpFailureMessage } from "../../src/standalone/mcp-jobs.js";

const mintFallback =
  "Operation failed. Check the local model, browser and integration configuration.";
const runFallback = "Operation failed. Check the local browser and integration configuration.";

it("keeps minting's fallback failure message", () => {
  const cause = Cause.fail(new Error("Unclassified failure"));
  expect(mcpFailureMessage(cause)).toBe(mintFallback);
  expect(mcpFailureMessage(cause, "mint")).toBe(mintFallback);
});

it("gives a run's fallback failure no model, because a run makes no model request", () => {
  const message = mcpFailureMessage(Cause.fail(new Error("Unclassified failure")), "run");
  expect(message).toBe(runFallback);
  expect(message).not.toContain("model");
});

it("reports a failed run job with the run message", async () => {
  const view = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const started = yield* jobs.start(() => Effect.fail(new Error("Unclassified failure")));
        let current = yield* jobs.get(started.job_id, 500);
        for (let attempt = 0; attempt < 5 && current.status === "running"; attempt++)
          current = yield* jobs.get(started.job_id, 500);
        return current;
      }),
    ),
  );
  expect(view).toMatchObject({
    status: "failed",
    error: `${runFallback} A dispatched website action may have taken effect; this job will not be replayed.`,
  });
});

it("says why a run's sign-in failed and what to do, naming the field and never a value", () => {
  expect(
    mcpFailureMessage(
      Cause.fail(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })),
      "run",
    ),
  ).toBe(
    "Sign-in failed (CredentialsRejected): The website rejected the password given for this sign-in, and the run sends it no more. Run the tool again with the right value.",
  );
  expect(
    mcpFailureMessage(
      Cause.fail(new SignInRunFailed({ code: "MissingRecipe", reason: "unknown_version" })),
      "run",
    ),
  ).toBe(
    "Sign-in failed (MissingRecipe): The tool's saved sign-in can't be read (unknown version), so the tool doesn't run signed out. Build the tool again.",
  );
});
