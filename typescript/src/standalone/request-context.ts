import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { makeGuardian, ReviewFailure } from "../guardian/review.js";
import type { PendingExecution } from "../guardian/review.js";
import { makeOpenAIReviewer } from "../guardian/openai.js";
import { answersForReview, type AnsweredQuestion } from "../guardian/question.js";
import { makeSourceInspector } from "../guardian/source.js";
import { MintFailure, type ExecutionRequest, type ExecutionEvidence } from "../mint/contracts.js";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import { error } from "./errors.js";
import { failureDetail } from "../runtime/failure-detail.js";
const sourceInspector = (session: StandaloneSession, sources: ReadonlyMap<string, string>) => {
  const { trustedSources, secrets } = session;
  const readSources = (sources: ReadonlyMap<string, string>) =>
    makeSourceInspector(
      (path) => {
        const text = sources.get(path) ?? trustedSources.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      },
      (_path, bytes) =>
        secrets.assertAbsent(new TextDecoder().decode(bytes)).pipe(
          Effect.as(new TextDecoder().decode(bytes)),
          Effect.mapError(
            (cause) =>
              new ReviewFailure({
                code: "SourceUnavailable",
                failureDetail: failureDetail("guardian_dependency_failed", {
                  operation: "standalone.projectSource",
                  error: cause,
                }),
              }),
          ),
        ),
    );
  return readSources(sources);
};
const executionReviewer = (
  guardian: ReturnType<typeof makeGuardian>,
  pending: (entrypoint: string, input: unknown) => PendingExecution,
  readSources: (sources: ReadonlyMap<string, string>) => ReturnType<typeof makeSourceInspector>,
  executions: NonNullable<PendingExecution["mintContext"]>["executions"][number][],
) => {
  const review = (
    entrypoint: string,
    sources: ReadonlyMap<string, string>,
    input: unknown,
    purpose: ExecutionRequest["purpose"] | "command" | "contract",
    target: "pureFiles" | "liveBrowser",
  ) =>
    guardian
      .review(
        {
          ...pending(entrypoint, input),
          mintContext: {
            repeatableRead: false,
            operationSources: [...sources.keys()],
            executedSources: [...sources.keys()],
            currentExecution: { purpose, target },
            browser: "active",
            executions: [...executions],
          },
        },
        readSources(sources),
      )
      .pipe(
        Effect.flatMap((result) =>
          result.decision.outcome === "allow"
            ? Effect.succeed(result)
            : Effect.fail(
                new MintFailure({
                  code: "ReviewDenied",
                  review: {
                    outcome: result.decision.outcome === "deny" ? "deny" : "escalate",
                    rationale: result.decision.rationale,
                    reviewId: result.reviewId,
                  },
                }),
              ),
        ),
      );
  return review;
};
/** The request's checked site and the navigation to it. Builds no Guardian. */
export const requestSite = (session: StandaloneSession, request: Pick<PomeradoRequest, "url">) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({ try: () => new URL(request.url), catch: error });
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return yield* Effect.fail(new Error("Provide an HTTP or HTTPS site URL without credentials"));
    return {
      url,
      siteOrigin: url.origin,
      navigate: session.browser
        .execute(`await page.goto(${JSON.stringify(url.href)}); return null;`, 60)
        .pipe(Effect.asVoid),
    };
  });
export const requestContext = (session: StandaloneSession, request: PomeradoRequest) =>
  Effect.gen(function* () {
    const { options, policy, secrets, projection } = session;
    const { url, siteOrigin, navigate } = yield* requestSite(session, request);
    const invocationId = randomUUID();
    let allowedEffect = request.effect === "write" ? "write" : "read";
    const executions: NonNullable<PendingExecution["mintContext"]>["executions"][number][] = [];
    const answeredQuestions = new Map<string, AnsweredQuestion>();
    const guardian = makeGuardian(
      makeOpenAIReviewer(policy, false, {
        executionEnvironment: "native",
        ...(options.guardianProvider === undefined
          ? {}
          : { modelProvider: options.guardianProvider }),
      }),
      undefined,
      {},
    );
    const pending = (entrypoint: string, input: unknown): PendingExecution => ({
      invocationId,
      attemptId: invocationId,
      entrypoint,
      screenedIntent: secrets.redact(request.intent),
      requestedIntent: secrets.redact(request.intent),
      screenedInput: secrets.redact(JSON.stringify(input)),
      screenedObservations: "Caller-owned local workspace and native Playwright session.",
      accountScope: invocationId,
      allowedOrigins: [url.origin, ...(request.authenticationOrigins ?? [])],
      allowedEffects: allowedEffect === "write" ? ["read", "write"] : ["read"],
      answeredQuestions: [...answeredQuestions.values()],
    });
    const readSources = (sources: ReadonlyMap<string, string>) => sourceInspector(session, sources);
    const review = executionReviewer(guardian, pending, readSources, executions);
    return {
      siteOrigin,
      guardian,
      pending,
      readSources,
      review,
      record: (
        execution: { readonly purpose: string; readonly target: string },
        evidence: ExecutionEvidence,
      ) =>
        executions.push({
          executionId: evidence.executionId,
          attempt: "current",
          purpose: execution.purpose,
          target: execution.target,
          status: evidence.status,
          effect: evidence.effect,
          ...(evidence.authentication === undefined
            ? {}
            : { authentication: evidence.authentication }),
        }),
      answered: (candidate: InputRequest, answers: ValidAnswers) =>
        answersForReview(candidate, answers, projection.text).pipe(
          Effect.tap((entries) =>
            Effect.sync(() => {
              for (const entry of entries) answeredQuestions.set(entry.question, entry);
            }),
          ),
          Effect.asVoid,
        ),
      setEffect: (value: "read" | "write") => {
        allowedEffect = value;
      },
      navigate,
    };
  });
export type RequestContext = Effect.Effect.Success<ReturnType<typeof requestContext>>;
