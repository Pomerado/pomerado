import { expect, it } from "vitest";
import { readPrice } from "../../src/browser/index.js";

// A price as the page shows it: its amount in the currency's minor units, the currency the page
// shows, never an assumed one, and the unit the price is per when the page names one.
it.each([
  ["USD 1,234.50", undefined, { amountMinor: 123450, currency: "USD", per: null, minimum: false }],
  ["1,500円", undefined, { amountMinor: 1500, currency: "JPY", per: null, minimum: false }],
  ["$0.99/lb", undefined, { amountMinor: null, currency: null, per: { quantity: 1, unit: "lb" }, minimum: false }],
  ["$0.99/lb", "CAD", { amountMinor: 99, currency: "CAD", per: { quantity: 1, unit: "lb" }, minimum: false }],
  ["$3.49/12 oz", "USD", { amountMinor: 349, currency: "USD", per: { quantity: 12, unit: "oz" }, minimum: false }],
  ["($0.29 / ounce)", "USD", { amountMinor: 29, currency: "USD", per: { quantity: 1, unit: "oz" }, minimum: false }],
  ["$4.29", "USD", { amountMinor: 429, currency: "USD", per: null, minimum: false }],
  ["$4.29 each", "USD", { amountMinor: 429, currency: "USD", per: { quantity: 1, unit: "each" }, minimum: false }],
  ["From 12,50 €", "USD", { amountMinor: 1250, currency: "EUR", per: null, minimum: true }],
  ["2 for $5", "USD", null],
  ["$5.99 - $7.99", "USD", null],
  ["Sold out", "USD", null],
])("reads %j with the caller's currency %j", (text, currency, read) => {
  expect(readPrice(text, currency === undefined ? {} : { currency })).toStrictEqual(read);
});
