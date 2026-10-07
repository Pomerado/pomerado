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
import { publicationScope, type PublicationReview } from "../mint/publication-review.js";
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
/**
 * The most elements a page may have for the host to capture it. A snapshot's work grows faster
 * than the page: about a second at this size, and past five seconds at four times it. The count
 * covers the main document, not shadow roots or frames; the snapshot's own time limit bounds
 * those.
 */
const captureElements = 10_000;
/**
 * Reads the page in the browser worker: its URL, and its accessibility snapshot cut to 256 KiB
 * there, so no more crosses to the host. A page over the element limit is not snapshotted. The
 * script ends on its own within 8 seconds: it waits at most 3 for the element count and 5 for the
 * snapshot, and a page that does not answer in time, as when its scripts keep it busy, is
 * reported unanswered.
 */
const pageSnapshotCode = `const url = page.url();
const late = Symbol("late");
const within = (seconds, work) => {
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(resolve, seconds * 1000, late);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
};
const elements = await within(3, page.evaluate(() => document.getElementsByTagName("*").length));
if (elements === late) return { url, unanswered: true };
if (elements > ${captureElements}) return { url, elements };
const snapshot = await within(
  5,
  page
    .locator("body")
    .ariaSnapshot({ timeout: 4000 })
    .catch((error) => (error?.name === "TimeoutError" ? late : Promise.reject(error))),
);
if (snapshot === late) return { url, unanswered: true };
const bytes = new TextEncoder().encode(snapshot);
return {
  url,
  capture: new TextDecoder().decode(bytes.subarray(0, ${captureBytes})),
  truncated: bytes.byteLength > ${captureBytes},
};`;
const PageSnapshot = Schema.Union(
  Schema.Struct({ url: Schema.String, unanswered: Schema.Literal(true) }),
  Schema.Struct({ url: Schema.String, elements: Schema.Number }),
  Schema.Struct({ url: Schema.String, capture: Schema.String, truncated: Schema.Boolean }),
);
/** A page capture, redacted with the values known when it was taken, and cut when `truncated`. */
interface PageCapture {
  readonly text: string;
  readonly truncated: boolean;
}

