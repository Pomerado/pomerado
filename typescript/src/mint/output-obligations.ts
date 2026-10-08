/**
 * The output obligations a repaired tool keeps: a deterministic comparison of a published tool's
 * registered output JSON Schema with the schema its repair would publish. A repair may tighten
 * the contract or add optional fields; it never loosens what callers already rely on. A field
 * whose loosening an applied, owner-confirmed `mint_update` output change names is exempt.
 */

/** How a repair loosens one registered output field. */
export type OutputLoosening = "removed" | "optional" | "nullable" | "widened";

/** One registered output field a repair loosens, by path (`items[].price.amount`; the root is `output`). */
export interface WeakenedOutput {
  readonly field: string;
  readonly change: OutputLoosening;
}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keywords that constrain a value; a node with none of them admits anything. */
const constraintKeys = [
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "properties",
  "required",
  "items",
  "prefixItems",
  "$ref",
  "not",
] as const;

const jsonType = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "number"
        ? Number.isInteger(value)
          ? "integer"
          : "number"
        : typeof value;

/** One alternative a schema node admits, with `$ref` and `allOf` resolved. */
interface Branch {
  readonly node: Json;
  /** The non-null JSON types it admits; undefined admits any value. */
  readonly types: ReadonlySet<string> | undefined;
  readonly nullable: boolean;
  /** The values it admits, when it lists them (`enum`/`const`), without `null`. */
  readonly values: readonly unknown[] | undefined;
}

const resolve = (root: Json, node: unknown, seen: ReadonlySet<string> = new Set()): Json => {
  if (!isObject(node)) return node === false ? { not: {} } : {};
  const ref = node["$ref"];
  if (typeof ref === "string" && !seen.has(ref)) {
    const match = /^#\/(\$defs|definitions)\/(.+)$/u.exec(ref);
    const definitions = match === null ? undefined : root[match[1] ?? ""];
    const target =
      match !== null && isObject(definitions)
        ? definitions[
            decodeURIComponent((match[2] ?? "").replace(/~1/gu, "/").replace(/~0/gu, "~"))
          ]
        : undefined;
    const { $ref: _ref, ...rest } = node;
    return resolve(root, { ...(isObject(target) ? target : {}), ...rest }, new Set([...seen, ref]));
  }
  const allOf = node["allOf"];
  if (Array.isArray(allOf)) {
    const { allOf: _allOf, ...rest } = node;
    // Every part applies at once: their keywords merge, and their required fields add up.
    return allOf.reduce<Json>((merged, part) => {
      const resolved = resolve(root, part, seen);
      const required = [
        ...(Array.isArray(merged["required"]) ? merged["required"] : []),
        ...(Array.isArray(resolved["required"]) ? resolved["required"] : []),
      ];
      const properties = {
        ...(isObject(merged["properties"]) ? merged["properties"] : {}),
        ...(isObject(resolved["properties"]) ? resolved["properties"] : {}),
      };
      return {
        ...merged,
        ...resolved,
        ...(required.length === 0 ? {} : { required }),
        ...(Object.keys(properties).length === 0 ? {} : { properties }),
      };
    }, rest);
  }
  return node;
};

const branchesOf = (root: Json, node: unknown): readonly Branch[] => {
  const resolved = resolve(root, node);
  const alternatives = resolved["anyOf"] ?? resolved["oneOf"];
  if (Array.isArray(alternatives)) {
    const { anyOf: _anyOf, oneOf: _oneOf, ...shared } = resolved;
    return alternatives.flatMap((alternative) =>
      branchesOf(root, { ...shared, ...resolve(root, alternative) }),
    );
  }
  if (!constraintKeys.some((key) => key in resolved))
    return [{ node: resolved, types: undefined, nullable: true, values: undefined }];
  const listed =
    "const" in resolved
      ? [resolved["const"]]
      : Array.isArray(resolved["enum"])
        ? resolved["enum"]
        : undefined;
  const declared = resolved["type"];
  const types =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((type): type is string => typeof type === "string")
        : listed !== undefined
          ? listed.map(jsonType)
          : "properties" in resolved || "required" in resolved
            ? ["object"]
            : "items" in resolved || "prefixItems" in resolved
              ? ["array"]
              : undefined;
  if (types === undefined)
    return [{ node: resolved, types: undefined, nullable: true, values: undefined }];
  const nullable =
    types.includes("null") && (listed === undefined || listed.some((value) => value === null));
  return [
    {
      node: resolved,
      types: new Set(types.filter((type) => type !== "null")),
      nullable,
      values: listed?.filter((value) => value !== null),
    },
  ];
};

const admits = (types: ReadonlySet<string>, type: string) =>
  types.has(type) || (type === "integer" && types.has("number"));

const branchOfType = (branches: readonly Branch[], type: string) =>
  branches.filter((branch) => branch.types?.has(type) === true);

const numberAt = (node: Json, key: string) =>
  typeof node[key] === "number" ? (node[key] as number) : undefined;

const child = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/**
 * The registered output fields `repaired` loosens, in the registered schema's order: a field
 * removed, made optional, newly nullable, or widened (a type or listed value newly admitted, a
 * lower or absent `minLength`/`minItems`, a dropped `pattern`). Tightening and new optional fields
 * are no loosening. `exempt` lists field paths, as an `output` task change names them, whose
 * loosening an applied update covers, each with everything under it.
 */
