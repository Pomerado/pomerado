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

// Left unanswered, the question ends the synthetic attempt as no_response.
const requestInput: ModelResponse = {
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name: "request_input",
      callId: "ask",
      arguments: JSON.stringify({
        questions: [{ id: "report", type: "text", prompt: "Which report?" }],
        intent: "End the synthetic attempt.",
      }),
      status: "completed",
    },
  ],
};

/** The execute tool the model is offered on an autofill site, with the host's own flags. */
const executeTool = async (host: Pick<MintDependencies, "privateAnswers">) => {
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
    ...host,
    model: makeOpenAIMinter({
      getModel: () => ({
        getResponse: async (request) => {
          requests.push(request);
          return requestInput;
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    }),
    preflight: () => Effect.succeed({ supported: true }),
    reviewQuestion: () =>
      Effect.succeed({ outcome: "allow_business" as const, rationale: "Synthetic question." }),
    claimExample: Effect.die("The question must not claim the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: () => Effect.die("The question must not execute"),
    publish: () => Effect.die("The question must not publish"),
    askInput: () =>
      Effect.fail(new MintFailure({ code: "Unavailable", noResponse: { possibleCommit: false } })),
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
  return JSON.stringify(requests[0]?.tools.find((tool) => tool.name === "execute") ?? null);
};

// With autofill on for the site, execute's signInStep (a union with
// optional fields) made the SDK refuse the tool before the first model call.
it("offers execute with signInStep to the model on an autofill site", async () => {
  expect(await executeTool({})).toContain("signInStep");
});

// A host that fills no private answers is offered no slot for one, so its model never sends a
// field the host cannot fill.
it("offers the private_answer slot only to a host that fills private answers", async () => {
  const plain = await executeTool({});
  expect(plain).not.toContain("private_answer");
  expect(plain).not.toContain("questionSelector");
  const answering = await executeTool({ privateAnswers: true });
  expect(answering).toContain("private_answer");
  expect(answering).toContain("questionSelector");
});
