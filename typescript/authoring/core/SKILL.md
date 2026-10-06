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

<!-- pomerado:section core.secret-answers:start
A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value. Write the
handle exactly as given as the whole string passed as the value to `fill`, `type` or
`pressSequentially` on a `page` chain inside the code of a `kernel.browsers.playwright.execute`
call, such as `await page.getByLabel("Code").fill("{{secret.s1}}")`. The host fills in the value
when it runs that source live. Never hold a handle in a variable, transform, log, return or read
it back, or put it in a URL or a file. An example and published source never hold a handle: a
value the finished tool needs at run time is a declared `secret` question it asks with `ask`
(caller-input skill).
pomerado:section core.secret-answers:end -->

## Kernel scripts

<!-- pomerado:section core.operation-shape -->

<!-- pomerado:section core.execute-calls -->

**The input schema.** Every caller sees the tool's input schema, so build it from the
request and the flow, never from one caller's account or example.

<!-- pomerado:section core.schema-coverage -->

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

<!-- pomerado:section core.site-origin -->

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

<!-- pomerado:section core.tools-and-files -->

<!-- pomerado:section core.captured-checks -->

<!-- pomerado:section core.references -->

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
script never receives a password.

When inspection establishes a login entry, pass `loginUrl` directly to `execute` with
purpose `authenticate`. The host uses it exactly as given and grants it no authority:
credentials are typed only on the site's registrable domain or a configured sign-in
origin. Record a stable reusable entry and include any observed fieldless navigation steps needed to
reach the credential form from that entry. A URL no sign-in can start from, and
a failed sign-in, come back with the reason and the next step; fix the cause and call
authenticate again. Do not author a login-routing metadata file.

<!-- pomerado:section core.login-markup -->

<!-- pomerado:section core.credentials -->

<!-- pomerado:section core.capture-evidence -->

Keep exploratory output focused on the current question: the relevant control or
container, its state, and the nearby choices. Prefer the existing accessibility
checkpoint to repeatedly returning whole-page text and all controls. If a probe
reports a missing choice, compare its post-action checkpoint before concluding
the site does not support it. Return explicit partial coverage when an observation
is bounded; never describe a truncated list as complete.

Supported login challenges during `authenticate` belong to the host's sign-in
(autofill or an explicit direct HTTP step) and its protected input requests. Generated `operation.run` and `explore` code
never request or enter a sign-in code, or sign in themselves. A code the site sends during the
action, such as a two-factor or confirmation code, is different: declare it as a `secret`
question and ask it with `ask`, as the caller-input skill's `caller-code.ts` shows. A missing ordinary page
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
