import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { MintFailure } from "../../mint/contracts.js";
import type { IncidentStore } from "../../runtime/incidents.js";
import { ExpectedConfirm } from "./contracts.js";
import type { DialogChoice, DialogFacts, DialogFailure, DialogType } from "./contracts.js";

/** How many accepted confirms one published revision keeps. */
export const expectedConfirmLimit = 32;
export const ExpectedConfirms = Schema.Array(ExpectedConfirm).pipe(
  Schema.maxItems(expectedConfirmLimit),
);

/** The longest confirm message a revision keeps a record of. */
const messageLimit = 2_000;
const stepPattern = /^[A-Za-z0-9_-]{1,100}$/;

/** Whitespace differences never make an expected popup unexpected. Case and wording do. */
const normalizedMessage = (message: string) =>
  message.normalize("NFC").replace(/\s+/gu, " ").trim();

/**
 * A confirm popup as the host saw it: its normalized message, page origin and generated step.
 * Host-only and never stored; a revision keeps only its digest.
 */
export interface ObservedConfirm {
  readonly message: string;
  readonly origin: string;
  readonly step: string;
}

/**
 * The fields of a native dialog a confirm match reads: its type, and the generated action that
 * raised it, the step a script names to `decideDialog`, or null when no action is known.
 */
export interface DialogEvent {
  readonly type: DialogType;
  readonly candidateActionId: string | null;
}

/**
 * The popup a confirm is, or undefined when it cannot be expected: not a confirm, raised outside
 * a generated action (so no step is known), on a page that is not https, or with a message empty
 * or too long to keep. Such a popup is never expected, so a run always asks about it.
 */
export const observedConfirmOf = (
  event: DialogEvent,
  facts: DialogFacts,
): ObservedConfirm | undefined => {
  const step = event.candidateActionId;
  if (event.type !== "confirm" || step === null || !stepPattern.test(step)) return undefined;
  const url = URL.canParse(facts.pageUrl) ? new URL(facts.pageUrl) : undefined;
  if (url?.protocol !== "https:") return undefined;
  const message = normalizedMessage(facts.message);
  if (message.length === 0 || message.length > messageLimit) return undefined;
  return { message, origin: url.origin, step };
};

/**
 * The record a revision keeps of an accepted popup: a SHA-256 digest of its normalized message,
 * page origin and step, so the shared revision holds no page text. Matching is exact, so a digest
 * matches exactly the popups the full record would.
 */
export const expectedConfirmDigest = (popup: ObservedConfirm): ExpectedConfirm => ({
  digest: createHash("sha256")
    .update(
      JSON.stringify(["pomerado.expected_confirm.v1", popup.message, popup.origin, popup.step]),
    )
    .digest("hex"),
});

/**
 * One browser's pool of expected confirms. Each record the mint kept accepts one matching popup
 * (the same message, page origin and step), so a popup the mint saw once is accepted once.
 */
export const makeExpectedConfirms = (records: readonly ExpectedConfirm[]) => {
  const remaining = records.map((record) => record.digest);
  return {
    take: (event: DialogEvent, facts: DialogFacts) => {
      const observed = observedConfirmOf(event, facts);
      if (observed === undefined) return undefined;
      const { digest } = expectedConfirmDigest(observed);
      const index = remaining.indexOf(digest);
      if (index < 0) return undefined;
      remaining.splice(index, 1);
      return { digest };
    },
  };
};

/**
 * Keeps a confirm popup the current live execution accepted, host-only, in `live`. A write
 * example's become digests in its revision's expected confirms, which its runs accept without
 * asking. It never throws, so it never changes a dialog's resolution.
 */
export const keepAcceptedConfirm = (
  live: ObservedConfirm[],
  resolution: {
    readonly event: DialogEvent;
    readonly facts: DialogFacts;
    readonly decision: DialogChoice;
  },
) => {
  if (resolution.decision.choice !== "accept" || live.length >= expectedConfirmLimit) return;
  const confirm = observedConfirmOf(resolution.event, resolution.facts);
  if (confirm !== undefined) live.push(confirm);
};

/**
 * The confirm popups the current live execution accepted that its build keeps. Only a write
 * keeps them, and never one whose text holds a registered secret such as the login: its runs ask
 * about that popup instead. `screen` fails for such a message, or when it cannot screen it;
 * `unscreened` hears each failure, and the popup is dropped either way.
 */
