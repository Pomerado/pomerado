// Failure modes covered: a call that must run alone starts beside a plain call, or a plain call
// beside it; a plain call sent after a waiting call that runs alone passes it; a call interrupted
// while it waits keeps its turn or places; and calls overlap when only one may run at a time.
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { makeCallGate } from "../../src/execution/playwright-protocol.js";

const plain = { kind: "execute" } as const;
const watch = { kind: "execute", watch: ["111111"] } as const;
const credential = { kind: "credential" } as const;

/**
 * Lets queued work run: a released semaphore wakes its waiters on a scheduled task, so a waiter that
 * could start has started once these yields are done.
 */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow(), {
  discard: true,
});

/** A gate whose calls each say when they start and run until released. */
const gateFor = (callsAtOnce: number) =>
  Effect.gen(function* () {
    const gate = yield* makeCallGate(callsAtOnce);
    const send = (request: Parameters<typeof gate>[0]) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const work = Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
        );
        const fiber = yield* Effect.fork(gate(request)(work));
        return {
          fiber,
          started: Deferred.isDone(started),
          whenStarted: Deferred.await(started),
          finish: Deferred.succeed(release, undefined).pipe(Effect.zipRight(Fiber.join(fiber))),
        };
      });
    return send;
  });

const run = <A>(test: Effect.Effect<A>) => Effect.runPromise(test);

describe("the page call gate", () => {
  it("starts a call that runs alone only once the plain calls running have finished", () =>
    run(
      Effect.gen(function* () {
        const send = yield* gateFor(3);
        const first = yield* send(plain);
        yield* first.whenStarted;
        const alone = yield* send(credential);
        yield* settle;
        expect(yield* alone.started).toBe(false);
        yield* first.finish;
        yield* alone.whenStarted;
        yield* alone.finish;
      }),
    ));

  it("keeps a plain call off the page while a call that runs alone runs", () =>
    run(
      Effect.gen(function* () {
        const send = yield* gateFor(3);
        const alone = yield* send(watch);
        yield* alone.whenStarted;
        const later = yield* send(plain);
        yield* settle;
        expect(yield* later.started).toBe(false);
        yield* alone.finish;
        yield* later.whenStarted;
        yield* later.finish;
      }),
    ));

  it("keeps a plain call sent after a waiting call that runs alone behind it", () =>
    run(
      Effect.gen(function* () {
        const send = yield* gateFor(2);
        const first = yield* send(plain);
        yield* first.whenStarted;
        const alone = yield* send(watch);
        yield* settle;
        // A place is free, but the call that runs alone waits for it and the plain call after it.
        const later = yield* send(plain);
        yield* settle;
        expect(yield* later.started).toBe(false);
        yield* first.finish;
        yield* alone.whenStarted;
        yield* settle;
        expect(yield* later.started).toBe(false);
        yield* alone.finish;
        yield* later.whenStarted;
        yield* later.finish;
      }),
    ));

  it("gives back the turn and places of a call interrupted while it waits", () =>
    run(
      Effect.gen(function* () {
        const send = yield* gateFor(2);
        const first = yield* send(plain);
        yield* first.whenStarted;
        // The call that runs alone holds the turn while it waits; the plain call waits for the turn.
        const alone = yield* send(credential);
        yield* settle;
        const later = yield* send(plain);
        yield* settle;
        expect(yield* later.started).toBe(false);
        yield* Fiber.interrupt(alone.fiber);
        yield* later.whenStarted;
        expect(yield* alone.started).toBe(false);
        // With both plain calls done, every place is free for another call that runs alone.
        yield* first.finish;
        yield* later.finish;
        const next = yield* send(watch);
        yield* next.whenStarted;
        yield* next.finish;
      }),
    ));

  it("gives back the turn of a plain call interrupted while it waits for a place", () =>
    run(
      Effect.gen(function* () {
        const send = yield* gateFor(1);
        const first = yield* send(plain);
        yield* first.whenStarted;
        const waiting = yield* send(plain);
        yield* settle;
        const later = yield* send(plain);
        yield* settle;
        yield* Fiber.interrupt(waiting.fiber);
        yield* first.finish;
        yield* later.whenStarted;
        yield* later.finish;
      }),
    ));

  it("runs one call at a time when one may run at once", () =>
    run(
      Effect.gen(function* () {
        const send = yield* gateFor(1);
        const first = yield* send(plain);
        yield* first.whenStarted;
        const second = yield* send(plain);
        yield* settle;
        expect(yield* second.started).toBe(false);
        yield* first.finish;
        yield* second.whenStarted;
        const third = yield* send(watch);
        yield* settle;
        expect(yield* third.started).toBe(false);
        yield* second.finish;
        yield* third.whenStarted;
        yield* third.finish;
      }),
    ));
});
