/**
 * One deterministic check of a tool's output, shared by every place that looks at one: the
 * minter's tests, publication and hosted runs. It reads values only, never the page, and knows no
 * site: each finding names a field path (array positions folded to `[]`), a check, how many
 * values it matched and, when asked, one short sample.
 *
 * Some checks block publication (`blockingOutputChecks`): code, styles, markup and template
 * leftovers in a string are never what a page shows a person. The rest are flags for the reviewer:
 * a value read while collapsed or cut short, a field that never varies or is always empty,
 * repeated entries or records, very long strings, and one field that restates its siblings (a
 * whole card's text). A minter that returns one of these on purpose, such as a tool that returns
 * code, names the path and check with its reason as an override, and the reviewer sees both.
 */

export const outputChecks = [
  "script",
  "css",
  "markup",
  "template_residue",
  "json_text",
  "invisible_chars",
  "untrimmed",
  "too_long",
  "collapsed_text",
  "card_text",
  "duplicate_entries",
  "duplicate_records",
  "constant_field",
  "empty_field",
] as const;
export type OutputCheck = (typeof outputChecks)[number];

/** Checks that refuse publication unless the minter overrides them with a reason. */
export const blockingOutputChecks: ReadonlySet<OutputCheck> = new Set([
  "script",
  "css",
  "markup",
  "template_residue",
]);

export interface OutputFinding {
  /** The field, such as `results[].description`; `$` is the whole output. */
  readonly path: string;
  readonly check: OutputCheck;
  /** How many values matched: strings, records or, for a field check, 1. */
  readonly count: number;
  readonly blocking: boolean;
  /** One matched value, at most 80 characters; only when samples were asked for. */
  readonly sample?: string;
}

/** A minter's statement that a flagged value is intended, and why. */
export interface OutputOverride {
  readonly path: string;
  readonly check: OutputCheck;
  readonly reason: string;
}

export interface OutputLintOptions {
  /** The output's JSON Schema: `contentMediaType`, `maxLength` and `enum` adjust the checks. */
  readonly outputSchema?: unknown;
  /**
   * The accessible names of buttons and links on the page the output was read from. A value that
   * ends with one, or holds one on its own line, was read with the control's label in it: usually
   * collapsed text whose "more" control was never used.
   */
  readonly controlLabels?: readonly string[];
  /** Adds one short sample per finding. Off for telemetry, which never carries page text. */
  readonly samples?: boolean;
}

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sampleLength = 80;
/** A string in a list's record longer than this is flagged; anywhere else, `longValue`. */
const longRowValue = 1_000;
const longValue = 8_000;

