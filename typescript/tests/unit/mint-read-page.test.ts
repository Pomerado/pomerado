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

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });

/** The recorded model: it reads the live page once, then ends the synthetic attempt blocked. */
const responses: readonly ModelResponse[] = [
  {
    usage: usage(),
    output: [
      {
        type: "function_call",
        name: "read_page",
        callId: "read",
        arguments: JSON.stringify({ intent: "See what the page shows before probing it." }),
        status: "completed",
      },
    ],
  },
  {
    usage: usage(),
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
  },
];

/** A synthetic attempt with `host`'s tools: the model's requests and the steps sent for review. */
const attempt = async (host: Partial<MintDependencies>) => {
  const workspace = await portableJobSession({ "src/tool.ts": "export {};" });
  cleanups.push(async () => {
    await workspace.close();
  });
  const requests: ModelRequest[] = [];
  const reviews: unknown[] = [];
  const dependencies: MintDependencies = {
    workspace,
    projection: portableMintProjection(),
    instructions: "Synthetic instructions.",
    skills: [{ name: "core", description: "Synthetic", content: "Synthetic contract." }],
    deadline: Deadline.after(60_000),
    model: makeOpenAIMinter({
      getModel: () => ({
        getResponse: async (request) => {
          requests.push(request);
          const response = responses[requests.length - 1];
          if (response === undefined) throw new Error("No recorded response is left");
          return response;
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    }),
    preflight: () => Effect.succeed({ supported: true }),
    reviewQuestion: () =>
      Effect.succeed({ outcome: "allow_business" as const, rationale: "Synthetic question." }),
    claimExample: Effect.die("The synthetic attempt never claims the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: (request) =>
      Effect.sync(() => reviews.push(request)).pipe(
        Effect.zipRight(Effect.die("The synthetic attempt never executes")),
      ),
    publish: () => Effect.die("The synthetic attempt never publishes"),
    ...host,
  };
  await Effect.runPromise(
    runMint({
      mode: "maintenance",
      intent: "Read public data",
      businessInput: {},
      observations: [],
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  return { requests, reviews };
};

/** The tools the first request lets the model call. */
const allowedTools = (request: ModelRequest | undefined) => {
  const choice: unknown = request?.modelSettings.providerData?.["tool_choice"];
  return typeof choice === "object" &&
    choice !== null &&
    "tools" in choice &&
    Array.isArray(choice.tools)
    ? choice.tools.map((tool: { readonly name?: string }) => tool.name)
    : [];
};

it("returns the host's read of the live page with no review, and offers no read without the host's reader", async () => {
  const page = {
    status: "read",
    url: "https://shop.example/cart",
    snapshot: '- heading "Your cart" [level=1]',
    snapshotPath: "captures/page.aria.yml",
  };
  let reads = 0;
  const { requests, reviews } = await attempt({
    readPage: () =>
      Effect.sync(() => {
        reads += 1;
        return page;
      }),
  });
  expect(allowedTools(requests[0])).toContain("read_page");
  expect(reads).toBe(1);
  // No script ran, so nothing was reviewed or executed.
  expect(reviews).toEqual([]);
  // The model's next request carries the host's read as the call's result.
  const result = JSON.stringify({ kind: "host_page_read", ...page });
  expect(JSON.stringify(requests[1]?.input)).toContain(JSON.stringify(result).slice(1, -1));

  const without = await attempt({});
  expect(allowedTools(without.requests[0])).not.toContain("read_page");
});
