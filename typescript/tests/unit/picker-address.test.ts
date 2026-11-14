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
    // Each place word counts, so the caller's town wins within a state, and a misspelled town still
    // keeps its state.
    const towns = ["1 Example St, Sampleton, IL, USA", "1 Example St, Exampleton, IL, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", () => towns)).toMatchObject({ label: towns[1] });
    expect(await resolveAddress("1 Example St, Exampletn IL", () => ["1 Example St, Exampleton, NY, USA", towns[1] ?? ""])).toMatchObject({ label: towns[1] });
    // The caller's ZIP outweighs place words, which outweigh another ZIP; a place word in a
    // suggestion's street never counts, and then the caller's street words decide.
    const zips = ["1 Example St, North Sampleton, IL 60999, USA", "1 Example St, Exampleton, IL 60000, USA"];
    expect(await resolveAddress("1 Example St, North Sampleton, IL 60000", () => zips)).toMatchObject({ label: zips[1] });
    const others = ["1 Example St, Sampleton, IL, USA", "1 Example St, Exampleton, IL 60999, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", () => others)).toMatchObject({ label: others[1] });
    const streets = ["1 Exampleton Rd, Sampleton, IL, USA", "1 Example St, Exampleton, NY, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => streets)).toMatchObject({ label: streets[1] });
    // A suggestion that shows no ZIP still keeps the state, and a state's name matches its code.
    expect(await resolveAddress("1 Example St, Exampleton, Illinois 60000", () => choices.slice(0, 2).concat("1 Example St, Exampleton, IL, USA"))).toMatchObject({
      label: "1 Example St, Exampleton, IL, USA",
    });
    // A ZIP alone keeps its place as a ZIP, never as a house number elsewhere.
    expect(await resolveAddress("60000", () => ["60000 Example Rd, Sampleville, NY, USA", "Exampleton, IL 60000, USA"])).toMatchObject({
      label: "Exampleton, IL 60000, USA",
    });
    expect(await resolveAddress("60000", () => ["60000 Example Rd, Sampleville, NY, USA"])).toMatchObject({ picked: false });
    // With none that keeps them on any form, the site's first is accepted for the tool to report.
    const { typed, suggest } = site({ "1 Example St, Exampleton, IL 60000": ["1 Example St, Exampleton, NY, USA"] });
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", suggest)).toMatchObject({ label: "1 Example St, Exampleton, NY, USA" });
    expect(typed).toEqual(["1 Example St, Exampleton, IL 60000", "1 Example St, Exampleton, IL"]);
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

  test("refuses only when no form brings a suggestion with the caller's house number, listing what the site gave", async () => {
    expect(await resolveAddress("3 Example St, Exampleton", () => ["5 Example St, Exampleton, IL, USA", "Example St, Exampleton, IL, USA"])).toEqual({
      picked: false,
      reason: "option_missing",
      wanted: "3 Example St, Exampleton",
      available: ["5 Example St, Exampleton, IL, USA", "Example St, Exampleton, IL, USA"],
      matches: [],
      unit: "",
    });
    expect(await resolveAddress("3 Example St, Apt 1, Exampleton", () => [])).toMatchObject({ picked: false, available: [], unit: "Apt 1" });
  });
});
