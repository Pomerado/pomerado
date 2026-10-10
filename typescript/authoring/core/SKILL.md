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
composes its script from what happened (the `writes` skill). Credentials and sign-in codes
belong to the host; never request a password, cookie or TOTP seed in model-visible text.

Asking the caller follows `AGENTS.md` ("Try hard, then ask").

Write ordinary TypeScript or JavaScript files. Export a default Kernel script, as
described below. Import the actual canonical SDK entrypoint given in the workspace
README; do not assume an unconfigured package alias. Repository examples compile
against `typescript/src/runtime/index.ts` and show the real method signatures.

## Secret answers

A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value,
which you never see. In explore, test or `act` source, write the handle exactly as given as
the whole string passed as the value to `fill`, `type` or `pressSequentially` on a `page`
chain, or as a field of a `fetch` call to a literal URL on this site, inside
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
- Click with a plain `locator.click()`, with at most a `timeout`. A hosted browser may make
  it a real pointer click, after the same checks Playwright makes. `force`, `position`,
  `modifiers`, `button`, `clickCount` and `delay` keep a synthetic click, so pass them only
  when the step needs them.
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
  or a party size over its limit, throw `new errors.InvalidInput(message)` saying why. When the
  refusal is obvious, start the message with "Caller input error:" so the caller gets it at
  once. It is obvious when the input alone breaks a rule of the task, checked before any site
  action, such as a departure date before yesterday in UTC, a return before its departure or a
  count below one. It is also obvious when the page itself refuses the value in its own words,
  which the message quotes. Never use that start when the tool's own read found nothing, such
  as an empty suggestion list, a slider or list that hadn't loaded, or a day the page disables
  without saying why. When the value is not among choices the page lists, throw
  `new errors.InvalidInput(message, { field, available })` instead, as "Configure, then read"
  below says. `errors` exists only in the script, never in a call's `code`, so when the page
  shows the refusal, return a marker such as `{ refused: "why", field, available }` from the
  call and throw once it returns. The run then fails as the caller's input; with `available`,
  the host ends it at once with those choices and no repair. A repair never asks the caller for
  a replacement value and never runs the tool with a value the caller did not send: when the
  page does not offer the caller's value, the repair makes the code throw with `available`,
  shows it with the caller's own input, and the run ends with those choices. A write that throws it before entering a commit mark reports that it changed nothing. A page,
  control or response that changed is still `OperationFailure`.
- After a write, call `verified()` with no argument just before returning, once a call has
  read the result back, either the site's confirmation for this submission or the saved state.
  Return the confirmation number or record in the output. Without it the write stays a
  possible effect. A write declares which in its contract's `write`, and a write build runs
  as `act` steps; see `writes/SKILL.md` and `forms/SKILL.md`.

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
  the code rejects or ignores, such as a string the code throws on unless it is the example's
  value, or an input the code accepts and then never applies, skips or always reports
  unsupported or unapplied: wire it to the site's control. Leave an input out only when the
  site offers no control for it, and say so in the description.
- Every value the code types, selects or fills on the site comes from the input and
  accepts what the site's field accepts. An enum lists the site's full set of options,
  never just the example's value. The example's values are one case, never limits.
- Prefer keying only on what the caller asked for. A detail that changes from one listing to
  the next, such as a seating label or a room name, shouldn't decide whether the tool books or
  refuses unless the caller chose it.
- Read results for every option the schema lists. When an option leads to a page that
  differs from the others, handle that layout too and run it live (testing skill); never
  return results for another option in its place.
- A repair that finds a declared input broken, never applied or always reported unsupported
  fixes it in the same repair, whether or not a caller is waiting. Keeping a tool's contract
  means every input and output it declares works, not leaving a broken one as it was.
- Never derive a format from one sample: not an input format, an element key, a selector, a
  URL path or a label. A key the page showed for the example's value says nothing about the
  next value, as when a calendar keyed December 3 as `12-3-2026` where the tool expected `12-03-2026`. Read
  the format off the page for the value you need, such as the day cell whose visible label or
  accessible name is the caller's date, or a key the page itself lists, never a key rebuilt
  from the one you saw.
