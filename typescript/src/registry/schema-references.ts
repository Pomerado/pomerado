/** A published schema whose local reference cannot be inlined, or recurses. */
export class UnresolvedSchemaReference extends Error {}
type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Reference expansion can grow exponentially; one operation must not stall discovery.
const inlinedSchemaNodeLimit = 10_000;
/**
 * A published operation schema with its local references resolved against the schema's root,
 * so it can be read, or nested under another schema, without its `$defs`. A reference that
 * cannot be inlined or recurses throws rather than leaving a dangling one.
 */
export const inlineLocalRefs = (schema: Record<string, unknown>): Record<string, unknown> => {
  let nodes = 0;
  const definitions = isRecord(schema["$defs"]) ? schema["$defs"] : {};
  const visit = (value: unknown, expanding: readonly unknown[]): unknown => {
    if (!Array.isArray(value) && !isRecord(value)) return value;
    if (++nodes > inlinedSchemaNodeLimit) throw new UnresolvedSchemaReference();
    if (Array.isArray(value)) return value.map((child) => visit(child, expanding));
    const reference = value["$ref"];
    if (typeof reference === "string") {
      const name = /^#\/\$defs\/([^/]+)$/.exec(reference)?.[1];
      const target =
        name === undefined
          ? undefined
          : definitions[name.replaceAll("~1", "/").replaceAll("~0", "~")];
      if (!isRecord(target) || expanding.includes(target)) throw new UnresolvedSchemaReference();
      const siblings = { ...value };
      delete siblings["$ref"];
      return visit({ ...target, ...siblings }, [...expanding, target]);
    }
    const allOf: unknown = value["allOf"];
    if (Array.isArray(allOf) && allOf.length === 1 && isRecord(allOf[0])) {
      const siblings = { ...value };
      delete siblings["allOf"];
      return visit({ ...allOf[0], ...siblings }, expanding);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$defs")
        .map(([key, child]) => [key, visit(child, expanding)]),
    );
  };
  const inlined = visit(schema, []);
  if (!isRecord(inlined)) throw new UnresolvedSchemaReference();
  return inlined;
};


/**
 * A tool's published schema in the one form every surface reads: its references resolved against
 * the schema's root, as the run check (Ajv) resolves them, and each one that is left points at a
 * definition in `definitions` as `#/$defs/<name>`. A schema whose references all expand is fully
 * inlined, with `definitions` empty; one that recurses, or would grow past inlining's limit, keeps
 * its references, and whatever nests the schema (an MCP tool, an OpenAPI document) places
 * `definitions` where those references resolve. Neither part holds `$schema`, `$defs` or
 * `definitions`.
 */
export interface CanonicalSchema {
  readonly schema: Json;
  readonly definitions: Readonly<Record<string, Json | boolean>>;
}

/** Keywords whose value is one schema. */
const schemaKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
/** Keywords whose value is a list of schemas (`items` too, in its older tuple form). */
const schemaListKeywords = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);
/** Keywords whose value maps names to schemas. */
const schemaMapKeywords = new Set(["dependentSchemas", "patternProperties", "properties"]);
/** Containers of definitions, which the canonical form moves to `definitions`. */
const definitionContainers = new Set(["$defs", "definitions"]);
/** Keywords the canonical form leaves out: the dialect, and identifiers the run check ignores. */
const droppedKeywords = new Set(["$schema", "$id"]);

/** A reference that names nothing in the schema. */
class Dangling extends Error {}

const mapEntries = (value: Json, child: (value: unknown) => unknown) =>
  Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, child(entry)]));
/**
 * One keyword's value with `schema` applied to each schema in it and `data` to anything else:
 * examples, defaults, constants and other keywords' values are data, whatever they look like.
 */
