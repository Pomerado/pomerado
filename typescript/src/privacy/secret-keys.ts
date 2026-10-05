import { isOpaqueCredentialValue } from "./common-values.js";

const normalizedSecretKeys = new Set([
  "accesstoken",
  "apikey",
  "authenticitytoken",
  "authorization",
  "clientsecret",
  "cookie",
  "csrf",
  "csrfmiddlewaretoken",
  "csrftoken",
  "idtoken",
  "otp",
  "passwd",
  "password",
  "proxyauthorization",
  "refreshtoken",
  "requestverificationtoken",
  "sessionid",
  "sessiontoken",
  "setcookie",
  "totp",
  "totpseed",
  "xapikey",
  "xauthtoken",
  "xcsrftoken",
  "xsrf",
  "xsrftoken",
  "xxsrftoken",
  "xaccesstoken",
  "xamzsecuritytoken",
  "privatetoken",
  "jwt",
  "authtoken",
  "oauthtoken",
  "otpcode",
  "xvercelprotectionbypass",
]);

/**
 * Loose names: a field, header, JSON key or form control named `token`,
 * `secret`, `pass` or `pin` is not masked, or its flag-like value withheld, for its name. Its value
 * is masked only by structure or as a value already known to be secret, for which the name is
 * still credential context (`isCredentialContextKey`). Gates that keep evidence out of
 * storage without masking it (a response retained for replay, a stored login URL) also still read
 * them, through `isSecretOrLooseKey`.
 */
const looseKeys = new Set(["token", "secret", "pass", "pin"]);

const normalizeSecretKey = (name: string): string => name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Exact match after removing conventional key-name separators. No substring matching. */
export const isSecretKey = (name: string): boolean =>
  normalizedSecretKeys.has(normalizeSecretKey(name));

/** A secret key or a loose name, for retention and storage gates that never mask. */
export const isSecretOrLooseKey = (name: string): boolean =>
  isSecretKey(name) || looseKeys.has(normalizeSecretKey(name));

/**
 * Names under which a value already known to be secret is recognized: secret keys, loose
 * names and username.
 */
export const isCredentialContextKey = (name: string): boolean =>
  isSecretOrLooseKey(name) || normalizeSecretKey(name) === "username";

/** Generic containers are withheld locally; concrete credential roles propagate. */
const isCredentialKey = (name: string): boolean =>
  isSecretKey(name) && !["cookie", "setcookie"].includes(normalizeSecretKey(name));

/**
 * Concrete credential names, matched as the trailing words of a key: `aws_secret_access_key`,
 * `secretAccessKey`, `X-Goog-Api-Key`, `newPassword` and `PGPASSWORD` qualify. They mirror the
 * diagnostic redactor's names (`runtime/failure-detail.ts`), except `account_key`, which is often
 * a business account identifier and counts only in an Azure connection string
 * (`credential-shapes.ts`). Generic words (`token`, `secret`, `key`, `auth`, `session`) never
 * qualify alone, and a word boundary is required, so `valid_token`, `token_type` and
 * `cookieDiscoveryMs` do not. A key whose earlier words include a UI verb (`showPassword`,
 * `forgotPassword`, `toggleApiKey`) names a label or setting, not a credential.
 */
const credentialNameWords: readonly (readonly string[])[] = [
  ["password"],
  ["passwd"],
  ["passphrase"],
  ["passcode"],
  ["client", "secret"],
  ["secret", "access", "key"],
  ["secret", "key"],
  ["security", "token"],
  ["private", "key"],
  ["api", "key"],
  ["access", "token"],
  ["refresh", "token"],
  ["id", "token"],
  ["session", "token"],
  ["auth", "token"],
  ["totp", "seed"],
  ["secret", "string"],
  ["secret", "binary"],
];

const uiVerbs = new Set([
  "show",
  "hide",
  "reveal",
  "mask",
  "unmask",
  "toggle",
  "view",
  "forgot",
  "forget",
  "reset",
  "change",
  "remember",
  "require",
  "requires",
  "required",
  "enable",
  "enabled",
  "disable",
  "disabled",
]);

const keyWords = (name: string): readonly string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

/** Results by name: structured screening asks for every key of every object in a body. */
const credentialNameCache = new Map<string, boolean>();

export const isCredentialName = (name: string): boolean => {
  const cached = credentialNameCache.get(name);
  if (cached !== undefined) return cached;
  const result = credentialName(name);
  if (name.length <= 128) {
    if (credentialNameCache.size >= 10_000) credentialNameCache.clear();
    credentialNameCache.set(name, result);
  }
  return result;
};

const credentialName = (name: string): boolean => {
  const words = keyWords(name);
  const last = words.at(-1);
  if (last === undefined) return false;
  const labelPrefix = (prefix: readonly string[]) => prefix.some((word) => uiVerbs.has(word));
  return credentialNameWords.some((expected) => {
    const [only] = expected;
    // A one-word name may carry an unseparated prefix, as in `PGPASSWORD`.
    if (expected.length === 1 && only !== undefined)
      return (
        last.endsWith(only) && !labelPrefix([...words.slice(0, -1), last.slice(0, -only.length)])
      );
    if (last === expected.join("")) return !labelPrefix(words.slice(0, -1));
    return (
      words.slice(-expected.length).join(" ") === expected.join(" ") &&
      !labelPrefix(words.slice(0, -expected.length))
    );
  });
};

/**
 * Where a discovered field value propagates. An exact concrete secret key keeps its global rule.
 * A name matched only by `isCredentialName` is masked in its own field and propagates to other
 * copies and gates only when its value is opaque, so a short value under a look-alike name cannot
 * hide ordinary words or refuse results, publications and destinations that repeat them.
 */
export const credentialFieldPropagation = (name: string, value: string): "global" | "source" =>
  isCredentialKey(name) || (isCredentialName(name) && isOpaqueCredentialValue(value))
    ? "global"
    : "source";

/**
 * Cookies are credentials. A credential-named cookie propagates everywhere; any other opaque
 * value is masked wherever readable text echoes it, without refusing results or publications
 * that repeat it (a cart id can live in a cookie). Short or common preference values stay local.
 */
export const cookiePropagation = (name: string, value: string): "global" | "readable" | "source" =>
  isCredentialKey(name) ? "global" : isOpaqueCredentialValue(value) ? "readable" : "source";

/** A name's words, lowercase: `customerAccessToken`, `x-auth-token`, `connect.sid`. */
const nameWords = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");

/**
 * A session token field an identity provider or the site returns: a name whose words end in an
 * access, refresh, id, session, auth, OAuth, bearer, private, security, CSRF or XSRF token, a JWT,
 * a session ID or SID, whatever its prefix (`customerAccessToken`, `x-auth-token`, `sessionId`,
 * `PHPSESSID`). A value discovered under one is registered as `sessionTokenEntity`, which a
 * published tool's files and metadata refuse even though it was discovered rather than supplied.
 * A public client key such as `apiKey` is none.
 */
export const isSessionTokenField = (name: string): boolean => {
  const words = nameWords(name);
  const joined = words.join("");
  const last = words.at(-1);
  return (
    /(?:access|refresh|id|session|auth|bearer|private|security|csrf|xsrf)token$/u.test(joined) ||
    /(?:jwt|sessionid|sessid)$/u.test(joined) ||
    last === "sid" ||
    last === "csrf" ||
    last === "xsrf"
  );
};

export const sessionTokenEntity = "SESSION_TOKEN";
