import { posix } from "node:path";
import type { AgentOutputType } from "@openai/agents";
import { Effect } from "effect";
import {
  publicationFindingCategories,
  publicationReasons,
  routePointerParts,
  shareabilityReasons,
} from "./review-contracts.js";
import type { PendingExecution, ReviewFailure } from "./review.js";

/**
 * Every Guardian review kind shares one request layout: the same instructions, tool and output
 * format. Only the per-review user message differs, so a mint's conversation stays cached when
 * it moves from one kind of review to another.
 */
export type ReviewKind = "execution" | "question" | "recovery" | "publication" | "shareability";

export const reviewKindOf = (pending: PendingExecution): ReviewKind =>
  pending.shareabilityCandidate !== undefined
    ? "shareability"
    : pending.publication !== undefined
      ? "publication"
      : pending.questionCandidate !== undefined
        ? "question"
        : pending.recoveryCandidate !== undefined
          ? "recovery"
          : "execution";

/** The outcomes each kind may return. The host refuses any other as an invalid decision. */
export const reviewOutcomes = {
  execution: ["allow", "deny", "escalate"],
  recovery: ["allow", "deny", "escalate"],
  publication: ["allow", "deny", "escalate"],
  question: ["allow_business", "authentication", "reword"],
  shareability: ["public", "private"],
} as const satisfies Record<ReviewKind, readonly string[]>;

/** The decision fields besides outcome and rationale that each kind uses. */
const reviewFields: Record<ReviewKind, readonly string[]> = {
  execution: [],
  recovery: [],
  question: [],
  publication: ["reason", "findings"],
  shareability: ["reason"],
};

/**
 * One strict output format for every kind: the union of their outcomes and fields. A field a
 * kind does not use is null; the host drops it and checks the outcome against the kind.
 */
export const guardianDecisionFormat: AgentOutputType = {
  type: "json_schema",
  name: "guardian_decision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: [...new Set(Object.values(reviewOutcomes).flat())],
      },
      rationale: { type: "string" },
      reason: {
        anyOf: [
          { type: "null" },
          { type: "string", enum: [...publicationReasons, ...shareabilityReasons] },
        ],
      },
      findings: {
        anyOf: [
          { type: "null" },
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                byteStart: { type: "integer", minimum: 0 },
                byteEnd: { type: "integer", minimum: 1 },
                category: {
                  type: "string",
                  // The host's own example-input check is never Guardian's.
                  enum: publicationFindingCategories.filter(
                    (category) => category !== "example_input",
                  ),
                },
                route: {
                  anyOf: [
                    { type: "null" },
                    {
                      type: "object",
                      properties: {
                        order: { type: "integer", minimum: 1 },
                        part: { type: "string", enum: [...routePointerParts] },
                        name: { type: ["string", "null"] },
                      },
                      required: ["order", "part", "name"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              required: ["path", "byteStart", "byteEnd", "category", "route"],
              additionalProperties: false,
            },
          },
        ],
      },
    },
    required: ["outcome", "rationale", "reason", "findings"],
    additionalProperties: false,
  },
};

/**
 * The kind's own decision from the shared format: other kinds' fields and null placeholders
 * dropped. Undefined when the outcome is not one the kind may return.
 */
export const decisionForKind = (kind: ReviewKind, raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const outcome: unknown = Reflect.get(raw, "outcome");
  if (!(reviewOutcomes[kind] as readonly unknown[]).includes(outcome)) return undefined;
  const fields = new Set(["outcome", "rationale", ...reviewFields[kind]]);
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key, value]) => fields.has(key) && (value !== null || !reviewFields[kind].includes(key)),
    ),
  );
};

/** A source path as the host compares it: `./x`, `x` and `a/../x` name one file. */
export const sourcePath = (path: string): string => {
  const normal = posix.normalize(path);
  return normal.startsWith("./") ? normal.slice(2) : normal;
};

interface SourceChunk {
  readonly path: string;
  readonly byteOffset: number;
  readonly nextOffset: number;
  readonly hasMore: boolean;
  /** The chunk as one canonical JSON text, for comparing reads of the same bytes. */
  readonly canonical: string;
  readonly value: Readonly<Record<string, unknown>>;
}

/** One `read_source` result, when it is a source chunk the host can compare. */
export const sourceChunkOf = (observation: unknown): SourceChunk | undefined => {
  let value: unknown = observation;
  if (typeof observation === "string")
    try {
      value = JSON.parse(observation);
      // error-reporting-allow: parse-predicate a result that is not JSON is not a comparable chunk
    } catch {
      return undefined;
    }
  if (typeof value !== "object" || value === null) return undefined;
  const chunk = value as Record<string, unknown>;
  const { path, byteOffset, nextOffset, hasMore } = chunk;
  return chunk.kind === "untrusted_source" &&
    typeof path === "string" &&
    typeof byteOffset === "number" &&
    typeof nextOffset === "number" &&
    typeof hasMore === "boolean"
    ? {
        path: sourcePath(path),
        byteOffset,
        nextOffset,
        hasMore,
        canonical: JSON.stringify(chunk),
        value: chunk,
      }
    : undefined;
};

const resultText = (output: unknown): string | undefined => {
  if (typeof output === "string") return output;
  if (typeof output !== "object" || output === null) return undefined;
  if (Array.isArray(output)) {
    const texts = output.map(resultText);
    return texts.every((text) => text !== undefined) ? texts.join("") : undefined;
  }
  const text: unknown = Reflect.get(output, "text");
  return typeof text === "string" ? text : undefined;
};

