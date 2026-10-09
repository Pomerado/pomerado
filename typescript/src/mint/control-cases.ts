import { createHash } from "node:crypto";

/**
 * Control checks, the case generator: from a read tool's input JSON Schema (and its output
 * schema, when known) to an ordered plan of inputs that exercise each control the tool declares.
 * Pure: the clock, the budget and the priorities are passed in, and every value a case holds comes
 * from the schema itself or is a host token that names nothing. A case key names only schema
 * values or host placeholders, never a caller's value, so results can be compared across
 * revisions and kept without the inputs that produced them.
 */

/** A JSON Schema object as a tool's contract declares it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Why a case is in the plan. */
export type ControlCaseKind =
  /** Required fields at their first example, optional fields unset. */
  | "base"
  /** One field changed from the base case. */
  | "field"
  /** A declared numeric minimum or maximum, or a limit's bounds. */
  | "boundary"
  /** A paired range set inverted (minimum above maximum). */
  | "inverted_range"
  /** Dates set relative to the injected clock, in order. */
  | "dates"
  /** Page 1, then page 2 through the cursor page 1 returned. */
  | "paging"
  /** Every optional field set at once. */
  | "all_together"
  /** A search's free-text field set to a host token that matches nothing. */
  | "empty_probe"
  /** An option field set to a value the page cannot offer. */
  | "unoffered_probe";

/**
 * What the case expects:
 * - `result`: a decoded result, possibly empty; a throw fails.
 * - `empty_or_choices`: the site's own empty result, or a refusal naming the choices; a throw
 *   fails.
 * - `choices`: a refusal naming the choices, then the first choice passes. A refusal without
 *   choices is inconclusive.
 * - `refusal_or_empty`: an input refusal or an empty result; a throw fails.
 */
export type ControlCaseExpectation = "result" | "empty_or_choices" | "choices" | "refusal_or_empty";

/** A second run the host makes from the first one's output. */
export interface ControlCaseFollowUp {
  readonly kind: "next_page";
  /** The input field that takes the cursor. */
  readonly inputField: string;
  /** The output field that returns it. */
  readonly outputField: string;
}

/**
 * Highest first: 0 is the base case; 1 a field the candidate's change touched; 2 a field in a
 * caller failure's signature; 3 a field whose last result failed or was inconclusive; 4 a field
 * never verified on this revision; 5 everything else.
 */
export type ControlCasePriority = 0 | 1 | 2 | 3 | 4 | 5;

export interface ControlCase {
  /**
   * Canonical JSON of the case's changes from the base case, keys sorted, such as
   * `{"sort":"price_asc"}`; `{}` for the base case. Values are schema values or host placeholders
   * (`$empty_probe`, `$next_page`, `$today+21d`), never a caller's or a page's value.
   */
  readonly key: string;
  readonly kind: ControlCaseKind;
  /** The input fields the case varies from the base case; empty for the base case. */
  readonly fields: readonly string[];
  /** The input the host runs. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly expect: ControlCaseExpectation;
  readonly followUp?: ControlCaseFollowUp;
  readonly priority: ControlCasePriority;
}

/** A case the budget left out, as coverage lists it ("not checked (budget)"). */
export interface ControlCaseCut {
  readonly key: string;
  readonly fields: readonly string[];
}

/** The fields each priority names; a host passes what it knows and omits the rest. */
export interface ControlCasePriorities {
  /** Input fields whose code the candidate changed from the published revision (priority 1). */
  readonly changedFields?: readonly string[];
  /** Input fields in the failing caller run's signature (priority 2). */
  readonly failureFields?: readonly string[];
  /** Input fields whose last stored result was a fail or inconclusive (priority 3). */
  readonly lastFailedFields?: readonly string[];
  /** Input fields never verified on this revision (priority 4). */
  readonly unverifiedFields?: readonly string[];
}

export interface ControlCasePlanOptions {
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  /** The injected clock: dates start 21 days after it. */
  readonly now: Date;
  /** The most cases the plan keeps; fields at priority 1 or 2 are never cut. 24 by default. */
  readonly budget?: number;
  readonly priorities?: ControlCasePriorities;
  /** Fields a run found the page offers choices for, which get the unoffered-value probe. */
  readonly pageChoiceFields?: readonly string[];
  /**
   * The empty probe's token. By default one derived from the schema and the clock's day, so a
   * baseline and a candidate checked the same day run the same token.
   */
  readonly emptyProbeToken?: string;
}

export type ControlCasePlanResult =
  /** Fields with no `examples` the generator could not otherwise fill: `input_examples_missing`. */
  | { readonly status: "examples_missing"; readonly fields: readonly string[] }
  | {
      readonly status: "planned";
      readonly cases: readonly ControlCase[];
      readonly notChecked: readonly ControlCaseCut[];
    };

/** What a host's `runControlCases` runs: the plan for one entrypoint. */
export interface ControlCheckPlan {
  readonly entrypoint: string;
  readonly cases: readonly ControlCase[];
  readonly notChecked: readonly ControlCaseCut[];
}

/** The default number of cases a check run keeps. */
export const defaultControlCaseBudget = 24;
/** The sentinel the unoffered-value probe sends. */
export const unofferedValue = "__unoffered__";
/** How many days after the clock generated dates start. */
const dateLeadDays = 21;
/** A limit's maximum is checked only up to this many items. */
const largestCheckedLimit = 50;
/** An enum with at most this many members runs every member. */
const allMembersUpTo = 6;

type Input = Readonly<Record<string, unknown>>;
type Schema = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A schema with a local `$ref` replaced by its definition, siblings kept over it. */
const resolved = (schema: unknown, root: Schema): Schema => {
  if (!isRecord(schema)) return {};
  const reference = schema["$ref"];
  if (typeof reference !== "string" || !reference.startsWith("#/")) return schema;
  const target = reference
    .slice(2)
    .split("/")
    .reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), root);
  const { $ref: _, ...siblings } = schema;
  return { ...resolved(target, root), ...siblings };
};

