import type { AgentInputItem, ModelRequest, ModelResponse } from "@openai/agents";

/**
 * Input tokens at which the minter compacts its history while it waits on a tool. Below the
 * provider-side backstop (`mintCompactionThresholdTokens`, 240K), so the compaction normally
 * lands before any request reaches it; the 40K between them is several turns of growth.
 */
export const mintIdleCompactionTokens = 200_000;

/** The Responses API compacts the context it is sent when this is the last input item. */
const compactionTrigger: AgentInputItem = {
  type: "unknown",
  providerData: { type: "compaction_trigger" },
};

/** Output items that leave the model waiting on a tool result. */
const toolCallTypes = new Set(["function_call", "shell_call", "apply_patch_call", "computer_call"]);

type IdleCompactionEvent =
  | { readonly state: "started"; readonly inputTokens: number }
  | { readonly state: "ready" }
  | { readonly state: "failed"; readonly reason: "no_compaction_item" | "provider_failed" }
  | { readonly state: "superseded" };

/**
 * Compaction off the minter's critical path. A server-side compaction runs inside the request
 * that crosses its threshold, so the turn waits for it (about a minute for the big model).
 * Instead, once a turn ends in tool calls with its input above the watermark, the same
 * request plus a compaction trigger runs in the background while the tools run: it reads
 * that turn's cached prefix. When it returns, each later request sends the compacted window
 * in place of the compacted prefix, followed by every item after it, so the reasoning and
 * tool calls of the turn being answered stay paired with their results.
 *
 * A turn never waits for a running compaction: it goes out uncompacted, and the compaction
 * applies to the first request after it lands. The SDK's history keeps every item; only
 * what is sent changes. A provider compaction (the 240K backstop) starts the SDK's input at
 * its own item, so a window for the old prefix no longer matches and is dropped.
 */
export const makeIdleCompaction = (options: {
  readonly watermarkTokens: number;
  readonly report: (event: IdleCompactionEvent) => Promise<void>;
}) => {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let disabled = false;
  let ready:
    | { readonly length: number; readonly key: string; readonly window: AgentInputItem[] }
    | undefined;
  const reports = new Set<Promise<void>>();
  const report = (event: IdleCompactionEvent) => {
    const sent = options.report(event).finally(() => reports.delete(sent));
    reports.add(sent);
    return sent;
  };
  const key = (items: readonly AgentInputItem[]) => JSON.stringify(items);

  /** The input to send for the SDK's input: the compacted window replaces its prefix. */
  const view = (input: string | AgentInputItem[]): string | AgentInputItem[] => {
    if (ready === undefined || typeof input === "string") return input;
    if (input.length < ready.length || key(input.slice(0, ready.length)) !== ready.key) {
      ready = undefined;
      void report({ state: "superseded" });
      return input;
    }
    return [...ready.window, ...input.slice(ready.length)];
  };

  /** After a returned turn: starts a background compaction when the model now waits on tools. */
  const afterTurn = (
    request: ModelRequest,
    sent: ModelRequest,
    response: ModelResponse,
    compact: (request: ModelRequest) => Promise<ModelResponse>,
  ) => {
    if (disabled || running !== undefined || controller.signal.aborted) return;
    if (typeof request.input === "string" || !Array.isArray(sent.input)) return;
    if (response.usage.inputTokens < options.watermarkTokens) return;
    if (response.output.some((item) => item.type === "compaction")) return;
    if (!response.output.some((item) => item.type !== undefined && toolCallTypes.has(item.type)))
      return;
    const original = [...request.input];
    const compacted = { length: original.length, key: key(original) };
    void report({ state: "started", inputTokens: response.usage.inputTokens });
    running = compact({
      ...sent,
      input: [...sent.input, compactionTrigger],
      signal: controller.signal,
    })
      .then(async (result) => {
        const item = result.output.findLast((entry) => entry.type === "compaction");
        if (item === undefined) {
          disabled = true;
          await report({ state: "failed", reason: "no_compaction_item" });
          return;
        }
        ready = { ...compacted, window: [item] };
        await report({ state: "ready" });
      })
      .catch(async () => {
        if (controller.signal.aborted) return;
        // The provider-side backstop still bounds the context; no retry loop here.
        disabled = true;
        await report({ state: "failed", reason: "provider_failed" });
      })
      .finally(() => {
        running = undefined;
      });
  };

  /** Ends a compaction still running when the attempt ends; waits for it and its reports. */
  const close = async () => {
    controller.abort();
    await running;
    await Promise.all(reports);
  };

  return { view, afterTurn, close };
};
