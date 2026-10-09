import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readJson, readText } from "../../src/browser/index.js";
import { makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { HttpFailure } from "../../src/runtime/site-http.js";
import type {
  HttpExchange,
  HttpTransport,
  SiteHttpRequest,
  SiteHttpResponse,
} from "../../src/runtime/site-http.js";
import { makeSiteHttp } from "../../src/runtime/site-http-host.js";

// `SiteHttp` over a synthetic site, as a host builds it with `makeSiteHttp`.

const html = (status: number, text: string, transport: SiteHttpResponse["transport"]) => ({
  status,
  headers: { "content-type": ["text/html"] },
  body: new TextEncoder().encode(text),
  transport,
  gaps: [],
});
const json = (value: unknown, transport: SiteHttpResponse["transport"]) => ({
  status: 200,
  headers: { "content-type": ["application/json"] },
  body: new TextEncoder().encode(JSON.stringify(value)),
  transport,
  gaps: [],
});

/** The synthetic challenge page this test's host knows. */
const challengePage = "<html><title>Checking your browser</title></html>";
const isChallenge = (response: SiteHttpResponse) =>
  new TextDecoder().decode(response.body).includes("Checking your browser");

/**
 * A site that answers the transport's default path with `direct` and a request that needs the
 * page's environment with `page`, recording each request.
 */
const site = async (options: {
  readonly direct: SiteHttpResponse;
  readonly page?: SiteHttpResponse;
  readonly isChallenge?: (response: SiteHttpResponse) => boolean;
  readonly capture?: (exchange: HttpExchange) => Effect.Effect<void, HttpFailure>;
  readonly deadline?: Deadline;
}) => {
  const sent: SiteHttpRequest[] = [];
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: ["session-cookies", "page-environment", "buffered-response-v1"],
    send: (request) => {
      sent.push(request);
      return Promise.resolve(
        request.requires?.includes("page-environment") === true && options.page !== undefined
          ? options.page
          : options.direct,
      );
    },
  };
  const journal = await Effect.runPromise(makeEffectJournal);
  const http = makeSiteHttp({
    transport,
    context: {
      journal,
      deadline: options.deadline ?? Deadline.after(),
      capture: { start: Effect.void, finish: Effect.void },
      events: { emit: () => Effect.void },
    },
    capture: options.capture ?? (() => Effect.void),
    siteOrigin: "https://shop.example",
    ...(options.isChallenge === undefined ? {} : { isChallenge: options.isChallenge }),
  });
  return { http, sent, dispatched: () => Effect.runPromise(journal.state) };
};

describe("bot challenges the host recognizes", () => {
  it("sends a challenged read once more over the page's fetch and reads that answer", async () => {
    const shop = await site({
      direct: html(403, challengePage, "kernel-curl"),
      page: json({ id: "88" }, "page-fetch"),
      isChallenge,
    });
    const read = await Effect.runPromise(
      readJson(shop.http, { url: "/api/p/88", method: "GET" }, Schema.Struct({ id: Schema.String })),
    );
    expect(read).toEqual({ id: "88" });
    expect(shop.sent.map((request) => request.requires ?? [])).toEqual([[], ["page-environment"]]);
  });

  it("fails a read the page's fetch was challenged on too, saying so", async () => {
    const shop = await site({
      direct: html(200, challengePage, "kernel-curl"),
      page: html(200, challengePage, "page-fetch"),
      isChallenge,
    });
    const failure = await Effect.runPromise(
      Effect.flip(readText(shop.http, { url: "/p/1", method: "GET" })),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure" });
    expect(failure.message).toContain("even over the page's fetch");
  });

  it("never sends a challenged write again", async () => {
    const shop = await site({ direct: html(403, challengePage, "kernel-curl"), isChallenge });
    const failure = await Effect.runPromise(
      Effect.flip(readText(shop.http, { url: "/cart", method: "POST", body: "{}" })),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure" });
    expect(shop.sent).toHaveLength(1);
  });

  it("reads every answer as the site's own when the host has no challenge test", async () => {
    const shop = await site({ direct: html(200, challengePage, "kernel-curl") });
    const read = await Effect.runPromise(readText(shop.http, { url: "/p/1", method: "GET" }));
    expect(read.text).toBe(challengePage);
    expect(shop.sent).toHaveLength(1);
  });
});

describe("requests SiteHttp refuses or bounds", () => {
  const request = (shop: Awaited<ReturnType<typeof site>>, sent: unknown) =>
    Effect.runPromise(Effect.either(shop.http.request(sent as SiteHttpRequest)));

  it("refuses an unsupported capability and an unbounded limit before anything is sent", async () => {
    const shop = await site({ direct: json({}, "kernel-curl") });
    for (const refused of [
      { url: "/a", method: "GET", requires: ["streaming"] },
      { url: "/a", method: "GET", maxResponseBytes: 1_024 },
      { url: "/a", method: "GET", body: "x" },
      { url: "//elsewhere.example/a", method: "GET" },
    ])
      expect(await request(shop, refused)).toMatchObject({
        left: { _tag: "HttpFailure", dispatch: "not_sent" },
      });
    expect(shop.sent).toHaveLength(0);
    expect(await shop.dispatched()).toBe("not_started");
  });

  it("fails a body over the requested limit as sent, with its status and no bytes", async () => {
    const shop = await site({ direct: json({ items: "x".repeat(64) }, "kernel-curl") });
    expect(
      await request(shop, {
        url: "/a",
        method: "GET",
        maxResponseBytes: 16,
        requires: ["buffered-response-v1"],
      }),
    ).toMatchObject({
      left: {
        code: "response_too_large",
        dispatch: "sent",
        response: { status: 200, body: { state: "unavailable", limitBytes: 16 } },
      },
    });
    expect(await shop.dispatched()).toBe("may_have_dispatched");
  });

  it("sends nothing once capture before the request used up the deadline", async () => {
    let now = 0;
    const shop = await site({
      direct: json({}, "kernel-curl"),
      deadline: Deadline.after(20, () => now),
      capture: () =>
        Effect.sync(() => {
          now = 21;
        }),
    });
    expect(await request(shop, { url: "/a", method: "POST" })).toMatchObject({
      left: { code: "deadline_exceeded", dispatch: "not_sent" },
    });
    expect(shop.sent).toHaveLength(0);
  });

  it("fails a capture failure as not sent before the request and sent after the answer", async () => {
    for (const phase of ["request", "response"] as const) {
      const shop = await site({
        direct: json({}, "kernel-curl"),
        capture: (exchange) =>
          exchange.phase === phase
            ? Effect.fail(new HttpFailure({ code: "capture_failed", dispatch: "unknown" }))
            : Effect.void,
      });
      expect(await request(shop, { url: "/a", method: "POST" })).toMatchObject({
        left: { code: "capture_failed", dispatch: phase === "request" ? "not_sent" : "sent" },
      });
      expect(shop.sent).toHaveLength(phase === "request" ? 0 : 1);
    }
  });
});
