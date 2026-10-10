import { randomUUID } from "node:crypto";
import { Effect, Either, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { type AutofillFillCall, autofillStepCode } from "./autofill-page-code.js";
import { unsupportedSelector } from "./autofill-locate-code.js";
import { firedRefusal, guardedSubmit, GuardRefusal } from "./autofill-submission-guard.js";
import {
  configuredOrigins,
  FoundAt,
  foundEvidence,
  foundFor,
  FoundIn,
  judgedOrigins,
  locatedRefusal,
  lostTypingPhase,
  namedAfterTyping,
  refused,
  targetEvidence,
  withCheck,
  withEvidence,
} from "./autofill-refusal.js";
import {
  type AutofillFieldStatus,
  type AutofillInspection,
  type AutofillPage,
  type AutofillRefusal,
  type AutofillStep,
  type AutofillStepReport,
  LocatedError,
  Targets,
  untrustedTarget,
} from "./autofill-step.js";
import {
  type CredentialKeyboard,
  type CredentialTypingMode,
  type InsertionRefusal,
} from "./credential-keyboard.js";
import { PageControls } from "./page-controls.js";

/** One fill call's answer: a control that moved, an empty field the host typed, or its own. */
const FillAnswer = Schema.Union(
  LocatedError,
  Schema.Struct({ checked: Schema.Literal(false), url: Schema.String }),
  Schema.Struct({
    focused: Schema.Boolean,
    /** Why the field did not take the focus: the error focusing threw, or the tag that holds it. */
    unfocused: Schema.optional(
      Schema.Union(
        Schema.Struct({ focusError: Schema.String }),
        Schema.Struct({ activeTag: Schema.String }),
      ),
    ),
    located: Schema.optional(FoundIn),
    url: Schema.String,
  }),
  Schema.Struct({ dated: Schema.Boolean, url: Schema.String }),
  Schema.Struct({
    /** `disabled`: the submit was disabled, so the call clicked nothing. */
    submit: Schema.Literal("clicked", "failed", "disabled", "none"),
    url: Schema.String,
    controls: Schema.optional(PageControls),
  }),
  GuardRefusal,
);
type FillAnswer = typeof FillAnswer.Type;
/** A call that found a control changed since the host last judged it did nothing: each as found. */
const Changed = Schema.Struct({
  changed: Targets,
  located: Schema.optional(FoundAt),
  url: Schema.String,
});
/** A call the host refused, with the primary page then. */
type Stop = { readonly refusal: AutofillRefusal; readonly url?: string | undefined };
/** A fill call's answer once the host judged it: a refusal, or the call's own answer. */
type CallAnswer = Exclude<FillAnswer, typeof LocatedError.Type> | Stop;

const properties = [
  "ownerUrl",
  "documentOrigin",
  "editable",
  "control",
  "actions",
  "methods",
  "submitMethod",
] as const;
/** Each control of two judgments: the field's index or `submit`, as judged before and now. */
const controls = (before: typeof Targets.Type, after: typeof Targets.Type) => [
  ...after.fields.map((now, index) => ({ at: index, was: before.fields[index], now })),
  { at: "submit" as const, was: before.submit, now: after.submit },
];
/**
 * Which properties of which controls differ between two judgments, by name only. The submit's
 * `editable` only follows whether it is disabled, which no call judges as a change.
 */
const changedProperties = (before: typeof Targets.Type, after: typeof Targets.Type) =>
  controls(before, after)
    .flatMap(({ at, was, now }) =>
      properties
        .filter((key) => !(at === "submit" && key === "editable"))
        .filter((key) => JSON.stringify(was?.[key]) !== JSON.stringify(now?.[key]))
        .map((key) => `${at}.${key}`),
    )
    .join(" ");
/**
 * The first control whose form changed how or where it submits, which is never judged again: a
 * switch to GET would put the values in a URL Guardian never judged, and the request watch counts
 * only the endpoints judged at inspection. Page code reports where a form submits by origin and
 * path alone, so an action's query or hash never counts as a change.
 */
const resubmitted = (
  before: typeof Targets.Type,
  after: typeof Targets.Type,
  named: ReadonlySet<string> | undefined,
) => {
  const moved = controls(before, after).find(
    ({ was, now }) =>
      JSON.stringify(was?.methods) !== JSON.stringify(now?.methods) ||
      was?.submitMethod !== now?.submitMethod ||
      JSON.stringify(was?.actions) !== JSON.stringify(now?.actions),
  );
  return (
    moved &&
    withCheck(
      refused("credential_target_refused", moved.at),
      "change",
      targetEvidence(moved.now, named),
    )
  );
};

/** What the fill has done so far. */
interface FillProgress {
  readonly statuses: AutofillFieldStatus[];
  /** Whether any value may have reached the page. */
  typed: boolean;
  /** The field the host typed last, which the next call checks holds something. */
  check: number | null;
  /** The controls as the host last judged them; a call acts only when it finds them so. */
  judged: typeof Targets.Type;
  /** The id the page keeps `judged` under, as the call that found it kept it. */
  judgment: string | undefined;
}

const filledReport = (
  step: AutofillStep,
  progress: FillProgress,
  submit: "clicked" | "failed" | "not_attempted" | "refused" | "stayed_disabled" | "none",
  url: string,
  refusal?: AutofillRefusal,
  clicked?: true,
): AutofillStepReport => ({
  outcome: "filled",
  fields: step.fields.map((field, index) => ({
    slot: field.slot,
    status: progress.statuses[index] ?? "not_attempted",
  })),
  submit,
  ...(clicked === undefined ? {} : { clicked }),
  url,
  ...(refusal?.failureDetail === undefined ? {} : { failureDetail: refusal.failureDetail }),
  ...(progress.typed ? { typed: true as const } : {}),
});

/** The labels a failed call that held a value keeps of its error, by their names in its context. */
const errorLabels = { code: "errorCode", reason: "errorReason", method: "errorMethod" } as const;

/**
 * An error's string labels, such as a DevTools command's finite reason and its method, each kept
 * only when no value of the step appears in it. Never the error's message or parameters.
 */
const valueFreeLabels = (error: Error, values: readonly string[]) => {
  const held = values.filter((value) => value !== "").map((value) => value.toLowerCase());
  const labels: Record<string, string> = {};
  for (const [key, name] of Object.entries(errorLabels)) {
    const label: unknown = Reflect.get(error, key);
    if (typeof label === "string" && !held.some((value) => label.toLowerCase().includes(value)))
      labels[name] = label;
  }
  return labels;
};

/**
 * A failed focus can refuse before typing. A date or submit can already have changed the site
 * even when it was the first call, so a lost reply stays uncertain. A date's call held the date,
 * and a typing call its value (`held`, the step's values), so their failures keep finite facts
 * only. A typing call's failure has the phase `lostTypingPhase`: the host clicks the submit only
 * after every field.
 */
const failedCall = (
  progress: FillProgress,
  error: Error,
  call: {
    readonly held?: readonly string[];
    readonly mayMutate: boolean;
    readonly typing?: true;
  },
): AutofillStepReport => {
  const detail =
    call.held === undefined
      ? failureDetail("autofill_step_failed", { operation: "autofill.fill", error })
      : failureDetail("autofill_step_failed", {
          operation: "autofill.fill",
          ...(call.typing === true ? { phase: lostTypingPhase } : {}),
          context: { errorName: error.name, ...valueFreeLabels(error, call.held) },
        });
  return progress.typed || call.mayMutate
    ? {
        outcome: "uncertain",
        reason: "fill_call_failed",
        failureDetail: detail,
        ...(progress.typed || call.held !== undefined ? { typed: true as const } : {}),
      }
    : { ...refused("page_unavailable"), failureDetail: detail };
};

/**
 * A control the host refused, or a field the host typed that holds nothing: a refusal before
 * anything was typed. After, the field about to be typed fails untyped, as a fill into it would, a
 * typed field left empty fails, and only the submit's recheck refuses the submit.
 */
const stopped = (
  step: AutofillStep,
  progress: FillProgress,
  answer: Stop | { readonly checked: false; readonly url: string },
  during: "field" | "submit",
): AutofillStepReport => {
  if ("checked" in answer) {
    if (progress.check !== null) progress.statuses[progress.check] = "failed";
    return filledReport(step, progress, "not_attempted", answer.url);
  }
  if (!progress.typed) return answer.refusal;
  if (during === "submit")
    return filledReport(step, progress, "refused", answer.url ?? "", answer.refusal);
  progress.statuses.push("failed");
  return filledReport(step, progress, "not_attempted", answer.url ?? "", answer.refusal);
};

/**
 * The origins the guard's record may name: those judged at inspection, or, when the host typed into
 * the page before it, only those `namedAfterTyping` allows, since the inspection may itself have
 * found a typed value in any other, such as an action's host.
 */
const guardOrigins = (input: FillInput) =>
  namedAfterTyping(input.inspection) ?? judgedOrigins(input.inspection);

/**
 * The origins a refusal's evidence may name: any until something was typed into the page, then
 * only the guard's (`guardOrigins`), since page code may have put a typed value in another.
 */
const evidenceOrigins = (input: FillInput, progress: FillProgress) =>
  progress.typed || input.inspection.judgedBeforeTyping !== undefined
    ? guardOrigins(input)
    : undefined;

interface FillInput {
  readonly step: AutofillStep;
  readonly values: readonly string[];
  readonly inspection: AutofillInspection;
  readonly page: AutofillPage;
  readonly keyboard: CredentialKeyboard;
  /** How each value is typed; `paste` by default. */
  readonly typing?: CredentialTypingMode;
  /** How long the page may take to navigate after the submit, then to load; 5 s by default. */
  readonly settleMs?: number;
}

/**
 * The host's judgment of the controls a call found changed, by inspection's rule, where only a
 * field still to be typed must take typing: a refusal, or undefined to call again. A form that
 * changed how or where it submits, beyond an action's query or hash, and a page that changed them
 * a third time (`changes`, counted across every call the host makes again for it) are refused.
 */
const rejudge = (
  input: FillInput,
  progress: FillProgress,
  changed: typeof Targets.Type,
  call: AutofillFillCall,
  changes: number,
) => {
  const target = call.kind === "submit" ? "submit" : call.index;
  const from = call.kind === "submit" ? input.step.fields.length : call.index;
  const judged = progress.judged;
  const named = evidenceOrigins(input, progress);
  return (
    untrustedTarget(changed, input.step, input.inspection, from, named) ??
    resubmitted(judged, changed, named) ??
    (changes >= 3
      ? withCheck(
          refused("credential_target_refused", target),
          "change",
          targetEvidence(target === "submit" ? changed.submit : changed.fields[target], named),
        )
      : undefined)
  );
};

/**
 * One Kernel call of the fill, which first checks the field the host typed last. A call that finds
 * a control changed since the host last judged it does nothing, and the host judges the controls
 * it found again (`rejudge`), then calls again against that judgment, which the page kept as that
 * call found it: no call's code holds an address the page supplied. `changes` counts the changes
 * found, shared by every call the host makes again for the same action.
 */
const fillCall =
  (input: FillInput, progress: FillProgress, changes = { count: 0 }) =>
  (call: AutofillFillCall): Effect.Effect<Either.Either<CallAnswer, Error>> =>
    Effect.gen(function* () {
      for (;;) {
        const observed = randomUUID();
        const answered = yield* input.page
          .execute(
            autofillStepCode(input.page.targetId, input.step, observed, {
              call,
              popupTargetId: input.inspection.popupTargetId,
              judged: progress.judgment,
              check: progress.check,
            }),
            call.kind === "focus" ? 15 : 30,
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Union(FillAnswer, Changed))),
            Effect.either,
          );
        if (answered._tag === "Left") return Either.left(answered.left);
        const answer = answered.right;
        if ("error" in answer)
          return Either.right<Stop>({
            refusal: locatedRefusal(answer, evidenceOrigins(input, progress)),
            url: answer.url,
          });
        if (!("changed" in answer)) return Either.right(answer);
        const changed = changedProperties(progress.judged, answer.changed);
        changes.count++;
        const untrusted = rejudge(input, progress, answer.changed, call, changes.count);
        if (untrusted !== undefined)
          return Either.right<Stop>({
            refusal: withEvidence(untrusted, {
              changed,
              ...foundEvidence(
                answer.url,
                foundFor(answer.located, untrusted.target),
                evidenceOrigins(input, progress),
              ),
            }),
            url: answer.url,
          });
        progress.judged = answer.changed;
        progress.judgment = observed;
      }
    });

