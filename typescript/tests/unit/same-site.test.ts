import { expect, it } from "vitest";
import { sameSite, siteDomain } from "../../src/runtime/same-site.js";

it.each([
  ["https://flights.example.com", "example.com"],
  ["https://example.com", "example.com"],
  ["https://app.example.co.uk", "example.co.uk"],
  // A private suffix keeps each user's page its own site.
  ["https://alice.github.io", "alice.github.io"],
  ["https://flights.site.invalid", "site.invalid"],
])("the site of %s is %s", (origin, domain) => {
  expect(siteDomain(origin)).toBe(domain);
  expect(sameSite(origin, new URL(`https://www.${domain}/travel`))).toBe(true);
  expect(sameSite(origin, new URL(`https://login.${domain}/`))).toBe(true);
  expect(sameSite(origin, new URL(`http://www.${domain}/`))).toBe(false);
});

it.each([
  "http://flights.example.com",
  "https://flights.example.com/travel",
  "https://127.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://github.io",
  "not a url",
])("%s names no site beyond its exact origin", (origin) => {
  expect(siteDomain(origin)).toBeUndefined();
});

it("keeps other users' pages on a private suffix apart", () => {
  expect(sameSite("https://alice.github.io", new URL("https://bob.github.io/"))).toBe(false);
  expect(sameSite("https://flights.example.com", new URL("https://example.org/"))).toBe(false);
});
