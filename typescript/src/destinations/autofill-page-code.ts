import { Schema } from "effect";
import { formControlsCode } from "../browser/form-controls.js";
import type { AutofillPopup, DateOfBirthFormat } from "./autofill-contracts.js";
import { locateCode, questionTextCode } from "./autofill-locate-code.js";
import { pageCode, primaryPageCode } from "../runtime/host-execute.js";
import { submissionGuardCode } from "./autofill-submission-guard.js";

/**
 * Page code: the step's controls and visible native and ARIA actions, for the host and Guardian.
 * The page keeps the controls as found, with every form destination as found, under `observed`.
 */
const inspectCode = `await keep(observed, {
  questions: fields.map(({ described }) => described.questionText ?? null),
  targets: { fields: fields.map(({ target }) => target), submit: submit === null ? null : submit.target },
  destinations: [submit, ...fields].flatMap((found) => found?.destinations ?? []),
});
const buttons = [];
for (const frame of primary.frames()) {
  const candidates = frame.locator('button, input[type="submit"], input[type="button"], input[type="image"], a, [role~="button"], [role~="link"], [role~="menuitem"], [role~="radio"]');
  const count = Math.min(await candidates.count(), 50);
  for (let index = 0; index < count && buttons.length < 20; index++) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    const words = clip(await candidate.evaluate((element) => element.getAttribute("aria-label") ?? (element instanceof HTMLInputElement ? (element.type === "image" ? element.alt : element.value) : element.textContent)));
    buttons.push(words ?? "(unlabelled button)");
  }
}
return {
  fields: fields.map(({ target, described }) => ({ target, described })),
  submit: submit === null ? null : { target: submit.target, described: submit.described },
  located,
  buttons,
  ...(popupTargetId === undefined ? {} : { popupTargetId }),
  url: primary.url(),
};`;

/**
 * One call of a step's fill, after its inspection. None carries a value but a date's: the host
 * types every other value itself over its own DevTools socket, into the field `focus` left focused. `check` names the field the host typed just before, which must now hold
 * something, so typing that went to another element never leads to a click.
 * - `focus`: empties the field when it holds something and focuses it, then reads that it holds
 *   the focus.
 * - `date`: fills a date of birth with the authoring library's `fillDate`, which needs the page's
 *   own options, so this call's code holds the date (`iso`).
 * - `submit`: guards the submission as it fires (`submissionGuardCode`, under the host's
 *   `guardKey` and armed for `guardCall`, with every form action and link destination as the
 *   step's inspection found them, which the page kept under `inspection`, the submission's method
 *   as judged, and how each field's secret is found by value, if it is one), clicks the submit and
 *   waits for the page to settle.
 */
export type AutofillFillCall =
  | {
      readonly kind: "focus";
      readonly index: number;
      readonly bindingKey: string;
    }
  | {
      readonly kind: "date";
      readonly index: number;
      readonly iso: string;
      readonly format: DateOfBirthFormat;
    }
  | {
      readonly kind: "submit";
      readonly settleMs: number;
      readonly guardKey: string;
      readonly guardCall: string;
      /** The id the page keeps the step's inspection under. */
      readonly inspection: string | undefined;
      /**
       * Once something was typed before the inspection, the configured origins, whose own scheme
       * and host alone still exempt a secret in place of what the inspection found; else null.
       */
      readonly exempt: readonly string[] | null;
      readonly secretMatch: readonly ("within" | "token" | null)[];
      /** The submit as judged: whether it submits a form at all, and by GET. */
      readonly submitInForm: boolean;
      readonly submitGet: boolean;
      /** Whether each field's own form was judged to submit by GET. */
      readonly fieldGet: readonly boolean[];
    };

/**
 * Page code: when any control differs from the one the host last judged, which the page kept under
 * `judged`, or the page lost it, does nothing, keeps every control as found under `observed` and
 * hands them back, for the host to judge again by inspection's rule (page code may move a form off
 * the site once values are typed, so each call finds and judges every control again). Otherwise
 * checks the field the host just typed, then runs the call.
 */
