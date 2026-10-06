import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Usage } from "@openai/agents";
import type { ModelRequest } from "@openai/agents";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import type { GuardianExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer, nativeExecutionEnvironment as packagedNative } from "../../src/guardian/openai.js";
import type { GuardianExecutionEnvironment as PackagedEnvironment } from "../../src/guardian/openai.js";
import { UpstreamPolicySlotInvalid, withTenantPolicy } from "../../src/guardian/upstream-policy.js";
import { markedUpstreamPolicy } from "../support/tenant-policy.js";

const slot = "{{ tenant_policy_config }}";
// sha256 of upstream-policy.md before the notice was added. A deliberate policy edit updates it.
const policyBodySha256 = "bf072035fd6233158822b23d95a8037a8fc85324c5d57254dbbbbfc30c2fd352";
// sha256 of the local host's execution policy. A deliberate policy edit updates it.
const nativePolicySha256 = "c69fb86e95370c2bd879ba2039c74dd0f209027795c92773eea1ccb321feeac6";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const shippedPolicy = readFileSync(
  new URL("../../src/guardian/upstream-policy.md", import.meta.url),
  "utf8",
);

describe("upstream Guardian policy", () => {
  it("carries the Codex Apache-2.0 modification notice", () => {
    expect(shippedPolicy.startsWith("<!--")).toBe(true);
    expect(shippedPolicy).toContain("OpenAI Codex");
    expect(shippedPolicy).toContain("Apache License, Version 2.0");
    expect(shippedPolicy).toContain("third-party/codex/LICENSE");
    expect(shippedPolicy).toContain("Modified by Pomerado");
  });

  it("keeps the notice out of the reviewer's instructions", () => {
    const instructions = withTenantPolicy(shippedPolicy, "TENANT POLICY");
    expect(instructions.startsWith("You are judging one planned coding-agent action.\n")).toBe(true);
    expect(instructions).not.toContain("<!--");
    expect(instructions).not.toContain("Apache");
    expect(instructions.split("TENANT POLICY")).toHaveLength(2);
  });

  it("sends the reviewer the same policy bytes as before the notice", () => {
    // Filling the slot with itself returns the policy exactly as the model would see it.
    expect(sha256(withTenantPolicy(shippedPolicy, slot))).toBe(policyBodySha256);
  });

  it("fills a commented policy exactly as the same policy without the comment", () => {
    const commented = `<!--\nNotice for readers.\n-->\n\n${markedUpstreamPolicy}`;
    expect(withTenantPolicy(commented, "TENANT")).toBe(
      withTenantPolicy(markedUpstreamPolicy, "TENANT"),
    );
  });

  it("drops the notice from a policy with CRLF line endings", () => {
    const body = markedUpstreamPolicy.replaceAll("\n", "\r\n");
    const commented = `<!--\r\nNotice for readers.\r\n-->\r\n\r\n${body}`;
    expect(withTenantPolicy(commented, "TENANT")).toBe(withTenantPolicy(body, "TENANT"));
  });

  it("drops the notice after a leading byte order mark", () => {
    const commented = `\uFEFF<!--\nNotice for readers.\n-->\n\n${markedUpstreamPolicy}`;
    expect(withTenantPolicy(commented, "TENANT")).toBe(
      withTenantPolicy(markedUpstreamPolicy, "TENANT"),
    );
  });

  it("drops the notice after leading whitespace", () => {
    const commented = ` \n\t\n<!-- Notice for readers. -->\n${markedUpstreamPolicy}`;
    expect(withTenantPolicy(commented, "TENANT")).toBe(
      withTenantPolicy(markedUpstreamPolicy, "TENANT"),
    );
  });

  it("leaves a policy without a leading notice byte-identical", () => {
    const policy = `\uFEFF \n${markedUpstreamPolicy}`;
    expect(withTenantPolicy(policy, slot)).toBe(policy);
  });

  it("does not count a slot inside the leading notice", () => {
    expect(() =>
      withTenantPolicy("<!-- {{ tenant_policy_config }} -->\nNo slot here.", "TENANT"),
    ).toThrow(UpstreamPolicySlotInvalid);
  });

  it("keeps a comment that does not open the policy", () => {
    const policy = `Before.\n<!-- kept -->\n${markedUpstreamPolicy}`;
    expect(withTenantPolicy(policy, "TENANT")).toContain("<!-- kept -->");
  });
});

