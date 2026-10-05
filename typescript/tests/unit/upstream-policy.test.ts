import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UpstreamPolicySlotInvalid, withTenantPolicy } from "../../src/guardian/upstream-policy.js";
import { markedUpstreamPolicy } from "../support/tenant-policy.js";

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

  it("fills a commented policy exactly as the same policy without the comment", () => {
    const commented = `<!--\nNotice for readers.\n-->\n\n${markedUpstreamPolicy}`;
    expect(withTenantPolicy(commented, "TENANT")).toBe(
      withTenantPolicy(markedUpstreamPolicy, "TENANT"),
    );
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
