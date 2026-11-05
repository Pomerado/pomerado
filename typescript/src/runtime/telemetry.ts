import { readFileSync } from "node:fs";

/**
 * Spans and resource use recorded in the runtime, for the host to export.
 *
 * The host passes the runtime a W3C trace context (`TRACEPARENT` in its environment, or the
 * `traceparent` option) and a writer. The runtime records each span as a child of that context and
 * hands every span and resource reading to the writer as a plain JSON-safe object; the host decides
 * where they go. This module opens no connection, loads no telemetry SDK and has no dependency.
 * Without a valid trace context or a writer it records nothing.
 *
 * Attribute values are limited to booleans, finite numbers and short tokens, and span names to
 * short tokens, so page text, URLs and email addresses can't be recorded by accident. A host that
 * exports spans still screens them as it would any record.
 *
 * Trace context: https://www.w3.org/TR/trace-context/
 */

/** A parsed W3C trace context: the trace, the parent span and its flags, as lowercase hex. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
}

const hexField = /^[0-9a-f]+$/u;
const allZero = /^0+$/u;

/**
 * The trace context a `traceparent` value carries, or `undefined` when it is missing or invalid:
 * version `ff`, an all-zero trace or parent ID, a wrong field length or uppercase hex. A later
 * version's first four fields are read and anything after a following `-` is ignored, as the
 * specification asks.
 */
export const parseTraceparent = (value: string | undefined): TraceContext | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim();
  const [version, traceId, spanId, traceFlags] = text.split("-", 4);
  if (version === undefined || traceId === undefined || spanId === undefined) return undefined;
  if (traceFlags === undefined) return undefined;
  if (version.length !== 2 || !hexField.test(version) || version === "ff") return undefined;
  if (traceId.length !== 32 || !hexField.test(traceId) || allZero.test(traceId)) return undefined;
  if (spanId.length !== 16 || !hexField.test(spanId) || allZero.test(spanId)) return undefined;
  if (traceFlags.length !== 2 || !hexField.test(traceFlags)) return undefined;
  const known = 55;
  if (version === "00" ? text.length !== known : text.length > known && text[known] !== "-")
    return undefined;
  return { traceId, spanId, traceFlags };
};

