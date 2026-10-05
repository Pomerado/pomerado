// This deliberately small, reviewed original v1 lexicon covers common English UI,
// function, and status values plus frequently encountered currency codes. It is
// not intended to approximate a complete English dictionary.
const commonSecretValuesV1 = new Set([
  "accept",
  "accepted",
  "account",
  "active",
  "add",
  "added",
  "admin",
  "all",
  "allow",
  "allowed",
  "apply",
  "approve",
  "approved",
  "aud",
  "available",
  "back",
  "brl",
  "cad",
  "cancel",
  "cancelled",
  "chf",
  "choose",
  "clear",
  "close",
  "closed",
  "cny",
  "complete",
  "completed",
  "confirm",
  "confirmed",
  "continue",
  "create",
  "created",
  "current",
  "default",
  "delete",
  "deleted",
  "disable",
  "disabled",
  "dkk",
  "done",
  "edit",
  "empty",
  "enable",
  "enabled",
  "error",
  "eur",
  "example",
  "expired",
  "fail",
  "failed",
  "finish",
  "finished",
  "gbp",
  "get",
  "help",
  "hkd",
  "home",
  "inr",
  "jpy",
  "krw",
  "list",
  "load",
  "loaded",
  "login",
  "logout",
  "menu",
  "mxn",
  "name",
  "new",
  "next",
  "no",
  "none",
  "nok",
  "nzd",
  "ok",
  "open",
  "password",
  "pending",
  "post",
  "previous",
  "read",
  "ready",
  "remove",
  "removed",
  "reset",
  "retry",
  "save",
  "saved",
  "search",
  "sek",
  "select",
  "send",
  "sent",
  "sgd",
  "start",
  "started",
  "status",
  "stop",
  "stopped",
  "submit",
  "success",
  "successful",
  "update",
  "updated",
  "usd",
  "user",
  "username",
  "view",
  "yes",
  "zar",
]);

const asciiCaseFold = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Exact whole-value membership with ASCII case folding only. */
export const isCommonSecretValue = (value: string): boolean =>
  commonSecretValuesV1.has(asciiCaseFold(value));

/** Automatic web discovery keeps these ubiquitous flags scoped to their field. */
export const isDiscoveredWebFlag = (value: string): boolean => /^(?:0|1|true|false)$/i.test(value);

/** Values that discovery must redact in-place without making global matchers. */
const isContextualDiscoveredSecretValue = (value: string): boolean =>
  isDiscoveredWebFlag(value) || isCommonSecretValue(value);

/**
 * Long, mixed values such as session identifiers. Matching them wherever they reappear cannot
 * hide ordinary words, flags, counts or timestamps.
 */
export const isOpaqueCredentialValue = (value: string): boolean =>
  value.length >= 12 &&
  !/\s/.test(value) &&
  !isContextualDiscoveredSecretValue(value) &&
  ((/[0-9]/.test(value) && /[A-Za-z]/.test(value)) || value.length >= 24);
