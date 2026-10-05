import { cp, mkdir } from "node:fs/promises";
import { Effect } from "effect";

const copy = (from: string, to: string) =>
  Effect.tryPromise(() => cp(from, to, { recursive: true }));
Effect.runPromise(
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      mkdir("dist/typescript/src/guardian", { recursive: true }),
    );
    yield* copy("typescript/authoring", "dist/typescript/authoring");
    yield* copy(
      "typescript/src/guardian/upstream-policy.md",
      "dist/typescript/src/guardian/upstream-policy.md",
    );
  }),
).catch((error: unknown) => {
  process.stderr.write(`Could not copy package assets: ${String(error)}\n`);
  process.exitCode = 1;
});
