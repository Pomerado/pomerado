import { createHash } from "node:crypto";
import type { AgentInputItem } from "@openai/agents";
import {
  cutResult,
  resultDigestPath,
  resultDigestThresholdBytes,
  resultHardCapBytes,
} from "./result-digest.js";

/**
 * The longest tool result, in UTF-16 code units, that a minter request carries whole. Each host
 * tool bounds its own result below this (one `read_source` call returns about 200,000 code units
 * of files at most, a skill page 131,072, an `execute` result 64 KiB), so only a result no tool
 * bounded reaches it, such as one a takeover replays from an earlier worker. A compaction keeps
 * the items after the request it compacts as they are, so it cannot shrink such a result; past
 * this length the request carries its first part, its size and the workspace file holding it.
 */
export const toolResultMaxChars = 400_000;

/**
 * The limits, in UTF-16 code units, that recovery from a request refused as over the model's
 * context sets in turn for its long tool results once a compaction no longer helps: the most a
 * host returns for any result (`resultHardCapBytes`), then the size a result comes back whole in
 * (`resultDigestThresholdBytes`).
 */
export const overflowToolResultMaxChars = [resultHardCapBytes, resultDigestThresholdBytes] as const;

type FunctionResult = Extract<AgentInputItem, { readonly type: "function_call_result" }>;
type FunctionOutput = FunctionResult["output"];

/** Where a tool result too long for a request is saved whole: one file per call and part. */
export const toolResultPath = (callId: string, part: number | undefined) => {
  const name = part === undefined ? callId : `${callId}-${part}`;
  // The path keeps only some characters of the id, so a hash of the whole id keeps two ids that
  // differ elsewhere in files of their own.
  const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
  return resultDigestPath(`tool-result-${name.slice(0, 64)}-${hash}`);
};

/** A part's text, when it is a text part. */
const partText = (part: unknown): string | undefined => {
  if (typeof part === "string") return part;
  const text: unknown =
    typeof part === "object" && part !== null && "text" in part ? part.text : undefined;
  return typeof text === "string" ? text : undefined;
};

/** A text part with its text replaced. */
const withText = <P extends object>(part: P, text: string): P => ({ ...part, text });

/** Each text of `output`. */
const outputTexts = (output: FunctionOutput): string[] =>
  (Array.isArray(output) ? (output as readonly unknown[]) : [output]).flatMap((part) => {
    const text = partText(part);
    return text === undefined ? [] : [text];
  });

/**
 * The minter's bound on the tool results its requests carry. A result longer than its call's
 * limit (`toolResultMaxChars`, or a lower one recovery set with `lower`) is saved whole through
 * `save` as a workspace file, and the request carries its first part, its size and the file's
 * path; without `save`, or when the save fails, its first part and size. A call's text is saved
 * once and goes out with the same bytes on every request at the same limit, so a request's
 * cached prefix holds, and an input with nothing to bound comes back as it is. Only what is sent
 * changes: the run's history keeps every result whole.
 */
export const makeToolResultBounds = (save?: (path: string, text: string) => Promise<boolean>) => {
  /** The limit recovery set per call, lower than `toolResultMaxChars`. */
  const limits = new Map<string, number>();
  /** Per call and part: whether its whole text is saved, once a save was tried. */
  const saved = new Map<string, Promise<boolean>>();
  /** Per call, part and limit: the text a request carries. */
  const sent = new Map<string, string>();
  const limitOf = (callId: string) => limits.get(callId) ?? toolResultMaxChars;

  const boundedText = async (
    callId: string,
    part: number | undefined,
    text: string,
    limit: number,
  ) => {
    if (text.length <= limit) return text;
    const partKey = JSON.stringify([callId, part ?? null]);
    const key = `${partKey}:${limit}`;
    const known = sent.get(key);
    if (known !== undefined) return known;
    const path = toolResultPath(callId, part);
    let saving = saved.get(partKey);
    if (saving === undefined) {
      saving = save === undefined ? Promise.resolve(false) : save(path, text).catch(() => false);
      saved.set(partKey, saving);
    }
    // A quarter of the limit, so a lower limit sends less; never more than a whole result.
    const bounded = cutResult(text, {
      excerptBytes: Math.floor(limit / 4),
      ...((await saving) ? { path } : {}),
    });
    // Two requests bounding the same part at once send the first one's bytes.
    const first = sent.get(key) ?? bounded;
    sent.set(key, first);
    return first;
  };

  const boundedOutput = async (
    callId: string,
    output: FunctionOutput,
    limit: number,
  ): Promise<FunctionOutput> => {
    if (!Array.isArray(output)) {
      const text = partText(output);
      if (text === undefined) return output;
      const bounded = await boundedText(callId, undefined, text, limit);
      if (bounded === text) return output;
      return typeof output === "string" ? bounded : withText(output, bounded);
    }
    const parts = await Promise.all(
      output.map(async <P,>(part: P, index: number): Promise<P> => {
        const text = partText(part);
        if (text === undefined || typeof part !== "object" || part === null) return part;
        const bounded = await boundedText(callId, index, text, limit);
        return bounded === text ? part : withText(part, bounded);
      }),
    );
    return parts.some((part, index) => part !== output[index]) ? parts : output;
  };

  /** `input` with each tool result longer than its call's limit bounded. */
  const apply = async <I extends string | AgentInputItem[]>(input: I): Promise<I> => {
    if (typeof input === "string") return input;
    let changed = false;
    const items = await Promise.all(
      input.map(async (item): Promise<AgentInputItem> => {
        if (item.type !== "function_call_result") return item;
        const output = await boundedOutput(item.callId, item.output, limitOf(item.callId));
        if (output === item.output) return item;
        changed = true;
        return { ...item, output };
      }),
    );
    return (changed ? items : input) as I;
  };

  /**
   * Sets `limit` from now on for each call whose tool result in `input`, a request as sent, has
   * a text longer than it; returns how many calls it lowered.
   */
  const lower = (input: string | readonly AgentInputItem[], limit: number) => {
    if (typeof input === "string") return 0;
    let lowered = 0;
    for (const item of input) {
      if (item.type !== "function_call_result" || limitOf(item.callId) <= limit) continue;
      if (!outputTexts(item.output).some((text) => text.length > limit)) continue;
      limits.set(item.callId, limit);
      lowered += 1;
    }
    return lowered;
  };

  return { apply, lower };
};