const subschemasIn = (
  key: string,
  value: unknown,
  schema: (value: unknown) => unknown,
  data: (value: unknown) => unknown = (unchanged) => unchanged,
): unknown => {
  if (schemaKeywords.has(key) && !Array.isArray(value)) return schema(value);
  if (schemaListKeywords.has(key) && Array.isArray(value)) return value.map(schema);
  if (schemaMapKeywords.has(key) && isRecord(value)) return mapEntries(value, schema);
  if (key === "dependencies" && isRecord(value))
    return mapEntries(value, (entry) => (Array.isArray(entry) ? data(entry) : schema(entry)));
  return data(value);
};

/** The definition a canonical reference (`#/$defs/<name>`) names. */
const definitionNamed = (reference: unknown) =>
  typeof reference === "string" ? /^#\/\$defs\/([^/]+)$/.exec(reference)?.[1] : undefined;

/**
 * A part of a canonical schema with each of its references pointing where `to` says for the
 * definition it names; data, such as an example that looks like a reference, as it is.
 */
export const withReferences = (schema: unknown, to: (name: string) => string): unknown =>
  isRecord(schema)
    ? Object.fromEntries(
        Object.entries(schema).map(([key, value]) => {
          const name = key === "$ref" ? definitionNamed(value) : undefined;
          return [
            key,
            name === undefined
              ? subschemasIn(key, value, (child) => withReferences(child, to))
              : to(name),
          ];
        }),
      )
    : schema;

/**
 * References that cannot all be expanded: one recurses, or expanding them grows past
 * `inlinedSchemaNodeLimit`, so the schema keeps its references.
 */
class KeepsReferences extends Error {}
const without = (schema: Json, keyword: string) =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => key !== keyword));

/**
 * `body` with each reference replaced by the definition it names, and a schema that is `allOf`
 * one schema merged with it, as `inlineLocalRefs` reads them; data as it is.
 */
const inlined = (body: Json, definitions: Readonly<Record<string, Json | boolean>>): Json => {
  let nodes = 0;
  const counted = (value: unknown): unknown => {
    if (isRecord(value) || Array.isArray(value)) {
      if (++nodes > inlinedSchemaNodeLimit) throw new KeepsReferences();
      for (const child of Object.values(value)) counted(child);
    }
    return value;
  };
  const inline = (schema: Json, expanding: readonly string[]): Json => {
    if (++nodes > inlinedSchemaNodeLimit) throw new KeepsReferences();
    const name = definitionNamed(schema["$ref"]);
    if (name !== undefined) {
      const target = definitions[name];
      if (!isRecord(target) || expanding.includes(name)) throw new KeepsReferences();
      return inline({ ...target, ...without(schema, "$ref") }, [...expanding, name]);
    }
    const allOf = schema["allOf"];
    if (Array.isArray(allOf) && allOf.length === 1 && isRecord(allOf[0]))
      return inline({ ...allOf[0], ...without(schema, "allOf") }, expanding);
    return Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        subschemasIn(
          key,
          value,
          (child) => (isRecord(child) ? inline(child, expanding) : child),
          counted,
        ),
      ]),
    );
  };
  return inline(body, []);
};

/** The JSON pointer a local reference names, as its decoded segments; none for any other kind. */
const pointerOf = (reference: string): readonly string[] | undefined => {
  if (reference === "#") return [];
  if (!reference.startsWith("#/")) return undefined;
  const segments = reference.slice(2).split("/");
  // A stray `%` is not an escape, so the reference names no place in the schema.
  if (segments.some((segment) => /%(?![0-9A-Fa-f]{2})/.test(segment))) return undefined;
  return segments.map((segment) =>
    percentDecoded(segment).replaceAll("~1", "/").replaceAll("~0", "~"),
  );
};

/** A segment with each `%XX` escape decoded as UTF-8; bytes that are not UTF-8 become U+FFFD, which no definition is named. */
const percentDecoded = (segment: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(
      segment
        .split(/(%[0-9A-Fa-f]{2})/)
        .flatMap((part) =>
          /^%[0-9A-Fa-f]{2}$/.test(part)
            ? [Number.parseInt(part.slice(1), 16)]
            : [...new TextEncoder().encode(part)],
        ),
    ),
  );

