import { Data } from "effect";

const tenantPolicySlot = "{{ tenant_policy_config }}";

/** The upstream Guardian policy has no single slot for Pomerado's policy. */
export class UpstreamPolicySlotInvalid extends Data.TaggedError("UpstreamPolicySlotInvalid")<{
  readonly slots: number;
}> {
  override get message() {
    return `The upstream Guardian policy must contain ${tenantPolicySlot} exactly once; it contains it ${this.slots} times`;
  }
}

/**
 * Puts Pomerado's policy in the upstream policy's one slot. An adapter calls it when it is built,
 * so a policy file without the slot stops startup instead of Guardian reviewing without
 * Pomerado's policy.
 */
export const withTenantPolicy = (upstreamPolicy: string, tenantPolicy: string): string => {
  const slots = upstreamPolicy.split(tenantPolicySlot).length - 1;
  if (slots !== 1) throw new UpstreamPolicySlotInvalid({ slots });
  return upstreamPolicy.replace(tenantPolicySlot, tenantPolicy);
};
