import { describe, expect, it } from "vitest";
import {
  applyOutputOverrides,
  controlLabelsFromAriaSnapshot,
  lintOutput,
  type OutputCheck,
} from "../../src/runtime/output-lint.js";

const checksOf = (output: unknown, options?: Parameters<typeof lintOutput>[1]) =>
  lintOutput(output, options).map(({ path, check }) => `${path} ${check}`);
const checkOf = (value: string, options?: Parameters<typeof lintOutput>[1]) =>
  lintOutput({ value }, options).map(({ check }) => check);

describe("output checks of one string", () => {
  const positives: readonly (readonly [OutputCheck, string])[] = [
    ["script", "var data = window.__state || {}; init(data);"],
    ["script", "function render(items) { return items.map(format); }"],
    ["script", "if (window.dataLayer) window.dataLayer.push({event:'view'});"],
    ["css", ".price{color:#b12704;font-size:18px}"],
    ["css", "@media (max-width: 600px) { .card { display: block; } }"],
    ["css", "margin: 0; padding: 4px; border: none;"],
    ["markup", "Free returns<br/>on most items"],
    ["markup", "Fish &amp; chips"],
    ["template_residue", "undefined"],
    ["template_residue", "Colour: undefined"],
    ["template_residue", "[object Object]"],
    ["template_residue", "Hello {{name}}"],
    ["template_residue", "Total ${amount}"],
    ["json_text", '{"sku":"A1","price":3}'],
    ["invisible_chars", "Blue\u200B shirt"],
    ["untrimmed", " leading space"],
    ["duplicate_entries", "Customer reviews Customer reviews"],
    // Script and style shapes text read from a container that holds a script or style comes out in.
    ["script", 'Blue mug {"@context":"https://schema.org","@type":"Product","name":"Blue mug"} $12.00'],
    ["script", 'Blue mug {"sku":"A1","price":12,"currency":"USD"} in stock'],
    ["script", 'self.__next_f.push([1,"abc"])'],
    ["script", "gtag('config', 'G-ABC123');"],
    ["script", "try{Typekit.load({async:true})}catch(e){}"],
    ["script", "requestAnimationFrame(() => init())"],
    ["script", "Rated 4.5 window.dataLayer = window.dataLayer || [];"],
    ["script", "if(a){b=c;}else{d();}return e;"],
    ["css", ".css-1x2y3z{display:flex}"],
    ["css", "Blue mug .a{display:flex}.b{margin:0} $12"],
    ["css", ":root{--brand:#123}"],
    ["css", "@media screen and (min-width: 40em) { .grid { gap: 8px } }"],
    ["css", "@font-face{font-family:Brand;src:url(/f.woff2)}"],
    ["markup", 'See <a href="/terms">terms</a>'],
    ["markup", "<p>Free returns</p>"],
    ["markup", '<x-price value="12">'],
    ["template_residue", "Price: $NaN"],
    // Tight single rules, comments and bootstrap calls.
    ["css", ".x{color:red}"],
    ["css", "a:hover{text-decoration:underline}"],
    ["css", ".x-1{opacity:.5}"],
    ["css", ".hdr{z-index:2}"],
    ["css", "h1{font-family:Inter,sans-serif}"],
    ["markup", "Blue mug <!-- react-text: 12 --> $12"],
    ["script", "_satellite.pageBottom();"],
    ["script", 'if(typeof window!=="undefined"){init()}'],
  ];
  it.each(positives)("flags %s in %j", (check, value) => {
    expect(checkOf(value)).toContain(check);
  });

  it("leaves ordinary page text alone", () => {
    const corpus = [
      "2 for $9; limit 4 per order",
      "Rated 4.7 out of 5 (1,203 reviews)",
      "C++ Primer, 5th edition",
      "null and void",
      "Ships in 3-5 days (some exclusions apply)",
      "Size: M; Colour: navy",
      "The set {x: x > 0} is open",
      "Read the document.pdf attached",
      "Save 20% = $12.00 off",
      "Wait... what? Find out tonight at 9.",
      "Downstairs: kitchen, lounge; upstairs: two bedrooms",
      "<3 years old",
    ];
    for (const value of corpus) expect(checkOf(value), value).toEqual([]);
  });

  it("never blocks page text that only resembles code", () => {
    const corpus = [
      "Dimensions (L x W x H): 10 x 5 x 3 in; Weight (lbs): 2.5; Material (outer): nylon; Color (main): black",
      "Price: $12.99 (was $19.99) (save 35%) (limited time) (members only) (in store) (online)",
      "Return policy: 30 days (unopened); 15 days (opened); exchanges (any time); see terms (below)",
      "Smith (2019); Jones (2020); Lee (2021); Park (2022); Chen (2023); Diaz (2024); Kim (2025)",
      "Download document.final.pdf now",
      "Save on window.cleaner.co supplies",
      "let x = 5 and solve for y",
      "size: M; color: navy; fit: slim; care: hand wash",
      "calories: 200; fat: 10g; sodium: 300mg; sugar: 5g",
      "width: 10 in; height: 5 in; depth: 3 in",
      "Contact press@media.example.com",
      "The behavior is undefined.",
      "Division by zero is undefined in arithmetic",
      "If a<b and c>d then swap",
      "Cable <USB-C> to <Lightning> adapter",
      "Choose a size {S, M, L}; then a colour {red, blue}",
      "Steps: mix (2 min); rest (10 min); bake (25 min) => serve",
      "Use code SAVE10 at checkout (one per order); not valid on gift cards",
      "A {great} deal: 2 for 1",
      "Free shipping {on orders over $50}",
      "{name}@example.com",
      "Width: 100%; Height: auto; Color: black; Border: none",
      "Opacity: 0; Visibility: hidden; Display: none",
      "Let x = 3; then y = 2x + 1 = 7;",
      "Rich & Famous <3",
      "AT&T <Unlimited>",
      "<0.5% alcohol and >20% protein",
      "Value is NaN in this context",
      "In the box {cable; charger; manual; case; strap; cloth}",
    ];
    for (const value of corpus)
      expect(
        lintOutput({ value }).filter((finding) => finding.blocking),
        value,
      ).toEqual([]);
  });

  it("keeps zero-width joiners, which are part of correct spelling and emoji", () => {
    expect(checkOf("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645")).toEqual([]);
    expect(checkOf("Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} pass")).toEqual([]);
    expect(checkOf("Blue\u00AD shirt")).toEqual(["invisible_chars"]);
  });

  it("keeps a declared code or markup field's findings, never blocking, naming the declared type", () => {
    const outputSchema = {
      type: "object",
      properties: {
        script: { type: "string", contentMediaType: "text/javascript" },
        style: { type: "string", contentMediaType: "text/css" },
        page: { type: "string", contentMediaType: "text/html" },
        data: { type: "string", contentMediaType: "application/json" },
      },
    };
    const findings = lintOutput(
      {
        script: "const total = values.reduce((sum, value) => sum + value, 0);",
        style: ".a{display:flex}",
        page: "<p>Hello</p>",
        data: '{"a":1}',
      },
      { outputSchema },
    );
    expect(findings.map(({ path, check, blocking }) => `${path} ${check} ${blocking}`)).toEqual([
      "script script false",
      "style css false",
      "page markup false",
      "data json_text false",
    ]);
    for (const finding of findings) expect(finding.override).toContain("contentMediaType");
  });

  it("never lets prose or an unrelated media type waive a leak", () => {
    for (const contentMediaType of ["text/markdown", "application/x-www-form-urlencoded", "text/x-anything"]) {
      const outputSchema = {
        type: "object",
        properties: { value: { type: "string", contentMediaType } },
      };
      const findings = lintOutput(
        { value: "About <script>var a = 1;</script> function(){ return 1; }" },
        { outputSchema },
      );
      expect(findings.filter((finding) => finding.blocking).map(({ check }) => check), contentMediaType).toContain(
        "script",
      );
    }
  });

  it("flags a long string in a list's record, unless its schema allows that length", () => {
    const long = Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ");
    expect(checksOf({ results: [{ text: long }] })).toContain("results[].text too_long");
    const outputSchema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: { $ref: "#/$defs/row" },
        },
      },
      $defs: { row: { type: "object", properties: { text: { type: "string", maxLength: 5000 } } } },
    };
    expect(checksOf({ results: [{ text: long }] }, { outputSchema })).not.toContain(
      "results[].text too_long",
    );
    expect(checksOf({ text: long })).toEqual([]);
  });

  it("flags text that ends with a page control's label or holds one on its own line", () => {
    const controlLabels = ["Show more", "Add to cart"];
    expect(checkOf("A bright room facing the garden. Show more", { controlLabels })).toEqual([
      "collapsed_text",
    ]);
    expect(checkOf("A bright room facing the garden with a desk Show more", { controlLabels })).toEqual([
      "collapsed_text",
    ]);
    expect(checkOf("Registration\nSTR-0001\nShow more", { controlLabels })).toEqual([
      "collapsed_text",
    ]);
    // A value that is only the label, or holds its words inside a sentence, is not.
    expect(checkOf("Show more", { controlLabels })).toEqual([]);
    expect(checkOf("Show more of the garden from the balcony", { controlLabels })).toEqual([]);
  });

  it("matches only a page's expand controls, never its navigation or a record's own title", () => {
    const controlLabels = ["Women", "Sale", "Home", "More", "Kids", "Books", "Blue mug", "Add to cart"];
    for (const value of [
      "Running Shoes for Women",
      "Garden Plants for Sale",
      "Welcome Home",
      "Less is More",
      "Acme Blue mug",
      "Blue mug $12\nAdd to cart",
    ])
      expect(checkOf(value, { controlLabels }), value).toEqual([]);
    // A one-word "more" control counts after an ellipsis or on its own line.
    expect(checkOf("A bright room facing the garden\u2026 More", { controlLabels })).toEqual([
      "collapsed_text",
    ]);
    // A label that is also a whole value in the output, such as a record's title link, is content.
    expect(
      checksOf({ results: [{ title: "Full details" }, { title: "A quiet room. Full details" }] }, {
        controlLabels: ["Full details"],
      }),
    ).toEqual([]);
  });

  it("flags a value that ends with an expand control's words, whatever controls the page showed", () => {
    for (const value of [
      "A mug with a wide handle and\u2026 Read more",
      "A mug with a wide handle Show more",
      "A mug with a wide handle. See more \u203A",
      "A mug with a wide handle and\u2026 more",
    ])
      expect(checkOf(value), value).toEqual(["collapsed_text"]);
    for (const value of ["Read more", "You should read more", "Show more of the garden", "Learn more about it"])
      expect(checkOf(value), value).toEqual([]);
  });

  it("flags an ending ellipsis only when the page offered a control to expand it", () => {
    const snippet = "Install the package, then call setup with your key and\u2026";
    expect(checkOf(snippet)).toEqual([]);
    expect(checkOf(snippet, { controlLabels: ["Next page"] })).toEqual([]);
    expect(checkOf(snippet, { controlLabels: ["Read more"] })).toEqual(["collapsed_text"]);
  });

  it("leaves a card_text section's control labels and ellipses alone", () => {
    const controlLabels = ["Show more"];
    expect(
      checksOf({ results: [{ title: "Blue mug", card_text: "Blue mug\nA mug with a\u2026\nShow more" }] }, {
        controlLabels,
      }),
    ).toEqual([]);
  });

  it("only samples when asked, and cuts a sample to 80 characters", () => {
    const value = `${"x".repeat(100)} var a = 1;`;
    expect(lintOutput({ value })[0]?.sample).toBeUndefined();
    expect(lintOutput({ value }, { samples: true })[0]?.sample).toHaveLength(80);
  });
});