export const acceptedConfirmsKept = <E>(input: {
  readonly write: boolean;
  readonly accepted: readonly ObservedConfirm[];
  readonly screen: (message: string) => Effect.Effect<void, E>;
  readonly unscreened?: (error: E) => Effect.Effect<unknown>;
}): Effect.Effect<ObservedConfirm[]> =>
  !input.write
    ? Effect.succeed([])
    : Effect.filter(input.accepted, (confirm) =>
        input.screen(confirm.message).pipe(
          Effect.as(true),
          Effect.catchAll((error) =>
            (input.unscreened?.(error) ?? Effect.void).pipe(Effect.as(false)),
          ),
        ),
      );

/**
 * A write session's record of the confirms its act steps accepted: their digests, which its
 * revision keeps for runs, and the steps they were accepted at, which its composed script must
 * name.
 */
export interface ConfirmSession {
  readonly acceptedConfirms: ExpectedConfirm[];
  readonly confirmSteps: Set<string>;
}

/** Adds an act step's kept confirms to its write session. */
export const recordConfirmSteps = (session: ConfirmSession, confirms: readonly ObservedConfirm[]) => {
  session.acceptedConfirms.push(...confirms.map(expectedConfirmDigest));
  for (const confirm of confirms) session.confirmSteps.add(confirm.step);
};

/** Whether any source holds the value as a quoted literal. */
const namesLiteral = (sources: readonly string[], value: string) =>
  sources.some((source) =>
    [`'${value}'`, `"${value}"`, `\`${value}\``].some((literal) => source.includes(literal)),
  );

/**
 * A run accepts a confirm popup without asking only at the action the mint accepted it at, so
 * the composed script must run each such action under the session's action id. Fails
 * `confirm_action_unmatched`, naming each step no source of the composed script (its entrypoint
 * and every file it imports) holds as a quoted literal.
 */
export const confirmActionUnmatched = (
  confirmSteps: Iterable<string>,
  composedSources: readonly string[],
): Effect.Effect<void, MintFailure> => {
  const confirmActionIds = [...confirmSteps].filter(
    (actionId) => !namesLiteral(composedSources, actionId),
  );
  return confirmActionIds.length > 0
    ? Effect.fail(
        new MintFailure({
          code: "PublicationUnavailable",
          reason: "confirm_action_unmatched",
          confirmActionIds,
        }),
      )
    : Effect.void;
};

/**
 * Nothing is confirmed on the caller's behalf. A beforeunload is accepted because dismissing
 * it would cancel the run's own navigation; leaving a page sends nothing.
 */
const defaultChoice = (type: DialogType): DialogChoice =>
  type === "beforeunload" ? { choice: "accept" } : { choice: "dismiss" };

/**
 * A published run's native dialogs. A write tool's `confirm` that its mint accepted (the same
 * message, page origin and step, `expectedConfirms`) is accepted and recorded. Any other write
 * `confirm` goes to the caller, when live input is configured: confirming belongs to the action
 * the caller asked for. A tool published before the mint kept that record has none, so its
 * confirms keep asking. Every other dialog is decided at once by the safe default and recorded,
 * so a page alert never becomes a long caller decision, unless the host asks the caller about
 * every dialog the record does not settle (`askEveryDialog`).
 */
export const makeRunDialogDecision = <Event extends DialogEvent>(input: {
  readonly readOnly: boolean;
  /** The confirms the published write's mint accepted. */
  readonly expectedConfirms?: readonly ExpectedConfirm[] | undefined;
  readonly askCaller?: (event: Event) => Effect.Effect<DialogChoice, DialogFailure>;
  readonly incidents: IncidentStore;
  readonly askEveryDialog?: boolean;
}) => {
  const expected = makeExpectedConfirms(input.expectedConfirms ?? []);
  return (event: Event, facts: DialogFacts): Effect.Effect<DialogChoice, DialogFailure> => {
    if (event.type === "confirm" && !input.readOnly) {
      if (expected.take(event, facts) !== undefined)
        return input.incidents
          .record({
            source: "host",
            kind: "dialog",
            reason: "dialog_expected_confirm_accepted",
            hostBug: false,
            severity: "info",
            subCause: "confirm_accept",
          })
          .pipe(Effect.as<DialogChoice>({ choice: "accept" }));
      if (input.askCaller) return input.askCaller(event);
    }
    if (input.askEveryDialog === true && input.askCaller) return input.askCaller(event);
    const choice = defaultChoice(event.type);
    return input.incidents
      .record({
        source: "host",
        kind: "dialog",
        reason: "dialog_default_decision",
        hostBug: false,
        severity: "info",
        subCause: `${event.type}_${choice.choice}`,
      })
      .pipe(Effect.as(choice));
  };
};
