import { Cause, Deferred, Effect, Ref } from "effect";
import { expect, it } from "vitest";
import { makeMcpJobs, mcpFailureMessage, type McpJobs } from "../../src/standalone/mcp-jobs.js";

/** Polls a job until it leaves running, as a caller polling get_job does. */
const finished = (jobs: McpJobs, id: string) =>
  Effect.gen(function* () {
    let view = yield* jobs.get(id, 200);
    for (let attempt = 0; attempt < 20 && view.status === "running"; attempt++)
      view = yield* jobs.get(id, 200);
    return view;
  });

/** Work that counts its runs, as each website write would. */
const countingWork = (runs: Ref.Ref<number>) => () =>
  Ref.updateAndGet(runs, (count) => count + 1).pipe(Effect.map((count) => ({ saved: count })));

it("runs the work again for a second call without a key once the first finished", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const runs = yield* Ref.make(0);
        const first = yield* jobs.start(countingWork(runs));
        const firstView = yield* finished(jobs, first.job_id);
        const second = yield* jobs.start(countingWork(runs));
        const secondView = yield* finished(jobs, second.job_id);
        return { first, firstView, second, secondView, runs: yield* Ref.get(runs) };
      }),
    ),
  );
  expect(result.runs).toBe(2);
  expect(result.second.job_id).not.toBe(result.first.job_id);
  expect(result.firstView).toMatchObject({ status: "completed", output: { saved: 1 } });
  expect(result.secondView).toMatchObject({ status: "completed", output: { saved: 2 } });
});

it("refuses a call without a key as busy while another job runs", async () => {
  const message = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const gate = yield* Deferred.make<void>();
        yield* jobs.start(() => Deferred.await(gate));
        const refused = yield* Effect.flip(jobs.start(() => Effect.succeed({ saved: true })));
        yield* Deferred.succeed(gate, undefined);
        return mcpFailureMessage(Cause.fail(refused), "run");
      }),
    ),
  );
  expect(message).toBe("The server is busy. Wait for or cancel its active job.");
});
