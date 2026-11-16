import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { runCardFill, type CardFillReview } from "../../src/destinations/card-fill.js";
import { makeSecretHandles } from "../../src/mint/secret-handles.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

const site = "https://shop.example.test";
const card = {
  number: "4242 4242 4242 4242",
  expiry: "12 / 34",
  cvc: "123",
  zip: "94110",
};
// The fields of a processor's card frame, as Stripe's Payment Element names them.
const cardForm = `<label for="payment-numberInput">Card number</label><input id="payment-numberInput" name="number" autocomplete="cc-number" inputmode="numeric" placeholder="1234 1234 1234 1234">
<label for="payment-expiryInput">Expiration date</label><input id="payment-expiryInput" name="expiry" autocomplete="cc-exp" placeholder="MM / YY">
<label for="payment-cvcInput">Security code</label><input id="payment-cvcInput" name="cvc" autocomplete="cc-csc" placeholder="CVC">
<label for="payment-postalCodeInput">ZIP code</label><input id="payment-postalCodeInput" name="postalCode" autocomplete="billing postal-code" placeholder="12345">`;
const selectors = [
  "#payment-numberInput",
  "#payment-expiryInput",
  "#payment-cvcInput",
  "#payment-postalCodeInput",
];

// A separate process is essential here: Chromium must scope the resolved native node to its OOPIF.
test.use({ launchOptions: { args: ["--site-per-process"] } });

/** A checkout at `top` whose card fields sit in a frame served from `frameOrigin`. */
const checkout = async (page: Page, top: string, frameOrigin: string) => {
  await page.route(`${new URL(top).origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<h1>Checkout</h1><iframe title="Secure payment input frame" src="${frameOrigin}/v3/elements-inner.html"></iframe>`,
    }),
  );
  await page.route(`${frameOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: cardForm }),
  );
  await page.goto(top);
  const frame = page.frames().find((candidate) => candidate.url().startsWith(frameOrigin));
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("#payment-numberInput").waitFor();
  return frame;
};

const fill = async (page: Page, fieldSelectors: readonly string[] = selectors) => {
  const handles = makeSecretHandles();
  const answers = handles.issue(
    {
      number: { type: "secret", value: card.number },
      expiry: { type: "secret", value: card.expiry },
      cvc: { type: "secret", value: card.cvc },
      zip: { type: "secret", value: card.zip },
    },
    { number: "card_number", expiry: "card_expiry", cvc: "card_cvc", zip: "billing_postal_code" },
  );
  const handleFor = (id: string) => {
    const answer = answers[id];
    if (answer?.type !== "secret") throw new Error("Not a secret");
    return answer.value;
  };
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const reviews: CardFillReview[] = [];
  const outcome = await Effect.runPromise(
    runCardFill({
      step: {
        fields: ["number", "expiry", "cvc", "zip"].map((id, index) => ({
          selector: fieldSelectors[index] ?? "",
          handle: handleFor(id),
        })),
      },
      handles,
      page: host,
      keyboard,
      siteOrigin: site,
      review: (source) =>
        Effect.sync(() => {
          reviews.push(source);
        }),
      beforeTyping: () => Effect.void,
    }),
  );
  return { outcome, reviews, calls: host.calls };
};

test("types a card into a payment processor's frame on the site's checkout", async ({ page }) => {
  const frame = await checkout(page, `${site}/checkout`, "https://js.stripe.com");
  const { outcome, reviews, calls } = await fill(page);
  expect(outcome.status).toBe("filled");
  expect(await Promise.all(selectors.map((selector) => frame.locator(selector).inputValue()))).toEqual(
    Object.values(card),
  );
  // Guardian saw the frame's labels and handles; no value reached a page call, Guardian or the result.
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.screen.origin).toBe("https://js.stripe.com");
  expect(reviews[0]?.screen.fields.map((field) => field.label)).toEqual([
    "Card number",
    "Expiration date",
    "Security code",
    "ZIP code",
  ]);
  for (const value of [card.number, card.expiry, card.zip]) {
    expectNotCarried(calls, value);
    expect(JSON.stringify(reviews)).not.toContain(value);
    expect(outcome.observations).not.toContain(value);
  }
});

test("types nothing into a frame on an origin off the list", async ({ page }) => {
  const frame = await checkout(page, `${site}/checkout`, "https://pay.example.org");
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("https://pay.example.org");
  expect(reviews).toEqual([]);
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe("");
});

test("types nothing when the page's top document left the site", async ({ page }) => {
  const frame = await checkout(page, "https://checkout.example.org/pay", "https://js.stripe.com");
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("top document is not on this site");
  expect(reviews).toEqual([]);
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe("");
});

test("types nothing into a payment frame that a frame off the site wraps", async ({ page }) => {
  const wrapper = "https://wrapper.example.org";
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<h1>Checkout</h1><iframe title="Checkout widget" src="${wrapper}/widget.html"></iframe>`,
    }),
  );
  await page.route(`${wrapper}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe title="Secure payment input frame" src="https://js.stripe.com/v3/elements-inner.html"></iframe>`,
    }),
  );
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: cardForm }),
  );
  await page.goto(`${site}/checkout`);
  const frame = page.frames().find((candidate) => candidate.url().startsWith("https://js.stripe.com"));
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("#payment-numberInput").waitFor();
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("field 1 is in a frame on https://wrapper.example.org");
  expect(reviews).toEqual([]);
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe("");
});

