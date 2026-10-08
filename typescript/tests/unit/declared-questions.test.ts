import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { asksAsDeclared } from "../../src/execution/declared-questions.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  draftQuestionDeclarationFailure,
  draftQuestionDeclarations,
} from "../../src/mint/draft-questions.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import {
  makeScriptInput,
  ScriptInputFailure,
  type ScriptQuestionDeclarations,
} from "../../src/runtime/script-input.js";

const operation = (contract: string, body = "async () => ({})") => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
${contract.includes("defineOperation") ? contract : `export default defineOperation(${contract}, ${body});`}`;
const note = { type: "text", prompt: "Which note should I keep?" } as const;

describe("draftQuestionDeclarations", () => {
  it("reads the questions a draft's one defineOperation declares as a plain literal", () => {
    const source = operation(
      `{name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"},"seat":{type:"choice",prompt:\`Which seat?\`,allowOther:true}}}`,
    );
    expect(draftQuestionDeclarations("src/tool.mjs", source)).toEqual({
      note,
      seat: { type: "choice", prompt: "Which seat?", allowOther: true },
    });
    expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBeUndefined();
  });

  it("reads TypeScript, with its as and satisfies expressions", () => {
    const source = operation(
      `{name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"} as const} satisfies object}`,
    );
    expect(draftQuestionDeclarations("src/tool.ts", source)).toEqual({ note });
  });

  it.each([
    [
      "a declaration through a variable",
      `const questions = { note: { type: "text", prompt: "Which note should I keep?" } };
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions}, async () => ({}));`,
    ],
    [
      "a spread",
      `const extra = {};
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{...extra,note:{type:"text",prompt:"Which note should I keep?"}}}, async () => ({}));`,
    ],
    [
      "a template with a value in it",
      `const word = "note";
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:\`Which \${word} should I keep?\`}}}, async () => ({}));`,
    ],
    [
      "two operations",
      `export const one = defineOperation({name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"}}}, async () => ({}));
export default defineOperation({name:"b",input:Schema.Unknown,output:Schema.Unknown}, async () => ({}));`,
    ],
    ["source that does not parse", `export default defineOperation({name:"a",questions:{`],
    [
      "an extra field",
      `export default defineOperation({name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?",hint:"x"}}}, async () => ({}));`,
    ],
  ])("declares nothing for %s", (_, source) => {
    expect(draftQuestionDeclarations("src/tool.mjs", operation(source))).toEqual({});
  });

  it("names each invalid id of a literal declaration before a step runs", () => {
    const source = operation(
      `{name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{pageTitle:{type:"text",prompt:"Which page?"},"2nd":{type:"text",prompt:"Which?"},ok:{type:"text",prompt:"Fine"}}}`,
    );
    expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBe(
      'Invalid script question ids: "pageTitle", "2nd". Question ids must start with a lowercase letter and contain only lowercase letters, digits, or underscores, up to 64 characters. Rename them before executing.',
    );
    expect(
      draftQuestionDeclarationFailure(
        "src/tool.mjs",
        operation(`{name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{Note:{type:"text",prompt:"Which?"}}}`),
      ),
    ).toContain('Invalid script question id: "Note".');
  });
});

/** The request core's script input builds for `asked` under `declared`, as a running script sends it. */
const requestFor = (declared: ScriptQuestionDeclarations, asked: Parameters<ReturnType<typeof makeScriptInput>["ask"]>[0]) => {
  let sent: InputRequest | undefined;
  Effect.runSync(
    Effect.either(
      makeScriptInput(declared, (request) =>
        Effect.sync(() => {
          sent = request;
        }).pipe(Effect.zipRight(Effect.fail(new ScriptInputFailure({ code: "Unavailable" })))),
      ).ask(asked),
    ),
  );
  if (sent === undefined) throw new Error("No request sent");
  return sent;
};

