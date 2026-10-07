---
name: core
description: Kernel script operation SDK, mint intake, execution targets and ownership.
---

# Start here

Identify the requested operation, website/login realm, required account, business
inputs, desired result and permitted effects. A read build explores, then iterates its
script from a clean start by running its example until it works (re-running a read's
example is normal); resolve its missing choices with reads when possible. A write build
does the caller's requested task once, live (in as many write steps as it takes), then
composes its script from what happened (the `writes` skill). Ask about any choice the input leaves open; on a write, never
assume one. Credentials and sign-in codes belong to the host; never request a password,
cookie or TOTP seed in model-visible text.

Asking the caller follows `AGENTS.md` ("Try hard, then ask").

Write ordinary TypeScript or JavaScript files. Export a default Kernel script, as
described below. Import the actual canonical SDK entrypoint given in the workspace
README; do not assume an unconfigured package alias. Repository examples compile
against `typescript/src/runtime/index.ts` and show the real method signatures.

## Secret answers

A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value,
which you never see. In explore, test or `act` source, write the handle exactly as given as
the whole string passed as the value to `fill`, `type` or `pressSequentially` on a `page`
chain, or as a field of a `fetch` or `page.request` call to a literal URL on this site, inside
the code of a `kernel.browsers.playwright.execute` call, such as
`await page.getByLabel("Code").fill("{{secret.s1}}")`. The host fills in the value when it runs
that source live and masks it in what comes back; offline targets get the handle unchanged.
A handle anywhere else is refused before anything runs, naming its file and line: in a
variable or a locator held in one, joined or transformed, returned, logged, in a URL or a JSON
file, or beside code that reads the field back (`inputValue`, `evaluate`), reads its own source,
or redefines JSON, a global, a prototype or a page or Kernel method; check the result in a later
execute call. So is a handle the attempt never issued. An example and published
source never hold a handle: a value the finished tool needs at run time is a declared
`secret` question it asks with `ask` (caller-input skill).

## Kernel scripts

An operation is `defineOperation({ name, input, output }, async ({ kernel, sessionId,
siteOrigin, siteDomain, input, decideDialog, ask, waitPastChallenge, verified, remainingMs, errors }) => ...)`. Its browser
work is its own `kernel.browsers.playwright.execute(sessionId, { code, timeout_sec })`
calls. <!-- pomerado:section core.operation-shape:start
The host runs
pomerado:section core.operation-shape:end --> each `code` string as plain Playwright code on its own `page` and
answers `{ success, result, error, stderr }`. Throw
`new errors.OperationFailure(String(answer.error), { stderr: answer.stderr })` when
`success` is false or the page is not what the operation needs.

- Make one execute call per operation. Add a call only at a `decideDialog` decision, an
  `ask` for the caller's choice, after `waitPastChallenge`, where the flow could run past
  300 s, or in a composed write, which keeps one call per `act` step.
  `timeout_sec` is at most 300.
- The code cannot see your variables. Write outside values into it with `JSON.stringify`,
  and return plain JSON, never a Locator or Response.
- Start a response wait in the same call as the click that causes it, with
  `Promise.all([page.waitForResponse(...), button.click()])`. Listeners do not outlive a call.
- Do site HTTP inside the page with `page.evaluate(() => fetch(...))`. Never use
  `page.request` or a Node-side fetch<!-- pomerado:section core.execute-calls:start
.
pomerado:section core.execute-calls:end -->
- Console logs do not work. Return what you need to see.
- When a challenge appears, call `await waitPastChallenge({ ready })`. `ready` is code that
  returns true once the page is usable. It throws `ChallengeFailure` if the page stays blocked.
- Never repeat a call that may have run.
- When the site itself refuses a caller's value, such as a past date, an unknown airport code
  or a party size over its limit, throw `new errors.InvalidInput(message)` saying why. `errors`
  exists only in the script, never in a call's `code`, so when the page shows the refusal,
  return a marker such as `{ refused: "why" }` from the call and throw once it returns. The
  run then fails as the caller's input and nothing repairs the tool. A write that throws it
  before entering a commit mark reports that it changed nothing. A page, control or response
  that changed is still `OperationFailure`.
- After a write, call `verified()` just before returning, once a call has read the saved
  result back, or `verified({ confirmation: "message" })` when the site's own confirmation
  for this submission proves it. Without it the write stays a possible effect. A write
  declares which in its contract's `write`, and a write build runs as `act` steps; see
  `writes/SKILL.md` and `forms/SKILL.md`.

