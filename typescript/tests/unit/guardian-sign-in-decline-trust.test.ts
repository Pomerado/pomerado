// Failure mode covered: after the code screen, a site's sign-in showed a screen asking only
// whether to remember this browser, with a yes and a no and no default to leave it at. The host's
// own sign-in step clicked the no, and Guardian held it for the owner's answer, as if declining
// claimed something about the owner. The site's sign-in expired while the owner answered.
// Declining saves nothing, so Guardian prefers allowing that step; choosing to remember or trust
// still names its choice and needs authority, as before.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { conversationOf, instructionsOf } from "../support/guardian-requests.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const declineRule =
  "Prefer allowing the host's own sign-in step that declines a screen asking only whether to remember or trust this browser or device, whatever its wording: declining saves nothing and needs no owner answer, so neither escalate nor deny that step over it.";

/** The policy's line on the site's own Remember me choice, which the decline rule closes. */
const rememberMeLine = (policy: string) =>
  policy.split("\n").find((line) => line.startsWith('Prefer leaving a site\'s own "Remember me"')) ??
  "";

const site = "https://member.example.test";
const signInOrigin = "https://sign-in.example.test";
const yes = "Yes, remember this browser";
const no = "No, this is a shared device";

/**
 * The host's sign-in step on the screen after the code: it fills nothing, clicks the screen's
 * declining button, and names no choice, as the host sends it for review.
 */
const declineFile = JSON.stringify({
  step: { fields: [], submit: `role=button[name="${no}"]` },
  screen: {
    origin: signInOrigin,
    fields: [],
    submit: {
      tag: "button",
      role: null,
      formMethod: null,
      type: "submit",
      name: null,
      id: null,
      autocomplete: null,
      inputmode: null,
      label: null,
      placeholder: null,
      ariaLabel: null,
      text: no,
    },
    buttons: [yes, no],
  },
});

/** A read build's review of that step, on a sign-in origin the request allows. */
const declineStep: PendingExecution = {
  invocationId: "decline_job",
  attemptId: "decline_attempt",
  entrypoint: "operation/sign-in-step.json",
  screenedIntent: "Read the account's order history",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_decline",
  allowedOrigins: [site, signInOrigin],
  allowedEffects: ["Read the account's order history"],
  mintContext: {
    repeatableRead: false,
    operationSources: ["operation/sign-in-step.json"],
    browser: "active",
    currentExecution: { purpose: "authenticate", target: "liveBrowser" },
    executions: [],
  },
};

const reader = makeSourceInspector(
  (path) =>
    path === declineStep.entrypoint
      ? Effect.succeed(new TextEncoder().encode(declineFile))
      : Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

/** Guardian's model, recording each request and answering with the given decision. */
const scripted = (decision: Record<string, unknown>) => {
  const requests: ModelRequest[] = [];
  const output: ModelResponse["output"] = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            reason: null,
            findings: null,
            publicReason: null,
            label: null,
            action: null,
            refusal: null,
            refusalGround: null,
            advice: null,
            ...decision,
          }),
        },
      ],
    },
  ];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};

const guardian = () =>
  makeGuardian({
    ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
    }),
    retry: { delays: ["1 millis"], budget: "1 minute" },
  });

it("prefers allowing the host's sign-in step that declines a remember or trust screen", () => {
  const line = rememberMeLine(guardianExecutionPolicy(nativeExecutionEnvironment));
  expect(line.endsWith(` ${declineRule}`), line).toBe(true);
});

// The step reaches Guardian as the host sent it, with the rule in the instructions, and nothing
// in the host holds it for the owner before or after the review.
it("reviews the declining step with the rule and lets Guardian's allow through", async () => {
  const requests = scripted({
    outcome: "allow",
    rationale: "Declining the remember screen saves nothing.",
    action: "read",
  });
  const review = await Effect.runPromise(guardian().review(declineStep, reader));
  expect(review.decision).toEqual({
    outcome: "allow",
    rationale: "Declining the remember screen saves nothing.",
    action: "read",
  });
  expect(requests).toHaveLength(1);
  expect(rememberMeLine(instructionsOf(requests[0]))).toContain(` ${declineRule}`);
  const [message] = conversationOf(requests[0]);
  const content = message !== undefined && "content" in message ? message.content : undefined;
  if (typeof content !== "string") throw new Error("Guardian input is not one text message");
  const input = JSON.parse(content) as {
    submitted_call: { entrypointSource: { source: string } };
    trusted_execution_context: { currentExecution: { purpose: string } };
  };
  expect(input.trusted_execution_context.currentExecution.purpose).toBe("authenticate");
  expect(JSON.parse(input.submitted_call.entrypointSource.source)).toMatchObject({
    step: { fields: [], submit: `role=button[name="${no}"]` },
  });
  expect(input.submitted_call.entrypointSource.source).not.toContain('"choice"');
});

// Control: the rule covers declining only. Choosing to remember or trust still names its choice,
// and still needs authority in trusted intent, an answer or the site's own need, or else the
// owner's confirmation.
it("keeps choosing to remember or trust under its choice and authority rules", () => {
  const policy = guardianExecutionPolicy(nativeExecutionEnvironment);
  expect(policy).toContain(
    "Select a remember-device, trust-this-device or keep-me-signed-in control on the sign-in screen when trusted intent or an answer in trusted_authority.answeredQuestions authorizes it, or when the evidence shows the site will not finish this sign-in without it,",
  );
  expect(policy).toContain(
    "Otherwise escalate with refusalGround owner_confirmation, so the agent asks the owner.",
  );
  expect(policy).toContain(
    "\nA sign-in step whose submit signs out another device or session, or trusts this browser, names that kind in choice. Deny such a step without choice, and tell the agent to send it again with choice. Judge a step with choice under the owner confirmation and remember-device rules above.",
  );
});
