import type { Effect } from "effect";
import { visuallyHiddenCode } from "../browser/visible-text.js";
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
 * part of the controls before it. An unnamed `form` element, which the snapshot leaves out too,
 * gets a `- form:` line over its own lines, as a named form has, so where it ends shows as well. A
 * `fieldset`, and an element whose role is group, form or region, already shows, named or not.
 * A line whose whole value is the text of an element held out of view reads `[hidden: <text>]`: an
 * element that holds the text and no element, is positioned absolute or fixed, is displayed, is
 * not aria-hidden and is hidden by `visuallyHiddenCode`'s rule, the first 200 found within 100 ms.
 * Not marked: a copy of the words an aria-hidden sibling shows, such as a price's; a text the
 * snapshot holds more often than such elements do, as when the page also shows it; and a text
 * control's line or a line under one. The page is only read; when a read fails or runs out of
 * time, the snapshot is unmarked by it, and the lines are matched against such texts for up to
 * 100 ms. Pass no `mode: "ai"`: that snapshot already lists a visible aria-hidden separator.
 *
 * One pass in document order, past aria-hidden subtrees, finds the anchors around each run of
 * such separators: rendered text, or a control's own label. The line goes before the first line,
 * shortly after the last three anchors before the run, that holds the anchor after it, or before
 * the groups that open between them. It goes nowhere when that anchor shares a line with the one
 * before, when an open shadow root comes first, or when an anchor is not found.
 *
 * A form outermost among forms, with no role or name of its own, is found by such anchors too: all
 * its own, up to three before it, and the first after it; a select's options count. Its first
 * anchor is found at one of the next few places past the forms before it, with the anchors before
 * it each shortly before the next, the last on an earlier line. Each of its own follows shortly
 * after the one before, and the one after it on a later line, past what holds its last. A line's
 * own `- ` is never part of an anchor. Its `- form:` line goes over the lines from its first
 * anchor's to the end of what holds its last, at the outermost level between the two. A form gets
 * none when it is not rendered, when nothing anchored is outside it, such as one that holds the
 * whole page, or when its first or last anchor, or the one after it, is not found that way; an
 * anchor of its own between those that is not found is passed over. A custom field, one
 * form-associated or holding a native control in its open shadow root, with no anchor otherwise,
 * counts by the first anchor in that shadow root, such as its label.
 */
