import { Schema } from "effect";
import { DialogChoice } from "../../runtime/dialogs.js";
import type { DialogType } from "../../runtime/dialogs.js";

export { DialogChoice, DialogFailure, DialogType } from "../../runtime/dialogs.js";
export const DialogDecision = Schema.Struct({
  dialogId: Schema.UUID,
  version: Schema.Literal(1),
  decision: DialogChoice,
});
export type DialogDecision = typeof DialogDecision.Type;
export interface DialogScope {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly attemptId: string;
}
export interface PendingDialog extends DialogScope {
  readonly dialogId: string;
  readonly version: 1;
  readonly pageId: string;
  readonly candidateActionId: string | null;
  readonly attribution: "candidate_action" | "unattributed";
  readonly type: DialogType;
  readonly message: string;
  readonly expiresAt: string;
  readonly remainingActiveMs: number;
}
/** Host-only facts about a held dialog. Never sent to the page, the caller or a model. */
export interface DialogFacts {
  /** The dialog's own message, unscreened. */
  readonly message: string;
  /** The URL of the page that showed it, when it showed. */
  readonly pageUrl: string;
}
/** A decision the host applied and the browser acknowledged. */
export interface ResolvedDialog {
  readonly event: Omit<PendingDialog, "message">;
  readonly facts: DialogFacts;
  readonly decision: DialogChoice;
}
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
export interface KnownDialog {
  readonly pageId: string;
  readonly actionId: string;
  readonly type: DialogType;
  readonly message: string;
  readonly decision: DialogChoice;
}