const fillCallCode = (
  call: AutofillFillCall,
  judgedId: string | undefined,
  check: number | null,
) => `const judgment = await kept(${JSON.stringify(judgedId ?? null)});
const judged = judgment?.targets ?? null;
const questions = fields.map(({ described }) => described.questionText ?? null);
for (let index = 0; index < questionSelectors.length; index++) {
  if (questionSelectors[index] !== null &&
      (judgment === null || questions[index] !== judgment.questions?.[index]))
    return { error: "target_changed", target: index, url: primary.url() };
}
const same = (found, expected) =>
  found === null || expected === null
    ? found === expected
    : found.ownerUrl === expected.ownerUrl &&
      found.documentOrigin === expected.documentOrigin &&
      found.editable === expected.editable &&
      found.control === expected.control &&
      JSON.stringify(found.actions) === JSON.stringify(expected.actions) &&
      JSON.stringify(found.methods) === JSON.stringify(expected.methods) &&
      found.submitMethod === expected.submitMethod;
const found = { fields: fields.map(({ target }) => target), submit: submit === null ? null : submit.target };
if (
  judged === null ||
  found.fields.some((target, index) => !same(target, judged.fields[index] ?? null)) ||
  !same(found.submit, judged.submit)
) {
  await keep(observed, { targets: found, questions });
  return { changed: found, located, url: primary.url() };
}
const check = ${JSON.stringify(check)};
if (check !== null) {
  // Its length only, never its value.
  const holds = await fields[check].locator
    .evaluate((element) => typeof element.value === "string" && element.value.length > 0)
    .catch(() => false);
  if (!holds) return { checked: false, url: primary.url() };
}
${fillCallBody(call)}`;

const fillCallBody = (call: AutofillFillCall) => {
  if (call.kind === "focus")
    return `const field = fields[${call.index}].locator;
const fieldLocated = located.fields[${call.index}];
const question = fields[${call.index}].question;
try {
  // Emptied only when it holds something: Playwright clears with a Delete key a page sees.
  if (await field.evaluate((element) => typeof element.value === "string" && element.value.length > 0))
    await field.fill("", { timeout: 5000 });
  await field.focus({ timeout: 5000 });
  // Keep this original-node binding in Patchright's isolated world, inaccessible to page code.
  // The tag of the element that holds the focus instead, if another does.
  const activeTag = await field.evaluate((element, [key, questionRequired]) => {
    const active = element.ownerDocument.activeElement;
    if (active !== element) return active === null ? "none" : active.tagName.toLowerCase();
    const binding = { document: element.ownerDocument, frame: element.ownerDocument.defaultView, questionRequired };
    Object.defineProperty(element, key, { value: binding, configurable: true });
    // Transfer the guard through this frame's isolated world; no value is involved.
    if (questionRequired) Object.defineProperty(element.ownerDocument.defaultView, key, { value: binding, configurable: true });
    element.setAttribute(key, "");
    return null;
  }, [${JSON.stringify(call.bindingKey)}, question !== undefined], undefined, true);
  if (activeTag === null && question !== undefined) {
    await question.locator.evaluate((element, { key, text }) => {
      const scope = element.ownerDocument.defaultView;
      const binding = scope[key];
      delete scope[key];
      if (!binding) throw new Error("Question binding unavailable");
      const readQuestionText = ${questionTextCode};
      binding.checkQuestion = () => readQuestionText(element) === text;
    }, { key: ${JSON.stringify(call.bindingKey)}, text: question.text }, undefined, true);
  }
  return activeTag === null
    ? { focused: true, located: fieldLocated, url: primary.url() }
    : { focused: false, unfocused: { activeTag }, located: fieldLocated, url: primary.url() };
} catch (error) {
  const focusError = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "unknown";
  return { focused: false, unfocused: { focusError }, located: fieldLocated, url: primary.url() };
} finally {
  if (question !== undefined) await field.evaluate((element, key) => {
    delete element.ownerDocument.defaultView[key];
  }, ${JSON.stringify(call.bindingKey)}, { timeout: 1000 }, true).catch(() => undefined);
}`;
  if (call.kind === "date")
    return `try {
  // A date goes into whatever date control the page has, in the format the field takes.
  await fillDate(fields[${call.index}].locator, ${JSON.stringify(call.iso)}, ${JSON.stringify(call.format)}, { timeout: 5000 });
  return { dated: true, url: primary.url() };
} catch {
  return { dated: false, url: primary.url() };
}`;
  return `if (submit === null) return { submit: "none", url: primary.url() };
const guardKey = ${JSON.stringify(call.guardKey)};
const guardCall = ${JSON.stringify(call.guardCall)};
const secretMatch = ${JSON.stringify(call.secretMatch)};
const fieldGet = ${JSON.stringify(call.fieldGet)};
// None once the page lost them: then a secret any action holds is refused, as if none held it before.
const exempt = ${JSON.stringify(call.exempt)};
const inspected =
  exempt ?? (await kept(${JSON.stringify(call.inspection ?? null)}))?.destinations ?? [];
const submitHandle = await submit.locator.elementHandle({ timeout: 5000 });
const submitFrame = await submitHandle.ownerFrame();
const guarded = [];
for (const [index, field] of fields.entries()) {
  const handle = await field.locator.elementHandle({ timeout: 5000 });
  // Only the form the host's click submits, judged GET, submits by GET: the
  // methods as judged, not as read now, which page code could have changed since the recheck.
  const guarding = await handle.evaluate(${submissionGuardCode}, {
    key: guardKey,
    call: guardCall,
    actions: inspected,
    match: secretMatch[index] ?? null,
    submit: (await handle.ownerFrame()) === submitFrame ? submitHandle : null,
    submitInForm: ${JSON.stringify(call.submitInForm)},
    submitGet: ${JSON.stringify(call.submitGet)},
    fieldGet: fieldGet[index] === true,
  });
  if (guarding) guarded.push(handle);
}
// Read through the same handles, so in the guard's own world; a document that left has none.
const refusedSubmission = async () => {
  for (const handle of guarded) {
    const refused = await handle
      .evaluate((field, { key, call }) => {
        const guard = field.ownerDocument.defaultView[key];
        return guard?.call === call ? guard.refused : null;
      }, { key: guardKey, call: guardCall })
      .catch(() => null);
    if (refused) return refused;
  }
  return null;
};
const navigated = primary
  .waitForEvent("framenavigated", { predicate: (frame) => frame === primary.mainFrame(), timeout: ${call.settleMs} })
  .then(() => true, () => false);
try {
  await submit.locator.click({ timeout: 5000 });
} catch {
  return { submit: "failed", url: primary.url() };
}
let submission = await refusedSubmission();
if (submission === null && (await navigated))
  await primary.waitForLoadState("domcontentloaded", { timeout: ${call.settleMs} }).catch(() => undefined);
submission ??= await refusedSubmission();
return submission === null ? { submit: "clicked", url: primary.url() } : { submission, url: primary.url() };`;
};

