import { Effect } from "effect";

/** Explicit caller secrets live only for this run. This does not detect or classify page data. */
export const makeRunSecrets = () => {
  const values = new Set<string>();
  /**
   * Each form a page or URL can show the value in: as given, trimmed, and with its whitespace
   * collapsed as a page's accessibility snapshot shows it; each as written, URL-encoded,
   * JSON-escaped and form-encoded with `+` for a space, as a query string carries it.
   */
  const register = (value: string) => {
    const shown = [
      value,
      value.trim(),
      value
        .replace(/[\u200b\u00ad]/gu, "")
        .trim()
        .replace(/\s+/gu, " "),
    ];
    for (const form of shown) {
      if (form.length === 0) continue;
      values.add(form);
      values.add(encodeURIComponent(form));
      values.add(JSON.stringify(form).slice(1, -1));
      values.add(new URLSearchParams([["", form]]).toString().slice(1));
    }
  };
  const ordered = () => [...values].sort((left, right) => right.length - left.length);
  const redact = (text: string) =>
    ordered().reduce((result, secret) => result.split(secret).join("[private]"), text);
  /** The longest proper prefix of a registered form that `text` ends with, as a length. */
  const splitPrefix = (text: string) =>
    ordered().reduce((longest, secret) => {
      for (let length = Math.min(secret.length - 1, text.length); length > longest; length--)
        if (text.endsWith(secret.slice(0, length))) return length;
      return longest;
    }, 0);
  /** Redacts text a cut ended, so a secret the cut split leaves no prefix at its end either. */
  const redactCut = (text: string) => {
    const redacted = redact(text);
    return redacted.slice(0, redacted.length - splitPrefix(redacted));
  };
  const assertAbsent = (text: string) =>
    Effect.suspend(() =>
      ordered().some((secret) => text.includes(secret))
        ? Effect.fail(new Error("Source contains a caller-supplied secret"))
        : Effect.void,
    );
  const json = (value: unknown) =>
    // error-reporting-allow: typed-recovery an observation getter may throw raw secrets, so only the finite serialization failure crosses this redaction boundary
    Effect.try({
      try: () => {
        const seen = new WeakSet<object>();
        const visit = (item: unknown): unknown => {
          if (typeof item === "string") return redact(item);
          if (item === null || typeof item !== "object") return item;
          if (seen.has(item)) throw new Error("Observation must be JSON serializable");
          seen.add(item);
          const result: unknown = Array.isArray(item)
            ? item.map(visit)
            : Object.fromEntries(
                Object.entries(item).map(([key, entry]) => [redact(key), visit(entry)]),
              );
          seen.delete(item);
          return result;
        };
        return visit(value);
      },
      catch: () => new Error("Observation must be JSON serializable"),
    });
  return { register, redact, redactCut, assertAbsent, json, clear: () => values.clear() };
};
