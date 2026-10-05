import type { ModelProvider } from "@openai/agents";
import { type Effect, Schema } from "effect";
import type { MintOutcome } from "../mint/contracts.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PlaywrightOptions } from "../execution/playwright-execute.js";
import type { InputAsker } from "../runtime/input-request.js";
export interface PomeradoOptions {
  readonly ask: InputAsker;
  readonly browser?: PlaywrightOptions;
  readonly minterProvider?: ModelProvider;
  readonly guardianProvider?: ModelProvider;
  readonly policy?: string;
  readonly timeoutMs?: number;
}

export interface PomeradoRequest {
  readonly intent: string;
  readonly url: string;
  readonly input?: unknown;
  readonly effect?: "read" | "write" | "ask";
  readonly authenticationOrigins?: readonly string[];
}

export interface Pomerado {
  readonly mint: (request: PomeradoRequest) => Effect.Effect<MintOutcome, Error>;
  readonly run: (
    artifact: MintArtifact,
    request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
  ) => Effect.Effect<unknown, Error>;
}

export const Artifact = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  entrypoint: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
});
export type { MintArtifact, MintOutcome };
