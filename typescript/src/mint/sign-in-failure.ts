import type { HostRefusal } from "../destinations/autofill-refusal.js";
import type { failureRootCause } from "../runtime/failure-detail.js";
import { MintFailure, type SpentSignIn } from "./contracts.js";
import { signInOutcomeUnknown, type SignInDiagnostic } from "../execution/sign-in-diagnostics.js";

/**
 * How many identical host refusals in a row while typing into a sign-in screen (`HostRefusal`)
 * end sign-in in the build: the agent could not correct the step past them. A different refusal,
 * or an authenticate that ends any other way, starts the count again.
 */
export const maximumHostRefusals = 3;

/** Why each check refuses a field, and what may get past it; value-free. */
const refusalNotices: Readonly<Record<string, { readonly why: string; readonly next: string }>> = {
  typing_refused: {
    why: "the field took the focus, but the value the host inserted did not land in it, so the page's own code blocks inserted text or replaces the field as it is typed",
    next: "Inspect the field read-only: name the control that holds the typed text itself, not a wrapper, a mask or a decoy, and send the signInStep again.",
  },
  not_focused: {
    why: "the field did not take the focus: another element holds it, such as an overlay, a dialog or a field the page moves the focus to",
    next: "Inspect read-only what covers the field or holds the focus. Dismiss a covering cookie or consent control in an explore if it is one, or name the field that takes the focus, then send the signInStep again.",
  },
  not_editable: {
    why: "the field is disabled or read-only, so it takes no typing",
    next: "The site may enable it only after an earlier control, such as a Next or a chosen method: send that screen first, or name the editable field.",
  },
  change: {
    why: "page code moved the field or changed where or how its form submits after the host judged it, and the host never types into a control it has not judged",
    next: "Wait for the screen to settle, read it read-only, then send the signInStep again.",
  },
  destination: {
    why: "the field sits or submits off the site and its configured sign-in origins",
    next: "Inspect the site's own sign-in page and correct the screen's signInStep. Another authentication origin requires operator configuration.",
  },
  not_found: {
    why: "the field's selector matched no visible control when the host went to type",
    next: "Read the screen again read-only and correct the selector so it matches the one visible field.",
  },
  ambiguous_match: {
    why: "the field's selector matched more than one visible control when the host went to type",
    next: "Read the screen again read-only and correct the selector so it matches the one visible field.",
  },
};
const otherRefusal = {
  why: "a host check refused the field",
  next: "Inspect the current browser read-only, then correct the screen's signInStep.",
};

/** What the host refused to type and where, value-free. */
const refusedField = (refusal: HostRefusal) =>
  `the host refused to type the ${refusal.slot} into field ${refusal.field + 1} of the sign-in screen (${refusal.check})`;

/**
 * The failed sign-in the host reports when its fill refused a field of the screen
 * (`typingRefusal`). `nothingSubmitted` says no earlier screen of this sign-in sent anything
 * either: the refused screen itself submitted nothing.
 */
export const autofillRefusalFailure = (
  refusal: HostRefusal,
  options: { readonly nothingSubmitted: boolean },
) =>
  new MintFailure({
    code: "Unavailable",
    authentication: {
      phase: "credential_submit",
      code: "AutofillRefused",
      hostRefusal: refusal,
      ...(options.nothingSubmitted ? { nothingSubmitted: true as const } : {}),
    },
  });

/**
 * The failure's own code: Kernel's, when the orchestration only labels a provider failure
 * `ProviderUncertain` or a failed login flow `AuthenticationFailed` (Kernel's `website_error`,
 * say), else the sign-in's. A wrapper's code never hides the root cause.
 */
export const signInRootCode = (failure: SignInDiagnostic) =>
  failure.code === "ProviderUncertain" && failure.providerCode !== undefined
    ? failure.providerCode
    : failure.code === "AuthenticationFailed"
      ? (failure.providerEvidence?.errorCode ?? failure.providerAuthCode ?? failure.code)
      : failure.code;

const cause = (failure: SignInDiagnostic) =>
  `${signInRootCode(failure)} during ${failure.phase}${failure.hostRefusal === undefined ? "" : `: ${refusedField(failure.hostRefusal)}`}${failure.providerReason === undefined ? "" : `: ${failure.providerReason}`}`;

