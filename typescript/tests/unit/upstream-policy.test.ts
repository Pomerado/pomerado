import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UpstreamPolicySlotInvalid, withTenantPolicy } from "../../src/guardian/upstream-policy.js";
import { markedUpstreamPolicy } from "../support/tenant-policy.js";

const slot = "{{ tenant_policy_config }}";
// sha256 of upstream-policy.md before the notice was added. A deliberate policy edit updates it.
const policyBodySha256 = "bf072035fd6233158822b23d95a8037a8fc85324c5d57254dbbbbfc30c2fd352";
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
