import type { ModelSettings } from "@openai/agents";

/** Settings that help model quality are always on for every runtime agent. With `store:false`
 * the provider keeps no conversation state, so each response must return its encrypted
 * reasoning (`reasoning.encrypted_content`) and the SDK sends those items back on the next
 * turn, carrying reasoning across turns and continuations. Readable summaries are requested
 * too. None of our agents use hosted tools that add their own `include` entries; the SDK
 * replaces its tool-derived `include` with this provider-data value. */
export const withReasoningContinuity = (settings: ModelSettings): ModelSettings => ({
  ...settings,
  store: false,
  reasoning: { ...settings.reasoning, summary: "auto" },
  providerData: { ...settings.providerData, include: ["reasoning.encrypted_content"] },
});
