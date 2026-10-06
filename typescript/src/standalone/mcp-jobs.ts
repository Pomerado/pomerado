import { randomUUID } from "node:crypto";
import { Cause, Clock, Data, Deferred, Effect, Either, Fiber, type Scope } from "effect";
import { MintFailure } from "../mint/contracts.js";
import { ReviewFailure } from "../guardian/review.js";
import { modelFailureMetadata } from "../models/model-failure.js";
import { LocalOperationFailure } from "../execution/local-operation.js";
import { makeInputAsker } from "../inputs/callback.js";
import {
  InputRequestFailure,
  maximumInputWaitMs,
  validateAnswer,
  type InputAnswers,
  type InputAsker,
  type InputRequest,
} from "../runtime/input-request.js";

interface PendingInput {
  readonly request: InputRequest;
  readonly expiresAt: number;
  readonly answer: Deferred.Deferred<InputAnswers, InputRequestFailure>;
}
interface Job {
  readonly id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  changed: Deferred.Deferred<void>;
  readonly inputPermit: Effect.Semaphore;
  pending?: PendingInput;
  output?: unknown;
  finishedAt?: number;
  error?: string;
  fiber?: Fiber.RuntimeFiber<void>;
}
export interface McpJobView {
  readonly job_id: string;
  readonly status: "running" | "input_required" | "completed" | "failed" | "cancelled";
  readonly output?: unknown;
  readonly pending_input?: InputRequest & { readonly expires_at: string };
  readonly next?: { readonly tool: string; readonly arguments: Record<string, unknown> };
  readonly error?: string;
}
const terminalRetentionMs = 15 * 60_000;
class McpJobFailure extends Data.TaggedError("McpJobFailure")<{
  readonly code: "busy" | "unknown_job" | "stale_input" | "invalid_answers";
}> {}
const requestErrors = {
  busy: "The server is busy. Wait for or cancel its active job.",
  unknown_job: "Unknown or expired job.",
  stale_input: "This input request is no longer pending.",
  invalid_answers: "Answers do not match the pending questions.",
};
export const mcpFailureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (error instanceof McpJobFailure) return requestErrors[error.code];
  if (error instanceof ReviewFailure) return `Guardian review failed (${error.code}).`;
  if (error instanceof MintFailure) return `Mint failed (${error.code}).`;
  if (error instanceof InputRequestFailure) return `Input could not be completed (${error.code}).`;
  // The tool's own InvalidInput says which value the task or site refuses, for the caller to fix.
  // A schema decode failure carries only its name, which the generic message below covers.
  if (
    error instanceof LocalOperationFailure &&
    error.code === "InvalidInput" &&
    error.message !== "InvalidInput"
  )
    return `Operation failed (InvalidInput): ${error.message}`;
  if (
    error instanceof LocalOperationFailure &&
    ["InvalidInput", "InvalidOutput", "NoResponse"].includes(error.code ?? "")
  )
    return `Operation failed (${error.code}).`;
  const metadata = modelFailureMetadata(error);
  if (metadata.httpStatus === 401 || metadata.code === "invalid_api_key")
    return "Model provider authentication failed. Check the server's model configuration.";
  if (metadata.httpStatus === 429) return "Model provider quota or rate limit was reached.";
  return "Operation failed. Check the local model, browser and integration configuration.";
};
const signalChange = (job: Job) =>
  Effect.gen(function* () {
    const previous = job.changed;
    job.changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });
const snapshot = (job: Job): McpJobView => {
  if (job.pending !== undefined)
    return {
      job_id: job.id,
      status: "input_required",
      pending_input: {
        ...job.pending.request,
        expires_at: new Date(job.pending.expiresAt).toISOString(),
      },
      next: {
        tool: "provide_input",
        arguments: { job_id: job.id, request_id: job.pending.request.id },
      },
    };
  return {
    job_id: job.id,
    status: job.status,
    ...(job.status === "completed" ? { output: job.output } : {}),
    ...(job.status === "running"
      ? { next: { tool: "get_job", arguments: { job_id: job.id } } }
      : {}),
    ...(job.status === "failed"
      ? {
          error: `${job.error ?? "Operation failed."} A dispatched website action may have taken effect; this job will not be replayed.`,
        }
      : {}),
  };
};
const pendingAnswer = (job: Job, request: InputRequest, expiresAt: number) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const pending = {
        request,
        expiresAt,
        answer: yield* Deferred.make<InputAnswers, InputRequestFailure>(),
      };
      job.pending = pending;
      yield* signalChange(job);
      return pending;
    }),
    (pending) => Deferred.await(pending.answer),
    (pending) =>
      Effect.gen(function* () {
        if (job.pending === pending) delete job.pending;
        yield* signalChange(job);
      }),
  );