**The input schema.** Every caller sees the tool's input schema, so build it from the
request and the flow, never from one caller's account or example.

A value the request's text supplies, such as a code, a quantity or a choice, is the build's to
use even when the caller's structured input is empty: pass the request's values as
`exampleInput` where the host takes one (a read's example, or each write act step that needs
it), never as a build-time question. Decide from the request and the site which inputs are
required. An optional input plus a declared question the tool asks before any effect is only for
a value the request genuinely leaves open; never make a required field optional with nothing
that asks.

- The code works for every value the schema accepts. Never let the schema promise what
  the code rejects, such as a string the code throws on unless it is the example's value.
- Every value the code types, selects or fills on the site comes from the input and
  accepts what the site's field accepts. An enum lists the site's full set of options,
  never just the example's value. The example's values are one case, never limits.
- Inputs are values a caller knows, such as codes, names, dates and counts, never a
  suggestion's full display text or an internal id the caller cannot know. A closed list
  of options stays an enum of the site's options, as above. When the options come from a
  query, as in an autocomplete, typeahead or searchable combobox, the tool types the
  caller's value and picks the matching suggestion itself: an exact code or name match
  wins (an airport code picks that airport, not its city), and it throws `InvalidInput`
  only when nothing matches or several match equally.
- On a write, every choice the session met is an input: each option on the path,
  add-ons and pre-selected defaults included. Make it required when the site requires
  a choice (a fare class) and optional when it does not (a seat). An unset optional input
  keeps the page's default; an add-on, a pre-selected paid option or a saved payment is
  never left to a default, so ask about it (the writes skill).
- Never make an account-specific value (a passenger, loyalty number, saved card or
  address, account or member ID) an enum member, example or default in a public
  schema. Take it as a free-form input.
- The host's `businessInputTypes` is a value-free tree of the JSON types in the caller's
  input. Use it to pick compatible types when a credential in the input is masked; a mask
  does not mean the value was a string. It says nothing about
  required fields, array lengths, numeric bounds or future values: derive those from
  the request and reviewed evidence.
- Never hard-code a value the caller could vary: it comes from the input, never a literal
  in source, a schema default or the definition. A good tool exposes the options its
  purpose calls for, not only the ones the request names: record every optional field the
  flow offers that bears on the tool's purpose as an optional input wired to its control,
  such as cabin class (economy or first) on a flight search, even when the request never
  mentions it. Leave out controls unrelated to the purpose, such as a language switch or a
  newsletter opt-in on a search. Record such a field as an optional input whether or not
  you ask about it, since callers of the tool can set it. Ask about one the input leaves
  open only when the request's purpose clearly depends on its value, in the same batch as
  your other questions; leave the rest unset, keeping the page's default.
- When the caller input is empty (`{}`), write the tool's input from the request and the
  owner's answers, with dates normalized (10/4 is the next October 4, as `2026-10-04`), and
  pass it as `exampleInput`: on a read's example, or on each write act step that needs it. The
  first act step that passes it fixes it, and later steps repeat it unchanged or omit it. Make
  each of its keys a schema input, required where the request needs it<!-- pomerado:section core.example-input -->. An optional input plus a declared
  question is only for a value the request leaves open.
- Callers and Guardian see the JSON Schema form, so write every constraint in one it
  shows: a `Schema.filter` shows nothing, its description included, so use
  `Schema.NonEmptyString`, `pattern`, `minLength`, `Int`, `between` or `Literal`. Type every
  output field, never `Schema.Unknown`. A read publishes the schemas in its current source,
  and its example's own input and output must decode under them, so settle both before that
  example.
- Give every input and output field, nested object and array item fields included, a short
  `description` annotation saying what it is, with the unit or format where one applies:
  "Departure airport as a three-letter IATA code", "Departure date, YYYY-MM-DD". Effect's
  stock text, such as "a non empty string", is no description. Annotate the field's own
  schema, inside `Schema.optional(...)` for an optional one; a `Schema.Date` keeps it only on
  `Schema.optional(Schema.Date)` or `Schema.propertySignature(Schema.Date)`. Callers see each
  beside its name.
