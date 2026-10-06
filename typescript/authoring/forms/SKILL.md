---
name: forms
description: Guarded native/custom selection, dynamic choices and consequential form completion.
---

# Author the site's behavior

Use Playwright locators and frame chains inside the call. Check unique target identity
separately from visibility/readiness and semantic completion. Arm relevant event
waiters before triggers, in the same call. Native dialogs go to the host through
`decideDialog`, as the core skill describes; do not click again while deciding a dialog.

`page.waitForLoadState("domcontentloaded")` may resolve for the document already
loaded. Pairing it with a click does not prove a new navigation has completed.
When the observed control navigates, arm a waiter tied to that transition before
clicking, then wait for the relevant result or explicit empty state under the
verified query. For an in-page update, wait for evidence that the new query has
completed. An immediate snapshot with an empty title and missing controls can be
a transition observation; it does not establish an empty business result.

<!-- pomerado:section forms.role-names -->

A committed selection can change a control's accessible name. During exploration,
reinspect its owned container to learn the committed state. If a later action needs
that control, locate it by the observed label and value instead of reusing an exact
name from the empty control; an airport code, for example, may be in the label while
the value contains its city or full name. Read confirmed background values before
opening a modal, which can hide those controls from the accessibility tree. A timeout
does not identify which of these occurred;
use its named phase and current evidence before diagnosing or changing the locator.

Drive every field from the input. Choose the option that matches the input value, by
the option's value or its observed label pattern, and read back that the field took it.
Never click a label or option copied from the example, and never reject an input value
the schema accepts. A closed list of options stays an enum of the site's options. For an
autocomplete, typeahead or searchable combobox, whose options come from a query, type the
caller's value and pick the suggestion that matches it: an exact code or name match wins,
and nothing matching or several matching equally is `InvalidInput` (core skill, the input
schema).

Fill every dropdown and date control with the SDK's form controls: import
`formControlsCode` from the runtime, put it at the top of the call's code, and call its
functions on your verified locators. `chooseOption(control, wanted)` chooses the one
option of a native select or a custom ARIA dropdown (a combobox, or a button that opens a
listbox) whose label or value is one of `wanted`, a list of the input's spellings
(`["CA", "California"]`). It opens the dropdown, searches only the listbox it owns, types
into one that filters as you type, scrolls one that renders options as it scrolls, refuses
a missing, disabled or ambiguous option, and reads back the committed choice.
`fillDate(control, isoDate, format)` fills an ISO date into whatever date control the page
has: a native date input, a text box in `format` (typed key by key when an input mask
rewrites it), or one part of a split date (`MM`, `MMMM`, `D`, `YYYY` and so on) in a text
box, a select or a dropdown, whose option it matches by number or month name. Each
throws an `Error` named `FormControlFailure` whose message is a fixed reason, never a
value. `references/dates-and-dropdowns.ts` fills a split date and a custom dropdown, and
`references/selection.ts` a native select. A picker whose options come from the server
for each typed query needs its fresh-query signal: `references/custom-selection.ts`
handles one observed combobox that owns one visible ARIA listbox through `aria-controls`.
It searches only that listbox, waits for the site's current-query marker, clicks one
option by stable key and reads the committed choice from the site. A dialog launcher and its inner
query field have different roles: establish their ownership and mechanics first.
The compiled `references/dialog-picker.ts` example shows one observed dialog-style
picker with a separate launcher and inner query input. It waits for the active
named dialog, fills its query field, waits for the site's current-query marker,
requires one active matching option, and verifies the committed key after one
click. These examples complete one selection, so their committed-state readback
validates that final result. Their names and `data-query` marker are synthetic site
observations, not selectors or readiness rules for other websites. When adapting a
picker into a larger flow, establish its popup ownership and fresh-query signal to
choose the right option; read the committed state during exploration, when the next
action needs it, or as part of validating the requested final outcome.

<!-- pomerado:section forms.selection-intent -->

Playwright `locator.count()` and `locator.isVisible()` are immediate observations,
not waits. After opening a popup, wait for its owned, named container and requested
option to become visible before checking uniqueness. For a known popup locator,
use `await popup.waitFor({ state: "visible", timeout: 30000 })` in the call; apply
the same bounded wait to the exact option within that popup. A zero count directly
after a click does not establish absence. Inspect the post-action accessibility
snapshot before changing the selector or attempting another action.

A filled query plus a visible listbox can still show the previous response.
Wait for observed current-query readiness and the relevant owned option; do not
label an old result window with the new query generation. A matching old option
alone does not establish it.

When an overlay such as a cookie or consent banner covers the target, dismiss it with any
of its controls, including accept.

Date ranges, calendar-only pickers, validation messages, uploads, staged forms and
autosave need site-specific semantic checks. A date field that takes typing goes
through `fillDate`; one that opens a calendar and takes no typing does not.
`references/dates-and-files.ts` picks a calendar date by full `data-date` within an
owned popup, and chooses a file whose base64 bytes are decoded with `Buffer.from` in
the call. Beyond the SDK's form controls, do not invent a universal widget resolver. A
field change, file upload or draft creation may already be a website write.

## Multi-step forms

<!-- pomerado:section forms.saved-steps -->

<!-- pomerado:section forms.step-rules -->

Expose prerequisite resolvers for valid choices. A prepare/confirm flow binds the
draft to the account and requires caller-expected item, quantity, amount/currency
and destination. Read current terms immediately before commitment; fail with a
specific correction when changed. Use server quote/version checks where available;
otherwise report the read-to-submit race. Ask about each add-on and pre-selected
paid option, saved payment and private detail included; never keep or clear one unasked.
Ask about an optional field only when it is core or relevant to the intent or the
flow, not about every one. Every optional field the flow offers is still an optional
input of the tool, wired to its control, even when you do not ask about it, such as
economy or first class on a flight search; left unset, it keeps the page's default.
A control with exactly one possible value, such as a select or radio group with a
single option, is not a question, and neither is one the input or an
earlier answer already settles; an add-on toggle, a pre-selected checkbox or a lone
saved payment method is still a yes-or-no choice to ask about. Confirm by meaningful resource/readback, not merely a generic toast or
200 response.

Once that read-back matches the request, call the context's `verified()` just before
returning, so the run reports the write as landed; a confirmation the site shows for
this submission is `verified({ confirmation: "message" })`, as the writes skill
describes. Without it the write stays a possible effect. Never call it for a toast,
a status code alone or a missing confirmation, and make no execute call after it: a
later call makes the effect possible again. Missing confirmation preserves uncertainty; it
does not authorize another submit.
<!-- pomerado:section forms.fixture-checks:start

## Standalone fixture checks

Use the same supplied-input/observed-control rules and browser helper APIs. Check pure parsers with `pureFiles` and supplied fixtures; verify actual interaction and final state with bounded `liveBrowser` steps. Never invent a live field value merely to test a control.

pomerado:section forms.fixture-checks:end -->
