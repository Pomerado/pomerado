import { Effect, Either } from "effect";
import { runLocalOperation } from "../execution/local-operation.js";
import { MintFailure, type MintDependencies } from "../mint/contracts.js";
import { savedOperationFiles } from "../mint/operation-source.js";
import {
  exampleOutputEvidence,
  exampleOutputPath,
  publicationEvidenceNote,
  publicDefinition,
  reviewPublication,
  sessionEvidenceFiles,
  sessionOutputPath,
  sessionStepPath,
  type ExampleOutputSource,
} from "../mint/publication-review.js";
import { contractExtractionNote } from "../mint/review-context.js";
import { publishedHandlePath } from "../mint/secret-handles.js";
import { sourceDigest } from "../mint/step-checks.js";
import type { MintState } from "./mint-state.js";
import { validateStandaloneWrite } from "./write-completion.js";
import { publicationError } from "./errors.js";

type Run = MintState["runs"] extends Map<string, infer Value> ? Value : never;

/** Bind completion to the actual retained example or confirmed write step. */
const retainedPublicationSample = (
  state: MintState,
  evidence: Parameters<MintDependencies["publish"]>[1],
  entrypoint: string,
) =>
  Effect.suspend(() => {
    const { runs } = state;
    const sample = runs.get(evidence.executionId);
    if (
      sample === undefined ||
      !(
        (sample.purpose === "act" && evidence.confirmation !== undefined) ||
        (evidence.status === "completed" && evidence.resultRef === `local:${evidence.executionId}`)
      ) ||
      (sample.purpose !== "act" && sample.entrypoint !== entrypoint)
    )
      return Effect.fail(new MintFailure({ code: "ScopeDenied" }));
    return Effect.succeed(sample);
  });

/**
 * The step's retained output as publication review reads it: redacted of the build's secrets,
 * then held back whole if a secret is still in it. A step that kept none is `not_retained`.
 */
const outputEvidence = (state: MintState, sample: Run, source: ExampleOutputSource) =>
  Effect.gen(function* () {
    const { secrets, projection } = state.session;
    const screened =
      sample.output === undefined
        ? undefined
        : JSON.stringify(yield* projection.json(sample.output));
    return yield* exampleOutputEvidence(source, screened, (text) =>
      Effect.either(secrets.assertAbsent(text)).pipe(Effect.map(Either.isRight)),
    );
  });

export const mintPublication =
  (state: MintState): MintDependencies["publish"] =>
  (publication, evidence) =>
    Effect.gen(function* () {
      const { runs, workspace, context, writeSession } = state;
      const { secrets, browser } = state.session;
      const sample = yield* retainedPublicationSample(state, evidence, publication.entrypoint);
      const write = sample.purpose === "act";
      // A write's composed contract decodes the input its session ran: the agent's exampleInput
      // when the caller sent none, as the first act step that passed one fixed it, even when the
      // named step ran before it; else the caller's own.
      const input = write ? (writeSession.input ?? sample.input) : sample.input;
      // What the operation can load ships: all of src/, the entrypoint and the probes it imports.
      const files = savedOperationFiles(new Map(yield* workspace.snapshot), publication.entrypoint);
      const sources = [...files];
      for (const [, text] of sources) yield* secrets.assertAbsent(text);
      if (publishedHandlePath(files, [publication.entrypoint]) !== undefined)
        return yield* Effect.fail(
          new MintFailure({
            code: "PublicationUnavailable",
            reason: "secret_handle",
          }),
        );
      yield* context.review({
        entrypoint: `operation/${publication.entrypoint}`,
        sources: new Map(sources.map(([path, text]) => [`operation/${path}`, text])),
        input,
        currentExecution: { purpose: "contract", target: "pureFiles" },
        note: contractExtractionNote,
      });
      const result = yield* runLocalOperation({
        workspace,
        entrypoint: publication.entrypoint,
        sources,
        input,
        validateInput: true,
        ...(write ? {} : { retainedOutput: { value: sample.output } }),
        browser,
        mode: "contract",
        target: "pureFiles",
      });
      context.setInputSchema(result.schemas.input);
      const acts = [...runs].filter(([, run]) => run.purpose === "act");
      // A write is judged against the act session that performed it, since its composed script
      // never ran; a read against the example that ran, whose source Guardian reads as executed.
      const judged = write
        ? {
            note: publicationEvidenceNote({
              kind: "write",
              writeConfirmation: yield* validateStandaloneWrite(result, {
                named: sample.journal,
                steps: acts.map(([, run]) => run.journal),
              }),
              intentDerived: writeSession.input !== undefined,
            }),
            files: new Map([
              [
                sessionOutputPath,
                (yield* outputEvidence(state, sample, {
                  kind: "write_session_output",
                  executionId: evidence.executionId,
                  executedEntrypoint: sessionStepPath(
                    acts.findIndex(([id]) => id === evidence.executionId),
                    sample.entrypoint,
                  ),
                })).text,
              ],
              ...sessionEvidenceFiles(
                acts.map(([, run]) => ({
                  entrypoint: run.entrypoint,
                  files: new Map(run.sources),
                })),
              ),
            ]),
            intentDerivedInput: writeSession.input,
          }
        : yield* Effect.gen(function* () {
            const baseline = savedOperationFiles(new Map(sample.sources), sample.entrypoint);
            const output = yield* outputEvidence(state, sample, {
              executionId: evidence.executionId,
              executedEntrypoint: `executed/${sample.entrypoint}`,
              executedSourceDigest: sourceDigest(baseline),
            });
            return {
              note: publicationEvidenceNote({
                kind: "read",
                entrypoint: sample.entrypoint,
                completed: evidence.status === "completed",
                schemasReadOffline: sourceDigest(baseline) !== sourceDigest(files),
              }),
              files: new Map([[exampleOutputPath, output.text]]),
              baseline,
              intentDerivedInput: sample.intentDerivedInput,
            };
          });
      yield* reviewPublication(context.reviewPublication, {
        entrypoint: publication.entrypoint,
        files,
        definition: publicDefinition(publication.metadata, result.schemas),
        evidence: judged.files,
        ...("baseline" in judged ? { baseline: judged.baseline } : {}),
        notes: `${judged.note} Coverage: ${secrets.redact(publication.coverage)}`,
        inputSchema: result.schemas.input,
        ...(judged.intentDerivedInput === undefined
          ? {}
          : { intentDerivedInput: judged.intentDerivedInput }),
        write,
      });
      return {
        artifact: {
          files: sources.map(([path, content]) => ({ path, content })),
          entrypoint: publication.entrypoint,
          inputSchema: result.schemas.input,
          outputSchema: result.schemas.output,
        },
        diagnostics: [],
      };
    }).pipe(Effect.mapError(publicationError));
