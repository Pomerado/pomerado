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
 * whole card's text). Every finding is a lead, never a verdict: when a flagged value is correct as
 * returned, such as code on a tool that returns code or page text that only resembles code, the
 * minter names its path and check with the reason as an override, and the reviewer sees both.
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
   * The names of the controls on the page the output was read from, best from
   * `controlLabelsFromAriaSnapshot`. Only those that expand text ("Show more", "Read more") count,
   * and not one that is also a whole value in the output. A value that ends with one, or holds one
   * on its own line, may have been read collapsed, with its "more" control never used; an ending
   * ellipsis counts only when the page offered such a control.
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

/**
 * The blocking checks need strong signals, so a page's own text never trips them: code tokens
 * that prose does not write (a function or arrow body, a call or assignment on a DOM global, a
 * statement ending in a semicolon), style rules in a selector block or with style property names
 * and values, real HTML tags, and unreplaced placeholders. Specs, prices, policies, citations and
 * nutrition lines, which run long with parentheses and semicolons, hold none of them.
 */
const scriptPatterns: readonly RegExp[] = [
  /<script\b/iu,
  /\bfunction\s*[\w$]*\s*\([^()]*\)\s*\{/u,
  // An arrow function whose body is a block or a call: `() => init()`, `(e) => {`.
  /\(\s*(?:[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)?\s*\)\s*=>\s*(?:\{|[A-Za-z_$][\w$.]*\s*\()/u,
  /\b[A-Za-z_$][\w$]*\s*=>\s*\{/u,
  /\}\s*catch\s*\(/u,
  // A call or an assignment on a DOM global, not a file or domain name such as document.final.pdf.
  /\b(?:window|document|self|globalThis)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:\(|=(?!=))/u,
  /\b(?:window|self|globalThis)\.__[\w$]+/u,
  // A declaration that ends as a statement does: `const total = 1;`, never "let x = 5 and ...".
  /\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*[^;=\n][^;\n]{0,200};/u,
  // A call with a quoted argument that ends as a statement: `gtag('config', 'G-1');`.
  /\b[A-Za-z_$][\w$.]*\(\s*(["'])[^"'\n]{0,200}\1\s*(?:,[^;\n]{0,200})?\)\s*;/u,
  // A call taking an object or array literal: `load({async:true})`, `push([1,"a"])`.
  /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(\s*(?:\[|\{\s*["']?[A-Za-z_$][\w$-]*["']?\s*:)/u,
  // Embedded structured data, such as JSON-LD, inside a longer string.
  /\{\s*"@(?:context|type|id|graph)"\s*:/u,
  /\{\s*"[^"\n]{1,60}"\s*:\s*(?:"[^"\n]*"|-?\d[\d.]*|true|false|null|\{|\[)\s*,\s*"[^"\n]{1,60}"\s*:/u,
];
/** Words that are statements or values in script and rarely stand next to code punctuation in prose. */
const scriptKeyword =
  /\b(?:if|else|return|var|let|const|function|new|this|typeof|null|true|false|undefined|for|while)\b/gu;

/** Style properties without a hyphen; hyphenated and custom (`--x`) names count on their shape. */
const cssProperty =
  "(?:--[\\w-]+|-?[a-z]+(?:-[a-z]+)+|color|display|margin|padding|border|width|height|top|left|right|bottom|position|float|clear|overflow|opacity|background|font|content|cursor|outline|transform|transition|animation|flex|grid|gap|order|visibility|filter|fill|stroke|inset|clip|resize|direction|zoom|src)";
/** A value only a style sheet writes: a length, a hex colour, a style function or keyword. */
const cssValue =
  "(?:-?\\d*\\.?\\d+(?:px|r?em|%|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|s|ms|deg|fr)|0|#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|var|calc|url|linear-gradient|radial-gradient)\\(|none|auto|block|inline|inline-block|inline-flex|flex|grid|inherit|initial|unset|hidden|visible|absolute|relative|fixed|sticky|solid|dashed|bold|normal|nowrap|pointer|transparent|uppercase|lowercase)";
const cssDeclaration = new RegExp(`(?:^|[\\s;{])${cssProperty}\\s*:\\s*${cssValue}[^;{}\\n]*(?:;|(?=\\}))`, "gu");
const cssPatterns: readonly RegExp[] = [
  // A selector block with a style declaration: `.a{display:flex}`, `:root{--brand:#123}`.
  new RegExp(`[^\\s{};]\\s*\\{\\s*(?:[^{};]*;\\s*)*${cssProperty}\\s*:\\s*${cssValue}[^{}]*\\}`, "u"),
  new RegExp(`[^\\s{};]\\s*\\{\\s*--[\\w-]+\\s*:[^{}]+\\}`, "u"),
  /@media\s*(?:screen|print|all|only|not|\()/u,
  /@font-face\s*\{|@keyframes\s+[\w-]+\s*\{|@import\s+(?:url\(|["'])|@supports\s*\(/u,
  /:\s*[^;:{}\n]+!important\b/u,
];
const htmlElement =
  "(?:a|abbr|article|aside|audio|b|blockquote|body|br|button|canvas|center|code|dd|del|div|dl|dt|em|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|label|li|link|main|mark|meta|nav|noscript|ol|option|p|path|picture|pre|section|select|small|source|span|strong|style|sub|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|tr|u|ul|video)";
const markupPatterns: readonly RegExp[] = [
  // An HTML element's tag with only name="value" attributes: `<br/>`, `<a href="/t">`, `</p>`.
  new RegExp(
    `<\\/?${htmlElement}(?:\\s+[\\w:-]+\\s*=\\s*(?:"[^"<>]*"|'[^'<>]*'|[^\\s"'<>=]+))*\\s*\\/?>`,
    "iu",
  ),
  // Any element with a quoted attribute, or opened and closed: `<x-price value="12">`.
  /<[a-z][\w-]*\s+[\w:-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*')[^<>]*>/iu,
  /<([a-z][\w-]*)\b[^<>]*>[^<]*<\/\1\s*>/iu,
  /&(?:amp|nbsp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/iu,
];
const templateWhole = /^(?:undefined|null|NaN)$/u;
const templateParts: readonly RegExp[] = [
  /\[object Object\]/u,
  /\{\{[^{}]*\}\}/u,
  /\$\{[^{}]*\}/u,
  // A label whose value never filled in: "Colour: undefined", "Price: $NaN".
  /(?:^|[\s(,])[\p{L}][\p{L}\p{N} _-]{0,40}:\s*(?:undefined|[$\u00A3\u20AC]?NaN)(?:$|[\s,.;)])/u,
];
/**
 * Characters that never carry meaning in text a person reads: zero-width space, word joiner,
 * byte order mark, soft hyphen, and controls other than tab and newline. The zero-width
 * non-joiner and joiner are left alone: they spell words in many scripts and join emoji.
 */
// eslint-disable-next-line no-control-regex
const invisible = /[\u200B\u2060\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const trailingEllipsis = /(?:\u2026|\.\.\.)\s*$/u;
/** A run of at least two words said twice in a row, such as a heading read from two copies. */
const repeatedRun = /(?:^|\s)(\S+(?:\s+\S+)+)\s+\1(?=$|\s)/u;
/** Media types a field declares to hold code or markup on purpose: its script and style checks do not apply. */
const codeMediaType =
  /^(?:text\/(?:javascript|css|markdown|x-[\w.+-]+)|application\/(?:javascript|ecmascript|x-[\w.+-]+))$/u;
/**
 * The name of a control that opens more of the text beside it: "Show more", "Read more", "See
 * all", "Expand", "+3 more". Navigation, filters and actions such as "Add to cart" are not.
 */
const expandControl =
  /^(?:(?:show|see|read|view|load)\s+(?:more|all|less|full|everything|details|the\s+rest)\b.*|(?:\.\.\.|\u2026)?\s*more\s*(?:\.\.\.|\u2026)?|less|expand(?:\s+all)?|\+\s*\d+\s*more|\d+\s+more|full\s+(?:description|details|text|review)s?)$/iu;

const sampleOf = (text: string) =>
  text.length <= sampleLength ? text : `${text.slice(0, sampleLength - 1)}\u2026`;

const normalizedLabel = (text: string) =>
  text
    .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * The names of the page's expand controls in a Playwright accessibility snapshot (the YAML
 * `locator.ariaSnapshot()` returns), as `controlLabels` takes them: a button named like "Show
 * more" or "Read more" that is not already expanded and comes right after text, as one that opens
 * a collapsed paragraph does. Links, which open another page, navigation, actions and a control
 * after a list, such as "Show more results", are left out.
 */
export const controlLabelsFromAriaSnapshot = (snapshot: string): string[] => {
  const labels = new Set<string>();
  // The last line seen at each indentation, reset when a shallower line closes its children.
  const previous: string[] = [];
  for (const line of snapshot.split("\n")) {
    const node = /^(\s*)-\s+(.*)$/u.exec(line);
    if (node === null) continue;
    const depth = (node[1] ?? "").length;
    const body = node[2] ?? "";
    if (body.startsWith("/")) continue;
    previous.length = depth + 1;
    const before = previous[depth];
    previous[depth] = body;
    const button = /^button\s+"((?:[^"\\]|\\.)+)"(.*)$/u.exec(body);
    if (button === null || /\[expanded\]/u.test(button[2] ?? "")) continue;
    const label = (button[1] ?? "").replace(/\\(.)/gu, "$1").trim();
    // Text right before it: `- text: ...`, `- paragraph: ...` or another node with inline text.
    const afterText =
      before !== undefined && /^[a-z]+(?:\s+"(?:[^"\\]|\\.)*")?(?:\s+\[[^\]]*\])*:\s+\S/u.test(before);
    if (afterText && isExpandControl(label)) labels.add(label);
  }
  return [...labels];
};

const isExpandControl = (label: string) =>
  label.length >= 2 && label.length <= 40 && expandControl.test(normalizedLabel(label));

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
  if (scriptPatterns.some((pattern) => pattern.test(text)) && !looksLikeJson(text)) return true;
  // Code without one telling token: statements, a block and keywords, densely punctuated.
  const statements = text.match(/;/gu)?.length ?? 0;
  if (statements < 2 || !/\{[^{}]*\}/u.test(text)) return false;
  const keywords = text.match(scriptKeyword)?.length ?? 0;
  const punctuation = text.match(/[;{}()=]/gu)?.length ?? 0;
  return keywords >= 2 && punctuation / text.length > 0.1;
};
const looksLikeCss = (text: string) =>
  cssPatterns.some((pattern) => pattern.test(text)) ||
  (text.match(cssDeclaration)?.length ?? 0) >= 3;
const looksLikeMarkup = (text: string) => markupPatterns.some((pattern) => pattern.test(text));
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
 * A value that holds an expand control's label on a line of its own, or ends with one after a
 * sentence's end or an ellipsis, or after a space when the label has two or more words ("...
 * a desk Show more"). A value that is only a label, such as a link's own text, is not flagged.
 */
const holdsControlLabel = (text: string, labels: ReadonlySet<string>) => {
  if (labels.size === 0) return false;
  const whole = normalizedLabel(text);
  if (labels.has(whole)) return false;
  const lines = text.split("\n").map(normalizedLabel);
  if (lines.length > 1 && lines.some((line) => labels.has(line))) return true;
  for (const label of labels)
    if (whole.length > label.length && whole.endsWith(label)) {
      const before = whole.slice(0, whole.length - label.length);
      if (/[.!?|\u2026]\s*$/u.test(before)) return true;
      if (/\s$/u.test(before) && label.includes(" ")) return true;
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
  // A label that is also a whole value in the output, such as a record's title, is content.
  const values = new Set<string>();
  const collect = (value: unknown, depth: number) => {
    if (depth > 32) return;
    if (typeof value === "string") {
      if (value.length <= 40) values.add(normalizedLabel(value));
    } else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1);
    else if (isRecord(value)) for (const child of Object.values(value)) collect(child, depth + 1);
  };
  if ((options.controlLabels?.length ?? 0) > 0) collect(output, 0);
  const labels = new Set(
    (options.controlLabels ?? [])
      .filter(isExpandControl)
      .map(normalizedLabel)
      .filter((label) => !values.has(label)),
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
    const code = typeof mediaType === "string" && codeMediaType.test(mediaType);
    const maxLength = schema.annotation(node, "maxLength");
    const allowedLength =
      typeof maxLength === "number" ? Math.max(maxLength, inRow ? longRowValue : longValue) : undefined;
    if (!code) {
      if (looksLikeScript(text)) flag(path, "script", text);
      else if (looksLikeCss(text)) flag(path, "css", text);
      if (mediaType !== "text/html" && looksLikeMarkup(text)) flag(path, "markup", text);
      if (mediaType !== "application/json" && looksLikeJson(text)) flag(path, "json_text", text);
      if (hasTemplateResidue(text)) flag(path, "template_residue", text);
    }
    if (invisible.test(text)) flag(path, "invisible_chars", text);
    if (/^\s|\s$/u.test(text) || /\n\s*\n\s*\n/u.test(text)) flag(path, "untrimmed", text);
    if (text.length > (allowedLength ?? (inRow ? longRowValue : longValue)))
      flag(path, "too_long", text);
    // A card_text section is a card's whole text, its controls included. An ending ellipsis
    // counts only when the page offered a control to expand it; a snippet the site cuts short
    // and shows in full elsewhere is not collapsed.
    const section = /(?:^|\.)card_text$/u.test(path);
    if (
      !section &&
      labels.size > 0 &&
      (trailingEllipsis.test(text) || holdsControlLabel(text, labels))
    )
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
    // is the record's whole text beside its typed fields. Links and paths are not compared. Each
    // record's values are normalized once.
    const restating = new Map<string, { count: number; sample: string }>();
    for (const record of records) {
      const scalars: { key: string; text: string; string: boolean; raw: unknown }[] = [];
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        const text = normalizedLabel(String(value));
        if (text.length < 2 || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(String(value))) continue;
        scalars.push({ key, text, string: typeof value === "string", raw: value });
      }
      if (scalars.length < 4) continue;
      // It must hold its longest string sibling, so it is at least as long as the second longest.
      const lengths = scalars
        .filter((entry) => entry.string)
        .map((entry) => entry.text.length)
        .sort((a, b) => b - a);
      const shortest = lengths[1] ?? 0;
      for (const candidate of scalars) {
        if (!candidate.string || candidate.key === "card_text") continue;
        const text = candidate.text;
        if (text.length < shortest) continue;
        // A whole value, not part of a longer word or number: "12" is not in "120".
        const holds = (part: string) => {
          const at = text.indexOf(part);
          return (
            at >= 0 &&
            !/[\p{L}\p{N}]/u.test(text.charAt(at - 1)) &&
            !/[\p{L}\p{N}]/u.test(text.charAt(at + part.length))
          );
        };
        let siblings = 0;
        let contained = 0;
        let longest: string | undefined;
        for (const sibling of scalars) {
          if (sibling === candidate) continue;
          siblings++;
          if (holds(sibling.text)) contained++;
          if (sibling.string && sibling.text.length > (longest?.length ?? -1))
            longest = sibling.text;
        }
        // A title often names a brand, a size and a colour; a whole card holds nearly every
        // field, its longest text, usually the title, included.
        if (contained >= 3 && contained >= siblings * 0.75 && longest !== undefined && holds(longest)) {
          const entry = restating.get(candidate.key);
          if (entry === undefined)
            restating.set(candidate.key, { count: 1, sample: String(candidate.raw) });
          else entry.count++;
        }
      }
    }
    for (const key of keys) {
      const entry = restating.get(key);
      if (entry !== undefined) flag(`${path}[].${key}`, "card_text", entry.sample, entry.count);
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
  invisible_chars: "holds characters that never show, such as a zero-width space, a soft hyphen or a control character",
  untrimmed: "has leading or trailing whitespace or blank lines",
  too_long: "is very long for one field",
  collapsed_text:
    "ends in an ellipsis or holds the label of a control that expands text on its page, so it may have been read collapsed",
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
          "The host checked every value this run returned. Check each finding against the page. Fix a wrong value at the read in source: read rendered text with visibleText, visibleTexts or readRows, expand collapsed text before reading it and read it back, and scope rows to the main list; never clean a string afterwards. A check can be wrong: when a value is correct as it is, such as code the tool is meant to return or the page's own text that only resembles code, name its path and check with the reason in finish_build's outputOverrides. Blocking findings (script, css, markup, template_residue) refuse finish_build until fixed or overridden; the others never block. The publication reviewer reads every finding and every override with its reason.",
      };
