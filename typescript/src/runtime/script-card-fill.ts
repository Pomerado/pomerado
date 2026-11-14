import { Schema } from "effect";
import { AutofillPopup } from "../destinations/autofill-contracts.js";

/**
 * A published script's card fill (`fillCard`): the script names each card field's selector and
 * the card answer `ask` returned for it, which is a handle, never the card itself. The host types
 * the caller's card into those fields under the card-fill step's checks and returns only what it
 * did, with no value in it. A host that fills a payment method the caller named instead takes
 * each field's card slot and the total the checkout shows.
 */

/** A run's card handle as `ask` returns it for a card question. */
export const runCardHandlePattern = /^\{\{card\.c[1-9]\d{0,3}\}\}$/u;

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));

/** The checkout's total as the page shows it: a decimal amount and an ISO 4217 currency code. */
const CardFillTotal = Schema.Struct({
  amount: Schema.String.pipe(Schema.pattern(/^\d+(?:\.\d{1,3})?$/u)),
  currency: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/u)),
});
export type CardFillTotal = typeof CardFillTotal.Type;

/** One to four card fields, each its own selector, none naming the same card part twice. */
const cardFields = <A, I>(field: Schema.Schema<A, I>, part: (field: A) => string, message: string) =>
  Schema.Array(field).pipe(
    Schema.minItems(1),
    Schema.maxItems(4),
    Schema.filter((fields) => new Set(fields.map(part)).size === fields.length, {
      message: () => message,
    }),
  );

/**
 * A card-fill step's fields: each the handle of a card answer (`handleField`), each handle once,
 * or each the card slot a host fills from a payment method, each slot once, with the checkout's
 * total. On a checkout the site opened in a pop-up, either names that pop-up as a sign-in step
 * does.
 */
export const cardFillFields = <Handled extends { readonly handle: string }, I>(
  handleField: Schema.Schema<Handled, I>,
) =>
  Schema.Union(
    Schema.Struct({
      popup: Schema.optional(AutofillPopup),
      fields: cardFields(handleField, (field) => field.handle, "name each card handle once"),
    }),
    Schema.Struct({
      popup: Schema.optional(AutofillPopup),
      fields: cardFields(
        Schema.Struct({
          selector: Selector,
          slot: Schema.Literal("card_number", "card_expiry", "card_cvc"),
        }),
        (field) => field.slot,
        "name each card slot once",
      ),
      total: CardFillTotal,
    }),
  );

/** What a script sends: one to four card fields with a card handle each, or a slot each and the total. */
export const ScriptCardFillRequest = cardFillFields(
  Schema.Struct({ selector: Selector, handle: Schema.String.pipe(Schema.pattern(runCardHandlePattern)) }),
);
export type ScriptCardFillRequest = typeof ScriptCardFillRequest.Type;

/** Each field's card part and how its typing went, as the host reports it. */
const FieldReport = Schema.Struct({
  slot: Schema.String.pipe(Schema.maxLength(32)),
  status: Schema.String.pipe(Schema.maxLength(64)),
});

/**
 * The host's answer: `filled` typed every field. `refused` typed nothing; `failed` and `uncertain`
 * may have typed some, as `typed` says. `message` is why, with no value in it.
 */
export const ScriptCardFillAnswer = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal("filled"),
    fields: Schema.Array(FieldReport).pipe(Schema.maxItems(4)),
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused", "failed", "uncertain"),
    typed: Schema.Boolean,
    message: Schema.String.pipe(Schema.maxLength(2_000)),
  }),
);
export type ScriptCardFillAnswer = typeof ScriptCardFillAnswer.Type;
