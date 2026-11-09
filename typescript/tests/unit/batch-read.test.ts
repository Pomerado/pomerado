import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchFetchCode, batchRead } from "../../src/browser/index.js";
import type { BatchClock, SiteHttpRequest, SiteHttpResult, SiteHttpService } from "../../src/browser/index.js";
import { batchRateLimitResetMs, classifyBatchAnswer } from "../../src/runtime/batch-read.js";
import { OperationFailure } from "../../src/runtime/operation-failure.js";

// The batch-read helpers against a scripted site: each request's answers in order, a controlled
// clock, and a count of requests in flight.

interface Scripted {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly challenge?: true;
}

const json = (body: unknown, status = 200): Scripted => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const fakeClock = () => {
  let now = 0;
  const waits: number[] = [];
  const clock: BatchClock = {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
  return { clock, waits };
};

/**
 * A site whose answers to each URL come from `script`, in order, the last one repeating. `script`
 * also gets the request's number among all the site received, from 1.
 */
const scriptedSite = (script: (url: string, number: number) => readonly Scripted[]) => {
  const sent: string[] = [];
  const tries = new Map<string, number>();
  let inFlight = 0;
  let mostInFlight = 0;
  const pending: (() => void)[] = [];
  const answerFor = (url: string) => {
    const attempt = tries.get(url) ?? 0;
    tries.set(url, attempt + 1);
    const answers = script(url, sent.length);
    return answers[Math.min(attempt, answers.length - 1)] ?? json(null);
  };
  /** Answers once every request in flight has arrived, so each batch is counted whole. */
  const respond = async (url: string) => {
    sent.push(url);
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const scripted = answerFor(url);
    await new Promise<void>((resolve) => {
      pending.push(resolve);
      setTimeout(() => {
        const ready = pending.splice(0);
        // Later requests in the batch answer first, so order comes only from the helper.
        for (const release of ready.reverse()) release();
      }, 0);
    });
    inFlight -= 1;
    return scripted;
  };
  const http: SiteHttpService = {
    capabilities: [],
    siteOrigin: "https://shop.example",
    request: (request: SiteHttpRequest) =>
      Effect.promise(async (): Promise<SiteHttpResult> => {
        const scripted = await respond(request.url);
        return {
          status: scripted.status,
          headers: Object.fromEntries(
            Object.entries(scripted.headers ?? {}).map(([name, value]) => [name, [value]]),
          ),
          body: new TextEncoder().encode(scripted.body ?? ""),
          transport: "kernel-curl",
          gaps: [],
          requestUrl: request.url,
          ...(scripted.challenge ? { challenge: true as const } : {}),
        };
      }),
  };
  const fetch = async (url: string) => {
    const scripted = await respond(url);
    return new Response(scripted.body ?? "", {
      status: scripted.status,
      headers: scripted.headers ?? {},
    });
  };
  return { http, fetch, sent, mostInFlight: () => mostInFlight };
};

const itemUrl = (index: number) => `https://shop.example/api/items/${index}`;
const reads = (count: number): SiteHttpRequest[] =>
  Array.from({ length: count }, (_, index) => ({
    url: itemUrl(index),
    method: "GET",
    headers: { accept: "application/json" },
  }));
const idOf = (url: string) => Number(url.split("/").pop());
const bodies = (items: readonly { ok: boolean; response?: SiteHttpResult }[]) =>
  items.map((item) =>
    item.response === undefined ? null : JSON.parse(new TextDecoder().decode(item.response.body)),
  );

/** An answer with the site's rate-limit headers added. */
const limited = (answer: Scripted, headers: Record<string, string>): Scripted => ({
  ...answer,
  headers: { ...answer.headers, ...headers },
});

/** A site's overloaded answer, the non-standard 529, to a request for JSON. */
const overloaded: Scripted = {
  status: 529,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: "overloaded" }),
};

