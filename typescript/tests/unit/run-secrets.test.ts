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

  it("collapses whitespace as the page snapshot does, dropping zero-width characters", () => {
    expect(registered("one​ two­\nthree").redact("one two three")).toBe("[private]");
  });

  it("adds no empty form for a secret of whitespace alone", () => {
    expect(registered("   ").redact("a b")).toBe("a b");
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
