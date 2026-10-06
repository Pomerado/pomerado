#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Cause, Effect, Exit, Schema } from "effect";
import { readArtifact, writeArtifact } from "./artifact-files.js";
import { createPomerado } from "./pomerado.js";
import { makeTerminalAsker } from "../inputs/terminal.js";

const usage = `Pomerado

  pomerado mint --url URL --intent TEXT --out DIRECTORY [--input JSON]
  pomerado run --artifact DIRECTORY --url URL [--input JSON]

Options
  --endpoint URL          Attach to a native Playwright websocket endpoint
  --headed                Show locally launched Chromium
  --effect read|write|ask  Mint authority (default ask)
  --timeout-seconds N      Session budget (default 1200)

Set OPENAI_API_KEY before minting. A run makes no model request and needs no key.
A run ignores --intent and --effect. Questions are asked in this terminal.
`;

const selectedEffect = (supplied: string | undefined) =>
  Schema.decodeUnknown(Schema.Literal("read", "write", "ask"))(supplied ?? "ask").pipe(
    Effect.mapError(() => new Error("Choose a supported --effect. See --help.")),
  );
const selectedTimeout = (supplied: string | undefined) =>
  Effect.try(() => {
    const timeoutMs = Number(supplied ?? "1200") * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("--timeout-seconds must be positive.");
    return timeoutMs;
  });

const readOptions = Effect.gen(function* () {
  const parsed = yield* Effect.try(() =>
    parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        url: { type: "string" },
        intent: { type: "string" },
        out: { type: "string" },
        artifact: { type: "string" },
        input: { type: "string" },
        endpoint: { type: "string" },
        headed: { type: "boolean" },
        effect: { type: "string" },
        "timeout-seconds": { type: "string" },
      },
    }),
  );
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || command === undefined) {
    return undefined;
  }
  if ((command !== "mint" && command !== "run") || positionals.length !== 1)
    return yield* Effect.fail(new Error("Use mint or run. See --help."));
  if (values.url === undefined) return yield* Effect.fail(new Error("--url is required."));
  if (command === "mint" && values.intent === undefined)
    return yield* Effect.fail(new Error("--intent is required to mint."));
  // Guardian checked the intent and authority when the artifact was minted, so a run ignores both.
  const effect = command === "mint" ? yield* selectedEffect(values.effect) : undefined;
  const timeoutMs = yield* selectedTimeout(values["timeout-seconds"]);
  const input = yield* Effect.try({
    try: () => JSON.parse(values.input ?? "{}") as unknown,
    catch: (cause) => new Error("--input must be valid JSON.", { cause }),
  });
  return {
    values,
    command,
    timeoutMs,
    request: {
      url: values.url,
      intent: values.intent ?? "",
      input,
      ...(effect === undefined ? {} : { effect }),
    },
  };
});

const main = Effect.scoped(
  Effect.gen(function* () {
    const options = yield* readOptions;
    if (options === undefined) {
      process.stdout.write(usage);
      return;
    }
    const { values, command, timeoutMs, request } = options;
    const pomerado = yield* createPomerado({
      ask: makeTerminalAsker(),
      timeoutMs,
      browser: {
        headless: !values.headed,
        ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
      },
    });
    if (command === "run") {
      if (values.artifact === undefined)
        return yield* Effect.fail(new Error("--artifact is required."));
      const artifact = yield* readArtifact(resolve(values.artifact));
      const output = yield* pomerado.run(artifact, {
        url: request.url,
        intent: request.intent,
        input: request.input,
      });
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    if (values.out === undefined) return yield* Effect.fail(new Error("--out is required."));
    const outputDirectory = resolve(values.out);
    // Creating the destination first prevents a long mint from overwriting an existing project.
    yield* Effect.tryPromise(() => mkdir(dirname(outputDirectory), { recursive: true }));
    yield* Effect.tryPromise({
      try: () => mkdir(outputDirectory),
      catch: (cause) => new Error("--out must name a new directory.", { cause }),
    });
    const result = yield* pomerado.mint(request);
    if (result.artifact === undefined) {
      process.stderr.write(`${result.summary}\n`);
      process.exitCode = 1;
      return;
    }
    const artifact = result.artifact;
    yield* writeArtifact(outputDirectory, artifact);
    process.stdout.write(`Saved ${artifact.entrypoint} and its schemas to ${outputDirectory}\n`);
  }),
);

const cancel = Effect.runCallback(main, {
  onExit: (result) => {
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      process.stderr.write(`${failure instanceof Error ? failure.message : "Pomerado failed."}\n`);
      process.exitCode = 1;
    }
  },
});
process.once("SIGINT", () => cancel());
process.once("SIGTERM", () => cancel());