/** Resolves only a real child of the stable primary opener, on the recorded origin. */
export const autofillPageCode = (targetId: string, popup: AutofillPopup | undefined) =>
  popup === undefined
    ? primaryPageCode(targetId)
    : `${pageCode(targetId, "opener")}
const popupOrigin = ${JSON.stringify(popup.origin)};
const matches = [];
for (const candidate of context.pages()) {
  if (candidate === opener || candidate.isClosed()) continue;
  if (await candidate.opener() !== opener) continue;
  let origin;
  try { origin = new URL(candidate.url()).origin; } catch { continue; }
  if (origin === popupOrigin) matches.push(candidate);
}
if (matches.length !== 1) return {
  error: matches.length === 0 ? "popup_missing" : "popup_ambiguous", target: "popup"
};
const primary = matches[0];
`;

/**
 * One host call for a step: its inspection, or with `fill`, one call of its fill. What it finds,
 * the page keeps under `observed`; a fill call compares against what it kept under `judged`.
 */
export const autofillStepCode = (
  targetId: string,
  step: {
    readonly fields: readonly {
      readonly selector: string;
      readonly slot?: string | undefined;
      readonly questionSelector?: string | undefined;
    }[];
    readonly submit?: string | undefined;
    readonly popup?: AutofillPopup | undefined;
  },
  observed: string,
  fill?: {
    readonly popupTargetId?: string | undefined;
    readonly call: AutofillFillCall;
    readonly judged: string | undefined;
    readonly check: number | null;
  },
) => `${autofillPageCode(targetId, step.popup)}
let popupTargetId;
${
  step.popup === undefined
    ? ""
    : `const authTargetSession = await context.newCDPSession(primary);
try { popupTargetId = (await authTargetSession.send("Target.getTargetInfo")).targetInfo.targetId; }
finally { await authTargetSession.detach(); }
${fill === undefined ? "" : `if (popupTargetId !== ${JSON.stringify(fill.popupTargetId)}) return {error:"target_changed", target:"popup"};`}`
}
${formControlsCode}
${locateCode}
const observed = ${JSON.stringify(observed)};
const selectors = ${JSON.stringify(step.fields.map((field) => field.selector))};
const questionSelectors = ${JSON.stringify(step.fields.map((field) => field.slot === "private_answer" ? field.questionSelector ?? null : null))};
const fields = [];
for (let index = 0; index < selectors.length; index++) {
  const found = await locate(selectors[index], questionSelectors[index]);
  if ("error" in found) return { ...found, target: index, url: primary.url() };
  fields.push(found);
}
const submitSelector = ${JSON.stringify(step.submit ?? null)};
const submit = submitSelector === null ? null : await locate(submitSelector);
if (submit !== null && "error" in submit) return { ...submit, target: "submit", url: primary.url() };
if (submit !== null && submit.disabled)
  return { error: "not_editable", target: "submit", located: submit.located, url: primary.url() };
const located = { fields: fields.map((field) => field.located), submit: submit === null ? null : submit.located };
${fill === undefined ? inspectCode : fillCallCode(fill.call, fill.judged, fill.check)}`;

