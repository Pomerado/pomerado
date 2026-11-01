import { formatDate } from "../browser/form-controls.js";
import { DateOfBirthFormat } from "./autofill-contracts.js";

/** A date of birth an owner typed, year first, as the ISO date a record keeps; undefined if none. */
export const parseDateOfBirth = (value: string): string | undefined => {
  const parts = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/u.exec(value);
  if (parts === null) return undefined;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.toISOString().slice(0, 10);
};
/** The formats that write the whole date, rather than one part of a split date. */
const wholeDates = DateOfBirthFormat.literals.filter(
  (format) => format.includes("Y") && format.includes("M") && format.includes("D"),
);
/**
 * An ISO date of birth in each whole-date layout a page may show it in, which masking registers;
 * never one part alone, such as a month's "4", which is no secret to mask everywhere.
 */
export const wholeDateLayouts = (iso: string) =>
  parseDateOfBirth(iso) === undefined
    ? []
    : [...new Set(wholeDates.map((format) => formatDate(iso, format)))];

/** The country calling codes one or two digits long; every other code is three. */
const shortCallingCodes = new Set([
  ...["1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39"],
  ...["40", "41", "43", "44", "45", "46", "47", "48", "49"],
  ...["51", "52", "53", "54", "55", "56", "57", "58"],
  ...["60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86"],
  ...["90", "91", "92", "93", "94", "95", "98"],
]);

/** A phone number written in international form: its digits after the `+` or `00`. */
const internationalDigits = (number: string) => {
  const written = number.trim();
  const lead = /^(?:\+|00)/u.exec(written)?.[0];
  return lead === undefined ? undefined : written.slice(lead.length).replaceAll(/[^0-9]/gu, "");
};

/**
 * A phone number's country calling code, digits only, when the number is written in international
 * form, after `+` or `00`; undefined for a number written another way, which does not say it.
 */
export const callingCode = (number: string) => {
  const digits = internationalDigits(number);
  if (digits === undefined || digits.length < 4 || digits.startsWith("0")) return undefined;
  const short = [digits.slice(0, 1), digits.slice(0, 2)].find((code) => shortCallingCodes.has(code));
  return short ?? digits.slice(0, 3);
};

/**
 * A phone number as a field that takes only the local number takes it (`PhoneFormat` `national`):
 * the digits after its country calling code (`callingCode`). Undefined for a number that does not
 * say its calling code, such as one saved without `+` or `00`, which the host types as saved.
 */
export const nationalDigits = (number: string) => {
  const code = callingCode(number);
  return code === undefined ? undefined : internationalDigits(number)?.slice(code.length);
};