/** The value a pointer names in `root`, or none. */
const resolve = (root: Json, pointer: readonly string[]): unknown => {
  let value: unknown = root;
  for (const segment of pointer) {
    if (Array.isArray(value) && /^(?:0|[1-9]\d*)$/.test(segment)) value = value[Number(segment)];
    else if (isRecord(value) && Object.hasOwn(value, segment)) value = value[segment];
    else return undefined;
  }
  return value;
};

/** A definition name OpenAPI and MCP clients accept, from a pointer's last segment. */
const nameFrom = (pointer: readonly string[]) => {
  const last = pointer.at(-1);
  const cleaned = (last ?? "Root").replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" ? "Definition" : cleaned;
};

/**
 * A tool's published schema in its canonical form (`CanonicalSchema`), or none when one of its
 * references names nothing in the schema: a remote URI, an anchor, or a pointer to a missing
 * place. No surface can serve such a schema as it is.
 */
export const canonicalSchema = (published: Json): CanonicalSchema | undefined => {
  /** Each referenced place, by its pointer, with the definition name it is given. */
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const nameOf = (pointer: readonly string[]) => {
    const key = JSON.stringify(pointer);
    const known = names.get(key);
    if (known !== undefined) return known;
    const base = nameFrom(pointer);
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
    taken.add(name);
    names.set(key, name);
    return name;
  };
  // Root definitions keep their own names, so a `#/$defs/X` reference stays `#/$defs/X`.
  for (const container of ["$defs", "definitions"]) {
    const definitions = published[container];
    if (isRecord(definitions))
      for (const name of Object.keys(definitions)) nameOf([container, name]);
  }
  /** The referenced places whose definitions are still to write, each once. */
  const referenced = new Set<string>();
  const pending: (readonly string[])[] = [];
  const definitionName = (pointer: readonly string[]) => {
    const key = JSON.stringify(pointer);
    if (!referenced.has(key)) {
      referenced.add(key);
      pending.push(pointer);
    }
    return nameOf(pointer);
  };

  const reference = (value: string) => {
    const pointer = pointerOf(value);
    const target = pointer === undefined ? undefined : resolve(published, pointer);
    if (pointer === undefined || (!isRecord(target) && typeof target !== "boolean"))
      throw new Dangling();
    return `#/$defs/${definitionName(pointer).replaceAll("~", "~0").replaceAll("/", "~1")}`;
  };
  const rewrite = (schema: unknown): unknown =>
    isRecord(schema)
      ? Object.fromEntries(
          Object.entries(schema)
            .filter(([key]) => !droppedKeywords.has(key) && !definitionContainers.has(key))
            .map(([key, value]) => [
              key,
              key === "$ref" && typeof value === "string"
                ? reference(value)
                : subschemasIn(key, value, rewrite),
            ]),
        )
      : schema;

  let body: Json;
  const definitions: Record<string, Json | boolean> = {};
  try {
    const rewritten = rewrite(published);
    if (!isRecord(rewritten)) return undefined;
    body = rewritten;
    for (let pointer = pending.shift(); pointer !== undefined; pointer = pending.shift()) {
      const name = nameOf(pointer);
      const target = resolve(published, pointer);
      const definition = rewrite(target);
      if (typeof definition === "boolean" || isRecord(definition)) definitions[name] = definition;
    }
  } catch (error) {
    if (error instanceof Dangling) return undefined;
    throw error;
  }
  try {
    return { schema: inlined(body, definitions), definitions: {} };
  } catch (error) {
    if (!(error instanceof KeepsReferences)) throw error;
  }
  // References are kept: a recursive schema, or one inlining would grow past its limit.
  return { schema: body, definitions };
};
