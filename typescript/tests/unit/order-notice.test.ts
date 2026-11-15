import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { asksAsDeclared } from "../../src/execution/declared-questions.js";
import { OrderFacts, orderNotice, type InputRequest } from "../../src/runtime/input-request.js";
import { makeScriptInput, type ScriptQuestionDeclarations } from "../../src/runtime/script-input.js";

const decodeOrder = Schema.decodeUnknownEither(OrderFacts, { onExcessProperty: "error" });
const decoded = (order: unknown) => {
  const result = decodeOrder(order);
  if (Either.isLeft(result)) throw new Error(String(result.left));
  return result.right;
};
const refused = (order: unknown) => Either.isLeft(decodeOrder(order));

describe("an order's notice", () => {
  // A host on a later core recomputes the notice of a tool on an earlier one and compares the two,
  // so an order of the earlier shape keeps its exact words.
  it("keeps the exact words for an order of the earlier shape", () => {
    expect(
      orderNotice(
        decoded({
          currency: "USD",
          items: [{ name: "Synthetic lamp", quantity: 1, price: "12.00" }],
          total: "12.00",
        }),
      ),
    ).toBe('Order: 1 × "Synthetic lamp" at 12.00 USD each. Total: 12.00 USD.');
    expect(
      orderNotice(
        decoded({
          currency: "EUR",
          items: [
            { name: 'Synthetic "cable"', quantity: 2, price: "4.50" },
            { name: "Café mug", quantity: 99_999, price: "0.001" },
          ],
          shipping: "0.00",
          tax: "0.81",
          total: "9.81",
        }),
      ),
    ).toBe(
      'Order: 2 × "Synthetic \\"cable\\"" at 4.50 EUR each; 99999 × "Café mug" at 0.001 EUR each. Shipping: 0.00 EUR. Tax: 0.81 EUR. Total: 9.81 EUR.',
    );
    expect(
      orderNotice(
        decoded({
          currency: "GBP",
          items: [{ name: "Synthetic kettle", quantity: 3, price: "20" }],
          tax: "12",
          total: "72",
        }),
      ),
    ).toBe('Order: 3 × "Synthetic kettle" at 20 GBP each. Tax: 12 GBP. Total: 72 GBP.');
  });

  it("shows each line's total, a measured quantity, fees, a discount and a tip", () => {
    expect(
      orderNotice(
        decoded({
          currency: "USD",
          items: [
            { name: "Synthetic shake", quantity: 3, price: "4.99", lineTotal: "14.97" },
            { name: "Synthetic pears", quantity: 1.25, unit: "lb", price: "3.49", lineTotal: "4.36" },
            { name: "Synthetic rope", quantity: 2, unit: "m", price: "1.10" },
          ],
          discount: "2.00",
          fees: [
            { name: "Service fee", amount: "2.99" },
            { name: "Delivery fee", amount: "0.00" },
          ],
          shipping: "0.00",
          tax: "1.20",
          tip: "3.00",
          total: "26.72",
        }),
      ),
    ).toBe(
      'Order: 3 × "Synthetic shake" at 4.99 USD each (14.97 USD); 1.25 lb × "Synthetic pears" at 3.49 USD per lb (4.36 USD); 2 m × "Synthetic rope" at 1.10 USD per m. Discount: 2.00 USD. Fees: "Service fee" 2.99 USD; "Delivery fee" 0.00 USD. Shipping: 0.00 USD. Tax: 1.20 USD. Tip: 3.00 USD. Total: 26.72 USD.',
    );
  });

  // A checkout that shows only a line's total, such as for an item sold by weight, never has the
  // tool work out a rounded price each.
  it("shows a line by its total alone when the checkout shows no price each", () => {
    expect(
      orderNotice(
        decoded({
          currency: "USD",
          items: [
            { name: "Synthetic shake", quantity: 3, lineTotal: "14.97" },
            { name: "Synthetic pears", quantity: 1.25, unit: "lb", lineTotal: "4.36" },
          ],
          fees: [],
          total: "19.33",
        }),
      ),
    ).toBe(
      'Order: 3 × "Synthetic shake" (14.97 USD); 1.25 lb × "Synthetic pears" (4.36 USD). Total: 19.33 USD.',
    );
  });
});

