import type { AgentInputItem } from "@openai/agents";
import { cutResult, resultHardCapBytes } from "./result-digest.js";

/**
 * The longest tool result, in UTF-16 code units, that a minter request carries whole. Each host
 * tool bounds its own result well below this (a `read_source` call returns about 200,000 code
 * units at most), so only a result no tool bounded reaches it, such as one a takeover replays from
 * an earlier worker. A compaction keeps the items after the request it compacts as they are, so it
 * cannot shrink such a result; past this length the request carries its first part and size.
 */
export const toolResultMaxChars = 400_000;

/**
 * The longest a tool result goes out whole once a request carrying it was refused as over the
 * model's context (`longToolResults`): the most bytes a host returns for any result.
 */
export const cutToolResultMaxChars = resultHardCapBytes;

type FunctionResult = Extract<AgentInputItem, { readonly type: "function_call_result" }>;
type FunctionOutput = FunctionResult["output"];

const boundedText = (text: string, limit: number) =>
  text.length <= limit ? text : cutResult(text);

/** A text output part with its text bounded; any other part as it is. */
const boundedPart =
  (limit: number) =>
  <P>(part: P): P => {
    if (typeof part !== "object" || part === null || !("text" in part)) return part;
    const text: unknown = part.text;
    if (typeof text !== "string") return part;
    const bounded = boundedText(text, limit);
    return bounded === text ? part : { ...part, text: bounded };
  };

const boundedOutput = (output: FunctionOutput, limit: number): FunctionOutput => {
  if (typeof output === "string") return boundedText(output, limit);
  if (!Array.isArray(output)) return boundedPart(limit)(output);
  const parts = output.map(boundedPart(limit));
  return parts.some((part, index) => part !== output[index]) ? parts : output;
};

/** The length of a function result's text, its text parts' together. */
const outputLength = (output: FunctionOutput): number => {
  const parts: readonly unknown[] = Array.isArray(output) ? output : [output];
  return parts.reduce<number>((total, part) => {
    if (typeof part === "string") return total + part.length;
    const text: unknown =
      typeof part === "object" && part !== null && "text" in part ? part.text : undefined;
    return total + (typeof text === "string" ? text.length : 0);
  }, 0);
};

/**
 * `input` with each function result longer than `toolResultMaxChars`, or than
 * `cutToolResultMaxChars` for a call in `cut`, replaced by its bounded first part. The same input
 * gives the same bytes every time, so a request's cached prefix holds, and an input with no such
 * result comes back as it is.
 */
export const boundedToolResults = <I extends string | AgentInputItem[]>(
  input: I,
  cut: ReadonlySet<string> = new Set(),
): I => {
  if (typeof input === "string") return input;
  let changed = false;
  const items = input.map((item) => {
    if (item.type !== "function_call_result") return item;
    const limit = cut.has(item.callId) ? cutToolResultMaxChars : toolResultMaxChars;
    const output = boundedOutput(item.output, limit);
    if (output === item.output) return item;
    changed = true;
    return { ...item, output };
  });
  return (changed ? items : input) as I;
};

/** The calls whose function results in `input` are longer than `cutToolResultMaxChars`. */
export const longToolResults = (input: string | readonly AgentInputItem[]): string[] =>
  typeof input === "string"
    ? []
    : input.flatMap((item) =>
        item.type === "function_call_result" && outputLength(item.output) > cutToolResultMaxChars
          ? [item.callId]
          : [],
      );
