import { createHash } from "node:crypto";
import { Clock, Effect, Either, Schema } from "effect";

/**
 * Live tests of a read: the cases the minting agent plans in `test/cases.json`, the checklist the
 * host derives from the tool's input and output schemas, each case's verdict, and the record the
 * publication review reads. Pure, except `runLiveTestCase`, which a host calls once per case.
 *
 * The agent writes the cases with real values the site offers and labels each with the checklist
 * items it covers. The host runs a batch after one Guardian review, each case on a fresh page,
 * in parallel browsers where the host has them, and the agent sees every result. Nothing here
 * blocks publication: the publication review reads the record and judges what is missing,
 * failing or stale.
 */

/** Where the agent writes its cases. */
export const liveTestCasesPath = "test/cases.json";
/** Where the host writes the record of its live tests for the publication review. */
export const liveTestsEvidencePath = "publication/tests.json";
/** The most cases one batch runs: a payload bound, not a limit on testing. */
export const maximumBatchCases = 50;
/** How many passing repeat cases the example's input needs. */
export const repeatRuns = 3;

type Json = Readonly<Record<string, unknown>>;
type Input = Readonly<Record<string, unknown>>;

const CaseId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u));
const ItemId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120));
const Reason = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(600));

/** What a case expects the tool to do. */
export const LiveTestExpectation = Schema.Literal("result", "empty", "invalid_input", "error");
export type LiveTestExpectation = typeof LiveTestExpectation.Type;

/** One case the agent planned. */
export const LiveTestCase = Schema.Struct({
  id: CaseId,
  /** The checklist items this case covers, such as `input:sort` or `repeat_example`. */
  covers: Schema.Array(ItemId).pipe(Schema.maxItems(20)),
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  expect: LiveTestExpectation,
  /** Run page 1, then the next page through the cursor page 1 returned. */
  next_page: Schema.optionalWith(Schema.Boolean, { exact: true }),
  note: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(600)), { exact: true }),
});
export type LiveTestCase = typeof LiveTestCase.Type;

/** A checklist item the agent did not test, with why. */
export const LiveTestSkip = Schema.Struct({
  item: ItemId,
  status: Schema.Literal("not_applicable", "declined"),
  reason: Reason,
});
export type LiveTestSkip = typeof LiveTestSkip.Type;

export const LiveTestCasesFile = Schema.Struct({
  cases: Schema.Array(LiveTestCase).pipe(Schema.maxItems(200)),
  skipped: Schema.optionalWith(Schema.Array(LiveTestSkip).pipe(Schema.maxItems(100)), {
    exact: true,
  }),
});
export type LiveTestCasesFile = typeof LiveTestCasesFile.Type;

/** The agent's cases file, or why it cannot be used. */
export const decodeCasesFile = (
  text: string | undefined,
): Either.Either<LiveTestCasesFile, string> => {
  if (text === undefined) return Either.right({ cases: [] });
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(LiveTestCasesFile))(text, {
    errors: "first",
  });
  if (Either.isLeft(decoded))
    return Either.left(
      `${liveTestCasesPath} is not a valid cases file: ${decoded.left.message.slice(0, 600)}`,
    );
  const seen = new Set<string>();
  for (const { id } of decoded.right.cases) {
    if (seen.has(id)) return Either.left(`${liveTestCasesPath} lists case id ${id} twice.`);
    seen.add(id);
  }
  return Either.right(decoded.right);
};

// ---------------------------------------------------------------------------------------------
// The checklist, from the tool's schemas.

/** The input field that takes a cursor and the output field that returns it. */
export interface CursorPair {
  readonly inputField: string;
  readonly outputField: string;
}