/**
 * A card fill from a payment method, as a host that fills the card itself runs it: each card
 * field by its slot and `fieldSelectors`, the host's fill noting the selectors it was handed.
 */
const fillFromMethod = async (page: Page, fieldSelectors: readonly string[]) => {
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const reviews: CardFillReview[] = [];
  const handedOver: string[][] = [];
  const outcome = await Effect.runPromise(
    runCardFill({
      step: {
        fields: (["card_number", "card_expiry", "card_cvc"] as const).map((slot, index) => ({
          selector: fieldSelectors[index] ?? "",
          slot,
        })),
        total: { amount: "12.50", currency: "USD" },
      },
      handles: makeSecretHandles(),
      page: host,
      keyboard,
      siteOrigin: site,
      review: (source) =>
        Effect.sync(() => {
          reviews.push(source);
        }),
      beforeTyping: () => Effect.void,
      fillVia: ({ step }) =>
        Effect.sync(() => {
          handedOver.push(step.fields.map((field) => field.selector));
          return {
            outcome: "filled" as const,
            fields: step.fields.map(({ slot }) => ({ slot, status: "filled" as const })),
            submit: "none" as const,
            url: `${site}/checkout`,
            typed: true,
          };
        }),
    }),
  );
  return { outcome, reviews, handedOver };
};

// The host's card fill takes CSS selectors only, each matching one editable field across the
// page's frames, so the inspection refuses any other before Guardian's review or the host's fill.
// Core's own typing still takes any selector it finds.
test("a card fill from a payment method refuses a role selector before the review and the host's fill", async ({
  page,
}) => {
  const frame = await checkout(page, `${site}/checkout`, "https://js.stripe.com");
  const roles = ["Card number", "Expiration date", "Security code", "ZIP code"].map(
    (name) => `role=textbox[name="${name}"]`,
  );
  const refused = await fillFromMethod(page, roles);
  expect(refused.outcome).toMatchObject({
    status: "refused",
    report: { outcome: "refused", reason: "selector_unsupported", target: 0 },
  });
  expect(refused.outcome.observations).toContain("field 1's selector");
  expect(refused.reviews).toEqual([]);
  expect(refused.handedOver).toEqual([]);
  const css = await fillFromMethod(page, selectors.slice(0, 3));
  expect(css.outcome.status).toBe("filled");
  expect(css.reviews).toHaveLength(1);
  expect(css.handedOver).toEqual([selectors.slice(0, 3)]);
  const typed = await fill(page, roles);
  expect(typed.outcome.status).toBe("filled");
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe(card.number);
});

