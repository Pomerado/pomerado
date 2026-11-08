import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import {
  approvalNumberOf,
  type AutofillPopup,
  pastedLinkPrompt,
  pastedSignInLink,
} from "../destinations/autofill-contracts.js";
import type { AutofillInspection } from "../destinations/autofill-step.js";
import type { SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import { leftSignInScreens } from "./autofill-replay-pages.js";
import { returnedCredential, type Replay } from "./autofill-replay-session.js";
import { askOne, type AutofillReplayInput } from "./autofill-replay-steps.js";
import type { AutofillHooks } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";

/**
 * The number a device approval's screen shows for the owner to pick, read once from its
 * `matchSelector` element: kept only when it is 1 to 3 digits (`approvalNumberOf`). None without a
 * selector, from a host that can't read one, or when the read fails, and nothing else of the page
 * is kept.
 */
export const approvalNumber = <E>(
  hooks: Pick<AutofillHooks<E>, "approvalNumber">,
  matchSelector: string | undefined,
  page: string,
  popup: AutofillPopup | undefined,
) => {
  const read = hooks.approvalNumber;
  if (matchSelector === undefined || read === undefined) return Effect.succeed(undefined);
  return read.call(hooks, matchSelector, page, popup).pipe(
    Effect.map(approvalNumberOf),
    Effect.orElseSucceed(() => undefined),
  );
};

/** A device approval's confirmation, naming the number to pick when its screen showed one. */
export const withApprovalNumber = (prompt: string, number: string | undefined) =>
  number === undefined ? prompt : `${prompt} If it asks you to choose a number, pick ${number}.`;

/**
 * An email-link approval recorded with `delivery: "paste"`, whose link signs in only the browser
 * that opens it: the owner pastes the link into a protected question, the replay registers it with
 * the host's broker as `SIGN_IN_LINK` before anything opens it, and opens it on the sign-in's tab
 * through the host's `withoutRecording` where it has one, only when `pastedSignInLink` accepts it.
 * A link it doesn't accept is never opened (`approval_link_refused`), and no answer is a decline.
 * The replay's events, outcomes and recorded step leave the link out; how its copies are masked,
 * and the pages the link leads to, are the host's.
 */
export const openPastedLink = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  screen: Pick<AutofillInspection, "siteOrigin" | "authenticationOrigins">,
) =>
  Effect.gen(function* () {
    const answer = yield* askOne(input, {
      id: "sign_in_link",
      type: "secret",
      secretKind: "private_text",
      prompt: pastedLinkPrompt(input.site),
    });
    if (answer?.type !== "secret") return "approval_declined" as const;
    const link = pastedSignInLink(answer.value, screen);
    for (const value of new Set([answer.value, answer.value.trim(), link ?? ""]))
      if (value !== "")
        yield* input.broker
          .register({ kind: "secret", entity: "SIGN_IN_LINK", value })
          .pipe(
            Effect.mapError((error) => input.failures.unavailable("broker.register", { error })),
          );
    if (link === undefined) return "approval_link_refused" as const;
    // The browser's own failure may quote the address it loaded: none of it goes on.
    const open = input.hooks
      .open(link)
      .pipe(
        Effect.mapError(() =>
          input.failures.unavailable("autofill.open", { context: { check: "pasted_link" } }),
        ),
      );
    yield* input.hooks.withoutRecording?.(open) ?? open;
    return "opened" as const;
  });

/** A page's origin, scheme, host and port; none for an opaque one, which matches nothing. */
const originOf = (page: string) => {
  const origin = URL.parse(page)?.origin;
  return origin === undefined || origin === "null" ? undefined : origin;
};

/**
 * Whether the page shown after the previous screen's submit is a recorded approval's screen, where
 * the owner approves the sign-in off the page. The recorded page is admitted as before. A site's
 * approval page often holds a code of its own in its path, and a recording may have saved the page
 * the site showed once the owner approved, so a new browser shows neither: any other page on the
 * recorded page's origin (`recordedPage`, a workspace screen's as this replay knows it) is
 * admitted too, unless it is one of the recorded screens or the entry page, shows a password field
 * or the credential screen the replay submitted again, or shows the signed-in marker already, which
 * signed the browser in with no approval (`signed_in`, which the sign-in's own check then verifies).
 * A page on any other origin is never admitted. Anything not admitted ends as before
 * (`screen_changed`).
 */
export const approvalScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  recordedPage: string,
  page: string,
) =>
  Effect.gen(function* () {
    if (replay.matchesRecorded(page, recorded)) return "admitted" as const;
    const origin = originOf(recordedPage);
    if (
      origin === undefined ||
      originOf(page) !== origin ||
      !leftSignInScreens(replay.onScreens, input.entryUrl, page)
    )
      return "screen_changed" as const;
    const here = yield* replay.checkHere;
    if (here.signedIn) {
      yield* input.emit({ stage: "skipped", reason: "signed_in_indicator" });
      return "signed_in" as const;
    }
    if ("passwordFieldVisible" in here && here.passwordFieldVisible === true)
      return "screen_changed" as const;
    const returned = yield* returnedCredential({
      progress: replay.progress,
      sent: replay.sent,
      hooks: input.hooks,
    });
    return returned === undefined ? ("admitted" as const) : ("screen_changed" as const);
  });