const retryInstruction = (failure: SignInDiagnostic) =>
  failure.code === "CredentialTargetRefused"
    ? "Inspect the site's own sign-in page and correct the screen's signInStep. Another authentication origin requires operator configuration."
    : "Inspect the current browser read-only, then correct the observed sign-in screens and their signInSteps.";
const unsentRetry =
  "No credential was sent, so this step does not count toward the sign-in limit. Correct the observed step on the current browser.";

/** What spent the attempt's sign-ins, as the agent and the build's owner read it. */
const spentReason: Record<SpentSignIn, string> = {
  relogin_spent: "the attempt's one sign-in again on this browser is spent",
  fresh_profile_sign_ins_spent:
    "the sign-ins the attempt allows on a recovery's new profile are spent",
  host_refusals_repeated: `the host refused the same field of the same screen the same way ${maximumHostRefusals} times in a row, and no correction of the step got past it`,
};

/**
 * What the agent hears when no further sign-in can run in this attempt: sign-in is unavailable in
 * this build, and the host sends nothing again.
 */
const unavailableInBuild =
  "Sign-in is unavailable in this build: the host starts no further sign-in and sends nothing again, so work that needs the site signed in cannot run.";

/**
 * What the minting agent is told about a failed sign-in: whether the site may be signed in,
 * whether any credential went out, the root cause and the concrete next step. A failed sign-in
 * that the attempt can get past never ends the build by itself; only an unconfirmed stop or
 * cleanup, which poisons the host, does. `spent` says no further sign-in may
 * run in this attempt, so the next step is to report that sign-in is unavailable, never another
 * authenticate.
 */
export const signInFailureFeedback = (failure: SignInDiagnostic, spent?: SpentSignIn) =>
  // An unclear stop or cleanup ends live work on its own, and a login conflict or an empty
  // journal already says sign-in is unavailable, whatever the attempt still allows.
  spent !== undefined && failure.cleanupCode === undefined && !ownUnavailable.has(failure.code)
    ? spentFailureFeedback(failure, spent)
    : recoverableFailureFeedback(failure);

/** Failures whose own feedback already says sign-in is unavailable. */
const ownUnavailable: ReadonlySet<SignInDiagnostic["code"]> = new Set([
  "LoginIdentityConflict",
  "SignInsSpent",
]);

/** Stated only when known: a sign-in that sent something may or may not have been counted. */
const sentFields = (failure: SignInDiagnostic) =>
  failure.nothingSubmitted === true
    ? { credentialSent: false as const, countsTowardSignInCap: false as const }
    : {};

/** A sign-in that failed once no further sign-in can run in this attempt. */
const spentFailureFeedback = (failure: SignInDiagnostic, spent: SpentSignIn) => {
  const unknown = signInOutcomeUnknown(failure);
  return {
    signInOutcome: unknown ? ("unknown" as const) : ("signed_out" as const),
    nextStep: "report_sign_in_unavailable" as const,
    ...sentFields(failure),
    notice: `The sign-in failed (${cause(failure)}) ${unknown ? "and may have completed on the site, so its outcome is unknown" : "and left the site signed out"}, and no further sign-in can run in this attempt: ${spentReason[spent]}. ${unavailableInBuild} Report that the site could not be signed in, with this cause.`,
  };
};

/** A failed sign-in while the attempt may still sign in again. */
const recoverableFailureFeedback = (failure: SignInDiagnostic) => {
  const sent = sentFields(failure);
  if (failure.code === "LoginIdentityConflict" || failure.code === "SignInsSpent")
    return {
      signInOutcome: "signed_out" as const,
      nextStep: "report_sign_in_unavailable" as const,
      ...sent,
      notice:
        failure.code === "LoginIdentityConflict"
          ? `This login conflicts with the Personal login locked to this site (${cause(failure)}). Report that the build needs the site's locked login.`
          : `No further sign-in can run in this attempt (${cause(failure)}). Report that the site could not be signed in.`,
    };
  if (failure.hostRefusal !== undefined) return refusalFeedback(failure, failure.hostRefusal);
  const unknown = signInOutcomeUnknown(failure);
  return {
    signInOutcome: unknown ? ("unknown" as const) : ("signed_out" as const),
    nextStep:
      failure.cleanupCode === undefined
        ? ("authenticate" as const)
        : ("report_sign_in_unavailable" as const),
    ...sent,
    notice:
      failure.cleanupCode !== undefined
        ? `The sign-in's cleanup is unconfirmed (${cause(failure)}), so live work ends. Report the unresolved sign-in.`
        : `The sign-in failed (${cause(failure)}) ${unknown ? "and may have completed on the site" : "and has not verified the site signed in"}. ${failure.nothingSubmitted === true ? unsentRetry : "No credential is automatically submitted again."} ${retryInstruction(failure)} Writes, examples and tests wait for the host's signed-in check and identity verification.`,
  };
};