describe("an order's facts", () => {
  const order = (item: object, more: object = {}) => ({
    currency: "USD",
    items: [{ name: "Synthetic item", ...item }],
    total: "1.00",
    ...more,
  });

  it("take a whole quantity, or one of up to three decimal places with its unit", () => {
    expect(refused(order({ quantity: 1.5, price: "1.00" }))).toBe(true);
    expect(refused(order({ quantity: 0, unit: "kg", price: "1.00" }))).toBe(true);
    expect(refused(order({ quantity: 0.0005, unit: "kg", price: "1.00" }))).toBe(true);
    expect(refused(order({ quantity: 1.2345, unit: "kg", price: "1.00" }))).toBe(true);
    expect(refused(order({ quantity: 100_000, unit: "kg", price: "1.00" }))).toBe(true);
    expect(refused(order({ quantity: 1.5, unit: "bunch", price: "1.00" }))).toBe(true);
    expect(refused(order({ quantity: 0.001, unit: "kg", price: "1.00" }))).toBe(false);
    expect(refused(order({ quantity: 2.345, unit: "fl oz", price: "1.00" }))).toBe(false);
    expect(refused(order({ quantity: 99_999, unit: "yd", price: "1.00" }))).toBe(false);
  });

  it("take a price each, a line total or both, never neither", () => {
    expect(refused(order({ quantity: 1 }))).toBe(true);
    expect(refused(order({ quantity: 1, lineTotal: "1.0000" }))).toBe(true);
    expect(refused(order({ quantity: 1, lineTotal: "1.00" }))).toBe(false);
    expect(refused(order({ quantity: 1, price: "1.00", lineTotal: "1.00" }))).toBe(false);
  });

  it("take up to ten named fees, a discount and a tip, each an amount", () => {
    const fee = { name: "Service fee", amount: "1.00" };
    const line = { quantity: 1, price: "1.00" };
    expect(refused(order(line, { fees: Array.from({ length: 10 }, () => fee) }))).toBe(false);
    expect(refused(order(line, { fees: Array.from({ length: 11 }, () => fee) }))).toBe(true);
    expect(refused(order(line, { fees: [{ ...fee, name: " " }] }))).toBe(true);
    expect(refused(order(line, { fees: [{ ...fee, amount: "-1.00" }] }))).toBe(true);
    expect(refused(order(line, { fees: [{ ...fee, percent: "5" }] }))).toBe(true);
    expect(refused(order(line, { discount: "0.50", tip: "1.50" }))).toBe(false);
    expect(refused(order(line, { tip: "1,50" }))).toBe(true);
  });
});

describe("a script's purchase confirm", () => {
  const declared: ScriptQuestionDeclarations = {
    confirm_order: { type: "confirm", prompt: "Place this order?" },
  };
  const asked = (order: unknown) => {
    const sent: InputRequest[] = [];
    const result = Effect.runSync(
      Effect.either(
        makeScriptInput(declared, (request) =>
          Effect.sync(() => {
            sent.push(request);
            return { confirm_order: { confirmed: true } };
          }),
        ).ask({ confirm_order: { order } } as never),
      ),
    );
    return { result, request: sent[0] };
  };

  it("puts each fee's name on one line and shortens a long one, as it does an item's", () => {
    const { result, request } = asked({
      currency: "USD",
      items: [{ name: "Synthetic\nshake", quantity: 3, price: "4.99", lineTotal: "14.97" }],
      fees: [
        { name: "  Service\n\tfee ", amount: "2.99" },
        { name: "x".repeat(300), amount: "0.00" },
      ],
      tip: "0.00",
      total: "17.96",
    });
    expect(result).toEqual(Either.right({ confirm_order: { confirmed: true } }));
    if (request === undefined) throw new Error("the order was not asked");
    expect(request.notice).toBe(
      `Order: 3 × "Synthetic shake" at 4.99 USD each (14.97 USD). Fees: "Service fee" 2.99 USD; "${"x".repeat(199)}…" 0.00 USD. Tip: 0.00 USD. Total: 17.96 USD.`,
    );
    expect(asksAsDeclared(request, declared)).toBe(true);
  });

  it("refuses a measured quantity without its unit", () => {
    const { result, request } = asked({
      currency: "USD",
      items: [{ name: "Synthetic pears", quantity: 1.25, lineTotal: "4.36" }],
      total: "4.36",
    });
    expect(result).toEqual(Either.left(expect.objectContaining({ code: "InvalidOptions" })));
    expect(request).toBeUndefined();
  });
});