describe("classifyBatchAnswer", () => {
  it("throttles a 529 and every other 5xx", () => {
    expect(classifyBatchAnswer(529, "application/json", false, true)).toBe("throttled");
    for (const status of [500, 502, 504, 520, 599])
      expect(classifyBatchAnswer(status, "application/json", false, true)).toBe("throttled");
  });

  it("keeps a 429, a 503, the blocked cases and other answers as they were", () => {
    expect(classifyBatchAnswer(429, "", false, true)).toBe("throttled");
    expect(classifyBatchAnswer(503, "application/json", false, true)).toBe("throttled");
    expect(classifyBatchAnswer(503, "text/html", false, true)).toBe("blocked");
    expect(classifyBatchAnswer(403, "text/html", false, true)).toBe("blocked");
    expect(classifyBatchAnswer(200, "text/html", false, true)).toBe("blocked");
    expect(classifyBatchAnswer(200, "application/json", true, true)).toBe("blocked");
    expect(classifyBatchAnswer(403, "application/json", false, true)).toBe("answered");
    expect(classifyBatchAnswer(404, "application/json", false, true)).toBe("answered");
  });
});

describe("batchRateLimitResetMs", () => {
  it("gives the reset once the site's rate-limit headers say no request remains", () => {
    expect(batchRateLimitResetMs("0", "2", null)).toBe(2000);
    expect(batchRateLimitResetMs(null, null, '"default";r=0;t=30')).toBe(30_000);
    expect(batchRateLimitResetMs(null, null, '"burst";r=0;t=5, "daily";r=900;t=3600')).toBe(5000);
    expect(batchRateLimitResetMs(null, null, "limit=100, remaining=0, reset=7")).toBe(7000);
    expect(batchRateLimitResetMs("0", null, '"default";r=0;t=9')).toBe(9000);
    expect(batchRateLimitResetMs("0", null, '"default";t=9')).toBe(9000);
  });

  it("gives null when none remain and no reset is given, and nothing while requests remain", () => {
    expect(batchRateLimitResetMs("0", null, null)).toBeNull();
    expect(batchRateLimitResetMs("3", "2", null)).toBeUndefined();
    expect(batchRateLimitResetMs(null, null, '"default";r=12;t=30')).toBeUndefined();
    expect(batchRateLimitResetMs(null, null, null)).toBeUndefined();
  });
});