/** What `autofillSignedInCode` answers. */
export const SignedInPage = Schema.Struct({
  url: Schema.String,
  indicator: Schema.NullOr(Schema.Boolean),
  passwordVisible: Schema.Boolean,
  challengeFormVisible: Schema.Boolean,
});

const signedInChallengeFormCode = `
const visibleFrame = async (frame) =>
  frame.parentFrame() === null || await (await frame.frameElement()).isVisible();
const recordedChallengeVisible = async (selectors) => {
  for (const frame of primary.frames()) {
    if (!(await visibleFrame(frame))) continue;
    for (const selector of selectors) {
      const located = frame.locator(selector);
      const count = Math.min(await located.count(), 100);
      for (let index = 0; index < count; index++)
        if (await located.nth(index).isVisible()) return true;
    }
  }
  return false;
};`;

/**
 * One host call: the page URL, whether the indicator is visible in a frame on the site (its host
 * `siteHost` or a subdomain of it), and whether a password field of the sign-in's own shows in any
 * frame: one of its fields (`signInFields`, by selector), or one in the form of a visible one.
 * Another form's password field, such as a change-password form or an inner service's login,
 * does not count unless one of those selectors matches in it. A hidden match, such as the username
 * a change-password form keeps for password managers, is no sign-in form showing. With no
 * `signInFields`, any visible password field counts.
 */
export const autofillSignedInCode = (
  targetId: string,
  selector: string | undefined,
  siteHost: string,
  signInFields: readonly string[],
  challengeFields: readonly string[],
  popups: readonly AutofillPopup[] = [],
) =>
  `${primaryPageCode(targetId)}
const popupOrigins = ${JSON.stringify(popups.map((popup) => popup.origin))};
for (const candidate of context.pages()) {
  if (candidate === primary || candidate.isClosed() || await candidate.opener() !== primary) continue;
  let origin;
  try { origin = new URL(candidate.url()).origin; } catch { continue; }
  if (popupOrigins.includes(origin)) return { url: primary.url(), indicator: false, passwordVisible: false, challengeFormVisible: false };
}
const siteHost = ${JSON.stringify(siteHost)};
const onSite = (frame) => {
  let host = "";
  try {
    host = new URL(frame.url()).hostname;
  } catch {
    return false;
  }
  return host === siteHost || host.endsWith("." + siteHost);
};
const visibleIn = async (selector, scopes) => {
  for (const scope of scopes) {
    const located = scope.locator(selector);
    const count = Math.min(await located.count(), 100);
    for (let index = 0; index < count; index++)
      if (await located.nth(index).isVisible()) return true;
  }
  return false;
};
${signedInChallengeFormCode}
const password = 'input[type="password"]';
// The field itself, or a control of its form as locate reads the form (its form attribute too),
// that is a password field and shows: a box with an area, and not hidden.
const passwordInForm = (element, matched) => {
  const form =
    "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
  const controls = form
    ? Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(form))
    : [element];
  return controls.some((control) => {
    const box = control.getBoundingClientRect();
    return (
      control.matches(matched) &&
      box.width > 0 &&
      box.height > 0 &&
      control.checkVisibility({ visibilityProperty: true })
    );
  });
};
const signInPasswordVisible = async (selectors) => {
  for (const frame of primary.frames())
    for (const fieldSelector of selectors) {
      const located = frame.locator(fieldSelector);
      const count = Math.min(await located.count(), 100);
      for (let index = 0; index < count; index++) {
        const field = located.nth(index);
        if (!(await field.isVisible())) continue;
        if (await field.evaluate(passwordInForm, password)) return true;
      }
    }
  return false;
};
const selector = ${JSON.stringify(selector ?? null)};
const signInFields = ${JSON.stringify(signInFields)};
const challengeFields = ${JSON.stringify(challengeFields)};
const siteFrames = primary.frames().filter(onSite);
return {
  url: primary.url(),
  indicator: selector === null ? null : await visibleIn(selector, siteFrames),
  challengeFormVisible: await recordedChallengeVisible(challengeFields),
  // With no field of the sign-in's own to go by, any password field on the page still counts.
  passwordVisible:
    signInFields.length === 0
      ? popupOrigins.length === 0 && await visibleIn(password, primary.frames())
      : await signInPasswordVisible(signInFields),
};`;