export const weakenedOutputs = (
  registered: unknown,
  repaired: unknown,
  exempt: readonly string[] = [],
): readonly WeakenedOutput[] => {
  const registeredRoot = isObject(registered) ? registered : {};
  const repairedRoot = isObject(repaired) ? repaired : {};
  const found: WeakenedOutput[] = [];
  const covered = (path: string) =>
    exempt.some(
      (entry) =>
        entry === "output" ||
        entry === path ||
        (path.startsWith(entry) && (path[entry.length] === "." || path[entry.length] === "[")),
    );
  const report = (path: string, change: OutputLoosening) => {
    const field = path === "" ? "output" : path;
    if (covered(field)) return;
    if (!found.some((entry) => entry.field === field && entry.change === change))
      found.push({ field, change });
  };
  const compare = (before: unknown, after: unknown, path: string, depth: number) => {
    if (depth > 64) return;
    const was = branchesOf(registeredRoot, before);
    const now = branchesOf(repairedRoot, after);
    // An unconstrained registered node promises nothing to keep.
    if (was.some((branch) => branch.types === undefined)) return;
    if (now.some((branch) => branch.types === undefined)) {
      report(path, "widened");
      return;
    }
    if (now.some((branch) => branch.nullable) && !was.some((branch) => branch.nullable))
      report(path, "nullable");
    const wasTypes = new Set(was.flatMap((branch) => [...(branch.types ?? [])]));
    const nowTypes = [...new Set(now.flatMap((branch) => [...(branch.types ?? [])]))];
    if (nowTypes.some((type) => !admits(wasTypes, type))) report(path, "widened");
    // Listed values: a registered list that every alternative keeps to bounds the repair's.
    const wasListed = was.filter((branch) => branch.types?.size !== 0);
    if (wasListed.length > 0 && wasListed.every((branch) => branch.values !== undefined)) {
      const allowed = new Set(
        wasListed.flatMap((branch) => branch.values ?? []).map((value) => JSON.stringify(value)),
      );
      const nowListed = now.filter((branch) => branch.types?.size !== 0);
      if (
        nowListed.some(
          (branch) =>
            branch.values === undefined ||
            branch.values.some((value) => !allowed.has(JSON.stringify(value))),
        )
      )
        report(path, "widened");
    }
    for (const type of ["string", "array", "object"] as const) {
      const wasBranches = branchOfType(was, type);
      const nowBranches = branchOfType(now, type);
      if (wasBranches.length !== 1 || nowBranches.length !== 1) continue;
      const { node: old } = wasBranches[0] as Branch;
      const { node: next } = nowBranches[0] as Branch;
      if (type === "string") {
        const minimum = numberAt(old, "minLength") ?? 0;
        if (minimum > 0 && (numberAt(next, "minLength") ?? 0) < minimum) report(path, "widened");
        if (typeof old["pattern"] === "string" && typeof next["pattern"] !== "string")
          report(path, "widened");
      } else if (type === "array") {
        const minimum = numberAt(old, "minItems") ?? 0;
        if (minimum > 0 && (numberAt(next, "minItems") ?? 0) < minimum) report(path, "widened");
        const positional = (node: Json) =>
          Array.isArray(node["prefixItems"])
            ? node["prefixItems"]
            : Array.isArray(node["items"])
              ? node["items"]
              : undefined;
        const oldPositions = positional(old);
        const nextPositions = positional(next);
        if (oldPositions !== undefined && nextPositions !== undefined)
          oldPositions.forEach((item, index) => {
            const itemPath = `${path}[${index}]`;
            if (index >= nextPositions.length) report(itemPath, "removed");
            else compare(item, nextPositions[index], itemPath, depth + 1);
          });
        const rest = (node: Json) =>
          isObject(node["items"]) || typeof node["items"] === "boolean"
            ? node["items"]
            : node["additionalItems"];
        if (rest(old) !== undefined && rest(next) !== undefined)
          compare(rest(old), rest(next), `${path}[]`, depth + 1);
      } else {
        const oldProperties = isObject(old["properties"]) ? old["properties"] : {};
        const nextProperties = isObject(next["properties"]) ? next["properties"] : {};
        const oldRequired = Array.isArray(old["required"]) ? old["required"] : [];
        const nextRequired = Array.isArray(next["required"]) ? next["required"] : [];
        for (const [key, schema] of Object.entries(oldProperties)) {
          const fieldPath = child(path, key);
          if (!(key in nextProperties)) {
            report(fieldPath, "removed");
            continue;
          }
          if (oldRequired.includes(key) && !nextRequired.includes(key))
            report(fieldPath, "optional");
          compare(schema, nextProperties[key], fieldPath, depth + 1);
        }
      }
    }
  };
  compare(registeredRoot, repairedRoot, "", 0);
  return found;
};

/** One line naming each loosened field and how, for the minter and the owner. */
export const weakenedOutputsText = (weakened: readonly WeakenedOutput[]) =>
  weakened
    .map(({ field, change }) =>
      change === "removed"
        ? `${field} was removed`
        : change === "optional"
          ? `${field} became optional`
          : change === "nullable"
            ? `${field} became nullable`
            : `${field} admits more values than before`,
    )
    .join("; ");
