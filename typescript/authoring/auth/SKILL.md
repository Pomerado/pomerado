---
name: auth
description: Discover an evidenced login entry and sign in screen by screen with verified host autofill.
---

# Sign in on this site

On this site the host signs in inside the browser you are already using. You find each sign-in
screen's fields and its submit control, and the host fills them from the private login and clicks
the submit. You never see, type, request or read back a credential. Start with a `signInStep` for
the first screen. If a step fails, inspect the site and correct the steps in this browser.

Sign in only when the task needs it (the request asks, the task is about the caller's own account,
or the data sits behind a login wall). Try a public task signed out first.

# The login URL you record

<!-- pomerado:hosted:start
The `loginUrl` you pass on `authenticate` is published with the tool, and every run opens it to
sign in. It must be a simple, stable route on the site: the page a person would bookmark to sign
in, or where the site's own login link points before any redirect, read from that link. Never
record:
pomerado:hosted:end -->

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

<!-- pomerado:hosted:start
Before recording, reopen the published stable `loginUrl` and map the complete signed-out flow. Reopen that
route and record the required entry navigation from there, not just the username form reached
after manual choices. Record each observed panel opener, authorized account/plan choice or
Continue control as `signInStep: { fields: [], submit: "the-observed-selector" }`. Include only
navigation needed for sign-in; exploration before the login URL and Business account actions,
registration and password reset do not belong in the recipe.
pomerado:hosted:end -->

Record a field or submit only after observing its unique visible enabled match in the intended
frame and form. Validate the complete live login and a fresh signed-out replay from the stable
login URL. A saved DOM supports locator matching and extraction; it cannot prove live controls
are actionable, their event handlers work or authentication succeeds.

<!-- pomerado:hosted:start
A run can begin partway through that flow because its bound profile or remembered device omitted
an earlier stage. The host acts only on the observed recorded screen. It skips an earlier stage
only when a later recorded page or distinct credential fields prove progression, or the published
signed-in check verifies the session. A missing control, a timeout or a coincident Continue button
on the same page does not prove an account choice happened. Record an authorized choice and its
following Continue as separate steps.
pomerado:hosted:end -->

Call `execute` with purpose `authenticate`, target `liveBrowser` and a `signInStep` for the screen in
front of you. Pass the stable route you clicked as `loginUrl` on the first one (above), never the
page it redirected to; runs open that route to replay your screens.

<!-- pomerado:hosted:start
- `fields`: each field the screen asks for, as a Playwright selector with exactly one visible match.
  A selector never reaches into another frame (no `>>` chains or `internal:` engines): the host finds
  each field in its own frame.
  - An identifier field lists every kind it accepts in `accepts`, from `username`, `email`,
    `phone` and `account_number`: a "username or email" field is `["username", "email"]`, an
    email-only field `["email"]`, a mobile-number field `["phone"]`, an account, member or customer
    number field `["account_number"]`. Read the label, type and placeholder. The host sends a kind
    the login holds (username first, then email, phone and account number) or asks the caller once
    for one it accepts. If it refuses the step as `identifier_conflict`, the answer was not this login's: send
    the step again to ask again.
  - `slot: "password"` for the password.
  - `slot: "code"` for a one-time or authenticator code. A saved authenticator seed answers it;
    otherwise the host asks the caller for the code. Never ask for a code yourself.
  - `slot: "date_of_birth"` for a date of birth, with `format`, how the field takes it, read from
    its placeholder, label, input mask or hint: `MM/DD/YYYY`, `DD/MM/YYYY`, `M/D/YYYY`,
    `D/M/YYYY`, `MM-DD-YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`, `YYYY/MM/DD`, `MMDDYYYY`,
    `DDMMYYYY` or `YYYYMMDD`. A native date input (`type="date"`) is `YYYY-MM-DD`. A date split into
    a month, a day and a year is one field per part, each with its part's format: `MM` or `M` for a
    month by number, `MMM` or `MMMM` for a month by its short or full name, `DD` or `D` for the day,
    `YYYY` or `YY` for the year. A part may be a text box, a select or a custom dropdown: name the
    select, or the dropdown's own control (its combobox or the button that opens its list), never
    an option. The host fills the saved date into whatever control it finds, choosing the option
    whose label or value matches, and records the format and the control's shape with the tool,
    never the date. Every date layout, dropdowns included, is a screen you map.
  - `slot: "zip"` for a ZIP or postal code the site checks to prove the account.
  - `slot: "recovery_code"` for a backup or recovery code field. The host fills a saved one only
    while recovery codes are the method in force, else asks the caller. Never ask for one yourself.
  - `slot: "private_answer"` for a security question or other private answer requested during
    sign-in. Name each observed answer field, never an answer in a selector. The host asks the
    caller separately for every field using its current label, then fills each once through the
    protected sign-in path. A later run asks again; answers are never saved in the login or
    recipe. Never submit them through generated browser code.
