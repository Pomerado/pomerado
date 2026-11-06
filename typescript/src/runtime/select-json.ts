/**
 * Selective reads of large JSON data, such as a page's embedded state or a saved response.
 *
 * `selectJson(input, select, options?)` returns only the values `select` names, each as an
 * array of its matches in document order. `input` is JSON text, which it scans without parsing
 * the parts it skips, or a value already in memory, such as a page's global state object, which it
 * walks. Either way it never copies the whole data: memory grows with what it returns, not with
 * the data's size, and it stops as soon as every selection has reached its `limit`.
 *
 * `select` maps each result name to a path, or to `{ path, fields?, limit?, outline? }`:
 *
 * - `path` is a list of keys, or one string of them joined with dots. An array's items are keyed
 *   by their index (`"0"`, `"1"`, ...). `"*"` matches any one key or index, and `"**"` any run of
 *   them, none included. `""` is the whole data.
 * - `fields` maps output names to paths inside each match. Each match then returns a record of
 *   those fields only, the first value each path finds, or `null` where it finds none, and the
 *   parts of the match no field names are skipped, never parsed.
 * - `limit` stops a selection after that many matches.
 * - `outline: depth` returns each match's shape instead of its value: its `type`, its size in
 *   `chars` (JSON text only), an object's `keys` count and its first `maxKeys` (default 40) keys'
 *   outlines as `children`, an array's `length` and its `first` item's outline, and a short
 *   `preview` of a string, number, boolean or null. Each level down spends one depth. Use it to
 *   find where the wanted values are in data too large to read whole.
 *
 * ```js
 * const { store, items } = selectJson(text, {
 *   store: { path: "props.pageProps.store.name", limit: 1 },
 *   items: {
 *     path: "props.pageProps.store.sections.*.items.*",
 *     fields: { id: "id", name: "title", price: "price.amount" },
 *     limit: 200,
 *   },
 * });
 * ```
 *
 * Options: `after`, for JSON text that follows other text such as `window.__STATE__ = `, starts
 * at the first object or array after that marker (the first one in the text without it); and
 * `maxChars` (default 8,000,000) bounds the size of everything returned.
 *
 * It throws an `Error` named `PageDataFailure` with a `reason`, and a message that carries
 * counts, never the data's text:
 *
 * - `not_json`: the text holds no object or array, or ends or breaks inside one (`at`, the
 *   character index).
 * - `not_found`: the `after` marker is not in the text.
 * - `too_large`: what it would return is over `maxChars` (`maxChars`, and `field`, the result
 *   name that crossed it). Select fewer fields, or set a `limit`.
 *
 * The function refers to nothing outside its own body, so `pageDataCode` pastes its source into
 * the page.
 */