/**
 * How long the host waits for the page to enable a disabled submit once the fields are filled: the
 * 5 s each of its control actions (focus, fill, click) may take. Many sign-in forms enable their
 * submit only on input, some after a short check of what was typed.
 */
const submitEnableMs = 5_000;
/** How often the host calls the submit again while the page keeps it disabled. */
const submitEnablePollMs = 250;

/** A submit call that clicked nothing because the submit was disabled. */
const disabledSubmit = (answered: Either.Either<CallAnswer, Error>) =>
  Either.isRight(answered) && "submit" in answered.right && answered.right.submit === "disabled";

/**
 * The step's submit call, made again while the page keeps the submit disabled, for up to
 * `submitEnableMs`. Each call judges every control again before it clicks, and none clicks a
 * disabled submit. The changes they find count across the whole wait, so a page that keeps
 * changing a control is refused however the changes fall between the calls.
 */
const submitWhenEnabled = (input: FillInput, progress: FillProgress, call: AutofillFillCall) =>
  Effect.gen(function* () {
    const until = Date.now() + submitEnableMs;
    const changes = { count: 0 };
    for (;;) {
      const answered = yield* fillCall(input, progress, changes)(call);
      if (!disabledSubmit(answered) || Date.now() >= until) return answered;
      yield* Effect.sleep(submitEnablePollMs);
    }
  });

