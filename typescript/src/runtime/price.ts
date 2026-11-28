import { normalizeText, unitAmount } from "./text.js";

/** A price as `readPrice` reads it from the page's text. */
export interface PriceRead {
  /** The amount in the currency's ISO 4217 minor units; null when the currency is. */
  readonly amountMinor: number | null;
  /** The currency's ISO 4217 code; null when neither the text nor the caller settles it. */
  readonly currency: string | null;
  /** What the price is for, as the text names it; null when the text names no unit. */
  readonly per: { readonly quantity: number; readonly unit: string } | null;
  /** Whether the text shows a starting amount: one after "from" or "starting at", or ending in "+". */
  readonly minimum: boolean;
}

// Signs one currency writes. "$", "¥" and "kr" are shared by several, so the caller's currency
// settles them when it writes that sign, as it does a price with no sign.
const signs: Readonly<Record<string, string>> = {
  "€": "EUR", "£": "GBP", "₹": "INR", "₩": "KRW", "₽": "RUB", "₺": "TRY", "₪": "ILS", "₫": "VND",
  "₱": "PHP", "฿": "THB", "₴": "UAH", "₦": "NGN", "円": "JPY", "zł": "PLN", "Kč": "CZK", "Rp": "IDR",
  "RM": "MYR", "R$": "BRL", "US$": "USD", "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD",
  "NZ$": "NZD", "HK$": "HKD", "S$": "SGD", "MX$": "MXN", "NT$": "TWD",
};
const sign = [...Object.keys(signs), "$", "¥", "kr"]
  .sort((a, b) => b.length - a.length)
  .map((text) => text.replace("$", "\\$"))
  .join("|");
const amountPattern = new RegExp(
  `^(?:(?<pre>[A-Z]{3}) ?)?(?<before>${sign})? ?(?<number>\\d(?:[ ,.'’]?\\d)*|[.,]\\d+)` +
    ` ?(?<after>${sign})?(?: (?<post>[A-Z]{3}))?$`,
  "u",
);
const startingAt = /^(?:from|starting at|starts at) /iu;

// ISO 4217 minor-unit digits of the currencies that have other than two.
const minorDigits: Readonly<Record<string, number>> = Object.fromEntries([
  ..."BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF".split(" ").map((code) => [code, 0]),
  ..."BHD IQD JOD KWD LYD OMR TND".split(" ").map((code) => [code, 3]),
]);

const isCurrency = (code: string | undefined): code is string =>
  code !== undefined && Intl.supportedValuesOf("currency").includes(code);

const narrowSign = (code: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value;

// The number's whole digits and fraction, or undefined when its marks don't group it one way. The
// last period or comma is the decimal mark unless it appears earlier too, or it is the number's
// only mark, three digits follow it, a nonzero whole precedes it and the currency has under three
// decimals.
const amountOf = (number: string, digits: number) => {
  const at = Math.max(number.lastIndexOf("."), number.lastIndexOf(","));
  const head = number.slice(0, at);
  const tail = number.slice(at + 1);
  const grouping =
    head.includes(number[at] ?? "") ||
    (/^\d*[1-9]\d*$/u.test(head) && tail.length === 3 && digits < 3);
  const [whole, fraction] = at < 0 || grouping ? [number, ""] : [head, tail];
  if (new Set(whole.replace(/\d/gu, "")).size > 1) return undefined;
  if (!/^\d*$|^\d{1,3}(?:,\d{2})*(?:,\d{3})+$/u.test(whole.replace(/\D/gu, ","))) return undefined;
  return { whole: whole.replace(/\D/gu, ""), fraction };
};

const perOf = (text: string) => {
  const unit = text.toLowerCase().replace(/\.$/u, "");
  if (["each", "ea", "item", "unit"].includes(unit)) return { quantity: 1, unit: "each" };
  const read = unitAmount(unit) ?? unitAmount(`1 ${unit}`);
  if (read === undefined) return undefined;
  const number = read.slice(0, read.indexOf(" "));
  // A mark before three digits after a nonzero whole may group thousands, as in 1,000 g.
  const quantity = /[1-9]\d*[.,]\d{3}$/u.test(number) ? Number.NaN : Number(number.replace(",", "."));
  const short = read.slice(read.indexOf(" ") + 1);
  return Number.isFinite(quantity)
    ? { quantity, unit: short === "ct" || short === "pc" ? "each" : short }
    : undefined;
};

/**
 * One price as a page shows it, such as `$0.99/lb`, `USD 1,234.50`, `1.234,56 €` or
 * `($0.29 / ounce)`, read as its amount in ISO 4217 minor units, its currency and the unit it is
 * per. The currency is the ISO 4217 code beside the amount, or the one its sign names. A sign
 * several currencies write, `$`, `¥` or `kr`, or no sign, takes `options.currency`, the site's
 * currency, when that currency writes the sign; otherwise it is null, never assumed. `per` is the
 * quantity and unit after `/` or `per`, or `each`, with units as `unitAmount` writes them and
 * each, item and count as `each`. It is null when the text names no unit, which a caller reads as
 * one of what the site sells. A period or comma before the number's last three digits, after a
 * nonzero whole, groups thousands when it is the only mark, unless the currency has three
 * decimals, so `$3.459` reads as 3459 dollars. Any other text is null, such as a range, a multi-buy, words around the price,
 * a negative amount, a code and sign that disagree, or an amount finer than the currency's minor
 * unit.
 */
export const readPrice = (
  text: unknown,
  options: { readonly currency?: string } = {},
): PriceRead | null => {
  const price = normalizeText(String(text ?? "")).replace(/^\((.*)\)$/u, "$1");
  const [, head = "", basis, each] =
    /^(.*?)(?: ?(?:\/|\bper ) ?(.+)| (each|ea)\.?)?$/iu.exec(price.replace(startingAt, "")) ?? [];
  const per = basis === undefined && each === undefined ? null : perOf(basis ?? each ?? "");
  const groups = amountPattern.exec(head.replace(/\+$/u, ""))?.groups;
  if (per === undefined || groups?.number === undefined) return null;
  const { pre, before, number, after, post } = groups;
  const marked = before ?? after;
  const fits = (code: string | undefined): code is string =>
    isCurrency(code) && (marked === undefined || signs[marked] === code || narrowSign(code) === marked);
  const code = pre ?? post;
  if ((pre && post) || (before && after) || (code !== undefined && !fits(code))) return null;
  const hint = options.currency?.toUpperCase();
  const currency = code ?? signs[marked ?? ""] ?? (fits(hint) ? hint : null);
  const digits = minorDigits[currency ?? ""] ?? 2;
  const amount = amountOf(number, digits);
  if (amount === undefined) return null;
  const minimum = startingAt.test(price) || head.endsWith("+");
  if (currency === null) return { amountMinor: null, currency, per, minimum };
  const fraction = amount.fraction.replace(/0+$/u, "");
  const amountMinor = Number(`${amount.whole}${fraction.padEnd(digits, "0")}`);
  if (fraction.length > digits || !Number.isSafeInteger(amountMinor)) return null;
  return { amountMinor, currency, per, minimum };
};