const jobAsker =
  (job: Job): InputAsker =>
  (request, bounds) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = Math.min(
        bounds?.sourceEndsAt ?? Number.POSITIVE_INFINITY,
        now + maximumInputWaitMs,
      );
      return yield* makeInputAsker((checked) =>
        job.inputPermit.withPermits(1)(pendingAnswer(job, checked, expiresAt)),
      )(request, {
        ...bounds,
        sourceEndsAt: expiresAt,
      });
    });
const settle = (job: Job, work: Effect.Effect<unknown, Error, Scope.Scope>) =>
  Effect.scoped(work).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.gen(function* () {
          job.status = Cause.isInterruptedOnly(cause) ? "cancelled" : "failed";
          job.error = mcpFailureMessage(cause);
          job.finishedAt = yield* Clock.currentTimeMillis;
          yield* signalChange(job);
        }),
      onSuccess: (output) =>
        Effect.gen(function* () {
          job.output = output;
          job.status = "completed";
          job.finishedAt = yield* Clock.currentTimeMillis;
          yield* signalChange(job);
        }),
    }),
  );
/** Jobs survive individual tool calls, but never their owning stdio server scope. */
export const makeMcpJobs = (maxJobs = 1) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const jobs = new Map<string, Job>();
    const prune = (now: number) => {
      for (const [id, job] of jobs)
        if (job.finishedAt !== undefined && now - job.finishedAt >= terminalRetentionMs)
          jobs.delete(id);
      const completed = [...jobs.values()].filter((job) => job.finishedAt !== undefined);
      for (const job of completed.slice(0, Math.max(0, jobs.size - 31))) jobs.delete(job.id);
    };
    const find = (id: string) =>
      Effect.gen(function* () {
        prune(yield* Clock.currentTimeMillis);
        const job = jobs.get(id);
        return job === undefined
          ? yield* Effect.fail(new McpJobFailure({ code: "unknown_job" }))
          : job;
      });
    const start = (work: (ask: InputAsker) => Effect.Effect<unknown, Error, Scope.Scope>) =>
      Effect.gen(function* () {
        prune(yield* Clock.currentTimeMillis);
        if ([...jobs.values()].filter((job) => job.finishedAt === undefined).length >= maxJobs)
          return yield* Effect.fail(new McpJobFailure({ code: "busy" }));
        const job: Job = {
          id: randomUUID(),
          status: "running",
          changed: yield* Deferred.make<void>(),
          inputPermit: yield* Effect.makeSemaphore(1),
        };
        jobs.set(job.id, job);
        job.fiber = yield* Effect.forkIn(
          settle(
            job,
            Effect.suspend(() => work(jobAsker(job))),
          ).pipe(Effect.interruptible),
          scope,
        );
        return snapshot(job);
      }).pipe(Effect.uninterruptible);
    const get = (id: string, waitMs = 0) =>
      Effect.gen(function* () {
        const job = yield* find(id);
        if (job.status === "running" && job.pending === undefined && waitMs > 0)
          yield* Effect.raceFirst(Deferred.await(job.changed), Effect.sleep(waitMs));
        return snapshot(job);
      });
    const provide = (id: string, requestId: string, answers: InputAnswers) =>
      Effect.gen(function* () {
        const job = yield* find(id);
        const pending = job.pending;
        const now = yield* Clock.currentTimeMillis;
        if (pending === undefined || pending.request.id !== requestId || now >= pending.expiresAt)
          return yield* Effect.fail(new McpJobFailure({ code: "stale_input" }));
        if (Either.isLeft(validateAnswer(pending.request, answers)))
          return yield* Effect.fail(new McpJobFailure({ code: "invalid_answers" }));
        // Remove the request before waking its fiber, so a second submission cannot answer it again.
        delete job.pending;
        yield* Deferred.succeed(pending.answer, answers);
        yield* signalChange(job);
        return snapshot(job);
      });
    const cancel = (id: string) =>
      Effect.gen(function* () {
        const job = yield* find(id);
        if (job.finishedAt === undefined && job.fiber !== undefined) {
          yield* Fiber.interrupt(job.fiber);
          job.status = "cancelled";
          job.finishedAt = yield* Clock.currentTimeMillis;
          delete job.pending;
          yield* signalChange(job);
        }
        return snapshot(job);
      });
    return { start, get, provide, cancel };
  });
export type McpJobs = Effect.Effect.Success<ReturnType<typeof makeMcpJobs>>;
