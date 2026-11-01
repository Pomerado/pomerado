import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, MintServices } from "../../src/mint/contracts.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { runMint } from "../../src/mint/harness.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { portableJobSession, portableMintProjection } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// The minter ends the synthetic attempt blocked, which stops the model at once.
const reportBlocked: ModelResponse = {
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name: "report_blocked",
      callId: "blocked",
      arguments: JSON.stringify({
        reason: "site_lacks_capability",
        explanation: "The synthetic site offers nothing to read.",
        intent: "End the synthetic attempt.",
      }),
      status: "completed",
    },
  ],
};

/** The part of a tool's JSON schema this test walks. */
interface JsonSchema {
  readonly anyOf?: readonly JsonSchema[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly enum?: readonly string[];
}

// With autofill on for the site, execute's signInStep (a union with
// optional fields) made the SDK refuse the tool before the first model call.
// Its secret field offers the private_answer slot and its questionSelector to every host's minter:
// no dependency turns them on.
/** The `execute` tool the minter offers the model on an autofill site, as its first request sent it. */
const autofillExecuteTool = async () => {
  const workspace = await portableJobSession({ "src/tool.ts": "export {};" });
  cleanups.push(async () => {
    await workspace.close();
  });
  const requests: ModelRequest[] = [];
  const dependencies: MintDependencies = {
    workspace,
    projection: portableMintProjection(),
    instructions: "Synthetic instructions.",
    skills: [{ name: "core", description: "Synthetic", content: "Synthetic contract." }],
    deadline: Deadline.after(60_000),
    autofillSignIn: true,
    model: makeOpenAIMinter({
      getModel: () => ({
        getResponse: async (request) => {
          requests.push(request);
          return reportBlocked;
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    }),
    preflight: () => Effect.succeed({ supported: true }),
    reviewQuestion: () =>
      Effect.succeed({ outcome: "allow_business" as const, rationale: "Synthetic question." }),
    claimExample: Effect.die("The attempt must not claim the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: () => Effect.die("The attempt must not execute"),
    publish: () => Effect.die("The attempt must not publish"),
  };
  await Effect.runPromise(
    runMint({
      mode: "mint",
      intent: "Sign in and read the account page",
      businessInput: {},
      observations: [],
      siteOrigin: "https://cloud.example.com",
      effect: "read",
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  expect(requests).toHaveLength(1);
  return requests[0]?.tools.find((tool) => tool.name === "execute");
};

it("offers execute with signInStep to the model on an autofill site", async () => {
  const execute = await autofillExecuteTool();
  expect(JSON.stringify(execute ?? null)).toContain("signInStep");
  const signInStep = (execute as { readonly parameters?: JsonSchema } | undefined)?.parameters
    ?.properties?.signInStep;
  // A nullable union is an anyOf holding the union's own anyOf and null.
  const branches = (schema: JsonSchema | undefined): JsonSchema[] =>
    schema?.anyOf === undefined ? (schema ? [schema] : []) : schema.anyOf.flatMap(branches);
  const secretFields = branches(signInStep)
    .flatMap((step) => step.properties?.fields?.items?.anyOf ?? [])
    .filter((field) => field.properties?.slot !== undefined);
  expect(secretFields).toHaveLength(1);
  expect(secretFields[0]?.properties?.slot?.enum).toContain("private_answer");
  expect(Object.keys(secretFields[0]?.properties ?? {})).toContain("questionSelector");
});

// Strict tool schemas keep each string's pattern, and the model provider refuses a pattern with
// lookaround, which would fail every model call that offers the tool.
it("offers execute with no pattern that looks around", async () => {
  const execute = await autofillExecuteTool();
  const patterns: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (typeof value === "object" && value !== null)
      for (const [key, inner] of Object.entries(value))
        if (key === "pattern" && typeof inner === "string") patterns.push(inner);
        else walk(inner);
  };
  walk((execute as { readonly parameters?: unknown } | undefined)?.parameters);
  expect(patterns.length).toBeGreaterThan(0);
  expect(patterns.filter((pattern) => /\(\?(?:=|!|<=|<!)/u.test(pattern))).toEqual([]);
});
