import { Effect, type Scope } from "effect";
import type { Pomerado, PomeradoOptions } from "./contracts.js";
import { makeSession } from "./session.js";
import { requestContext } from "./request-context.js";
import { mintRequest } from "./mint-host.js";
import { runOperation } from "./run-operation.js";
export { Artifact } from "./contracts.js";
export type {
  Pomerado,
  PomeradoOptions,
  PomeradoRequest,
  MintArtifact,
  MintOutcome,
} from "./contracts.js";
/** A scoped session owns its browser, so a minted operation can run in the same signed-in session. */
export const createPomerado = (
  options: PomeradoOptions,
): Effect.Effect<Pomerado, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* makeSession(options);
    const mint: Pomerado["mint"] = (request) =>
      session.mutex.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* requestContext(session, request);
            return yield* mintRequest(session, context, request);
          }),
        ),
      );
    const run: Pomerado["run"] = (artifact, request) =>
      session.mutex.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* requestContext(session, request);
            return yield* runOperation(session, context, artifact, request);
          }),
        ),
      );
    return { mint, run };
  });
