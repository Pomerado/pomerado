import type { Effect } from "effect";
import { visibleTextPageCode } from "../browser/visible-text.js";
import { timeoutDefaults } from "./deadline.js";

/** One browser's host calls: plain Playwright code with `page`, `context` and `browser`. */
export type HostExecute = (code: string, timeoutSec?: number) => Effect.Effect<unknown, Error>;

/**
 * The code a host call starts with to bind `name` to the tab with this target id, which may not
 * be Kernel's foreground `page`. It fails when that tab is closed.
 */
export const pageCode = (targetId: string, name: string) => `
const ${name} = await (async () => {
  for (const candidate of context.pages()) {
    const session = await context.newCDPSession(candidate);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      if (targetInfo.targetId === ${JSON.stringify(targetId)}) return candidate;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
  throw new Error("Page closed");
})();
`;

/**
 * Defines `markedAriaSnapshot(locator, options)` for a host call's code: the locator's
 * accessibility snapshot, with a `- separator [aria-hidden]` line where a rendered `hr` or
 * `role="separator"` hidden from assistive technology splits rendered content. The snapshot drops
 * such a separator, and an unnamed form or group's edge with it, so a notice after one reads as
 * part of the controls before it. A line whose whole value is the text of an element the page
 * holds out of view and shows nowhere, by `visibleTextPageCode`'s rule, reads `[hidden: <text>]`.
 * Not marked: a copy of the words an aria-hidden sibling shows, such as a price's, a text
 * control's value or a line under one, and a text more lines hold than hidden elements do. The page
 * is only read; when a read fails, the snapshot is unmarked by it. Pass no `mode: "ai"`: that
 * snapshot already lists a visible aria-hidden separator.
 *
 * One pass in document order, past aria-hidden subtrees, finds the anchors around each run of
 * such separators: rendered text, or a control's own label. The line goes before the first line,
 * shortly after the last three anchors before the run, that holds the anchor after it, or before
 * the groups that open between them. It goes nowhere when that anchor shares a line with the one
 * before, when an open shadow root comes first, or when an anchor is not found.
 */
