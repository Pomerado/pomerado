/** A published schema whose local reference cannot be inlined, or recurses. */
export class UnresolvedSchemaReference extends Error {}
const isRecord = (value: unknown): value is Record<string, unknown> =>
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