/**
 * One field: a date's call fills it; any other field's call focuses it and binds its original node/document/frame; the host inserts its
 * value atomically. Undefined when the fill goes on to the next field, else the step's report.
 */
const fillField = (
  input: FillInput,
  progress: FillProgress,
  index: number,
): Effect.Effect<AutofillStepReport | undefined> =>
  Effect.gen(function* () {
    const field = input.step.fields[index];
    const value = input.values[index] ?? "";
    const bindingKey = `__pomerado_autofill_${randomUUID()}`;
    const format = field?.slot === "date_of_birth" ? (field.format ?? "YYYY-MM-DD") : undefined;
    const answered = yield* fillCall(
      input,
      progress,
    )(
      format === undefined
        ? { kind: "focus", index, bindingKey }
        : { kind: "date", index, iso: value, format },
    );
    if (answered._tag === "Left")
      return failedCall(progress, answered.left, {
        ...(format === undefined ? {} : { held: input.values }),
        mayMutate: format !== undefined,
      });
    const answer = answered.right;
    if ("refusal" in answer || "checked" in answer)
      return stopped(input.step, progress, answer, "field");
    progress.check = null;
    return yield* afterFieldCall(input, progress, index, answer, bindingKey);
  });

/**
 * A field that did not take the focus, or whose native insertion refused (`insertion`, its finite
 * cause), and why. A private answer's question that changed is a change on the screen, as when the
 * call found it changed before focusing.
 */
