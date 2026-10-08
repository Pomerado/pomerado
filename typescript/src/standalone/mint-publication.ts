import { Effect, Either } from "effect";
import { expectedConfirmLimit } from "../browser/dialogs/expected.js";
import { runLocalOperation } from "../execution/local-operation.js";
import { MintFailure, type MintDependencies } from "../mint/contracts.js";
import { runnableOperationFiles, savedOperationFiles } from "../mint/operation-source.js";
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
import { holdsSecretHandle } from "../mint/secret-handles.js";
import type { PublishedSignIn } from "../mint/sign-in-recorder.js";
import { sourceDigest } from "../mint/step-checks.js";
import { checkWriteSession } from "../mint/write-session.js";
import type { MintState } from "./mint-state.js";
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

/**
 * The build's verified sign-in as it ships, value-free: its recipe and the address its runs start
 * from. A login URL holding a sign-in value the build was given is refused, naming the login URL
 * and never the value, so the minter can sign in again from a URL without it. A recipe holding one
 * is refused too.
 */
export const screenedSignIn = <E>(
  signIn: PublishedSignIn | undefined,
  assertAbsent: (text: string) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    if (signIn === undefined) return undefined;
    if (Either.isLeft(yield* Effect.either(assertAbsent(signIn.entryUrl))))
      return yield* new MintFailure({
        code: "PublicationUnavailable",
        reason: "login_url_contains_credential",
        publicationFeedback: { parts: [{ part: "loginUrl", credentialKinds: ["credential"] }] },
      });
    yield* assertAbsent(JSON.stringify(signIn.recipe));
    return signIn;
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
      // The composed contract, read offline: the files that ship, screened for secrets and
      // handles, reviewed by Guardian and run in contract mode on the input.
      const extract = Effect.gen(function* () {
        // What the operation can load ships: all of src/, the entrypoint and the probes it imports.
        const snapshot = new Map(yield* workspace.snapshot);
        const files = savedOperationFiles(snapshot, publication.entrypoint);
        const sources = [...files];
        for (const [, text] of sources) yield* secrets.assertAbsent(text);
        const signIn = yield* screenedSignIn(state.recorder.published(), secrets.assertAbsent);
        // Published code never holds a handle: no saved file the operation could run may hold one,
        // whatever its extension. That is every saved file when Node could load one its imports
        // don't name (see runnableOperationFiles). Otherwise a probe no import reaches, saved only
        // because the workspace has a package manifest, is not checked.
        const runnable = runnableOperationFiles(snapshot, publication.entrypoint);
        if ([...runnable.values()].some(holdsSecretHandle))
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
        return {
          files,
          sources,
          signIn,
          result,
          contract: result,
          inputDecodes: result.inputDecodes === true,
        };
      });
      // A write first proves its session may have sent the write, then that its composed contract
      // matches the session and names each step a confirm popup was accepted at. The local host
      // counts no requests, so a step whose journal saw a browser call counts as possibly sent,
      // as do a confirmation and an entered commit mark.
      const session = write
        ? yield* checkWriteSession({
            session: { steps: writeSession.steps, nonReadRequests: 0 },
            step: sample.journal,
            extract,
            confirms: { steps: writeSession.confirmSteps, entrypoint: publication.entrypoint },
          })
        : undefined;
      const { files, sources, signIn, result } = session?.extracted ?? (yield* extract);
      const acts = [...runs].filter(([, run]) => run.purpose === "act");
      // A write is judged against the act session that performed it, since its composed script
      // never ran; a read against the example that ran, whose source Guardian reads as executed.
      const judged =
        session !== undefined
          ? {
              note: publicationEvidenceNote({
                kind: "write",
                writeConfirmation: session.declared,
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
          ...(signIn === undefined ? {} : { signIn }),
          ...(write && writeSession.acceptedConfirms.length > 0
            ? { acceptedConfirms: writeSession.acceptedConfirms.slice(0, expectedConfirmLimit) }
            : {}),
        },
        diagnostics: [],
      };
    }).pipe(Effect.mapError(publicationError));
