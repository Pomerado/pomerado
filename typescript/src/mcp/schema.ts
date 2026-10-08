import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { JSONSchema, Schema } from "effect";
import { valueFreeIssues } from "../runtime/schema-issues.js";
import { inlineLocalRefs } from "../registry/schema-references.js";
import type { CanonicalSchema } from "../registry/schema-references.js";

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

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The most top-level fields a site tool's `input` description names. */
const maximumSummarizedInputFields = 12;
/** The longest field description a site tool's `input` description repeats. */
const maximumSummarizedFieldDescription = 80;
const schemaType = (schema: unknown): string => {
  if (!isRecord(schema)) return "any value";
  const type = schema["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(type))
    return type.filter((name): name is string => typeof name === "string").join(" or ");
  const branches = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(branches)) return [...new Set(branches.map(schemaType))].join(" or ");
  if ("properties" in schema) return "object";
  return "any value";
};
const fieldDescription = (schema: unknown) => {
  const description = isRecord(schema) ? schema["description"] : undefined;
  if (typeof description !== "string") return "";
  const text = description.replaceAll(/\s+/g, " ").trim().replace(/\.$/, "");
  if (text === "") return "";
  // Cut by code point: a lone surrogate makes strict JSON parsers refuse the whole tool list.
  const characters = Array.from(text);
  return `: ${characters.length > maximumSummarizedFieldDescription ? `${characters.slice(0, maximumSummarizedFieldDescription - 1).join("")}…` : text}`;
};
/**
 * What a site tool's `input` takes, for a client that shows only top-level parameters: its
 * top-level fields, required ones first, with their types, required flags and own
 * descriptions, or else its type.
 */
const inputSummary = (schema: Json) => {
  const fields = isRecord(schema["properties"]) ? Object.entries(schema["properties"]) : [];
  if (fields.length === 0)
    return schemaType(schema) === "object" && schema["additionalProperties"] === false
      ? "This operation takes no input fields. Send {}."
      : `The operation's input (${schemaType(schema)}).`;
  const required: unknown[] = Array.isArray(schema["required"]) ? schema["required"] : [];
  // Required fields first, so the cap never hides one.
  const named = [
    ...fields.filter(([name]) => required.includes(name)),
    ...fields.filter(([name]) => !required.includes(name)),
  ]
    .slice(0, maximumSummarizedInputFields)
    .map(
      ([name, field]) =>
        `${name} (${schemaType(field)}${required.includes(name) ? ", required" : ""})${fieldDescription(field)}`,
    );
  const unnamed = fields.length - named.length;
  return `The operation's input: ${[...named, ...(unnamed > 0 ? [`and ${unnamed} more`] : [])].join("; ")}.`;
};
/** A canonical schema's root, read through a root that is one reference to a definition. */
export const described = (schema: CanonicalSchema) => {
  const root = /^#\/\$defs\/([^/]+)$/.exec(String(schema.schema["$ref"]))?.[1];
  const definition = root === undefined ? undefined : schema.definitions[root];
  return isRecord(definition) ? definition : schema.schema;
};
/**
 * A site tool's `input` as a call schema nests it: titled with the tool's name, and described by
 * its own description and a summary of its fields. A recursive input keeps its references, which
 * resolve once the call schema holds `definitions` at its root.
 */
export const siteInput = (name: string, input: CanonicalSchema) => {
  const own =
    typeof input.schema["description"] === "string" ? `${input.schema["description"]}\n` : "";
  return {
    title: `${name} input`,
    ...input.schema,
    description: `${own}${inputSummary(described(input))}`,
  };
};
