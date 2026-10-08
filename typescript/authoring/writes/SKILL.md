---
name: writes
description: Do a write build's requested task once as a live act session, confirm it, then compose and publish its script without running it again.
---

# Do the task once, then compose its script

A write build changes something real on the caller's account: an order, a booking,
a submitted form, a saved profile. There is no practice run. The write is the whole
task the request asks for, done once, live, with the caller's values, as a series
of `act` steps. When the caller's input is empty (`{}`), pass the request's values and
the owner's answers as `exampleInput` (JSON text) on each act step that needs them. The
first act step that passes it fixes it: later steps repeat it unchanged or omit it, and
every step from then on runs that one input. Decide from the
request and the site which inputs are required, and keep them required. An optional
input plus a declared question the tool asks before any effect is only for a value the
request genuinely leaves open; never make a value the request states optional with
nothing that asks. It may take several write steps: filling in and advancing a
multi-step form, choosing options, saving, then submitting. Drafts, autosaves and the
saves a site makes at each step along the way are part of that one task. You never
redo the whole task, and never redo a step that finished; run a step again only when
a fresh read of the page shows it did not finish, or the task cannot complete without it. Then you compose the
published script from what those steps did and publish it. Nothing runs again.

A read build may search, filter and query, but may not fill in or advance a form that
saves data on the site, save or submit anything; a task that needs that is a write build.

## When a read build finds it needs to write

When a read build's task turns out to need that (a form that saves each step, a search
that is really a booking), ask the owner once with `request_input` and `writeUpgrade: true`:
one `choice` question with the option ids `read` and `write`, whose prompt says in one or
two plain sentences what the build would change and why the task needs it. Ask as soon as
exploration shows it, and before any live `example`: a job that ran a live read example
cannot become a write. The host writes the two answers' labels. Guardian reviews it first.
A `write` answer makes this a write build in place: every later step is reviewed under
write authority and the rules below, what you explored stays valid evidence, and the first
`act` step starts on the site origin page. A `read` answer keeps it read-only: finish what a read
can do, or end and say the task needs a write build. An answer in the owner's own words approves
no write either: follow what they said, and ask again if they asked for the change.

## Before the session

Sign in first when the site needs it (the auth skill: read-only `explore` to find
the login, then `authenticate`). Before the first `act` step you may still explore
read-only, for example to read the first page's options, but never fill, select,
add, save or submit anything there.

Read the path's options with read-only exploration where you can, then ask with
`request_input` about each add-on, pre-selected paid option and saved payment you saw
that the caller's input does not settle, and about any other option that is relevant or
important to the request (delivery, seat or insurance choices, which saved card or
address to use). An optional field that matters little keeps the page's default, and is
still an optional input of the script. Ask only about options the site actually shows. A control with
exactly one possible value (a select or radio group with a single option) is not a
question, and neither is one the input or an earlier answer already settles; an add-on
toggle, a pre-selected checkbox or a lone saved payment method is still a yes-or-no
choice to ask about. Never keep, clear,
accept or decline one of these unasked. Credentials never go through a question; the host's
protected form owns them.

During the session:

- Before a committing step, read the selected options and total from the current
  page or an available read-only summary. Use a review page when the site has one;
  a separate review page is not required, and submitting a form is never a way to
  discover whether one exists.
- Make the commit step check that no option the input does not settle is selected,
  and fail before clicking commit if one is.
- Before committing, read back from the page what you are about to submit and check
  each value against the caller's input, in the session and on every branch of the
  composed script. Fail before the commit if one does not match. Never read back a
  field filled with a secret handle.
- If a step meets an option the input does not settle, stop that step before choosing
  it and ask. A `request_input` question during the session waits in place; a choice
  that exists only on the page mid-flow, such as a seat on the flight just chosen, is
  a declared `ask` in the next `act` step's script (the caller-input skill). An
  answered question settles the option. Check the page again before continuing.

## The session

Author each step as a Kernel script under `src/` with the caller's input schema (the
core skill), and keep the flow's calls in a module the composed script will import
too. Run each step with `execute` purpose `act`, target `liveBrowser`.

<!-- pomerado:section writes.session -->

<!-- pomerado:section writes.session-limits -->

## Compose and publish