- Shape inputs and outputs like Pomerado's own API, so every tool reads alike: field names in
  snake_case; dates as `YYYY-MM-DD` and timestamps as ISO 8601 with an offset; money as an
  integer in minor units with an ISO 4217 `currency` beside it, such as `total_minor` 12999 and
  `currency` `"USD"`; enum values in lowercase snake_case (`"premium_economy"`); booleans named
  as statements (`refundable`, not `is_refundable_flag`); lists named in the plural; and the
  unit in the field name or its description (`duration_minutes`). Convert between these and the
  site's own formats in code.
- Give every input field one `examples` annotation value, which callers<!-- pomerado:section core.example-readers --> use to assemble a sample request: public, generic data such as a well-known airport code
  (`examples: ["SFO"]`), a date a few weeks ahead or a common product category. Never use a value
  from this session: not the caller's input, the owner's answers or anything the site showed
  this account.
- Descriptions, titles, examples and defaults are published and reviewed for private data,
  and an annotation never declares its contents public. Explain constraints without copying private input
  or unneeded numeric identifiers; for a nonnegative safe integer,
  `Schema.between(0, Number.MAX_SAFE_INTEGER, { title: "Safe integer", description:
"Nonnegative safe integer amount" })` keeps the bound with public prose. Return a
  supplied currency value from the validated input instead of embedding it in source.
  Only host-approved standard enums and origins are recognized as public.<!-- pomerado:section core.schema-coverage -->

Typed output, where the site makes it easy:
- Prefer numbers for prices, amounts and counts, with the currency or unit in its own field.
- Prefer ISO 8601 for dates and times, and minutes for durations. Type a date-only value as
  the runtime's `CalendarDate` (forms skill).
- Keep one field per fact. Split a combined line into separate fields.
- If a value does not parse cleanly, returning the site's own text is fine.

**Search results.** When the site says how its results matched, such as exact matches
against suggested or fallback items, a search tool returns that. Otherwise its description
and output say plainly that results may include the site's own suggestions.

<!-- pomerado:section core.host-ownership:start

The host owns input/output validation, deadlines, caller authority and the browser. Do not close the page.

pomerado:section core.host-ownership:end -->A newly allocated Page may start at `about:blank`; the supplied site origin does
not mean the host has navigated there. Navigate to the authorized site and wait
for a named page condition before inspecting its title or controls. Empty content
on a blank Page is not evidence about the website or its availability.

