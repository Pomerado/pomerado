import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { JSONSchema, Schema } from "effect";
import { valueFreeIssues } from "../runtime/schema-issues.js";
import { inlineLocalRefs } from "../registry/schema-references.js";

export function standard<A, I>(
  schema: Schema.Schema<A, I>,
  jsonSchema?: Record<string, unknown>,
  normalize: (value: unknown) => unknown = (value) => value,
): StandardSchemaWithJSON<I, A> {
  const json = inlineLocalRefs(jsonSchema ?? { ...JSONSchema.make(schema) });
  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      validate: (value: unknown) => {
        const parsed = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(
          normalize(value),
        );
        // The caller's own input, so it gets every issue, credentials masked.
        return parsed._tag === "Right"
          ? { value: parsed.right }
          : { issues: valueFreeIssues(parsed.left.issue) };
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}