describe("output checks across a list's records", () => {
  const rows = [
    { title: "Blue mug", price: 12, brand: "Acme", seller: "Shop A", note: null },
    { title: "Red mug", price: 14, brand: "Acme", seller: "Shop B", note: null },
    { title: "Green mug", price: 9, brand: "Acme", seller: "Shop C", note: "" },
  ];

  it("flags a field that never varies, one that is always empty, and repeated records", () => {
    const findings = checksOf({ results: [...rows, rows[0]] });
    expect(findings).toContain("results[].brand constant_field");
    expect(findings).toContain("results[].note empty_field");
    expect(findings).toContain("results duplicate_records");
    expect(findings).not.toContain("results[].title constant_field");
  });

  it("leaves a field the schema declares as a closed set, and fewer than three records, alone", () => {
    const outputSchema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: { type: "object", properties: { brand: { type: "string", enum: ["Acme"] } } },
        },
      },
    };
    expect(checksOf({ results: rows }, { outputSchema })).not.toContain(
      "results[].brand constant_field",
    );
    expect(checksOf({ results: rows.slice(0, 2) })).toEqual([]);
  });

  it("flags one field holding most of its siblings' values: a whole card's text", () => {
    const cards = rows.map((row) => ({
      ...row,
      text: `${row.title} by ${row.brand} $${row.price} sold by ${row.seller} Add to cart`,
    }));
    expect(checksOf({ results: cards })).toContain("results[].text card_text");
    // A title that names a brand and a colour is not a card's text.
    const titled = rows.map((row, index) => ({
      ...row,
      colour: ["Blue", "Red", "Green"][index],
      size: "12 oz",
      title: `${row.brand} ${row.title} 12 oz`,
    }));
    expect(checksOf({ results: titled })).not.toContain("results[].title card_text");
  });

  it("flags repeated entries in a list of strings", () => {
    expect(checksOf({ tags: ["New", "Sale", "New"] })).toEqual(["tags[] duplicate_entries"]);
  });
});

