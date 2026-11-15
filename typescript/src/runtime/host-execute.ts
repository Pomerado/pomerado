import type { Effect } from "effect";
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
 * `role="separator"` hidden from assistive technology splits rendered text. The snapshot drops such
 * a separator, and an unnamed form or group's edge with it, so a notice after one reads as part of
 * the controls before it. The page is only read; when that read fails, the snapshot is unmarked.
 * The line goes before the first line after the separator's preceding text that holds its
 * following text, or the groups that open between them, and nowhere when both texts share a line
 * or either is missing.
 */
export const markedAriaSnapshotCode = `
const markedAriaSnapshot = async (locator, options) => {
  const [aria, splits] = await Promise.all([
    locator.ariaSnapshot(options),
    locator
      .evaluate((root) => {
        const hidden = (element) => element.closest('[aria-hidden="true" i]') !== null;
        // A rendered text node's longest run the snapshot writes as is, or "".
        const words = (node) => {
          const element = node.parentElement;
          if (element === null || hidden(element)) return "";
          // An element shown as its children only has no box of its own.
          const style = getComputedStyle(element);
          const box = style.display === "contents" ? element.parentElement : element;
          if (style.visibility !== "visible" || box?.checkVisibility() !== true) return "";
          return node.nodeValue
            .replace(/[\\u200b\\u00ad]/g, "")
            .split(/["'\\\\]/)
            .map((run) => run.replace(/\\s+/g, " ").trim())
            .reduce((longest, run) => (run.length > longest.length ? run : longest), "");
        };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nearest = (separator, step) => {
          walker.currentNode = separator;
          for (let node = walker[step](); node !== null; node = walker[step]()) {
            const text = words(node);
            if (text !== "") return text;
          }
          return "";
        };
        // One string crosses back: Playwright serializes each array element separately, slowly.
        return JSON.stringify(
          [...root.querySelectorAll('hr, [role="separator" i]')]
            .filter((separator) => hidden(separator) && separator.checkVisibility({ visibilityProperty: true }))
            .map((separator) => [nearest(separator, "previousNode"), nearest(separator, "nextNode")])
            .filter(([before, after]) => before !== "" && after !== ""),
        );
      }, undefined, { timeout: options?.timeout })
      .then(JSON.parse)
      .catch(() => []),
  ]);
  if (splits.length === 0) return aria;
  const lines = aria.split("\\n");
  const find = (text, from) => {
    for (let index = from; index < lines.length; index++) if (lines[index].includes(text)) return index;
    return -1;
  };
  const marked = new Set();
  let from = 0;
  for (const [before, after] of splits) {
    const start = find(before, from);
    if (start === -1 || lines[start].includes(after, lines[start].indexOf(before) + before.length)) continue;
    const next = find(after, start + 1);
    if (next === -1) continue;
    // Before the groups that open between the two texts, such as a list holding the second.
    let at = next;
    while (at - 1 > start && lines[at - 1].endsWith(":")) at--;
    marked.add(at);
    from = next;
  }
  return lines
    .flatMap((line, index) =>
      marked.has(index)
        ? [line.slice(0, line.length - line.trimStart().length) + "- separator [aria-hidden]", line]
        : [line])
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
