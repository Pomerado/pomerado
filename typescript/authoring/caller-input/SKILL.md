---
name: caller-input
description: Ask the run's caller mid-run for what only they know, such as a choice only the page offers or a code the site sends, then continue in place.
---

# Ask the caller during a run

Try first. Ask only for what the page or the caller uniquely knows at that point:

- a choice whose options exist only once the run reaches them: the open seats of the
  flight the caller just chose, the delivery slots for the cart the run just filled, or
  which of the account's saved travelers or addresses to use;
- a code the site sends to confirm a protected action after sign-in, such as a confirmation code
  by text or email. A code that is part of signing in is the host's: a `code` field of the
  `authenticate` step, never a question;
- a fact only the caller has that the site now asks for.

Never ask for a value the request, the input or an earlier answer already supplied, a private
one included: use that value. In the tool, take it from its input, or a private one, such as
part of an identity number, through a declared `secret` question, never a plain-text field.
When question review finds a question redundant, remove the ask and use the supplied value; a
reworded question still asks for it again. A placeholder that stands in for a redacted value,
such as "[redacted value]", supplies nothing. A supplied value the site rejects, or two that
conflict, can still need a question, one that names the actual problem.

Work the request already covers proceeds without a question, such as finding the right field
or choosing among alternatives the request already allows. A supplied value the site does not
offer, such as an unavailable option, date or quantity, is not such a question: the tool throws
`InvalidInput`, as .agents/core/SKILL.md says, and never substitutes another value. Asking the
owner to revise it or stop is the minter's own `request_input` question while it builds, as
`AGENTS.md` says.

Use a published input instead whenever the value is stable and the caller can supply it
up front, such as a flight number, a date or a quantity. Never ask for a password, a
username or any other login: the host asks for a login itself and signs in. Never ask
for something the page shows, for permission to proceed with the operation the caller
already asked for, or to solve a CAPTCHA.

## Declare, read, ask

<!-- pomerado:section caller-input.declare -->

   One ask takes up to eight questions, with up to 50 options per choice. A choice
   returns the chosen `value`, a multi-choice an array of values. Write answers into
   the next call's code with `JSON.stringify`.

The run waits with its browser open and its active budget stopped, and the next call
starts on the same page. Continue from there. Do not reload, search again or repeat an
earlier step, and never resubmit anything the run already submitted. The wait can be
long, so in that next call confirm the page still shows the chosen option before acting
on it.

## When no answer comes

`ask` throws `ScriptInputFailure`:

- `NoResponse`: the caller did not answer within the request's window (at most ten
  minutes, less when the job's window ends sooner). The run fails as `no_response`. It
  is never retried or repaired, and its result says whether a step before the question
  may already have changed the site.
- `Unavailable`: the host could not put the question to the caller, or the answer did
  not fit the question.
- `Unauthorized`: the caller's access to the job was revoked while the run waited.
- `Undeclared` or `InvalidOptions`: the ask names an id that `questions` does not
  declare, gives a choice no options or duplicate values, gives options to another type,
  or offers fewer options than the selection bounds need.

Let these failures end the run. Never catch one to pick a default, the first option or
a guessed value. For a write, ask before its consequential step when the site allows
it, so an unanswered question leaves the site unchanged. A hold or a cart the run made
before the question is reported as a possible change when no answer comes.

## During a mint

A read build's example run, or a write build's `act` step, asks the build's owner
through the same request, and the answer comes back to the running script. Guardian
reviews each question first. When it asks for a rewording, nobody is asked, the `ask`
fails and the execution's result carries `scriptQuestion` with Guardian's rationale:
change the declared question as it says and execute again. If the
owner does not answer in time, the build ends as `no_response`; there is nothing to
retry, and a write step after one that sent something is reported as a possible
change. Do not turn an account-specific choice into a published input to work around
a question.

`references/caller-choice.ts` books a seat on the caller's chosen flight: it asks for a
seat and a saved traveler once the flight's seat map is shown, then books once and calls
`verified()` after reading the confirmation back.
`references/caller-code.ts` asks for the code the site sends to confirm an address
change and enters it on the same page.
<!-- pomerado:section caller-input.protected-answers:start

## Standalone protected answers

Declare questions in the operation contract using the existing SDK schema and ask through `ask`. Ordinary answers are caller input, not extra authority. A `secret` answer is delivered privately for its declared purpose; during minting it returns an opaque handle. Use that handle only as a whole value at an authorized destination, never transformed, logged, returned, stored or read back. Website login credentials are requested only by the host during `authenticate`; TOTP/one-time codes are caller-supplied, with no stored seed automation.

pomerado:section caller-input.protected-answers:end -->