describe("overrides", () => {
  it("keeps an overridden finding with its reason and stops it blocking", () => {
    const findings = lintOutput({ code: "const total = 1;", note: "Fish &amp; chips" });
    const applied = applyOutputOverrides(findings, [
      { path: "code", check: "script", reason: "The tool returns code samples" },
      { path: "other", check: "css", reason: "Unused" },
    ]);
    expect(applied.findings).toContainEqual(
      expect.objectContaining({
        path: "code",
        check: "script",
        blocking: false,
        override: "The tool returns code samples",
      }),
    );
    expect(applied.blocking.map(({ path, check }) => `${path} ${check}`)).toEqual(["note markup"]);
    expect(applied.unmatched).toEqual([{ path: "other", check: "css", reason: "Unused" }]);
  });
});

describe("control labels from an accessibility snapshot", () => {
  it("lists the expand controls that follow text, not navigation, actions or list controls", () => {
    const snapshot = [
      "- navigation:",
      '  - link "Women":',
      "    - /url: /women",
      '  - button "More"',
      '- heading "Garden room" [level=1]',
      "- paragraph: A bright room facing the garden\u2026",
      '- button "Show more"',
      '- button "Add to cart"',
      "- list:",
      "  - listitem:",
      '    - link "Blue mug":',
      "      - /url: /p/1",
      "    - text: A sturdy mug with a\u2026",
      '    - link "Read more":',
      "      - /url: /p/1",
      '- button "Show more results"',
      "- text: Free returns on most items",
      '- button "See all" [expanded]',
      "- button",
      '- textbox "Search"',
    ].join("\n");
    expect(controlLabelsFromAriaSnapshot(snapshot)).toEqual(["Show more"]);
  });

  it("lists an expand control built as a link that stays on the page", () => {
    const snapshot = [
      "- paragraph:",
      "  - text: A mug with a wide handle and\u2026",
      '  - link "Read more":',
      '    - /url: "#"',
      "- text: Another text",
      '- link "Show details":',
      "  - /url: javascript:void(0)",
      "- text: Third text",
      '- link "See more":',
      "  - /url: /full-article",
    ].join("\n");
    expect(controlLabelsFromAriaSnapshot(snapshot)).toEqual(["Read more", "Show details"]);
  });
});

