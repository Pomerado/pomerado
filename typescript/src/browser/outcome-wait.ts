/**
 * What one outcome's locator matched at the last look: all its matches and the visible ones, and
 * after an `action`, how many visible ones are new or changed since before it.
 */
export interface OutcomeObservation {
  readonly count: number;
  readonly visible: number;
  readonly changed?: number;
}

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then call `waitForOutcome` with your verified Playwright locators.
 *
 * `waitForOutcome(outcomes, { action, timeout, unchangedMs }?)` waits for whichever of the page's
 * possible answers appears, after a step whose answer can vary, such as a search, a filter, a date
 * pick or a submit, and returns its key. `outcomes` names one locator per answer, highest priority
 * first, such as `{ refused, failed, unavailable, empty, results }`: when several show at once,
 * the first listed wins, so list a refusal, the site's error or a greyed-out choice before an
 * empty state, and an empty state before results. Each locator names one element, such as the
 * results list rather than its rows.
 *
 * It only observes: about every 100 ms it counts each locator's matches and its visible ones, and
 * never clicks, types or navigates itself. An outcome shows when one of its matches is visible, and
 * the first listed outcome that shows wins. It answers once two looks in a row agree, the second
 * taken at once, so a page that changes between two locators is looked at again; a ready page
 * still answers at once. `timeout` defaults to 30 s, the readiness budget; pass less when less of
 * the operation's deadline remains. A host reports its timeout as a browser action timeout.
 *
 * `action` is the step itself, such as `() => apply.click()`, which it runs exactly once, after
 * noting what each outcome showed. A match that was visible before the action, with the same
 * text, is the answer from before it, so it counts only once it has stayed so for `unchangedMs`
 * (default 2000), for a step that leaves the same answer. A new element, one that was hidden
 * before, or one whose text changed, counts at once. `timeout` and `unchangedMs` both start once
 * the action returns. An action that throws ends the wait with its error.
 *
 * It throws an `Error` named `OutcomeWaitFailure`, with `reason` and `observations`
 * (`OutcomeObservation` by key), and a message that names the reason and what each outcome
 * matched, never page text:
 *
 * - `outcome_ambiguous`, when the winning outcome's locator matches more than one element, hidden
 *   ones included, so the locator the code acts on next matches exactly one; its `outcome` is that
 *   key. It never picks one of them: scope the locator, for example with
 *   `.filter({ visible: true })` against a hidden copy.
 * - `outcome_timeout`, when no outcome appeared within `timeout`.
 */
export const outcomeWaitCode = String.raw`
const outcomeWaitFailure = (reason, timeout, observations, outcome) => {
  const seen = Object.entries(observations)
    .map(([name, { count, visible, changed }]) =>
      name + " " + visible + " visible of " + count + (changed === 0 && visible > 0 ? ", unchanged" : ""))
    .join(", ");
  const after = reason === "outcome_timeout" ? " after " + timeout + " ms" : "";
  return Object.assign(new Error(reason + after + ": " + seen), {
    name: "OutcomeWaitFailure",
    reason,
    observations,
    ...(outcome === undefined ? {} : { outcome }),
  });
};
// What each visible element showed before the action, kept in the page by a key of this wait's
// own; a page the action replaced has none, so everything on it is new.
const outcomeWaitNote = (locator, key) =>
  locator.filter({ visible: true }).evaluateAll((elements, key) => {
    const noted = (globalThis[Symbol.for(key)] ??= new WeakMap());
    for (const element of elements) noted.set(element, element.innerText);
  }, key);
const outcomeWaitChanged = (locator, key) =>
  locator.filter({ visible: true }).evaluateAll((elements, key) => {
    const noted = globalThis[Symbol.for(key)];
    return elements.filter((element) => noted?.get(element) !== element.innerText).length;
  }, key);
const outcomeWaitObserve = async (outcomes, key) => {
  const observations = {};
  for (const [name, locator] of Object.entries(outcomes)) {
    const count = await locator.count();
    const visible = count === 0 ? 0 : await locator.filter({ visible: true }).count();
    observations[name] = key === undefined ? { count, visible }
      : { count, visible, changed: visible === 0 ? 0 : await outcomeWaitChanged(locator, key) };
  }
  return observations;
};
const waitForOutcome = async (outcomes, options = {}) => {
  const names = Object.keys(outcomes);
  if (names.length === 0) throw new TypeError("waitForOutcome needs at least one outcome");
  const timeout = options.timeout ?? 30000;
  let key;
  if (options.action !== undefined) {
    key = "pomerado.outcomeWait." + Date.now() + "." + Math.random();
    for (const locator of Object.values(outcomes)) await outcomeWaitNote(locator, key);
    await options.action();
  }
  const until = Date.now() + timeout;
  const unchangedFrom = Date.now() + (options.unchangedMs ?? 2000);
  // A page or frame the action is replacing can drop a look midway; the next look sees the new one.
  const look = () =>
    outcomeWaitObserve(outcomes, key).catch((error) => {
      if (/Execution context was destroyed|Frame was detached/.test(String(error?.message))) return undefined;
      throw error;
    });
  // The outcomes are looked at one after another, so the page can change between two of them:
  // a decision holds only once the next look, taken at once, agrees.
  let previous;
  let last;
  while (true) {
    const observations = await look();
    last = observations ?? last;
    const stale = Date.now() < unchangedFrom;
    const shown = names.find(
      (name) => observations?.[name].visible > 0 && !(stale && observations[name].changed === 0),
    );
    const decision = shown === undefined ? undefined : shown + ":" + Math.min(observations[shown].count, 2);
    if (decision !== undefined && decision === previous) {
      if (observations[shown].count > 1)
        throw outcomeWaitFailure("outcome_ambiguous", timeout, observations, shown);
      return shown;
    }
    // A first sighting at the deadline still gets its confirming look.
    if (Date.now() >= until && (decision === undefined || previous !== undefined))
      throw outcomeWaitFailure("outcome_timeout", timeout, last ?? (await look().catch(() => undefined)) ?? {});
    // Only a first sighting is looked at again at once; anything else waits for the next poll.
    if (decision === undefined || previous !== undefined)
      await new Promise((resolve) => setTimeout(resolve, 100));
    previous = decision;
  }
};
`;