/** One step Guardian reviews: its files under `operation/`, its input and what it is. */
export interface ReviewStep {
  readonly entrypoint: string;
  readonly sources: ReadonlyMap<string, string>;
  readonly input: unknown;
  readonly currentExecution?: CurrentExecution;
  /** The step resets the page before it runs, so the page the last step left is not its page. */
  readonly startsOnFreshPage?: boolean;
  /** Host text Guardian reads after the build's observations. */
  readonly note?: string;
  /** Files Guardian may read besides the step's own, by their full paths. */
  readonly evidence?: ReadonlyMap<string, string>;
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
    let observed: { readonly page: ObservedPage; readonly capture: PageCapture } | undefined;
    let inputSchema: unknown;
    const executions: ExecutionEntry[] = [];
    const stepResults = makeStepResults();
    const answeredQuestions = new Map<string, AnsweredQuestion>();
    /** Handles of codes the agent asked for during this attempt's unverified sign-in. */
    const signInCodeHandles = new Set<string>();
    const signedIn = () =>
      executions.some((execution) => execution.authentication?.state === "authenticated");
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
      // The page's place is redacted again on each read, as its capture is.
      observedPage: () =>
        observed === undefined
          ? undefined
          : {
              ...observed.page,
              origin: secrets.redact(observed.page.origin),
              path: secrets.redact(observed.page.path),
            },
      executions: () => executions,
      inputSchema: () => inputSchema,
      signInCodes: () => (signedIn() ? [] : [...signInCodeHandles]),
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
        const readable = new Map([...step.sources, ...(step.evidence ?? [])]);
        // A capture is redacted on each read, for values the owner gave since it was taken.
        if (mintContext.currentPage !== undefined && observed !== undefined)
          readable.set(capturePath, readableCapture(observed.capture));
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
    /**
     * Guardian's publication review: the bundle under `operation/`, the source a read example ran
     * under `executed/`, and the publication files the host wrote, read against the caller's
     * input. A denial carries Guardian's reason and findings.
     */
    const reviewPublication: PublicationReview = (publication) =>
      Effect.gen(function* () {
        const { turn, readSource } = yield* pending({
          entrypoint: `operation/${publication.entrypoint}`,
          sources: new Map(
            [...publication.files].map(([path, text]) => [`operation/${path}`, text] as const),
          ),
          input: request.input ?? {},
          note: publication.notes,
          evidence: new Map([
            ...[...(publication.baseline ?? [])].map(
              ([path, text]) => [`executed/${path}`, text] as const,
            ),
            ...publication.evidence.files,
          ]),
        });
        const result = yield* guardian
          .review(
            {
              ...turn,
              allowedEffects: publication.allowedEffects,
              publication: publicationScope(
                publication.files,
                publication.evidence.files,
                publication.evidence.hostWritten,
              ),
            },
            readSource,
          )
          .pipe(Effect.mapError((failure) => reviewFailureOf(failure)));
        const { outcome } = result.decision;
        if (outcome !== "allow")
          return yield* reviewDenied(result.reviewId, { ...result.decision, outcome });
        return result.reviewId;
      });
    /** Guardian's review of a question the minter or a running script asks. */
    const reviewQuestion = (
      step: Omit<ReviewStep, "currentExecution" | "startsOnFreshPage" | "note" | "evidence">,
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
    /** Redacts a capture; a cut one keeps no prefix of a secret the cut split. */
    const redactedCapture = (capture: PageCapture): PageCapture => ({
      text: capture.truncated ? secrets.redactCut(capture.text) : secrets.redact(capture.text),
      truncated: capture.truncated,
    });
    /**
     * A capture as Guardian reads it: redacted again, for values the owner gave since it was
     * taken, and within 256 KiB, since a redaction can lengthen it.
     */
    const readableCapture = (capture: PageCapture) => {
      const { text, truncated } = redactedCapture(capture);
      if (!truncated) return text;
      const bytes = new TextEncoder().encode(text);
      const capped =
        bytes.byteLength <= captureBytes
          ? text
          : new TextDecoder().decode(bytes.subarray(0, captureBytes)).replace(/\uFFFD$/u, "");
      return `${capped}${captureMarker}`;
    };
    /**
     * Reads the page the browser shows for the next review. A page that cannot be read leaves no
     * observed page; the step's own result stands. The capture script ends within 8 seconds,
     * well inside the executor's 20, so a page too busy to answer is reported not captured and
     * leaves the browser running.
     */
    const observe = Effect.gen(function* () {
      // A live step ran, so the browser shows a page, even one the step's start reset.
      navigated = true;
      const read = yield* browser.execute(pageSnapshotCode, 20).pipe(
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
              capture:
                "unanswered" in read.value
                  ? {
                      text: "Page not captured: the page did not answer in time, as when its scripts keep it busy.",
                      truncated: false,
                    }
                  : "elements" in read.value
                    ? {
                        text: `Page too large to capture: ${read.value.elements.toLocaleString("en-US")} elements, over the ${captureElements.toLocaleString("en-US")} the host reads.`,
                        truncated: false,
                      }
                    : redactedCapture({
                        // A character the cut split decodes to one replacement character, dropped.
                        text: read.value.truncated
                          ? read.value.capture.replace(/\uFFFD$/u, "")
                          : read.value.capture,
                        truncated: read.value.truncated,
                      }),
            };
    });
    return {
      siteOrigin,
      observations,
      review,
      reviewPublication,
      reviewQuestion,
      running,
      recorded,
      observe,
      /** Opens the request's site, which the build's start does once; the browser is then active. */
      navigate: site.navigate.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            navigated = true;
          }),
        ),
      ),
      /** Drops the observed page: a step's start is resetting it, so no review reads it again. */
      leavePage: () => {
        observed = undefined;
      },
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
      /**
       * Notes the handles the agent received for one-time or authenticator code questions it
       * asked after an authenticate step and before any verified sign-in: codes the site sent as
       * part of that sign-in, which the agent may type into its code screen.
       */
      askedByAgent: (candidate: Pick<InputRequest, "questions">, issued: ValidAnswers) => {
        if (signedIn() || !executions.some((execution) => execution.purpose === "authenticate"))
          return;
        for (const question of candidate.questions) {
          const answer = issued[question.id];
          if (
            question.type === "secret" &&
            (question.secretKind === "one_time_code" || question.secretKind === "totp") &&
            answer?.type === "secret"
          )
            signInCodeHandles.add(answer.value);
        }
      },
      /** The handles `askedByAgent` noted, while no sign-in of this attempt is verified. */
      signInCodes: host.signInCodes,
    };
  });
export type RequestContext = Effect.Effect.Success<ReturnType<typeof requestContext>>;
