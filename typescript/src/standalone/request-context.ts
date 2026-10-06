import { randomUUID } from "node:crypto";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  guardianOutageRetry,
  makeGuardian,
  ReviewFailure,
  type PendingExecution,
} from "../guardian/review.js";
import { makeOpenAIReviewer } from "../guardian/openai.js";
import {
  answersForReview,
  type AnsweredQuestion,
  type PendingQuestion,
} from "../guardian/question.js";
import { makeSourceInspector } from "../guardian/source.js";
import type { ExecutionEvidence } from "../mint/contracts.js";
import {
  allowedEffectsFor,
  currentDateObservations,
  intentWithApproval,
  makeStepResults,
  mintReviewContext,
  pageLocation,
  reviewDenied,
  reviewFailureOf,
  type CurrentExecution,
  type ExecutionEntry,
  type MintReviewHost,
  type ObservedPage,
} from "../mint/review-context.js";
import { repeatableReadFor, writeUpgradeApproval } from "../mint/step-checks.js";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import { error } from "./errors.js";
import { failureDetail } from "../runtime/failure-detail.js";
const sourceInspector = (session: StandaloneSession, sources: ReadonlyMap<string, string>) => {
  const { trustedSources, secrets } = session;
  return makeSourceInspector(
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

/** Where Guardian reads the page the build last observed. */
const capturePath = "captures/current-page.aria.yml";
const captureBytes = 256 * 1024;
const captureMarker = "\n…[truncated at 256 KiB]";
const PageSnapshot = Schema.Struct({ url: Schema.String, capture: Schema.String });
/** A readable capture within its cap, cut on a character. */
const cappedCapture = (capture: string) => {
  const bytes = new TextEncoder().encode(capture);
  if (bytes.byteLength <= captureBytes) return capture;
  const kept = new TextDecoder().decode(bytes.subarray(0, captureBytes));
  return `${kept.replace(/�$/u, "")}${captureMarker}`;
};

/** One step Guardian reviews: its files under `operation/`, its input and what it is. */
export interface ReviewStep {
  readonly entrypoint: string;
  readonly sources: ReadonlyMap<string, string>;
  readonly input: unknown;
  readonly currentExecution?: CurrentExecution;
  /** Host text Guardian reads after the build's observations. */
  readonly note?: string;
}

/**
 * The request's Guardian and the facts each review reads: the build's effect and approved
 * upgrade, its browser and the page it last observed, its execution history and step results,
 * and the input schema of its latest example or contract run.
 */
export const requestContext = (session: StandaloneSession, request: PomeradoRequest) =>
  Effect.gen(function* () {
    const { options, policy, secrets, projection, browser } = session;
    const site = yield* requestSite(session, request);
    const { url, siteOrigin } = site;
    const invocationId = randomUUID();
    const observations = currentDateObservations(yield* DateTime.now);
    let buildEffect: "read" | "write" | undefined =
      request.effect === "read" || request.effect === "write" ? request.effect : undefined;
    let claimed = false;
    let approvedChange: string | undefined;
    let navigated = false;
    let observed: { readonly page: ObservedPage; readonly capture: string } | undefined;
    let inputSchema: unknown;
    const executions: ExecutionEntry[] = [];
    const stepResults = makeStepResults();
    const answeredQuestions = new Map<string, AnsweredQuestion>();
    const guardian = makeGuardian(
      {
        ...makeOpenAIReviewer(policy, false, {
          executionEnvironment: "native",
          ...(options.guardianProvider === undefined
            ? {}
            : { modelProvider: options.guardianProvider }),
        }),
        retry: guardianOutageRetry,
      },
      undefined,
      {},
    );
    const host: MintReviewHost = {
      repeatableRead: () => repeatableReadFor(buildEffect, claimed),
      browser: () => (navigated ? "active" : "not_opened"),
      observedPage: () => observed?.page,
      // The local host keeps the page a step leaves open for the next one.
      startsOnFreshPage: () => false,
      executions: () => executions,
      inputSchema: () => inputSchema,
    };
    /** The pending review of `step`, and the files Guardian may read for it. */
    const pending = (step: ReviewStep) =>
      Effect.gen(function* () {
        const mintContext = yield* mintReviewContext(host, projection, step);
        const requestedIntent = secrets.redact(request.intent);
        const turn: PendingExecution = {
          invocationId,
          attemptId: invocationId,
          entrypoint: step.entrypoint,
          screenedIntent: intentWithApproval(requestedIntent, approvedChange),
          requestedIntent,
          screenedInput: secrets.redact(JSON.stringify(step.input)),
          screenedObservations: [
            JSON.stringify(observations),
            ...(step.note ? [step.note] : []),
          ].join("\n"),
          accountScope: invocationId,
          allowedOrigins: [url.origin, ...(request.authenticationOrigins ?? [])],
          allowedEffects:
            step.currentExecution === undefined ? [] : allowedEffectsFor(step.currentExecution),
          answeredQuestions: [...answeredQuestions.values()],
          ...stepResults.forReview(step.currentExecution),
          mintContext,
        };
        const readable = new Map(step.sources);
        // A capture is redacted again on each read, for values the owner gave since.
        if (mintContext.currentPage !== undefined && observed !== undefined)
          readable.set(capturePath, secrets.redact(observed.capture));
        return { turn, readSource: sourceInspector(session, readable) };
      });
    /**
     * Guardian's review of a step: an allow, a refusal with its rationale, or a review that could
     * not complete. `dispatch` is `not_sent` where the step waits on the review to start.
     */
    const review = (step: ReviewStep, dispatch?: "not_sent") =>
      Effect.gen(function* () {
        const { turn, readSource } = yield* pending(step);
        const result = yield* guardian
          .review(turn, readSource)
          .pipe(Effect.mapError((failure) => reviewFailureOf(failure, dispatch)));
        const { outcome, rationale } = result.decision;
        if (outcome !== "allow")
          return yield* reviewDenied(result.reviewId, { outcome, rationale });
        return result;
      });
    /** Guardian's review of a question the minter or a running script asks. */
    const reviewQuestion = (
      step: Omit<ReviewStep, "currentExecution" | "note">,
      question: PendingQuestion,
    ) =>
      Effect.gen(function* () {
        const { turn, readSource } = yield* pending(step);
        return yield* guardian
          .reviewQuestion(turn, question, readSource)
          .pipe(Effect.mapError((failure) => reviewFailureOf(failure)));
      });
    type HistoryStep = {
      readonly purpose: string;
      readonly target: string;
      readonly input?: "agent_chosen";
    };
    /** A step's settled history entry; its result is the next reviews' step result. */
    const settled = (step: HistoryStep, evidence: ExecutionEvidence): ExecutionEntry => {
      stepResults.record(evidence.executionId, evidence.observations);
      return {
        executionId: evidence.executionId,
        attempt: "current",
        purpose: step.purpose,
        target: step.target,
        status: evidence.status,
        effect: evidence.effect,
        ...(evidence.authentication === undefined
          ? {}
          : { authentication: evidence.authentication }),
        ...(step.input === undefined ? {} : { input: step.input }),
      };
    };
    /**
     * Runs a reviewed step with a `running` entry in the history, which its result settles; a
     * step that ends without one is failed.
     */
    const running = <E, R>(step: HistoryStep, run: Effect.Effect<ExecutionEvidence, E, R>) =>
      Effect.suspend(() => {
        const index = executions.length;
        executions.push({
          executionId: `unresolved_${randomUUID()}`,
          attempt: "current",
          purpose: step.purpose,
          target: step.target,
          status: "running",
          effect: step.target === "liveBrowser" ? "possible" : "not_sent",
          ...(step.input === undefined ? {} : { input: step.input }),
        });
        return run.pipe(
          Effect.tap((evidence) =>
            Effect.sync(() => {
              executions[index] = settled(step, evidence);
            }),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const entry = executions[index];
              if (exit._tag === "Failure" && entry?.status === "running")
                executions[index] = { ...entry, status: "failed" };
            }),
          ),
        );
      });
    /** Records a step whose review runs inside it, such as a sign-in, once it settles. */
    const recorded = <E, R>(step: HistoryStep, run: Effect.Effect<ExecutionEvidence, E, R>) =>
      run.pipe(
        Effect.tap((evidence) =>
          Effect.sync(() => {
            executions.push(settled(step, evidence));
          }),
        ),
      );
    /**
     * Reads the page the browser shows, redacted and capped, for the next review. A page that
     * cannot be read leaves no observed page; the step's own result stands.
     */
    const observe = Effect.gen(function* () {
      const read = yield* browser
        .execute(
          `return { url: page.url(), capture: await page.locator("body").ariaSnapshot({ timeout: 5000 }) };`,
          6,
        )
        .pipe(
          Effect.flatMap((value) => Schema.decodeUnknown(PageSnapshot)(value)),
          Effect.option,
        );
      const location = Option.flatMap(read, ({ url: href }) =>
        Option.fromNullable(URL.canParse(href) ? pageLocation(new URL(href)) : undefined),
      );
      observed =
        Option.isNone(read) || Option.isNone(location)
          ? undefined
          : {
              page: {
                origin: secrets.redact(location.value.origin),
                path: secrets.redact(location.value.path),
                capture: capturePath,
              },
              capture: cappedCapture(secrets.redact(read.value.capture)),
            };
    });
    return {
      siteOrigin,
      observations,
      review,
      reviewQuestion,
      running,
      recorded,
      observe,
      /** Opens the request's site once; the browser is active from then on. */
      navigate: Effect.suspend(() =>
        navigated
          ? Effect.void
          : site.navigate.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  navigated = true;
                }),
              ),
            ),
      ),
      executions: () => executions,
      repeatableRead: host.repeatableRead,
      get buildEffect() {
        return buildEffect;
      },
      setBuildEffect: (effect: "read" | "write") => {
        buildEffect = effect;
      },
      get claimed() {
        return claimed;
      },
      claim: () => {
        claimed = true;
      },
      /** An example's or contract run's declared input schema, which later reviews carry. */
      setInputSchema: (schema: unknown) => {
        inputSchema = schema;
      },
      /** Switches a repeatable read to a write once its owner approved `change`. */
      approveWrite: (change: string) =>
        writeUpgradeApproval(
          projection,
          { buildEffect, repeatableRead: host.repeatableRead() },
          change,
        ).pipe(
          Effect.map((approved) => {
            approvedChange = approved;
            buildEffect = "write";
          }),
        ),
      answered: (candidate: InputRequest, answers: ValidAnswers) =>
        answersForReview(candidate, answers, projection.text).pipe(
          Effect.tap((entries) =>
            Effect.sync(() => {
              for (const entry of entries) answeredQuestions.set(entry.question, entry);
            }),
          ),
          Effect.asVoid,
        ),
    };
  });
export type RequestContext = Effect.Effect.Success<ReturnType<typeof requestContext>>;