const untypedRefusal = (
  input: FillInput,
  progress: FillProgress,
  index: number,
  answer: Extract<CallAnswer, { readonly focused: boolean }>,
  insertion: InsertionRefusal | undefined,
) =>
  withCheck(
    refused("credential_target_refused", index),
    insertion === undefined
      ? "not_focused"
      : insertion === "question_changed"
        ? "change"
        : "typing_refused",
    {
      ...answer.unfocused,
      ...(insertion === undefined ? {} : { insertion }),
      ...(insertion === "question_changed" ? { cause: "question_changed" } : {}),
      ...targetEvidence(progress.judged.fields[index], evidenceOrigins(input, progress)),
      ...foundEvidence(answer.url, answer.located, evidenceOrigins(input, progress)),
    },
  );

/** What a field's own call found: a date filled, or a focused field the host now types. */
const afterFieldCall = (
  input: FillInput,
  progress: FillProgress,
  index: number,
  answer: Exclude<CallAnswer, Stop | { readonly checked: false }>,
  bindingKey: string,
): Effect.Effect<AutofillStepReport | undefined> =>
  Effect.gen(function* () {
    if ("dated" in answer) {
      // A date's call may have changed the field even when it failed.
      progress.typed = true;
      progress.statuses.push(answer.dated ? "filled" : "failed");
      return answer.dated
        ? undefined
        : filledReport(input.step, progress, "not_attempted", answer.url);
    }
    if (!("focused" in answer)) return refused("page_unavailable");
    let insertion: InsertionRefusal | undefined;
    if (answer.focused) {
      const value = input.values[index] ?? "";
      const typing = yield* Effect.either(
        input.keyboard.insertText(
          {
            targetId: input.inspection.popupTargetId,
            bindingKey,
            documentOrigin: progress.judged.fields[index]?.documentOrigin ?? "",
          },
          value,
        ),
      );
      if (typing._tag === "Left")
        return failedCall(progress, typing.left, {
          held: input.values,
          mayMutate: true,
          typing: true,
        });
      if (typing.right === "inserted") {
        progress.typed = true;
        progress.statuses.push("filled");
        progress.check = index;
        return undefined;
      }
      insertion = typing.right;
    }
    const refusal = untypedRefusal(input, progress, index, answer, insertion);
    if (!progress.typed) return refusal;
    progress.statuses.push("failed");
    return filledReport(input.step, progress, "not_attempted", answer.url, refusal);
  });

