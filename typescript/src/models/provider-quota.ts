const spentQuotaCodes = new Set<unknown>(["insufficient_quota", "credit_balance_exhausted"]);

/** The provider's error code says the account's quota or billing limit is spent. */
export const spentQuotaCode = (code: unknown): boolean => spentQuotaCodes.has(code);

/**
 * The provider refused a model call because the account's quota or billing limit is spent: a 429
 * that waiting does not clear. Found on the provider's error or on a cause beneath an SDK wrapper.
 */
export const providerQuotaExhausted = (error: unknown, depth = 0): boolean =>
  depth <= 8 &&
  error !== null &&
  typeof error === "object" &&
  (spentQuotaCode(Reflect.get(error, "code")) ||
    providerQuotaExhausted(Reflect.get(error, "cause"), depth + 1));
