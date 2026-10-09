import { Effect, Schema } from "effect";
import type { ExecutionServices } from "./context.js";
import { timeoutDefaults } from "./deadline.js";
import type { Dispatch } from "./errors.js";
import { HttpFailure, maxSiteHttpResponseBytes, SiteHttpRequest } from "./site-http.js";
import type {
  HttpExchange,
  HttpTransport,
  SiteHttpResponse,
  SiteHttpResult,
  SiteHttpService,
} from "./site-http.js";

const responseTooLarge = (status: number, limitBytes: number | undefined): HttpFailure =>
  limitBytes === undefined
    ? new HttpFailure({ code: "invalid_response", dispatch: "unknown" })
    : new HttpFailure({
        code: "response_too_large",
        dispatch: "sent",
        response: {
          status,
          body: { state: "unavailable", reason: "limit_exceeded", limitBytes },
        },
      });

const responseLimit = (request: SiteHttpRequest): number | undefined =>
  request.requires?.includes("buffered-response-v1") === true
    ? (request.maxResponseBytes ?? maxSiteHttpResponseBytes)
    : undefined;

/** A path on the site itself, such as `/api/cart?id=1`; never a scheme-relative `//host`. */
const isSitePath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//");

/**
 * Resolves a site-relative request URL against the site origin. Without an origin, a relative URL
 * stays invalid and fails before dispatch.
 */
const withSiteOrigin = (input: unknown, siteOrigin: string | undefined): unknown => {
  if (siteOrigin === undefined || typeof input !== "object" || input === null || !("url" in input))
    return input;
  const url: unknown = input.url;
  return isSitePath(url) ? { ...input, url: new URL(url, `${siteOrigin}/`).href } : input;
};

/**
 * Builds the job's `SiteHttp` over a host's transport. Each request is validated and checked
 * against the transport's capabilities before anything is sent, bounded by the execution's
 * deadline, captured, announced as `http.request_started` and `http.response_received` events,
 * and marked in the effect journal as possibly dispatched just before it is sent.
 */
export const makeSiteHttp = (options: {
  readonly transport: HttpTransport;
  readonly context: ExecutionServices;
  // Private exchange values must be screened before this callback persists or publishes them.
  readonly capture: (exchange: HttpExchange) => Effect.Effect<void, HttpFailure>;
  /** The site a relative request URL means; absent, only absolute URLs are accepted. */
  readonly siteOrigin?: string;
  /**
   * The host's test for a bot-protection challenge page in place of the site's answer. A result
   * it finds carries `challenge: true`, which `isBotChallenge`, `requestPastChallenge`, `readText`
   * and `readJson` act on. Without it, no answer is a challenge.
   */
  readonly isChallenge?: (response: SiteHttpResponse) => boolean;
}): SiteHttpService => ({
  capabilities: options.transport.capabilities,
  siteOrigin: options.siteOrigin,
  request: (input) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknown(SiteHttpRequest)(
        withSiteOrigin(input, options.siteOrigin),
      ).pipe(
        Effect.mapError(() => new HttpFailure({ code: "invalid_request", dispatch: "not_sent" })),
      );
      if (
        ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined) ||
        Object.entries(request.headers ?? {}).some(
          ([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value),
        )
      )
        return yield* new HttpFailure({ code: "invalid_request", dispatch: "not_sent" });
      if (
        request.requires?.some((capability) => !options.transport.capabilities.includes(capability))
      )
        return yield* new HttpFailure({ code: "unsupported_capability", dispatch: "not_sent" });
      const deadline = options.context.deadline.child(request.timeoutMs ?? timeoutDefaults.http);
      const maxResponseBytes = responseLimit(request);
      const capture = (exchange: HttpExchange, dispatch: Dispatch) =>
        options
          .capture(exchange)
          .pipe(Effect.mapError(() => new HttpFailure({ code: "capture_failed", dispatch })));
      yield* capture({ phase: "request", request }, "not_sent");
      yield* options.context.events
        .emit("http.request_started", {
          transport: options.transport.name,
          method: request.method,
          reason: "configured_compatible_transport",
        })
        .pipe(
          Effect.mapError(() => new HttpFailure({ code: "capture_failed", dispatch: "not_sent" })),
        );
      if (deadline.remainingMs() <= 0)
        return yield* new HttpFailure({ code: "deadline_exceeded", dispatch: "not_sent" });
      yield* options.context.journal.enteringDispatch;
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          options.transport.send(request, {
            signal,
            timeoutMs: Math.max(1, deadline.remainingMs()),
            ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
          }),
        catch: (error) =>
          error instanceof HttpFailure
            ? error
            : new HttpFailure({ code: "transport_failed", dispatch: "unknown" }),
      }).pipe(
        Effect.filterOrFail(
          (value) => maxResponseBytes === undefined || value.body.byteLength <= maxResponseBytes,
          (value) => responseTooLarge(value.status, maxResponseBytes),
        ),
        Effect.timeoutFail({
          duration: deadline.remainingMs(),
          onTimeout: () => new HttpFailure({ code: "deadline_exceeded", dispatch: "unknown" }),
        }),
        Effect.tapError((failure) =>
          capture({ phase: "failure", request, failure }, failure.dispatch),
        ),
      );
      yield* capture({ phase: "response", request, response }, "sent");
      yield* options.context.events
        .emit("http.response_received", {
          transport: response.transport,
          status: response.status,
          bytes: response.body.byteLength,
        })
        .pipe(Effect.mapError(() => new HttpFailure({ code: "capture_failed", dispatch: "sent" })));
      const result: SiteHttpResult = { ...response, requestUrl: request.url };
      return options.isChallenge?.(response) === true ? { ...result, challenge: true } : result;
    }),
});
