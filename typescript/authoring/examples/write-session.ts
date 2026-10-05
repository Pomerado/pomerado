import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";
import type { KernelOperationContext } from "../../src/browser/index.js";

// Observed contract: /checkout fills item, quantity and a gift-wrap add-on the page offers
// unchecked, Continue opens a review step, and Place order shows "Order ORD-…" on its
// confirmation page. Adapt every selector and condition from your own session's evidence.
// Every on-path option is an input: the add-on is the caller's choice, never kept or cleared
// unasked. An account-specific value (a passenger, saved card or address) would be a free-form
// input, never an enum member, example or default.
export const OrderInput = Schema.Struct({
  item: Schema.NonEmptyString.annotations({ description: "Item to order, as the site names it" }),
  quantity: Schema.Int.pipe(Schema.between(1, 99)).annotations({
    description: "How many to order, 1 to 99",
  }),
  gift_wrap: Schema.Boolean.annotations({ description: "Whether to add gift wrap" }),
});
type OrderInput = typeof OrderInput.Type;
const Placed = Schema.Struct({
  order_number: Schema.NonEmptyString.annotations({
    description: "Order number from the confirmation",
  }),
});
const Filled = Schema.Union(
  Schema.Struct({ review_shown: Schema.Literal(true) }),
  Schema.Struct({ failure: Schema.Literal("checkout_changed") }),
);
const Confirmed = Schema.Union(
  Schema.Struct({ order_number: Schema.NonEmptyString }),
  Schema.Struct({ failure: Schema.Literal("review_missing", "not_confirmed") }),
);
type Context = KernelOperationContext<OrderInput>;

// The act steps and the composed script share these calls, so the published script repeats
// exactly what the session did.

/** From the site origin page: open the checkout, fill it from the input and stop at the review step. */
const fillCheckout = async ({ kernel, sessionId, siteOrigin, input, errors }: Context) => {
  if (siteOrigin === undefined)
    throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      const checkout = ${JSON.stringify(new URL("/checkout", siteOrigin).href)};
      const input = ${JSON.stringify(input)};
      await page.goto(checkout, { waitUntil: "domcontentloaded", timeout: 30000 });
      const form = page.getByRole("form", { name: "Checkout", exact: true });
      if ((await form.count()) !== 1) return { failure: "checkout_changed" };
      await form.getByLabel("Item", { exact: true }).fill(input.item, { timeout: 5000 });
      await form.getByLabel("Quantity", { exact: true }).fill(String(input.quantity), { timeout: 5000 });
      await form.getByLabel("Gift wrap", { exact: true }).setChecked(input.gift_wrap, { timeout: 5000 });
      await form.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 5000 });
      await page.getByRole("button", { name: "Place order", exact: true }).waitFor({ timeout: 10000 });
      return { review_shown: true };
    `,
  });
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const filled = Schema.decodeUnknownSync(Filled)(answer.result);
  // Filling sends nothing the site keeps: a changed form fails before any commit.
  if ("failure" in filled)
    throw new errors.OperationFailure(filled.failure, { dispatch: "not_sent" });
};

/** The one commit, then the confirmation the site shows for it. Never clicked twice. */
const placeAndConfirm = async ({
  kernel,
  sessionId,
  errors,
  verified,
  enteringCommit,
}: Context) => {
  // The call below can send the order, so its commit step is marked first.
  enteringCommit("place-order");
  // One call clicks and reads: a confirmation already on the page cannot stand in for this one.
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      const place = page.getByRole("button", { name: "Place order", exact: true });
      if ((await place.count()) !== 1) return { failure: "review_missing" };
      await place.click({ timeout: 5000 });
      const confirmation = page.getByRole("status", { name: "Order confirmation", exact: true });
      try { await confirmation.waitFor({ timeout: 15000 }); } catch { return { failure: "not_confirmed" }; }
      const number = /^Order (ORD-[0-9]+)/.exec(await confirmation.innerText())?.[1];
      return number === undefined ? { failure: "not_confirmed" } : { order_number: number };
    `,
  });
  // A failure after the click leaves the write uncertain. Nothing here resubmits it.
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const result = Schema.decodeUnknownSync(Confirmed)(answer.result);
  if ("failure" in result)
    throw new errors.OperationFailure(result.failure, {
      dispatch: result.failure === "review_missing" ? "not_sent" : "sent",
    });
  // The site's own confirmation for this submission: the write landed.
  verified({ confirmation: "message" });
  return result;
};

/** Act step 1: fills the checkout on the site origin page and stops before the commit. */
export const fillStep = defineOperation(
  {
    name: "fill_checkout",
    input: OrderInput,
    output: Schema.Struct({
      review_shown: Schema.Boolean.annotations({ description: "True once the review step shows" }),
    }),
  },
  async (context) => {
    await fillCheckout(context);
    return { review_shown: true };
  },
);

/** Act step 2: continues on the page step 1 left, commits once and reads the confirmation. */
export const placeStep = defineOperation(
  { name: "place_order", input: OrderInput, output: Placed },
  placeAndConfirm,
);

/** The composed script, published without another run: the whole flow from the site origin page. */
export default defineOperation(
  {
    name: "place_order",
    input: OrderInput,
    output: Placed,
    write: { confirmation: "message", commits: ["place-order"] },
  },
  async (context) => {
    await fillCheckout(context);
    return placeAndConfirm(context);
  },
);
