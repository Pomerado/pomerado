import { PassThrough } from "node:stream";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeTerminalAsker } from "../../src/inputs/terminal.js";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";
import { localHandOffAsker, visibleBrowser } from "../../src/standalone/hand-off.js";
import { makeMcpJobs } from "../../src/standalone/mcp-jobs.js";

const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
afterEach(() => {
  if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
  vi.restoreAllMocks();
});

const handOff: InputRequest = {
  id: "5d1f6b8e-2a3c-4e7f-9b0a-1c2d3e4f5a6b",
  source: "script",
  questions: [
    {
      id: "review_claim",
      type: "browser_handoff",
      prompt: "Check the claim form, then mark this step done.",
      show_inputs: ["policy_number", "amount", "attachment", "contacts", "missing"],
    },
  ],
};
const input = {
  policy_number: "P-100",
  amount: 120.5,
  attachment: "upload-1",
  contacts: ["Example Person"],
};
const inputSchema = {
  type: "object",
  properties: {
    policy_number: { type: "string" },
    amount: { type: "number" },
    attachment: { type: "string", format: "file" },
    contacts: { type: "array", items: { type: "string" } },
  },
};

/** An asker that keeps each request it is given and marks every hand-off done. */
const keeping = (asked: InputRequest[]): InputAsker => (request) =>
  Effect.sync(() => {
    asked.push(request);
    return { review_claim: { type: "browser_handoff" as const, value: { done: true as const } } };
  });

describe("the local host's browser hand-off", () => {
  it("tells the person to use the open window, shows the named inputs, and hands back on Enter", async () => {
    const terminal = new PassThrough();
    Object.defineProperty(process, "stdin", { value: terminal, configurable: true });
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    const asked = Effect.runPromise(
      localHandOffAsker(makeTerminalAsker(), { visible: true, input, inputSchema })(handOff),
    );
    // The person finishes in the browser window, then presses Enter.
    await vi.waitFor(() => expect(written.join("")).toContain("Press Enter"));
    terminal.write("\n");
    expect(await asked).toEqual({
      review_claim: { type: "browser_handoff", value: { done: true } },
    });
    const shown = written.join("");
    expect(shown).toContain("This run's inputs:\npolicy_number: P-100\namount: 120.5");
    expect(shown).toContain("Check the claim form, then mark this step done.");
    expect(shown).toContain("Do this in the open browser window.");
    // A file and a list are never shown, nor an input the run did not get.
    expect(shown).not.toContain("upload-1");
    expect(shown).not.toContain("Example Person");
    expect(shown).not.toContain("missing");
  });

  it("follows local references, and hides write-only and password values", async () => {
    const asked: InputRequest[] = [];
    const referenced: InputRequest = {
      ...handOff,
      questions: [
        {
          id: "review_claim",
          type: "browser_handoff",
          prompt: "Check the claim form, then mark this step done.",
          show_inputs: ["policy_number", "amount", "attachment", "pin", "member"],
        },
      ],
    };
    await Effect.runPromise(
      localHandOffAsker(keeping(asked), {
        visible: true,
        input: { ...input, pin: "4321", member: "M-7" },
        inputSchema: {
          type: "object",
          $defs: {
            Upload: { type: "string", format: "file" },
            Member: { type: "string" },
          },
          properties: {
            policy_number: { type: "string" },
            amount: { type: "number" },
            attachment: { anyOf: [{ $ref: "#/$defs/Upload" }, { type: "null" }] },
            pin: { type: "string", writeOnly: true },
            member: { $ref: "#/$defs/Member" },
          },
        },
      })(referenced),
    );
    expect(asked[0]?.notice).toBe(
      "This run's inputs:\npolicy_number: P-100\namount: 120.5\nmember: M-7",
    );
  });

  it("tells the asker the hand-off opened, with its 30-minute bound", async () => {
    const opened: string[] = [];
    const started = Date.now();
    await Effect.runPromise(
      makeInputAsker(() =>
        Effect.succeed({ review_claim: { done: true } }),
      )(handOff, {
        opened: ({ expiresAt }) =>
          Effect.sync(() => {
            opened.push(expiresAt);
          }),
      }),
    );
    expect(opened).toHaveLength(1);
    const waits = Date.parse(opened[0] ?? "") - started;
    expect(waits).toBeGreaterThan(29 * 60_000);
    expect(waits).toBeLessThanOrEqual(30 * 60_000 + 2_000);
  });

  it("refuses a hand-off as Unavailable when the browser has no window, asking nobody", async () => {
    const asked: InputRequest[] = [];
    const refused = await Effect.runPromise(
      Effect.either(localHandOffAsker(keeping(asked), { visible: false, input, inputSchema })(handOff)),
    );
    expect(Either.isLeft(refused) && refused.left).toMatchObject({
      _tag: "InputRequestFailure",
      code: "Unavailable",
    });
    expect(asked).toEqual([]);
  });

  it("passes every other request through unchanged, and shows no value without the schema", async () => {
    const asked: InputRequest[] = [];
    const note: InputRequest = {
      id: "6e2a7c9f-3b4d-4f80-8c1b-2d3e4f5a6b7c",
      source: "script",
      questions: [{ id: "note", type: "text", prompt: "Anything else?" }],
    };
    await Effect.runPromise(Effect.either(localHandOffAsker(keeping(asked), { visible: false })(note)));
    await Effect.runPromise(localHandOffAsker(keeping(asked), { visible: true, input })(handOff));
    expect(asked).toEqual([note, handOff]);
  });

  it("counts a launched browser visible only when it is headed", () => {
    expect(visibleBrowser(undefined)).toBe(false);
    expect(visibleBrowser({})).toBe(false);
    expect(visibleBrowser({ headless: true })).toBe(false);
    expect(visibleBrowser({ headless: false })).toBe(true);
    expect(visibleBrowser({ endpoint: "ws://127.0.0.1:9000/browser" })).toBe(true);
  });
});

describe("a local MCP job's hand-off", () => {
  /** How long the job's pending request waits, as get_job shows it. */
  const waitShown = (request: InputRequest) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run");
          const started = Date.now();
          const job = yield* jobs.start((ask) => ask(request));
          const view = yield* jobs.get(job.job_id, 2_000);
          yield* jobs.cancel(job.job_id);
          const expires = view.pending_input?.expires_at;
          return expires === undefined ? undefined : Date.parse(expires) - started;
        }),
      ),
    );

  it("waits 30 minutes for a hand-off and ten for any other question", async () => {
    const handOffWait = await waitShown(handOff);
    expect(handOffWait).toBeGreaterThan(29 * 60_000);
    expect(handOffWait).toBeLessThanOrEqual(30 * 60_000 + 2_000);
    const noteWait = await waitShown({
      id: "8a4c9e1b-5d6f-4b02-8e3d-4f5a6b7c8d9e",
      source: "script",
      questions: [{ id: "note", type: "text", prompt: "Anything else?" }],
    });
    expect(noteWait).toBeGreaterThan(9 * 60_000);
    expect(noteWait).toBeLessThanOrEqual(10 * 60_000 + 2_000);
  });
});
