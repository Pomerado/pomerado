import { expect, it } from "vitest";
import { urlOrigin } from "../../src/destinations/autofill-refusal.js";

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
