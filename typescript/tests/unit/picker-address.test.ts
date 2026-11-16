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
  test("takes a place by its name when the caller gave no house number; a write lists any other, a read takes the site's first in the caller's area", async () => {
    const asked = "Example Park, Exampleton, CA";
    const place = "Example Park, 12 Sample Plaza, Exampleton, CA";
    const longer = "Example Park Ferry Terminal, Exampleton, CA";
    // The suggestion whose name is the caller's place is taken, whatever street follows its name,
    // in either order and alone.
    for (const rows of [[place, longer], [longer, place], [place]])
      expect(await resolveAddress(asked, () => rows)).toMatchObject({ picked: true, label: place });
    expect(await resolveAddress(asked, () => [longer, place], String, { read: true })).toMatchObject({ picked: true, label: place });
    // A name holding the caller's among other words is another place: a write lists it, and a read
    // with no suggestion of that name takes the site's first when it is in the caller's area.
    expect(await resolveAddress(asked, () => [longer])).toEqual({
      picked: false,
      reason: "option_unclear",
      wanted: asked,
      available: [longer],
      matches: [longer],
      unit: "",
    });
    expect(await resolveAddress(asked, () => [longer], String, { read: true })).toMatchObject({ picked: true, label: longer });
    // So any other name, or a house the caller did not give, however many of its words it shares.
    const others = ["Example Gardens, Exampleton, CA", "Example Park Lot B, Exampleton, CA"];
    expect(await resolveAddress(asked, () => others)).toMatchObject({ picked: false, reason: "option_unclear", matches: others });
    for (const rows of [others, [...others].reverse()])
      expect(await resolveAddress(asked, () => rows, String, { read: true })).toMatchObject({ picked: true, label: rows[0] });
    // A read whose first suggestion is in another town, or state, refuses with the candidates.
    for (const away of ["Example Gardens, Otherton, CA", "Example Gardens, Exampleton, TX"])
      expect(await resolveAddress(asked, () => [away, ...others], String, { read: true })).toMatchObject({
        picked: false,
        reason: "option_unclear",
        matches: [away, ...others],
      });
    expect(await resolveAddress("Example St, Exampleton, IL", () => ["12 Example St, Exampleton, IL, USA"])).toMatchObject({ picked: false });
    // A name written another way word for word is the same name.
    expect(await resolveAddress("Example St, Exampleton, IL", () => ["Example Street, Exampleton, IL, USA"])).toMatchObject({ picked: true });
    // Of several with the name, a write takes the site's first, one that leaves out the state last.
    const named = ["Example Park, Exampleton", "Example Park, Exampleton, CA, USA", place];
    expect(await resolveAddress(asked, () => named)).toMatchObject({ picked: true, label: named[1] });
    expect(await resolveAddress(asked, () => [named[0] ?? "", place, named[1] ?? ""])).toMatchObject({ picked: true, label: place });
    // A place whose name holds a numbered street is taken by that name.
    const market = "5th Street Market, 40 Sample St, Exampleton, CA";
    expect(await resolveAddress("5th Street Market, Exampleton, CA", () => ["5th Street Market Garage, Exampleton, CA", market])).toMatchObject({
      picked: true,
      label: market,
    });
    // A street address with a house number is matched by its house number and street, as before.
    expect(await resolveAddress("12 Sample Plaza, Exampleton, CA", () => [longer, place])).toMatchObject({ picked: true, label: place });
  });

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
    // the caller's ZIP, a street type the caller got wrong, a direction letter written another way,
    // or a misspelled street never sends the address to another town.
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
    // A suggestion that keeps the address is taken over one ranked higher that does not, even one
    // whose town, joined to its street from another line, sits in its street's part.
    const joined = ["12 Example St Otherton, IL, USA", "12 Example St Exampleton, IL, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL 60000", () => joined)).toMatchObject({ picked: true, label: joined[1] });
    const zipped = ["12 Example St Exampleton, IL, USA", "12 Example St, Exampleton, IL 60999, USA"];
    expect(await resolveAddress("12 Example St, Exampleton, IL 60000", () => zipped)).toMatchObject({ picked: true, label: zipped[0] });
    expect(await resolveAddress("60000-1234", () => ["Exampleton, IL 60000, USA"])).toMatchObject({ picked: true });
    // A street only close to the caller's, with no word of it, is usable but not kept.
    expect(await resolveAddress("12 Example Street, Exampleton, IL", () => ["12 Exampel Rd, Exampleton, IL, USA"])).toMatchObject({ picked: false, reason: "option_unclear" });
    // A place word in a suggestion's street never counts, so only the other state's is usable.
    const streets = ["1 Exampleton Rd, Sampleton, IL, USA", "1 Example St, Exampleton, NY, USA"];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => streets)).toMatchObject({ picked: false, reason: "option_unclear", matches: [streets[1]] });
  });

  test("takes a place by its name over other places named after it, and never the site's control that lists more results", async () => {
    const asked = "Example International Airport (EXA), Exampleton, CA";
    const place = "Example International Airport (EXA), 400 Sample Rd, Exampleton, CA";
    const others = ["Terminal 2, EXA", "Sample Terminal 1", "Terminal 3 (Door 3-4)", "International Terminal (B gates)"];
    const controls = ["See more results for " + asked, 'Search for "Example International Airport (EXA), Exampleton, CA"'];
    for (const read of [false, true])
      expect(await resolveAddress(asked, () => [others[0] ?? "", place, ...others.slice(1), ...controls], String, { read })).toMatchObject({
        picked: true,
        label: place,
      });
    // Without the place, a write lists the other places and no control, and so does a read whose
    // first place is not in the caller's area; one in it is taken, past a control listed first.
    for (const read of [false, true])
      expect(await resolveAddress(asked, () => [...others, ...controls], String, { read })).toMatchObject({
        picked: false,
        reason: "option_unclear",
        available: others,
        matches: others,
      });
    const parking = "Example International Airport Parking, Exampleton, CA";
    expect(await resolveAddress(asked, () => [...controls, parking, ...others], String, { read: true })).toMatchObject({ picked: true, label: parking });
    // A place showing the typed text after a house number or a part of its own, or as its own
    // start, is no control.
    expect(await resolveAddress("Example Rd, Exampleton, CA", () => ["Example Park, Example Rd, Exampleton, CA"])).toMatchObject({
      matches: ["Example Park, Example Rd, Exampleton, CA"],
    });
    expect(await resolveAddress("Example St, Exampleton, IL", () => ["12 Example St, Exampleton, IL"])).toMatchObject({ matches: ["12 Example St, Exampleton, IL"] });
    expect(await resolveAddress("Example St, Exampleton, IL", () => ["Example St, Exampleton, IL, USA"])).toMatchObject({ picked: true });
  });

  test("lists a place whose name holds a word before the caller's text, and keeps a read to the caller's area", async () => {
    // A word before the caller's whole text, a site's country after it, or a count in the control's
    // words, is no reason to take a row for a control or a control for a place.
    for (const [asked, row] of [
      ["Example Park, Exampleton, CA", "The Example Park, Exampleton, CA, USA"],
      ["Exampleton, IL", "West Exampleton, IL, USA"],
      ["Example Rd, Exampleton, CA", "N Example Rd, Exampleton, CA"],
    ] as const)
      expect(await resolveAddress(asked, () => [row])).toMatchObject({ picked: false, reason: "option_unclear", matches: [row] });
    const asked = "Example Park, Exampleton, CA";
    expect(await resolveAddress(asked, () => ["See 12 more results for " + asked], String, { read: true })).toMatchObject({ picked: false, available: [] });
    expect(await resolveAddress(asked, () => ["See all results for " + asked + " (12)"], String, { read: true })).toMatchObject({ picked: false, available: [] });
    // A read takes no first suggestion that shows the caller's whole text after words of its own, as
    // a control the rule above leaves listed may, and no place taken for one either.
    for (const row of ['Search "' + asked + '"', "The Example Park, Exampleton, CA, USA"])
      expect(await resolveAddress(asked, () => [row], String, { read: true })).toMatchObject({ picked: false, matches: [row] });
    // A town given alone after the place's name is its town, so a read takes a first suggestion there.
    expect(await resolveAddress("Example Park, Exampleton", () => ["Example Gardens, Exampleton, CA"], String, { read: true })).toMatchObject({
      picked: true,
      label: "Example Gardens, Exampleton, CA",
    });
    // The place's own row that leaves out the state, with its street after its name, is taken.
    const place = "Example Park, 12 Sample Plaza, Exampleton";
    expect(await resolveAddress(asked, () => [place])).toMatchObject({ picked: true, label: place });
    // A read refuses a first suggestion whose town is only in its name, one in another town for a town
    // the caller named alone, one with no area to compare, and another house.
    for (const [address, row] of [
      [asked, "Exampleton Ferry Terminal, Otherton, CA"],
      ["Exampleton, IL", "Otherton, IL, USA"],
      ["Exampleton, IL 60000", "Otherton, IL, USA"],
      ["Example Park", "Set location on map"],
      ["1 Example St, Exampleton, IL 60000", "2 Example St, Exampleton, IL 60000, USA"],
    ] as const)
      expect(await resolveAddress(address, () => [row], String, { read: true })).toMatchObject({ picked: false });
    // A name the typed text brings only with a longer name is asked for again without its ZIP.
    const { suggest } = site({
      "Example Park, Exampleton, CA 90000": ["Example Park Ferry Terminal, Exampleton, CA 90000"],
      "Example Park, Exampleton, CA": ["Example Park, 12 Sample Plaza, Exampleton, CA 90000"],
    });
    expect(await resolveAddress("Example Park, Exampleton, CA 90000", suggest)).toMatchObject({ picked: true, label: "Example Park, 12 Sample Plaza, Exampleton, CA 90000" });
  });

  test("in a read, takes a suggestion that keeps the house number, street and place but shows another ZIP", async () => {
    const wanted = "1 Example St, Exampleton, IL 60000";
    const shown = ["1 Example St, Exampleton, IL 60001, USA"];
    expect(await resolveAddress(wanted, () => shown, String, { read: true })).toMatchObject({ picked: true, label: shown[0] });
    expect(await resolveAddress(wanted, () => shown)).toMatchObject({ picked: false, reason: "option_unclear" });
    const both = ["1 Example St, Exampleton, IL 60001, USA", "1 Example St, Exampleton, IL 60000, USA"];
    expect(await resolveAddress(wanted, () => both, String, { read: true })).toMatchObject({ label: both[1] });
    // Another house number, street or state, or no house number or place, still refuses.
    for (const other of ["2 Example St, Exampleton, IL 60001, USA", "1 Other St, Exampleton, IL 60001, USA", "1 Example St, Exampleton, WI 60001, USA"])
      expect(await resolveAddress(wanted, () => [other], String, { read: true })).toMatchObject({ picked: false });
    expect(await resolveAddress("Exampleton, IL 60000", () => ["Exampleton, IL 60001, USA"], String, { read: true })).toMatchObject({ picked: false });
    expect(await resolveAddress("1 Example St, 60000", () => ["1 Example St, Faraway, TX 75001, USA"], String, { read: true })).toMatchObject({ picked: false });
  });

  test("takes a suggestion that leaves out one of the caller's ZIP, town and state, and none that shows another", async () => {
    // A state after the town in one part is its own field too, and a street word written short
    // either way still keeps the street.
    for (const [wanted, shown] of [
      ["1 Example St, Exampleton, IL", "1 Example St, Exampleton"],
      ["1 Example St, Exampleton, IL", "1 Example St, IL"],
      ["1 Example St, Exampleton, IL", "1 Example St Exampleton"],
      ["1 Example St, Exampleton IL", "1 Example St, Exampleton"],
      ["1 Example St, Exampleton IL", "1 Example St, IL"],
      ["1 Example Building, Exampleton, IL", "1 Example Bldg, IL 60000"],
      ["1 Example Road, Exampleton, IL", "1 Example Rd, Exampleton"],
      ["1 N Example St, Exampleton, IL", "1 North Example St, Exampleton"],
      ["1 Example St, Exampleton New York", "1 Example St, Exampleton"],
      ["1 Example St, Exampleton, West Virginia", "1 Example St, Exampleton, WV"],
      ["1 Example St #4B, Exampleton, IL", "1 Example St #4B, Exampleton"],
      ["1 Example St, Exampleton New York", "1 Example St, NY"],
      ["1 Example St NW, Washington DC", "1 Example St NW, DC"],
      ["1 Example St, Exampleton, Illinois, USA", "1 Example St, Exampleton, IL, USA"],
      ["12 Example St, Exampleton IL 60000, USA", "12 Example St, Exampleton, IL, USA"],
      ["1 Example St, Exampleton IL, USA", "1 Example St, Exampleton, IL"],
      ["1 Example St, Exampleton Illinois", "1 Example St, Exampleton, IL"],
      ["1 Example St, Illinois Exampleton, Illinois", "1 Example St, Illinois Exampleton, IL"],
      ["1 Example St, Illinois Exampleton, IL", "1 Example St, Illinois Exampleton"],
    ])
      expect(await resolveAddress(wanted ?? "", () => [shown ?? ""])).toMatchObject({ picked: true, label: shown });
    expect(await resolveAddress("1 Example Building, Exampleton, IL 60000", () => ["1 Example Bldg, Exampleton, IL"])).toMatchObject({ picked: true });
    // Two left out, a ZIP beside the state counting as its own field; another town, state or ZIP,
    // also on the street's line or opening with a word of the caller's street; or a word of the
    // suggestion's street read as the town or state: none is taken.
    for (const [wanted, shown] of [
      ["1 Example St, Exampleton, IL 60000", "1 Example St, Exampleton"],
      ["1 Example St, Exampleton, IL 60000", "1 Example St, IL"],
      ["1 Example St, Exampleton, IL", "1 Example St, Sampleton, IL"],
      ["1 Example St, Exampleton, IL", "1 Example St Sampleton, IL"],
      ["1 Example St, Exampleton, IL", "1 Example St, Exampleton, WI"],
      ["1 Example St, North Exampleton, IL", "1 Example St, Exampleton"],
      ["1 Example Building, Exampleton, IL 60000", "1 Example Bldg, Exampleton, IL 60001"],
      ["1 Example Building, Exampleton, IL 60000", "1 Example Bldg, Sampleton, IL"],
      ["1 Example Building, Exampleton, IL", "1 Example Bldg Sampleton, IL"],
      ["1 West St, Exampleton, IL", "1 West St, West Exampleton"],
      ["1 Example St, Exampleton, MT", "1 Example St, St Exampleton"],
      ["1 Example St, Exampleton, MT", "1 Example St St Exampleton"],
      ["12 Exampleton Ave, Exampleton, IL", "12 Exampleton Ave"],
      ["12 Exampleton Ave, Exampleton, IL 60000", "12 Exampleton Ave, IL"],
      ["12 Exampleton Ave, Exampleton, IL", "12 Exampleton Ave, Sampleton, IL"],
      ["1 Example St, Exampleton, NJ", "1 Example St, New Exampleton"],
      ["1 Example St, Exampleton, WV", "1 Example St, Exampleton, Virginia"],
      ["1 Example St, Exampleton, West Virginia", "1 Example St, Exampleton, VA"],
      ["1 Example St, Washington DC", "1 Example St, WA"],
      ["1 Example St, Exampleton Center, MA", "1 Example St, Center, MA"],
      ["1 Example St, Exampleton New York", "1 Example St"],
      ["12 Example Rd, Exampleton, IL", "12 Example Riverside, IL"],
      ["1 Example St, Exampleton, IL", "Exampleton Mall, 1 Example St"],
      ["1 Example St, Washington, IL", "1 Example St, WA"],
      ["1 Example St, Washington, IL", "1 Example St, Washington, WA"],
      ["1 Example St NW, Washington DC", "1 Example St NW"],
      ["12 Example St, Washington, Pennsylvania", "12 Example St, Washington, Washington"],
      ["12 West Example St, Washington, West Virginia, USA", "12 West Example St, West Washington, Virginia"],
      ["12 Example St, Exampleton Illinois, USA", "12 Example St, USA"],
      ["1 Example St, Port Exampleton, PA", "1 Example St, Port, Exampleton 60000"],
      ["1 Example St, Port Washington", "1 Example St, Washington, PA"],
    ])
      expect(await resolveAddress(wanted ?? "", () => [shown ?? ""])).toMatchObject({ picked: false, reason: "option_unclear" });
  });

  test("lists a suggestion that leaves out the caller's town or state and shows no caller's ZIP when another ties or holds as much", async () => {
    const items = [
      { text: "1 Example St, Exampleton", id: "a" },
      { text: "1 Example St, Exampleton", id: "b" },
    ];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => items.slice(0, 1), (item) => item.text)).toMatchObject({ picked: true, choice: { id: "a" } });
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => items, (item) => item.text)).toMatchObject({
      picked: false,
      reason: "option_unclear",
      matches: ["1 Example St, Exampleton"],
    });
    const zips = ["1 Example St, Exampleton 60000", "1 Example St, Exampleton 70000"];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => zips)).toMatchObject({ picked: false, reason: "option_unclear", matches: zips });
    // The same street and town in another state, a same-named town, is listed too.
    const states = ["1 Example St, Exampleton, WI", "1 Example St, Exampleton"];
    expect(await resolveAddress("1 Example St, Exampleton, IL", () => states)).toMatchObject({ picked: false, reason: "option_unclear", matches: states });
    // Another street, or the street with a unit, is no rival.
    for (const shown of ["12 Example Ave, Exampleton", "12 Example St Apt 1, Exampleton"])
      expect(await resolveAddress("12 Example St, Exampleton, IL", () => ["12 Example St, Exampleton", shown])).toMatchObject({
        picked: true,
        label: "12 Example St, Exampleton",
      });
  });

  test("returns as a candidate a suggestion whose street shows another direction or street number", async () => {
    // Another direction, short or spelled out, before or after the name, or one added or dropped,
    // with the suggestion's street running on into its town or not; or another number.
    for (const [address, shown] of [
      ["1 N Example St, Exampleton, IL", "1 S Example St Exampleton, IL, USA"],
      ["1 North Example St, Exampleton, IL 60000", "1 S Example St, Exampleton, IL 60000, USA"],
      ["1 N Example St, 60000", "1 S Example St, Exampleton, IL 60000, USA"],
      ["100 NE 3rd Ave, Exampleton, FL", "100 Northwest 3rd Ave Exampleton, FL, USA"],
      ["1 Example St N, Exampleton, IL", "1 Example St S Exampleton, IL, USA"],
      ["12 Example St, Exampleton, IL", "12 N Example St, Exampleton, IL, USA"],
      ["12 N Example St, Exampleton, IL", "12 Example St Exampleton, IL, USA"],
      ["12 Example St, North Exampleton, NV", "12 N Example St, North Exampleton, NV, USA"],
      ["12 N Example St, North Exampleton, NV", "12 Example St North Exampleton, NV, USA"],
      ["12 Route 9, Exampleton, NJ", "12 Route 90 Exampleton, NJ, USA"],
      ["455 E 500 S, Exampleton, UT", "455 S 500 E Exampleton, UT, USA"],
      ["1 Example St, Exampleton, NE", "1 Example St NE, Exampleton, NE 68000, USA"],
      ["1 Example St NE, Exampleton, NE", "1 Example St, Exampleton, NE 68000, USA"],
      ["1 Example St, Exampleton, NE", "1 Example St NE, Exampleton, Nebraska 68000, USA"],
      ["1 Example St NE, Exampleton, Nebraska", "1 Example St, Exampleton, NE 68000, USA"],
      ["1 Example St, West Sampleton, FL", "1 Example St West, Sampleton, FL, USA"],
    ])
      expect(await resolveAddress(address ?? "", () => [shown ?? ""])).toMatchObject({ picked: false, reason: "option_unclear", matches: [shown] });
    // So in a read under another ZIP too.
    for (const [address, shown] of [
      ["1 N Example St, Exampleton, IL 60000", "1 S Example St, Exampleton, IL 60001, USA"],
      ["12 Route 9, Exampleton, NJ 07000", "12 Route 90, Exampleton, NJ 07001, USA"],
    ])
      expect(await resolveAddress(address ?? "", () => [shown ?? ""], String, { read: true })).toMatchObject({ picked: false });
    // With both listed, the caller's direction is taken, whatever the site's order.
    const both = ["1 S Example St Exampleton, IL, USA", "1 N Example St Exampleton, IL, USA"];
    expect(await resolveAddress("1 N Example St, Exampleton, IL 60000", () => both)).toMatchObject({ label: both[1] });
    expect(await resolveAddress("1 Example St, Exampleton, IL 60000", () => both)).toMatchObject({ picked: false, matches: both });
    // The same direction written another way, or a direction word in a town or state, keeps the
    // street, whichever side runs its street on into its town.
    for (const [address, shown] of [
      ["1 N Example St, Exampleton, IL", "1 North Example St Exampleton, IL, USA"],
      ["100 Northeast 3rd Ave, Exampleton, FL", "100 NE 3rd Ave Exampleton, FL, USA"],
      ["1 Example St, South Exampleton, IN", "1 Example St South Exampleton, IN, USA"],
      ["1 Example St South Exampleton IN 46000", "1 Example St, South Exampleton, IN 46000, USA"],
      ["1 NE Example St, Exampleton, NE", "1 NE Example St Exampleton, NE, USA"],
      ["1 Example St Exampleton NE 68000", "1 Example St, Exampleton, NE 68000, USA"],
      ["1 Example St, South Exampleton IN 46000", "1 Example St South Exampleton, IN, USA"],
      ["1600 Example Ave N.W., Exampleton, DC", "1600 Example Ave NW Exampleton, DC, USA"],
      // A unit on the street's line keeps its street's own number.
      ["350 5th Ave Apt 3, Exampleton, NY", "350 5th Ave, Exampleton, NY, USA"],
      ["350 5th Ave, Apt 3, Exampleton, NY", "350 5th Ave Apt 3, Exampleton, NY, USA"],
      ["350 Fifth Ave Apt 3, Exampleton, NY", "350 5th Ave, Exampleton, NY, USA"],
    ])
      expect(await resolveAddress(address ?? "", () => [shown ?? ""])).toMatchObject({ picked: true, label: shown });
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
    // A place's name before its address may open with a number of its own.
    for (const name of ["24 Hour Sample", "12 Hour Sample"])
      expect(await houses("12 Example St, Exampleton, IL", [`${name}, 12 Example St, Exampleton, IL, USA`])).toBe(`${name}, 12 Example St, Exampleton, IL, USA`);
    expect(await houses("12 Example St, Exampleton, IL", ["2 mi, Sample Place, 15 Example St, Exampleton, IL, USA"])).toBe(false);
    // A later part opening with the caller's house number, such as a distance or a town, is not the street.
    for (const [address, shown] of [
      ["12 Example St, Exampleton, IL", "12 Example St, Exampleton, IL, USA, 12 min"],
      ["100 Main St, 100 Mile House, BC", "100 Main St, 100 Mile House, BC, Canada"],
    ])
      expect(await houses(address ?? "", [shown ?? ""])).toBe(shown);
  });

  test("keeps the unit when only a place's name or a distance beside the suggestion holds its number", async () => {
    for (const [address, shown, unit] of [
      ["5 Sample Blvd, Suite 5, Example City, IL", "5 Sample Bar, 5 Sample Blvd, Example City, IL, USA", "Suite 5"],
      ["100 Example St, Suite 24, Exampleton, IL", "24 Hour Sample, 100 Example St, Exampleton, IL, USA", "Suite 24"],
      ["12 Example St, Apt 2, Exampleton, IL", "Sample Cafe, 12 Example St, Exampleton, IL, USA, 2 mi", "Apt 2"],
      ["12 Example St, Apt 2, Exampleton, IL", "Sample Cafe, 12 Example St, Exampleton, IL, USA, 1.2 mi", "Apt 2"],
      ["12 Example St, Apt 2, Exampleton, IL", "0.2 mi, Sample Cafe, 12 Example St, Exampleton, IL, USA", "Apt 2"],
      ["12 Example St, Suite 39, Exampleton, IL", "Pier 39, 12 Example St, Exampleton, IL, USA", "Suite 39"],
    ])
      expect(await resolveAddress(address ?? "", () => [shown ?? ""])).toMatchObject({ picked: true, label: shown, unit });
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
