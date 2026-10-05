import { autofillPageCode } from "./autofill-page-code.js";
import type { AutofillPopup } from "./autofill-contracts.js";
import { Effect, Schema } from "effect";
import { primaryPageCode } from "../runtime/host-execute.js";
import { sameSite } from "../runtime/same-site.js";
import type { AutofillPage } from "./autofill-step.js";

/** Reads only whether a recorded rejection marker is visible on its screen's allowed frames. */
export const autofillMarkerVisible = (input: {
  readonly selector: string;
  readonly screenPage: string;
  readonly popup?: AutofillPopup | undefined;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
}) => {
  if (input.selector.includes(">>") || input.selector.includes("internal:"))
    return Effect.succeed(false);
  const expected = URL.parse(input.screenPage)?.origin;
  if (
    expected === undefined ||
    !(
      input.authenticationOrigins.includes(expected) ||
      sameSite(input.siteOrigin, new URL(expected))
    )
  )
    return Effect.succeed(false);
  // A known absent recorded popup has no visible marker; opener verification still decides success.
  return input.page
    .execute(
      `${autofillPageCode(input.page.targetId, input.popup)}
const expected = ${JSON.stringify(expected)};
if (new URL(primary.url()).origin !== expected) return false;
const origins = ${JSON.stringify([expected, ...input.authenticationOrigins])};
for (const frame of primary.frames()) {
  let origin;
  try { origin = new URL(frame.url()).origin; } catch { continue; }
  if (!origins.includes(origin)) continue;
  const marker = frame.locator(${JSON.stringify(input.selector)});
  const count = Math.min(await marker.count(), 100);
  for (let index = 0; index < count; index++)
    if (await marker.nth(index).isVisible()) return true;
}
return false;`,
      15,
    )
    .pipe(
      Effect.flatMap((result) =>
        input.popup === undefined
          ? Schema.decodeUnknown(Schema.Boolean)(result)
          : Schema.decodeUnknown(
              Schema.Union(
                Schema.Boolean,
                Schema.Struct({
                  error: Schema.Literal("popup_missing"),
                  target: Schema.Literal("popup"),
                }),
              ),
            )(result).pipe(Effect.map((visible) => visible === true)),
      ),
    );
};
/** Opens `url` on the primary tab, as a run's replay starts from its login URL. */
export const openAutofillLogin = (input: {
  readonly page: AutofillPage;
  readonly url: string;
  /** How long the page may take to load; 30 s by default. */
  readonly timeoutMs?: number;
}) =>
  input.page
    .execute(
      `${primaryPageCode(input.page.targetId)}
await primary.goto(${JSON.stringify(input.url)}, { waitUntil: "domcontentloaded", timeout: ${input.timeoutMs ?? 30_000} });
return primary.url();`,
      Math.ceil((input.timeoutMs ?? 30_000) / 1000) + 5,
    )
    .pipe(Effect.asVoid);
