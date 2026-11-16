// Minimal JS glue for the plain C-ABI placematch WASM (no wasm-bindgen). It runs anywhere
// WebAssembly does and reads nothing but the bytes it is given.
const SEPARATOR = "\u0001";

/** The longest query or row text, in UTF-16 code units (JavaScript string length), and the most
 * rows, that a call takes. Longer input is refused with a RangeError, never cut: matching time grows
 * quickly with text length, and an address or a site's row is far shorter. */
export const LIMITS = Object.freeze({ textLength: 512, rows: 100 });

const checkText = (what, s) => {
  if (typeof s !== "string") throw new TypeError(`${what} must be a string`);
  if (s.length > LIMITS.textLength) throw new RangeError(`${what} is ${s.length} characters; PlaceMatch takes at most ${LIMITS.textLength}`);
};

const NONE = Object.freeze({ outcome: "none", index: null, same: [], reasons: [], notes: [], cross_script: false, prefer_on_read: null, rows: [] });

export async function load(bytes) {
  const t0 = performance.now();
  const mod = await WebAssembly.compile(bytes);
  const t1 = performance.now();
  let x = (await WebAssembly.instantiate(mod, {})).exports;
  const t2 = performance.now();
  x.am_init();
  const t3 = performance.now();
  // a call that traps leaves the instance's memory as the trap found it: replace the instance
  let pending = null;
  const restart = () => {
    x = null;
    try {
      const fresh = new WebAssembly.Instance(mod, {}).exports;
      fresh.am_init();
      x = fresh;
    } catch {
      // where a large module cannot be instantiated synchronously (a browser's main thread)
      pending = WebAssembly.instantiate(mod, {}).then((i) => {
        i.exports.am_init();
        x = i.exports;
        pending = null;
      });
    }
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // call export `name` with the texts written into the module's memory, freed on every path
  const call = (name, texts, read) => {
    if (!x) throw new Error("PlaceMatch is reloading after an internal error; try again");
    const args = [];
    try {
      for (const t of texts) {
        const b = enc.encode(t || "");
        const p = x.am_alloc(b.length || 1);
        args.push([p, b.length]);
        new Uint8Array(x.memory.buffer, p, b.length).set(b);
      }
      const r = x[name](...args.flat());
      return read ? read(r) : r;
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        args.length = 0;
        restart();
      }
      throw error;
    } finally {
      for (const [p, n] of args) x.am_free(p, n || 1);
    }
  };
  const flag = (name, query, row, country) => {
    checkText("the query", query);
    checkText("the row", row);
    return call(name, [query, row, country]) === 1;
  };
  const joined = (texts) => {
    if (texts.length > LIMITS.rows) throw new RangeError(`${texts.length} rows; PlaceMatch takes at most ${LIMITS.rows}`);
    for (const t of texts) {
      if (typeof t !== "string") throw new TypeError("each row must be a string or { text, categorized }");
      if (t.includes(SEPARATOR)) throw new TypeError("row text must not contain U+0001");
      checkText("a row", t);
    }
    return texts.join(SEPARATOR);
  };
  return {
    timings: { compileMs: t1 - t0, instantiateMs: t2 - t1, initMs: t3 - t2 },
    /** Bytes of WebAssembly memory in use (it grows, never shrinks). */
    memoryBytes() {
      return x ? x.memory.buffer.byteLength : 0;
    },
    pick(query, candidates, country) {
      checkText("the query", query);
      const r = call("am_pick", [query, joined(candidates), country]);
      return r >= 0 ? { outcome: "match", index: r } : r === -1 ? { outcome: "none", index: null } : { outcome: "ambiguous", index: null };
    },
    compare(a, b, country) {
      checkText("the query", a);
      checkText("the candidate", b);
      return ["different", "same", "unknown"][call("am_compare", [a, b, country])];
    },
    /**
     * The outcome with the rows that are the caller's place, each row's verdict and reasons, why an
     * ambiguous answer asks, notes beside a match, and the row a read may take (`prefer_on_read`).
     * `rows`: strings, or `{ text, categorized }` where `categorized` says the site shows the row
     * with a category of its own (a venue type), as it does not for a dropped pin. `options` may
     * be omitted or null. Input over `LIMITS` throws a RangeError.
     */
    pickExplained(query, rows, options) {
      checkText("the query", query);
      const country = options?.country;
      if (rows.length === 0) return { ...NONE, same: [], reasons: [], notes: [], rows: [] };
      const texts = rows.map((r) => (typeof r === "string" ? r : r?.text));
      const flags = rows.map((r) => (typeof r === "object" && r?.categorized ? "1" : "0")).join("");
      return JSON.parse(call("am_pick_explained", [query, joined(texts), country, flags], (p) => dec.decode(new Uint8Array(x.memory.buffer, p, x.am_out_len()))));
    },
    /** The row is a site's control ("See more results for <text>", "Search "<text>""), never a place. */
    isControl(query, row) {
      return flag("am_is_control", query, row, "");
    },
    /** The row shows the caller's whole text (of two parts or more) after at least `minWords`
     * words of its own first part ("The <text>"). */
    showsTypedText(query, row, minWords = 1) {
      if (!Number.isInteger(minWords) || minWords < 0) throw new RangeError("minWords must be a whole number");
      return flag("am_shows_typed_text", query, row, String(minWords));
    },
    /** The row, after its first part, is in the area the caller gave after theirs. */
    inArea(query, row, country) {
      return flag("am_in_area", query, row, country);
    },
    /** The caller's house, street and town with only the postcode different, in the same postal
     * area and district: the same building under another postcode, which a read may accept. */
    sameButPostcode(query, row, country) {
      return flag("am_same_but_postcode", query, row, country);
    },
  };
}
