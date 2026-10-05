import { solModel } from "../../src/models/models.js";
import { afterEach, expect, it } from "vitest";
import { mintCompaction, mintCompactionThresholdTokens } from "../../src/mint/openai.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("applies one compaction threshold that does not depend on the SDK model table", () => {
  for (const model of [solModel, "gpt-5.6-sol", "unknown-model"])
    expect(mintCompaction().samplingParams({ model })).toEqual({
      context_management: [
        { type: "compaction", compact_threshold: mintCompactionThresholdTokens },
      ],
    });
});