export const markedAriaSnapshotCode = `
const markedAriaSnapshot = async (locator, options) => {
  const [aria, splits, hidden] = await Promise.all([
    locator.ariaSnapshot(options),
    locator
      .evaluate((root) => {
        const hiddenSelector = '[aria-hidden="true" i]';
        // The outermost aria-hidden element holding each rendered separator the snapshot drops.
        const holders = new Set();
        for (const separator of root.querySelectorAll('hr, [role="separator" i]')) {
          let holder = separator.closest(hiddenSelector);
          if (holder === null || !root.contains(holder)) continue;
          if (!separator.checkVisibility({ visibilityProperty: true })) continue;
          for (let up = holder.parentElement?.closest(hiddenSelector); up && root.contains(up); )
            [holder, up] = [up, up.parentElement?.closest(hiddenSelector)];
          holders.add(holder);
        }
        // One string crosses back: Playwright serializes each array element separately, slowly.
        if (holders.size === 0) return "[]";
        // The longest run of a label or text the snapshot writes as is.
        const words = (text) =>
          (text ?? "")
            .replace(/[\\u200b\\u00ad]/g, "")
            .split(/["'\\\\]/)
            .map((run) => run.replace(/\\s+/g, " ").trim())
            .reduce((longest, run) => (run.length > longest.length ? run : longest), "");
        // An element shown as its children only has no box of its own.
        const rendered = (element) => {
          const style = getComputedStyle(element);
          const box = style.display === "contents" ? element.parentElement : element;
          return style.visibility === "visible" && box?.checkVisibility() === true;
        };
        const control = (element) =>
          ["button", "input", "select", "textarea", "img"].includes(element.localName) ||
          (element.localName === "a" && element.hasAttribute("href")) ||
          element.hasAttribute("role");
        const named = (value) => (value?.trim() ? value : null);
        // A control's own name. Text it holds names it in the snapshot, and is an anchor of its
        // own, so what names an icon counts only for a control with none.
        const nameOf = (element) => {
          const textless = () =>
            ["input", "select", "textarea", "img"].includes(element.localName) ||
            // innerText leaves out what is not rendered, such as an SVG's title.
            !/\\S/.test(element.innerText ?? "");
          const labelledBy = () =>
            element
              .getAttribute("aria-labelledby")
              ?.split(/\\s+/)
              .map((id) => document.getElementById(id)?.textContent)
              .join(" ");
          const label = element.labels?.[0];
          const button =
            element.localName === "input" && ["button", "submit", "reset"].includes(element.type);
          return (
            (element.hasAttribute("aria-labelledby") && textless() ? named(labelledBy()) : null) ??
            named(element.getAttribute("aria-label")) ??
            (element.localName === "img" ? named(element.getAttribute("alt")) : null) ??
            // A label around the control also holds the control's own text, such as its options.
            (label?.contains(element) ? null : named(label?.textContent)) ??
            named(element.getAttribute("placeholder")) ??
            (button ? named(element.value) : null) ??
            (textless()
              ? (named(element.getAttribute("title")) ??
                named(element.querySelector("svg title")?.textContent))
              : null)
          );
        };
        // A candidate's anchor: rendered text, or a control's own name; "" for neither.
        const anchorOf = (node) => {
          const text = node.nodeType === Node.TEXT_NODE;
          const anchor = words(text ? node.nodeValue : nameOf(node));
          return anchor !== "" && rendered(text ? node.parentElement : node) ? anchor : "";
        };
        const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        );
        // The latest candidates, read only when a separator needs them.
        const recent = [];
        const splits = [];
        let crossed = false;
        let before;
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches(hiddenSelector)) {
            crossed ||= holders.has(node);
            // Past all it holds: a filter that rejected it would cost a call per node.
            let last = node;
            while (last.lastChild !== null) last = last.lastChild;
            walker.currentNode = last;
            continue;
          }
          if (crossed && before === undefined) {
            const anchors = [];
            for (let index = recent.length - 1; index >= 0 && anchors.length < 3; index--) {
              const anchor = anchorOf(recent[index]);
              if (anchor !== "") anchors.unshift(anchor);
            }
            if (anchors.length > 0) before = anchors;
          }
          crossed = false;
          // The snapshot shows a shadow root's content first, which this pass cannot read.
          if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot !== null) before = undefined;
          if (node.nodeType === Node.TEXT_NODE ? !/\\S/.test(node.nodeValue) : !control(node))
            continue;
          if (before !== undefined) {
            const anchor = anchorOf(node);
            if (anchor !== "") {
              splits.push([...before, anchor]);
              before = undefined;
              // The next split's anchors start here, where this one's line is found.
              recent.length = 0;
            }
          }
          recent.push(node);
          if (recent.length > 128) recent.splice(0, 64);
        }
        return JSON.stringify(splits);
      }, undefined, { timeout: options?.timeout })
      .then(JSON.parse)
      .catch(() => []),
    locator
      .evaluate((root) => {
        ${visibleTextPageCode}
        // The text of each element out of view that the page shows nowhere, by the visible reader,
        // one per line: a text holds no line break.
        const elements = [];
        const shown = visibleTextPage([root], { as: "visible", lines: false, hidden: elements })[0] ?? "";
        const words = (text) => text.replace(/[^\\p{L}\\p{N}]/gu, "").toLowerCase();
        // The words each parent's aria-hidden children show, read once per parent, and whether
        // each text is shown, checked once per text.
        const beside = new Map();
        const isShown = new Map();
        const texts = [];
        for (const element of elements) {
          const text = element.textContent.replace(/\\s+/g, " ").trim();
          const parent = element.parentElement;
          if (!beside.has(parent))
            beside.set(parent, new Set([...(parent?.children ?? [])]
              .filter((child) => child.matches('[aria-hidden="true" i]'))
              .map((child) => words(child.textContent))));
          // A screen-reader copy of the words an aria-hidden sibling shows, such as a price's, is shown.
          if (text === "" || beside.get(parent).has(words(text))) continue;
          if (!isShown.has(text)) isShown.set(text, shown.includes(text));
          if (!isShown.get(text)) texts.push(text);
        }
        return texts.join("\\n");
      }, undefined, { timeout: options?.timeout })
      .then((texts) => (typeof texts === "string" && texts !== "" ? texts.split("\\n") : []))
      .catch(() => []),
  ]);
  if (splits.length === 0 && hidden.length === 0) return aria;
  const lines = aria.split("\\n");
  // The first line from \`from\`, and before \`to\`, that holds \`text\`, or -1.
  const find = (text, from, to = lines.length) => {
    for (let index = from; index < Math.min(to, lines.length); index++)
      if (lines[index].includes(text)) return index;
    return -1;
  };
  // How far past one anchor's line the next is looked for.
  const lookahead = 50;
  const marked = new Set();
  let from = 0;
  for (const split of splits) {
    const after = split.pop();
    const before = split.at(-1);
    let start = find(split[0], from);
    for (const anchor of split.slice(1))
      if (start !== -1) start = find(anchor, start, start + lookahead);
    if (start === -1) continue;
    if (lines[start].includes(after, lines[start].indexOf(before) + before.length)) continue;
    const next = find(after, start + 1, start + 1 + lookahead);
    if (next === -1) continue;
    // Before the groups that open between the two, such as a list holding the anchor after.
    let at = next;
    while (at - 1 > start && lines[at - 1].endsWith(":")) at--;
    marked.add(at);
    from = next;
  }
  const out = lines.flatMap((line, index) =>
    marked.has(index)
      ? [line.slice(0, line.length - line.trimStart().length) + "- separator [aria-hidden]", line]
      : [line]);
  if (hidden.length === 0) return out.join("\\n");
  // A line's whole value, plain or quoted, but none of a text control or nested under one.
  let control = Infinity;
  const values = out.map((line) => {
    const indent = line.length - line.trimStart().length;
    if (indent > control) return undefined;
    control = /^\\s*- (?:textbox|searchbox|spinbutton|combobox|slider)\\b/.test(line) ? indent : Infinity;
    const value = /^(\\s*- [a-z]+(?: "(?:[^"\\\\]|\\\\.)*")?(?: \\[[^\\]]*\\])*: )(.+)$/.exec(line);
    if (control !== Infinity || value === null) return undefined;
    try {
      return { prefix: value[1], raw: value[2], text: value[2].startsWith('"') ? JSON.parse(value[2]) : value[2] };
    } catch {
      return undefined;
    }
  });
  // A value that is such a text reads [hidden: <text>], unless more lines hold it than hidden
  // elements do, as when the page also shows it another way.
  const tally = (texts) => texts.reduce((counts, text) => counts.set(text, (counts.get(text) ?? 0) + 1), new Map());
  const held = tally(hidden);
  const lined = tally(values.flatMap((value) => (value !== undefined && held.has(value.text) ? [value.text] : [])));
  return out
    .map((line, index) => {
      const value = values[index];
      if (value === undefined || !held.has(value.text) || lined.get(value.text) > held.get(value.text)) return line;
      return value.prefix + (value.raw.startsWith('"') ? '"[hidden: ' + value.raw.slice(1, -1) + ']"' : "[hidden: " + value.raw + "]");
    })
    .join("\\n");
};
`;

/** Binds `primary` to the browser's primary tab; see `pageCode`. */
export const primaryPageCode = (targetId: string) => pageCode(targetId, "primary");

/**
 * An exploration probe's call code: the runtime's action budget as the page's default timeout
 * while it runs, navigation kept at its own budget, and Playwright's default put back after. A
 * probe's locator that matches nothing then fails in seconds with Playwright's own timeout error,
 * not after 30 s. A host wraps every call an exploration probe makes, and nothing else.
 */
export const probeCallCode = (code: string, actionMs: number = timeoutDefaults.action) => `page.setDefaultNavigationTimeout(${timeoutDefaults.navigation});
page.setDefaultTimeout(${actionMs});
try {
${code}
} finally {
  page.setDefaultTimeout(${timeoutDefaults.navigation});
}`;