/** One thing the cases must cover, or say why not. */
export interface ChecklistItem {
  readonly item: string;
  /** What a case covering it does. */
  readonly hint: string;
  /** How many passing cases it needs. */
  readonly needs: number;
  /** The cases must expect this; any expectation when absent. */
  readonly expect?: LiveTestExpectation;
  /** A case covering it sets this input field. */
  readonly field?: string;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A schema with a local `$ref` replaced by its definition, siblings kept over it. */
const resolved = (schema: unknown, root: Json): Json => {
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
const branchesOf = (schema: Json, root: Json): readonly Json[] => {
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (!Array.isArray(union)) return [schema];
  return union
    .map((branch) => resolved(branch, root))
    .flatMap((branch) => branchesOf(branch, root))
    .filter((branch) => branch["type"] !== "null");
};

/** A branch that admits exactly the values it lists. */
const membersOf = (branch: Json): readonly unknown[] | undefined =>
  Array.isArray(branch["enum"])
    ? branch["enum"]
    : "const" in branch
      ? [branch["const"]]
      : undefined;

const typeOf = (branch: Json) => {
  const type = branch["type"];
  return typeof type === "string"
    ? type
    : Array.isArray(type)
      ? type.find((entry) => entry !== "null")
      : undefined;
};

interface Field {
  readonly name: string;
  readonly required: boolean;
  readonly types: readonly string[];
  readonly members: readonly unknown[] | undefined;
  readonly text: string;
}

/** An object schema's properties, its local references resolved. */
const objectFields = (raw: unknown): readonly Field[] => {
  if (!isRecord(raw)) return [];
  const root = raw;
  const schema = branchesOf(resolved(raw, root), root).find((branch) =>
    isRecord(branch["properties"]),
  );
  const properties = schema?.["properties"];
  if (schema === undefined || !isRecord(properties)) return [];
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((name) => typeof name === "string")
      : [],
  );
  return Object.entries(properties).map(([name, property]) => {
    const field = resolved(property, root);
    const branches = branchesOf(field, root);
    const memberLists = branches.map(membersOf);
    const text = [field["title"], field["description"]]
      .filter((part) => typeof part === "string")
      .join(" ");
    return {
      name,
      required: required.has(name),
      types: branches.map((branch) => typeOf(branch) ?? "any"),
      members: memberLists.every((list) => list !== undefined) ? memberLists.flat() : undefined,
      text,
    };
  });
};

const cursorInputName = /^(?:cursor|page_?token|next_?cursor|continuation(?:_?token)?)$/iu;
const cursorOutputName =
  /^(?:next_?cursor|cursor|next_?page_?token|page_?token|continuation(?:_?token)?)$/iu;
const scalarCursor = (field: Field) =>
  field.types.length > 0 &&
  field.types.every((type) => type === "string" || type === "integer" || type === "number");

/**
 * The cursor a paged list takes and returns: string or number fields only, so a boolean such as
 * `has_next_page` is never read as one.
 */
export const cursorPairOf = (inputSchema: unknown, outputSchema: unknown): CursorPair | undefined => {
  const input = objectFields(inputSchema).find(
    (field) => cursorInputName.test(field.name) && scalarCursor(field),
  );
  const outputs = objectFields(outputSchema).filter(
    (field) => cursorOutputName.test(field.name) && scalarCursor(field),
  );
  const output =
    outputs.find((field) => /next/iu.test(field.name)) ?? outputs.find(() => true);
  return input === undefined || output === undefined
    ? undefined
    : { inputField: input.name, outputField: output.name };
};

const freeTextName = /^(?:q|query|search|search_?term|keywords?|terms?|text)$/iu;
const recordName =
  /(?:^|_)(?:url|link|href|id|sku|slug|asin|listing|product|item|record|code|handle)(?:$|_)/iu;
const selectorName =
  /(?:^|_)(?:retailer|store|seller|merchant|vendor|marketplace|market|region|site|shop|warehouse|branch)(?:$|_)/iu;
const locationName =
  /(?:^|_)(?:zip|zipcode|postal|postcode|post_?code|location|address|city|lat|latitude|lng|lon|longitude|geo|near|area|delivery)(?:$|_)/iu;
const locationText = /\b(?:zip|postal|post code|postcode|location|address|deliver)/iu;
/** Words split from a name such as `zipCode` or `store_id`. */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();

const listFields = (outputSchema: unknown) =>
  objectFields(outputSchema).filter((field) => field.types.includes("array"));

const fieldHint = (field: Field) => {
  if (field.types.includes("boolean"))
    return `Set ${field.name} to its non-default side, and read back that the page applied it.`;
  const members = field.members;
  if (members !== undefined && members.length > 0)
    return members.length <= 6
      ? `Run each of ${field.name}'s ${members.length} values, and read back that the page applied it.`
      : `Run three of ${field.name}'s values spread across its list, and read back that the page applied each.`;
  return `Set ${field.name} to a value the site offers that differs from the example's, and read back that the page applied it.`;
};

const fieldNeeds = (field: Field) => {
  const members = field.members;
  if (field.types.includes("boolean") || members === undefined || members.length === 0) return 1;
  return Math.min(members.length, members.length <= 6 ? 6 : 3);
};

/**
 * The checklist for a read with these schemas. Item ids are stable: `repeat_example`,
 * `input:<field>`, `all_inputs`, `combination`, `unoffered_value`, `no_results`, `next_page`,
 * `other_record`, `other_value:<field>`, `location_applied` and `location_impossible`.
 */
export const checklistOf = (inputSchema: unknown, outputSchema: unknown): readonly ChecklistItem[] => {
  const fields = objectFields(inputSchema);
  const cursor = cursorPairOf(inputSchema, outputSchema);
  const controls = fields.filter((field) => field.name !== cursor?.inputField);
  const optional = controls.filter((field) => !field.required);
  const lists = listFields(outputSchema);
  const items: ChecklistItem[] = [
    {
      item: "repeat_example",
      hint: `Run the example's input ${repeatRuns} times or more, each from a fresh browser. A run that fails or needs a retry is missing a wait: fix the wait, not the retry.`,
      needs: repeatRuns,
      expect: "result",
    },
  ];
  for (const field of controls)
    items.push({
      item: `input:${field.name}`,
      hint: fieldHint(field),
      needs: fieldNeeds(field),
      field: field.name,
    });
  if (optional.length >= 2)
    items.push({
      item: "all_inputs",
      hint: "Set every optional input in one case, to catch controls that undo or hide each other.",
      needs: 1,
      expect: "result",
    });
  if (optional.length >= 3)
    items.push({
      item: "combination",
      hint: "Pair two or more controls that share a panel, a drawer or a page reload, other than the all-inputs case.",
      needs: 1,
    });
  if (controls.some((field) => !freeTextName.test(field.name) && !field.types.includes("boolean")))
    items.push({
      item: "unoffered_value",
      hint: "Send a value the site does not offer for a choice (a size, store, option or date it lacks). The tool must refuse with InvalidInput listing the page's choices, never pick another value.",
      needs: 1,
      expect: "invalid_input",
    });
  if (lists.length > 0)
    items.push({
      item: "no_results",
      hint: "A query or filter set the site has no results for. The tool returns an empty list, never a throw.",
      needs: 1,
      expect: "empty",
    });
  if (cursor !== undefined)
    items.push({
      item: "next_page",
      hint: `Run a case with next_page true: the host runs page 1, then page 2 through ${cursor.outputField}. Page 2 must hold different results.`,
      needs: 1,
      expect: "result",
    });
  if (lists.length === 0 && controls.some((field) => recordName.test(words(field.name))))
    items.push({
      item: "other_record",
      hint: "Read two or more other records, picked from a listing you opened, whose pages differ from the example's: other options, a single option, a grouped or multi-item page, sold out or unavailable, another layout or type.",
      needs: 2,
      expect: "result",
    });
  for (const field of controls.filter((entry) => selectorName.test(words(entry.name))))
    items.push({
      item: `other_value:${field.name}`,
      hint: `Run a second ${field.name} the site offers, unlike the example's, end to end: its pages may be laid out or worded differently.`,
      needs: 1,
      expect: "result",
      field: field.name,
    });
  if (
    controls.some(
      (field) => locationName.test(words(field.name)) || locationText.test(field.text),
    )
  )
    items.push(
      {
        item: "location_applied",
        hint: "Run another location and read back from the page that it applied.",
        needs: 1,
        expect: "result",
      },
      {
        item: "location_impossible",
        hint: "Run a location the site cannot apply. The tool must fail loudly, never return results for another place.",
        needs: 1,
        expect: "error",
      },
    );
  return items;
};

// ---------------------------------------------------------------------------------------------
// Running a case, and its verdict.

/** One case as a host runs it. */
export interface LiveTestBatchCase {
  readonly id: string;
  readonly input: Input;
  /** Present when the case also runs the next page. */
  readonly nextPage?: CursorPair;
}

export type LiveTestInconclusiveReason =
  /** The site challenged the browser and the host stopped the case. */
  | "challenge"
  /** The browser or the host failed, not the tool. */
  | "host"
  /** The batch's deadline came before the case could run. */
  | "deadline"
  /** The script asked a question, which nobody answers during a test. */
  | "asked"
  /** Page 1 returned no cursor, so there was no next page to run. */
  | "no_next_page";

/** What one run of a case's input showed. Outputs stay with the host until judged. */
export type LiveTestOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  | {
      readonly status: "invalid_input";
      readonly message?: string;
      readonly field?: string;
      readonly available?: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly errorClass: string;
      readonly message?: string;
      /** The authored source line that threw, such as `src/tool.mjs:88`. */
      readonly frame?: string;
    }
  | { readonly status: "inconclusive"; readonly reason: LiveTestInconclusiveReason };

/** One case's runs, as a host returns them. */
export interface LiveTestCaseRun {
  readonly id: string;
  readonly outcome: LiveTestOutcome;
  /** The next page's run, for a `next_page` case whose page 1 completed. */
  readonly followUp?: LiveTestOutcome;
  readonly durationMs: number;
  /** Which of the batch's browsers ran it: 0 is the build's own. */
  readonly lane?: number;
}

/** Runs one case and, for a `next_page` case, its next page, through a host's `run`. */
export const runLiveTestCase = <E, R>(
  testCase: LiveTestBatchCase,
  run: (input: Input) => Effect.Effect<LiveTestOutcome, E, R>,
): Effect.Effect<LiveTestCaseRun, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const outcome = yield* run(testCase.input);
    const { nextPage } = testCase;
    let followUp: LiveTestOutcome | undefined;
    if (nextPage !== undefined && outcome.status === "completed") {
      const cursor = isRecord(outcome.output) ? outcome.output[nextPage.outputField] : undefined;
      followUp =
        cursor === undefined || cursor === null || cursor === ""
          ? { status: "inconclusive", reason: "no_next_page" }
          : yield* run({ ...testCase.input, [nextPage.inputField]: cursor });
    }
    const ended = yield* Clock.currentTimeMillis;
    return {
      id: testCase.id,
      outcome,
      ...(followUp === undefined ? {} : { followUp }),
      durationMs: ended - started,
    };
  });

