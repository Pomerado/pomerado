import type { ModelProvider } from "@openai/agents";
import { type Effect, Schema } from "effect";
import { ExpectedConfirms } from "../browser/dialogs/expected.js";
import { SignInRecipe } from "../destinations/sign-in-recipe.js";
import type { MintOutcome } from "../mint/contracts.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PlaywrightOptions } from "../execution/playwright-execute.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { FileLimits } from "../runtime/files.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
export interface PomeradoOptions {
  readonly ask: InputAsker;
  readonly browser?: PlaywrightOptions;
  readonly minterProvider?: ModelProvider;
  readonly guardianProvider?: ModelProvider;
  /** The outcome reviewer's model provider, which judges whether each write took effect. */
  readonly outcomeReviewerProvider?: ModelProvider;
  readonly policy?: string;
  readonly timeoutMs?: number;
  /**
   * Files a run places and collects. A caller names its own file by a `file:` URL in the input.
   * A run keeps each downloaded file for 30 minutes and returns its `file:` URL: under
   * `downloads` when given, else in this process's temporary directory, which is removed when
   * the process exits. `limits` caps the bytes (`defaultFileLimits`).
   */
  readonly files?: { readonly downloads?: string; readonly limits?: FileLimits };
  /**
   * Checks each control of a read before it publishes: the host builds inputs from the tool's
   * input schema (each field one at a time, bounds, dates, paging, an empty search and a value
   * the page cannot offer) and runs them one at a time in this session's browser. A failing
   * control, an inert one or a schema without examples refuses publication, and the minter fixes
   * it. Absent, no checks run. `budget` caps the cases (24 by default) and `now` is the clock
   * generated dates start from.
   */
  readonly controlChecks?: { readonly budget?: number; readonly now?: () => Date };
}

export interface PomeradoRequest {
  readonly intent: string;
  readonly url: string;
  readonly input?: unknown;
  readonly effect?: "read" | "write" | "ask";
  readonly authenticationOrigins?: readonly string[];
}

/**
 * A local mint's outcome. An unpublished build whose sign-in sent the login only to origins off
 * the site and `authenticationOrigins` names them in `untrustedSignInOrigins`, each an exact
 * origin, whether or not the caller trusted one when asked: answer yes when the build asks, or add
 * one you trust to `authenticationOrigins`, and mint again.
 */
export type LocalMintOutcome = MintOutcome & {
  readonly untrustedSignInOrigins?: readonly string[];
};

export interface Pomerado {
  readonly mint: (request: PomeradoRequest) => Effect.Effect<LocalMintOutcome, Error>;
  /**
   * Runs a minted artifact on `url` with no Guardian review and no model request. Guardian
   * reviewed the artifact when it was minted. `intent`, `effect` and `authenticationOrigins` are
   * not checked here, so run only artifacts you minted or trust. Its sign-in types the login on
   * the site, the request's `authenticationOrigins` and the ones the artifact saved in
   * `signIn.authenticationOrigins`, which a caller trusted when its build asked. A read or a
   * confirmed write returns its output. A failed sign-in fails with `SignInRunFailed`, and any
   * other run with `RunOutcomeFailure`, which says what it did to the website and how to retry.
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
/** A sign-in origin a tool saves: an https origin exactly as `URL.origin` writes it. */
export const SignInOrigin = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return url !== null && url.protocol === "https:" && url.origin === value;
  }),
);
export const Artifact = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  entrypoint: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
  /**
   * The verified sign-in a build recorded: its value-free recipe, where its runs start and the
   * build's https sign-in origins, when it has any.
   */
  signIn: Schema.optionalWith(
    Schema.Struct({
      recipe: SignInRecipe,
      entryUrl: PageUrl,
      authenticationOrigins: Schema.optionalWith(Schema.Array(SignInOrigin), { exact: true }),
    }),
    { exact: true },
  ),
  /** The questions publication reviewed, the only ones a run asks. */
  questions: Schema.optionalWith(ScriptQuestionDeclarations, { exact: true }),
  /** The confirm popups a write's build accepted, as digests its runs accept without asking. */
  acceptedConfirms: Schema.optionalWith(ExpectedConfirms, { exact: true }),
});
export type { MintArtifact, MintOutcome };