- Inputs are values a caller knows, such as codes, names, dates and counts, never a
  suggestion's full display text or an internal id the caller cannot know (an id the site
  shows on its own pages, such as a product number, is not internal). A closed list
  of options stays an enum of the site's options, as above. When the options come from a
  query, as in a search box, autocomplete, typeahead or searchable combobox, look the value
  up the way a person would. Type the caller's value into the site's own search and read
  every suggestion or result it shows. Prefer matching names loosely, ignoring case,
  punctuation, apostrophe style and a location the site adds to the name, such as a
  neighborhood or an airport code in brackets, over waiting for an element named exactly as
  the caller typed it. A whole-name or code match outranks a partial one, so an airport code
  picks that airport, not its city. Then count the matches at the best rank. With none,
  throw `InvalidInput` at once, saying the site has no match and naming the closest entries
  it showed. With one, use it. With several, ask the caller which one with a declared choice
  question whose options are those matches as the site labels them
  (.agents/caller-input/SKILL.md).
- On a write, every choice the session met is an input: each option on the path,
  add-ons and pre-selected defaults included. Make it required when the site requires
  a choice (a fare class) and optional when it does not (a seat). An unset optional input
  keeps the page's default; an add-on, a pre-selected paid option or a saved payment is
  never left to a default, so ask about it (`AGENTS.md`, "Try hard, then ask").
- Never make an account-specific value (a passenger, loyalty number, saved card or
  address, account or member ID) an enum member, example or default in a public
  schema. Take it as a free-form input when the caller can name it, such as a loyalty
  number; a choice among the account's saved items that the caller cannot name is a
  declared `ask` with `accountSpecific` options (caller-input skill).
- The host's `businessInputTypes` is a value-free tree of the JSON types in the caller's
  input. Use it to pick compatible types when a credential in the input is masked; a mask
  does not mean the value was a string. It says nothing about
  required fields, array lengths, numeric bounds or future values: derive those from
  the request and reviewed evidence.
- Never hard-code a value the caller could vary: it comes from the input, never a literal
  in source, a schema default or the definition. A good tool exposes the options its
  purpose calls for, not only the ones the request names: record every control the flow
  offers that narrows, orders or configures what the tool returns as an optional input wired
  to its control, such as cabin class (economy or first) on a flight search, even when the
  request never mentions it. Open collapsed groups, drawers and "more" links before you
  decide what the page offers: a collapsed group is not an absent one. Leave out controls
  unrelated to the purpose, such as a language switch or a newsletter opt-in on a search.
  Record such a field as an optional input whether or not you ask about it, since callers of
  the tool can set it. Ask about one only as `AGENTS.md` ("Try hard, then ask") allows; left
  unset, it keeps the page's default.
- Turn safety defaults off. A preselected option whose only effect is to share the caller's
  data with another company, such as a partner comparison that opens the search on another
  site, to opt into tracking beyond what the site needs, or to sign the caller up for marketing
  email, is never an input and never a question. The tool turns it off on every run before the
  submit it affects, and reads back that it is off. When the site won't submit with it off,
  leave it on and say so in the description. Name the ones the tool turns off in the
  description in general words, such as "turns off partner comparisons". A repair keeps each
  one the registered source turns off.
- Find these boxes where you fill the form, unlabeled ones included. List every checkbox,
  switch and toggle in and near the form by role and by `input[type=checkbox]`, never only by
  label, with its checked state, its nearest text, its group's heading and the alt text or
  title of any logo beside it. A preselected box whose group names another company or shows its
  logo is a partner box. After a probe's first submit, check whether a new tab opened or the
  page left the site. If one did, a box you missed sent it there.
- Find the inputs that change the result yourself; the request will not list them all. A
  location is the common one: a ZIP or postal code, city, address or store often changes
  results, prices and availability, such as a store's stock or the appointments a city's
  offices show. Always look for where the site lets a visitor set one, on a search, details or
  cart tool alike, and when it does, make it an optional input, such as `zip_code`, or `store`
  when the site offers stores. Set it on every run through the site's
  own location control, take the site's matching suggestion, read the applied location back
  from the page and return it. Left unset, return the location the page shows and say in the
  description that the site picks it, which can differ from run to run. While building, ask
  the owner for one (`AGENTS.md`, "Try hard, then ask"); they may skip it. Setting a location,
  store or delivery or pickup mode in the run's own browser is part of the read, never a write,
  even through a Save button: the run's browser is fresh and discarded, so nothing is saved,
  and a tool that never signs in has no account to change. Saving a guest address signed out
  is part of the read too when it only sets the location; a step that also enters a name,
  email or phone number is a write that needs the caller's confirmation. In a signed-in tool, use the site's per-visit location control and
  never save an address, default store or preference to the account.