/** Source chunks Guardian has in view, by path and byte offset, each as canonical JSON. */
export type SourceLedger = ReadonlyMap<string, ReadonlyMap<number, string>>;

/**
 * What Guardian already read in a conversation: every source chunk a `read_source` result or a
 * request's included entrypoint carries. A session's history starts at its last compaction, so
 * this is what Guardian read since then.
 */
export const sourceLedger = (history: readonly unknown[]): SourceLedger => {
  const ledger = new Map<string, Map<number, string>>();
  const keep = (chunk: SourceChunk | undefined) => {
    if (chunk === undefined) return;
    const chunks = ledger.get(chunk.path) ?? new Map<number, string>();
    chunks.set(chunk.byteOffset, chunk.canonical);
    ledger.set(chunk.path, chunks);
  };
  for (const item of history) {
    if (typeof item !== "object" || item === null) continue;
    const type: unknown = Reflect.get(item, "type");
    if (type === "function_call_result" && Reflect.get(item, "name") === "read_source")
      keep(sourceChunkOf(resultText(Reflect.get(item, "output"))));
    else if (Reflect.get(item, "role") === "user") {
      const request = sourceChunkRequest(resultText(Reflect.get(item, "content")));
      keep(request);
    }
  }
  return ledger;
};

/** The entrypoint chunk a review request included, when the message is a review request. */
const sourceChunkRequest = (content: string | undefined): SourceChunk | undefined => {
  if (content === undefined || !content.startsWith("{")) return undefined;
  try {
    const request: unknown = JSON.parse(content);
    if (typeof request !== "object" || request === null) return undefined;
    const call: unknown = Reflect.get(request, "submitted_call");
    return typeof call === "object" && call !== null
      ? sourceChunkOf(Reflect.get(call, "entrypointSource"))
      : undefined;
    // error-reporting-allow: parse-predicate a message that is not JSON includes no source
  } catch {
    return undefined;
  }
};

/** A file larger than this many chunks is read again rather than compared. */
const comparedChunks = 32;

/**
 * The paths whose current content is byte-identical, chunk for chunk, to what the ledger holds.
 * Only paths Guardian already read are compared; a read that fails leaves its path out.
 */
export const unchangedSources = (
  ledger: SourceLedger,
  paths: readonly string[],
  read: (path: string, offset: number) => Effect.Effect<string, ReviewFailure>,
): Effect.Effect<readonly string[]> =>
  Effect.forEach(
    [...new Set(paths)].filter((path) => ledger.has(sourcePath(path))),
    (path) =>
      Effect.gen(function* () {
        const seen = ledger.get(sourcePath(path));
        let offset = 0;
        for (let index = 0; index < comparedChunks; index++) {
          const current = sourceChunkOf(yield* read(path, offset));
          if (current === undefined || seen?.get(offset) !== current.canonical) return [];
          if (!current.hasMore) return [path];
          if (current.nextOffset <= offset) return [];
          offset = current.nextOffset;
        }
        return [];
      }).pipe(
        // error-reporting-allow: typed-recovery a source the host cannot compare is read again
        Effect.catchAll(() => Effect.succeed([])),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((found) => found.flat()));

const privateReviewRequest = (item: unknown): boolean => {
  if (typeof item !== "object" || item === null || Reflect.get(item, "role") !== "user")
    return false;
  const content: unknown = Reflect.get(item, "content");
  if (typeof content !== "string" || !content.startsWith("{")) return false;
  try {
    const request: unknown = JSON.parse(content);
    const review: unknown =
      typeof request === "object" && request !== null
        ? Reflect.get(request, "trusted_review")
        : undefined;
    return (
      typeof review === "object" &&
      review !== null &&
      Reflect.get(review, "kind") === "shareability"
    );
    // error-reporting-allow: parse-predicate a message that is not JSON is no review request
  } catch {
    return false;
  }
};

/**
 * A conversation as readable records may show it: each shareability review's exchange, its
 * request and everything up to the next request, replaced by one placeholder message. The
 * model still receives the whole conversation; `restore` maps placeholders back to it.
 */
export const withholdPrivateReviews = <Item>(
  items: readonly Item[],
  placeholder: (index: number) => Item,
  /** The items before the first request continue a shareability review a compaction cut. */
  leadingPrivate = false,
): { readonly items: Item[]; readonly withheld: ReadonlyMap<string, readonly Item[]> } => {
  const shown: Item[] = [];
  const withheld = new Map<string, Item[]>();
  let segment: Item[] | undefined;
  if (leadingPrivate) {
    const stand = placeholder(0);
    segment = [];
    withheld.set(JSON.stringify(stand), segment);
    shown.push(stand);
  }
  for (const item of items) {
    const request =
      typeof item === "object" && item !== null && Reflect.get(item, "role") === "user";
    if (request) segment = undefined;
    if (request && privateReviewRequest(item)) {
      const stand = placeholder(withheld.size);
      segment = [];
      withheld.set(JSON.stringify(stand), segment);
      shown.push(stand);
    }
    if (segment === undefined) shown.push(item);
    else segment.push(item);
  }
  return { items: shown, withheld };
};

/**
 * Whether the items a compaction keeps, up to the next request, belong to a shareability
 * review: the last request among the items it drops says, or else the earlier answer stands.
 */
export const leadingPrivateAfter = (dropped: readonly unknown[], before: boolean): boolean => {
  for (const item of [...dropped].reverse())
    if (typeof item === "object" && item !== null && Reflect.get(item, "role") === "user")
      return privateReviewRequest(item);
  return before;
};
