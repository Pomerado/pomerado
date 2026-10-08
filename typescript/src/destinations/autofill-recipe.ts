import { Option, Schema } from "effect";
import {
  AutofillApproval,
  AutofillPopup,
  DateControl,
  DateOfBirthFormat,
  IdentifierKinds,
  maximumStepFields,
  RejectedMarker,
  SecretSlots,
  SignInMethodChoice,
} from "./autofill-contracts.js";
import type { AutofillField } from "./autofill-step.js";
export {
  AutofillPopup,
  RejectedMarker,
  SignInMethodChoice,
  SignInMethod,
} from "./autofill-contracts.js";

/** The bundle file a minted tool's sign-in recipe ships as, beside its source. */
export const autofillRecipePath = "auth-fill.json";

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/**
 * A recorded field: an identifier field by every kind it accepts, which each run resolves against
 * its own login, or a secret field by its slot.
 */
const RecipeField = Schema.Union(
  Schema.Struct({
    selector: Selector,
    accepts: Schema.Array(IdentifierKinds).pipe(Schema.minItems(1), Schema.maxItems(4)),
  }),
  Schema.Struct({
    selector: Selector,
    slot: SecretSlots,
    format: Schema.optional(DateOfBirthFormat),
    control: Schema.optional(DateControl),
    /** A security answer's question, which each replay reads again; never the answer. */
    questionSelector: Schema.optional(Selector),
  }),
);

/**
 * One recorded sign-in screen: the page it ran on (origin and path), the fields the host filled by
 * slot, and the control that submitted them, clicked by the host or, after a missed host click, by
 * the minter. A two-factor method choice records every method the screen offered, each with the
 * control that picks it, and its `submit` is the one the mint picked.
 */
const RecipeStep = Schema.Struct({
  rejectedMarkers: Schema.optional(
    Schema.Array(RejectedMarker).pipe(Schema.maxItems(maximumStepFields)),
  ),
  page: Schema.String.pipe(Schema.maxLength(2_000)),
  fields: Schema.Array(RecipeField).pipe(Schema.maxItems(maximumStepFields)),
  submit: Schema.optional(Selector),
  submittedBy: Schema.optional(Schema.Literal("host", "minter")),
  methods: Schema.optional(
    Schema.Array(Schema.Struct({ method: SignInMethodChoice, selector: Selector })).pipe(
      Schema.minItems(1),
      Schema.maxItems(8),
    ),
  ),
});

/**
 * A verified autofill sign-in, value-free: selectors, slots, submits and pages, and the indicator
 * the minter found and the host checked. A run replays it with the host's own fill. `version` is
 * what a host checks before replaying: a host that does not know it refuses the recipe rather than
 * dropping step metadata or typing into a different page.
 */
export const LegacyAutofillRecipe = Schema.Struct({
  version: Schema.Literal(1),
  steps: Schema.Array(RecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  /**
   * The deterministic check that the sign-in worked: a marker on the page it lands on, or on the
   * account page `openPath` the host opens first.
   */
  signedIn: Schema.Struct({
    selector: Schema.optional(Selector),
    urlPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
    openPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  }),
});
const PopupRecipeStep = Schema.Struct({
  ...RecipeStep.fields,
  popup: Schema.optional(AutofillPopup),
  approval: Schema.optional(AutofillApproval),
});
/** Version 2 keeps a host that does not know it from dropping popup metadata and filling the primary tab. */
export const PopupAutofillRecipe = Schema.Struct({
  ...LegacyAutofillRecipe.fields,
  version: Schema.Literal(2),
  steps: Schema.Array(PopupRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
});
export const AutofillRecipe = Schema.Union(LegacyAutofillRecipe, PopupAutofillRecipe);
export type AutofillRecipe = typeof AutofillRecipe.Type;
export type AutofillRecipeStep = typeof PopupRecipeStep.Type;

/** The bundle's recipe, or undefined when it has none or one this host cannot replay. */
export const publishedAutofillRecipe = (
  bundle: ReadonlyMap<string, string>,
): AutofillRecipe | undefined => {
  const text = bundle.get(autofillRecipePath);
  return text === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.parseJson(AutofillRecipe))(text));
};

/**
 * One screen of a sign-in as a host ran it, value-free: what a run replays. `submittedBy` is
 * `minter` when the host's click failed and the minter clicked it itself.
 */
interface RecordedRecipeStep {
  readonly popup?: AutofillRecipeStep["popup"] | undefined;
  readonly approval?: AutofillRecipeStep["approval"] | undefined;
  readonly rejectedMarkers?: AutofillRecipeStep["rejectedMarkers"] | undefined;
  /** With each identifier field's accepted kinds, never a value. */
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  readonly submittedBy?: "host" | "minter" | undefined;
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillRecipeStep["methods"] | undefined;
  /** The page the step ran on, origin and path only. */
  readonly page: string;
}

const isIdentifierKind = Schema.is(IdentifierKinds);

/**
 * A recorded screen as the recipe ships it: an identifier field by the kinds it accepts, never the
 * kind this login sent, which each run resolves against its own login.
 */
export const recipeStep = (step: RecordedRecipeStep): AutofillRecipeStep => ({
  page: step.page,
  ...(step.approval === undefined ? {} : { approval: step.approval }),
  ...(step.popup === undefined ? {} : { popup: step.popup }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
  fields: step.fields.map((field) =>
    !isIdentifierKind(field.slot)
      ? {
          selector: field.selector,
          slot: field.slot,
          ...(field.format === undefined ? {} : { format: field.format }),
          ...(field.control === undefined ? {} : { control: field.control }),
          // A replay reads the question again; the recipe never holds an answer.
          ...(field.questionSelector === undefined
            ? {}
            : { questionSelector: field.questionSelector }),
        }
      : { selector: field.selector, accepts: field.accepts ?? [field.slot] },
  ),
  ...(step.submit === undefined ? {} : { submit: step.submit }),
  ...(step.submittedBy === undefined ? {} : { submittedBy: step.submittedBy }),
  ...(step.methods === undefined ? {} : { methods: step.methods }),
});

/**
 * A verified sign-in's recipe: version 2 only with a popup or an approval, else version 1. A
 * security answer's question selector rides in either.
 */
export const autofillRecipe = <SignedIn>(
  steps: readonly RecordedRecipeStep[],
  signedIn: SignedIn,
) => ({
  version: steps.some((step) => step.popup !== undefined || step.approval !== undefined)
    ? (2 as const)
    : (1 as const),
  steps: steps.map(recipeStep),
  signedIn,
});