- When the caller input is empty (`{}`), write the tool's input from the request and the
  owner's answers, with dates normalized (10/4 is the next October 4, as `2026-10-04`), and
  pass it as `exampleInput`: on a read's example, or on each write act step that needs it. The
  first act step that passes it fixes it, and later steps repeat it unchanged or omit it. Make
  each of its keys a schema input, required where the request needs it; publication returns a
  key the schema lacks as an `example_input` input feedback. An optional input plus a declared
  question is only for a value the request leaves open.
- Callers and Guardian see the JSON Schema form, so write every constraint in one it
  shows: a `Schema.filter` shows nothing, its description included, so use
  `Schema.NonEmptyString`, `pattern`, `minLength`, `Int`, `between` or `Literal`. Type every
  output field, never `Schema.Unknown`. A read publishes the schemas in its current source,
  and its example's own input and output must decode under them, so settle both before that
  example.
- Give every input and output field, nested object and array item fields included, a short
  `description` annotation saying what it is, with the unit or format where one applies:
  "Departure airport as a three-letter IATA code", "Departure date, YYYY-MM-DD", "Average
  guest rating out of 5, not a count of reviews". Effect's stock text, such as "a non empty
  string", is no description. Annotate the field's own schema, inside `Schema.optional(...)`
  for an optional one. Callers see each beside its name.
- Shape inputs and outputs like Pomerado's own API, so every tool reads alike: field names in
  snake_case; dates as `YYYY-MM-DD` and timestamps as ISO 8601 with an offset; money as an
  integer in minor units with the ISO 4217 `currency` the page shows beside it, such as
  `total_minor` 12999 and `currency` `"EUR"` read from "€129.99"; enum values in lowercase
  snake_case (`"premium_economy"`); booleans named as statements (`refundable`, not
  `is_refundable_flag`); lists named in the plural; and the unit in the field name or its
  description (`duration_minutes`). Convert between these and the site's own formats in code.
- When `reference/site-tools.json` exists, it lists this site's published tools with their
  descriptions and schemas. Read it before settling or changing yours: where this tool takes or
  returns the same thing as one of them, use the same identifier, field names and shape, so a
  caller can pass one tool's output to the next, such as a record's ID from a search tool into a
  details tool. Never narrow an input to match. It is reference only: nothing here calls those
  tools.
- Give every input field one `examples` annotation value, which callers<!-- pomerado:section core.example-readers --> use to assemble a sample request: public, generic data such as a well-known airport code
  (`examples: ["SFO"]`), a date a few weeks ahead or a common product category. Never use a value
  from this session: not the caller's input, the owner's answers or anything the site showed
  this account.
- Descriptions, titles, examples and defaults are published and reviewed for private data,
  and an annotation never declares its contents public. Explain constraints without copying private input
  or unneeded numeric identifiers; for a nonnegative safe integer,
  `Schema.between(0, Number.MAX_SAFE_INTEGER, { title: "Safe integer", description:
"Nonnegative safe integer amount" })` keeps the bound with public prose. Only
  host-approved standard enums and origins are recognized as public.
- Guardian's publication review checks the schema and the code that fills it. A
  `not_published` result with reason `input_feedback` lists `account_specific_enum` and
  `input_option` findings. They are feedback, on a read or a write: correct the source
  (make the value free-form or add the option as an input) and call `finish_build` again
  with the same `executionId`. An input narrowed to the example's value (`example_value`)
  blocks publication instead: widen the input and the code that sets it. The host reads the schemas offline from current source and checks that the
  example's or session's own input, and a read example's output, still decode. Never run a
  write again for it. After two such rounds, or if you stop
  without fixing them, the host publishes the last reviewed version privately to the
  caller's account and flags it.

**Find contract gaps before your first example.** Compare the schema you plan with what the
page offers: a control no input covers, an input you cannot wire, a value the request needs
that the page does not show, or a needed field you would have to make nullable. Settle each
then: wire it, ask the owner with `request_input` when the request reads two ways, or state in
the description why the tool lacks it. Publication review blocks on the same gaps, and finding
them at `finish_build` costs a full fix-and-resubmit round.

