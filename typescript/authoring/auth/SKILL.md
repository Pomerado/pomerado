---
name: auth
description: Discover an evidenced login entry and sign in screen by screen with verified host autofill.
---

# Sign in on this site

On this site the host signs in inside the browser you are already using. You find each sign-in
screen's fields and its submit control, and the host fills them from the private login and clicks
the submit. You never see, type, request or read back a credential. Start with a `signInStep` for
the first screen. If a step fails, inspect the site and correct the steps in this browser.

A code the site sends as part of signing in, by text message, email or an authenticator app, is
part of the sign-in: map its screen as a `signInStep` with a `code` field and let `authenticate`
get the code. Never ask for it separately with `request_input`. A `request_input` secret question
for a code is only for a later protected action after sign-in, when the site asks for another code
to confirm it.

Sign in only when the task needs it (the request asks, the task is about the caller's own account,
or the data sits behind a login wall). Try a public task signed out first.

# The login URL you record

<!-- pomerado:section auth.login-url -->

- a URL carrying one-time values: `state`, `nonce`, `code_challenge`, `code`, `session_state`,
  `SAMLRequest`, or a signed token or opaque random value in its query or fragment;
- an identity provider's authorize endpoint (`/authorize`, `/oauth2/…/authorize`,
  `/as/authorization.oauth2`, `/protocol/openid-connect/auth`), even on the site's own domain.

Such a URL was made for one sign-in; a run that replays it starts from spent values.

Read a login link's `href` before you click it. A simple login route often redirects through an
identity provider and lands on an authorize URL with one-time parameters: record the route you
clicked, not the page you landed on.

# Discover the entry before authenticating

1. Submit a bounded, anonymous, read-only `explore` with target `liveBrowser` on the authorized site
   (any https host on its registrable domain). Before sign-in this probe gets no private value.
2. Follow the site's actual unique member-login entry from its links, buttons and frames. Do not
   guess `/login`, hardcode a remembered SSO domain, or click `.first()` of a broad match such as
   `/sign in|log in/i`. Use a visible, container-scoped role locator, confirm it is unique, and tell
   member login from provider or employer login, registration and password reset by evidence.
   Read the chosen link's `href` before the click: it is usually the login route to record.
3. Check that the page is on the site before one click that only opens the login page. A sign-in on
   the site's own registrable domain needs no permission; another site's is checked by the host.
