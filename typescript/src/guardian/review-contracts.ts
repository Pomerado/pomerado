import { Schema } from "effect";

/**
 * Host-owned index of a publication review's evidence, in UTF-8 bytes. `published` files ship with
 * the tool; the rest are host evidence for this review only. `current` files are the publication
 * as it stands; the others are historical source an earlier execution ran, such as a write
 * session's act steps. `owner` says who wrote a file: the minter edits its own, and nothing it
 * edits changes a host-written one. Guardian reads what the review needs; nothing must be read in
 * full.
 */
export interface PublicationScope {
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly published: boolean;
    readonly current: boolean;
    readonly owner: "host" | "minter";
  }[];
}

/**
 * Input findings are feedback for the minter; they never block a publication on their own.
 * `example_input` is the host's own check that each key of an intent-derived example's input is
 * a schema input, never Guardian's.
 */
export const inputFindingCategories = [
  "account_specific_enum",
  "input_option",
  "example_value",
  "example_input",
] as const;
export const publicationFindingCategories = [
  "private_literal",
  "credential",
  "customer_data",
  "exfiltration",
  "unsafe_logging",
  "schema_mismatch",
  "unsupported_claim",
  "confirmation",
  ...inputFindingCategories,
] as const;
export const publicationReasons = [
  "approved",
  "privacy",
  "authority",
  "evidence",
  "source_correction",
  "unsupported_claim",
  "input_feedback",
  // Every finding is in a host-written file, which no source or metadata edit can fix.
  "host_owned",
] as const;

/** The parts of one route in a host-generated routes.json that a finding can point at. */
export const routePointerParts = [
  "request_field",
  "response_field",
  "query",
  "path_segment",
  "url",
] as const;
/**
 * Where in a host-generated file a finding is: the route by its `order`, which every review chunk
 * shows, and the part at fault, named exactly as the file writes it; `url` is the whole route and
 * names nothing. The host checks it against the file; a pointer it cannot match is no pointer.
 */
export const RoutePointer = Schema.Struct({
  order: Schema.Int.pipe(Schema.positive()),
  part: Schema.Literal(...routePointerParts),
  name: Schema.NullOr(Schema.String),
});
export type RoutePointer = typeof RoutePointer.Type;

export const PublicationFinding = Schema.Struct({
  path: Schema.String,
  byteStart: Schema.Int.pipe(Schema.nonNegative()),
  byteEnd: Schema.Int.pipe(Schema.positive()),
  category: Schema.Literal(...publicationFindingCategories),
  /** Only for a finding in a host-generated file; the model sends null for any other. */
  route: Schema.optionalWith(RoutePointer, { exact: true, nullable: true }),
});
export type PublicationFinding = typeof PublicationFinding.Type;
export const PublicationReason = Schema.Literal(...publicationReasons);
export type PublicationReason = typeof PublicationReason.Type;

export interface PublicationFileBlock {
  readonly file: string;
  readonly section?: string;
  readonly check: "registered_value" | "contextual_secret" | "provider_credential" | "invalid_text";
  readonly entity?: string;
  readonly valueSource?: string;
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
}