- `submit`: the observed enabled control that submits those fields or advances this sign-in screen
  ("Next", "Continue", "Sign in"). It may be a native button, a submit/button/image input, an HTML
  anchor or a custom ARIA action: use its evidenced role, label or stable selector and purpose.
  The host clicks it. A screen that advances by itself (the identifier fills and the password field
  appears by itself) names none; unrelated links or buttons on that page do not need a submit.
  A two-factor method choice ("Text me a code", "Use my authenticator app") fills no field: list
  every method the screen offers in `methods` (`sms`, `call`, `email`, `totp`, `push` or
  `recovery_code` for "use a backup code", each with
  the selector of the control that picks it) and name the one to pick now as `submit`, once the
  branch rule above settles which. The tool's runs pick again from that list. A method's selector
  publishes with the tool, so it never names the masked phone number or address the option shows
  (such as `***-1234`): use the method's own words or a stable attribute.
- Every selector and submit you send publishes with the tool, as does each screen's page address.
  None may name this account's username, email or phone: not a "Continue as …" button's text, a
  data attribute holding it, or a placeholder for it. Name a control by its role, label or a stable
  attribute. The host refuses a step that names it (`selector_names_contact`), and a screen whose
  address names it (`page_names_contact`) is refused; use an account-independent route.
pomerado:hosted:end -->

A screen may record `rejectedMarkers`, each with a field slot and an observed, value-free
rejection selector. The slots are `username`, `email`, `phone`, `account_number`, `password`,
`code`, `date_of_birth`, `zip` and `recovery_code`. Record every rejection visible during ordinary
sign-in; never invent a marker or submit bad credentials to discover one. The host reads only
visibility and retains every rejected value so it cannot send that value again.
`private_answer` has no recorded rejection marker or automatic correction: inspect a refused
question screen and stop rather than resending the same answer.
Do not mark sign-in complete while a recorded answer or verification field is still visible,
including one inside a provider frame. Account search, support and security-settings forms are
not sign-in evidence. Inspect and record each new authentication screen before checking completion.
The host checks recorded challenge fields and also recognizes some authentication routes. It cannot
distinguish an unrecorded challenge on an ordinary account page from a security-settings form; a
successful host check does not replace inspecting the screen and verifying authenticated access.

<!-- pomerado:hosted:start
On a combined password-and-code screen that returns empty, an explicit code rejection permits a
fresh code with the unchanged password only while its two-send allowance remains. When the
password remains in its field, retry only the fresh code. In a recorded replay, missing or
ambiguous evidence about which field was rejected requests maintenance without resending the
password. Report a rejection visible in the current mint even if no selector has been recorded
yet; a visible recorded marker takes precedence over that report.
pomerado:hosted:end -->

Guardian checks each step against the screen: that every field takes the kinds it lists, that the
submit is the right sign-in action, including a fieldless continuation or verification-method
choice, and that a step without one advances by itself. The host checks that each control is unique
and visible and that its frame, form actions and link destination are on the site or a configured
sign-in origin. A refused step typed and sent nothing and spends no sign-in: fix it from the evidence.