**Never loosen a value the request needs.** The values the request needs are each value it
names, the record's identifier as the site shows it, and the context those depend on as the page
shows it, such as dates, a party size or a location. Make each one required and non-null, typed
so a value the code could not read fails the output check (`Schema.NonEmptyString` for text,
`Schema.Int` for a count), never optional, nullable or plain `Schema.Number`, whatever the
request's wording or a description says. A run whose output fails its schema goes to repair.
- The one exception is a record whose own page genuinely does not show the value, such as an
  item that is sold out and shows no amount, or a listing that shows no date yet. Then the value may be null only together with a
  field that says why, such as its availability, and both descriptions say so.
- Null never covers a value the page shows that the code failed to read: that throws
  `OperationFailure` naming it. Never turn a read that found nothing into null
  (`?.innerText ?? null`); a missing element is a failure, not an absence.
- Before your first example, list the needed values. If the page may not show one, settle it
  then: find where the site shows it, on every layout its records use, or ask the owner.

**Output fields.** Design the output for what a caller could use, and lean toward more fields
and more information rather than the minimum: include the facts about each record or result
that a caller could reasonably use to identify, choose, compare or act on it, not only the values
the request names. Leave out what is unrelated to the tool's purpose or of no use to a caller.
- Keep each value's full displayed text. Read the element that holds the whole value, never a
  shorter or secondary one. When the page splits one value across elements, such as a maker
  line above a linked name or an author line above a title, return each part in its own field. Never drop either part.
- Prefer a separate typed field for each fact over folding it into another field's text. Never
  derive a value the page does not show.
- A field that is not a needed value is nullable when records on this site can lack it, and it
  is null exactly when this record does not show it.
- Never declare a field the code does not read. A field that is always null, empty or fixed is
  not a disclosed limit: read it from the page, or leave the field out.

Then, for every field:
- Prefer parsing what the page shows into typed fields over returning a result row, card or
  itinerary as one text blob or summary, and keep every result row the page shows.
- Read every output from the page or response on every run, so every returned field has
  observable support: never a literal, a default you invented, or a constant `null`, `[]`,
  `false`, `0` or fixed label where the page can show the value.
- Return `null` for a field that is not a needed value only when this record's page lacks it,
  and an empty list only when the page shows none; never throw for either. When the code cannot
  read a value the request needs, throw `OperationFailure` naming it; never return a
  placeholder, a label or another record's value in its place.
- One field per fact, as the page states it, and variants as the dimensions and values the page
  lists.
- Prefer numbers for amounts and counts, ISO 8601 for dates and times and minutes for durations;
  type a date-only value as the runtime's `CalendarDate` (forms skill). A value that does not
  parse cleanly may be the site's own text.

**Configure, then read.** Many pages show values that depend on choices made on the page: a
record's options or variants, a plan or tier, dates, a party size or quantity, units, a
location or store. A search's filters and sort are such choices too. Before reading any value
that depends on them:

1. Discover. While building, read every choice group the page offers and each group's options
   exactly as shown, including which are unavailable, opening collapsed groups and menus as
   above. On a run, open and read only the groups the caller's inputs use. A group
   with one option, or a disabled control showing one value, is a
   fixed value: read it, never click it.
2. Set. Apply each input's value through the page's own control, in the order the page
   presents the groups, since one choice can change the options of the next. When the value is
   not among the options the page offers, throw
   `new errors.InvalidInput(message, { field, available })` before any commit mark, with
   `field` the input's name and `available` every option the page currently offers as
   selectable, exactly as shown. Leave disabled, sold-out and other unselectable options out of
   `available`, and say in the message that they were left out. Never pick a near match, the page's default or the first option.
3. Confirm. Read each choice back from the page's selected state, then wait for the values
   that depend on it with `waitForChange`: changed, or confirmed unchanged once the page's
   loading sign came and went; a value read before the page updates belongs to the previous
   choice.
4. Read. Only then read the values the choices affect. Return the applied choices beside
   them. Return a group's offered options as a list when the page shows them without extra
   clicks, as a record page shows its variants, or when the caller asks (search skill).

