/**
 * The pause before each key after the first, in milliseconds, for typing `text` key by key at a
 * fast person's pace: about 130 words a minute, five characters a word, so 92 ms a key on average.
 * Each pause is drawn from a normal distribution with a 25 ms spread and kept between 35 and 250
 * ms. With `capMs`, a text whose pauses add up to more is typed faster: every pause shrinks by the
 * same factor so they add up to `capMs`.
 *
 * It is pure and self-contained: the page code of `pickerCode` and `formControlsCode` embeds this
 * same function, so it may refer to nothing outside itself.
 */
export const typingPauses = (text: string, capMs?: number): number[] => {
  const pauses = Array.from(text)
    .slice(1)
    .map(() => {
      const normal =
        Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
      return Math.min(250, Math.max(35, 92 + 25 * normal));
    });
  const total = pauses.reduce((sum, pause) => sum + pause, 0);
  return capMs === undefined || total <= capMs
    ? pauses
    : pauses.map((pause) => (pause * Math.max(0, capMs)) / total);
};

/** The part of a Playwright locator that typing key by key uses. */
interface KeyTarget {
  readonly pressSequentially: (text: string, options?: { readonly timeout?: number }) => Promise<void>;
  readonly page: () => { readonly keyboard: { readonly type: (text: string) => Promise<void> } };
}

/**
 * Types `text` into `target` key by key, waiting `pauses[n]` before each key after the first
 * (`typingPauses`). The first key goes through the locator, which focuses its element; the rest go
 * to its page's keyboard, as Playwright's own `pressSequentially` types after it focused. Like
 * `typingPauses`, it is self-contained for the page code that embeds it.
 */
export const typeKeys = async (
  target: KeyTarget,
  text: string,
  pauses: readonly number[],
  options?: { readonly timeout?: number },
): Promise<void> => {
  const [first, ...rest] = Array.from(text);
  if (first === undefined) return;
  await target.pressSequentially(first, options);
  for (const [index, key] of rest.entries()) {
    await new Promise((resolve) => setTimeout(resolve, pauses[index] ?? 0));
    await target.page().keyboard.type(key);
  }
};