Take the site origin from the context's `siteOrigin`. If it is undefined, fail before
live navigation; offline fixtures intentionally have no live origin. Build URLs with
`new URL("/", siteOrigin).href` or an observed relative path and write them into the
code. Never embed the site's hostname or account-specific origin as a literal in
authored source, schema examples, or logs, and never replace it with `page.url()`
after a redirect. The host supplies the primary origin even when the model cannot see
it. This value does not authorize other destinations or credential submission.
The context's `siteDomain` is the site's registrable domain, which the host computed with
the public suffix list: a page is on the site when it is `https:` and its hostname is
`siteDomain` or ends with `"." + siteDomain`, and only `siteOrigin` itself is the site when
`siteDomain` is undefined. Write it into the code as you do `siteOrigin`, and never derive it
from the hostname: its last labels can be a public suffix (`co.uk`) or another tenant's
(`github.io`). `references/native-page.ts` shows the check. Use `page.evaluate`,
`locator.evaluate` or `locator.evaluateAll` when code needs browser globals such as
`document`.
For visible page text, prefer a scoped locator's `innerText`; `textContent` also
includes hidden text and script/style contents. Read embedded data separately
when it is relevant to the requested operation.
Default budgets: action, readiness and navigation 30 s. Give every Playwright
wait in the code an explicit `timeout`, and keep `timeout_sec` within `remainingMs()`.
Child waits cannot extend the outer deadline. Explicitly name observation conditions.
`domcontentloaded` is document readiness, not readiness of the requested page or
control. Initial navigation can land on a temporary verification page before the
site redirects or renders its controls. JavaScript challenges, redirects and
delayed rendering can be intermittent: a fast exploration load does not establish
that later executions will be immediately ready. Include a bounded wait for the
expected page or control even when exploration never observed a delay. Derive
that readiness condition from the intended page, not from having seen a particular
challenge. Wait for a unique operation control or page state before testing absence
or choosing a fallback. Use `locator.waitFor` or a bounded polling loop;
`count()` and `isVisible()` only observe the current instant. A ready page should
pass immediately; do not add a fixed sleep. Share one bounded navigation deadline across navigation
and first-page readiness, as in `references/navigation.ts`. Readiness polling
only observes: do not repeat `goto`, reload, login, submission or another action
inside it. Preserve site/path and account guards while waiting.
After an action that can navigate, wait for the observed destination URL when known,
then a specific destination control or page state before extracting. Keep the action,
readiness wait and extraction in the same Kernel execute call when possible. If a read
reports “Execution context was destroyed,” the action may already have succeeded.
Reacquire page/frame locators, wait for readiness and retry only the read within the
original deadline. Never repeat the click or submission as part of that recovery.
Use observed conditions, without fixed sleeps or whole-page network-idle waits.
For an unknown destination, inspect after the document transition; do not invent a
selector or repeat the action in a follow-up read.
<!-- pomerado:section core.site-origin -->After a probe reveals a challenge, inspect the retained Page in follow-up probes
and wait for the intended page/control within the existing deadline and job budget;
do not click the challenge, reload, or navigate to another route merely because
the earlier probe timed out. A new probe execution does not require new navigation.
A live example, a live read `test`, and a write session's first `act` step are
different: the host resets
the browser to the site origin before it runs,
and clears exploration cookies and site storage. A signed-in build gets back the session
saved right after sign-in instead, so a stale session shows up as a login wall that a new
sign-in fixes. That source must perform the flow from its input,
never rely on a page an exploration left open. So a read iterates from a clean start,
and re-running its example or live test is normal. A live test stays read-only. A write
session's later `act` steps continue on the page the previous step left.
If the deadline expires, report the named readiness failure and use current
screened evidence to distinguish a remaining challenge, loading and changed
layout.<!-- pomerado:section core.challenge-reference --> Do not invent a CAPTCHA bypass or replace the target with an arbitrary
first element. Resolve role and computed accessible name from observed evidence;
`searchbox` and `textbox`, and their exact names, are not interchangeable.
When a Playwright timeout names a locator, repair that wait and keep the checks that
already passed. A `DeadlineExceeded` phase of `execution` is the shared operation
deadline. Before increasing a timeout, make one bounded observation of the candidate
target count or state; increase it only when evidence shows that the correct unique
target is slow. Do not catch-and-repeat timed-out work. A click or navigation that
timed out is an uncertain transition: it may already have taken effect. Inspect the
retained page in the next probe and do not repeat the action until you know where
the page landed.

Never call `.first()` (or `.nth(0)`) on a broad text or regex match, whether to
click it or to wait for readiness: collapsed menus often hold an earlier hidden
match. Scope a role locator to its evidenced container and to visible elements,
for example `nav.getByRole("link", { name: /log in/i }).filter({ visible: true })`,
then check that exactly one element matches. When several candidates remain,
inspect them and choose by evidence such as section, accessible name and
destination before clicking or waiting. A readiness wait targets one specific
evidenced element or page state.