4. Read the first sign-in screen, the first step whose form signs in with a username, email,
   phone-number, account-number, password, code, date-of-birth, ZIP or recovery-code field,
   including an identifier-only first step. Its fields for the first `signInStep` come from a
   read-only probe of that screen: wait for its controls, then return each visible field's label,
   type, placeholder, id and name, never its value, and the visible buttons, frames, the URL and
   the form actions. Never type, fill or select into its fields, press keys in them, or click its
   submit, Next, Continue or send-code control during exploration: that is signing in, which only
   `authenticate` does (the one exception, after the host's own submit click failed, is below).
   Other controls on the page, such as a site search or a cookie banner, are not the sign-in.
   After a failed sign-in, reopening the login route in an `explore` to read it again is fine.
   `references/auth-entry.ts` shows a bounded second probe that reads a login form's controls.

When the entry offers mutually exclusive account or plan types, or sign-in methods, decide before
clicking one: take the branch only when the request or input names or clearly implies it, otherwise
ask with `request_input` right away. A preselected option says nothing about the caller.

# One screen at a time

<!-- pomerado:section auth.signed-out-flow -->

Record a field only after observing its unique visible enabled match in the intended frame and
form, and a submit after observing its unique visible match there, even one the page enables only
once the fields hold input. Validate the complete live login and a fresh signed-out replay from
the stable login URL. A saved DOM supports locator matching and extraction; it cannot prove live
controls are actionable, their event handlers work or authentication succeeds.

<!-- pomerado:section auth.partial-flow -->

Call `execute` with purpose `authenticate`, target `liveBrowser` and a `signInStep` for the screen in
front of you. Pass the stable route you clicked as `loginUrl` on the first one (above), never the
page it redirected to; runs open that route to replay your screens.

Security questions can change between screens and visits. Inspect the current question and its
answer control each time, then record the observed field through the same `signInStep` mechanism.
Never assume a fixed challenge stage or put question text or an answer into a recipe.

Use `slot: "private_answer"` for each observed security-question answer field. When the actual
question has one visible match in that field's frame, supply its stable `questionSelector`, never
its text. The host rereads the question before privately filling the answer. No answer reaches
you, Guardian, generated code or the recipe. One-time and recovery codes keep their own slots.

<!-- pomerado:section auth.step-fields -->

A screen may record `rejectedMarkers`, each with a field slot and an observed, value-free
rejection selector. The slots are `username`, `email`, `phone`, `account_number`, `password`,
`code`, `date_of_birth`, `zip` and `recovery_code`. Record every rejection visible during ordinary
sign-in; never invent a marker or submit bad credentials to discover one. The host reads only
visibility and retains every rejected value so it cannot send that value again.
`private_answer` has no recorded rejection marker or automatic correction: when the site rejects
an answer, inspect the question screen and stop rather than resending the same answer. A host
refusal with cause `question_changed` is not the site's rejection: nothing was typed, so read the
screen again and send its step, and the owner is asked the question it shows now.
Do not mark sign-in complete while a recorded answer or verification field is still visible,
including one inside a provider frame. Account search, support and security-settings forms are
not sign-in evidence. Inspect and record each new authentication screen before checking completion.
The host checks the challenge fields recorded since the last check that showed the site signed in.
One counts only while the same control shows and takes typing, on the site or a configured sign-in
origin: the label, accessible name and placeholder it had when you recorded it name it again, with
the same name and id where it had them. Another control your selector also matches, such as a
gift-card or promo code box, does not count. It does not classify unrecorded forms by their names or
page route. A successful host check does not replace inspecting the current screen and verifying
authenticated access.

<!-- pomerado:section auth.code-rejection -->

Guardian checks each step against the screen: that every field takes the kinds it lists, that the
submit is the right sign-in action, including a fieldless continuation or verification-method
choice, and that a step without one advances by itself. The host checks that each control is unique
and visible and that its frame, form actions and link destination are on the site or a configured
sign-in origin. A refused step typed and sent nothing and spends no sign-in: fix it from the evidence.

Sign-in pages are often slow, and the next screen can take a while to show. Wait for its field with
a bounded readiness wait (such as `locator.waitFor` with a timeout of about 30 seconds) before you
map or fill it, and read the page again.<!-- pomerado:section auth.slow-screens -->

After a step whose submit the host clicked, its result names `captures/after-submit/<step>.json`
(`nextScreen`), where the host saved the next screen's controls: role, name or label, input type,
and whether each is required, visible and enabled, never a value. Read it with `read_source` first
to see what the screen asks for. A step that did not resolve shows the last saved controls inline
(`lastScreen`), at most 30, and the file holds the rest.
Then read what the file lacks, such as a selector or form destination, with a read-only `explore`. Never read, change or return a field
the host filled, not even to check it. If the host reports that its click of the submit failed after
the fields filled, you may click that one submit yourself in an `explore`, and nothing else; the host
counts a value as sent only once it sees the form go out carrying it, whoever clicked. If it reports `submit: refused`, never click it.
If the site says a field was wrong, send `signInStep: { rejected: { slot: "password" } }`
with the actual rejected slot at once. The host asks for corrections; never ask for substitute
credentials yourself or send a rejected value again.<!-- pomerado:section auth.next-screen -->

A rejected code permits at most two fresh-code corrections within the remaining sign-in time.
This does not extend the unchanged password's limit of two sends, including sends before worker
takeover. If a further known code correction would need a third unchanged-password send, the host
ends with `credentials_rejected` for `code`. Only an actually fresh accepted password begins a new
password-send allowance within this sign-in; correcting the primary identifier while retaining
the password does not. Correction counters and rejected-value history persist.

A fill is not a write: when the next screen shows a step did not go through (the same screen with
no rejection message, or a page error), send that `signInStep` again after inspecting why it failed.
The host counts a send once its click ran, its answer was lost or a form carried the value, and
refuses a third unchanged-password send.

Flows vary. A login may be passwordless (identifier, then a code or a link), ask for a code after the
password, offer several code methods, or ask you to approve on another device. Record every screen
the sign-in shows, a code screen included: the tool's runs replay only the screens you recorded and
never look for another, so a run that meets a screen you did not record requests sign-in repair.
When an observed screen asks the caller to follow an email link or approve on another device,
submit `signInStep: { approval: "email_link" }` or `{ approval: "device" }`, with the same popup
relation if that screen is in the popup. The host asks the caller through a protected confirmation
after the identifier was submitted. Never ask an ordinary question for this approval or request
the link, code or device contents. After confirmation, explore the account page and submit its
signed-in indicator; confirmation alone does not verify the session.

# Signed in

<!-- pomerado:section auth.signed-in-evidence:start
Prefer an observed protected account page or authenticated workflow control that the signed-out
flow cannot reach, corroborated by the live business example. Generic Sign out or account chrome
alone does not establish access to the caller's workflow. The signed-in marker you send is a
separate check, of presence only (below): for it, a site-wide account menu or sign-out control is
the right choice once `check_signed_in_marker` shows that the signed-out page lacks it.
pomerado:section auth.signed-in-evidence:end -->

# Popup sign-in

When the site's entry opens a separate authentication popup, map its controls without reading
values. Name `popup: { opener: "primary", origin: "https://the-observed-origin" }` on each step
in that popup. The host verifies the actual opener relation and exactly one matching popup;
zero or multiple matches type nothing. Record the origin from the observed popup, including its
port when present, never a browser target ID or tab index. An opener button that opens the popup
is its own step with no fields and its observed `submit`.

Keep the site's original page as the primary page. After the popup closes, inspect the opener
and submit its own signed-in indicator. Popup closure alone proves nothing. If a popup is missing
or ambiguous, inspect the tabs and correct the flow before sending another step.

# When a step cannot sign in

Inspect the current page read-only, wait for the observed screen, and correct the step from its
controls and submit destination. Browser recovery may help when the evidence points at the
browser. A failed host check leaves this browser available for another evidenced step; report
that sign-in could not be verified when the site or the remaining allowance prevents recovery.
Never send a visibly rejected value again. There is no provider-login fallback.

When the host refuses to type into a field (`AutofillRefused`), its answer names the field, the
check that refused it and why. Fix that cause before sending the step again: the same refusal of
the same field on the same screen three times in a row ends sign-in in this build.

<!-- pomerado:section auth.after-recovery -->

# Every sign-in ends with its check

<!-- pomerado:section auth.sign-in-check:start
End every sign-in with a check that it worked, sent as `signInStep.signedIn`: an observed
signed-in marker that every signed-in account shows and a signed-out page never does. Never use an
account's name, email or number as the marker.

The marker is checked in many places across the site, not only where this sign-in lands: after
every reset, at the start of every operation, after a page load in the middle of a script, and on
whatever page a failure lands on. So choose a site-wide element only a signed-in user sees, such as
the global header's account menu or sign-out control, never something only the page after sign-in
shows. It must show on any signed-in page, not only on `openPath`.

- Prefer stable attributes and names, such as `aria-label`, a role and its name, visible text or a
  test id, over generated class names such as `css-1q2w3e`.
- Never send a `urlPath` alone on a single-page app, or for a page the site also serves signed out:
  the path stays the same when the session is gone. Never use the login page's path.
- Test the marker with `check_signed_in_marker` before you send it, and choose another until every
  check passes: absent on the signed-out page the host saw before the sign-in, and present on the
  signed-in page now, after a fresh load and on another page you visited signed in. The host
  refuses a marker that the signed-out page shows. When the tool reports the check unavailable,
  or passed with the signed-out page unchecked, compare it yourself against the signed-out pages
  you explored before signing in.

For example, after sign-in the header shows an "Account" link, which the signed-out header shows
too, and an account menu button, which it does not. `{ "selector": "text=Account" }` matches the
signed-out page and is refused. `{ "selector": "header [aria-label=\"Account menu\"]" }` passes
every check, and is the marker to send.
pomerado:section auth.sign-in-check:end -->

## A sign-in refusal found by operation code

An operation may find a field-specific refusal after the host's sign-in setup. Use an error marker observed during normal authorized sign-in; never submit deliberately bad credentials to invent a marker. Call `await rejectedSignIn({ field: "password", selector: observedPasswordErrorSelector })` on the authorized page. The helper reads only boolean locator visibility: a visible marker throws `errors.CredentialsRejected(field)`, an absent marker returns, and unavailable or malformed inspection throws `OperationFailure` with its cause. When operation code already observed the specific refusal, it may instead throw `new errors.CredentialsRejected(field)` directly. Pass only the finite field kind, never a credential value or error text.

The caller receives `credentials_rejected` and `rejected_field`; this requests no repair. Preserve every named commit mark. A write whose commit may have been sent still returns `outcome_unknown` with `possible_commit`; read back its outcome before any retry. A refusal before any declared commit step was entered stays rejected without a possible commit.

## Staying signed in during an operation

Some sites keep their session only in the page, so a full page load signs them out. The runtime
calls `ensureSignedIn()` once before your operation code runs, so every signed-in operation starts
signed in. After that, call `const { signedInAgain } = await ensureSignedIn()` after each full page
load in the middle of the script: a `page.goto`, a reload, or a click or submit that loads a new
document. In-page navigation in a single-page app needs no call. The host checks the signed-in
marker on the current page without moving it and signs in again only when the page is signed out.
When `signedInAgain` is true, the sign-in left the page somewhere else: open the page you were on
again before you go on. The host signs in on the same browser while your script waits in
`ensureSignedIn`, and the operation's deadline pauses meanwhile. Any other browser call the script
makes during that time, even from a timer or a promise it never awaited, is held until the host is
done, then sent in order.

Never call it between a write's commit and its read-back: read the outcome back first. Let its
failure propagate. An `OperationFailure` with `sessionLoss: "session_not_kept"` means the host
could not sign in again, and the run reports that the site did not keep its session. Never catch it
to go on signed out, and never sign in from the script yourself.

# A direct sign-in request

A direct sign-in request signs in with one host-filled HTTP request instead of an autofill form submission. Runs are faster with it, so the host prefers it once a mint proves it.

<!-- pomerado:section auth.direct-request:start

## Standalone live authentication

Observe the current login screen with a reviewed read-only probe: its URL, frames, visible field labels/types/names/autocomplete, form destination and submit. Never read control values or enter credentials in source. Pass `signInStep` to execute purpose `authenticate`, target `liveBrowser`, with the evidenced reusable `loginUrl`.

Fields use the same slots and format declarations. `username` lists every accepted identifier kind; password/code/recovery-code/date-of-birth/ZIP/private-answer match that observed field's purpose. The host obtains the needed value through the caller's input callback or the terminal, checks the original field/document/origin/focus binding and inserts privately. The terminal hides a password, code or other secret as it is typed, and shows a username, email, phone number or account number. A private answer is prompted from the current `questionSelector` text when it has one visible match in the answer field's frame. When a recorded question could not be read, the prompt says so; with no `questionSelector`, it uses the field label. The answer is discarded after this fill. Supply the observed question selector when the question is adjacent to a generic answer label. No saved credential, seed or SMS automation is used. The host records the screens of a verified sign-in, without values, and publishes them with the tool; runs don't replay them yet. No value enters your model context or files.

Inspect each subsequent screen and send its observed step. After a step whose submit the host clicked, its result names `captures/after-submit/<step>.json`, where the host saved the next screen's controls: role, name or label, input type, and whether each is required, visible and enabled, never a value. Read it first to see what the screen asks for, then probe read-only only for what it lacks, such as a selector or form destination. A failed step's result shows the last saved controls inline, at most 30, and the file holds the rest. A method or account choice needs caller input before selection. Wait for and verify an observed signed-in marker; disappearance of the login form is insufficient. Rejection requires caller correction and never authorizes replay of a private submission. Popup/frame sign-in uses the observed host target and configured sign-in origins, with the same destination guard.

pomerado:section auth.direct-request:end -->