export function selectJson(
  input: unknown,
  select: Readonly<Record<string, JsonPath | JsonSelection>>,
  options?: SelectJsonOptions,
): Record<string, unknown[]> {
  interface Entry {
    readonly name: string;
    readonly segs: readonly string[];
    readonly limit: number;
    readonly outline: number | undefined;
    readonly values: unknown[];
    fields: number[] | undefined;
    readonly parent: Entry | undefined;
  }
  type Outline = Record<string, unknown>;
  const settings = options ?? {};
  const maxChars = settings.maxChars ?? 8_000_000;
  const maxKeys = settings.maxKeys ?? 40;
  const failure = (reason: string, message: string, detail: Record<string, unknown>) =>
    Object.assign(new Error(reason + ": " + message), { name: "PageDataFailure", reason, ...detail });
  const segments = (path: unknown): string[] => {
    if (Array.isArray(path)) return path.map(String);
    if (typeof path !== "string") throw new TypeError("a path is a string or a list of keys");
    return path === "" ? [] : path.split(".");
  };
  const entries: Entry[] = [];
  for (const name of Object.keys(select)) {
    const raw = select[name];
    const spec = (typeof raw === "string" || Array.isArray(raw) ? { path: raw } : raw) as JsonSelection;
    const limit = spec.limit ?? Infinity;
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1))
      throw new TypeError("limit must be a positive integer");
    if (spec.outline !== undefined && (!Number.isInteger(spec.outline) || spec.outline < 0))
      throw new TypeError("outline must be a depth of 0 or more");
    if (spec.outline !== undefined && spec.fields !== undefined)
      throw new TypeError("a selection takes fields or outline, not both");
    const entry: Entry = {
      name,
      segs: segments(spec.path),
      limit,
      outline: spec.outline,
      values: [],
      fields: undefined,
      parent: undefined,
    };
    entries.push(entry);
    if (spec.fields !== undefined) {
      const fields: number[] = [];
      for (const field of Object.keys(spec.fields)) {
        fields.push(entries.length);
        entries.push({
          name: field,
          segs: segments(spec.fields[field]),
          limit: 1,
          outline: undefined,
          values: [],
          fields: undefined,
          parent: entry,
        });
      }
      entry.fields = fields;
    }
  }
  const at = (index: number) => entries[index] as Entry;
  // Matching runs every selection's path at once: a state is a pair, a selection's index and how
  // many of its path's keys the keys walked so far have matched.
  const full = (entry: Entry) => entry.parent === undefined && entry.values.length >= entry.limit;
  const globbed = entries.some((entry) => entry.segs.includes("**"));
  const closure = (states: number[]) => {
    if (!globbed) return states;
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (e: number, p: number) => {
      if (seen.has(e * 4096 + p)) return;
      seen.add(e * 4096 + p);
      out.push(e, p);
      if (at(e).segs[p] === "**") add(e, p + 1);
    };
    for (let k = 0; k < states.length; k += 2) add(states[k] as number, states[k + 1] as number);
    return out;
  };
  const step = (states: number[], key: string) => {
    const next: number[] = [];
    for (let k = 0; k < states.length; k += 2) {
      const e = states[k] as number;
      const p = states[k + 1] as number;
      const entry = at(e);
      if (p >= entry.segs.length || full(entry)) continue;
      const seg = entry.segs[p];
      if (seg === "**") next.push(e, p);
      else if (seg === "*" || seg === key) next.push(e, p + 1);
    }
    return next.length === 0 ? next : closure(next);
  };
  let open = entries.filter((entry) => entry.parent === undefined).length;
  let taken = 0;
  const stop = {};
  const sizeOf = (value: unknown, depth: number): number => {
    if (typeof value === "string") return value.length + 2;
    if (value === null || typeof value !== "object" || depth > 64) return 8;
    let size = 2;
    for (const key of Object.keys(value))
      size += key.length + 4 + sizeOf((value as Record<string, unknown>)[key], depth + 1);
    return size;
  };
  const count = (size: number, name: string) => {
    taken += size;
    if (taken > maxChars)
      throw failure(
        "too_large",
        "the selected data is over " + maxChars + " characters; select fewer fields or set a limit",
        { maxChars, field: name },
      );
  };
  const records = new Map<Entry, Record<string, unknown>>();
  // What a value matched: the selections it completes, and whether some path goes on below it.
  const matched = (states: number[]) => {
    let descend = false;
    let complete: Entry[] | undefined;
    for (let k = 0; k < states.length; k += 2) {
      const entry = at(states[k] as number);
      if (full(entry)) continue;
      if (states[k + 1] !== entry.segs.length) descend = true;
      else if (entry.parent === undefined || !(entry.name in (records.get(entry.parent) ?? {})))
        (complete ??= []).push(entry);
    }
    // A selection that names fields starts its record here and looks for them inside.
    let saved: [Entry, Record<string, unknown> | undefined][] | undefined;
    if (complete !== undefined)
      for (const entry of complete)
        if (entry.fields !== undefined) {
          (saved ??= []).push([entry, records.get(entry)]);
          records.set(entry, {});
          const extra: number[] = [];
          for (const field of entry.fields) extra.push(field, 0);
          states = closure(states.concat(extra));
          descend = true;
        }
    return { descend, complete, saved, states };
  };
  const settle = (
    complete: Entry[],
    saved: [Entry, Record<string, unknown> | undefined][] | undefined,
    read: (name: string) => unknown,
    outline: (depth: number) => Outline,
    size: number | undefined,
  ) => {
    for (const entry of complete) {
      if (entry.parent !== undefined) {
        (records.get(entry.parent) as Record<string, unknown>)[entry.name] = read(entry.parent.name);
        continue;
      }
      let item: unknown;
      if (entry.outline !== undefined) {
        item = outline(entry.outline);
        count(sizeOf(item, 0), entry.name);
      } else if (entry.fields === undefined) {
        item = read(entry.name);
        count(size ?? sizeOf(item, 0), entry.name);
      } else {
        const record = records.get(entry) as Record<string, unknown>;
        for (const field of entry.fields) if (!(at(field).name in record)) record[at(field).name] = null;
        item = record;
        count(sizeOf(record, 0), entry.name);
      }
      entry.values.push(item);
      if (entry.values.length >= entry.limit && --open === 0) throw stop;
    }
    if (saved !== undefined)
      for (const [entry, record] of saved)
        if (record === undefined) records.delete(entry);
        else records.set(entry, record);
  };
  const initial: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.parent === undefined) initial.push(index, 0);
  });

  if (typeof input !== "string") {
    // A value in memory: walk it, visiting each object once.
    const seen = new WeakSet<object>();
    const outlineOf = (value: unknown, depth: number): Outline => {
      if (Array.isArray(value)) {
        const node: Outline = { type: "array", length: value.length };
        if (depth > 0 && value.length > 0) node.first = outlineOf(value[0], depth - 1);
        return node;
      }
      if (value !== null && typeof value === "object") {
        const keys = Object.keys(value);
        const node: Outline = { type: "object", keys: keys.length };
        if (depth > 0) {
          const children: Outline = {};
          for (const key of keys.slice(0, maxKeys))
            children[key] = outlineOf((value as Record<string, unknown>)[key], depth - 1);
          node.children = children;
          if (keys.length > maxKeys) node.more = keys.length - maxKeys;
        }
        return node;
      }
      if (typeof value === "string")
        return { type: "string", chars: value.length, preview: value.slice(0, 60) };
      return { type: value === null ? "null" : typeof value, preview: String(value).slice(0, 60) };
    };
    const visit = (value: unknown, states: number[]) => {
      const found = matched(states);
      if (found.descend && value !== null && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        const keys = Array.isArray(value) ? value.map((_, index) => String(index)) : Object.keys(value);
        for (const key of keys) {
          const next = step(found.states, key);
          if (next.length > 0) visit((value as Record<string, unknown>)[key], next);
        }
        seen.delete(value);
      }
      if (found.complete !== undefined)
        settle(found.complete, found.saved, () => value, (depth) => outlineOf(value, depth), undefined);
    };
    try {
      visit(input, closure(initial));
    } catch (error) {
      if (error !== stop) throw error;
    }
  } else {
    // JSON text: scan it, skipping every value no path goes into without parsing it.
    const text = input;
    const n = text.length;
    const ws = (i: number) => {
      let c = text.charCodeAt(i);
      while (c === 32 || c === 10 || c === 13 || c === 9) c = text.charCodeAt(++i);
      return i;
    };
    const stringEnd = (i: number) => {
      let j = i + 1;
      for (;;) {
        const k = text.indexOf('"', j);
        if (k < 0) throw failure("not_json", "the data ends inside a string", { at: i });
        let backslashes = 0;
        while (text.charCodeAt(k - 1 - backslashes) === 92) backslashes++;
        if (backslashes % 2 === 0) return k + 1;
        j = k + 1;
      }
    };
    const structural = /["[\]{}]/g;
    const primitiveEnd = /[,\]}\s]/g;
    const skip = (i: number) => {
      const c = text.charCodeAt(i);
      if (c === 34) return stringEnd(i);
      if (c === 123 || c === 91) {
        let depth = 0;
        structural.lastIndex = i;
        for (;;) {
          const m = structural.exec(text);
          if (m === null) throw failure("not_json", "the data ends inside a value", { at: i });
          const ch = text.charCodeAt(m.index);
          if (ch === 34) structural.lastIndex = stringEnd(m.index);
          else if (ch === 123 || ch === 91) depth++;
          else if (--depth === 0) return m.index + 1;
        }
      }
      if (Number.isNaN(c)) throw failure("not_json", "the data ends before a value", { at: i });
      primitiveEnd.lastIndex = i;
      const m = primitiveEnd.exec(text);
      return m === null ? n : m.index;
    };
    // Walks an object's members or an array's items from its opening character at `i`, calling
    // `member` with each key and the index of its value, which returns where the value ends.
    const members = (i: number, member: (key: string, j: number) => number) => {
      const object = text.charCodeAt(i) === 123;
      const close = object ? 125 : 93;
      let j = ws(i + 1);
      if (text.charCodeAt(j) === close) return j + 1;
      for (let index = 0; ; index++) {
        let key = String(index);
        if (object) {
          if (text.charCodeAt(j) !== 34) throw failure("not_json", "an object key is not a string", { at: j });
          const keyEnd = stringEnd(j);
          key = text.slice(j + 1, keyEnd - 1);
          if (key.includes("\\")) key = JSON.parse(text.slice(j, keyEnd)) as string;
          j = ws(keyEnd);
          if (text.charCodeAt(j) !== 58) throw failure("not_json", "an object key has no colon", { at: j });
          j = ws(j + 1);
        }
        j = ws(member(key, j));
        const ch = text.charCodeAt(j);
        if (ch === 44) j = ws(j + 1);
        else if (ch === close) return j + 1;
        else throw failure("not_json", object ? "an object is not closed" : "an array is not closed", { at: j });
      }
    };
    const outlineAt = (i: number, depth: number): [number, Outline] => {
      const c = text.charCodeAt(i);
      if (c === 123) {
        const children: Outline = {};
        let keys = 0;
        const end = members(i, (key, j) => {
          keys++;
          if (depth === 0 || keys > maxKeys) return skip(j);
          const [childEnd, child] = outlineAt(j, depth - 1);
          children[key] = child;
          return childEnd;
        });
        const node: Outline = { type: "object", chars: end - i, keys };
        if (depth > 0) node.children = children;
        if (depth > 0 && keys > maxKeys) node.more = keys - maxKeys;
        return [end, node];
      }
      if (c === 91) {
        let length = 0;
        let first: Outline | undefined;
        const end = members(i, (_, j) => {
          length++;
          if (depth === 0 || length > 1) return skip(j);
          const [itemEnd, item] = outlineAt(j, depth - 1);
          first = item;
          return itemEnd;
        });
        const node: Outline = { type: "array", chars: end - i, length };
        if (first !== undefined) node.first = first;
        return [end, node];
      }
      const end = skip(i);
      if (c === 34) {
        const preview =
          end - i < 4096 ? (JSON.parse(text.slice(i, end)) as string).slice(0, 60) : text.slice(i + 1, i + 61);
        return [end, { type: "string", chars: end - i - 2, preview }];
      }
      const raw = text.slice(i, end);
      const type = raw === "null" ? "null" : raw === "true" || raw === "false" ? "boolean" : "number";
      return [end, { type, preview: raw.slice(0, 60) }];
    };
    const value = (i: number, states: number[]): number => {
      i = ws(i);
      const found = matched(states);
      const c = text.charCodeAt(i);
      const end =
        found.descend && (c === 123 || c === 91)
          ? members(i, (key, j) => {
              const next = step(found.states, key);
              return next.length === 0 ? skip(j) : value(j, next);
            })
          : skip(i);
      if (found.complete !== undefined) {
        let parsed: unknown;
        let read = false;
        settle(
          found.complete,
          found.saved,
          (name) => {
            if (!read) {
              if (end - i > maxChars) count(end - i, name);
              parsed = JSON.parse(text.slice(i, end));
              read = true;
            }
            return parsed;
          },
          (depth) => outlineAt(i, depth)[1],
          end - i,
        );
      }
      return end;
    };
    let start = 0;
    if (settings.after !== undefined) {
      const marker = text.indexOf(settings.after);
      if (marker < 0) throw failure("not_found", "the text it was told to start after is missing", {});
      start = marker + settings.after.length;
    }
    const opening = /[[{]/g;
    opening.lastIndex = start;
    const first = opening.exec(text);
    if (first === null) throw failure("not_json", "the text holds no JSON object or array", {});
    try {
      value(first.index, closure(initial));
    } catch (error) {
      if (error !== stop) throw error;
    }
  }
  const result: Record<string, unknown[]> = {};
  for (const entry of entries) if (entry.parent === undefined) result[entry.name] = entry.values;
  return result;
}

/** A path of keys, as a list or joined with dots. `"*"` is any one key, `"**"` any run of them. */
export type JsonPath = string | readonly (string | number)[];

/** One selection: its path, and optionally the fields it keeps, its limit or an outline. */
export interface JsonSelection {
  readonly path: JsonPath;
  readonly fields?: Readonly<Record<string, JsonPath>>;
  readonly limit?: number;
  readonly outline?: number;
}

export interface SelectJsonOptions {
  /** JSON text: start at the first object or array after this marker. */
  readonly after?: string;
  /** The most characters everything returned may hold. Default 8,000,000. */
  readonly maxChars?: number;
  /** An outline's most keys listed per object. Default 40. */
  readonly maxKeys?: number;
}
