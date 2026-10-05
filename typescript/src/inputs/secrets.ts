import { Effect } from "effect";

/** Explicit caller secrets live only for this run. This does not detect or classify page data. */
export const makeRunSecrets = () => {
  const values = new Set<string>();
  const register = (value: string) => {
    if (value.length === 0) return;
    values.add(value);
    values.add(encodeURIComponent(value));
    values.add(JSON.stringify(value).slice(1, -1));
  };
  const ordered = () => [...values].sort((left, right) => right.length - left.length);
  const redact = (text: string) =>
    ordered().reduce((result, secret) => result.split(secret).join("[private]"), text);
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
  return { register, redact, assertAbsent, json, clear: () => values.clear() };
};
