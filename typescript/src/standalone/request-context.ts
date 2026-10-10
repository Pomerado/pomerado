import type { WriteOutcome } from "../mint/outcome-review-contracts.js";
import { randomUUID } from "node:crypto";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  guardianOutageRetry,
  makeGuardian,
  ReviewFailure,
  type PendingExecution,
} from "../guardian/review.js";
import { makeOpenAIReviewer, nativeExecutionEnvironment } from "../guardian/openai.js";
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
import { repeatableReadFor } from "../mint/step-checks.js";
import type {
  TaskUpdateApplication,
  TaskUpdateCandidate,
  TaskUpdateHostResult,
} from "../mint/contracts.js";
import type { ReviewedTaskUpdate } from "../guardian/task-update.js";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import { error } from "./errors.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { runtimeSourceEntry } from "../execution/runtime-sources.js";
/** The folder a review's authored files sit in, where staged runs also link the SDK. */
const operationPrefix = "operation/";
/** The SDK's package path, as an import names it and as the staged package holds it. */
const runtimePackagePaths = new Set(["pomerado/runtime", "node_modules/pomerado/runtime.js"]);
/** A trusted SDK path: the package path reads the module it names. */
const trustedPath = (path: string) =>
  runtimePackagePaths.has(path) ? runtimeSourceEntry : path;
/**
 * Guardian's source reads: the review's own file at the path, else the trusted SDK's. Authored
 * source imports the SDK from inside `operation/`, as `../../runtime/index.js` from `src/`, so a
 * path there that no authored file holds reads the SDK file at the rest of the path. A bare
 * `pomerado/runtime` reads the module that package path names.
 */
