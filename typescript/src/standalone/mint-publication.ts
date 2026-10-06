import { Effect } from "effect";
import { runLocalOperation } from "../execution/local-operation.js";
import { MintFailure, type MintDependencies } from "../mint/contracts.js";
import { contractExtractionNote } from "../mint/review-context.js";
import { publishedHandlePath } from "../mint/secret-handles.js";
import type { MintState } from "./mint-state.js";
import { validateStandaloneWrite } from "./write-completion.js";
import { publicationError } from "./errors.js";

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
export const mintPublication =
  (state: MintState): MintDependencies["publish"] =>
  (publication, evidence) =>
    Effect.gen(function* () {
      const { runs, workspace, context } = state;
      const { secrets, browser } = state.session;
      const sample = yield* retainedPublicationSample(state, evidence, publication.entrypoint);
      // A write's composed contract decodes the input its session ran: the agent's exampleInput
      // when the caller sent none, else the caller's own.
      const input =
        sample.purpose === "act" ? (state.writeSession.input ?? sample.input) : sample.input;
      const sources = (yield* workspace.snapshot).filter(([path]) =>
        /^(src|explore|test|scratch)\//u.test(path),
      );
      for (const [, text] of sources) yield* secrets.assertAbsent(text);
      if (publishedHandlePath(new Map(sources), [publication.entrypoint]) !== undefined)
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
        ...(sample.purpose === "act" ? {} : { retainedOutput: { value: sample.output } }),
        browser,
        mode: "contract",
        target: "pureFiles",
      });
      context.setInputSchema(result.schemas.input);
      if (sample.purpose === "act")
        yield* validateStandaloneWrite(result, {
          named: sample.journal,
          steps: [...runs.values()]
            .filter((run) => run.purpose === "act")
            .map((run) => run.journal),
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
