import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  LocalOperationFailure,
  type LocalOperationJournal,
} from "../../src/execution/local-operation.js";
import { makeMcpJobs } from "../../src/standalone/mcp-jobs.js";

/*
 * What a served run's failed job says today. Every failure after sign-in carries the same
 * warning, whatever its journal shows, and the job names no finite code, write status, possible
 * commit or retry class.
 */
const warning = "A dispatched website action may have taken effect; this job will not be replayed.";

const failedRunJob = (error: Error) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const started = yield* jobs.start(() => Effect.fail(error));
        let current = yield* jobs.get(started.job_id, 500);
        for (let attempt = 0; attempt < 5 && current.status === "running"; attempt++)
          current = yield* jobs.get(started.job_id, 500);
        return current;
      }),
    ),
  );

const nothingSent: LocalOperationJournal = { effect: "not_sent", commits: [] };
const commitNotEntered: LocalOperationJournal = {
  effect: "possible",
  commits: [{ name: "save", state: "not_sent" }],
};
const confirmedWrite: LocalOperationJournal = {
  effect: "verified",
  confirmation: "message",
  commits: [{ name: "save", state: "confirmed" }],
};

it.each([
  {
    case: "a refused input before anything was dispatched",
    failure: new LocalOperationFailure(
      "The date must be in the future.",
      nothingSent,
      "InvalidInput",
      "InvalidInput",
    ),
    error: `Operation failed (InvalidInput): The date must be in the future. ${warning}`,
  },
  {
    case: "a refused input whose declared commit was never entered",
    failure: new LocalOperationFailure(
      "The date must be in the future.",
      commitNotEntered,
      "InvalidInput",
      "InvalidInput",
    ),
    error: `Operation failed (InvalidInput): The date must be in the future. ${warning}`,
  },
  {
    case: "an unanswered question before anything was dispatched",
    failure: new LocalOperationFailure(
      "NoResponse",
      nothingSent,
      "NoResponse",
      "ScriptInputFailure",
    ),
    error: `Operation failed (NoResponse). ${warning}`,
  },
  {
    case: "invalid output after a confirmed write",
    failure: new LocalOperationFailure(
      "InvalidOutput",
      confirmedWrite,
      "InvalidOutput",
      "InvalidOutput",
    ),
    error: `Operation failed (InvalidOutput). ${warning}`,
  },
  {
    case: "a script error before anything was dispatched",
    failure: new LocalOperationFailure("Fixture failure", nothingSent),
    error: `Operation failed. Check the local browser and integration configuration. ${warning}`,
  },
  {
    case: "an expired deadline after a commit was entered",
    failure: new LocalOperationFailure(
      "Local operation deadline expired; execution was not replayed",
      { effect: "possible", commits: [{ name: "save", state: "sent" }] },
    ),
    error: `Operation failed. Check the local browser and integration configuration. ${warning}`,
  },
])("today, $case gives the same warning and no outcome fields", async ({ failure, error }) => {
  const view = await failedRunJob(failure);
  expect(view).toEqual({ job_id: view.job_id, status: "failed", error });
});
