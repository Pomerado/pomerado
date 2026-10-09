import { expect, it } from "vitest";
import {
  signInOriginsToAsk,
  trustSignInOriginsQuestion,
  trustsSignInOrigins,
} from "../../src/standalone/sign-in-origin-question.js";

const siteOrigin = "https://www.shop.test";
const identity = "https://accounts.identity.test";
const analytics = "https://collect.analytics.test";
const none = { siteOrigin, trusted: [], asked: new Set<string>(), receivedProof: true };

it("asks about one to three https origins off the site that are neither trusted nor asked yet", () => {
  expect(signInOriginsToAsk([identity], none)).toEqual([identity]);
  expect(
    signInOriginsToAsk([identity, "https://token.identity.test", "https://other.test"], none),
  ).toEqual([identity, "https://token.identity.test", "https://other.test"]);
  for (const origins of [
    [],
    // More than three, all or nothing.
    [identity, "https://a.test", "https://b.test", "https://c.test"],
    // Plain HTTP, a path or a host on the site's registrable domain.
    ["http://accounts.identity.test"],
    [`${identity}/v1/sign-in`],
    ["https://login.shop.test"],
    // One the build already trusts or already asked about, beside one it did not.
    [identity, "https://configured.test"],
  ])
    expect(
      signInOriginsToAsk(origins, {
        siteOrigin,
        trusted: ["https://configured.test"],
        asked: new Set(),
        receivedProof: true,
      }),
    ).toBeUndefined();
  expect(signInOriginsToAsk([identity], { ...none, asked: new Set([identity]) })).toBeUndefined();
});

it("asks about two or three origins only once a password or a code went anywhere, and about one before that", () => {
  const early = { ...none, receivedProof: false };
  // An identifier screen whose email reached the identity service and an analytics script: the
  // check after the password screen asks instead.
  expect(signInOriginsToAsk([identity, analytics], early)).toBeUndefined();
  expect(
    signInOriginsToAsk([identity, analytics, "https://token.identity.test"], early),
  ).toBeUndefined();
  // One origin that heard the identifier alone, as an approval or email-link sign-in sends it.
  expect(signInOriginsToAsk([identity], early)).toEqual([identity]);
  expect(signInOriginsToAsk([identity, analytics], none)).toEqual([identity, analytics]);
});

it("asks one host question naming the site and each origin, and maps only a yes to trust", () => {
  const one = trustSignInOriginsQuestion("shop.test", [identity]);
  expect(one).toMatchObject({ source: "system" });
  expect(one).not.toHaveProperty("notice");
  expect(one.questions).toEqual([
    {
      id: "trust_sign_in_origin",
      type: "confirm",
      prompt:
        "Does shop.test sign in through https://accounts.identity.test? Its sign-in page sent the login you gave to that address, which is outside the website. Yes trusts it for signing in only and saves it with the tool, so its runs sign in the same way. No stops the build without publishing.",
    },
  ]);
  const two = trustSignInOriginsQuestion("shop.test", [identity, "https://token.identity.test"]);
  expect(two.questions[0]?.prompt).toBe(
    "Does shop.test sign in through https://accounts.identity.test and https://token.identity.test? Its sign-in page sent the login you gave to those addresses, which are outside the website. Yes trusts them for signing in only and saves them with the tool, so its runs sign in the same way. No stops the build without publishing.",
  );
  const three = trustSignInOriginsQuestion("shop.test", [identity, "https://a.test", "https://b.test"]);
  expect(three.questions[0]?.prompt).toContain(
    "through https://accounts.identity.test, https://a.test and https://b.test?",
  );
  expect(
    trustsSignInOrigins({ trust_sign_in_origin: { type: "confirm", value: { confirmed: true } } }),
  ).toBe(true);
  expect(
    trustsSignInOrigins({ trust_sign_in_origin: { type: "confirm", value: { confirmed: false } } }),
  ).toBe(false);
  expect(trustsSignInOrigins({})).toBe(false);
});