export type LiveTestVerdict = "pass" | "fail" | "inconclusive";

export interface JudgedCase {
  readonly verdict: LiveTestVerdict;
  /** What the run did, in a few words: `results (12)`, `empty`, `InvalidInput`, `TimeoutError`. */
  readonly got: string;
  /** Why it failed or was inconclusive, or a note on a pass. */
  readonly detail?: string;
  readonly errorClass?: string;
  readonly message?: string;
  readonly frame?: string;
  readonly refusal?: { readonly field?: string; readonly available?: readonly string[] };
  /** The output the verdict judged, for an excerpt; absent when the run returned none. */
  readonly output?: unknown;
}

/** The lists an output holds: its own top-level arrays, or itself when it is one. */
const listsOf = (output: unknown): readonly (readonly unknown[])[] =>
  Array.isArray(output)
    ? [output]
    : isRecord(output)
      ? Object.values(output).filter((value): value is unknown[] => Array.isArray(value))
      : [];

const resultShape = (output: unknown) => {
  const lists = listsOf(output);
  if (output === null || output === undefined) return { empty: true, got: "no output" };
  if (lists.length === 0) return { empty: false, got: "a result" };
  const count = Math.max(...lists.map((list) => list.length));
  return count === 0
    ? { empty: true, got: "empty" }
    : { empty: false, got: `results (${count})` };
};