describe("asksAsDeclared", () => {
  const declared: ScriptQuestionDeclarations = {
    note,
    seat: { type: "choice", prompt: "Which seat?" },
    sides: { type: "multi_choice", prompt: "Which sides?", maxSelections: 2 },
    sure: { type: "confirm", prompt: "Go ahead?" },
    code: { type: "secret", prompt: "Which code?", secretKind: "one_time_code" },
  };
  const options = [
    { value: "a", label: "Aisle" },
    { value: "w", label: "Window" },
    { value: "m", label: "Middle" },
  ];

  it("allows a request that asks exactly what was declared", () => {
    expect(asksAsDeclared(requestFor(declared, "note"), declared)).toBe(true);
    expect(
      asksAsDeclared(
        requestFor(declared, { seat: { options }, sides: { options }, sure: {}, code: {} }),
        declared,
      ),
    ).toBe(true);
  });

  it("refuses a request whose prompt or bounds differ from the declaration it is checked against", () => {
    const asked = requestFor(declared, "note");
    expect(asksAsDeclared(asked, { note: { ...note, prompt: "Which note?" } })).toBe(false);
    expect(asksAsDeclared(asked, { note: { ...note, maxLength: 10 } })).toBe(false);
    expect(asksAsDeclared(asked, { note: { type: "confirm", prompt: note.prompt } })).toBe(false);
    const sides = requestFor(declared, { sides: { options } });
    expect(asksAsDeclared(sides, { sides: { type: "multi_choice", prompt: "Which sides?" } })).toBe(
      false,
    );
    const seat = requestFor(declared, { seat: { options } });
    expect(asksAsDeclared(seat, { seat: { type: "choice", prompt: "Which seat?", allowOther: true } })).toBe(false);
    // The pre-unification `{ prompt }` declaration is a plain choice.
    expect(asksAsDeclared(seat, { seat: { prompt: "Which seat?" } })).toBe(true);
  });

  it("refuses an undeclared id, an inherited one, a notice and a request that is not the script's", () => {
    const asked = requestFor(declared, "note");
    expect(asksAsDeclared(asked, {})).toBe(false);
    expect(asksAsDeclared(asked, Object.create({ note }) as ScriptQuestionDeclarations)).toBe(false);
    expect(asksAsDeclared({ ...asked, notice: "Read this first." }, declared)).toBe(false);
    expect(asksAsDeclared({ ...asked, source: "agent" }, declared)).toBe(false);
  });
});

describe("a local operation's questions", () => {
  const asking = operation(
    `{name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"}}}`,
    `async ({ ask }) => ({ note: await ask("note") })`,
  );
  const run = (declaredQuestions?: ScriptQuestionDeclarations) => {
    const asked: InputRequest[] = [];
    const ask = makeInputAsker((request) =>
      Effect.sync(() => {
        asked.push(request);
        return { note: "kept" };
      }),
    );
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* Effect.either(
            runLocalOperation({
              workspace,
              entrypoint: "src/tool.mjs",
              sources: [["src/tool.mjs", asking]],
              input: {},
              target: "pureFiles",
              ask,
              ...(declaredQuestions === undefined ? {} : { declaredQuestions }),
            }),
          );
        }),
      ),
    ).then((result) => ({ result, asked }));
  };

  it("puts a question to the caller when it matches what the host read", async () => {
    const { result, asked } = await run({ note });
    expect(Either.isRight(result) && result.right.output).toEqual({ note: "kept" });
    expect(asked).toHaveLength(1);
  });

  it.each([
    ["a different prompt", { note: { ...note, prompt: "Which note?" } }],
    ["no declarations", {}],
    ["declarations the host never read", undefined],
  ])("fails the ask as Undeclared and asks nobody for %s", async (_, declared) => {
    const { result, asked } = await run(declared);
    expect(asked).toEqual([]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LocalOperationFailure);
      expect(result.left).toMatchObject({ tag: "ScriptInputFailure", code: "Undeclared" });
    }
  });
});
