import { Effect, Schema } from "effect";
import { publicDefinitionPath } from "../guardian/publication.js";
import type { PublicationScope } from "../guardian/review-contracts.js";
import { inlineLocalRefs, UnresolvedSchemaReference } from "../registry/schema-references.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { MintFailure } from "./contracts.js";
import { entrypointImportClosure } from "./operation-source.js";

/**
 * The publication review every host runs on finish_build, after its own checks: one Guardian
 * review of the bundle that would ship, the public definition the host writes from the build's
 * metadata and schemas, and the example's screened output or, for a write, the act session that
 * performed it. A host supplies the review itself through `PublicationReview`, and screens the
 * example's output before it reaches this module.
 */

type Json = Readonly<Record<string, unknown>>;

/** The host's record of a read example's output, for publication review only. */
export const exampleOutputPath = "publication/example-output.json";
/** A write session's evidence: each act step's source, then the named step's output. */
export const sessionOutputPath = "publication/session-output.json";
/** Where each act step's source sits: historical evidence of what ran, never what ships. */
const sessionStepsDirectory = "publication/session/";
export const sessionStepPath = (index: number, path: string) =>
  `${sessionStepsDirectory}${index}/${path}`;

// Publication review judges claims against this envelope, so an oversized one carries an
// explicitly truncated prefix rather than exhausting the review's bounded turns.
const maximumEvidenceBytes = 96 * 1024;