const inconclusiveDetail: Readonly<Record<LiveTestInconclusiveReason, string>> = {
  challenge: "The site challenged this browser; the host stopped the case. It does not count against the tool.",
  host: "The browser or the host failed, not the tool. Run the case again.",
  deadline: "The batch ran out of time before this case ran. Run it again.",
  asked: "The script asked a question, which nobody answers during a test. A read that needs an answer from its caller declares the question; run cases that do not need one.",
  no_next_page: "Page 1 returned no cursor, so the host could not run a next page. Use a query with more than one page of results, or fix how the tool returns its cursor.",
};

/** A case's verdict from its runs and what it expected. */
export const judgeCase = (testCase: Pick<LiveTestCase, "expect">, run: LiveTestCaseRun): JudgedCase => {
  const outcome =
    run.outcome.status === "completed" && run.followUp !== undefined ? run.followUp : run.outcome;
  const page = run.followUp !== undefined && outcome === run.followUp ? "Page 2: " : "";
  switch (outcome.status) {
    case "inconclusive":
      return {
        verdict: "inconclusive",
        got: outcome.reason,
        detail: `${page}${inconclusiveDetail[outcome.reason]}`,
      };
    case "completed": {
      const shape = resultShape(outcome.output);
      const base = { got: shape.got, output: outcome.output };
      if (testCase.expect === "result")
        return shape.empty
          ? { ...base, verdict: "fail", detail: `${page}Expected results, but the output's lists are empty.` }
          : { ...base, verdict: "pass" };
      if (testCase.expect === "empty")
        return shape.empty
          ? { ...base, verdict: "pass" }
          : { ...base, verdict: "fail", detail: `${page}Expected no results, but the tool returned ${shape.got}.` };
      return {
        ...base,
        verdict: "fail",
        detail:
          testCase.expect === "invalid_input"
            ? `${page}Expected InvalidInput for a value the site does not offer, but the tool returned ${shape.got}. Never substitute another value.`
            : `${page}Expected a loud failure, but the tool returned ${shape.got}.`,
      };
    }
    case "invalid_input": {
      const refusal = {
        ...(outcome.field === undefined ? {} : { field: outcome.field }),
        ...(outcome.available === undefined ? {} : { available: outcome.available.slice(0, 20) }),
      };
      const base = {
        got: "InvalidInput",
        errorClass: "InvalidInput",
        ...(outcome.message === undefined ? {} : { message: outcome.message.slice(0, 600) }),
        ...(Object.keys(refusal).length === 0 ? {} : { refusal }),
      };
      if (testCase.expect === "invalid_input" || testCase.expect === "error")
        return {
          ...base,
          verdict: "pass",
          ...(outcome.available === undefined || outcome.available.length === 0
            ? { detail: "The refusal lists no choices (available). Where the page offers choices, list them." }
            : {}),
        };
      return {
        ...base,
        verdict: "fail",
        detail: `${page}The tool refused this input with InvalidInput. If the site offers this value, fix the code; never narrow the schema to pass.`,
      };
    }
    case "failed": {
      const base = {
        got: outcome.errorClass,
        errorClass: outcome.errorClass,
        ...(outcome.message === undefined ? {} : { message: outcome.message.slice(0, 600) }),
        ...(outcome.frame === undefined ? {} : { frame: outcome.frame }),
      };
      if (testCase.expect === "error" && !/timeout/iu.test(outcome.errorClass))
        return { ...base, verdict: "pass" };
      return {
        ...base,
        verdict: "fail",
        detail:
          testCase.expect === "error"
            ? `${page}The tool timed out instead of failing with a clear error.`
            : `${page}The tool threw ${outcome.errorClass}${outcome.frame === undefined ? "" : ` at ${outcome.frame}`}. Fix the code at that line.`,
      };
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Results the harness keeps, and what the agent and the publication review read.

/** JSON with object keys sorted, so equal values have equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry,
  );

/** A digest of what a case asks for, so an edited case's earlier result is stale. */
export const caseDigest = (testCase: LiveTestCase) =>
  createHash("sha256")
    .update(canonical([testCase.input, testCase.expect, testCase.next_page === true]))
    .digest("hex")
    .slice(0, 16);

/** One case's latest result, as the harness keeps it across a takeover. */
export interface LiveTestRecord {
  readonly id: string;
  readonly caseDigest: string;
  /** The digest of the source it ran. */
  readonly sourceDigest: string;
  readonly verdict: LiveTestVerdict;
  readonly got: string;
  readonly detail?: string;
  readonly errorClass?: string;
  readonly message?: string;
  readonly frame?: string;
  readonly refusal?: { readonly field?: string; readonly available?: readonly string[] };
  /** A short screened excerpt of the output. */
  readonly excerpt?: string;
  readonly durationMs: number;
  readonly lane?: number;
}

export const LiveTestRecord: Schema.Schema<LiveTestRecord> = Schema.Struct({
  id: Schema.String,
  caseDigest: Schema.String,
  sourceDigest: Schema.String,
  verdict: Schema.Literal("pass", "fail", "inconclusive"),
  got: Schema.String,
  detail: Schema.optionalWith(Schema.String, { exact: true }),
  errorClass: Schema.optionalWith(Schema.String, { exact: true }),
  message: Schema.optionalWith(Schema.String, { exact: true }),
  frame: Schema.optionalWith(Schema.String, { exact: true }),
  refusal: Schema.optionalWith(
    Schema.Struct({
      field: Schema.optionalWith(Schema.String, { exact: true }),
      available: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    }),
    { exact: true },
  ),
  excerpt: Schema.optionalWith(Schema.String, { exact: true }),
  durationMs: Schema.NonNegativeInt,
  lane: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
});

/** The first few items of an output, as compact text, for an excerpt. */
export const outputExcerpt = (output: unknown, limit = 600): string | undefined => {
  if (output === undefined) return undefined;
  const lists = listsOf(output);
  const shown =
    Array.isArray(output)
      ? output.slice(0, 2)
      : isRecord(output) && lists.length > 0
        ? Object.fromEntries(
            Object.entries(output).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.slice(0, 2) : value,
            ]),
          )
        : output;
  const text = JSON.stringify(shown) ?? "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

/** A case's status against the current source and the case as written now. */
export type CaseStatus = "not_run" | "stale" | LiveTestVerdict;

export const caseStatus = (
  testCase: LiveTestCase,
  record: LiveTestRecord | undefined,
  sourceDigest: string | undefined,
): CaseStatus => {
  if (record === undefined) return "not_run";
  if (record.caseDigest !== caseDigest(testCase) || record.sourceDigest !== sourceDigest)
    return "stale";
  return record.verdict;
};

export type ItemStatus =
  | "covered"
  | "failing"
  | "stale"
  | "not_run"
  | "inconclusive"
  | "missing"
  | "not_applicable"
  | "declined";

export interface ItemView {
  readonly item: string;
  readonly status: ItemStatus;
  readonly hint: string;
  readonly needs: number;
  readonly passing: number;
  readonly cases: readonly string[];
  readonly reason?: string;
  /** Cases that claim this item but do not fit it. */
  readonly mismatched?: readonly { readonly id: string; readonly why: string }[];
}

/** Why a case cannot cover an item, if it cannot. */
const mismatch = (item: ChecklistItem, testCase: LiveTestCase): string | undefined => {
  if (item.expect !== undefined && testCase.expect !== item.expect)
    return `${item.item} cases expect ${item.expect}`;
  if (item.field !== undefined && testCase.input[item.field] === undefined)
    return `the case does not set ${item.field}`;
  if (item.item === "next_page" && testCase.next_page !== true)
    return "the case does not set next_page";
  return undefined;
};

/** Each checklist item's status from the cases, their results and the current source. */
export const itemViews = (
  checklist: readonly ChecklistItem[],
  file: LiveTestCasesFile,
  records: ReadonlyMap<string, LiveTestRecord>,
  sourceDigest: string | undefined,
): readonly ItemView[] =>
  checklist.map((item) => {
    const skip = file.skipped?.find((entry) => entry.item === item.item);
    const claiming = file.cases.filter((testCase) => testCase.covers.includes(item.item));
    const mismatched = claiming.flatMap((testCase) => {
      const why = mismatch(item, testCase);
      return why === undefined ? [] : [{ id: testCase.id, why }];
    });
    const fitting = claiming.filter((testCase) => mismatch(item, testCase) === undefined);
    const statuses = fitting.map((testCase) =>
      caseStatus(testCase, records.get(testCase.id), sourceDigest),
    );
    const passing = statuses.filter((status) => status === "pass").length;
    const base = {
      item: item.item,
      hint: item.hint,
      needs: item.needs,
      passing,
      cases: claiming.map((testCase) => testCase.id),
      ...(mismatched.length === 0 ? {} : { mismatched }),
    };
    const status: ItemStatus =
      passing >= item.needs
        ? "covered"
        : statuses.includes("fail")
          ? "failing"
          : skip !== undefined && fitting.length === 0
            ? skip.status
            : statuses.includes("stale")
              ? "stale"
              : statuses.includes("inconclusive")
                ? "inconclusive"
                : statuses.includes("not_run")
                  ? "not_run"
                  : "missing";
    return {
      ...base,
      status,
      ...(skip !== undefined && (status === "not_applicable" || status === "declined")
        ? { reason: skip.reason }
        : {}),
    };
  });

/** One case as the agent and the publication review read it. */
export const caseView = (
  testCase: LiveTestCase,
  record: LiveTestRecord | undefined,
  sourceDigest: string | undefined,
) => {
  const status = caseStatus(testCase, record, sourceDigest);
  return {
    id: testCase.id,
    covers: testCase.covers,
    expect: testCase.expect,
    ...(testCase.next_page === true ? { next_page: true } : {}),
    status,
    ...(record === undefined
      ? {}
      : {
          ...(status === "stale"
            ? {
                lastVerdict: record.verdict,
                staleBecause:
                  record.caseDigest !== caseDigest(testCase)
                    ? "the case changed after it ran"
                    : "the source changed after it ran",
              }
            : {}),
          got: record.got,
          ...(record.detail === undefined ? {} : { detail: record.detail }),
          ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
          ...(record.message === undefined ? {} : { message: record.message }),
          ...(record.frame === undefined ? {} : { frame: record.frame }),
          ...(record.refusal === undefined ? {} : { refusal: record.refusal }),
          ...(record.excerpt === undefined ? {} : { excerpt: record.excerpt }),
          durationMs: record.durationMs,
          ...(record.lane === undefined ? {} : { lane: record.lane }),
        }),
  };
};

const tally = (statuses: readonly string[]) => {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
};

/**
 * The host's record of a read's live tests on the source it publishes, for the publication
 * review (`publication/tests.json`), and the line it adds to coverage. Undefined checklist means
 * the host could not read the tool's schemas.
 */
export const liveTestsEvidence = (options: {
  readonly checklist: readonly ChecklistItem[] | undefined;
  readonly file: LiveTestCasesFile;
  readonly fileProblem?: string;
  readonly records: ReadonlyMap<string, LiveTestRecord>;
  readonly sourceDigest: string | undefined;
}) => {
  const { checklist, file, records, sourceDigest } = options;
  const items = checklist === undefined ? [] : itemViews(checklist, file, records, sourceDigest);
  const cases = file.cases.map((testCase) => ({
    ...caseView(testCase, records.get(testCase.id), sourceDigest),
    input: testCase.input,
    ...(testCase.note === undefined ? {} : { note: testCase.note }),
  }));
  const itemCounts = tally(items.map((item) => item.status));
  const caseCounts = tally(cases.map((testCase) => testCase.status));
  const gaps = items.filter(
    (item) => item.status !== "covered" && item.status !== "not_applicable",
  );
  const summary = `Host live tests on the published source: ${cases.length} case${cases.length === 1 ? "" : "s"} (${
    Object.entries(caseCounts)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ") || "none run"
  }); checklist ${items.length - gaps.length} of ${items.length} items covered or not applicable${
    gaps.length === 0
      ? "."
      : `; open: ${gaps
          .slice(0, 12)
          .map((item) => `${item.item} (${item.status})`)
          .join(", ")}${gaps.length > 12 ? ", …" : ""}.`
  }${options.fileProblem === undefined ? "" : ` ${options.fileProblem}`}${
    checklist === undefined ? " The host could not read the tool's schemas, so it built no checklist." : ""
  }`;
  return {
    record: {
      kind: "host_live_tests",
      note: "Written by the host from its own runs, never by the minter. Each case ran on a fresh page after one Guardian review of its batch. status is against the source being published: stale means the source or the case changed after the case ran.",
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      ...(options.fileProblem === undefined ? {} : { casesFileProblem: options.fileProblem }),
      checklist: items,
      cases,
      counts: { items: itemCounts, cases: caseCounts },
    },
    coverage: summary,
  };
};
