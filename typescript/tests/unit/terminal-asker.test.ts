import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Effect, Either } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeTerminalAsker, OwnerCancelled } from "../../src/inputs/terminal.js";

const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
afterEach(() => {
  if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
  vi.restoreAllMocks();
});

// The person at the terminal owns the account, so an option from it shows in full.
it("lists an option from the owner's own account by its full label", async () => {
  const input = new PassThrough();
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    written.push(String(text));
    return true;
  });
  const asked = Effect.runPromise(
    makeTerminalAsker()({
      id: randomUUID(),
      source: "script",
      questions: [
        {
          id: "address",
          type: "choice",
          prompt: "Which saved address?",
          options: [
            { id: "home", label: "12 Example Rd, Springfield", accountSpecific: true, maskedLabel: "Home" },
            { id: "new", label: "A new address" },
          ],
        },
      ],
    }),
  );
  input.end("1\n");
  expect(await asked).toEqual({ address: { type: "choice", value: "home" } });
  expect(written.join("")).toContain("1. 12 Example Rd, Springfield\n");
});

it("reports the owner closing the input at a question as their own cancel, still NoResponse", async () => {
  const input = new PassThrough();
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const asked = Effect.runPromise(
    Effect.either(
      makeTerminalAsker()({
        id: randomUUID(),
        source: "system",
        questions: [
          {
            id: "choice",
            type: "choice",
            prompt: "How should Pomerado respond to this dialog?",
            options: [
              { id: "accept", label: "Accept" },
              { id: "dismiss", label: "Dismiss" },
            ],
          },
        ],
      }),
    ),
  );
  input.end();
  const answered = await asked;
  expect(Either.isLeft(answered) && answered.left).toBeInstanceOf(OwnerCancelled);
  expect(Either.isLeft(answered) && answered.left).toMatchObject({
    _tag: "InputRequestFailure",
    code: "NoResponse",
  });
});
