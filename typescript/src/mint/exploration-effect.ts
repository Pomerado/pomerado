// The host's read grant, kept apart from the review context so Guardian's review can name it
// without importing the mint modules that import Guardian.

/**
 * What Guardian may approve for an anonymous read or exploration. Opening the public sign-in
 * page, including the site's own redirects to its sign-in origin and its own sign-in link or
 * button, is discovery; entering or submitting any credential is the host-owned sign-in step,
 * never authored exploration. After the host signed in, a context step that asks for no
 * credential and verifies no one, such as choosing a company, is navigation. A read keeps the
 * limits the request states; context it gives, such as today's date, is no filter.
 */
export const explorationAllowedEffect =
  "Authorized repeatable reads, navigation, observation and transient search/query interactions, including query submission when its read semantics are established. Respect constraints the request states, such as a date range, filter, sort or limit. Context it gives, such as the current date or the caller's location, is not a constraint unless the request applies it. Navigating to and observing the site's public sign-in pages, including the site's own redirects to its sign-in origin, is allowed. Clicking the site's own sign-in link or button to open its sign-in screen or dialog is navigation, even when the page says results need a login. Entering or submitting a username, email, phone number, password or code, submitting a sign-in step, or switching to a different login is not: credential submission belongs only to the host-owned authenticate step. After the host has signed in, entering the caller's own input into a context step that asks for no username, email, phone number, password, code, date of birth, ZIP or security answer and does not verify who the user is, such as choosing a supplier, company, client or language, and continuing past it is navigation, not a sign-in step or a switch to a different login. No autosave, holds, drafts, uploads, business commitments, account changes or other writes, even for exploration/test setup.";