/**
 * A refused field while the attempt may still sign in again: what was refused and why, by the
 * check that refused it, and what may get past it.
 */
const refusalFeedback = (failure: SignInDiagnostic, refusal: HostRefusal) => {
  const notice = refusalNotices[refusal.check] ?? otherRefusal;
  const field = refusedField(refusal);
  return {
    signInOutcome: "signed_out" as const,
    nextStep: "authenticate" as const,
    ...sentFields(failure),
    notice: `The sign-in did not complete: ${field}, because ${notice.why}. It submitted nothing of this screen. ${failure.nothingSubmitted === true ? "No credential was sent, so this does not count toward the sign-in limit." : "No credential is automatically submitted again."} ${notice.next} The same refusal of this field on this screen ${maximumHostRefusals} times in a row ends sign-in in this build. Writes, examples and tests wait for the host's signed-in check and identity verification.`,
  };
};

/**
 * What the agent hears when a browser was to start from the login's saved provider profile, which
 * may be signed in, and the saved login could not be read: the profile was set aside, and the
 * browser started on a new, empty one. Nothing was sent.
 */
export const savedProfileSetAsideNotice = (
  failure: SignInDiagnostic,
  /** The store's own failure beneath the code, in finite fields. */
  rootCause?: ReturnType<typeof failureRootCause>,
) => ({
  kind: "sign_in" as const,
  state: "saved_profile_set_aside" as const,
  code: signInRootCode(failure),
  signInOutcome: "signed_out" as const,
  nextStep:
    failure.code === "LoginIdentityConflict"
      ? ("report_sign_in_unavailable" as const)
      : ("authenticate" as const),
  credentialSent: false as const,
  countsTowardSignInCap: false as const,
  authentication: failure,
  ...(rootCause === undefined ? {} : { rootCause }),
  instruction:
    failure.code === "LoginIdentityConflict"
      ? `The saved login cannot be used (${cause(failure)}): it conflicts with the login the owner's Personal account has locked this site to, so it can never sign in here. The browser started on a new, empty profile instead of the login's saved one, which may have been signed in. Nothing was sent. Work that needs no sign-in may go on; report that the build needs the site's locked login.`
      : `The host could not read the saved login from its credential store (${cause(failure)}), so the browser started on a new, empty profile instead of the login's saved one, which may have been signed in and is kept for a later build. Nothing was sent, and this does not count toward the attempt's sign-in limit. Work that needs no sign-in may go on; call execute purpose authenticate when the build needs to sign in, which reads the login again.`,
});

/**
 * What the agent hears when it calls authenticate once the attempt's sign-ins are spent and no
 * failed sign-in is pending: the host starts none, and sign-in is unavailable in this build.
 */
const spentSignInFeedback = (spent: SpentSignIn) => ({
  nextStep: "report_sign_in_unavailable" as const,
  credentialSent: false as const,
  notice: `The host started no sign-in, and sent nothing: ${spentReason[spent]}. ${unavailableInBuild} Report that the site could not be signed in in this attempt.`,
});

/** A failed or refused sign-in as the host hands it on: its diagnostic and what was spent. */
interface SignInFailure {
  readonly authentication?: SignInDiagnostic;
  readonly spentSignIn?: SpentSignIn;
}

/** What a failed or refused sign-in tells the agent, or undefined for any other failure. */
export const signInFeedbackOf = (error: SignInFailure) =>
  error.authentication !== undefined
    ? signInFailureFeedback(error.authentication, error.spentSignIn)
    : error.spentSignIn !== undefined
      ? spentSignInFeedback(error.spentSignIn)
      : undefined;