export const sourceInspector = (
  session: Pick<StandaloneSession, "trustedSources" | "secrets">,
  sources: ReadonlyMap<string, string>,
) => {
  const { trustedSources, secrets } = session;
  return makeSourceInspector(
    (path) => {
      const text =
        sources.get(path) ??
        trustedSources.get(trustedPath(path)) ??
        (path.startsWith(operationPrefix)
          ? trustedSources.get(trustedPath(path.slice(operationPrefix.length)))
          : undefined);
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
 * The request's Guardian and the facts each review reads: the effective task (the build's
 * effect, site, input and accepted updates), its browser and the page it last observed, its
 * execution history and step results, and the input schema of its latest example or contract run.
 */
export const requestContext = (session: StandaloneSession, request: PomeradoRequest) =>
  Effect.gen(function* () {
    const { options, policy, secrets, projection, browser } = session;
    let site = yield* requestSite(session, request);
    const invocationId = randomUUID();
    const observations = currentDateObservations(yield* DateTime.now);
    let buildEffect: "read" | "write" | undefined =
      request.effect === "read" || request.effect === "write" ? request.effect : undefined;
    let claimed = false;
    /** The effective task: the caller's input and the updates the host applied, oldest first. */
    let input: unknown = request.input ?? {};
    const taskUpdates: ReviewedTaskUpdate[] = [];
    /** The task revision an execution recorded now runs under, once an update applied. */
    const revision = () =>
      taskUpdates.length === 0 ? {} : { taskRevision: taskUpdates.at(-1)?.revision ?? 0 };
    let navigated = false;
    let observed: { readonly page: ObservedPage; readonly capture: PageCapture } | undefined;
    /** The address of the page `observed` came from, unredacted, for the host's own loads. */
    let observedUrl: string | undefined;
    let inputSchema: unknown;
    const executions: ExecutionEntry[] = [];
    /** Each settled step's entrypoint, for the live-test count; Guardian's history omits it. */
    const entrypoints = new Map<string, string>();
    const stepResults = makeStepResults();
    const answeredQuestions = new Map<string, AnsweredQuestion>();
    /** Handles of codes the agent asked for during this attempt's unverified sign-in. */
    const signInCodeHandles = new Set<string>();
    /** Where this site's history starts: a site change leaves the earlier site's sign-ins behind. */
    let siteSince = 0;
    /** The request's own sign-in origins, which belong to its first site only. */
    let authenticationOrigins: readonly string[] = request.authenticationOrigins ?? [];
    const signedIn = () =>
      executions
        .slice(siteSince)
        .some((execution) => execution.authentication?.state === "authenticated");
    const guardian = makeGuardian(
      {
        ...makeOpenAIReviewer(policy, false, {
          executionEnvironment: nativeExecutionEnvironment,
          ...(options.guardianProvider === undefined
            ? {}
            : { modelProvider: options.guardianProvider }),
        }),
        retry: guardianOutageRetry,
      },
      undefined,
      {},
    );
    /** The build's tracked writes, once the harness's outcome reviewer binds them. */
    let writes: (() => readonly WriteOutcome[]) | undefined;
    const host: MintReviewHost = {
      writes: () => writes?.() ?? [],
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
          screenedIntent: requestedIntent,
          requestedIntent,
          ...(taskUpdates.length === 0 ? {} : { taskUpdates: [...taskUpdates] }),
          screenedInput: secrets.redact(JSON.stringify(step.input)),
          screenedObservations: [
            JSON.stringify(observations),
            ...(step.note ? [step.note] : []),
          ].join("\n"),
          accountScope: invocationId,
          allowedOrigins: [site.siteOrigin, ...authenticationOrigins],
          allowedEffects:
            step.currentExecution === undefined ? [] : allowedEffectsFor(step.currentExecution),
          // Only a write build's write session may change the site.
          writeAuthority:
            buildEffect === "write" &&
            step.currentExecution?.purpose === "act" &&
            step.currentExecution.target === "liveBrowser",
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
          input,
          note: publication.notes,
          evidence: new Map([
            ...[...(publication.baseline ?? [])].map(
              ([path, text]) => [`executed/${path}`, text] as const,
            ),
            ...publication.evidence,
          ]),
        });
        const result = yield* guardian
          .review(
            {
              ...turn,
              allowedEffects: publication.allowedEffects,
              publication: publicationScope(publication.files, publication.evidence),
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
      readonly entrypoint?: string;
      readonly input?: "agent_chosen";
    };
    /** A step's settled history entry; its result is the next reviews' step result. */
    const settled = (step: HistoryStep, evidence: ExecutionEvidence): ExecutionEntry => {
      stepResults.record(evidence.executionId, evidence.observations);
      if (step.entrypoint !== undefined) entrypoints.set(evidence.executionId, step.entrypoint);
      return {
        executionId: evidence.executionId,
        attempt: "current",
        purpose: step.purpose,
        target: step.target,
        status: evidence.status,
        effect: evidence.effect,
        ...revision(),
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
          ...revision(),
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
      observedUrl = Option.isSome(read) ? read.value.url : undefined;
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
    /** Guardian's review of a proposed task update, against the task as it stands. */
    const reviewTaskUpdate = (candidate: TaskUpdateCandidate) =>
      Effect.gen(function* () {
        const { turn, readSource } = yield* pending({
          entrypoint: "task-update",
          sources: new Map(),
          input,
        });
        return yield* guardian
          .reviewTaskUpdate(turn, candidate.update, readSource)
          .pipe(Effect.mapError((failure) => reviewFailureOf(failure)));
      });
    /**
     * Applies an update Guardian allowed, all or nothing. The local host has no intake screen,
     * duplicate check, saved logins or checkpoint store: it rebinds the site, input and effect,
     * and a sign-in on a new site asks the caller as any sign-in does. `rebind` binds the build's
     * browser pieces to a new site; only once it succeeds does anything switch, and the earlier
     * site's sign-in origins, sign-ins, codes and observed page are left behind.
     */
    const applyTaskUpdate = (
      application: TaskUpdateApplication,
      rebind: (siteOrigin: string) => Effect.Effect<void, Error>,
    ): Effect.Effect<TaskUpdateHostResult, Error> =>
      Effect.gen(function* () {
        const { next, update } = application;
        const moved =
          next.siteOrigin !== undefined && next.siteOrigin !== site.siteOrigin
            ? yield* requestSite(session, { url: `${next.siteOrigin}/` })
            : undefined;
        if (moved !== undefined) yield* rebind(moved.siteOrigin);
        // Nothing below fails, so the update switches every binding at once.
        if (moved !== undefined) {
          site = moved;
          authenticationOrigins = [];
          siteSince = executions.length;
          signInCodeHandles.clear();
          observed = undefined;
          observedUrl = undefined;
        }
        input = next.businessInput;
        if (next.effect === "write" && buildEffect !== "write") {
          buildEffect = "write";
          // A read example's claim was the read's; the write session takes its own.
          claimed = false;
        }
        taskUpdates.push({
          revision: update.revision,
          summary: update.summary,
          changes: update.changes,
          confirmation: update.confirmation,
        });
        return { outcome: "applied" } as const;
      });
    return {
      /** The site the build works on now. */
      get siteOrigin() {
        return site.siteOrigin;
      },
      /** The sign-in origins the build's current site takes besides its own. */
      get authenticationOrigins() {
        return authenticationOrigins;
      },
      /** The caller's input as the effective task has it. */
      get input() {
        return input;
      },
      observations,
      review,
      reviewTaskUpdate,
      applyTaskUpdate,
      reviewPublication,
      reviewQuestion,
      running,
      recorded,
      observe,
      /** Opens the build's site, which the build's start does once; the browser is then active. */
      navigate: Effect.suspend(() => site.navigate).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            navigated = true;
          }),
        ),
      ),
      /** Drops the observed page: a step's start is resetting it, so no review reads it again. */
      leavePage: () => {
        observed = undefined;
        observedUrl = undefined;
      },
      /** The accessibility snapshot of the page the last live step left, redacted, if taken. */
      get observedCapture() {
        return observed?.capture.text;
      },
      /** The address of the page the last live step left, as the browser reported it. */
      get observedUrl() {
        return observedUrl;
      },
      /** Whether a sign-in of this attempt is verified. */
      get signedIn() {
        return signedIn();
      },
      executions: () => executions,
      /** The settled history with each step's entrypoint, for the live-test count. */
      testHistory: () =>
        executions.map((entry) => {
          const entrypoint = entrypoints.get(entry.executionId);
          return entrypoint === undefined ? entry : { ...entry, entrypoint };
        }),
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
      /** Gives execution reviews the outcome reviewer's tracked writes. */
      bindWrites: (read: () => readonly WriteOutcome[]) => {
        writes = read;
      },
    };
  });
export type RequestContext = Effect.Effect.Success<ReturnType<typeof requestContext>>;