/** The non-null branches of a schema; a single one for a schema that is not a union. */
const branchesOf = (schema: Schema, root: Schema): readonly Schema[] => {
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (!Array.isArray(union)) return [schema];
  return union
    .map((branch) => resolved(branch, root))
    .flatMap((branch) => branchesOf(branch, root))
    .filter((branch) => branch["type"] !== "null");
};

/** A branch that admits exactly the values it lists. */
const membersOf = (branch: Schema): readonly unknown[] | undefined =>
  Array.isArray(branch["enum"])
    ? branch["enum"]
    : "const" in branch
      ? [branch["const"]]
      : undefined;

const typeOf = (branch: Schema) => {
  const type = branch["type"];
  return typeof type === "string"
    ? type
    : Array.isArray(type)
      ? type.find((entry) => entry !== "null")
      : undefined;
};

/** Whether a value fits a branch, by its type and listed members only. */
const fits = (value: unknown, branch: Schema): boolean => {
  const members = membersOf(branch);
  if (members !== undefined) return members.some((member) => canonical(member) === canonical(value));
  switch (typeOf(branch)) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return true;
  }
};

/** JSON with object keys sorted, so equal values have equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry,
  );

const datePattern = /^\d{4}-\d{2}-\d{2}/u;
const searchName = /^(?:q|query|search|search_?term|keywords?|terms?|text)$/iu;
const cursorName = /cursor|page_?token|next_?page/iu;
const limitName = /^(?:limit|max_?results|page_?size|per_?page)$/iu;
/** Description text that marks a string as one of the page's own choices. */
const pageChoiceText =
  /\b(?:as|that) the (?:site|page) (?:shows|offers|lists|labels)\b|\b(?:site|page)'s (?:options?|choices?)\b/iu;
/** Paired range names: the minimum's name, then the maximum's. */
const rangeNames = (name: string): readonly string[] => {
  const pairs: readonly (readonly [RegExp, string])[] = [
    [/^min_(.+)$/u, "max_$1"],
    [/^(.+)_min$/u, "$1_max"],
    [/^min([A-Z].*)$/u, "max$1"],
    [/^(.+)_from$/u, "$1_to"],
    [/^low_(.+)$/u, "high_$1"],
  ];
  return pairs.filter(([pattern]) => pattern.test(name)).map(([pattern, max]) =>
    name.replace(pattern, max),
  );
};

type FieldKind = "enum" | "boolean" | "integer" | "number" | "date" | "union" | "cursor" | "other";

interface Field {
  readonly name: string;
  readonly required: boolean;
  readonly kind: FieldKind;
  readonly schema: Schema;
  readonly branches: readonly Schema[];
  readonly examples: readonly unknown[];
  readonly members: readonly unknown[];
  readonly dateTime: boolean;
}

