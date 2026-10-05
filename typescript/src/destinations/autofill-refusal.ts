import { Schema } from "effect";
import { failureDetail, withFailureContext } from "../runtime/failure-detail.js";
import type { FailureContextValue } from "../runtime/failure-detail.js";
import type {
  AutofillRefusal,
  AutofillStepReport,
  LocatedError,
  Targets,
} from "./autofill-step.js";

/** Where a step call found a control's one visible match: that frame's URL, and how many it searched. */
export const FoundIn = Schema.Struct({ frameUrl: Schema.String, frames: Schema.Number });
/** Where a step call found each control of the step. */
export const FoundAt = Schema.Struct({
  fields: Schema.Array(FoundIn),
  submit: Schema.NullOr(FoundIn),
});
/** A search with no one visible match: the frames searched and each frame that matched. */
export const Searched = Schema.Struct({
  frames: Schema.Number,
  matches: Schema.Array(
    Schema.Struct({ frameUrl: Schema.String, count: Schema.Number, visible: Schema.Number }),
  ),
});

/** A refusal for `reason`, about the control `target` names, if any. */
export const refused = (
  reason: AutofillRefusal["reason"],
  target?: AutofillRefusal["target"],
): AutofillRefusal => ({
  outcome: "refused",
  reason,
  ...(target === undefined ? {} : { target }),
});

/** Value-free evidence of a refusal: finite facts, origins and counts, never a URL or a value. */
type RefusalEvidence = Readonly<Record<string, FailureContextValue | undefined>>;

/**
 * The opaque URLs named by what they are, a failed navigation's error page among them; page code
 * chooses any other scheme, so may fill it. Page code reports a URL by the same names.
 */
export const opaqueOrigins: readonly string[] = [
  "about:blank",
  "about:srcdoc",
  "data:",
  "javascript:",
  "blob:",
  "chrome-error:",
];

/**
 * A URL's origin alone, never its path or query. An opaque one is named only from a fixed set
 * (`opaqueOrigins`), any other `other`.
 */
export const urlOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null) return "invalid";
  if (parsed.origin !== "null") return parsed.origin;
  const opaque = parsed.protocol === "about:" ? `about:${parsed.pathname}` : parsed.protocol;
  return opaqueOrigins.includes(opaque) ? opaque : "other";
};

/**
 * The origins evidence may name once the step typed something: the page's and each control's
 * frame, document and destinations, as judged at inspection. Page code may since have put a typed
 * value, whole or in part, in any other origin, such as an action's hostname.
 */
export const judgedOrigins = (inspection: {
  readonly page: string;
  readonly targets: typeof Targets.Type;
}): ReadonlySet<string> =>
  new Set([
    urlOrigin(inspection.page),
    ...[...inspection.targets.fields, inspection.targets.submit].flatMap((target) =>
      target === null
        ? []
        : [
            ...(target.ownerUrl === null ? [] : [urlOrigin(target.ownerUrl)]),
            urlOrigin(target.documentOrigin),
            ...target.actions.map(urlOrigin),
          ],
    ),
  ]);

/**
 * The origins evidence may name once the host typed into the page before the inspection
 * (`judgedBeforeTyping` given): the site's and its configured sign-in origins, which no page code
 * chose, and those the browser's inspections judged before anything was typed. The inspection may
 * itself have found a typed value in any other origin. Undefined while nothing
 * was typed.
 */
/** The site's and its configured sign-in origins, which no page code chose. */
export const configuredOrigins = (trust: {
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
}) => [trust.siteOrigin, ...trust.authenticationOrigins].map(urlOrigin);

export const namedAfterTyping = (trust: {
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly judgedBeforeTyping?: readonly string[] | undefined;
}): ReadonlySet<string> | undefined =>
  trust.judgedBeforeTyping === undefined
    ? undefined
    : new Set([...configuredOrigins(trust), ...trust.judgedBeforeTyping]);

/**
 * A URL's origin when `named` holds it or no set is given, else `other`. An opaque one's name
 * comes from `urlOrigin`'s fixed set, which page code cannot fill.
 */
export const namedOrigin = (url: string, named: ReadonlySet<string> | undefined) => {
  const origin = urlOrigin(url);
  return named === undefined || named.has(origin) || !origin.includes("//") ? origin : "other";
};

