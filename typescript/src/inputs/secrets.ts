import { Effect } from "effect";

/**
 * A quoted value in a page's accessibility snapshot, escaped as Playwright's YAML writer does: a
 * backslash, a double quote and `\b\f\n\r\t` as escapes, and every other control character as
 * `\xNN`.
 */
const yamlValueEscaped = (form: string) =>
  form.replace(/[\\"\x00-\x1f\x7f-\x9f]/gu, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    }
  });

/**
 * The characters a browser percent-encodes in each part of a URL it shows, beyond control
 * characters, space and anything outside ASCII, which every part encodes.
 */
const urlPartEncoded = { query: `"#<>'`, path: '"#<>?`{}', fragment: '"<>`' };
/** `form` as a browser writes it into one part of a URL: UTF-8, uppercase hex. */
const percentEncoded = (form: string, encoded: string) =>
  [...new TextEncoder().encode(form)]
    .map((byte) =>
      byte <= 0x20 || byte >= 0x7f || encoded.includes(String.fromCharCode(byte))
        ? `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
        : String.fromCharCode(byte),
    )
    .join("");
const lowercaseHex = (encoded: string) =>
  encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());

/** Explicit caller secrets live only for this run. This does not detect or classify page data. */
export const makeRunSecrets = () => {
  const values = new Set<string>();
  /**
   * Each form a page or URL can show the value in. The value as given, trimmed, and with its
   * whitespace collapsed as an accessibility snapshot shows it; each of them as written,
   * JSON-escaped, escaped as a snapshot's quoted value, and with each `'` doubled as a snapshot's
   * quoted key holds a name; and percent-encoded as `encodeURIComponent`, a form and each part of
   * a URL write it, in uppercase and lowercase hex. A value that cannot be encoded, such as one
   * holding a lone surrogate, keeps every other form.
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
      const json = JSON.stringify(form).slice(1, -1);
      const forms = [
        form,
        json,
        yamlValueEscaped(form),
        form.replaceAll("'", "''"),
        json.replaceAll("'", "''"),
      ];
      if (form.isWellFormed()) {
        const percent = [
          encodeURIComponent(form),
          new URLSearchParams([["", form]]).toString().slice(1),
          ...Object.values(urlPartEncoded).map((encoded) => percentEncoded(form, encoded)),
        ];
        forms.push(...percent, ...percent.map(lowercaseHex));
      }
      for (const shownForm of forms) values.add(shownForm);
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