<!-- pomerado:hosted:start
Sign-in pages are often slow, and the next screen can take a while to show. Wait for its field with
a bounded readiness wait (such as `locator.waitFor` with a timeout of about 30 seconds) before you
map or fill it, and read the page again. Ask for a new browser with `request_browser_recovery` only
after a reasonable wait still found nothing and the evidence points at the browser.
pomerado:hosted:end -->

<!-- pomerado:hosted:start
After each step, read the next screen with a read-only `explore`. Never read, change or return a field
the host filled, not even to check it. If the host reports that its click of the submit failed after
the fields filled, you may click that one submit yourself in an `explore`, and nothing else; the host
counts a value as sent only once it sees the form go out carrying it, whoever clicked. If it reports `submit: refused`, never click it.
If the site says a field was wrong, send `signInStep: { rejected: { slot: "password" } }`
with the actual rejected slot at once. The host asks for corrections; never ask for substitute
credentials yourself or send a rejected value again. A primary identifier or password rejection
asks for both username and password. A rejected secondary identifier, date of birth or ZIP asks
only for that field; a recovery code uses the host's fresh-code ledger or question. The host allows
at most two correction questions per rejected field per sign-in. Only submitted, visibly rejected
fields consume their counters; `username` and the saved login's matching primary identifier share one
counter. Worker takeover preserves these counters and rejected-value history.
pomerado:hosted:end -->

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