const scriptPatterns: readonly RegExp[] = [
  /<script\b/iu,
  /\bfunction\s*[\w$]*\s*\([^()]*\)\s*\{/u,
  /\)\s*=>\s*\{/u,
  /\b(?:window|document)\.[A-Za-z_$][\w$]*\s*[.(=[]/u,
  /\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=/u,
];
/** Punctuation that code is dense in and prose is not. */
const codePunctuation = /[;{}()=]/gu;
const cssPatterns: readonly RegExp[] = [
  // A rule block: two or more declarations, or one ending in a semicolon, as prose never writes.
  /[^\s{};]\s*\{\s*[a-z-]+\s*:[^;{}]+(?:;\s*[a-z-]+\s*:[^;{}]+)*;\s*\}/u,
  /[^\s{};]\s*\{\s*[a-z-]+\s*:[^;{}]+(?:;\s*[a-z-]+\s*:[^;{}]+)+\}/u,
  /@media\b|@font-face\b|@keyframes\b|@import\b/u,
  /!important\b/u,
];
const cssDeclaration = /(?:^|[\s;{])[a-z-]+\s*:\s*[^;:{}\n]+;/gu;
const markupTag = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/u;
const entityResidue = /&(?:amp|nbsp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/iu;
const templateWhole = /^(?:undefined|null|NaN)$/u;
const templateParts: readonly RegExp[] = [
  /\[object Object\]/u,
  /\{\{[^{}]*\}\}/u,
  /\$\{[^{}]*\}/u,
  /(?:^|[\s:(,])undefined(?:$|[\s,.;)])/u,
];
// Zero-width characters and controls other than tab and newline.
// eslint-disable-next-line no-control-regex
const invisible = /[\u200B-\u200D\u2060\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const trailingEllipsis = /(?:\u2026|\.\.\.)\s*$/u;
/** A run of at least two words said twice in a row, such as a heading read from two copies. */
const repeatedRun = /(?:^|\s)(\S+(?:\s+\S+)+)\s+\1(?=$|\s)/u;

const sampleOf = (text: string) =>
  text.length <= sampleLength ? text : `${text.slice(0, sampleLength - 1)}\u2026`;

const normalizedLabel = (text: string) =>
  text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * The accessible names of the buttons and links in a Playwright accessibility snapshot (the YAML
 * `locator.ariaSnapshot()` returns), as `controlLabels` takes them. Names longer than six words
 * are left out: a link that long is content, such as a record's title, not a control.
 */
export const controlLabelsFromAriaSnapshot = (snapshot: string): string[] => {
  const labels = new Set<string>();
  for (const match of snapshot.matchAll(/^\s*-\s*(?:button|link)\s+"((?:[^"\\]|\\.)+)"/gmu)) {
    const label = (match[1] ?? "").replace(/\\(.)/gu, "$1").trim();
    if (label.length >= 2 && label.length <= 40 && label.split(/\s+/u).length <= 6)
      labels.add(label);
  }
  return [...labels];
};

/** The JSON Schema node for a path's value, following properties, items, local refs and unions. */
const schemaResolver = (root: unknown) => {
  const resolve = (node: unknown, depth = 0): Json | undefined => {
    if (!isRecord(node) || depth > 16) return undefined;
    const reference = node["$ref"];
    if (typeof reference === "string" && reference.startsWith("#/")) {
      let target: unknown = root;
      for (const part of reference.slice(2).split("/"))
        target = isRecord(target) ? target[part.replace(/~1/gu, "/").replace(/~0/gu, "~")] : undefined;
      return resolve(target, depth + 1);
    }
    return node;
  };
  const branches = (node: Json | undefined): Json[] => {
    if (node === undefined) return [];
    const union = [node["anyOf"], node["oneOf"], node["allOf"]].find(Array.isArray);
    return union === undefined
      ? [node]
      : union.flatMap((branch: unknown) => branches(resolve(branch)));
  };
  return {
    root: resolve(root),
    property: (node: Json | undefined, key: string) =>
      branches(node)
        .map((branch) => (isRecord(branch["properties"]) ? branch["properties"][key] : undefined))
        .map((child) => resolve(child))
        .find((child) => child !== undefined),
    items: (node: Json | undefined) =>
      branches(node)
        .map((branch) => resolve(branch["items"]))
        .find((child) => child !== undefined),
    annotation: (node: Json | undefined, key: string): unknown =>
      branches(node)
        .map((branch) => branch[key])
        .find((value) => value !== undefined),
  };
};

const looksLikeScript = (text: string) => {
  if (scriptPatterns.some((pattern) => pattern.test(text))) return true;
  if (text.length <= 80) return false;
  return (text.match(codePunctuation)?.length ?? 0) / text.length > 0.08;
};
const looksLikeCss = (text: string) =>
  cssPatterns.some((pattern) => pattern.test(text)) ||
  (text.match(cssDeclaration)?.length ?? 0) >= 3;
const looksLikeJson = (text: string) => {
  const trimmed = text.trim();
  if (!/^[[{]/u.test(trimmed) || trimmed.length < 2) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
};
const hasTemplateResidue = (text: string) =>
  templateWhole.test(text.trim()) || templateParts.some((pattern) => pattern.test(text));

/**
 * A value that ends with a control's label, or holds one on a line of its own, when it is more
 * than the label itself. A value that is only a label, such as a link's own text, is not flagged.
 */
const holdsControlLabel = (text: string, labels: ReadonlySet<string>) => {
  if (labels.size === 0) return false;
  const whole = normalizedLabel(text);
  if (labels.has(whole)) return false;
  const lines = text.split("\n").map(normalizedLabel);
  if (lines.length > 1 && lines.some((line) => labels.has(line))) return true;
  for (const label of labels)
    if (whole.length > label.length && whole.endsWith(label)) {
      const before = whole.charAt(whole.length - label.length - 1);
      if (/[\s.,;:!?|/\u2026)\]-]/u.test(before)) return true;
    }
  return false;
};

/**
 * Every finding in `output`. Paths fold array positions to `[]`, so one finding covers a field in
 * every record. Field checks (constant, empty, duplicate records, whole-card text) need a list of
 * at least three records, so a single record is never judged on them.
 */
export const lintOutput = (output: unknown, options: OutputLintOptions = {}): OutputFinding[] => {
  const schema = schemaResolver(options.outputSchema);
  const labels = new Set(
    (options.controlLabels ?? []).map(normalizedLabel).filter((label) => label.length >= 2),
  );
  const found = new Map<string, { path: string; check: OutputCheck; count: number; sample?: string }>();
  const flag = (path: string, check: OutputCheck, sample?: string, count = 1) => {
    const key = `${check}\u0000${path}`;
    const entry = found.get(key);
    if (entry === undefined)
      found.set(key, {
        path,
        check,
        count,
        ...(options.samples === true && sample !== undefined ? { sample: sampleOf(sample) } : {}),
      });
    else entry.count += count;
  };

  const lintString = (text: string, path: string, node: Json | undefined, inRow: boolean) => {
    const mediaType = schema.annotation(node, "contentMediaType");
    const maxLength = schema.annotation(node, "maxLength");
    const allowedLength =
      typeof maxLength === "number" ? Math.max(maxLength, inRow ? longRowValue : longValue) : undefined;
    if (looksLikeScript(text)) flag(path, "script", text);
    else if (looksLikeCss(text)) flag(path, "css", text);
    if (mediaType !== "text/html" && (markupTag.test(text) || entityResidue.test(text)))
      flag(path, "markup", text);
    if (mediaType !== "application/json" && looksLikeJson(text)) flag(path, "json_text", text);
    if (hasTemplateResidue(text)) flag(path, "template_residue", text);
    if (invisible.test(text)) flag(path, "invisible_chars", text);
    if (/^\s|\s$/u.test(text) || /\n\s*\n\s*\n/u.test(text)) flag(path, "untrimmed", text);
    if (text.length > (allowedLength ?? (inRow ? longRowValue : longValue)))
      flag(path, "too_long", text);
    if (trailingEllipsis.test(text) || holdsControlLabel(text, labels))
      flag(path, "collapsed_text", text);
    if (text.length <= 2_000 && repeatedRun.test(text)) flag(path, "duplicate_entries", text);
  };

  const lintRecords = (records: readonly Json[], path: string, node: Json | undefined) => {
    if (records.length < 3) return;
    const seen = new Set<string>();
    let repeated = 0;
    for (const record of records) {
      const text = JSON.stringify(record);
      if (seen.has(text)) repeated++;
      else seen.add(text);
    }
    if (repeated > 0) flag(path, "duplicate_records", undefined, repeated);
    const keys = new Set(records.flatMap((record) => Object.keys(record)));
    const itemNode = schema.items(node);
    for (const key of keys) {
      const values = records.map((record) => record[key]);
      const fieldPath = `${path}[].${key}`;
      const empty = (value: unknown) =>
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0);
      if (values.every(empty)) {
        flag(fieldPath, "empty_field");
        continue;
      }
      const declared = schema.property(itemNode, key);
      const closedSet =
        Array.isArray(schema.annotation(declared, "enum")) ||
        schema.annotation(declared, "const") !== undefined;
      const scalar = values.every(
        (value) => typeof value === "string" || typeof value === "number",
      );
      if (scalar && !closedSet && new Set(values).size === 1)
        flag(fieldPath, "constant_field", String(values[0]));
    }
    // One string field that holds the values of three or more of its siblings, and most of them,
    // is the record's whole text beside its typed fields. Links and paths are not compared.
    for (const key of keys) {
      if (key === "card_text") continue;
      let restating = 0;
      let sample: string | undefined;
      for (const record of records) {
        const value = record[key];
        if (typeof value !== "string") continue;
        const text = normalizedLabel(value);
        const siblings = Object.entries(record).filter(
          ([other, sibling]) =>
            other !== key &&
            (typeof sibling === "string" || typeof sibling === "number") &&
            normalizedLabel(String(sibling)).length >= 2 &&
            !/^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(String(sibling)),
        );
        const holds = (sibling: unknown) => {
          const part = normalizedLabel(String(sibling));
          const at = text.indexOf(part);
          // A whole value, not part of a longer word or number: "12" is not in "120".
          return (
            at >= 0 &&
            !/[\p{L}\p{N}]/u.test(text.charAt(at - 1)) &&
            !/[\p{L}\p{N}]/u.test(text.charAt(at + part.length))
          );
        };
        const contained = siblings.filter(([, sibling]) => holds(sibling)).length;
        const longest = siblings
          .filter(([, sibling]) => typeof sibling === "string")
          .reduce<unknown>(
            (best, [, sibling]) =>
              String(sibling).length > String(best ?? "").length ? sibling : best,
            undefined,
          );
        // A title often names a brand, a size and a colour; a whole card holds nearly every
        // field, its longest text, usually the title, included.
        if (
          contained >= 3 &&
          contained >= siblings.length * 0.75 &&
          longest !== undefined &&
          holds(longest)
        ) {
          restating++;
          sample ??= value;
        }
      }
      if (restating > 0) flag(`${path}[].${key}`, "card_text", sample, restating);
    }
  };

  const visit = (value: unknown, path: string, node: Json | undefined, inRow: boolean, depth: number) => {
    if (depth > 32) return;
    if (typeof value === "string") {
      lintString(value, path, node, inRow);
      return;
    }
    if (Array.isArray(value)) {
      const itemNode = schema.items(node);
      const strings = value.filter((item): item is string => typeof item === "string");
      if (strings.length > 1) {
        const duplicates = strings.length - new Set(strings.map(normalizedLabel)).size;
        if (duplicates > 0) flag(`${path}[]`, "duplicate_entries", undefined, duplicates);
      }
      const records = value.filter(isRecord);
      if (records.length > 0) lintRecords(records, path, node);
      for (const item of value) visit(item, `${path}[]`, itemNode, true, depth + 1);
      return;
    }
    if (isRecord(value))
      for (const [key, child] of Object.entries(value))
        visit(
          child,
          path === "$" ? key : `${path}.${key}`,
          schema.property(node, key),
          inRow,
          depth + 1,
        );
  };

  visit(output, "$", schema.root, false, 0);
  return [...found.values()].map((entry) => ({
    ...entry,
    blocking: blockingOutputChecks.has(entry.check),
  }));
};

/** A finding as the reviewer reads it: with the minter's reason when it overrode it. */
export interface ReviewedOutputFinding extends OutputFinding {
  readonly override?: string;
}

/**
 * Applies the minter's overrides: a finding whose path and check an override names keeps its
 * place, with the override's reason, and no longer blocks. `blocking` lists what still refuses
 * publication, and `unmatched` each override that names no finding.
 */
export const applyOutputOverrides = (
  findings: readonly OutputFinding[],
  overrides: readonly OutputOverride[] = [],
) => {
  const reasons = new Map(overrides.map((entry) => [`${entry.check}\u0000${entry.path}`, entry.reason]));
  const reviewed: ReviewedOutputFinding[] = findings.map((finding) => {
    const reason = reasons.get(`${finding.check}\u0000${finding.path}`);
    return reason === undefined ? finding : { ...finding, blocking: false, override: reason };
  });
  const matched = new Set(findings.map((finding) => `${finding.check}\u0000${finding.path}`));
  return {
    findings: reviewed,
    blocking: reviewed.filter((finding) => finding.blocking),
    unmatched: overrides.filter((entry) => !matched.has(`${entry.check}\u0000${entry.path}`)),
  };
};

/** What each check means, in the words the minter and the reviewer read. */
export const outputCheckMeaning: Readonly<Record<OutputCheck, string>> = {
  script: "holds script code",
  css: "holds style rules",
  markup: "holds HTML tags or entities",
  template_residue: "holds a template or serialization leftover such as undefined or [object Object]",
  json_text: "holds JSON as text instead of structured fields",
  invisible_chars: "holds zero-width or control characters",
  untrimmed: "has leading or trailing whitespace or blank lines",
  too_long: "is very long for one field",
  collapsed_text:
    "ends in an ellipsis or holds a page control's label, so it was read collapsed or cut short",
  card_text: "repeats most of its sibling fields' values, a whole card's text",
  duplicate_entries: "repeats an entry or a run of words",
  duplicate_records: "repeats a whole record",
  constant_field: "has the same value in every record",
  empty_field: "is empty or null in every record",
};

/**
 * The host's note to the minter after a run returned output with findings: what each one is and
 * how to act on it. Undefined when there are none.
 */
export const outputChecksNotice = (findings: readonly OutputFinding[]) =>
  findings.length === 0
    ? undefined
    : {
        findings: findings.map((finding) => ({
          ...finding,
          meaning: outputCheckMeaning[finding.check],
        })),
        instruction:
          "The host checked every value this run returned. Fix each finding in source, at the read: read rendered text with visibleText, visibleTexts or readRows, expand collapsed text before reading it and read it back, and scope rows to the main list; never clean a string afterwards. finish_build refuses an example whose output still holds a blocking finding (script, css, markup, template_residue). When a value is meant to be so, such as a tool whose purpose is to return code, name its path and check with the reason in finish_build's outputOverrides. Every other finding, and every override with its reason, goes to the publication reviewer.",
      };