/** How the answer closes, by whether sign-in is unavailable and when the build then ends. */
const endingNotice = {
  none: "",
  now: " The host ends this build now with the result sign_in_unavailable and this cause; nothing more is needed from you.",
  after_publication:
    " A retained receipt may still publish: call finish_build with it if it supports the request; otherwise the build ends with this result.",
};

/**
 * A failed or refused sign-in's answer: the root cause's code, the fields the agent acts on and
 * the notice. `ending` is `none` while a further sign-in can run; otherwise sign-in is unavailable
 * and the build ends `now`, or `after_publication` when a retained receipt may still publish.
 */
export const signInAnswer = (
  error: SignInFailure,
  feedback: NonNullable<ReturnType<typeof signInFeedbackOf>>,
  ending: keyof typeof endingNotice,
) => ({
  code:
    error.authentication === undefined ? error.spentSignIn : signInRootCode(error.authentication),
  fields: {
    ...("signInOutcome" in feedback ? { signInOutcome: feedback.signInOutcome } : {}),
    nextStep: feedback.nextStep,
    ...("credentialSent" in feedback ? { credentialSent: feedback.credentialSent } : {}),
    ...("countsTowardSignInCap" in feedback
      ? { countsTowardSignInCap: feedback.countsTowardSignInCap }
      : {}),
    ...(error.spentSignIn === undefined ? {} : { spentSignIn: error.spentSignIn }),
    ...(ending === "none" ? {} : { buildOutcome: "sign_in_unavailable" as const }),
  },
  notice: `${feedback.notice}${endingNotice[ending]}`,
});

/**
 * The build's result once sign-in is unavailable, as its owner reads it: the root cause's code
 * and phase, whether the login reached the site, and what spent the attempt's sign-ins. It holds
 * no provider or site text.
 */
export const signInUnavailableSummary = (
  failure: SignInDiagnostic | undefined,
  spent: SpentSignIn | undefined,
) => {
  const why =
    spent !== undefined
      ? `no further sign-in could run in this attempt, since ${spentReason[spent]}`
      : failure?.code === "SignInsSpent"
        ? "the attempt's sign-in allowance was spent"
        : "no further sign-in could run in this attempt";
  if (failure?.code === "LoginIdentityConflict")
    return "Sign-in was unavailable, so the build stopped without publishing. This login conflicts with the one the owner's Personal account has locked this site to, so it can never sign in here. Nothing was sent. Recorded effects and receipts are preserved.";
  const failed =
    failure === undefined || failure.code === "SignInsSpent"
      ? "The site could not be signed in"
      : `The sign-in failed with ${signInRootCode(failure)} during ${failure.phase} ${failure.nothingSubmitted === true ? "before anything reached the site" : "after the login was sent to the site"}`;
  return `Sign-in was unavailable, so the build stopped without publishing. ${failed}, and ${why}. The host sent nothing again. Recorded effects and receipts are preserved.`;
};

/** Why a live execution waits, while the last sign-in has not succeeded. */
export const signInPendingNotice = (failure: SignInDiagnostic | undefined) =>
  failure === undefined
    ? "The last sign-in did not succeed and its outcome is unknown. Only authenticate may run live until a sign-in succeeds: call execute purpose authenticate again."
    : signInFailureFeedback(failure).notice;

/**
 * The guidance a final answer without a tool call gets back, once, while a failed sign-in the
 * agent can get past is unresolved; see the loop guard in `mint/openai.ts`.
 */
export const unresolvedSignInGuidance = (failure: SignInDiagnostic, spent?: SpentSignIn) => {
  const feedback = signInFailureFeedback(failure, spent);
  // No tool ends a build: one that cannot sign in publishes a retained receipt, or stops.
  if (feedback.nextStep === "report_sign_in_unavailable")
    return `Host notice: sign-in is unavailable in this build: ${feedback.notice} If a retained receipt supports the request, publish it with finish_build; otherwise stop, and the host ends the build with this result. This notice grants no new authority.`;
  return `Host notice: the build is not finished. The last sign-in failed and nothing has resolved it yet: ${feedback.notice} Continue with a tool call: call execute purpose authenticate again${failure.nothingSubmitted === true ? " (a retry after a failure that sent nothing spends no sign-in)" : ""}, or end the build and report what stops the sign-in. This notice grants no new authority.`;
};
