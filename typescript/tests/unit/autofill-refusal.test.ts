import { expect, it } from "vitest";
import { urlOrigin } from "../../src/destinations/autofill-refusal.js";
import {
  codeBoxesRefusal,
  slotControlRefusal,
  untrustedTarget,
} from "../../src/destinations/autofill-step.js";

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

// A slot the step gives a field is checked against what the control's own markup says it takes.
// The check reads only strong evidence, so a PIN that stands in for a password, a card's security
// code or a promo box is never taken for a one-time code, and a masked or numeric box proves
// nothing by itself.
it("refuses a password slot only on a control its markup names a one-time code, and a code slot only on a marked password", () => {
  type Named = "type" | "name" | "id" | "autocomplete" | "inputmode" | "label" | "placeholder";
  type Attributes = Partial<Record<Named | "ariaLabel", string>>;
  const control = (attributes: Attributes) => ({
    tag: "input",
    role: null,
    formMethod: "post",
    type: "text",
    name: null,
    id: null,
    autocomplete: null,
    inputmode: null,
    label: null,
    placeholder: null,
    ariaLabel: null,
    text: null,
    slot: "password" as const,
    ...attributes,
  });
  const check = (slot: "password" | "code", attributes: Attributes) =>
    slotControlRefusal(
      { fields: [{ selector: "#field", slot }] },
      {
        screen: {
          origin: "https://www.example.test",
          fields: [control(attributes)],
          submit: null,
          buttons: [],
        },
      },
    )?.slotControl;
  const password = (attributes: Attributes) => check("password", attributes);
  expect(password({ type: "password", autocomplete: "one-time-code" })).toEqual({
    slot: "password",
    control: "code",
    evidence: "autocomplete",
  });
  expect(password({ name: "totpToken" })?.evidence).toBe("name");
  expect(password({ id: "mfa_code" })?.evidence).toBe("name");
  expect(password({ type: "password", label: "Authentication code" })?.evidence).toBe("label");
  expect(password({ placeholder: "Enter the code from your authenticator app" })?.evidence).toBe(
    "label",
  );
  expect(password({ ariaLabel: "Two-factor code" })?.evidence).toBe("label");
  // Never a code by itself: a numeric PIN box, a masked box, a card's security code, a promo box,
  // a passcode, or a name that also names a password.
  const neverCodes: Attributes[] = [
    { type: "password", inputmode: "numeric", name: "pin", label: "PIN" },
    { type: "password", label: "Passcode" },
    { label: "Security code", name: "cvc" },
    { name: "promo-code", label: "Promo code" },
    { name: "mfa-password", label: "Password" },
    { type: "password", autocomplete: "current-password", label: "Password" },
    // A passcode the site names for signing in is the account's own secret.
    { type: "password", label: "Login passcode" },
    { type: "password", label: "Sign-in passcode" },
    // A control whose own words also name a password points both ways, so it stands.
    { type: "password", label: "Password or one-time code" },
    { type: "password", label: "Password followed by your authentication code" },
    { type: "password", label: "Authenticator app password" },
    { type: "password", autocomplete: "one-time-code", label: "Password" },
    { type: "password", autocomplete: "one-time-code", name: "password" },
  ];
  for (const attributes of neverCodes) expect(password(attributes)).toBeUndefined();
  // A code slot is refused only on a control marked as the account's password.
  expect(check("code", { type: "password", autocomplete: "current-password" })).toEqual({
    slot: "code",
    control: "password",
    evidence: "autocomplete",
  });
  expect(check("code", { autocomplete: "section-login new-password" })?.control).toBe("password");
  expect(check("code", { type: "password", label: "Verification code" })).toBeUndefined();
  expect(check("code", { autocomplete: "one-time-code" })).toBeUndefined();
  // A code box a site marks new-password to keep password managers out is a code by its other
  // words: the evidence points both ways, so neither slot is refused and no step is trapped.
  for (const attributes of [
    { autocomplete: "new-password", name: "otp" },
    { autocomplete: "new-password", label: "Verification code" },
  ]) {
    expect(check("code", attributes)).toBeUndefined();
    expect(check("password", attributes)).toBeUndefined();
  }
});
