import { Schema } from "effect";
import { SignInMethod } from "./autofill-contracts.js";

/**
 * A value a tool's sign-in takes from its caller or the saved login, as the tool's public
 * `login_fields` names it. One-time codes, recovery codes included, never appear: a run gets them
 * from the owner or the saved login, never from its call.
 */
export const LoginField = Schema.Literal(
  "username",
  "password",
  "email",
  "phone",
  "account_number",
  "date_of_birth",
  "zip",
);
export type LoginField = typeof LoginField.Type;

/** The fields a run's inline `website_auth` may carry besides its username and password. */
export const inlineLoginFields = [
  "email",
  "phone",
  "account_number",
  "date_of_birth",
  "zip",
] as const;
export type InlineLoginField = (typeof inlineLoginFields)[number];

/**
 * What one verified sign-in used, value-free: the fields it filled and, when it met a two-factor
 * method choice, every method that choice offered that a call may name. A revision records it as
 * its `login_fields` and `sign_in_methods`; one without it predates the record.
 */
export const LoginFields = Schema.Array(LoginField).pipe(
  Schema.minItems(1),
  Schema.maxItems(LoginField.literals.length),
);
export const SignInMethods = Schema.Array(SignInMethod).pipe(
  Schema.minItems(1),
  Schema.maxItems(SignInMethod.literals.length),
);
export const LoginFieldsUsed = Schema.Struct({
  fields: LoginFields,
  methods: Schema.optional(SignInMethods),
});
export type LoginFieldsUsed = typeof LoginFieldsUsed.Type;

/** The members of `order` among `values`, in that order, once each. */
const ordered = <Kind extends string>(
  values: Iterable<string>,
  order: readonly Kind[],
): readonly Kind[] => {
  const present = new Set(values);
  return order.filter((value) => present.has(value));
};

/**
 * The fields and methods a verified autofill sign-in used: every kind each identifier field accepts
 * (a caller may give any one of them), each secret slot but a code (a slot shares its field's
 * name), and the methods its method choices offered that a call may name. A recovery code is
 * never a call's method: only the owner's choice or saved preference uses one.
 */
export const loginFieldsOfRecipe = (recipe: {
  readonly steps: readonly {
    readonly fields: readonly (
      { readonly slot: string } | { readonly accepts: readonly string[] }
    )[];
    readonly methods?: readonly { readonly method: string }[] | undefined;
  }[];
}): LoginFieldsUsed | undefined => {
  const kinds = recipe.steps.flatMap((step) =>
    step.fields.flatMap((field): readonly string[] =>
      "slot" in field ? [field.slot] : field.accepts,
    ),
  );
  const fields = ordered(kinds, LoginField.literals);
  const methods = ordered(
    recipe.steps.flatMap((step) => (step.methods ?? []).map((choice) => choice.method)),
    SignInMethod.literals,
  );
  return fields.length === 0 ? undefined : { fields, ...(methods.length === 0 ? {} : { methods }) };
};

/** A tool's public sign-in record, as a tool listing shows it; absent before the record. */
export const publicLoginFields = (revision: {
  readonly loginFields?: readonly LoginField[] | undefined;
  readonly signInMethods?: readonly SignInMethod[] | undefined;
}) => ({
  ...(revision.loginFields === undefined ? {} : { login_fields: revision.loginFields }),
  ...(revision.signInMethods === undefined ? {} : { sign_in_methods: revision.signInMethods }),
});

/** The revision fields that record a sign-in's use. */
export const revisionLoginFields = (used: LoginFieldsUsed | undefined) =>
  used === undefined
    ? {}
    : {
        loginFields: used.fields,
        ...(used.methods === undefined ? {} : { signInMethods: used.methods }),
      };

/**
 * The first field of a run call its tool's sign-in does not take, which the call is refused for:
 * an inline field the revision's `login_fields` does not list, or a `sign_in_method` its recorded
 * sign-in met no choice offering. A revision published before the record takes no inline field
 * beyond the username and password, and any method, as before it.
 */
export const unusedRunLoginField = (
  revision: {
    readonly loginFields?: readonly LoginField[] | undefined;
    readonly signInMethods?: readonly SignInMethod[] | undefined;
  },
  websiteAuth: Partial<Record<InlineLoginField, unknown>> | undefined,
  signInMethod: SignInMethod | undefined,
): InlineLoginField | "sign_in_method" | undefined => {
  const listed: readonly LoginField[] = revision.loginFields ?? [];
  const field = inlineLoginFields.find(
    (name) => websiteAuth?.[name] !== undefined && !listed.includes(name),
  );
  if (field !== undefined) return field;
  return signInMethod !== undefined &&
    revision.loginFields !== undefined &&
    !(revision.signInMethods ?? []).includes(signInMethod)
    ? "sign_in_method"
    : undefined;
};
