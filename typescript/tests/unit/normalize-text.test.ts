import { expect, it } from "vitest";
import { normalizeText } from "../../src/runtime/text.js";

it("removes zero-width characters and reads no-break and other Unicode spaces as spaces", () => {
  expect(normalizeText("Total:\u00A0$\u200B12.99")).toBe("Total: $12.99");
  expect(normalizeText("\uFEFFDue\u2060 in\u2009\u20093\u200C\u200D days")).toBe("Due in 3 days");
  expect(normalizeText("Room\u3000101\u202Fwest")).toBe("Room 101 west");
});

it("joins lines with one space by default and keeps them with lines: true", () => {
  const text = "  Garden room \r\n\n\t Sleeps 2 \u2028Breakfast included  \n";
  expect(normalizeText(text)).toBe("Garden room Sleeps 2 Breakfast included");
  expect(normalizeText(text, { lines: true })).toBe("Garden room\nSleeps 2\nBreakfast included");
});

it("leaves ordinary text unchanged", () => {
  expect(normalizeText("Order 12345 shipped on 3 March")).toBe("Order 12345 shipped on 3 March");
  expect(normalizeText("First line\nSecond line", { lines: true })).toBe("First line\nSecond line");
  expect(normalizeText("   \u200B\n ")).toBe("");
});