describe("batchRead", () => {
  it("raises the batch size after clean batches, up to 16", async () => {
    const site = scriptedSite((url) => [json({ id: idOf(url) })]);
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(70), { clock }));
    expect(result.batches).toEqual([4, 6, 9, 14, 16, 16, 5]);
    expect(site.mostInFlight()).toBe(16);
    expect(waits).toEqual([]);
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  it("halves the batch size on a 429 and waits its Retry-After before sending it again", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(2)
        ? [{ status: 429, headers: { "retry-after": "3" } }, json({ id: 2 })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(12), { clock }));
    expect(waits).toEqual([3000]);
    // 4 sent, one throttled: 2 next (the throttled one first), then growing by one at a time.
    expect(result.batches).toEqual([4, 2, 3, 4]);
    expect(site.sent.slice(4, 6)).toEqual([itemUrl(2), itemUrl(4)]);
    expect(bodies(result.items)).toEqual(Array.from({ length: 12 }, (_, id) => ({ id })));
  });

  it("honours a Retry-After given in fractional seconds", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(1)
        ? [{ status: 429, headers: { "retry-after": "1.5" } }, json({ id: 1 })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(4), { clock }));
    expect(waits).toEqual([1500]);
    expect(bodies(result.items)).toEqual([0, 1, 2, 3].map((id) => ({ id })));
  });

  it("never grows after a throttled batch, and stops when the next batch is throttled too", async () => {
    const site = scriptedSite((url, number) => (number <= 4 ? [json({ id: idOf(url) })] : [overloaded]));
    const { clock, waits } = fakeClock();
    const outcome = await Effect.runPromise(
      Effect.either(batchRead(site.http, reads(20), { clock })),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left.message).toContain(
        "The site throttled two batches in a row at request 4, after 4 of 20 answered; nothing more was sent.",
      );
      expect(outcome.left.http?.status).toBe(529);
    }
    // 4 answered, then 6 throttled: one backoff and half the size, then 3 throttled again.
    expect(waits).toEqual([1000]);
    expect(site.sent).toHaveLength(13);
  });

  it("backs off after a 5xx whose RateLimit-Reset is 0", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(2)
        ? [limited(json({}, 500), { "ratelimit-remaining": "0", "ratelimit-reset": "0" }), json({ id: 2 })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(4), { clock }));
    expect(waits).toEqual([1000]);
    expect(bodies(result.items)).toEqual([0, 1, 2, 3].map((id) => ({ id })));
  });

  it("waits the site's RateLimit-Reset once none remain, and does not grow the next batch", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(3)
        ? [limited(json({ id: 3 }), { "ratelimit-remaining": "0", "ratelimit-reset": "2" })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(12), { clock }));
    expect(waits).toEqual([2000]);
    expect(result.batches).toEqual([4, 2, 3, 3]);
    expect(bodies(result.items)).toEqual(Array.from({ length: 12 }, (_, id) => ({ id })));
  });

  it("stops as rate_limited when the site's RateLimit reset is longer than maxWaitMs", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(1)
        ? [limited(json({ id: 1 }), { ratelimit: '"default";r=0;t=60' })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const outcome = await Effect.runPromise(
      Effect.either(batchRead(site.http, reads(12), { clock })),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome))
      expect(outcome.left.message).toContain(
        "The site rate-limited the batch for 60 s at request 1",
      );
    expect(waits).toEqual([]);
    expect(site.sent).toHaveLength(4);
  });

  it("finishes without waiting when the last batch says none remain", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(3)
        ? [limited(json({ id: 3 }), { "ratelimit-remaining": "0", "ratelimit-reset": "60" })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(4), { clock }));
    expect(waits).toEqual([]);
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  it("stops at a challenge and sends nothing more", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(5) ? [{ status: 200, challenge: true, body: "<html>" }] : [json({ id: idOf(url) })],
    );
    const { clock } = fakeClock();
    const outcome = await Effect.runPromise(
      Effect.either(batchRead(site.http, reads(30), { clock })),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(OperationFailure);
      expect(outcome.left.dispatch).toBe("sent");
      expect(outcome.left.http?.status).toBe(200);
    }
    // The first batch of 4, then the batch of 6 holding the challenge; item 5 was sent once.
    expect(site.sent.length).toBe(10);
    expect(site.sent.filter((url) => url === itemUrl(5))).toHaveLength(1);
  });

  it("returns every request's result in input order, however they answer", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(3) ? [json({ missing: true }, 404)] : [json({ id: idOf(url) })],
    );
    const { clock } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(9), { clock }));
    expect(result.items.map((item) => item.ok && item.response.status)).toEqual([
      200, 200, 200, 404, 200, 200, 200, 200, 200,
    ]);
    expect(bodies(result.items)).toEqual([
      ...[0, 1, 2].map((id) => ({ id })),
      { missing: true },
      ...[4, 5, 6, 7, 8].map((id) => ({ id })),
    ]);
  });

  it("refuses a batch holding a write, sending nothing", async () => {
    const site = scriptedSite(() => [json({})]);
    for (const write of [
      { url: itemUrl(1), method: "PUT" as const },
      { url: itemUrl(1), method: "POST" as const, body: "{}", write: true },
      // A method outside GET, HEAD, OPTIONS and POST is a write too, however it is spelled.
      { url: itemUrl(1), method: "MKCOL" as unknown as "GET" },
    ]) {
      const outcome = await Effect.runPromise(
        Effect.either(batchRead(site.http, [...reads(2), write])),
      );
      expect(Either.isLeft(outcome) && outcome.left.dispatch).toBe("not_sent");
    }
    expect(site.sent).toEqual([]);
  });
});

/** Runs `batchFetchCode` as a Kernel call body would, with a page whose evaluate runs here. */
const runBatchFetch = async (requests: readonly unknown[], options: unknown = {}) => {
  const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) };
  const body = new Function(
    "page",
    "requests",
    "options",
    `return (async () => {${batchFetchCode}\nreturn await batchFetch(requests, options);})();`,
  ) as (page: unknown, requests: unknown, options: unknown) => Promise<{
    results: { ok: boolean; status?: number; data?: unknown; error?: string }[];
    stopped: { reason: string; index: number } | null;
    batches: number[];
  }>;
  return body(page, requests, options);
};

