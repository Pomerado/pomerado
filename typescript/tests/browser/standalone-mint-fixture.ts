import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import {
  authorityOf,
  contextOf,
  execution,
  html,
  message,
  probe,
  recordingGuardian,
  scripted,
  startSite,
  type RecordedReview,
} from "./guardian-context-fixture.js";

export type Turn = (request: ModelRequest) => ModelResponse["output"];

/**
 * Mints against `url` with a minter that plays `turns`, one per model request, and the recorded
 * Guardian; `answer` answers each question the build asks.
 */
export const mint = async (options: {
  readonly effect: "read" | "write";
  readonly url: string;
  readonly turns: readonly Turn[];
  readonly guardian: ReturnType<typeof recordingGuardian>;
  readonly answer?: (request: InputRequest) => Record<string, unknown>;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly intent?: string;
}) => {
  const requests: ModelRequest[] = [];
  const asked: InputRequest[] = [];
  const minter = scripted(
    (request, index) => options.turns[index]?.(request) ?? [message("Done.")],
    requests,
  );
  const built = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createPomerado({
          minterProvider: minter,
          guardianProvider: options.guardian.provider,
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              asked.push(request);
              return options.answer?.(request) ?? {};
            }),
          ),
          timeoutMs: 60_000,
        });
        return yield* service.mint({
          url: options.url,
          intent: options.intent ?? "Read the fixture heading",
          effect: options.effect,
          input: options.input ?? {},
        });
      }),
    ),
  );
  return { built, requests, asked, last: requests.at(-1) };
};
export const executions = (reviews: readonly RecordedReview[]) =>
  reviews.filter((review) => review.kind === "execution");
export const effectsOf = (review: RecordedReview | undefined) =>
  (review === undefined ? [] : authorityOf(review)["allowedEffects"]) as readonly string[];
export const historyOf = (review: RecordedReview | undefined) =>
  ((review === undefined ? [] : contextOf(review)?.["executions"]) ?? []) as readonly Readonly<
    Record<string, unknown>
  >[];

/** A site whose Save button posts once per click, and how many posts it received. */
export const saveSite = () => {
  let writes = 0;
  return {
    writes: () => writes,
    start: () =>
      startSite((request, response) => {
        if (request.method === "POST") {
          writes++;
          response.end("saved");
          return;
        }
        html(
          response,
          `<title>Save</title><button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.title='Saved')">Save</button>`,
        );
      }),
  };
};
/** A step that clicks Save and waits for the save to finish. */
export const saveStep = probe(
  "await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); return true;",
);

/** A site whose Save button posts the note the page holds, and what it received. */
export const noteSite = () => {
  const saved: string[] = [];
  return {
    saved,
    start: () =>
      startSite((request, response, body) => {
        if (request.method === "POST") {
          saved.push(body);
          response.end("saved");
          return;
        }
        html(
          response,
          `<title>Note</title><button id="save" onclick="fetch('/save',{method:'POST',body:document.body.dataset.note}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
        );
      }),
  };
};
/** A write step that saves its input's note once and confirms it. */
export const saveNote = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save_note",input:Schema.Struct({note:Schema.String}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},
async ({kernel,sessionId,input,enteringCommit,verified}) => {
  enteringCommit("save");
  const result = await kernel.browsers.playwright.execute(sessionId,{code:"await page.evaluate((note) => { document.body.dataset.note = note; }, " + JSON.stringify(input.note) + "); await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:10});
  if(!result.success || result.result !== true) throw new Error("Save not confirmed");
  verified({confirmation:"message"});
  return {saved:true};
});`;
export const readNote = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_note",input:Schema.Struct({note:Schema.String}),output:Schema.Unknown},
async ({input}) => ({note:input.note}));`;
export const act = (entrypoint: string, exampleInput?: unknown) =>
  execution(
    "act",
    entrypoint,
    exampleInput === undefined
      ? {}
      : {
          exampleInput:
            typeof exampleInput === "string" ? exampleInput : JSON.stringify(exampleInput),
        },
  );