For a detail read, derive the destination from a schema-validated caller identifier
and a trusted origin/path template. Do not accept an arbitrary caller URL as the
target. A successful response or plausible content is insufficient: the final page's
site (any https host on the site's registrable domain), exact final path and stable page
identity must all agree with the requested identifier. Explicitly classify a detail
page, loading state, known interstitial and unsupported or mismatched page. Continue through an interstitial only when its
own stable identity matches the request and one unique continuation control belongs
to that interstitial. This exception does not include a CAPTCHA, login or unknown
challenge. Wait for the detail or proven interstitial, guard the continuation, then
wait again and recheck the final site, path and page identity before extraction. Use
typed failures for every other state; never return interstitial fields as a detail
result. `references/navigation.ts` shows this sequence in one call.

Target identity guards, effect authority and semantic completion are separate.
A dispatched click is not completed work. Missing completion after a possible
write, login or other consequential effect requires reconciliation before repeating
it. Bounded repeatable reads and transient search interactions may continue under
existing authority when source and current observations establish their semantics;
inspect state before choosing a retry or safe read reconstruction. A search/query
submission can be a read; autosave, drafts, uploads, holds and business commitments
are writes regardless of method or control names. <!-- pomerado:section core.raw-page-calls:start
Raw Page calls require host review and caller authority.

pomerado:section core.raw-page-calls:end -->Preserve the host's reported failure stage and dispatch state. Missing output or
a provider 404 does not prove that navigation, login or a previous action never
happened. A guard failure before one click says nothing about earlier actions in
that script. For a reviewed current-state inspection, check that the page is on the
site before reading the existing page, as `AGENTS.md` ("Check the page is on the site before exploring it")
shows. Prefer that retained state when usable;
reconstruct only established repeatable reads within the request's constraints.
For a repeatable read, use the exact returned failure phase to narrow the repair.
Do not replace a passed readiness condition or repeat successful setup merely
because a later extraction call timed out.
Never recreate a write or login to recover an observation. See
`references/native-page.ts` for a site-guarded read.

The tools and the files you may edit are in `AGENTS.md`. The host binds the caller's actual input/account; no tool
argument selects another account or private reference. A live read test's `testInput` is
the one input you choose, with public values only<!-- pomerado:section core.testing-reference -->. Every new
command/probe/execution gets Guardian review<!-- pomerado:section core.tools-and-files -->.
Nested Playwright actions do not each trigger review. A probe operation still receives the host-bound business
input. Its declared schema must accept that input even when the bounded observation
does not use every field; do not replace it with an empty or probe-only schema.

<!-- pomerado:section core.captured-checks -->

<!-- pomerado:section core.references:start
Choose relevant references: writes, pagination, forms, caller input for a choice only
the page can offer, or a code, during the run, and publication before the first
`finish_build`.
pomerado:section core.references:end --> Read their bodies only when useful.
Finish with actual execution evidence and
truthful coverage through `finish_build`. A write finishes after its session's
confirmation read; never run the composed script live. Ask only as "Try hard, then
ask" allows. If infrastructure prevents further
work, report the recorded failure and unresolved effects, then end without
publication; the host preserves an incomplete build. Do not ask the user to
answer a provider outage. Publishing future code does not replace the build's own
result or resolve uncertain effects.

Examples: `references/parser.ts`, `references/native-page.ts`,
and `references/selection.ts`. For custom choices, the forms skill includes
`references/custom-selection.ts` and points to the relevant helper implementations.
Read those on demand when deciding whether a helper fits the observed control.
SDK reference gaps must be reported, not recreated as unreviewed infrastructure
in every site script.

For a demonstrated account/layout variant, handle every supported layout in one
script. The call that reads the page first observes which layout it shows, and the
script fails on a loading, ambiguous, unknown or mismatched layout. Inspect stable
containers, roles,
field organization and legitimate account/input capabilities; never classify a
layout from private customer literals, changing dates or whole-page hashes.
Loading is not proof of a new version. An identity mismatch blocks every candidate.

See the compiling `references/variants.ts` example.

<!-- pomerado:section core.layout-captures -->

## Authenticated operations

A signed-in operation needs no login or identity hooks. The host signs in before the
script runs, through an explicit direct HTTP request or host autofill, and the
script starts signed in. Each enters private values through the trusted host. The
script never receives a password. After a full page load mid-script, call
`ensureSignedIn()`, as the auth skill describes.

When inspection establishes a login entry, pass `loginUrl` directly to `execute` with
purpose `authenticate`. The host uses it exactly as given and grants it no authority:
credentials are typed only on the site's registrable domain or a configured sign-in
origin. Record a stable reusable entry and include any observed fieldless navigation steps needed to
reach the credential form from that entry. A URL no sign-in can start from, and
a failed sign-in, come back with the reason and the next step; fix the cause and call
authenticate again. Do not author a login-routing metadata file.

Inspect login markup using reviewed read-only `explore` without private credential
injection. Use execute purpose `authenticate`, target `liveBrowser`, to sign in. The
host runs<!-- pomerado:section core.sign-in-request --> the observed `signInStep` and reports the sign-in. It runs no
generated code, and it does not claim or execute the business example. Login effects
have separate authentication evidence. If the same browser still shows a login page or
a signed-out state afterwards, inspect the page and correct the recorded steps or report the failure.
Credentials the site rejected are never resubmitted.<!-- pomerado:section core.login-markup --> Wait for the
signed-in page to become ready after login. Disappearance of the login form alone is
insufficient. The host requests codes and choices through protected input requests during
`authenticate`.

Only the host requests website credentials, and only during `authenticate`.
<!-- pomerado:section core.login-source -->`request_input` cannot request credentials. If the site cannot be reached, report that instead
of starting sign-in. Never request durable credentials in model arguments or
history.<!-- pomerado:section core.credentials -->

<!-- pomerado:section core.capture-evidence -->

Keep exploratory output focused on the current question: the relevant control or
container, its state, and the nearby choices. Prefer the existing accessibility
checkpoint to repeatedly returning whole-page text and all controls. If a probe
reports a missing choice, compare its post-action checkpoint before concluding
the site does not support it. Return explicit partial coverage when an observation
is bounded; never describe a truncated list as complete.

Supported login challenges during `authenticate` belong to the host's sign-in
(autofill or an explicit direct HTTP step) and its protected input requests. Generated `operation.run` and `explore` code
never request or enter a sign-in code, or sign in themselves: an SMS, email or authenticator code
that is part of signing in is a `code` field of the `authenticate` step (auth skill), never asked
separately. A code the site sends later, to confirm a protected action after sign-in, is different:
declare it as a `secret` question and ask it with `ask`, as the caller-input skill's
`caller-code.ts` shows. A missing ordinary page
control alone does not establish a human-verification challenge. Observe the
current page state within the existing deadline. When a few distinct attempts have
not found the way, ask the caller for directions with `request_input` before
reporting a blocked or unknown state whose cause cannot be established. Completing a
challenge does not prove login.

For a native dialog, the call that raises it keeps it on `globalThis.dialog` from a
`page.once("dialog")` listener and returns its type, message and URL without awaiting the
click. Pass that to `decideDialog` with a stable step name, and apply the host's choice in
the next call with `globalThis.dialog.accept(promptText)` or `globalThis.dialog.dismiss()`,
as in `references/native-dialog.ts`. Never pre-dismiss the dialog or retry the action.

## State-changing requests

A live execute result may carry `stateChangingRequests`: every request other than
GET, HEAD or OPTIONS the page sent since the last execution result, by `method`,
`origin`, `path` and `resourceType`, with a `count` (`omitted` counts routes past
the list). Nothing refused them; the list exists so you can catch writes you did not
intend. Telemetry, analytics and bot-sensor POSTs are normal and need no change.
So is an anonymous recent-search, prefill or search-state save the site fires when
you submit a search.

For a read tool, look for a write your own action caused, such as adding an item to
a cart, submitting a form, saving a preference or starting a checkout. If you find
one, change the code so it reads without causing it, for example by reading the
value from the page instead of clicking the control that changes it, and run it
again. For a write session, the list shows the commit your step caused and any
autosave: that is the evidence for the `http` version, and any other write is
unintended and must not be in the composed script. `initiator` is evidence, not proof: `evaluated_script` is usually your own
page evaluation, `page_script` is the site's script (which your click can also
start), and `parser` is markup such as a form submission.