describe("batchFetch in the page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns results in input order and stops at a block, marking the rest not sent", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(6)
        ? [{ status: 403, headers: { "content-type": "text/html" }, body: "<html>Access denied" }]
        : [json({ id: idOf(url) })],
    );
    vi.stubGlobal("fetch", site.fetch);
    const answer = await runBatchFetch(Array.from({ length: 20 }, (_, index) => ({ url: itemUrl(index) })));
    expect(answer.stopped).toEqual({ reason: "blocked", index: 6 });
    expect(answer.batches).toEqual([4, 6]);
    expect(answer.results.map((result) => result.data ?? result.error)).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((id) => ({ id })),
      "blocked",
      ...[7, 8, 9].map((id) => ({ id })),
      ...Array.from({ length: 10 }, () => "not_sent"),
    ]);
  });

  it("stops as rate_limited within two throttled batches when the site turns to 529 after a burst", async () => {
    // The site answers its first 60 requests, then answers 529 to every one after.
    const site = scriptedSite((url, number) => (number <= 60 ? [json({ id: idOf(url) })] : [overloaded]));
    vi.stubGlobal("fetch", site.fetch);
    const answer = await runBatchFetch(
      Array.from({ length: 200 }, (_, index) => ({ url: itemUrl(index) })),
      { backoffMs: 1 },
    );
    expect(answer.stopped).toEqual({ reason: "rate_limited", index: 60 });
    // Grows to 16 while the site answers, halves after the batch where the 529s begin, then stops
    // after two batches in a row the site throttled whole: 77 of 200 sent.
    expect(answer.batches).toEqual([4, 6, 9, 14, 16, 16, 8, 4]);
    expect(site.sent).toHaveLength(77);
    expect(answer.results.map((result) => (result.ok ? "ok" : result.error))).toEqual([
      ...Array.from({ length: 60 }, () => "ok"),
      ...Array.from({ length: 8 }, () => "throttled"),
      ...Array.from({ length: 132 }, () => "not_sent"),
    ]);
  });

  it("stops as rate_limited within 6 sends when the site answers 529 from the first request", async () => {
    const site = scriptedSite(() => [overloaded]);
    vi.stubGlobal("fetch", site.fetch);
    const answer = await runBatchFetch(
      Array.from({ length: 100 }, (_, index) => ({ url: itemUrl(index) })),
      { backoffMs: 1 },
    );
    // The site gave no wait, so the stop carries none.
    expect(answer.stopped).toEqual({ reason: "rate_limited", index: 0 });
    expect(answer.batches).toEqual([4, 2]);
    expect(site.sent).toHaveLength(6);
    expect(answer.results.map((result) => result.error)).toEqual([
      ...Array.from({ length: 4 }, () => "throttled"),
      ...Array.from({ length: 96 }, () => "not_sent"),
    ]);
  });

  it.each([0, 4, 10, 19, 20, 33, 49])(
    "stops as rate_limited soon after the site turns to 529 after %i requests",
    async (answered) => {
      const site = scriptedSite((url, number) =>
        number <= answered ? [json({ id: idOf(url) })] : [overloaded],
      );
      vi.stubGlobal("fetch", site.fetch);
      const answer = await runBatchFetch(
        Array.from({ length: 200 }, (_, index) => ({ url: itemUrl(index) })),
        { backoffMs: 1 },
      );
      expect(answer.stopped?.reason).toBe("rate_limited");
      // The rest of the batch in flight, then at most two halved batches: 6 to 24 sends here.
      expect(site.sent.length - answered).toBeLessThanOrEqual(24);
      expect(answer.results.filter((result) => result.ok)).toHaveLength(answered);
    },
  );

  it("retries one record that always answers 500 up to maxAttempts, and reads every other one", async () => {
    const broken = { status: 500, headers: { "content-type": "application/json" }, body: "{}" };
    const site = scriptedSite((url) => (url === itemUrl(5) ? [broken] : [json({ id: idOf(url) })]));
    vi.stubGlobal("fetch", site.fetch);
    const answer = await runBatchFetch(
      Array.from({ length: 30 }, (_, index) => ({ url: itemUrl(index) })),
      { backoffMs: 1 },
    );
    expect(answer.stopped).toBeNull();
    expect(site.sent.filter((url) => url === itemUrl(5))).toHaveLength(3);
    expect(answer.results.map((result) => result.data ?? result.error)).toEqual(
      Array.from({ length: 30 }, (_, id) => (id === 5 ? "throttled" : { id })),
    );
  });

  it("refuses a write, or any method but GET, HEAD, OPTIONS and POST, before anything is sent", async () => {
    const site = scriptedSite(() => [json({})]);
    vi.stubGlobal("fetch", site.fetch);
    for (const method of ["DELETE", "PURGE", "mkcol"])
      await expect(
        runBatchFetch([{ url: itemUrl(0) }, { url: itemUrl(1), method }]),
      ).rejects.toMatchObject({ name: "BatchFetchRefused" });
    expect(site.sent).toEqual([]);
  });
});
