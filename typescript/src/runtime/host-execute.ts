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
 * part of the controls before it. Text the snapshot keeps that the page holds out of view and
 * shows nowhere, by `visibleTextPageCode`'s rule, reads `[hidden: <text>]` where a line's value
 * holds it; a copy beside an aria-hidden sibling, which shows it, is not marked. The page is only
 * read; when a read fails, the snapshot is unmarked by it. Pass no `mode: "ai"`: that snapshot
 * already lists a visible aria-hidden separator.
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
        // The text of each element out of view that the page shows nowhere, by the visible reader.
        const elements = [];
        const shown = visibleTextPage([root], { as: "visible", lines: false, hidden: elements })[0] ?? "";
        const texts = new Set();
        for (const element of elements) {
          const text = element.textContent.replace(/\\s+/g, " ").trim();
          // A screen-reader copy of what an aria-hidden sibling shows, such as a price's, is shown.
          const twin = [...(element.parentElement?.children ?? [])].some((sibling) =>
            sibling.matches('[aria-hidden="true" i]'));
          if (text !== "" && !twin && !shown.includes(text)) texts.add(text);
        }
        return JSON.stringify([...texts]);
      }, undefined, { timeout: options?.timeout })
      .then(JSON.parse)
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
  // Each such text in a line's value, never in a name or a text control's value, as written
  // plain or quoted, longest first.
  const pattern = (form) =>
    new RegExp(hidden.sort((a, b) => b.length - a.length)
      .map((text) => form(text).replace(/[^\\w\\s]/g, "\\\\$&")).join("|"), "g");
  const [plain, quoted] = hidden.length === 0 ? []
    : [pattern((text) => text), pattern((text) => JSON.stringify(text).slice(1, -1))];
  const hide = (line) => {
    const value = plain && /^(\\s*- (?!(?:textbox|searchbox|spinbutton|combobox)\\b)[a-z]+(?: "(?:[^"\\\\]|\\\\.)*")?(?: \\[[^\\]]*\\])*: )(.+)$/.exec(line);
    return value ? value[1] + value[2].replace(value[2].startsWith('"') ? quoted : plain, "[hidden: $&]") : line;
  };
  return lines
    .flatMap((line, index) =>
      marked.has(index)
        ? [line.slice(0, line.length - line.trimStart().length) + "- separator [aria-hidden]", line]
        : [line])
    .map(hide)
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
