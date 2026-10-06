import type { Usage } from "@openai/agents";

const total = (details: ReadonlyArray<Record<string, number>>, key: string) =>
  details.reduce((sum, entry) => {
    const value = entry[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? sum + value
      : sum;
  }, 0);

/** One model call's token counts, as finite diagnostics: the cache hit rate is
 * `cachedTokens / inputTokens`, and `cacheWriteTokens` is what the call newly cached. */
export const modelUsageCounts = (usage: Usage) => ({
  inputTokens: usage.inputTokens,
  cachedTokens: total(usage.inputTokensDetails, "cached_tokens"),
  cacheWriteTokens: total(usage.inputTokensDetails, "cache_write_tokens"),
  outputTokens: usage.outputTokens,
  reasoningTokens: total(usage.outputTokensDetails, "reasoning_tokens"),
});