export const markedAriaSnapshotCode = `
const markedAriaSnapshot = async (locator, options) => {
  const [aria, [[splits, forms], hidden]] = await Promise.all([
    locator.ariaSnapshot(options),
    locator
      .evaluate((root) => [((root) => {
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
        // The forms the snapshot drops, having no role or name of their own: the outermost ones
        // not hidden from assistive technology.
        const forms = [
          ...root.querySelectorAll("form:not([role], [aria-label], [aria-labelledby])"),
        ].filter(
          (form) => form.closest(hiddenSelector) === null && !form.parentElement?.closest("form"),
        );
        // One string crosses back: Playwright serializes each array element separately, slowly.
        if (holders.size === 0 && forms.length === 0) return "[[],[]]";
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
          // A shadow root's own text has its host for a parent.
          const box = text ? (node.parentElement ?? node.parentNode.host) : node;
          return anchor !== "" && rendered(box) ? anchor : "";
        };
        const candidate = (node) =>
          node.nodeType === Node.TEXT_NODE ? /\\S/.test(node.nodeValue) : control(node);
        const lastOf = (node) => {
          while (node.lastChild !== null) node = node.lastChild;
          return node;
        };
        // A form's anchor, where a select's option, which has no box of its own, shows while its
        // select does, unless it is hidden itself.
        const formAnchorOf = (node) => {
          const option = node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
          if (option?.localName !== "option") return anchorOf(node);
          const select = option.closest("select");
          return select !== null && getComputedStyle(option).display !== "none" && rendered(select)
            ? words(node.nodeValue)
            : "";
        };
        // A custom field's anchor, for one form-associated or holding a native control in its open
        // shadow root, which the walks here do not enter: the first there, such as its label.
        const fieldAnchorOf = (node) => {
          const shadow = node.shadowRoot ?? null;
          return shadow !== null &&
            (node.constructor.formAssociated === true ||
              shadow.querySelector("input, select, textarea") !== null) &&
            rendered(node)
            ? (anchorsBeside(shadow, shadow, false, 1)[0] ?? "")
            : "";
        };
        // Up to \`count\` anchors in \`scope\` next to \`node\`, after it or (\`back\`) before
        // it, in document order, past aria-hidden subtrees.
        const anchorsBeside = (scope, node, back, count) => {
          const walk = document.createTreeWalker(
            scope,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
          );
          walk.currentNode = node;
          const step = () => (back ? walk.previousNode() : walk.nextNode());
          const anchors = [];
          for (let next = step(); next !== null && anchors.length < count; next = step()) {
            // Walking back reaches what an aria-hidden element holds before the element itself.
            const text = next.nodeType === Node.TEXT_NODE;
            const hidden = back
              ? ((text ? next.parentElement : next)?.closest(hiddenSelector) ?? null)
              : !text && next.matches(hiddenSelector)
                ? next
                : null;
            if (hidden !== null) walk.currentNode = back ? hidden : lastOf(hidden);
            else {
              const anchor = (candidate(next) ? formAnchorOf(next) : "") || fieldAnchorOf(next);
              if (anchor !== "") anchors[back ? "unshift" : "push"](anchor);
            }
          }
          return anchors;
        };
        // Each form's anchors: all its own, up to three before it, and the first after it. A form
        // with none of its own, such as a hidden one, is left out before its neighbours are
        // walked, and so is one with nothing anchored outside it, such as one holding the page.
        const edges = forms.flatMap((form) => {
          if (!rendered(form)) return [];
          const inside = anchorsBeside(form, form, false, Infinity);
          if (inside.length === 0) return [];
          const before = anchorsBeside(root, form, true, 3);
          const after = anchorsBeside(root, lastOf(form), false, 1);
          return before.length === 0 && after.length === 0
            ? []
            : [[before, inside, after[0] ?? null]];
        });
        if (holders.size === 0) return JSON.stringify([[], edges]);
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
            walker.currentNode = lastOf(node);
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
          if (!candidate(node)) continue;
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
        return JSON.stringify([splits, edges]);
      })(root), ((root) => {
${visuallyHiddenCode}
        // The text of each element held out of view that holds it, one per line (a text holds no
        // line break): the first 200 within 100 ms, or nothing past that time.
        const words = (text) => text.replace(/[^\\p{L}\\p{N}]/gu, "").toLowerCase();
        // The words each parent's aria-hidden children show, such as a price's styled digits.
        const beside = new Map();
        const texts = [];
        const started = performance.now();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let last = null;
        for (let node = walker.nextNode(); node !== null && texts.length < 200; node = walker.nextNode()) {
          if (performance.now() - started > 100) return null;
          const element = node.parentElement;
          if (element === null || element === last || !/\\S/.test(node.data)) continue;
          last = element;
          // Only a positioned element that holds its text alone, as screen-reader-only text is, is
          // judged, and only one the snapshot can show: displayed and not aria-hidden.
          if (element.firstElementChild !== null) continue;
          const computed = getComputedStyle(element);
          if (!/^(absolute|fixed)$/.test(computed.position) || !visuallyHidden(element, computed)
            || !element.checkVisibility({ visibilityProperty: true })
            || element.closest('[aria-hidden="true" i]') !== null) continue;
          const text = element.textContent.replace(/\\s+/g, " ").trim();
          const parent = element.parentElement;
          if (!beside.has(parent))
            beside.set(parent, new Set([...(parent?.querySelectorAll(':scope > [aria-hidden="true" i]') ?? [])]
              .map((child) => words(child.textContent))));
          if (!beside.get(parent).has(words(text))) texts.push(text);
        }
        return texts.join("\\n");
      })(root)], undefined, { timeout: options?.timeout })
      .then(([marks, texts]) => {
        // A page that redefines how an array turns into JSON leaves separators and forms unmarked.
        const parsed = JSON.parse(marks);
        return [
          Array.isArray(parsed?.[0]) && Array.isArray(parsed[1]) ? parsed : [[], []],
          typeof texts === "string" && texts !== "" ? texts.split("\\n") : [],
        ];
      })
      .catch(() => [[[], []], []]),
  ]);
  if (splits.length === 0 && forms.length === 0 && hidden.length === 0) return aria;
  const lines = aria.split("\\n");
  // The first line from \`from\`, and before \`to\`, that holds \`text\`, or -1.
  const find = (text, from, to = lines.length) => {
    for (let index = from; index < Math.min(to, lines.length); index++)
      if (lines[index].includes(text)) return index;
    return -1;
  };
  // How far past one anchor's line the next is looked for.
  const lookahead = 50;
  const indent = (line) => line.length - line.trimStart().length;
  // Where \`text\` ends, as [line, column], next from \`at\` and before line \`to\`, or undefined.
  // A line's own \`- \` is never part of an anchor.
  const seek = (text, [line, column], to) => {
    for (let index = line; index < Math.min(to, lines.length); index++) {
      const start = Math.max(index === line ? column : 0, indent(lines[index]) + 2);
      const found = lines[index].indexOf(text, start);
      if (found !== -1) return [index, found + text.length];
    }
  };
  // Where \`text\` starts, as [line, column], last before \`at\` and after line \`to\`, or
  // undefined.
  const seekBack = (text, [line, column], to) => {
    for (let index = line; index > Math.max(to, -1); index--) {
      const end = index === line ? column - text.length : Infinity;
      const found = end < 0 ? -1 : lines[index].lastIndexOf(text, end);
      if (found >= indent(lines[index]) + 2) return [index, found];
    }
  };
  // The last line of the last form marked: a form's own lines come after it.
  let done = -1;
  // Where the next form's first anchor is looked for: past the last form's first anchor found.
  let resume = [0, 0];
  for (const [before, inside, after] of forms) {
    // Its first anchor, at one of the next \`lookahead\` places its text is found, with the
    // anchors before it each shortly before the next, the last of them on an earlier line, so
    // the form starts on a line of its own.
    let first = seek(inside[0], resume, lines.length);
    let previous;
    for (let tries = 1; first !== undefined; tries++) {
      let at = [first[0], first[1] - inside[0].length];
      for (const [index, anchor] of [...before].reverse().entries()) {
        at = at && seekBack(anchor, at, at[0] - 1 - lookahead);
        if (index === 0) previous = at;
      }
      if (before.length === 0 || (at !== undefined && previous[0] < first[0])) break;
      first = tries < lookahead ? seek(inside[0], first, lines.length) : undefined;
    }
    if (first === undefined) continue;
    resume = first;
    // Its own anchors in turn: one not found is passed over, but not its last.
    let last = first;
    let found = true;
    for (const anchor of inside.slice(1)) {
      const next = seek(anchor, last, last[0] + 1 + lookahead);
      found = next !== undefined;
      if (found) last = next;
    }
    if (!found) continue;
    // Its lines: from its first anchor's to the end of what holds its last, at the outermost
    // level between the two.
    let level = Infinity;
    for (let index = first[0]; index <= last[0]; index++)
      level = Math.min(level, indent(lines[index]));
    const floor = Math.max(done + 1, before.length === 0 ? 0 : previous[0] + 1);
    let top = first[0];
    while (top > floor && indent(lines[top]) > level) top--;
    let end = last[0];
    while (end + 1 < lines.length && indent(lines[end + 1]) > level) end++;
    // What follows the form starts on a later line, past what holds its last anchor.
    const next = after === null ? undefined : seek(after, last, last[0] + 1 + lookahead);
    if (indent(lines[top]) !== level || (after !== null && (next === undefined || next[0] <= end)))
      continue;
    lines.splice(top, 0, " ".repeat(level) + "- form:");
    for (let index = top + 1; index <= end + 1; index++) lines[index] = "  " + lines[index];
    done = end + 1;
    resume = [done + 1, 0];
  }
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
  const held = hidden.reduce((counts, text) => counts.set(text, (counts.get(text) ?? 0) + 1), new Map());
  // How often the snapshot holds a text, plain or quoted; past 100 ms, too often to mark.
  const counted = new Map();
  const until = Date.now() + 100;
  const occurrences = (text) => {
    const escaped = JSON.stringify(text).slice(1, -1);
    const count = (written) => aria.split(written).length - 1;
    if (!counted.has(text))
      counted.set(text, Date.now() > until ? Infinity : count(text) + (escaped === text ? 0 : count(escaped)));
    return counted.get(text);
  };
  // A line's whole value that is such a text reads [hidden: <text>], unless the snapshot holds it
  // more often than hidden elements do, as when the page also shows it. A text control's line and
  // the lines under it are left as they are.
  let control = Infinity;
  return out
    .map((line) => {
      const level = indent(line);
      if (level > control) return line;
      control = /^\\s*- '?(?:textbox|searchbox|spinbutton|combobox|slider)\\b/.test(line) ? level : Infinity;
      const value = /^(\\s*- [a-z]+(?: "(?:[^"\\\\]|\\\\.)*")?(?: \\[[^\\]]*\\])*: )(.+)$/.exec(line);
      if (control !== Infinity || value === null) return line;
      const [, prefix, raw] = value;
      let text;
      try {
        text = raw.startsWith('"') ? JSON.parse(raw) : raw;
      } catch {
        return line;
      }
      if (!held.has(text) || occurrences(text) > held.get(text)) return line;
      return prefix + (raw.startsWith('"') ? '"[hidden: ' + raw.slice(1, -1) + ']"' : "[hidden: " + raw + "]");
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