<!-- pomerado:hosted:start
Prefer an observed protected business/account page or authenticated workflow control that the
signed-out flow cannot reach, corroborated by the live business example. Generic Sign out or
account chrome alone does not establish access to the caller's workflow. Call `authenticate`
with `signInStep: { signedIn: { selector } }` (or `urlPath`, the observed signed-in page's path).
When the landing page shows no such evidence, add `openPath`, the observed path of an account page
that does, and the host opens it and checks there; never guess a protected route. The host checks
that the submitted sign-in's recorded controls/form no longer show a password entry awaiting
sign-in, and that its recorded answer or verification fields are no longer visible; unrelated
account forms do not fail this check. It also checks
that this sign-in submitted the login's identifier with its password, code or protected approval,
then marks it verified; a Personal login locks to this site then. The indicator is part of the
published tool: runs check it after they sign in. Business work waits for a verified sign-in.
pomerado:hosted:end -->

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

<!-- pomerado:hosted:start
After browser recovery, inspect the retained bound profile before signing in. When its published
signed-in indicator verifies the identity, continue without another credential submission. When
it is signed out, sign in from the observed recorded stage on that profile, preserving what the
site remembers; do not clear storage or log out merely to force the full flow. A genuinely empty
profile starts the observed fresh sign-in flow.
pomerado:hosted:end -->

# Every sign-in ends with its check

<!-- pomerado:hosted:start
Every sign-in you record ends with a deterministic sign-in check, sent as `signInStep.signedIn`:
a signed-in marker on the page the sign-in lands on (a selector, or the signed-in page's path), or,
when that page shows none, an account page with `openPath` and the marker to check there. Choose a
marker that every signed-in account shows and a signed-out page never does. Prefer an observed
protected page or authenticated workflow control, corroborated by the live business example;
generic Sign out or account chrome alone is insufficient. Never put an account's name, email or
number in the marker: the check publishes with the tool and runs for every login, and the host
refuses one that names this account. This strengthens the observed workflow evidence without
adding a separate identity detector or guessing a protected route. The published
tool records the check with its screens, and each run decides whether its sign-in worked by that
check alone: a run whose check fails requests sign-in repair before its operation.
pomerado:hosted:end -->

## A sign-in refusal found by operation code

An operation may find a field-specific refusal after the host's sign-in setup. Use an error marker observed during normal authorized sign-in; never submit deliberately bad credentials to invent a marker. Call `await rejectedSignIn({ field: "password", selector: observedPasswordErrorSelector })` on the authorized page. The helper reads only boolean locator visibility: a visible marker throws `errors.CredentialsRejected(field)`, an absent marker returns, and unavailable or malformed inspection throws `OperationFailure` with its cause. When operation code already observed the specific refusal, it may instead throw `new errors.CredentialsRejected(field)` directly. Pass only the finite field kind, never a credential value or error text.

The caller receives `credentials_rejected` and `rejected_field`; this requests no repair. Preserve every named commit mark. A write whose commit may have been sent still returns `outcome_unknown` with `possible_commit`; read back its outcome before any retry. A refusal before any declared commit step was entered stays rejected without a possible commit.

# A direct sign-in request

A direct sign-in request signs in with one host-filled HTTP request instead of an autofill form submission. Runs are faster with it, so the host prefers it once a mint proves it.

<!-- pomerado:hosted:start
1. From the explored login page, find what the form actually submits: its action, or the
   request the page script sends (method, path, content type, field names, and any CSRF
   field or header). Read the login page's HTML and scripts in the capture. Never submit
   the form yourself. A staged form with a separate identifier submission is not a
   single direct sign-in request. Omit this optional template and map the autofill screens.
2. Author `src/website-auth-http.json`, for example:
   `{"preload":"/login","request":{"method":"POST","url":"/api/login","headers":{"content-type":"application/json","x-csrf-token":"{{cookie.csrf_token}}"},"body":"{\"username\":\"{{identifier}}\",\"password\":\"{{password}}\"}"},"acceptedStatuses":[200]}`
   - URLs are paths on the site, or an https URL on an approved sign-in origin. `preload`
     loads a page first, so anti-bot and CSRF cookies are set before the request.
   - It holds placeholders, never values: `{{identifier}}`, `{{password}}`, `{{code}}` (a
     one-time code the host asks the user for), and `{{cookie.NAME}}` or `{{input.NAME}}`
     for this sign-in's own CSRF values, read after the preload. The host fills them;
     generated code never sees them. Never write a literal token or credential.
   - If a vendor computes a per-request sensor payload in page JavaScript, a direct
     request isn't possible. Omit the file.
3. Call `execute` with purpose `authenticate`, target `liveBrowser` and the authored operation
   entrypoint, without `signInStep`, to run this explicit host-filled template. The host validates
   it before sending. An accepted status verifies the sign-in, and the receipt reports `method:
"direct"`. A failure returns control without another credential submission. Inspect the
   response and login page, then correct the template or use the evidenced autofill screens.
   A visibly rejected password is corrected through the host; never resend it yourself.
4. Publication includes the template only when this mint signed in with the same file and the
   business example then completed. A registered run's failed direct request requests sign-in
   repair before its operation. Until repaired, later calls use the verified autofill recipe.
   The host manages the resulting session and tokens; callers never hold them.

pomerado:hosted:end --><!-- pomerado:standalone:start

## Standalone live authentication

Observe the current login screen with a reviewed read-only probe: its URL, frames, visible field labels/types/names/autocomplete, form destination and enabled submit. Never read control values or enter credentials in source. Pass `signInStep` to execute purpose `authenticate`, target `liveBrowser`, with the evidenced reusable `loginUrl`.

Fields use the same slots and format declarations. `username` lists every accepted identifier kind; password/code/recovery-code/date-of-birth/ZIP/private-answer match that observed field's purpose. The host obtains the needed value through the caller's protected input callback or masked terminal, checks the original field/document/origin/focus binding and inserts privately. A private answer is prompted from the current field label and discarded after this fill. No saved credential, seed, SMS automation or recipe is used. No value enters your model context or files.

Inspect each subsequent screen and send its observed step. A method or account choice needs caller input before selection. Wait for and verify an observed signed-in marker; disappearance of the login form is insufficient. Rejection requires caller correction and never authorizes replay of a private submission. Popup/frame sign-in uses the observed host target and configured sign-in origins, with the same destination guard.

pomerado:standalone:end -->