An optional choice the caller leaves unset keeps the page's default: read it back and return
it as applied. A control you could not find, open or read throws `OperationFailure`, never
`InvalidInput`.

<!-- pomerado:section core.host-ownership:start

The host owns input/output validation, deadlines, caller authority and the browser. Do not close the page.

pomerado:section core.host-ownership:end -->A newly allocated Page may start at `about:blank`; the supplied site origin does
not mean the host has navigated there. Navigate to the authorized site and wait
for a named page condition before inspecting its title or controls. Empty content
on a blank Page is not evidence about the website or its availability.

Take the site origin from the context's `siteOrigin`. If it is undefined, fail before
live navigation; offline fixtures intentionally have no live origin. Build URLs with
`new URL("/", siteOrigin).href` or a fixed path the site links to (`AGENTS.md` says when a
caller's value may go in a URL), and write them into the code. Never embed the site's hostname
or account-specific origin as a literal in authored source, schema examples, or logs, and never replace it with `page.url()`
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
Read each output value from the element or structured-data entry that holds the whole value,
never a shorter or secondary one, found by a stable id, a `data-` attribute, a role and name or
the record's own key, using its `innerText`.
Never read it from a broad container, whole-page text, tag-stripped HTML, a regex over page-wide
text or a page-wide setting such as a currency or language picker: `textContent` also includes
hidden text and scripts, and a heading, label or placeholder is not the value beside it. Read
embedded data separately when it is relevant to the requested operation.
Budgets: navigation 30 s for the document to commit; a click, fill or other action 5 s, taken
only on an element a wait has shown ready. After a navigation commits or an action returns, the
page gets 8 s without progress to show one of the answers you named, and up to 30 s while it
keeps progressing: a loading sign showing, the part of the page you named changing, the site's own
request in flight, the URL changing, or the values you read filling in. Values the site fills in
after its answer get up to 15 s. The runtime's waits (`waitCode`, below) apply these budgets. Give
every other Playwright call in the code an explicit `timeout`, and keep `timeout_sec` within
`remainingMs()`.
Child waits cannot extend the outer deadline. Explicitly name observation conditions.
`domcontentloaded` is document readiness, not readiness of the requested page or
control. Initial navigation can land on a temporary verification page before the
site redirects or renders its controls. JavaScript challenges, redirects and
delayed rendering can be intermittent: a fast exploration load does not establish
that later executions will be immediately ready. Include a bounded wait for the
expected page or control even when exploration never observed a delay. Derive
that readiness condition from the intended page, not from having seen a particular
challenge. Wait for a unique operation control or page state before testing absence
or choosing a fallback. Use `locator.waitFor` for one expected state, `waitForOutcome`
(below) when the page can answer more than one way, `waitForRows`, `waitForValues` or
`waitForChange` (below) for the values you return, or a bounded polling loop;
`count()` and `isVisible()` only observe the current instant. A ready page should
pass immediately; do not add a fixed sleep. Share one bounded navigation deadline across navigation
and first-page readiness, as in `references/navigation.ts`. Readiness polling
only observes: do not repeat `goto`, reload, login, submission or another action
inside it. Preserve site/path and account guards while waiting.
Wait for the values you will return, not for their containers or the rest of the page. A record
is ready when each value you return is filled in and reads the same on two looks
(`waitForValues`). A list is ready when the rows you return, the first `limit` from the page's
position (pagination skill), have their identifier and the values the request needs, filled in
and reading the same twice (`waitForRows`); keeping every result row means every row up to that
page size. A slot that is present but empty, a skeleton, `aria-busy` or reading "Loading…" is
still loading, never absent; a slot with no identifier is not a result. A value still loading
when the page stops progressing fails the run, optional or not: null is only for a field this
record's markup lacks altogether, as the build saw on records without it, never for a slow one.
Never wait for rows you won't return, for the whole list to stop changing, or for the page's
`load` event. Read image links from attributes (`src`, `srcset`) without scrolling. A page with
an outcome is ready only when it shows that outcome: results, or the site's own empty message.
Before acting on a control, wait until loading overlays covering it are gone and its section is
expanded. A panel or dialog you opened does not go away by waiting: close it with its own
control or Escape and check it closed. A click Playwright keeps reporting as intercepted by the
same element is a page state, not slowness. After an action that navigates or re-renders, wait
for the committed state
(URL, selected value or header) before checking identity or reading. Use bounded retrying
waits: re-check the condition until it holds or the budget ends, then throw `OperationFailure`
naming what was last observed and what was expected. Never swallow a failed wait and continue
(`try { await wait } catch {}`): either the condition is required, so throw, or it is not, so do
not wait for it. After extracting, confirm the page did not re-render under you: the same IDs
for the rows you returned, the same values for the fields you returned, and the same URL as
before extraction. If any changed, read again within the deadline.
These re-checks only observe: never repeat the click, submission or navigation that caused the
change.
After an action that can navigate, wait for the observed destination URL when known,
then a specific destination control or page state before extracting. Keep the action,
readiness wait and extraction in the same Kernel execute call when possible. If a read
reports “Execution context was destroyed,” the action may already have succeeded.
Reacquire page/frame locators, wait for readiness and retry only the read within the
original deadline. Never repeat the click or submission as part of that recovery.
Use observed conditions, without fixed sleeps, whole-page network-idle waits or the `load` event.
For an unknown destination, inspect after the document transition; do not invent a
selector or repeat the action in a follow-up read.
After a step whose answer can vary, such as a search, a filter, a date pick or a submit, name
every way the page can answer: results, an empty or sold-out message, a greyed-out choice
(`getByRole(role, { name, disabled: true })` or the site's own disabled marker), the site's
error, a pick-one list. Prefer naming every answer over waiting only for the happy result.
Import `waitCode` from the runtime (`outcomeWaitCode` is the same string), paste it once at the
top of the call's code, and wait with `waitForOutcome({ refused, failed, unavailable, empty,
results }, { action, loading, region })`, one scoped locator per answer, each an element only
that answer has, such as a results list that holds a
row. The first listed wins when several show, so list a refusal, error or greyed-out choice
first, then the empty state, then results. Pass the step itself as `action`, such as
`() => apply.click()`: the wait runs it once, and an answer the page already showed before it counts
only after staying unchanged for `unchangedMs`, 2 s by default, so a list the step has not yet
re-rendered is not read while a step that leaves the same answer still resolves; a new or
changed element counts at once. Pass the site's own loading sign as `loading` and the part of
the page the answer appears in as `region`, so their changes count as progress. Read results;
return an empty list for a listing's empty state;
throw `InvalidInput` with the site's own words for a refusal or a greyed-out choice the input
asked for; ask the caller about a pick-one list (.agents/caller-input/SKILL.md). It throws an
`Error` named `OutcomeWaitFailure` whose message says what each outcome matched, which progress
signs it saw and when progress stopped: `outcome_ambiguous` when the winning locator matches more
than one element; `outcome_unknown` when the page stops progressing for `noProgressMs` (8 s)
while showing none of the answers; and `outcome_timeout` when it is still progressing at
`timeout` (30 s). An unknown page is a challenge, the site's error or a layout you have not
handled: never raise a timeout for it. `references/navigation.ts` waits for a search's answer and
a record's page this way.
The same code declares the waits for the values you return. `waitForRows(rows, fields, { count,
key })` returns `{ rows, more }`: the first `count` rows that have a `key`, each field filled in
and reading the same twice. It skips a row without a key, and returns fewer rows once their count
holds; no rows is never its answer, so decide an empty list with `waitForOutcome` first.
`waitForValues(fields)` returns `{ values }` for a record, a quote or a form's state.
`waitForChange(fields, { before, action, loading })` returns `{ values, changed }` after a choice:
changed, or the same with no progress sign for `unchangedMs`. They throw a `ValueWaitFailure`:
`values_loading` when a value is still loading as progress stops, `change_unknown` when the
fields are missing, `values_timeout` at the cap. The host's one timeout retry of a read covers
`outcome_timeout`, `outcome_unknown`, `values_loading`, `values_timeout` and `change_unknown`,
so let them throw. `waitReport()` returns a one-line summary of how each wait in the call ended.
A field is a Playwright locator, or `{ locator, attribute, optional, all }`, where `all` reads
every visible match as a list. After a search or a filter, use `waitForChange` on the rows you
return, such as `{ ids: { locator: rowIds, all: true } }`, with the site's own loading sign as
`loading` when it has one.
After a step that reloads the page, such as choosing a city, prefer typing into the search box
again when its suggestions don't appear.
<!-- pomerado:section core.site-origin -->After a probe reveals a challenge, inspect the retained Page in follow-up probes
and wait for the intended page/control within the existing deadline and job budget;
do not click the challenge, reload, or navigate to another route merely because
the earlier probe timed out. A new probe execution does not require new navigation.
A live example, a live read `test`, and a write session's first `act` step are
different: the host resets
the browser to the site origin before it runs,
and clears exploration cookies and site storage. A signed-in build gets back the session
saved right after sign-in instead. When the page is signed out after that reset, or after a
full page load your source asks about with `ensureSignedIn`, the host signs in again by itself;
do not call `authenticate` for it. When the host cannot keep the site signed in, the step fails with
`session_not_kept`: report that cause instead of signing in again. That source must perform
the flow from its input,
never rely on a page an exploration left open. So a read iterates from a clean start,
and re-running its example or live test is normal. A live test stays read-only. A write
session's later `act` steps continue on the page the previous step left.
If the deadline expires, report the named readiness failure and use current
screened evidence to distinguish a remaining challenge, loading and changed
layout.<!-- pomerado:section core.challenge-reference --> Do not invent a CAPTCHA bypass or replace the target with an arbitrary
first element. Resolve role and computed accessible name from observed evidence;
`searchbox` and `textbox`, and their exact names, are not interchangeable.
When a locator is missing or a Playwright timeout names one, first check that the page's URL and
heading are the page you meant: a wrong or error page needs the site's own route to the right
page, never a new selector. Otherwise repair that wait and keep the checks that already
passed. A `DeadlineExceeded` phase of `execution` is the shared operation deadline. Before increasing a timeout, make one bounded observation of the candidate
target count or state; increase it only when evidence shows that the correct unique
target is slow. Do not catch-and-repeat timed-out work. A click or navigation that
timed out is an uncertain transition: it may already have taken effect. Inspect the
retained page in the next probe and do not repeat the action until you know where
the page landed.

Never call `.first()` (or `.nth(0)`) on a broad text or regex match, whether to
click it or to wait for readiness: collapsed menus often hold an earlier hidden
match. Scope a role locator to its evidenced container and to visible elements,
for example `nav.getByRole("link", { name: /log in/i }).filter({ visible: true })`,
then check that exactly one element matches; `waitForOutcome` checks it for the outcome it
returns. When several candidates remain, inspect them and choose by evidence such as
section, accessible name and destination before clicking or waiting. A readiness wait targets one specific
evidenced element or page state.

For a detail read whose input is the record's page URL, check that it is https on the tool's
site and open it unchanged. Otherwise reach the record through the site's own search, list or
link for the schema-validated caller identifier, or through a stable identifier route the site
itself uses when that is clearly better (AGENTS.md, "Work through the page's own controls").
A successful response or plausible content is insufficient: the final page's
site (any https host on the site's registrable domain), final path and stable page
identity must all agree with the requested identifier. A path agrees when it carries the
identifier; a site can serve one record under several of its own routes. Explicitly classify
a detail page, loading state, known interstitial and unsupported or mismatched page. Continue through an interstitial only when its
own stable identity matches the request and one unique continuation control belongs
to that interstitial. This exception does not include a CAPTCHA, login or unknown
challenge. Wait for the detail or proven interstitial, guard the continuation, then
wait again and recheck the final site, path and page identity before extraction. Use
typed failures for every other state; never return interstitial fields as a detail
result. `references/navigation.ts` shows this sequence in one call, reached through the site's
search (`detailNavigation`) and from a caller's page URL opened unchanged (`detailFromUrl`).

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
the one input you choose, with public values only (.agents/testing/SKILL.md). Every new
command/probe/execution gets Guardian review<!-- pomerado:section core.tools-and-files -->.
Nested Playwright actions do not each trigger review. A probe operation still receives the host-bound business
input. Its declared schema must accept that input even when the bounded observation
does not use every field; do not replace it with an empty or probe-only schema.

<!-- pomerado:section core.captured-checks -->

<!-- pomerado:section core.references:start
Choose relevant references: search for a search or listing tool, writes, cart for a cart or
checkout, pagination, forms, caller input for a choice only the page can offer, or a code,
during the run, and publication before the first `finish_build`.
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

When inspection establishes a login entry, pass `loginUrl` and the first screen's
`signInStep` to `execute` with purpose `authenticate`. The host uses the URL exactly as given
and grants it no authority: credentials are typed only on the site's registrable domain or a configured sign-in
origin. Record the site's own sign-in link (auth skill) and include any observed fieldless
navigation steps needed to reach the credential form from it. A URL no sign-in can start from, and
a failed sign-in, come back with the reason and the next step; fix the cause and call
authenticate again. Author no login-routing file beyond the direct-request template the auth
skill describes.

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
the site does not support it. Listing a filter panel's or option group's controls is a
focused observation. Return explicit partial coverage when an observation is bounded; never
describe a truncated list as complete. In a probe, count a locator before acting on it and give
each action `timeout: 5000`, the default the host also gives probe actions; take names from a
scoped `ariaSnapshot()`, not visible text. A probe that waits out a long timeout for a missing
element learns nothing a count would not. Return `waitReport()` from a probe that waits.

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
the list). Each entry also lists its requests' final response `statuses` in order, and
`unanswered` counts any with no answer when the step ended. Nothing refused them; the
list exists so you can catch writes you did not intend. Telemetry, analytics and bot-sensor POSTs are normal and need no change.
So is an anonymous recent-search, prefill or search-state save the site fires when
you submit a search.

For a read tool, look for a write your own action caused, such as adding an item to
a cart, submitting a form, saving a preference or starting a checkout. If you find
one, change the code so it reads without causing it, for example by reading the
value from the page instead of clicking the control that changes it, and run it
again. Setting a read's location, filter, sort or option through the site's control is part of
the read, not a saved preference (the input schema above). For a write session, the list shows the commit your step caused and any
autosave, with the status the site answered: a 2xx or 3xx on the commit's route, with no
error after it, is what the writes skill confirms from. A 200 whose body reports an error, as
GraphQL can, did not go through. The list is the evidence for the `http` version, and any
other write is unintended and must not be in the composed script. `initiator` is evidence, not proof: `evaluated_script` is usually your own
page evaluation, `page_script` is the site's script (which your click can also
start), and `parser` is markup such as a form submission.

## Host incidents

The host records every request your code causes and blocks none. An execute or inspect result
may carry `hostIncidents`. The first model request may carry `hostIncidentsBeforeStart` for the
host's own entry-page load. The mint continued past each listed gap.

`hostIncidents` kinds:

<!-- pomerado:section core.incident-kinds -->

Unclear means possible. `websiteEffect: may_have_dispatched` makes that execution's
effect possible: reconcile current state before claiming success, and never repeat
a claimed example or an uncertain write blindly: in a write session or a maintenance
repair, read back whether the write happened first, and do the write only if it did not.
`hostBug: true` marks a suspected Pomerado defect, which the host has reported. On a
`dialog`, report it in your diagnostics and do not work around it. On an `observation_gap`
or `capture_unavailable`, note it in `finish_build` coverage and keep building. A gap never
stops a read. A write the gap covers has an unknown outcome, so never repeat it without the
read-back above.
<!-- pomerado:section core.standalone-completion:start

## Standalone execution and completion

Use the ordinary `defineOperation` API and existing Kernel-shaped browser calls above. `liveBrowser` is native Playwright and `pureFiles` is local computation. The host retains Guardian review, caller authority, source reads, questions, deadline/cleanup and no-replay rules. It offers no browser replacement or captured replay facility. An invalidated native executor ends this attempt; never use a new browser to repeat an uncertain effect.

Declare explicit input and output schemas, concrete types and bounds for each supported field. A detail read verifies the requested record identity and final page state.

`finish_build` returns the current integration files and schemas after shared checks. A read needs a successful example using supplied values. A write needs its original confirming act receipt and current source; compose it without running it again. Return the task result and honest evidence, not unsupported success claims.

Only the host asks for website credentials and only during `authenticate`. Give it the observed field selectors, slots, allowed identifier kinds, format and submit. No generated source receives the raw password; follow the same destination, stale field/focus, no-readback and code-handle rules as hosted execution. Correct a refused binding by reading the current screen. A rejected credential needs caller correction; do not resubmit it.

pomerado:section core.standalone-completion:end -->
