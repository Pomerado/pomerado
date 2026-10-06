import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { Effect, Schema, type Scope } from "effect";
import { standard } from "../mcp/schema.js";
import { inlineLocalRefs } from "../registry/schema-references.js";
import { InputAnswers } from "../runtime/input-request.js";
import { createPomerado } from "./pomerado.js";
import { type MintArtifact, type PomeradoOptions, type PomeradoRequest } from "./contracts.js";
import { Deployment, validateArtifact } from "./artifact-files.js";
import { makeMcpJobs, mcpFailureMessage, type McpJobs, type McpJobView } from "./mcp-jobs.js";

interface ServerOptions {
  readonly pomerado?: Omit<PomeradoOptions, "ask">;
  readonly maxJobs?: number;
  readonly waitMs?: number;
}
export interface PomeradoMcpOptions extends ServerOptions {
  readonly prepare: (
    request: PomeradoRequest,
    name: string,
  ) => Effect.Effect<
    (artifact: MintArtifact) => Effect.Effect<unknown, Error, Scope.Scope>,
    Error,
    Scope.Scope
  >;
}
export interface IntegrationMcpOptions extends ServerOptions {
  readonly artifact: MintArtifact;
  readonly deployment: Deployment;
}
const JobId = Schema.Struct({ job_id: Schema.UUID });
const GetJob = Schema.Struct({
  job_id: Schema.UUID,
  wait_seconds: Schema.optional(Schema.Number.pipe(Schema.between(0, 30))),
});
const ProvideInput = Schema.Struct({
  job_id: Schema.UUID,
  request_id: Schema.UUID,
  answers: InputAnswers,
});
const helperNames = ["mint", "get_job", "provide_input", "cancel_job"];
const MintRequest = Schema.Struct({
  name: Deployment.fields.name.pipe(Schema.filter((name) => !helperNames.includes(name))),
  ...Deployment.fields.request.fields,
  input: Schema.optional(Schema.Unknown),
});
const completedResult = (output: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(output) ?? "null" }],
  structuredContent:
    typeof output === "object" && output !== null && !Array.isArray(output)
      ? Object.fromEntries(Object.entries(output))
      : { result: output },
});
const jobResult = (view: McpJobView) => completedResult(view);
const toolResponse = (effect: Effect.Effect<CallToolResult, Error>, signal: AbortSignal) =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.succeed({
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${mcpFailureMessage(cause)} Check the existing job status; do not repeat a possible website write.`,
            },
          ],
        }),
      ),
    ),
    { signal },
  );
const helperTools = (server: McpServer, jobs: McpJobs, waitMs: number) => {
  server.registerTool(
    "get_job",
    {
      description:
        "Observe an existing job without starting or replaying work. Returns promptly when input is needed or the job finishes. Jobs are local and disappear when this MCP process stops.",
      inputSchema: standard(GetJob),
      annotations: { readOnlyHint: true },
    },
    (input, context) =>
      toolResponse(
        jobs
          .get(input.job_id, input.wait_seconds === undefined ? waitMs : input.wait_seconds * 1000)
          .pipe(Effect.map(jobResult)),
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "provide_input",
    {
      description:
        "Answer the current job questions using its request_id and answers keyed by question ID. Secret answers sent here are visible to your MCP client and model; ask the user before sending them. No login or secret is saved.",
      inputSchema: standard(ProvideInput),
    },
    (input, context) =>
      toolResponse(
        jobs.provide(input.job_id, input.request_id, input.answers).pipe(Effect.map(jobResult)),
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "cancel_job",
    {
      description:
        "Cancel a local job and wait for resource cleanup. A website action already dispatched may have taken effect. Cancellation never retries it.",
      inputSchema: standard(JobId),
    },
    (input, context) =>
      toolResponse(jobs.cancel(input.job_id).pipe(Effect.map(jobResult)), context.mcpReq.signal),
  );
};
const makeServer = (name: string, options: ServerOptions) =>
  Effect.gen(function* () {
    const maxJobs = options.maxJobs ?? 1;
    const waitMs = options.waitMs ?? 20_000;
    if (
      !Number.isInteger(maxJobs) ||
      maxJobs < 1 ||
      maxJobs > 16 ||
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      waitMs > 30_000
    )
      return yield* Effect.fail(new Error("Invalid MCP job limits."));
    const jobs = yield* makeMcpJobs(maxJobs);
    const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    yield* Effect.addFinalizer(() => Effect.promise(() => server.close()));
    helperTools(server, jobs, waitMs);
    return { server, jobs, waitMs };
  });
/** Discovery registers tools without creating Chromium or invoking a model. */
export const makePomeradoMcp = (options: PomeradoMcpOptions) =>
  Effect.gen(function* () {
    const { server, jobs } = yield* makeServer("pomerado", options);
    server.registerTool(
      "mint",
      {
        description:
          "Mint a local, directly hostable MCP integration from a website and task. Choose read or write explicitly; ask the user before choosing write. name is a lowercase directory name using underscores within the configured output root. Starts once and returns a job ID; use get_job and provide_input to continue it.",
        inputSchema: standard(MintRequest),
      },
      (input, context) =>
        toolResponse(
          jobs
            .start((ask) =>
              Effect.gen(function* () {
                const { name, ...request } = input;
                const publish = yield* options.prepare(request, name);
                const pomerado = yield* createPomerado({ ...options.pomerado, ask });
                const result = yield* pomerado.mint(request);
                if (result.artifact === undefined)
                  return { build: result.build, summary: result.summary };
                const integration = yield* publish(result.artifact);
                return { build: result.build, integration };
              }),
            )
            .pipe(Effect.map(jobResult)),
          context.mcpReq.signal,
        ),
    );
    return server;
  });
const SchemaObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const businessInput = (inputSchema: unknown, outputSchema: unknown) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(SchemaObject)(inputSchema).pipe(
      Effect.mapError((cause) => new Error("Invalid operation input schema.", { cause })),
    );
    const output = yield* Schema.decodeUnknown(SchemaObject)(outputSchema).pipe(
      Effect.mapError((cause) => new Error("Invalid operation output schema.", { cause })),
    );
    return yield* Effect.try({
      try: (): StandardSchemaWithJSON<{ input: unknown }, { input: unknown }> => {
        const validator = new AjvJsonSchemaValidator();
        validator.getValidator(output);
        const json = {
          type: "object",
          properties: { input: inlineLocalRefs(input) },
          required: ["input"],
          additionalProperties: false,
        };
        const validate = validator.getValidator<{ input: unknown }>(json);
        return {
          "~standard": {
            version: 1,
            vendor: "pomerado",
            jsonSchema: { input: () => json, output: () => json },
            validate: (value) => {
              const result = validate(value);
              // Ajv names each failing path and the schema rule it breaks, never the value.
              return result.valid
                ? { value: result.data }
                : {
                    issues: [
                      {
                        message: `Input does not match the operation schema: ${
                          result.errorMessage ?? "unknown error"
                        }.`,
                      },
                    ],
                  };
            },
          },
        };
      },
      catch: (cause) => new Error("Invalid operation schema.", { cause }),
    });
  });
export const makeIntegrationMcp = (options: IntegrationMcpOptions) =>
  Effect.gen(function* () {
    const artifact = yield* validateArtifact(options.artifact);
    const deployment = yield* Schema.decodeUnknown(Deployment)(options.deployment).pipe(
      Effect.mapError((cause) => new Error("Invalid integration deployment.", { cause })),
    );
    const inputSchema = yield* businessInput(artifact.inputSchema, artifact.outputSchema);
    const { server, jobs, waitMs } = yield* makeServer(deployment.name, options);
    if (helperNames.includes(deployment.name))
      return yield* Effect.fail(
        new Error("The integration tool name conflicts with a job helper."),
      );
    server.registerTool(
      deployment.name,
      {
        description: `${deployment.description}\nReturns the operation result, or a job ID when input or more time is needed. Continue that job with get_job/provide_input; never repeat a possible write to poll it.`,
        inputSchema,
        annotations: {
          readOnlyHint: deployment.request.effect === "read",
          openWorldHint: true,
          idempotentHint: false,
          destructiveHint: deployment.request.effect === "write",
        },
      },
      (input, context) =>
        toolResponse(
          Effect.gen(function* () {
            const started = yield* jobs.start((ask) =>
              Effect.gen(function* () {
                const pomerado = yield* createPomerado({ ...options.pomerado, ask });
                return yield* pomerado.run(artifact, { ...deployment.request, input: input.input });
              }),
            );
            const view = yield* jobs.get(started.job_id, waitMs);
            return view.status === "completed" ? completedResult(view.output) : jobResult(view);
          }),
          context.mcpReq.signal,
        ),
    );
    return server;
  });
