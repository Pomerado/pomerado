import { Effect, Schema } from "effect";

/** A field's one-use binding, as the keyboard's `CredentialTarget` names it. */
const CredentialTarget = Schema.Struct({
  targetId: Schema.optional(Schema.String),
  bindingKey: Schema.String,
  documentOrigin: Schema.String,
});

/** The messages between the native executor and its worker thread. Internal to the executor. */
export const NativeWorkerRequest = Schema.Union(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("execute"),
    code: Schema.String,
    /**
     * Values to watch for: the worker answers which ones a typing call delivered, and in which
     * frame (`typed`).
     */
    watch: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("credential"),
    target: CredentialTarget,
    text: Schema.String,
    /**
     * The keyboard's `InsertionOptions`: read a phone number back, type by keys or by trusted keys,
     * hold each trusted key as a person's press, and the fields the second key on goes into.
     */
    phone: Schema.optional(Schema.Literal(true)),
    keys: Schema.optional(Schema.Literal(true)),
    trustedKeys: Schema.optional(Schema.Literal(true)),
    held: Schema.optional(Schema.Literal(true)),
    across: Schema.optional(Schema.Array(CredentialTarget)),
  }),
);
export const NativeWorkerReply = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    targetId: Schema.String,
    /** The context the worker made and owns; absent for a page it adopted over CDP. */
    contextId: Schema.optional(Schema.String),
  }),
  /** The worker's own connection to a CDP-attached browser closed. */
  Schema.Struct({ kind: Schema.Literal("disconnected") }),
  Schema.Struct({ kind: Schema.Literal("response"), id: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("failure"), id: Schema.String, error: Schema.String }),
);
export const PlaywrightLibrary = Schema.Literal("playwright", "patchright");
export type PlaywrightLibrary = typeof PlaywrightLibrary.Type;
/**
 * Whether a call runs alone on the page: a typing watch patches the page's typing methods and a
 * credential call types into the focused field, so neither shares the page with another call.
 */
export const runsAlone = (request: {
  readonly kind: "execute" | "credential";
  readonly watch?: readonly string[] | undefined;
}) => request.kind !== "execute" || request.watch !== undefined;

/**
 * Admits calls to the page: plain calls `callsAtOnce` at a time, and a call that runs alone once
 * every place is free. Calls take their places in turn. One that runs alone keeps the turn until it
 * has every place, so a plain call sent after it waits behind it instead of passing it while the
 * calls ahead finish. A call interrupted while it waits gives back its turn and places.
 */
export const makeCallGate = (callsAtOnce: number) =>
  Effect.gen(function* () {
    const places = yield* Effect.makeSemaphore(callsAtOnce);
    const turn = yield* Effect.makeSemaphore(1);
    return (request: Parameters<typeof runsAlone>[0]) =>
      <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
        const needed = runsAlone(request) ? callsAtOnce : 1;
        // Each wait is interruptible, and each release is attached as soon as its take returns.
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(turn.take(1));
            yield* restore(places.take(needed)).pipe(Effect.ensuring(turn.release(1)));
            return yield* restore(call).pipe(Effect.ensuring(places.release(needed)));
          }),
        );
      };
  });

export const NativeWorkerOptions = Schema.Struct({
  endpoint: Schema.String,
  startupTimeoutMs: Schema.Number,
  library: PlaywrightLibrary,
  /** The most bytes of JSON a script's result may take; 1 MiB when absent. Output keeps 1 MiB. */
  resultLimitBytes: Schema.optional(Schema.Number),
  /** How many plain page calls run at once; 1 when absent. Any other call runs alone. */
  callsAtOnce: Schema.optional(Schema.Number),
  /** Attach over CDP and drive the browser's own context, at this page (its first when absent). */
  cdp: Schema.optional(Schema.Struct({ targetId: Schema.optional(Schema.String) })),
});