const fieldOf = (name: string, raw: unknown, required: boolean, root: Schema): Field => {
  const schema = resolved(raw, root);
  const branches = branchesOf(schema, root);
  const examples = Array.isArray(schema["examples"])
    ? schema["examples"]
    : "example" in schema
      ? [schema["example"]]
      : [];
  const memberLists = branches.map(membersOf);
  const members = memberLists.every((list) => list !== undefined) ? memberLists.flat() : [];
  const only = branches.length === 1 ? branches[0] : undefined;
  const type = only === undefined ? undefined : typeOf(only);
  const format = only?.["format"];
  const description = typeof schema["description"] === "string" ? schema["description"] : "";
  const dateLike =
    type === "string" &&
    (format === "date" ||
      format === "date-time" ||
      (typeof examples[0] === "string" && datePattern.test(examples[0])) ||
      /\bYYYY-MM-DD\b/u.test(description));
  const kind: FieldKind =
    members.length > 0
      ? "enum"
      : branches.length > 1
        ? "union"
        : type === "boolean"
          ? "boolean"
          : type === "integer"
            ? "integer"
            : type === "number"
              ? "number"
              : dateLike
                ? "date"
                : type === "string" && cursorName.test(name)
                  ? "cursor"
                  : "other";
  return {
    name,
    required,
    kind,
    schema: only === undefined ? schema : { ...only, ...schema },
    branches,
    examples,
    members,
    dateTime: format === "date-time",
  };
};