/** The `traceparent` value for a trace context, version 00. */
export const formatTraceparent = (context: TraceContext) =>
  `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;

/** An attribute value the runtime records. */
export type AttributeValue = boolean | number | string;

/** Attributes by name. Names and string values are short tokens. */
export type Attributes = Readonly<Record<string, AttributeValue>>;

/** Letters, digits, `_`, `.` and `-`, from 1 to 64 characters. */
const token = /^[A-Za-z0-9_.-]{1,64}$/u;

/** At most this many attributes are kept on one span or reading. */
export const maxAttributes = 32;

/**
 * The attributes the runtime may record: a token name with a boolean, a finite number or a token
 * string, the first 32 such. Everything else is dropped without a trace.
 */
export const screenAttributes = (
  attributes: Readonly<Record<string, unknown>> | undefined,
): Attributes => {
  const kept = new Map<string, AttributeValue>();
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (kept.size >= maxAttributes) break;
    if (!token.test(name)) continue;
    if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && token.test(value))
    )
      kept.set(name, value);
  }
  return Object.fromEntries(kept);
};

/** How a span ended. */
export type SpanStatus = "unset" | "ok" | "error";

/** One finished span. Times are Unix epoch milliseconds, possibly fractional. */
export interface SpanEvent {
  readonly type: "span";
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly traceFlags: string;
  readonly name: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly status: SpanStatus;
  readonly attributes: Attributes;
}

/** The process's own figures, from Node. */
export interface ProcessResources {
  readonly userCpuMicros: number;
  readonly systemCpuMicros: number;
  readonly maxRssBytes: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
}

/** The process's cgroup v2 figures, each present only when its file was readable. */
export interface CgroupResources {
  readonly cpuUsageMicros?: number;
  readonly cpuUserMicros?: number;
  readonly cpuSystemMicros?: number;
  readonly memoryCurrentBytes?: number;
  readonly memoryPeakBytes?: number;
  /** Absent when the cgroup has no memory limit. */
  readonly memoryMaxBytes?: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
}

/** One reading of resource use. */
export interface ResourceSnapshot {
  readonly process: ProcessResources;
  /** Absent when no cgroup v2 file was readable, as outside a container. */
  readonly cgroup?: CgroupResources;
}

/** One resource reading, recorded under a span. */
export interface ResourceEvent extends ResourceSnapshot {
  readonly type: "resource";
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceFlags: string;
  readonly timeMs: number;
  readonly attributes: Attributes;
}

/** What the runtime hands its host's writer. */
export type TelemetryEvent = SpanEvent | ResourceEvent;

/**
 * Where events go, set by the host, such as a line on a channel it reads. It is called
 * synchronously, and an error it throws is dropped so recording never fails a run.
 */
export type TelemetryWriter = (event: TelemetryEvent) => void;

/** How resource use is read. Each reader defaults to the running process's own. */
export interface ResourceReaders {
  /** As `process.resourceUsage()`: CPU times in microseconds, `maxRSS` in kilobytes. */
  readonly resourceUsage?: () => {
    readonly userCPUTime: number;
    readonly systemCPUTime: number;
    readonly maxRSS: number;
  };
  /** As `process.memoryUsage()`, in bytes. */
  readonly memoryUsage?: () => {
    readonly rss: number;
    readonly heapUsed: number;
    readonly heapTotal: number;
    readonly external: number;
  };
  /**
   * The text of one file in the process's cgroup v2 folder, such as `memory.current`, or
   * `undefined` when it can't be read. Only the files this module names are asked for.
   */
  readonly readCgroupFile?: (name: string) => string | undefined;
}

/** The process's cgroup v2 folder, from `/proc/self/cgroup`, or `undefined` without one. */
const cgroupFolder = () => {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    if (line === undefined) return undefined;
    const path = line.slice(3).trim();
    if (!path.startsWith("/") || path.split("/").includes("..")) return undefined;
    return `/sys/fs/cgroup${path === "/" ? "" : path}`;
  } catch {
    return undefined;
  }
};

const cgroupFiles = new Set(["cpu.stat", "memory.current", "memory.peak", "memory.max", "io.stat"]);

let folder: string | null | undefined;

const readOwnCgroupFile = (name: string) => {
  if (!cgroupFiles.has(name)) return undefined;
  if (folder === undefined) folder = cgroupFolder() ?? null;
  if (folder === null) return undefined;
  try {
    return readFileSync(`${folder}/${name}`, "utf8");
  } catch {
    return undefined;
  }
};

const wholeNumber = (text: string | undefined) => {
  const trimmed = text?.trim();
  return trimmed !== undefined && /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
};

/** `key value` lines, as in `cpu.stat`. */
const flatKeyed = (text: string | undefined) => {
  const values = new Map<string, number>();
  for (const line of text?.split("\n") ?? []) {
    const [key, value, extra] = line.trim().split(/\s+/u);
    const parsed = wholeNumber(value);
    if (key !== undefined && parsed !== undefined && extra === undefined) values.set(key, parsed);
  }
  return values;
};

/** `rbytes` and `wbytes` summed across the devices `io.stat` lists. */
const ioBytes = (text: string | undefined) => {
  if (text === undefined) return {};
  let read: number | undefined;
  let written: number | undefined;
  for (const line of text.split("\n"))
    for (const field of line.trim().split(/\s+/u).slice(1)) {
      const [key, value] = field.split("=", 2);
      const parsed = wholeNumber(value);
      if (parsed === undefined) continue;
      if (key === "rbytes") read = (read ?? 0) + parsed;
      if (key === "wbytes") written = (written ?? 0) + parsed;
    }
  return {
    ...(read === undefined ? {} : { ioReadBytes: read }),
    ...(written === undefined ? {} : { ioWriteBytes: written }),
  };
};

const readCgroup = (read: (name: string) => string | undefined): CgroupResources | undefined => {
  const cpu = flatKeyed(read("cpu.stat"));
  const figures: Record<string, number | undefined> = {
    cpuUsageMicros: cpu.get("usage_usec"),
    cpuUserMicros: cpu.get("user_usec"),
    cpuSystemMicros: cpu.get("system_usec"),
    memoryCurrentBytes: wholeNumber(read("memory.current")),
    memoryPeakBytes: wholeNumber(read("memory.peak")),
    memoryMaxBytes: wholeNumber(read("memory.max")),
    ...ioBytes(read("io.stat")),
  };
  const present = Object.entries(figures).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  return present.length === 0 ? undefined : (Object.fromEntries(present) as CgroupResources);
};

/** Reads the process's resource use now, and its cgroup v2 figures where they are present. */
export const readResources = (readers: ResourceReaders = {}): ResourceSnapshot => {
  const usage = (readers.resourceUsage ?? (() => process.resourceUsage()))();
  const memory = (readers.memoryUsage ?? (() => process.memoryUsage()))();
  const cgroup = readCgroup(readers.readCgroupFile ?? readOwnCgroupFile);
  return {
    process: {
      userCpuMicros: usage.userCPUTime,
      systemCpuMicros: usage.systemCPUTime,
      maxRssBytes: usage.maxRSS * 1024,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    ...(cgroup === undefined ? {} : { cgroup }),
  };
};

/** A span being recorded. A span of disabled telemetry has no IDs and records nothing. */
export interface RecordingSpan {
  /** This span's ID, `undefined` when nothing is recorded. */
  readonly spanId: string | undefined;
  /** The `traceparent` that makes work elsewhere this span's child, `undefined` likewise. */
  readonly traceparent: string | undefined;
  /** Adds attributes, screened as at the start. */
  readonly setAttributes: (attributes: Readonly<Record<string, unknown>>) => void;
  /** Ends the span and writes it. Only the first call counts. */
  readonly end: (options?: {
    readonly status?: SpanStatus;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }) => void;
}

export interface StartSpanOptions {
  /** The span this one is a child of. Defaults to the host's trace context. */
  readonly parent?: RecordingSpan;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface RuntimeTelemetry {
  /** Whether spans are recorded: a valid trace context and a writer were both given. */
  readonly enabled: boolean;
  /** The host's trace context, when valid. */
  readonly parent: TraceContext | undefined;
  /** Starts a span. A name that is not a short token is recorded as `unnamed`. */
  readonly startSpan: (name: string, options?: StartSpanOptions) => RecordingSpan;
  /** Runs `work` in a span that ends `ok` when it returns and `error` when it throws. */
  readonly span: <A>(
    name: string,
    work: (span: RecordingSpan) => A | Promise<A>,
    options?: StartSpanOptions,
  ) => Promise<A>;
  /** Reads resource use now and writes it under `parent`, or the host's trace context. */
  readonly recordResources: (options?: {
    readonly parent?: RecordingSpan;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }) => void;
}

export interface RuntimeTelemetryOptions {
  /** The parent trace context. Defaults to `TRACEPARENT` in `env`. */
  readonly traceparent?: string;
  /** Where `TRACEPARENT` is read when `traceparent` is not given. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where events go. Without one nothing is recorded. */
  readonly writer?: TelemetryWriter;
  /** The current time in Unix epoch milliseconds. */
  readonly now?: () => number;
  /** Random bytes for span IDs. Defaults to `crypto.getRandomValues`. */
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly resources?: ResourceReaders;
}

const disabledSpan: RecordingSpan = {
  spanId: undefined,
  traceparent: undefined,
  setAttributes: () => undefined,
  end: () => undefined,
};

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const defaultNow = () => performance.timeOrigin + performance.now();

const defaultRandomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));

/**
 * Records spans and resource use under the host's trace context and writes them through the
 * host's writer. Without a valid trace context or a writer every call does nothing.
 */
export const createRuntimeTelemetry = (options: RuntimeTelemetryOptions = {}): RuntimeTelemetry => {
  const parent = parseTraceparent(
    options.traceparent ?? (options.env ?? process.env)["TRACEPARENT"],
  );
  const writer = options.writer;
  if (parent === undefined || writer === undefined)
    return {
      enabled: false,
      parent,
      startSpan: () => disabledSpan,
      span: async (_name, work) => work(disabledSpan),
      recordResources: () => undefined,
    };

  const now = options.now ?? defaultNow;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const write = (event: TelemetryEvent) => {
    try {
      writer(event);
    } catch {
      // Recording never fails the run it records.
    }
  };
  const newSpanId = () => {
    for (;;) {
      const id = toHex(randomBytes(8)).slice(0, 16).padStart(16, "0");
      if (!allZero.test(id)) return id;
    }
  };
  const parentIdOf = (span: RecordingSpan | undefined) => span?.spanId ?? parent.spanId;

  const startSpan = (name: string, spanOptions: StartSpanOptions = {}): RecordingSpan => {
    const spanId = newSpanId();
    const parentSpanId = parentIdOf(spanOptions.parent);
    const startTimeMs = now();
    const attributes = new Map<string, AttributeValue>();
    const add = (more: Readonly<Record<string, unknown>> | undefined) => {
      for (const [key, value] of Object.entries(screenAttributes(more)))
        if (attributes.has(key) || attributes.size < maxAttributes) attributes.set(key, value);
    };
    add(spanOptions.attributes);
    let ended = false;
    return {
      spanId,
      traceparent: formatTraceparent({ ...parent, spanId }),
      setAttributes: (more) => {
        if (!ended) add(more);
      },
      end: (endOptions = {}) => {
        if (ended) return;
        ended = true;
        add(endOptions.attributes);
        write({
          type: "span",
          traceId: parent.traceId,
          spanId,
          parentSpanId,
          traceFlags: parent.traceFlags,
          name: token.test(name) ? name : "unnamed",
          startTimeMs,
          endTimeMs: now(),
          status: endOptions.status ?? "unset",
          attributes: Object.fromEntries(attributes),
        });
      },
    };
  };

  return {
    enabled: true,
    parent,
    startSpan,
    span: async (name, work, spanOptions) => {
      const span = startSpan(name, spanOptions);
      try {
        const result = await work(span);
        span.end({ status: "ok" });
        return result;
      } catch (error) {
        span.end({ status: "error" });
        throw error;
      }
    },
    recordResources: (resourceOptions = {}) => {
      let snapshot: ResourceSnapshot;
      try {
        snapshot = readResources(options.resources);
      } catch {
        return;
      }
      write({
        type: "resource",
        traceId: parent.traceId,
        parentSpanId: parentIdOf(resourceOptions.parent),
        traceFlags: parent.traceFlags,
        timeMs: now(),
        attributes: screenAttributes(resourceOptions.attributes),
        ...snapshot,
      });
    },
  };
};
