import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeIntegrationMcp } from "../../src/standalone/mcp-server.js";

const artifact = {
  entrypoint: "src/tool.mjs",
  files: [{ path: "src/tool.mjs", content: "export default {};" }],
  inputSchema: {
    type: "object",
    properties: { note: { type: "string" } },
    required: ["note"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { saved: { type: "boolean" } },
    required: ["saved"],
    additionalProperties: false,
  },
};
const deployment = (effect: "read" | "write") => ({
  name: `${effect}_fixture`,
  description: "Operate a local fixture",
  request: { url: "http://127.0.0.1:9/", intent: "Operate a local fixture", effect },
});

/** Lists a served integration's tools over MCP without starting a browser or a run. */
const listed = (effect: "read" | "write") =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeIntegrationMcp({ artifact, deployment: deployment(effect) });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        const client = new Client({ name: "pomerado-unit", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        const { tools } = yield* Effect.promise(() => client.listTools());
        const tool = tools.find((candidate) => candidate.name === `${effect}_fixture`);
        if (tool === undefined) throw new Error("The integration tool is not listed");
        return tool;
      }),
    ),
  );

it("marks a write tool as neither idempotent nor read-only", async () => {
  const tool = await listed("write");
  expect(tool.annotations).toMatchObject({
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
  });
});

it("gives a read tool only its input", async () => {
  const tool = await listed("read");
  expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["input"]);
  expect(tool.description).not.toContain("idempotency_key");
});

it("lets a write tool take an optional idempotency_key and says to send one with every write", async () => {
  const tool = await listed("write");
  expect(tool.inputSchema.required).toEqual(["input"]);
  expect(tool.inputSchema.properties?.["idempotency_key"]).toEqual({
    type: "string",
    pattern: "^[A-Za-z0-9_-]{1,200}$",
    description:
      "Optional. Your key for this call; reuse it only to retry the same call, which then answers the same job instead of acting on the website again.",
  });
  expect(tool.description).toContain(
    "Send an idempotency_key with every write and reuse it only to retry that same call. A call without one is a new website action.",
  );
});
