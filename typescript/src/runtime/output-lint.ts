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
  /**
   * Why the finding does not block: the minter's reason, or the field's declared
   * `contentMediaType` when that type holds such text on purpose. The reviewer judges both.
   */
  readonly override?: string;
  /** The check stopped at its work budget, so `count` covers only the values it reached. */
  readonly partial?: true;
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
/** Sibling comparisons the whole-card check makes in one output, about a tenth of a second. */
const recordCheckBudget = 400_000;
/** Word comparisons the repeated-words check makes in one output. */
const repeatCheckBudget = 2_000_000;
/** A string in a list's record longer than this is flagged; anywhere else, `longValue`. */
const longRowValue = 1_000;
const longValue = 8_000;

/**
 * The blocking checks need strong signals, so a page's own text never trips them: code tokens
 * that prose does not write (a function or arrow body, a call or assignment on a DOM global, a
 * statement ending in a semicolon), style rules in a selector block or with style property names
 * and values, real HTML tags, and unreplaced placeholders. Specs, prices, policies, citations and
 * nutrition lines, which run long with parentheses and semicolons, hold none of them.
 *
 * Every pattern's work per character is bounded by a constant: each repetition is bounded or can
 * split its input only one way, so no page text makes one backtrack without end. They read at
 * most the first `scannedLength` characters of a value; a longer value is flagged too_long anyway.
 */