describe("bounded cost", () => {
  // Text a page can show, shaped to make a backtracking pattern retry without end. Each value
  // must lint in well under the bound even on a loaded host.
  const items = (count: number, item: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => item(index)).join("; ");
  const pathological: readonly (readonly [string, string])[] = [
    ["an unclosed brace list", `In the box {${items(24, (index) => `item ${index}`)}`],
    ["a brace list of specs", `Specs {${items(30, (index) => `spec ${index}: value ${index}`)}`],
    ["a brace config", `config { ${items(30, (index) => `key${index} value${index}`)}`],
    ["empty statements after a brace", `a{${"; ".repeat(25_000)}`],
    ["declarations after a brace", `a{${"color:0; ".repeat(5_000)}`],
    ["declarations without a brace", "color:0 ".repeat(6_250)],
    ["a long member chain", `window${".a".repeat(25_000)}`],
    ["a long call chain", `${"a.".repeat(25_000)}b`],
    ["spaces after a parenthesis", `(${" ".repeat(50_000)}`],
    ["spaces after function", `function${" ".repeat(50_000)}`],
    ["an unclosed JSON string", `{"a":"${"x".repeat(50_000)}`],
    ["an unclosed tag", `<a ${'b="1" '.repeat(5_000)}`],
    ["a long tag name", `<x${"-a".repeat(25_000)}`],
    ["an unclosed comment", `<!--${"x".repeat(50_000)}`],
    ["an unclosed placeholder", `{{${"x".repeat(50_000)}`],
    ["a long number", `color:${"1".repeat(50_000)}`],
    ["blank space between lines", `a\n${" ".repeat(50_000)}\nb`],
    ["a long run of distinct words", Array.from({ length: 400 }, (_, index) => `w${index}`).join(" ")],
  ];
  it.each(pathological)("lints %s in bounded time", (_name, value) => {
    const started = performance.now();
    lintOutput({ value });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("stops comparing records at a budget and reports what it found as partial", () => {
    const record = (index: number) => {
      const fields = Object.fromEntries(
        Array.from({ length: 24 }, (_, field) => [`f${field}`, `value ${index} field ${field}`]),
      );
      return { ...fields, text: Object.values(fields).join(" ") };
    };
    const small = lintOutput({ results: Array.from({ length: 20 }, (_, index) => record(index)) });
    expect(small.find((finding) => finding.check === "card_text")).toMatchObject({ count: 20 });
    expect(small.find((finding) => finding.check === "card_text")?.partial).toBeUndefined();
    const large = lintOutput({ results: Array.from({ length: 3_000 }, (_, index) => record(index)) });
    const cardText = large.find((finding) => finding.check === "card_text");
    expect(cardText).toMatchObject({ path: "results[].text", partial: true, blocking: false });
    expect(cardText?.count).toBeLessThan(3_000);
  });
});
