import { getDomain } from "tldts";

/** Registrable domain (eTLD+1, private suffixes such as github.io included), or null. */
const registrableDomain = (hostname: string) => getDomain(hostname, { allowPrivateDomains: true });

/** Registrable domain, else the host. */
const siteOf = (hostname: string) => registrableDomain(hostname) ?? hostname;

/** Whether two hosts share a registrable domain, or are the same host when either has none. */
export const sameRegistrableDomain = (left: string, right: string) =>
  siteOf(left) === siteOf(right);

/**
 * The registrable domain whose HTTPS hosts `sameSite` accepts for an exact HTTPS site origin.
 * Undefined for any other origin text and for a host with no registrable domain (an IP address,
 * localhost or a bare public suffix such as github.io), whose site is only its own host.
 */
export const siteDomain = (siteOrigin: string): string | undefined => {
  const url = URL.parse(siteOrigin);
  if (url === null || url.protocol !== "https:" || url.origin !== siteOrigin) return undefined;
  return registrableDomain(url.hostname) ?? undefined;
};

/**
 * Same registrable domain as the authorized HTTPS site: apex, www and sibling subdomains. The site's
 * own registrable domain is always allowed, sign-in included.
 */
export const sameSite = (authorizedSiteOrigin: string | undefined, url: URL) => {
  if (authorizedSiteOrigin === undefined || url.protocol !== "https:") return false;
  try {
    const authorized = new URL(authorizedSiteOrigin);
    return (
      authorized.protocol === "https:" &&
      authorized.origin === authorizedSiteOrigin &&
      siteOf(authorized.hostname) === siteOf(url.hostname)
    );
    // error-reporting-allow: parse-predicate an authorized origin that does not parse is not the same site
  } catch {
    return false;
  }
};

/**
 * Whether a URL is on the site or one of its configured sign-in origins, with no user name or
 * password in it: where the host types a sign-in's values.
 */
export const trustedUrl = (
  siteOrigin: string,
  authenticationOrigins: readonly string[],
  value: string,
) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    (authenticationOrigins.includes(url.origin) || sameSite(siteOrigin, url))
  );
};
