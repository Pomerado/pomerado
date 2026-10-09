/** What one outcome's locator matched at the last look: all its matches, and the visible ones. */
export interface OutcomeObservation {
  readonly count: number;
  readonly visible: number;
}

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then call `waitForOutcome` with your verified Playwright locators.
 *
 * `waitForOutcome(outcomes, { timeout }?)` waits for whichever of the page's possible answers
 * appears, after a step whose answer can vary, such as a search, a date pick or a submit, and
 * returns its key. `outcomes` names one locator per answer, highest priority first, such as
 * `{ refused, failed, empty, results }`: when several show at once, the first listed wins, so
 * list a refusal or the site's error before an empty state, and an empty state before results.
 * Each locator names one element, such as the results list rather than its rows.
 *
 * It only observes: about every 100 ms it counts each locator's matches and its visible ones, and
 * never clicks, types or navigates. An outcome shows when one of its matches is visible, and the
 * first listed outcome that shows wins. It answers once two looks in a row agree, the second taken
 * at once, so a page that changes between two locators is looked at again; a ready page still
 * answers at once. `timeout` defaults to 30 s, the readiness budget; pass less when less of the
 * operation's deadline remains. It throws an `Error` named `OutcomeWaitFailure`,
 * with `reason` and `observations` (`OutcomeObservation` by key), and a message that names the
 * reason and what each outcome matched, never page text:
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
    .map(([name, { count, visible }]) => name + " " + visible + " visible of " + count)
    .join(", ");
  const after = reason === "outcome_timeout" ? " after " + timeout + " ms" : "";
  return Object.assign(new Error(reason + after + ": " + seen), {
    name: "OutcomeWaitFailure",
    reason,
    observations,
    ...(outcome === undefined ? {} : { outcome }),
  });
};
const outcomeWaitObserve = async (outcomes) => {
  const observations = {};
  for (const [name, locator] of Object.entries(outcomes)) {
    const count = await locator.count();
    observations[name] = { count, visible: count === 0 ? 0 : await locator.filter({ visible: true }).count() };
  }
  return observations;
};
const waitForOutcome = async (outcomes, options = {}) => {
  const names = Object.keys(outcomes);
  if (names.length === 0) throw new TypeError("waitForOutcome needs at least one outcome");
  const timeout = options.timeout ?? 30000;
  const until = Date.now() + timeout;
  // The outcomes are looked at one after another, so the page can change between two of them:
  // a decision holds only once the next look, taken at once, agrees.
  let previous;
  while (true) {
    const observations = await outcomeWaitObserve(outcomes);
    const shown = names.find((name) => observations[name].visible > 0);
    const decision = shown === undefined ? undefined : shown + ":" + Math.min(observations[shown].count, 2);
    if (decision !== undefined && decision === previous) {
      if (observations[shown].count > 1)
        throw outcomeWaitFailure("outcome_ambiguous", timeout, observations, shown);
      return shown;
    }
    if (Date.now() >= until) throw outcomeWaitFailure("outcome_timeout", timeout, observations);
    if (decision === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    previous = decision;
  }
};
`;