/** Another host's text for every slot, each marked so the test can find it. */
const otherHost: GuardianExecutionEnvironment = {
  name: "other-host",
  operations: "OTHER-OPERATIONS runs operations elsewhere.",
  bypassTarget: "OTHER-BYPASS",
  offlineTargets: "OTHER-OFFLINE stays offline.",
  commands: "OTHER-COMMANDS runs commands elsewhere.",
  signIn: "OTHER-SIGN-IN",
  challenges: "OTHER-CHALLENGES waits elsewhere.",
  executor: "OTHER-EXECUTOR",
};
const slots = [
  "operations",
  "bypassTarget",
  "offlineTargets",
  "commands",
  "signIn",
  "challenges",
  "executor",
] as const;

describe("Guardian execution environment", () => {
  it("puts each of the host's texts in its place in the execution policy", () => {
    const policy = guardianExecutionPolicy(otherHost);
    for (const slot of slots) expect(policy.split(otherHost[slot])).toHaveLength(2);
    expect(policy).toContain("attempts to bypass OTHER-BYPASS.");
    expect(policy).toContain("Sign-in is handled by the host OTHER-SIGN-IN");
    expect(policy).toContain("confirms only OTHER-EXECUTOR cleanup");
    for (const slot of ["operations", "offlineTargets", "commands", "signIn", "challenges"] as const)
      expect(policy).not.toContain(nativeExecutionEnvironment[slot]);
    const native = guardianExecutionPolicy(nativeExecutionEnvironment);
    for (const slot of slots) expect(native).toContain(nativeExecutionEnvironment[slot]);
  });

  it("sends the model the host's policy and names the host in the review input", async () => {
    const requests: ModelRequest[] = [];
    const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: otherHost,
      modelProvider: {
        getModel: () => ({
          getResponse: async (request) => {
            requests.push(request);
            return {
              usage: new Usage(),
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({ outcome: "allow", rationale: "Synthetic review" }),
                    },
                  ],
                },
              ],
            };
          },
          getStreamedResponse: () => {
            throw new Error("Unused stream");
          },
        }),
      },
    });
    await Effect.runPromise(
      reviewer.run({
        reviewId: "review_environment",
        pending: {
          invocationId: "job_environment",
          attemptId: "attempt_environment",
          entrypoint: "operation.mjs",
          screenedIntent: "Read the title",
          screenedInput: "{}",
          screenedObservations: "No prior execution",
          accountScope: "account_a",
          allowedOrigins: ["https://example.test"],
          allowedEffects: ["read"],
        },
        readSource: () => Effect.succeed("export default {};"),
        reportDiagnostic: () => Effect.void,
      }),
    );
    expect(requests).toHaveLength(1);
    const instructions = String(requests[0]?.systemInstructions);
    expect(instructions).toContain(guardianExecutionPolicy(otherHost));
    // The review input is one JSON document inside the user message.
    expect(JSON.stringify(requests[0]?.input)).toContain(
      String.raw`\"trusted_execution_environment\":\"other-host\"`,
    );
  });

  it("keeps the local host's execution policy byte for byte", () => {
    expect(sha256(guardianExecutionPolicy(nativeExecutionEnvironment))).toBe(nativePolicySha256);
  });

  it("exports the environment type and the local environment from the package's Guardian entry", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { readonly exports: Readonly<Record<string, { readonly import?: string }>> };
    const target = manifest.exports["./core/guardian/openai"]?.import;
    expect(target).toBe("./dist/typescript/src/guardian/openai.js");
    const source = new URL(
      `../../../${String(target).replace("./dist/", "").replace(/\.js$/u, ".ts")}`,
      import.meta.url,
    );
    const entry = (await import(source.href)) as { readonly nativeExecutionEnvironment?: unknown };
    expect(entry.nativeExecutionEnvironment).toBe(nativeExecutionEnvironment);
    const environment: PackagedEnvironment = packagedNative;
    expect(environment).toBe(nativeExecutionEnvironment);
  });
});