test("a card fill from a payment method whose fields the page doesn't show yet is refused as not found", async ({
  page,
}) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Checkout</h1>" }),
  );
  await page.goto(`${site}/checkout`);
  const { outcome, reviews, handedOver } = await fillFromMethod(page, selectors.slice(0, 3));
  expect(outcome).toMatchObject({ status: "refused", report: { reason: "not_found", target: 0 } });
  expect(reviews).toEqual([]);
  expect(handedOver).toEqual([]);
});

test("a card fill from a payment method refuses a CSS selector matching two editable fields", async ({
  page,
}) => {
  const frame = await checkout(page, `${site}/checkout`, "https://js.stripe.com");
  // A second, hidden card number field in the payment frame: one visible match, two editable.
  await frame.evaluate(() => {
    const twin = document.createElement("input");
    twin.className = "card-number";
    twin.hidden = true;
    document.querySelector("#payment-numberInput")?.classList.add("card-number");
    document.body.append(twin);
  });
  const { outcome, reviews, handedOver } = await fillFromMethod(page, [
    ".card-number",
    ...selectors.slice(1, 3),
  ]);
  expect(outcome).toMatchObject({
    status: "refused",
    report: { reason: "selector_unsupported", target: 0 },
  });
  expect(reviews).toEqual([]);
  expect(handedOver).toEqual([]);
});

// The selector check comes after the step's other checks, so a field they refuse keeps their reason.
test("a card fill from a payment method refuses a switched-off card field as not editable", async ({
  page,
}) => {
  const frame = await checkout(page, `${site}/checkout`, "https://js.stripe.com");
  await frame.evaluate(() => document.querySelector("#payment-numberInput")?.setAttribute("disabled", ""));
  const { outcome, reviews, handedOver } = await fillFromMethod(page, selectors.slice(0, 3));
  expect(outcome).toMatchObject({ status: "refused", report: { reason: "not_editable", target: 0 } });
  expect(reviews).toEqual([]);
  expect(handedOver).toEqual([]);
});

/** A checkout whose card fields sit on the site's own page, inside `form`. */
const ownPage = async (page: Page, form: string) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<h1>Checkout</h1>${form}${cardForm}</form>` }),
  );
  await page.goto(`${site}/checkout`);
  await page.locator("#payment-numberInput").waitFor();
};

test("types into card fields on the site's own page in a form that names no method", async ({ page }) => {
  await ownPage(page, "<form>");
  const { outcome } = await fill(page);
  expect(outcome.status).toBe("filled");
});

// A card form shown again keeps its expiry field's mask, which the mask's script puts back once
// the field is emptied or takes the focus. A mask with no digit is no value, so the card goes in.
test("types into a card expiry field whose mask comes back once it is emptied", async ({ page }) => {
  await ownPage(
    page,
    `<form><script>
addEventListener("DOMContentLoaded", () => {
  const expiry = document.querySelector("#payment-expiryInput");
  const mask = () => {
    const digits = expiry.value.replace(/\\D/g, "").slice(0, 4);
    expiry.value = digits === "" ? "__ / __" : \`\${digits.slice(0, 2)} / \${digits.slice(2)}\`;
  };
  expiry.value = "__ / __";
  expiry.addEventListener("input", mask);
  expiry.addEventListener("focus", mask);
});
</script>`,
  );
  const { outcome } = await fill(page);
  expect(outcome.status).toBe("filled");
  expect(await page.locator("#payment-expiryInput").inputValue()).toBe("12 / 34");
});

test("types nothing into card fields on the site's own page in a form that says GET", async ({ page }) => {
  await ownPage(page, '<form method="GET" action="/pay">');
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("field 1's form sends by GET");
  expect(reviews).toEqual([]);
  expect(await page.locator("#payment-numberInput").inputValue()).toBe("");
});
