import { describe, expect, test } from "vitest";
import { resolveAddress } from "../../src/browser/picker-address.js";

/** A site's suggestions by the text typed, recording each text in order. */
const site = (answers: Readonly<Record<string, readonly string[]>>) => {
  const typed: string[] = [];
  const suggest = (text: string) => {
    typed.push(text);
    return answers[text] ?? [];
  };
  return { typed, suggest };
};

describe("resolveAddress", () => {
  test("types the street without the unit after a comma or a #, and returns the unit", async () => {
    const echo = (text: string) => [text];
    expect(await resolveAddress("1 Example St, Suite 2, Exampleton, IL 60000", echo)).toMatchObject({
      picked: true,
      query: "1 Example St, Exampleton, IL 60000",
      unit: "Suite 2",
    });
    expect(await resolveAddress("1 Example St #4B, Exampleton", echo)).toMatchObject({
      query: "1 Example St, Exampleton",
      unit: "#4B",
    });
    expect(await resolveAddress("Acme Corp, 12 Example St, Suite 2, Exampleton, IL", echo)).toMatchObject({
      query: "Acme Corp, 12 Example St, Exampleton, IL",
      unit: "Suite 2",
    });
    // A unit-shaped last part is asked for as typed, then left out, and is the unit unless the
    // suggestion taken keeps it.
    const { typed, suggest } = site({ "1 Example St": ["1 Example St, Exampleton, IL, USA"] });
    expect(await resolveAddress("1 Example St, Apt 2", suggest)).toMatchObject({ label: "1 Example St, Exampleton, IL, USA", unit: "Apt 2" });
    expect(typed).toEqual(["1 Example St, Apt 2", "1 Example St"]);
    // A unit before the street is asked for as typed first; it, or one with the house's own number,
    // is still the unit, while a town and postcode the suggestion keeps is not.
    const before = site({ "12 Example St, Exampleton, IL": ["12 Example St, Exampleton, IL, USA"] });
    expect(await resolveAddress("Suite 200, 12 Example St, Exampleton, IL", before.suggest)).toMatchObject({ query: "12 Example St, Exampleton, IL", unit: "Suite 200" });
    expect(before.typed).toEqual(["Suite 200, 12 Example St, Exampleton, IL", "12 Example St, Exampleton, IL"]);
    expect(await resolveAddress("100 Example St, Suite 100", () => ["100 Example St, Exampleton, IL, USA"])).toMatchObject({ unit: "Suite 100" });
    expect(await resolveAddress("1 Example St, Fl 2, Exampleton, FL", () => ["1 Example St, Exampleton, FL, USA"])).toMatchObject({ unit: "Fl 2" });
    const towns = ["1 Example St, Otherton 3000, Australia", "1 Example St, Exampleton 4000, Australia"];
    expect(await resolveAddress("1 Example St, Exampleton 4000, Australia", () => towns)).toMatchObject({ label: towns[1], unit: "" });
    // A town, a ZIP, a town opening with a number, a postal code, a last part or a part after no
    // house number is no unit.
    for (const address of [
      "1 Example St, Exampleton, IL 60000",
      "1 Example St, Exampleton 60000",
      "1 Example St, 12 Oaks, CA",
      "1 Example St, Exampleton ON A1B 2C3",
      "1 Example St, Sampleville NSW 2000",
      "1 Example St, Exampleton SW1A1AA",
      "Example Plaza, Route 9, Exampleton, NJ",
    ])
      expect(await resolveAddress(address, echo)).toMatchObject({ query: address, unit: "" });
  });

  test("retries once with joined words split, the ZIP left out and stray punctuation dropped", async () => {
    const { typed, suggest } = site({ "2 N Example Ton St, Exampleton, IL": ["2 N Example Ton St, Exampleton, IL, USA"] });
    expect(await resolveAddress("2 N ExampleTon St., Exampleton, IL 60000", suggest)).toEqual({
      picked: true,
      choice: "2 N Example Ton St, Exampleton, IL, USA",
      label: "2 N Example Ton St, Exampleton, IL, USA",
      query: "2 N Example Ton St, Exampleton, IL",
      unit: "",
    });
    expect(typed).toEqual(["2 N ExampleTon St., Exampleton, IL 60000", "2 N Example Ton St, Exampleton, IL"]);
  });

  test("prefers a suggestion that keeps the caller's ZIP and state, then the site's order", async () => {
    const choices = ["1 Example St, Exampleton, NY, USA", "1 Example St, Exampleton, IL 60001, USA", "1 Example St, Exampleton, IL 60000, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", () => choices)).toMatchObject({ label: choices[2] });
    // Each place word counts, so the caller's town wins within a state.
    const towns = ["1 Example St, Sampleton, IL, USA", "1 Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", () => towns)).toMatchObject({ label: towns[1] });
    // The caller's ZIP comes first only on a street that keeps more than half the caller's street
    // words, then the place words, then the share of the street words kept, so another street with
    // the caller's ZIP, a street type the caller got wrong, a direction letter added or dropped, or
    // a misspelled street never sends the address to another town.
    const street = ["12 Other Ave, Exampleton, IL 60000, USA", "12 Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL 60000", () => street)).toMatchObject({ label: street[1] });
    const sunset = ["12 Sunset Ave, Exampleton, IL 60000, USA", "12 Example Rd, Exampleton, IL, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL 60000", () => sunset)).toMatchObject({ label: sunset[1] });
    const type = ["12 Example St, Sampleton, MA, USA", "12 Example Ave, Exampleton, IL, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL", () => type)).toMatchObject({ label: type[1] });
    const typeZip = ["12 Example St, Sampleton, MA 01000, USA", "12 Example Ave, Exampleton, IL 60000, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL 60000", () => typeZip)).toMatchObject({ label: typeZip[1] });
    const road = ["12 Example Dr, Sampleton, OK, USA", "12 Example Rd, Exampleton, TX, USA"];
    expect(await resolveAddress("12 Example Dr, Exampleton, TX", () => road)).toMatchObject({ label: road[1] });
    const north = ["12 N Example St, Sampleton, TX, USA", "12 North Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("12 N Example St, Exampleton, IL", () => north)).toMatchObject({ label: north[1] });
    const added = ["12 Example St, Sampleton, NY, USA", "12 N Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL", () => added)).toMatchObject({ label: added[1] });
    const dropped = ["12 N Example St, Sampleton, NY, USA", "12 Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("12 N Example St, Exampleton, IL", () => dropped)).toMatchObject({ label: dropped[1] });
    const misspelled = ["12 E St, Sampleton, NY, USA", "12 Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("12 Exampel St, Exampleton, IL", () => misspelled)).toMatchObject({ label: misspelled[1] });
    const zips = ["1 Example St, North Sampleton, IL 60999, USA", "1 Example St, Exampleton, IL 60000, USA"];
    expect(await resolveAddress("1 Example St, North Sampleton, IL 60000", () => zips)).toMatchObject({ label: zips[1] });
    // A suggestion that shows no ZIP still keeps the state, and a state's name matches its code.
    expect(await resolveAddress("1 Example St, Exampleton, Illinois 60000", () => choices.slice(0, 2).concat("1 Example St, Exampleton, IL, USA"))).toMatchObject({
      label: "1 Example St, Exampleton, IL, USA",
    });
    // A ZIP alone keeps its place as a ZIP, never as a house number elsewhere.
    expect(await resolveAddress("60000", () => ["60000 Example Rd, Sampleville, NY, USA", "Exampleton, IL 60000, USA"])).toMatchObject({
      label: "Exampleton, IL 60000, USA",
    });
    expect(await resolveAddress("60000", () => ["60000 Example Rd, Sampleville, NY, USA"])).toMatchObject({ picked: false });
  });

  test("returns the suggestions as candidates when the best keeps the caller's address only in part", async () => {
    // Another state, another ZIP, or a misspelled town: none keeps the town, state and ZIP, and
    // none shows the caller's ZIP on its street.
    const { typed, suggest } = site({ "1 Example St, Exampleton, IL 60000": ["1 Example St, Exampleton, NY, USA"] });
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", suggest)).toEqual({
      picked: false,
      reason: "option_unclear",
      wanted: "1 Example St, Exampleton, IL 60000",
      available: ["1 Example St, Exampleton, NY, USA"],
      matches: ["1 Example St, Exampleton, NY, USA"],
      unit: "",
    });
    expect(typed).toEqual(["1 Example St, Exampleton, IL 60000", "1 Example St, Exampleton, IL"]);
    const others = ["1 Example St, Sampleton, IL, USA", "1 Example St, Exampleton, IL 60999, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", () => others)).toMatchObject({ picked: false, reason: "option_unclear", available: others });
    const misspelled = ["1 Example St, Exampleton, NY, USA", "1 Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("1 Example St, Exampletn IL", () => misspelled)).toMatchObject({ picked: false, reason: "option_unclear", available: misspelled });
    // A place word in a suggestion's street never counts, so only the other state's is usable.
    const streets = ["1 Exampleton Rd, Sampleton, IL, USA", "1 Example St, Exampleton, NY, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => streets)).toMatchObject({ picked: false, reason: "option_unclear", matches: [streets[1]] });
  });

  test("takes the suggestion that matches the typed text among those that tie, and returns the site's own item", async () => {
    const items = [
      { description: "1 Example St, Exampleton Heights, IL, USA", id: "a" },
      { description: "1 Example St, Exampleton, IL, USA", id: "b" },
    ];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => items, (item) => item.description)).toMatchObject({
      choice: { id: "b" },
      label: "1 Example St, Exampleton, IL, USA",
    });
  });

  test("takes only a suggestion with the caller's house number, wherever the street part is", async () => {
    const houses = (wanted: string, shown: readonly string[]) => resolveAddress(wanted, () => shown).then((outcome) => outcome.picked && outcome.label);
    expect(await houses("Acme Corp, 12 Example St, Exampleton, IL", ["15 Example St, Exampleton, IL, USA", "12 Example St, Exampleton, IL, USA"])).toBe(
      "12 Example St, Exampleton, IL, USA",
    );
    expect(await houses("12A Example St, Exampleton, IL", ["12 A Example St, Exampleton, IL, USA"])).toBe("12 A Example St, Exampleton, IL, USA");
    expect(await houses("2nd Floor, 12 Example St, Exampleton, IL", ["12 Example St, Exampleton, IL, USA"])).toBe("12 Example St, Exampleton, IL, USA");
    expect(await houses("1 Example St, Exampleton, IL", ["100 Example St Apt 1, Exampleton, IL, USA"])).toBe(false);
  });

  test("refuses only when no form brings a suggestion with the caller's house number and street name, listing what the site gave", async () => {
    expect(await resolveAddress("3 Example St, Exampleton", () => ["5 Example St, Exampleton, IL, USA", "Example St, Exampleton, IL, USA"])).toEqual({
      picked: false,
      reason: "option_missing",
      wanted: "3 Example St, Exampleton",
      available: ["5 Example St, Exampleton, IL, USA", "Example St, Exampleton, IL, USA"],
      matches: [],
      unit: "",
    });
    expect(await resolveAddress("3 Example St, Apt 1, Exampleton", () => [])).toMatchObject({ picked: false, available: [], unit: "Apt 1" });
    // A suggestion whose street keeps no word of the caller's street name, its street type alone
    // included, is another street.
    const other = ["12 Other Ave, Exampleton, IL, USA", "12 Other St, Exampleton, IL, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL", () => other)).toMatchObject({ picked: false, available: other });
    expect(await resolveAddress("12-34 Example St, Exampleton, NY", () => ["12-34 Other St, Exampleton, NY, USA"])).toMatchObject({ picked: false });
    // A number in the street, with or without its ordinal ending, or a close name, its words joined
    // or split or written as initials, keeps the street; a close name with another ZIP does not.
    for (const [address, shown] of [
      ["12 Route 9, Exampleton, NJ", "12 US-9, Exampleton, NJ, USA"],
      ["12 SW 107 Ave, Exampleton, FL", "12 SW 107th Ave, Exampleton, FL, USA"],
      ["12 N La Salle St, Exampleton, IL", "12 N LaSalle St, Exampleton, IL, USA"],
      ["12 Mian St, Exampleton, IL", "12 Main St, Exampleton, IL, USA"],
      ["12 MLK Jr Way, Exampleton, GA", "12 Dr Martin Luther King Jr Way, Exampleton, GA, USA"],
    ])
      expect(await resolveAddress(address ?? "", () => [shown ?? ""])).toMatchObject({ label: shown });
    expect(await resolveAddress("12 Exampel St, Exampleton, IL 60000", () => ["12 Example St, Exampleton, IL 60001, USA"])).toMatchObject({ picked: false });
    expect(await resolveAddress("1234 NE 45th St, Exampleton, WA", () => ["1234 NE 46th St, Exampleton, WA, USA"])).toMatchObject({ picked: false });
    expect(await resolveAddress("12 Old Mill Rd, Exampleton, IL", () => ["12 Oak Leaf Dr, Exampleton, IL, USA"])).toMatchObject({ picked: false });
  });
});