/**
 * Fills the values into the step's fields, in order, and clicks its submit, on the stable primary tab or its inspected authentication popup,
 * judging every control again before each call acts. Kernel calls
 * focus and bind each field and click; the host inserts each value atomically into that original
 * node over its own encrypted DevTools socket (`keyboard`), so no value but a date of birth ever enters a Kernel call's script text or
 * its request to Kernel's REST API. It reports per-field outcomes and never a
 * value. Once anything was typed, a call that fails or finds a control refused can no longer say
 * nothing reached the site: a lost answer is `uncertain`, a control refused before a field's typing
 * fails that field, and one refused before the click, or a submission refused as it fires, refuses
 * the submit. That click ran, though, so the report says so (`clicked`): the page's own handlers
 * ran on it, and what the step filled may have gone out. A submit the page keeps disabled is never
 * clicked: the host waits for the page to enable it once the fields are filled, and when it stays
 * disabled the report says so (`stayed_disabled`).
 */
export const fillAutofillStep = (input: FillInput): Effect.Effect<AutofillStepReport> =>
  Effect.gen(function* () {
    const { step } = input;
    if (input.typing === "keyboard")
      return withCheck(refused("typing_unavailable"), "typing_unavailable");
    const crossing = unsupportedSelector(step);
    if (crossing !== undefined)
      return withCheck(refused("selector_unsupported", crossing), "selector_unsupported");
    const progress: FillProgress = {
      statuses: [],
      typed: false,
      check: null,
      judged: input.inspection.targets,
      judgment: input.inspection.judgment,
    };
    for (let index = 0; index < step.fields.length; index++) {
      const ended = yield* fillField(input, progress, index);
      if (ended !== undefined) return ended;
    }
    // A re-judge never changes a method, so the submission's method is the one judged now.
    const clicked = yield* submitWhenEnabled(
      input,
      progress,
      guardedSubmit(step, progress.judged, {
        settleMs: input.settleMs ?? 5_000,
        inspection: input.inspection.judgment,
        // Once something was typed before inspection, only a secret inside an origin no page chose
        // Is no leak: the page may have put one in any path or query.
        exempt:
          input.inspection.judgedBeforeTyping === undefined
            ? null
            : configuredOrigins(input.inspection),
      }),
    );
    if (clicked._tag === "Left")
      return failedCall(progress, clicked.left, { mayMutate: step.submit !== undefined });
    const answer = clicked.right;
    if ("refusal" in answer || "checked" in answer)
      return stopped(step, progress, answer, "submit");
    if ("submission" in answer)
      return filledReport(
        step,
        progress,
        "refused",
        answer.url,
        firedRefusal(answer, guardOrigins(input)),
        true,
      );
    if (!("submit" in answer)) return refused("page_unavailable");
    if (answer.submit === "disabled")
      return filledReport(
        step,
        progress,
        "stayed_disabled",
        answer.url,
        withCheck(refused("not_editable", "submit"), "submit_disabled", {
          waitedMs: submitEnableMs,
          ...foundEvidence(answer.url, undefined, evidenceOrigins(input, progress)),
        }),
      );
    const report = filledReport(step, progress, answer.submit, answer.url);
    return answer.controls === undefined ? report : { ...report, controls: answer.controls };
  });