Write `src/tool.mjs`, the `playwright` version: a Kernel script running the whole
flow from the site origin page and the caller's input, with the same calls, the commit
exactly once, and the same confirmation or read-back the session recorded. The call
that reads it, the commit call or a read-only call after it as in the session, reads
only what the session's confirming step read and returns it; the script matches those
values to the input and calls `verified()`, as the references do. Nothing runs live
before publishing, so a read the session never made, added to that call, can fail
after the write has landed, and a run that hits it reports a successful write as
possibly completed. Declare the script's contract, `defineOperation({ name,
input, output, write: { confirmation: "readback", commits: ["place-order"] } }, run)`
(or `"unverifiable"` when the site shows neither a confirmation nor the saved state),
marking the same commit steps as the session. A script declared `unverifiable` cannot call
`verified`. One that declares no commit marks is refused as `commit_marks_undeclared`,
and one that declares a mark no `act` step of the session entered is refused as
`commit_marks_unentered`. If the declaration names the wrong marks, correct it to
match the marks the session actually entered. If the completed session entered no
marks, it cannot publish: changing its source or entering a mark in a later read
cannot show that the earlier commit was marked. End the build and explain that
the task completed but its commit steps were not marked; never repeat the write
to add them.

Every option the session met on its path is an input of the script, add-ons and
pre-selected defaults included: required when the site requires a choice, optional
otherwise. The script sets each option from its input. An unset optional input leaves the
page's default, as in a read. The exception is an add-on, a pre-selected paid option or
a saved payment: each must be explicit, so the script never keeps, clears, accepts or
declines one the input leaves open, and fails before the commit instead. An
account-specific value, such as a passenger, loyalty number, saved card, address or
account ID, is a free-form input, never an enum member, example or default in the
public schema (core's input schema rules).

The composed script publishes without ever running end to end, so it ends with a check that
tells whether its action succeeded: the site's confirmation for this submission, or a read-back
of the saved state matched to the input, unless the site offers neither; then declare it
`unverifiable`. Compose it from the steps that worked, also when a commit step returned an
uncertain result and a later read-back showed the write landed.

<!-- pomerado:section writes.alternate-version -->

Call `finish_build` with entrypoint `src/tool.mjs` and the confirming step's
`executionId` (for an `unverifiable` write, the step that committed). The host reads
the script's contract offline, checks that the input the session ran (the caller's own,
or the `exampleInput` the first act step to pass one fixed) decodes against it and that
the named step recorded the declared confirmation, then publishes. A
`not_published` reason of `confirmation_undeclared`, `confirmation_unrecorded` or
`contract_input_mismatch` means correct the source and call `finish_build` again;
never run the write again.<!-- pomerado:section writes.finish --> `write_not_submitted` means no
`act` step that Guardian labelled a write ran on the site, or the outcome review found
that every one of them did not happen. Read back first. If
the write happened, publish with `readback`. If the read-back shows it did not, do the
write once, marking its commit step, and read its confirmation. If no read-back can tell,
never submit again: publish it as `unverifiable`. Filling a form or an offline example
is not the write. An unreadable step output never justifies a run either: the write
publishes with its output recorded as unavailable.

After a `not_published`, live `act` steps are open again while the write session is still
open (a commit that recorded its confirmation stays done), on a fresh browser on a new,
empty profile: read `page.url()` first and sign in again when the build signs in. Before
running a commit again, run an `act` step that only reads the site or the account to see
whether the earlier commit landed, and never resubmit one that did. If no read-back can
tell, never submit again. Guardian reviews every
`act` step and denies one that would repeat a finished commit.

Guardian labels each step it allows `read`, `write` or `authentication`, and every step
that changes what the site keeps is a write, a draft, a saved field or a cart included.
A separate outcome reviewer then judges each write from your history and the host's
records. The host refuses a step that runs an earlier write's entrypoint again until
that review finds the write did not happen, so read back in a step of its own. When a
tool result's `hostNotices` holds an `outcome_review_observation`, the reviewer needs
that readback: run it in a step that changes nothing when you can.

## What runs do with it

<!-- pomerado:section writes.run-outcomes -->

See `references/write-session.ts` for two steps and the composed script, and
`references/write-readback.ts` for a read-back confirmation tied to its submission.
<!-- pomerado:section writes.completion:start

## Standalone write completion

Perform the authorized task once through live `act` steps, preserving the shared effect journal and caller choices. Wait for actual confirmation and read back committed state. Declare `verified`, `unverifiable`, and their confirmation behavior accurately using the existing SDK; a missing result alone never proves the write absent.

Keep steps small and read the actual state after each submission. A button named Continue, Next or Save may save a draft, persist that page, or finish the task immediately; its label does not establish that another review or final submit follows. Mark every step that can change saved state, including autosaves, saved form steps and payment submissions whose next screen is unknown: call `enteringCommit("place-order")` right before the execute call that can send the change and declare the names in order as `write.commits`. Use the same marked helper in the session and the composed script. If a call returns an unexpected page or fails while waiting for an assumed review, read back before another submission: the task may already be complete.

Compose `src/tool.mjs` from the original reviewed steps and confirming observation. You may check source/schema and pure helpers offline, but never run the composed write live again. Call `finish_build` with its confirming `executionId`, declared entrypoint and honest coverage. It returns integration files/schemas. When a write's outcome remains uncertain, report that uncertainty and preserve the no-replay rule.

If the composed contract names the wrong commit marks, correct it to match the marks the session actually entered. If the completed session entered no marks, it cannot finish: changing its source or entering a mark in a later read cannot show that the earlier commit was marked. End the build and explain that the task completed but its commit steps were not marked; never repeat the write to add them.

pomerado:section writes.completion:end -->
