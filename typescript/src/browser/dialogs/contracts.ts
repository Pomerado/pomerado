import { Schema } from "effect";

export { DialogChoice, DialogFailure, DialogType } from "../../runtime/dialogs.js";
/**
 * A write mint's accepted confirm popup, stored with the published revision so a later run of
 * the same write accepts the same popup at the same step without asking.
 * The revision is shared, so it keeps only a SHA-256 digest of the popup's normalized message,
 * page origin and generated step, never the page's own text (`expectedConfirmDigest`).
 */
export const ExpectedConfirm = Schema.Struct({
  digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
});
export type ExpectedConfirm = typeof ExpectedConfirm.Type;
