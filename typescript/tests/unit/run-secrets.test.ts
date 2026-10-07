import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { makeRunSecrets } from "../../src/inputs/secrets.js";

const secret = "  correct  horse\tbattery  ";
const registered = (value = secret) => {
  const secrets = makeRunSecrets();
  secrets.register(value);
  return secrets;
};

describe("makeRunSecrets", () => {
  it.each([
    ["as given", secret],
    ["URL-encoded", encodeURIComponent(secret)],
    ["JSON-escaped", JSON.stringify(secret).slice(1, -1)],
    ["trimmed", "correct  horse\tbattery"],
    ["with its whitespace collapsed, as a page snapshot shows it", "correct horse battery"],
    [
      "form-encoded, with + for each space, as a query string carries it",
      "++correct++horse%09battery++",
    ],
    ["trimmed and form-encoded", "correct++horse%09battery"],
    ["collapsed and URL-encoded", "correct%20horse%20battery"],
  ])("redacts a secret %s", (_, shown) => {
    expect(registered().redact(`before ${shown} after`)).toBe("before [private] after");
    expect(Either.isLeft(Effect.runSync(Effect.either(registered().assertAbsent(shown))))).toBe(
      true,
    );
  });

  // An accessibility snapshot single-quotes a key that needs it and doubles each ' in it; a key
  // holds the name JSON-stringified. A quoted value writes other control characters as \xNN.
  it.each([
    [
      "with each ' doubled, as a quoted snapshot key shows it",
      "o'brien@example.com",
      "o''brien@example.com",
    ],
    ["JSON-escaped with each ' doubled", 'say "o\'hi"', "say \\\"o''hi\\\""],
    [
      "with control characters written as \\xNN, as a quoted snapshot value shows it",
      "ctl\u0007bell\u0085",
      "ctl\\x07bell\\x85",
    ],
    ["percent-encoded in lowercase hex", "a/b=c", "a%2fb%3dc"],
    ["as a URL's query carries it", "o'brien {x}", "o%27brien%20{x}"],
    ["as a URL's path carries it", "o'brien {x}", "o'brien%20%7Bx%7D"],
    ["with | encoded as a URL's path carries it", "a$b|c", "a$b%7Cc"],
    ["with ^ encoded as a URL's path carries it", "user@x^y", "user@x%5Ey"],
    ["with \\ turned into / as a URL's path carries it", "a\\b$c", "a/b$c"],
    ["without its tab, which a URL drops", "a\tb|c", "ab%7Cc"],
    ["as a URL's fragment carries it", "o'brien `x`", "o'brien%20%60x%60"],
  ])("redacts a secret %s", (_, value, shown) => {
    expect(registered(value).redact(`before ${shown} after`)).toBe("before [private] after");
  });

  it("keeps every form it can encode for a secret holding a lone surrogate", () => {
    const secrets = makeRunSecrets();
    expect(() => secrets.register("ab\ud800cd")).not.toThrow();
    expect(secrets.redact("x ab\ud800cd y")).toBe("x [private] y");
    expect(secrets.redact("x ab\\ud800cd y")).toBe("x [private] y");
  });

  it("collapses whitespace as the page snapshot does, dropping zero-width characters", () => {
    expect(registered("one​ two­\nthree").redact("one two three")).toBe("[private]");
  });

  it("adds no empty form for a secret of whitespace alone", () => {
    expect(registered("   ").redact("a b")).toBe("a b");
  });

  // A short answer, such as a favorite color, turns up inside longer words by chance. It counts
  // only where no letter or digit adjoins it, as the submission guard finds a code.
  it("finds a short secret only as a whole token", () => {
    const secrets = registered("red");
    const words = "required ordered shared credit Ordered";
    expect(secrets.redact(words)).toBe(words);
    expect(Either.isRight(Effect.runSync(Effect.either(secrets.assertAbsent(words))))).toBe(true);
    for (const [shown, redacted] of [
      ["my answer is red", "my answer is [private]"],
      ["red", "[private]"],
      ['{"answer":"red"}', '{"answer":"[private]"}'],
      ["/login?answer=red&next=1", "/login?answer=[private]&next=1"],
      ['textbox "Answer": red', 'textbox "Answer": [private]'],
    ] as const) {
      expect(secrets.redact(shown)).toBe(redacted);
      expect(Either.isLeft(Effect.runSync(Effect.either(secrets.assertAbsent(shown))))).toBe(true);
    }
    // A short code is no secret inside a timestamp, and is one beside other text.
    const code = registered("482913");
    expect(code.redact("ts=1759482913123")).toBe("ts=1759482913123");
    expect(code.redact("otp=482913;")).toBe("otp=[private];");
  });

  it("still finds a longer secret inside other text", () => {
    const secrets = registered("hunter22");
    expect(secrets.redact("xhunter22y")).toBe("x[private]y");
    expect(Either.isLeft(Effect.runSync(Effect.either(secrets.assertAbsent("xhunter22y"))))).toBe(
      true,
    );
  });

  it("drops a short secret's prefix at a cut only where the prefix starts a token", () => {
    const secrets = registered("red");
    expect(secrets.redactCut("the color is re")).toBe("the color is ");
    expect(secrets.redactCut("from her")).toBe("from her");
  });

  it("drops the prefix of a secret that a cut split at the end of the text", () => {
    const secrets = registered("fixture-private-value");
    expect(secrets.redactCut("page text fixture-priv")).toBe("page text ");
    expect(secrets.redactCut("page fixture-private-value tail")).toBe("page [private] tail");
    expect(secrets.redactCut("ends fixture-private-value")).toBe("ends [private]");
    // A collapsed form split by the cut leaves nothing of itself either.
    expect(
      registered("correct  horse  battery").redactCut('textbox "Code": correct horse ba'),
    ).toBe('textbox "Code": ');
  });
});
