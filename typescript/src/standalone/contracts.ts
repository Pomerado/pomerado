import type { ModelProvider } from "@openai/agents";
import { type Effect, Schema } from "effect";
import { ExpectedConfirms } from "../browser/dialogs/expected.js";
import { SignInRecipe } from "../destinations/sign-in-recipe.js";
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
  /**
   * Runs a minted artifact on `url` with no Guardian review and no model request. Guardian
   * reviewed the artifact when it was minted. `intent`, `effect` and `authenticationOrigins` are
   * not checked here, so run only artifacts you minted or trust.
   */
  readonly run: (
    artifact: MintArtifact,
    request: Omit<PomeradoRequest, "effect"> & { readonly effect?: "read" | "write" },
  ) => Effect.Effect<unknown, Error>;
}

/** A web page a run can open: an http or https URL with no credentials and no fragment. */
export const PageUrl = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }),
);
export const Artifact = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  entrypoint: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
  /** The verified sign-in a build recorded: its value-free recipe and where its runs start. */
  signIn: Schema.optionalWith(Schema.Struct({ recipe: SignInRecipe, entryUrl: PageUrl }), {
    exact: true,
  }),
  /** The confirm popups a write's build accepted, as digests its runs accept without asking. */
  acceptedConfirms: Schema.optionalWith(ExpectedConfirms, { exact: true }),
});
export type { MintArtifact, MintOutcome };
