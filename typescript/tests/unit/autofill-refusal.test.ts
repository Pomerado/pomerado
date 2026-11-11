import { expect, it } from "vitest";
import { urlOrigin } from "../../src/destinations/autofill-refusal.js";
import { codeBoxesRefusal, untrustedTarget } from "../../src/destinations/autofill-step.js";

// Page code can put any text in an opaque URL, its scheme included, so refusal evidence names one
// only from a fixed set.
it("names an opaque frame's URL from a fixed set, never by text the page put in it", () => {
  expect(
    [
      "about:blank",
      "about:srcdoc",
      "about:blank#synthetic-note",
      "about:synthetic%20page%20text",
      "data:text/html,synthetic-page-text",
      "javascript:void('synthetic-page-text')",
      "blob:null/0b1d0d5e-5b38-4c3b-9a3b-3f1c2c7d8e9f",
      // A navigation that failed shows Chromium's own error page.
      "chrome-error://chromewebdata/",
      "synthetic-page-text:x",
      "https://login.example.test:8443/session?next=%2Faccount",
    ].map(urlOrigin),
  ).toEqual([
    "about:blank",
    "about:srcdoc",
    "about:blank",
    "other",
    "data:",
    "javascript:",
    "blob:",
    "chrome-error:",
    "other",
    "https://login.example.test:8443",
  ]);
});

// Every script destination's origin reads `javascript:`, so a refusal's evidence also keeps the
// code of the script it refused, screened and cut short, to tell one script from another.
it("keeps the code of a refused form's script action in its evidence", () => {
  const site = "https://www.shop.example";
  const refusal = untrustedTarget(
    {
      fields: [
        {
          ownerUrl: site,
          documentOrigin: site,
          actions: ["javascript:"],
          scriptAction: false,
          scriptCode: "throw new Error('x')",
          methods: ["get"],
          editable: true,
          control: "text",
        },
      ],
      submit: null,
    },
    { fields: [{ selector: "#password", slot: "password" }] },
    { siteOrigin: site, authenticationOrigins: [] },
    0,
  );
  expect(refusal?.failureDetail?.context).toEqual({
    check: "destination",
    part: "form_action",
    frameOrigin: site,
    documentOrigin: site,
    actionOrigins: "javascript:",
    actionScript: "throw new Error('x')",
  });
});

// A code split across one-character boxes takes one character in each, so a code step reaches
// Guardian and the owner only when it names every box the screen shows, first to last.
it("sends back a code step that names part of its screen's one-character boxes, or names them out of order, saying which it named", () => {
  const code = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ selector: `#d${at + 1}`, slot: "code" as const }));
  const screen = (boxes: readonly ({ box: number; of: number } | undefined)[]) => ({
    screen: {
      origin: "https://bank.example.test",
      fields: boxes.map((codeBox) => ({
        tag: "input",
        role: null,
        formMethod: "post",
        type: "text",
        name: null,
        id: null,
        autocomplete: null,
        inputmode: "numeric",
        label: null,
        placeholder: null,
        ariaLabel: null,
        text: null,
        slot: "code" as const,
        ...(codeBox === undefined ? {} : { codeBox }),
      })),
      submit: null,
      buttons: [],
    },
  });
  const of = (order: readonly number[], count = 6) => order.map((box) => ({ box, of: count }));
  // Every box in order, a one-field code, and a code field that is no box pass.
  expect(codeBoxesRefusal({ fields: code(6) }, screen(of([1, 2, 3, 4, 5, 6])))).toBeUndefined();
  expect(codeBoxesRefusal({ fields: code(1) }, screen([undefined]))).toBeUndefined();
  expect(
    codeBoxesRefusal(
      { fields: [{ selector: "#user", slot: "username" }, ...code(1)] },
      screen([undefined, undefined]),
    ),
  ).toBeUndefined();
  // Only the first of seven, the boxes out of order, or one box twice are sent back.
  expect(codeBoxesRefusal({ fields: code(1) }, screen(of([1], 7)))).toMatchObject({
    outcome: "refused",
    reason: "code_boxes_incomplete",
    target: 0,
    codeBoxes: { boxes: 7, named: [1] },
  });
  expect(codeBoxesRefusal({ fields: code(6) }, screen(of([2, 1, 3, 4, 5, 6])))).toMatchObject({
    reason: "code_boxes_incomplete",
    codeBoxes: { boxes: 6, named: [2, 1, 3, 4, 5, 6] },
  });
  expect(codeBoxesRefusal({ fields: code(6) }, screen(of([1, 1, 3, 4, 5, 6])))).toMatchObject({
    codeBoxes: { boxes: 6, named: [1, 1, 3, 4, 5, 6] },
  });
  // A box that is not a code field counts for nothing: a username field is never a box.
  expect(
    codeBoxesRefusal(
      { fields: [{ selector: "#user", slot: "username" }, ...code(1)] },
      screen([{ box: 1, of: 2 }, { box: 2, of: 2 }]),
    ),
  ).toMatchObject({ target: 1, codeBoxes: { boxes: 2, named: [2] } });
});