type ExampleOutputState = "available" | "truncated" | "withheld" | "not_retained";
/** Which execution produced the output, and the source it ran. */
export interface ExampleOutputSource {
  readonly kind?: "verified_example_output" | "write_session_output";
  readonly executionId: string;
  readonly executedEntrypoint: string;
  /** A read example's executed source digest; a write session's record names its step instead. */
  readonly executedSourceDigest?: string;
}
interface ExampleOutputEvidence {
  readonly state: ExampleOutputState;
  readonly text: string;
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** A UTF-16 prefix that never ends inside a surrogate pair, so it encodes to whole code points. */
const codePointPrefix = (text: string, length: number) => {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
};

const outputRecord = (
  source: ExampleOutputSource,
  state: ExampleOutputState,
  fields: Json = {},
): ExampleOutputEvidence => ({
  state,
  text: JSON.stringify(
    {
      kind: source.kind ?? "verified_example_output",
      executionId: source.executionId,
      executedEntrypoint: source.executedEntrypoint,
      ...(source.executedSourceDigest === undefined
        ? {}
        : { executedSourceDigest: source.executedSourceDigest }),
      state,
      ...fields,
    },
    null,
    2,
  ),
});

/**
 * The actual validated output the example or the named act step returned, bound to the source
 * that ran. `screened` is that output as the host's screening leaves it, as JSON text, and
 * undefined when the host kept none. `credentialFree` is the host's credential precheck: it sees
 * the whole record first, since a cut inside a URL-embedded credential would leave an unmatched
 * prefix, and the cut record again. A record that fails it is withheld; one past 96 KiB keeps a
 * prefix of the output that ends on a code point.
 */
export const exampleOutputEvidence = (
  source: ExampleOutputSource,
  screened: string | undefined,
  credentialFree: (text: string) => Effect.Effect<boolean>,
): Effect.Effect<ExampleOutputEvidence> =>
  Effect.gen(function* () {
    if (screened === undefined) return outputRecord(source, "not_retained");
    const withheld = outputRecord(source, "withheld", { reason: "credential_precheck" });
    const screenedBytes = byteLength(screened);
    const complete = outputRecord(source, "available", { screenedBytes, output: screened });
    if (!(yield* credentialFree(complete.text))) return withheld;
    if (byteLength(complete.text) <= maximumEvidenceBytes) return complete;
    const truncatedAt = (length: number) =>
      outputRecord(source, "truncated", {
        screenedBytes,
        output: codePointPrefix(screened, length),
      });
    // Every UTF-16 unit serializes to at least one byte, so the prefix is shorter than the bound.
    let fits = 0;
    let exceeds = Math.min(screened.length, maximumEvidenceBytes) + 1;
    while (exceeds - fits > 1) {
      const middle = Math.floor((fits + exceeds) / 2);
      if (byteLength(truncatedAt(middle).text) <= maximumEvidenceBytes) fits = middle;
      else exceeds = middle;
    }
    const truncated = truncatedAt(fits);
    return (yield* credentialFree(truncated.text)) ? truncated : withheld;
  });

/**
 * One review's host-built publication files besides the definition: the output or session
 * evidence and any of the host's own, and the bundle paths the host wrote itself.
 */
export interface PublicationEvidence {
  readonly files: ReadonlyMap<string, string>;
  /** Bundle paths the host wrote, which nothing the minter edits changes. */
  readonly hostWritten: ReadonlySet<string>;
}

/**
 * The index of a publication review's evidence: every bundle file under `operation/`, then each
 * publication file. The bundle and the public definition ship; the other publication files are
 * evidence for the review only. A write session's act-step source is historical; everything
 * else is current. The host wrote every publication file and the bundle files it added; the
 * minter wrote the rest.
 */
export const publicationScope = (
  files: ReadonlyMap<string, string>,
  publicationFiles: ReadonlyMap<string, string>,
  hostWritten: ReadonlySet<string>,
): PublicationScope => ({
  files: [
    ...[...files].map(([path, source]) => ({
      path: `operation/${path}`,
      byteLength: byteLength(source),
      published: true,
      current: true,
      owner: hostWritten.has(path) ? ("host" as const) : ("minter" as const),
    })),
    ...[...publicationFiles].map(([path, source]) => ({
      path,
      byteLength: byteLength(source),
      published: path === publicDefinitionPath,
      current: !path.startsWith(sessionStepsDirectory),
      owner: "host" as const,
    })),
  ],
});

/**
 * A write session's evidence files: each act step's entrypoint and the modules it imports, in
 * order, under `publication/session/<step>/`. A step's workspace also held files it never ran.
 */
export const sessionEvidenceFiles = (
  steps: readonly { readonly entrypoint: string; readonly files: ReadonlyMap<string, string> }[],
): ReadonlyMap<string, string> =>
  new Map(
    steps.flatMap((step, index) =>
      [...entrypointImportClosure(step.files, step.entrypoint)].map(
        ([path, source]) => [sessionStepPath(index, path), source] as const,
      ),
    ),
  );

/**
 * The public definition as Guardian reads it, at `publication/definition.json`: the build's name
 * and description, then its input and output schemas and declared questions. A host with fields
 * of its own places them before the schemas or after them.
 */
export const publicDefinition = (
  metadata: { readonly name: string; readonly description: string },
  schemas: {
    readonly input: unknown;
    readonly output: unknown;
    readonly questions?: ScriptQuestionDeclarations;
  },
  host: { readonly beforeSchemas?: Json; readonly afterSchemas?: Json } = {},
) =>
  JSON.stringify(
    {
      name: metadata.name,
      description: metadata.description,
      ...host.beforeSchemas,
      inputSchema: schemas.input,
      outputSchema: schemas.output,
      ...(schemas.questions === undefined ? {} : { questions: schemas.questions }),
      ...host.afterSchemas,
    },
    null,
    2,
  );

/** What a publication is judged against: the read example that ran, or the write session. */
type PublicationExample =
  | {
      readonly kind: "read";
      /** The example's entrypoint, served under `executed/`. */
      readonly entrypoint: string;
      readonly completed: boolean;
      /** The source changed after the example ran, so the schemas were read again offline. */
      readonly schemasReadOffline?: boolean;
    }
  | {
      readonly kind: "write";
      readonly writeConfirmation: "message" | "readback" | "unverifiable";
      /** The session ran the agent's exampleInput because the caller sent none. */
      readonly intentDerived: boolean;
    };

/** What the review is told about its evidence, part of the notes a host gives it. */
export const publicationEvidenceNote = (example: PublicationExample) =>
  example.kind === "read"
    ? `The actual ${example.completed ? "completed" : "failed"} example used executed/${example.entrypoint}; its actual screened output and provenance are in ${exampleOutputPath}. Judge the declared capability claims against that output, not against exploratory probe observations. Its input/output contract was extracted from the imported operation before running the business action.${example.schemasReadOffline === true ? " The source changed after the example ran, so the host read the input and output schemas and questions again offline from current source and checked that the example's own input and output decode against them." : ""} Inspect its baseline and current source for schema compatibility. Publish only if the JSON schemas in publication/definition.json still describe the current operation.`
    : `This is a write build. Its one real write ran as the act session under publication/session/: step N's source is under publication/session/N/, in order, and ${sessionOutputPath} holds the screened output of the step named for publication. The composed operation was never run. The host extracted its input/output contract and declared write confirmation (${example.writeConfirmation}) offline from current source, and ${example.intentDerived ? "the input the session ran, the agent's exampleInput read from the request and the owner's answers because the caller sent none," : "the caller's own input"} decodes against it. Judge the composed script against the session steps, their outputs and the captures: it must reproduce the same flow from its input, perform and return the confirmation or read-back it declares, and never resubmit or commit twice. 'unverifiable' is valid only if the session evidence shows the site offered neither a confirmation nor a read-back. Each confirm popup must keep the session step's literal decideDialog step name. Do not call for another run of the write.`;

/** The authority a publication review grants: publish what is under review, run nothing. */
const publicationAllowedEffect =
  "Publish the current operation bundle, including the files the host adds to it, and the public definition only; do not execute the business action again.";

/**
 * A host's Guardian review of a publication: `files` is the bundle, `evidence` its publication
 * files with the definition first, and `baseline` the source a read example ran, served under
 * `executed/`. It returns the review's ID once Guardian allows; a denial fails as `ReviewDenied`
 * with Guardian's reason and findings.
 */
export type PublicationReview = (request: {
  readonly entrypoint: string;
  readonly files: ReadonlyMap<string, string>;
  readonly allowedEffects: readonly string[];
  readonly notes: string;
  readonly baseline?: ReadonlyMap<string, string>;
  readonly evidence: PublicationEvidence;
}) => Effect.Effect<string, MintFailure>;

/** What one finish_build would publish, and the evidence it is reviewed against. */
export interface PublicationCandidate {
  readonly entrypoint: string;
  /** The bundle that would ship, by path, without the `operation/` prefix. */
  readonly files: ReadonlyMap<string, string>;
  /** `publicDefinition`'s text. */
  readonly definition: string;
  /** The output or session evidence and any host files; the definition goes first. */
  readonly evidence: PublicationEvidence;
  readonly baseline?: ReadonlyMap<string, string>;
  /** Host text the review reads after the build's observations. */
  readonly notes: string;
  /** The published input schema, as JSON Schema. */
  readonly inputSchema: unknown;
  /** The agent's exampleInput the example or the write session ran because the caller sent none. */
  readonly intentDerivedInput?: Json;
  readonly write: boolean;
}

/**
 * The property names an input schema lists at its root, with a root `$ref` resolved and every
 * `anyOf`, `oneOf` or `allOf` branch counted. Undefined when neither the root nor a branch has
 * `properties` at all, or a reference cannot be resolved, so there is nothing to check against.
 */
const listedInputKeys = (schema: unknown) => {
  if (typeof schema !== "object" || schema === null) return undefined;
  let root: Record<string, unknown>;
  try {
    root = inlineLocalRefs({ ...schema });
  } catch (error) {
    if (error instanceof UnresolvedSchemaReference) return undefined;
    throw error;
  }
  const branches = [
    root,
    ...["anyOf", "oneOf", "allOf"].flatMap((key) => {
      const listed = root[key];
      return Schema.is(Schema.Array(Schema.Unknown))(listed) ? listed : [];
    }),
  ];
  const listings = branches.flatMap((branch) =>
    typeof branch === "object" && branch !== null && "properties" in branch
      ? [branch.properties]
      : [],
  );
  // A no-input tool's empty properties lists nothing, so every example key is missing from it.
  return listings.length === 0
    ? undefined
    : new Set(
        listings.flatMap((properties: unknown) =>
          typeof properties === "object" && properties !== null ? Object.keys(properties) : [],
        ),
      );
};

/**
 * Runs the publication review and returns the allowing review's ID. An intent-derived example
 * input key the published schema does not list is a value the tool fixes itself: once Guardian
 * allows, it comes back as the host's own input feedback on the reviewed candidate, so, like
 * Guardian's, the minter gets rounds to fix it.
 */
export const reviewPublication = (review: PublicationReview, candidate: PublicationCandidate) =>
  Effect.gen(function* () {
    const listed = listedInputKeys(candidate.inputSchema);
    const unlisted =
      listed === undefined
        ? []
        : Object.keys(candidate.intentDerivedInput ?? {}).filter((key) => !listed.has(key));
    const reviewId = yield* review({
      entrypoint: candidate.entrypoint,
      files: candidate.files,
      allowedEffects: [publicationAllowedEffect],
      notes: candidate.notes,
      ...(candidate.baseline === undefined ? {} : { baseline: candidate.baseline }),
      evidence: {
        files: new Map([[publicDefinitionPath, candidate.definition], ...candidate.evidence.files]),
        hostWritten: candidate.evidence.hostWritten,
      },
    });
    if (unlisted.length === 0) return reviewId;
    const inputSchemaAt = byteLength(
      candidate.definition.slice(0, candidate.definition.indexOf('"inputSchema"')),
    );
    return yield* new MintFailure({
      code: "ReviewDenied",
      review: {
        outcome: "deny",
        reason: "input_feedback",
        reviewId,
        rationale: `The ${candidate.write ? "write session" : "example"} ran with ${unlisted.map((key) => JSON.stringify(key)).join(", ")} in its exampleInput, which the input schema does not list, so the tool fixes that value itself. Make each an input property.`,
        findings: [
          {
            path: publicDefinitionPath,
            byteStart: inputSchemaAt,
            byteEnd: inputSchemaAt + '"inputSchema"'.length,
            category: "example_input",
          },
        ],
      },
    });
  });
