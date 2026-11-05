import { describe, expect, it } from "vitest";
import {
  createRuntimeTelemetry,
  parseTraceparent,
  readResources,
  screenAttributes,
  type TelemetryEvent,
} from "../../src/runtime/telemetry.js";

// The runtime records spans under the trace context its host passes in and hands them to the
// host's writer. It never sends anything itself, and it records nothing without both.

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;

/** Span IDs from a counter, so each test knows the IDs it gets. */
const counterBytes = () => {
  let next = 0;
  return (size: number) => {
    next += 1;
    const bytes = new Uint8Array(size);
    bytes[size - 1] = next;
    return bytes;
  };
};

const recorder = (options: { readonly traceparent?: string; readonly env?: NodeJS.ProcessEnv }) => {
  const events: TelemetryEvent[] = [];
  let clock = 1_000;
  const telemetry = createRuntimeTelemetry({
    env: {},
    ...options,
    writer: (event) => events.push(event),
    now: () => (clock += 5),
    randomBytes: counterBytes(),
    resources: {
      resourceUsage: () => ({ userCPUTime: 10, systemCPUTime: 2, maxRSS: 2048 }),
      memoryUsage: () => ({ rss: 4096, heapUsed: 1024, heapTotal: 2048, external: 64 }),
      readCgroupFile: () => undefined,
    },
  });
  return { telemetry, events };
};

describe("parseTraceparent", () => {
  it("reads a version 00 trace context", () => {
    expect(parseTraceparent(traceparent)).toEqual({
      traceId,
      spanId: parentId,
      traceFlags: "01",
    });
    expect(parseTraceparent(`  ${traceparent.replace(/01$/u, "00")}\n`)).toEqual({
      traceId,
      spanId: parentId,
      traceFlags: "00",
    });
  });

  it("refuses a malformed or invalid trace context", () => {
    for (const value of [
      undefined,
      "",
      `ff-${traceId}-${parentId}-01`,
      `00-${"0".repeat(32)}-${parentId}-01`,
      `00-${traceId}-${"0".repeat(16)}-01`,
      `00-${traceId.slice(1)}-${parentId}-01`,
      `00-${traceId}-${parentId}0-01`,
      `00-${traceId}-${parentId}-1`,
      `00-${traceId.toUpperCase()}-${parentId}-01`,
      `00-${traceId}-${parentId}-01-extra`,
      `0-${traceId}-${parentId}-01`,
      `00_${traceId}_${parentId}_01`,
    ])
      expect(parseTraceparent(value), String(value)).toBeUndefined();
  });

  it("reads the known fields of a later version and ignores what follows them", () => {
    expect(parseTraceparent(`01-${traceId}-${parentId}-01-future`)).toEqual({
      traceId,
      spanId: parentId,
      traceFlags: "01",
    });
    expect(parseTraceparent(`01-${traceId}-${parentId}-01future`)).toBeUndefined();
  });
});

describe("createRuntimeTelemetry", () => {
  it("records child spans under the trace context it was given", async () => {
    const { telemetry, events } = recorder({ traceparent });
    expect(telemetry.enabled).toBe(true);

    const outer = telemetry.startSpan("operation.run", { attributes: { attempt: 1 } });
    expect(outer.traceparent).toBe(`00-${traceId}-0000000000000001-01`);
    const inner = telemetry.startSpan("browser.call", { parent: outer });
    inner.end();
    outer.end({ status: "error", attributes: { "error.kind": "timeout" } });
    outer.end();

    expect(events).toEqual([
      {
        type: "span",
        traceId,
        spanId: "0000000000000002",
        parentSpanId: "0000000000000001",
        traceFlags: "01",
        name: "browser.call",
        startTimeMs: 1_010,
        endTimeMs: 1_015,
        status: "unset",
        attributes: {},
      },
      {
        type: "span",
        traceId,
        spanId: "0000000000000001",
        parentSpanId: parentId,
        traceFlags: "01",
        name: "operation.run",
        startTimeMs: 1_005,
        endTimeMs: 1_020,
        status: "error",
        attributes: { attempt: 1, "error.kind": "timeout" },
      },
    ]);
  });

  it("reads the trace context from the environment when none is passed", () => {
    const { telemetry, events } = recorder({ env: { TRACEPARENT: traceparent } });
    telemetry.startSpan("step").end({ status: "ok" });
    expect(events).toMatchObject([{ traceId, parentSpanId: parentId, status: "ok" }]);
  });

  it("ends a wrapped span with the outcome of its work", async () => {
    const { telemetry, events } = recorder({ traceparent });
    await expect(telemetry.span("ok.step", async () => 3)).resolves.toBe(3);
    await expect(
      telemetry.span("failed.step", () => Promise.reject(new Error("no"))),
    ).rejects.toThrow("no");
    expect(events.map((event) => event.type === "span" && [event.name, event.status])).toEqual([
      ["ok.step", "ok"],
      ["failed.step", "error"],
    ]);
  });

  it("draws span IDs again until they are not all zero", () => {
    const draws = [new Uint8Array(8), new Uint8Array(8), Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 9])];
    const events: TelemetryEvent[] = [];
    const telemetry = createRuntimeTelemetry({
      traceparent,
      env: {},
      writer: (event) => events.push(event),
      randomBytes: () => draws.shift() ?? new Uint8Array(8),
    });
    expect(telemetry.startSpan("step").spanId).toBe("0000000000000009");
  });

  it("records nothing without a trace context or a writer", async () => {
    for (const telemetry of [
      createRuntimeTelemetry({ env: {}, writer: () => expect.unreachable() }),
      createRuntimeTelemetry({ env: {}, traceparent: "garbage", writer: () => expect.unreachable() }),
      createRuntimeTelemetry({ env: { TRACEPARENT: traceparent } }),
    ]) {
      expect(telemetry.enabled).toBe(false);
      const span = telemetry.startSpan("step");
      expect(span.spanId).toBeUndefined();
      expect(span.traceparent).toBeUndefined();
      span.end();
      await expect(telemetry.span("step", () => "done")).resolves.toBe("done");
      telemetry.recordResources();
    }
  });

  it("keeps running when the writer throws", () => {
    const telemetry = createRuntimeTelemetry({
      traceparent,
      env: {},
      writer: () => {
        throw new Error("closed");
      },
    });
    expect(() => telemetry.startSpan("step").end()).not.toThrow();
    expect(() => telemetry.recordResources()).not.toThrow();
  });

  it("records resource use under a span", () => {
    const { telemetry, events } = recorder({ traceparent });
    const span = telemetry.startSpan("step");
    telemetry.recordResources({ parent: span, attributes: { phase: "after" } });
    expect(events).toEqual([
      {
        type: "resource",
        traceId,
        parentSpanId: "0000000000000001",
        traceFlags: "01",
        timeMs: 1_010,
        attributes: { phase: "after" },
        process: {
          userCpuMicros: 10,
          systemCpuMicros: 2,
          maxRssBytes: 2048 * 1024,
          rssBytes: 4096,
          heapUsedBytes: 1024,
          heapTotalBytes: 2048,
          externalBytes: 64,
        },
      },
    ]);
  });
});