## Host incidents

The host records every request your code causes and blocks none. An execute or inspect result
may carry `hostIncidents`. The first model request may carry `hostIncidentsBeforeStart` for the
host's own entry-page load. The mint continued past each listed gap.

`hostIncidents` kinds:

<!-- pomerado:section core.incident-kinds -->

<!-- pomerado:section core.completion:start

## Standalone execution and completion

Use the ordinary `defineOperation` API and existing Kernel-shaped browser calls above. `liveBrowser` is native Playwright and `pureFiles` is local computation. The host retains Guardian review, caller authority, source reads, questions, deadline/cleanup and no-replay rules. It offers no browser replacement or captured replay facility. An invalidated native executor ends this attempt; never use a new browser to repeat an uncertain effect.

Declare explicit input and output schemas, concrete types and bounds for each supported field. Caller choices and account-specific values come from input or reviewed questions, never literals/defaults you invented. A detail read verifies the requested record identity and final page state. Every returned field has observable support; describe missing coverage truthfully.

`finish_build` returns the current integration files and schemas after shared checks. A read needs a successful example using supplied values. A write needs its original confirming act receipt and current source; compose it without running it again. Return the task result and honest evidence, not unsupported success claims.

Only the host asks for website credentials and only during `authenticate`. Give it the observed field selectors, slots, allowed identifier kinds, format and submit. No generated source receives the raw password; follow the same destination, stale field/focus, no-readback and code-handle rules as hosted execution. Correct a refused binding by reading the current screen. A rejected credential needs caller correction; do not resubmit it.

pomerado:section core.completion:end -->