const scannedLength = 16_384;
const identifier = "[A-Za-z_$][\\w$]{0,63}";
const scriptPatterns: readonly RegExp[] = [
  /<script\b/iu,
  new RegExp(`\\bfunction\\b\\s*(?:${identifier}\\s*)?\\([^()]{0,300}\\)\\s*\\{`, "u"),
  // An arrow function whose body is a block or a call: `() => init()`, `(e) => {`.
  new RegExp(
    `\\(\\s*(?:${identifier}\\s*(?:,\\s*${identifier}\\s*){0,10})?\\)\\s*=>\\s*(?:\\{|${identifier}(?:\\.${identifier}){0,6}\\s*\\()`,
    "u",
  ),
  new RegExp(`\\b${identifier}\\s*=>\\s*\\{`, "u"),
  /\}\s*catch\s*\(/u,
  // A call or an assignment on a DOM global, not a file or domain name such as document.final.pdf.
  new RegExp(`\\b(?:window|document|self|globalThis)(?:\\.${identifier}){1,8}\\s*(?:\\(|=(?!=))`, "u"),
  /\b(?:window|self|globalThis)\.__[\w$]/u,
  // A declaration that ends as a statement does: `const total = 1;`, never "let x = 5 and ...".
  new RegExp(`\\b(?:var|let|const)\\s+${identifier}\\s*=[^;=\\n][^;\\n]{0,200};`, "u"),
  // A call with a quoted argument, or none, that ends as a statement: `gtag('config', 'G-1');`.
  new RegExp(
    `\\b${identifier}(?:\\.${identifier}){0,6}\\((?:\\s*(["'])[^"'\\n]{0,200}\\1\\s*(?:,[^;\\n]{0,200})?)?\\)\\s*;`,
    "u",
  ),
  // A call taking an object or array literal: `load({async:true})`, `push([1,"a"])`.
  new RegExp(`\\b${identifier}\\.${identifier}\\(\\s*(?:\\[|\\{\\s*["']?${identifier}["']?\\s*:)`, "u"),
  /\btypeof\s{1,10}[A-Za-z_$][\w$]{0,63}\s{0,10}[!=]==?\s{0,10}["']/u,
  // Embedded structured data, such as JSON-LD, inside a longer string.
  /\{\s*"@(?:context|type|id|graph)"\s*:/u,
  /\{\s*"[^"\n]{1,60}"\s*:\s*(?:"[^"\n]{0,2000}"|-?\d{1,20}(?:\.\d{1,20})?|true|false|null|\{|\[)\s*,\s*"[^"\n]{1,60}"\s*:/u,
];
/** Words that are statements or values in script and rarely stand next to code punctuation in prose. */
const scriptKeyword =
  /\b(?:if|else|return|var|let|const|function|new|this|typeof|null|true|false|undefined|for|while)\b/gu;

/** Style properties without a hyphen; hyphenated and custom (`--x`) names count on their shape. */
const cssProperty =
  "(?:--[\\w-]{1,60}|-?[a-z]{1,30}(?:-[a-z]{1,30}){1,5}|color|display|margin|padding|border|width|height|top|left|right|bottom|position|float|clear|overflow|opacity|background|font|content|cursor|outline|transform|transition|animation|flex|grid|gap|order|visibility|filter|fill|stroke|inset|clip|resize|direction|zoom|src)";
/** A value only a style sheet writes: a length, a hex colour, a style function or keyword. */
const cssValue =
  "(?:-?(?:\\d{1,10}(?:\\.\\d{1,10})?|\\.\\d{1,10})(?:px|r?em|%|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|s|ms|deg|fr)|0|#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|var|calc|url|linear-gradient|radial-gradient)\\(|none|auto|block|inline|inline-block|inline-flex|flex|grid|inherit|initial|unset|hidden|visible|absolute|relative|fixed|sticky|solid|dashed|bold|normal|nowrap|pointer|transparent|uppercase|lowercase)";
const cssDeclaration = new RegExp(
  `(?:^|[\\s;{])${cssProperty}[^\\S\\n]{0,10}:[^\\S\\n]{0,10}${cssValue}[^;{}\\n]{0,200}(?:;|(?=\\}))`,
  "gu",
);
const cssPatterns: readonly RegExp[] = [
  // A selector block with a style declaration: `.a{display:flex}`, `:root{--brand:#123}`.
  new RegExp(
    `[^\\s{};][^\\S\\n]{0,10}\\{(?:[^{};]{0,500};){0,50}\\s{0,10}${cssProperty}\\s{0,10}:\\s{0,10}${cssValue}[^{}]{0,500}\\}`,
    "u",
  ),
  // A tight rule, which prose never writes, takes any value: `.x{color:red}`, `a:hover{z-index:2}`.
  new RegExp(`[^\\s{};]\\{(?:[^{};]{0,500};){0,50}${cssProperty}:[^\\s{};][^{}]{0,500}\\}`, "u"),
  /[^\s{};][^\S\n]{0,10}\{\s{0,10}--[\w-]{1,60}\s{0,10}:[^{}]{1,500}\}/u,
  /@media\s{0,10}(?:screen|print|all|only|not|\()/u,
  /@font-face\s{0,10}\{|@keyframes\s{1,10}[\w-]{1,60}\s{0,10}\{|@import\s{1,10}(?:url\(|["'])|@supports\s{0,10}\(/u,
  /:[^;:{}\n]{1,200}!important\b/u,
];
const htmlElement =
  "(?:a|abbr|article|aside|audio|b|blockquote|body|br|button|canvas|center|code|dd|del|div|dl|dt|em|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|label|li|link|main|mark|meta|nav|noscript|ol|option|p|path|picture|pre|section|select|small|source|span|strong|style|sub|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|tr|u|ul|video)";
const markupPatterns: readonly RegExp[] = [
  // An HTML element's tag with only name="value" attributes: `<br/>`, `<a href="/t">`, `</p>`.
  new RegExp(
    `<\\/?${htmlElement}(?:\\s{1,10}[\\w:-]{1,60}\\s{0,10}=\\s{0,10}(?:"[^"<>]{0,500}"|'[^'<>]{0,500}'|[^\\s"'<>=]{1,500})){0,30}\\s{0,10}\\/?>`,
    "iu",
  ),
  // Any element with a quoted attribute, or opened and closed: `<x-price value="12">`.
  /<[a-z][\w-]{0,60}\s{1,10}[\w:-]{1,60}\s{0,10}=\s{0,10}(?:"[^"<>]{0,500}"|'[^'<>]{0,500}')[^<>]{0,500}>/iu,
  /<([a-z][\w-]{0,60})(?![\w-])[^<>]{0,500}>[^<]{0,2000}<\/\1\s{0,10}>/iu,
  /<!--[\s\S]{0,2000}?-->/u,
  /&(?:amp|nbsp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/iu,
];
const templateWhole = /^(?:undefined|null|NaN)$/u;
const templateParts: readonly RegExp[] = [
  /\[object Object\]/u,
  /\{\{[^{}]{0,200}\}\}/u,
  /\$\{[^{}]{0,200}\}/u,
  // A label whose value never filled in: "Colour: undefined", "Price: $NaN".
  /(?:^|[\s(,])[\p{L}][\p{L}\p{N} _-]{0,40}:\s{0,10}(?:undefined|[$\u00A3\u20AC]?NaN)\s{0,10}(?:$|[,;)])/u,
];
/**
 * Characters that never carry meaning in text a person reads: zero-width space, word joiner,
 * byte order mark, soft hyphen, and controls other than tab and newline. The zero-width
 * non-joiner and joiner are left alone: they spell words in many scripts and join emoji.
 */
// eslint-disable-next-line no-control-regex
const invisible = /[\u200B\u2060\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const trailingEllipsis = /(?:\u2026|\.\.\.)\s{0,10}$/u;
/**
 * Whether the text says a run of at least two words twice in a row, such as a heading read from
 * two copies, and the word comparisons it took. It compares words, not characters, so a value of
 * W words costs at most W*W/4 comparisons; `budget` stops it early.
 */
const repeatedRun = (text: string, budget: number) => {
  const words = text.split(/\s+/u).filter((word) => word !== "");
  let spent = 0;
  for (let length = 2; length * 2 <= words.length; length++) {
    let matched = 0;
    for (let at = 0; at + length < words.length; at++) {
      if (++spent > budget) return { found: false, spent, stopped: true };
      matched = words[at] === words[at + length] ? matched + 1 : 0;
      if (matched === length) return { found: true, spent, stopped: false };
    }
  }
  return { found: false, spent, stopped: false };
};
/**
 * Media types a field declares to hold code or markup on purpose, and the checks each waives. A
 * waived finding is still reported, never blocking, with the declared type as its override, so
 * the reviewer judges whether the type fits the field.
 */
const codeChecks: readonly OutputCheck[] = ["script", "css", "markup", "template_residue", "json_text"];
const waivedByMediaType: Readonly<Record<string, readonly OutputCheck[]>> = {
  "text/javascript": codeChecks,
  "application/javascript": codeChecks,
  "text/ecmascript": codeChecks,
  "application/ecmascript": codeChecks,
  "application/typescript": codeChecks,
  "text/css": codeChecks,
  "text/x-python": codeChecks,
  "text/x-java-source": codeChecks,
  "text/x-csrc": codeChecks,
  "text/x-c++src": codeChecks,
  "application/x-sh": codeChecks,
  "application/sql": codeChecks,
  "text/html": ["markup"],
  "application/json": ["json_text"],
};
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
 * `locator.ariaSnapshot()` returns), as `controlLabels` takes them: a control named like "Show
 * more" or "Read more" that is not already expanded and comes right after text, as one that opens
 * a collapsed paragraph does. It is a button, or a link that stays on the page (`#`, a fragment or
 * `javascript:`); a link to another page, navigation, actions and a control after a list, such as
 * "Show more results", are left out.
 */
export const controlLabelsFromAriaSnapshot = (snapshot: string): string[] => {
  const labels = new Set<string>();
  // The last line seen at each indentation, reset when a shallower line closes its children.
  const previous: string[] = [];
  // A link that would count once its `/url` child shows it stays on the page.
  let link: { label: string; depth: number } | undefined;
  for (const line of snapshot.split("\n")) {
    const node = /^( *)- (.*)$/u.exec(line);
    if (node === null) continue;
    const depth = (node[1] ?? "").length;
    const body = node[2] ?? "";
    if (body.startsWith("/")) {
      if (link !== undefined && depth > link.depth && /^\/url: "?(?:#|javascript:)/iu.test(body))
        labels.add(link.label);
      continue;
    }
    link = undefined;
    previous.length = depth + 1;
    const before = previous[depth];
    previous[depth] = body;
    const control = /^(button|link) "((?:[^"\\]|\\.){1,200})"(.*)$/u.exec(body);
    if (control === null || /\[expanded\]/u.test(control[3] ?? "")) continue;
    const label = (control[2] ?? "").replace(/\\(.)/gu, "$1").trim();
    // Text right before it: `- text: ...`, `- paragraph: ...` or another node with inline text.
    const afterText =
      before !== undefined && /^[a-z]{1,30}(?: "(?:[^"\\]|\\.){0,200}")?(?: \[[^\]]{0,60}\]){0,8}: +\S/u.test(before);
    if (!afterText || !isExpandControl(label)) continue;
    if (control[1] === "button") labels.add(label);
    else link = { label, depth };
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

/** `json` says whether the whole value, not only the part read here, is JSON. */
const looksLikeScript = (text: string, json: boolean) => {
  if (json) return false;
  if (scriptPatterns.some((pattern) => pattern.test(text))) return true;
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
      const before = whole.slice(Math.max(0, whole.length - label.length - 20), whole.length - label.length);
      if (/[.!?|\u2026]\s{0,10}$/u.test(before)) return true;
      if (/\s$/u.test(before) && label.includes(" ")) return true;
    }
  return false;
};

/**
 * The phrases of an expand control that a value only ends with when the control's own text was
 * read into it: "Read more", "Show more", "See all", "Show full description", "\u2026 more".
 * Written as a label ("Read more", "READ MORE") after other text, or in any case after an
 * ellipsis or a sentence's end; "you should read more" is prose.
 */
const expandPhrase =
  "(?:read|show|see|view)\\s(?:more|less|all|full(?:\\s\\p{L}{1,20})?)\\s{0,3}(?:\\u2026|\\.\\.\\.|[\\u203A\\u00BB>\\u2192])?$";
const expandPhraseAnyCase = new RegExp(`(?:[.!?|\\u2026]\\s{0,3}${expandPhrase}|(?:\\u2026|\\.\\.\\.)\\s{0,3}more\\s{0,3}$)`, "iu");
const expandPhraseLabel =
  /\s(?:Read|Show|See|View|READ|SHOW|SEE|VIEW)\s(?:more|less|all|full(?:\s\p{L}{1,20})?|MORE|LESS|ALL|FULL(?:\s\p{L}{1,20})?)\s{0,3}(?:\u2026|\.\.\.|[\u203A\u00BB>\u2192])?$/u;
/** A value that ends with an expand phrase after other text, whatever controls the page showed. */
const endsWithExpandPhrase = (text: string) => {
  const tail = text.slice(-200).replace(/\s+/gu, " ").trim();
  const match = expandPhraseAnyCase.exec(tail) ?? expandPhraseLabel.exec(tail);
  return match !== null && /\S/u.test(tail.slice(0, match.index));
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
  const found = new Map<
    string,
    { path: string; check: OutputCheck; count: number; sample?: string; override?: string; partial?: true }
  >();
  const flag = (path: string, check: OutputCheck, sample?: string, count = 1, override?: string) => {
    const key = `${check}\u0000${path}`;
    const entry = found.get(key);
    if (entry === undefined)
      found.set(key, {
        path,
        check,
        count,
        ...(options.samples === true && sample !== undefined ? { sample: sampleOf(sample) } : {}),
        ...(override === undefined ? {} : { override }),
      });
    else entry.count += count;
  };
  // Comparisons the whole-card check may make across the output, so a very large output costs a
  // bounded time; past it, the check reports what it found as partial.
  let recordBudget = recordCheckBudget;
  // Word comparisons the repeated-words check may make across the output; past it, the check
  // skips the remaining values and reports what it found as partial.
  let stringBudget = repeatCheckBudget;
  let repeatsPartial = false;

  const lintString = (text: string, path: string, node: Json | undefined, inRow: boolean) => {
    const mediaType = schema.annotation(node, "contentMediaType");
    const waived = typeof mediaType === "string" ? waivedByMediaType[mediaType.toLowerCase()] : undefined;
    const leak = (check: OutputCheck) =>
      flag(
        path,
        check,
        text,
        1,
        waived?.includes(check) === true ? `the field declares contentMediaType ${String(mediaType)}` : undefined,
      );
    const maxLength = schema.annotation(node, "maxLength");
    const allowedLength =
      typeof maxLength === "number" ? Math.max(maxLength, inRow ? longRowValue : longValue) : undefined;
    const head = text.length > scannedLength ? text.slice(0, scannedLength) : text;
    const json = looksLikeJson(text);
    if (looksLikeScript(head, json)) leak("script");
    else if (looksLikeCss(head)) leak("css");
    if (looksLikeMarkup(head)) leak("markup");
    if (json) leak("json_text");
    if (hasTemplateResidue(head)) leak("template_residue");
    if (invisible.test(text)) flag(path, "invisible_chars", text);
    if (/^\s|\s$/u.test(text) || /\n[^\S\n]*\n[^\S\n]*\n/u.test(text)) flag(path, "untrimmed", text);
    if (text.length > (allowedLength ?? (inRow ? longRowValue : longValue)))
      flag(path, "too_long", text);
    // A card_text section is a card's whole text, its controls included. An ending ellipsis
    // counts only when the page offered a control to expand it; a snippet the site cuts short
    // and shows in full elsewhere is not collapsed.
    const section = /(?:^|\.)card_text$/u.test(path);
    if (
      !section &&
      (endsWithExpandPhrase(text) ||
        (labels.size > 0 && (trailingEllipsis.test(text) || holdsControlLabel(text, labels))))
    )
      flag(path, "collapsed_text", text);
    if (text.length <= 2_000 && stringBudget > 0) {
      const run = repeatedRun(text, stringBudget);
      stringBudget -= run.spent;
      if (run.stopped) repeatsPartial = true;
      if (run.found) flag(path, "duplicate_entries", text);
    }
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
    let cardTextPartial = false;
    for (const record of records) {
      const scalars: { key: string; text: string; string: boolean; raw: unknown }[] = [];
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        const text = normalizedLabel(String(value));
        if (text.length < 2 || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(String(value))) continue;
        scalars.push({ key, text, string: typeof value === "string", raw: value });
      }
      if (scalars.length < 4) continue;
      if (recordBudget <= 0) {
        cardTextPartial = true;
        break;
      }
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
        recordBudget -= scalars.length;
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
      if (entry === undefined) continue;
      flag(`${path}[].${key}`, "card_text", entry.sample, entry.count);
      if (cardTextPartial) {
        const finding = found.get(`card_text\u0000${path}[].${key}`);
        if (finding !== undefined) finding.partial = true;
      }
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
    ...(repeatsPartial && entry.check === "duplicate_entries" ? { partial: true as const } : {}),
    blocking: entry.override === undefined && blockingOutputChecks.has(entry.check),
  }));
};

/** A finding as the reviewer reads it: with the minter's reason when it overrode it. */
export type ReviewedOutputFinding = OutputFinding;

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
          "The host checked every value this run returned. Check each finding against the page. Fix a wrong value at the read in source: read rendered text with visibleText, visibleTexts or readRows, expand collapsed text before reading it and read it back, and scope rows to the main list; never clean a string afterwards. A check can be wrong: when a value is correct as it is, such as code the tool is meant to return or the page's own text that only resembles code, name its path and check with the reason in finish_build's outputOverrides. A field that holds code or markup on purpose can declare its contentMediaType instead; its findings then name that type and never block. Blocking findings (script, css, markup, template_residue) refuse finish_build until fixed or overridden; the others never block. The publication reviewer reads every finding and every override with its reason.",
      };