describe("screenAttributes", () => {
  it("keeps booleans, finite numbers and short tokens, and drops everything else", () => {
    expect(
      screenAttributes({
        ok: true,
        count: 3,
        ratio: 0.5,
        kind: "read_only",
        version: "1.2.3-beta",
        infinite: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
        url: "https://example.com/path?q=1",
        email: "someone@example.com",
        text: "Your order has shipped",
        empty: "",
        long: "a".repeat(65),
        object: { nested: true } as never,
        list: [1, 2] as never,
        nothing: null as never,
        "bad key": 1,
        "": 1,
        ["k".repeat(65)]: 1,
      }),
    ).toEqual({ ok: true, count: 3, ratio: 0.5, kind: "read_only", version: "1.2.3-beta" });
  });

  it("keeps at most 32 attributes, on a span as in one call", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`a${index}`, index]));
    expect(Object.keys(screenAttributes(many))).toHaveLength(32);

    const { telemetry, events } = recorder({ traceparent });
    const span = telemetry.startSpan("step", { attributes: { a0: 0 } });
    span.setAttributes(many);
    span.end({ attributes: { a0: "replaced", late: true } });
    expect(events).toMatchObject([{ attributes: { a0: "replaced" } }]);
    const [event] = events;
    expect(event?.type === "span" && Object.keys(event.attributes)).toHaveLength(32);
    expect(event?.attributes).not.toHaveProperty("late");
  });

  it("records a name that looks like an object key as a plain attribute", () => {
    const screened = screenAttributes(JSON.parse('{"__proto__": "x", "kind": "read"}'));
    expect(Object.getPrototypeOf(screened)).toBe(Object.prototype);
    expect(Object.keys(screened)).toEqual(["__proto__", "kind"]);
  });

  it("names a span whose name is not a short token as unnamed", () => {
    const { telemetry, events } = recorder({ traceparent });
    telemetry.startSpan("open https://example.com/").end();
    expect(events).toMatchObject([{ name: "unnamed" }]);
  });
});

describe("readResources", () => {
  it("reads process figures and the cgroup v2 files that are present", () => {
    const files: Record<string, string> = {
      "cpu.stat": "usage_usec 5000\nuser_usec 4000\nsystem_usec 1000\nnr_periods 0\n",
      "memory.current": "1048576\n",
      "memory.peak": "2097152\n",
      "memory.max": "max\n",
      "io.stat": "8:0 rbytes=100 wbytes=200 rios=1 wios=2\n8:16 rbytes=1 wbytes=2 rios=0 wios=0\n",
    };
    expect(
      readResources({
        resourceUsage: () => ({ userCPUTime: 1, systemCPUTime: 2, maxRSS: 3 }),
        memoryUsage: () => ({ rss: 4, heapUsed: 5, heapTotal: 6, external: 7 }),
        readCgroupFile: (name) => files[name],
      }),
    ).toEqual({
      process: {
        userCpuMicros: 1,
        systemCpuMicros: 2,
        maxRssBytes: 3 * 1024,
        rssBytes: 4,
        heapUsedBytes: 5,
        heapTotalBytes: 6,
        externalBytes: 7,
      },
      cgroup: {
        cpuUsageMicros: 5000,
        cpuUserMicros: 4000,
        cpuSystemMicros: 1000,
        memoryCurrentBytes: 1048576,
        memoryPeakBytes: 2097152,
        ioReadBytes: 101,
        ioWriteBytes: 202,
      },
    });
  });

  it("leaves out the cgroup figures when no file is readable or a file is malformed", () => {
    const process = { resourceUsage: () => ({ userCPUTime: 1, systemCPUTime: 2, maxRSS: 3 }) };
    expect(readResources({ ...process, readCgroupFile: () => undefined }).cgroup).toBeUndefined();
    expect(
      readResources({
        ...process,
        readCgroupFile: (name) => (name === "memory.current" ? "lots" : undefined),
      }).cgroup,
    ).toBeUndefined();
    expect(
      readResources({
        ...process,
        readCgroupFile: (name) => (name === "memory.max" ? "1073741824" : undefined),
      }).cgroup,
    ).toEqual({ memoryMaxBytes: 1073741824 });
  });
});
