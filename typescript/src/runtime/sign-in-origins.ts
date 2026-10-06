import { sameSite } from "./same-site.js";

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