/**
 * Where a control sits and submits, by origin: its own frame, its document and each destination,
 * each named only when `named` holds it (`namedOrigin`).
 */
export const targetEvidence = (
  target: (typeof Targets.Type)["fields"][number] | null | undefined,
  named?: ReadonlySet<string>,
): RefusalEvidence =>
  target === undefined || target === null
    ? {}
    : {
        frameOrigin: target.ownerUrl === null ? "none" : namedOrigin(target.ownerUrl, named),
        documentOrigin: namedOrigin(target.documentOrigin, named),
        actionOrigins: target.actions.map((action) => namedOrigin(action, named)).join(" "),
      };

/** The control a refusal is about, among the step's controls a call found. */
export const foundFor = (at: typeof FoundAt.Type | undefined, target: AutofillRefusal["target"]) =>
  target === "submit" ? at?.submit : typeof target === "number" ? at?.fields[target] : undefined;

/**
 * The primary page then and the frame a control's one visible match was in, by origin, each named
 * only when `named` holds it (`namedOrigin`).
 */
export const foundEvidence = (
  url: string | undefined,
  found: typeof FoundIn.Type | null | undefined,
  named?: ReadonlySet<string>,
): RefusalEvidence => ({
  ...(url === undefined ? {} : { pageOrigin: namedOrigin(url, named) }),
  ...(found === undefined || found === null
    ? {}
    : { matchFrameOrigin: namedOrigin(found.frameUrl, named), framesSearched: found.frames }),
});

/**
 * A refusal that says which check fired: `check`, also its failure detail's phase, with value-free
 * evidence for the diagnostic archive and the step event.
 */
export const withCheck = (
  refusal: AutofillRefusal,
  check: string,
  evidence: RefusalEvidence = {},
): AutofillRefusal => ({
  ...refusal,
  failureDetail: failureDetail("autofill_step_failed", {
    phase: check,
    context: { check, ...evidence },
    helperFrames: 1,
  }),
});

/** Adds evidence to a refusal that says which check fired. */
export const withEvidence = (refusal: AutofillRefusal, evidence: RefusalEvidence) =>
  refusal.failureDetail === undefined
    ? refusal
    : { ...refusal, failureDetail: withFailureContext(refusal.failureDetail, evidence) };

/**
 * A step call's own refusal, with its evidence: a search with no one visible match counts each
 * frame's visible and total matches by origin, and a replaced popup is a change. Origins are named
 * only when `named` holds them.
 */
export const locatedRefusal = (answer: typeof LocatedError.Type, named?: ReadonlySet<string>) =>
  withCheck(
    {
      outcome: "refused",
      reason: answer.error === "target_changed" ? "credential_target_refused" : answer.error,
      target: answer.target,
    },
    answer.error === "target_changed" ? "change" : answer.error,
    {
      ...(answer.error === "target_changed" ? { changed: answer.target } : {}),
      ...foundEvidence(answer.url, answer.located, named),
      ...(answer.searched === undefined
        ? {}
        : {
            framesSearched: answer.searched.frames,
            matches: answer.searched.matches
              .map(
                (match) => `${namedOrigin(match.frameUrl, named)} ${match.visible}/${match.count}`,
              )
              .join(", "),
          }),
    },
  );

/** A step report's refusal evidence for its step event: empty unless a check refused it. */
export const refusalEvidence = (report: AutofillStepReport) => {
  const context = report.outcome === "uncertain" ? undefined : report.failureDetail?.context;
  return context?.["check"] === undefined ? {} : context;
};

/**
 * A step report's failure detail when a call of it failed, for the failure archive. A check's
 * refusal is the host working as it should, so its evidence goes only in the step event.
 */
export const callFailure = (report: AutofillStepReport) =>
  report.failureDetail?.context?.["check"] === undefined ? report.failureDetail : undefined;

/**
 * A fill whose host click ran, even one whose submission the guard then refused as it fired, or
 * whose answer was lost, may have sent what it filled: the page's own handlers ran on the click.
 */
export const maySend = (stepReport: AutofillStepReport) =>
  stepReport.outcome === "uncertain" ||
  (stepReport.outcome === "filled" &&
    (stepReport.submit === "clicked" || stepReport.clicked === true));
