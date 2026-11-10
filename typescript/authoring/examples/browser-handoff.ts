import { Schema } from "effect";
import {
  defaultedInput,
  defineOperation,
  timeoutDefaults,
  waitCode,
} from "../../src/browser/index.js";

const Filled = Schema.Union(
  Schema.Struct({ formId: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ failure: Schema.Literal("unexpected_page") }),
);
// What the page shows once the person hands the browser back.
const AfterHandOff = Schema.Union(
  Schema.Struct({ state: Schema.Literal("submitted"), reference: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ state: Schema.Literal("waiting") }),
  Schema.Struct({ state: Schema.Literal("changed") }),
);
const Submitted = Schema.Union(
  Schema.Struct({ reference: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ failure: Schema.Literal("not_confirmed") }),
);

// Observed contract: an example claims form. Filling it saves nothing; "Submit claim" sends it and
// shows a confirmation with the claim's reference. The build's request asked to let a person check
// the filled form before it is submitted, and to make that check optional per run, so the tool
// takes a boolean input named for it and hands the browser over only when it is true. Adapt from
// site evidence.
export default defineOperation(
  {
    name: "submit_claim",
    input: Schema.Struct({
      policy_number: Schema.NonEmptyTrimmedString.annotations({
        description: "Policy number the claim is for",
      }),
      amount: Schema.NonEmptyTrimmedString.annotations({
        description: "Amount claimed, as the form takes it, such as 120.50",
      }),
      description: Schema.NonEmptyTrimmedString.annotations({
        description: "What the claim is for",
      }),
      review_claim_before_submit: defaultedInput(
        Schema.Boolean.annotations({
          description:
            "When true, a person checks the filled claim form in the browser before it is submitted, and may correct it or submit it themselves",
        }),
        true,
      ),
    }),
    output: Schema.Struct({
      reference: Schema.NonEmptyTrimmedString.annotations({
        description: "Claim reference from the site's confirmation",
      }),
      submitted_by: Schema.Literal("tool", "person").annotations({
        description: "Who pressed Submit claim: the tool, or the person who checked the form",
      }),
    }),
    questions: {
      // The task the person does, naming what to check, and the inputs that help them check it.
      review_claim: {
        type: "browser_handoff",
        prompt:
          "Check the claim form: the policy number, the amount and the description. Correct anything that is wrong. Submit it yourself, or leave it unsubmitted for the tool to submit, then mark this step done.",
        show_inputs: ["policy_number", "amount", "description"],
      },
    },
    // The confirmation's reference, read back after the submit, confirms the write.
    write: { confirmation: "readback", commits: ["submit-claim"] },
  },
  async ({
    kernel,
    sessionId,
    siteOrigin,
    siteDomain,
    input,
    handOff,
    verified,
    enteringCommit,
    notCommitted,
    errors,
  }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const filled = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        if (!onSite(new URL(page.url()))) return { failure: "unexpected_page" };
        const form = page.getByRole("form", { name: "Claim", exact: true });
        await form.waitFor({ timeout: ${timeoutDefaults.navigation} });
        await form.getByLabel("Policy number", { exact: true }).fill(${JSON.stringify(input.policy_number)}, { timeout: ${timeoutDefaults.action} });
        await form.getByLabel("Amount", { exact: true }).fill(${JSON.stringify(input.amount)}, { timeout: ${timeoutDefaults.action} });
        await form.getByLabel("Description", { exact: true }).fill(${JSON.stringify(input.description)}, { timeout: ${timeoutDefaults.action} });
        // The form's own id tells this form from another one the person may open.
        return { formId: (await form.getAttribute("data-form-id")) ?? "" };
      `,
    });
    if (!filled.success)
      throw new errors.OperationFailure(String(filled.error), { stderr: filled.stderr });
    const form = Schema.decodeUnknownSync(Filled)(filled.result);
    if ("failure" in form) throw new errors.OperationFailure(form.failure, { dispatch: "not_sent" });

    if (input.review_claim_before_submit) {
      // The person holds the browser now, and may submit, so the commit step reads sent from here
      // on. The deadline pauses while they work, up to 30 minutes.
      await handOff("review_claim");
      const after = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 60,
        code: `
          const confirmation = page.getByRole("status", { name: "Claim submitted", exact: true });
          if (await confirmation.isVisible())
            return { state: "submitted", reference: (await confirmation.getAttribute("data-reference")) ?? "" };
          const form = page.getByRole("form", { name: "Claim", exact: true });
          const same = (await form.count()) === 1 &&
            (await form.getAttribute("data-form-id")) === ${JSON.stringify(form.formId)};
          return same ? { state: "waiting" } : { state: "changed" };
        `,
      });
      if (!after.success)
        throw new errors.OperationFailure(String(after.error), { stderr: after.stderr });
      const state = Schema.decodeUnknownSync(AfterHandOff)(after.result);
      // The person submitted it: the site's confirmation is the result.
      if (state.state === "submitted") {
        verified();
        return { reference: state.reference, submitted_by: "person" as const };
      }
      // Neither the same form nor a result: stop without acting further.
      if (state.state === "changed") throw new errors.HandoffStateChanged();
      // The same form still waits unsubmitted, so the person sent nothing: the tool submits it.
      notCommitted("submit-claim");
    }

    // The submit can send the claim, so its commit step is marked first.
    enteringCommit("submit-claim");
    const submitted = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        // The claim is sent once; a page that shows no confirmation is reported unconfirmed. The
        // form keeps any correction the person made, which is what the site receives.
        const submit = page.getByRole("button", { name: "Submit claim", exact: true });
        const confirmation = page.getByRole("status", { name: "Claim submitted", exact: true });
        const shown = await waitForOutcome({ confirmation }, { action: () => submit.click({ timeout: waitLimits.action }) }).then(
          () => true,
          (error) => {
            if (error.name !== "OutcomeWaitFailure") throw error;
            return false;
          },
        );
        if (!shown) return { failure: "not_confirmed" };
        return { reference: (await confirmation.getAttribute("data-reference")) ?? "" };
      `,
    });
    // A failure after the click leaves the claim uncertain. Never submit again here.
    if (!submitted.success)
      throw new errors.OperationFailure(String(submitted.error), { stderr: submitted.stderr });
    const result = Schema.decodeUnknownSync(Submitted)(submitted.result);
    if ("failure" in result) throw new errors.OperationFailure(result.failure, { dispatch: "sent" });
    // The confirmation with its reference, read after this click, shows the claim landed.
    verified();
    return { reference: result.reference, submitted_by: "tool" as const };
  },
);