const isoDay = (now: Date, days: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
const dayText = (day: Date, dateTime: boolean) => {
  const text = day.toISOString();
  return dateTime ? `${text.slice(0, 10)}T12:00:00Z` : text.slice(0, 10);
};
const daysBetween = (from: unknown, to: unknown) => {
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const span = (Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000;
  return Number.isFinite(span) && span >= 1 ? Math.round(span) : undefined;
};

/** A value for one union branch: an example that fits it, else one its schema settles. */
const branchValue = (field: Field, branch: Schema): { readonly value: unknown } | undefined => {
  const example = field.examples.find((candidate) => fits(candidate, branch));
  if (example !== undefined) return { value: example };
  const members = membersOf(branch);
  if (members !== undefined && members.length > 0) return { value: members[0] };
  if (typeOf(branch) === "boolean") return { value: true };
  const minimum = branch["minimum"];
  if ((typeOf(branch) === "integer" || typeOf(branch) === "number") && typeof minimum === "number")
    return { value: minimum };
  return undefined;
};

/** The value a field takes when a case sets it on its own: its first example or member. */
const firstValue = (field: Field): { readonly value: unknown } | undefined => {
  if (field.examples.length > 0) return { value: field.examples[0] };
  if (field.kind === "enum") return { value: field.members[0] };
  if (field.kind === "boolean") return { value: field.schema["default"] !== true };
  if (field.kind === "union")
    for (const branch of field.branches) {
      const value = branchValue(field, branch);
      if (value !== undefined) return value;
    }
  return undefined;
};

/** The day each date field takes, starting 21 days after the clock and keeping their order. */
const dateOffsets = (dates: readonly Field[]) => {
  const offsets = new Map<string, number>();
  let offset = dateLeadDays;
  dates.forEach((field, index) => {
    if (index > 0) offset += daysBetween(dates[index - 1]?.examples[0], field.examples[0]) ?? 1;
    offsets.set(field.name, offset);
  });
  return offsets;
};

/** The default token for the empty probe: base32 of the schema and the clock's day. */
const defaultToken = (inputSchema: unknown, now: Date) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const digest = createHash("sha256")
    .update(`${canonical(inputSchema)}\n${now.toISOString().slice(0, 10)}`)
    .digest();
  return `zq-${[...digest.subarray(0, 8)].map((byte) => alphabet[byte % 32]).join("")}-xv`;
};

/** The case plan for a schema; see the module comment and `ControlCasePlanOptions`. */
export const controlCasePlan = (options: ControlCasePlanOptions): ControlCasePlanResult => {
  const root = isRecord(options.inputSchema) ? options.inputSchema : {};
  const schema = resolved(root, root);
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((name): name is string => typeof name === "string")
      : [],
  );
  const fields = Object.entries(properties).map(([name, raw]) =>
    fieldOf(name, raw, required.has(name), root),
  );
  // Dates come from the clock, a cursor from the site, and an enum or boolean from the schema;
  // every other field needs an example to build its cases from.
  const missing = fields.filter(
    (field) =>
      field.kind !== "date" &&
      field.kind !== "cursor" &&
      field.kind !== "enum" &&
      field.kind !== "boolean" &&
      field.examples.length === 0 &&
      (field.kind !== "union" || firstValue(field) === undefined),
  );
  if (missing.length > 0)
    return { status: "examples_missing", fields: missing.map(({ name }) => name) };

  const dates = fields.filter((field) => field.kind === "date");
  const offsets = dateOffsets(dates);
  const dateValue = (field: Field) =>
    dayText(isoDay(options.now, offsets.get(field.name) ?? dateLeadDays), field.dateTime);
  const datePlaceholder = (field: Field) => `$today+${offsets.get(field.name) ?? dateLeadDays}d`;

  const base: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.required || field.kind === "cursor") continue;
    if (field.kind === "date") base[field.name] = dateValue(field);
    else {
      const value = firstValue(field);
      if (value !== undefined) base[field.name] = value.value;
    }
  }

  type Draft = Omit<ControlCase, "key" | "priority"> & {
    /** The key's values where they differ from the input's, such as a date's placeholder. */
    readonly keyed?: Input;
  };
  const drafts: Draft[] = [{ kind: "base", fields: [], input: base, expect: "result" }];
  const set = (
    kind: ControlCaseKind,
    changes: Input,
    extra: Partial<Pick<Draft, "expect" | "followUp" | "keyed">> = {},
  ) =>
    drafts.push({
      kind,
      fields: Object.keys(changes),
      input: { ...base, ...changes },
      expect: extra.expect ?? "result",
      ...(extra.followUp === undefined ? {} : { followUp: extra.followUp }),
      ...(extra.keyed === undefined ? {} : { keyed: extra.keyed }),
    });

  // One field at a time.
  for (const field of fields) {
    const { name } = field;
    if (field.kind === "date" || field.kind === "cursor") continue;
    if (field.kind === "enum") {
      const { members } = field;
      const picked =
        members.length <= allMembersUpTo
          ? members
          : [
              ...field.examples.slice(0, 1),
              members[0],
              members[Math.floor((members.length - 1) / 2)],
              members.at(-1),
            ];
      for (const member of picked) set("field", { [name]: member });
    } else if (field.kind === "boolean") {
      const current = field.required ? base[name] : field.schema["default"] === true;
      set("field", { [name]: current !== true });
    } else if (field.kind === "union") {
      for (const branch of field.branches) {
        const value = branchValue(field, branch);
        if (value !== undefined) set("field", { [name]: value.value });
      }
    } else {
      for (const example of field.examples.slice(0, 2)) set("field", { [name]: example });
      const minimum = field.schema["minimum"];
      if (field.kind === "integer" && typeof minimum === "number")
        set("field", { [name]: minimum });
    }
  }

  // Boundaries: declared minimums and maximums, and a limit's maximum only up to 50.
  for (const field of fields) {
    if (field.kind !== "integer" && field.kind !== "number") continue;
    const { minimum, maximum } = field.schema;
    if (typeof minimum === "number") set("boundary", { [field.name]: minimum });
    if (
      typeof maximum === "number" &&
      (!limitName.test(field.name) || maximum <= largestCheckedLimit)
    )
      set("boundary", { [field.name]: maximum });
  }

  // Inverted ranges: a minimum above its maximum expects a refusal or an empty result.
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const low of fields) {
    if (low.kind !== "integer" && low.kind !== "number") continue;
    for (const highName of rangeNames(low.name)) {
      const high = byName.get(highName);
      if (high === undefined || (high.kind !== "integer" && high.kind !== "number")) continue;
      const values = [
        ...low.examples,
        ...high.examples,
        low.schema["minimum"],
        high.schema["maximum"],
      ].filter((value): value is number => typeof value === "number");
      const smallest = Math.min(...values);
      const largest = Math.max(...values);
      if (values.length < 2 || smallest === largest) continue;
      set(
        "inverted_range",
        { [low.name]: largest, [high.name]: smallest },
        { expect: "refusal_or_empty" },
      );
    }
  }

  // Dates, in order from the clock; a required date is already in the base case.
  const optionalDates = dates.filter((field) => !field.required);
  if (optionalDates.length > 0)
    set(
      "dates",
      Object.fromEntries(dates.map((field) => [field.name, dateValue(field)])),
      { keyed: Object.fromEntries(dates.map((field) => [field.name, datePlaceholder(field)])) },
    );
  for (const field of dates) {
    const latest = field.schema["formatMaximum"];
    if (typeof latest === "string" && datePattern.test(latest))
      set("dates", { [field.name]: latest.slice(0, 10) });
  }

  // Paging, when the input takes the cursor the output returns.
  const outputRoot = isRecord(options.outputSchema) ? options.outputSchema : {};
  const output = resolved(outputRoot, outputRoot);
  const outputCursor = Object.keys(isRecord(output["properties"]) ? output["properties"] : {}).find(
    (name) => cursorName.test(name),
  );
  const inputCursor = fields.find((field) => field.kind === "cursor");
  if (inputCursor !== undefined && outputCursor !== undefined)
    drafts.push({
      kind: "paging",
      fields: [inputCursor.name],
      input: base,
      expect: "result",
      followUp: { kind: "next_page", inputField: inputCursor.name, outputField: outputCursor },
      keyed: { [inputCursor.name]: "$next_page" },
    });

  // Every optional field at once.
  const optional = fields.filter((field) => !field.required && field.kind !== "cursor");
  if (optional.length >= 2) {
    const changes: Record<string, unknown> = {};
    const keyed: Record<string, unknown> = {};
    for (const field of optional) {
      if (field.kind === "date") {
        changes[field.name] = dateValue(field);
        keyed[field.name] = datePlaceholder(field);
      } else {
        const value =
          field.kind === "boolean"
            ? { value: field.schema["default"] !== true }
            : firstValue(field);
        if (value !== undefined) changes[field.name] = keyed[field.name] = value.value;
      }
    }
    set("all_together", changes, { keyed });
  }

  // The empty probe on a search's free-text field.
  const search = fields.find(
    (field) => field.kind === "other" && typeOf(field.schema) === "string" && searchName.test(field.name),
  );
  if (search !== undefined)
    set(
      "empty_probe",
      { [search.name]: options.emptyProbeToken ?? defaultToken(options.inputSchema, options.now) },
      { expect: "empty_or_choices", keyed: { [search.name]: "$empty_probe" } },
    );

  // The unoffered-value probe on a field whose values are the page's own choices.
  const pageChoices = new Set(options.pageChoiceFields ?? []);
  for (const field of fields) {
    if (field.kind !== "other" || typeOf(field.schema) !== "string" || field === search) continue;
    const description =
      typeof field.schema["description"] === "string" ? field.schema["description"] : "";
    if (pageChoices.has(field.name) || pageChoiceText.test(description))
      set("unoffered_probe", { [field.name]: unofferedValue }, { expect: "choices" });
  }

  // Keys, without repeats: a case that runs the same input as an earlier one is dropped.
  const seen = new Set<string>();
  const cases: Omit<ControlCase, "priority">[] = [];
  for (const { keyed, ...draft } of drafts) {
    const key = canonical(
      Object.fromEntries(
        draft.fields.map((name) => [name, keyed?.[name] ?? draft.input[name]] as const),
      ),
    );
    const identity = `${canonical(draft.input)}|${draft.followUp === undefined ? "" : "page"}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    cases.push({ ...draft, key });
  }

  // Priorities, then the budget: fields at priority 1 or 2 are never cut.
  const { priorities = {} } = options;
  const rank = (field: string): ControlCasePriority =>
    priorities.changedFields?.includes(field) === true
      ? 1
      : priorities.failureFields?.includes(field) === true
        ? 2
        : priorities.lastFailedFields?.includes(field) === true
          ? 3
          : priorities.unverifiedFields?.includes(field) === true
            ? 4
            : 5;
  const ranked = cases
    .map((entry): ControlCase => ({
      ...entry,
      priority:
        entry.kind === "base"
          ? 0
          : (Math.min(...entry.fields.map(rank), 5) as ControlCasePriority),
    }))
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.priority - right.entry.priority || left.index - right.index)
    .map(({ entry }) => entry);
  const budget = options.budget ?? defaultControlCaseBudget;
  const kept: ControlCase[] = [];
  const notChecked: ControlCaseCut[] = [];
  for (const entry of ranked)
    if (entry.priority <= 2 || kept.length < budget) kept.push(entry);
    else notChecked.push({ key: entry.key, fields: entry.fields });
  return { status: "planned", cases: kept, notChecked };
};
