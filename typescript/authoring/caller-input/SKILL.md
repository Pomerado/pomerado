---
name: caller-input
description: Ask the run's caller mid-run for what only they know, such as a choice only the page offers or a code the site sends, then continue in place.
---

# Ask the caller during a run

Try first. Ask only for what the page or the caller uniquely knows at that point:

- a choice whose options exist only once the run reaches them: the open seats of the
  flight the caller just chose, the delivery slots for the cart the run just filled, or
  which of the account's saved travelers or addresses to use;
- a code the site sends during the action, such as a confirmation code by text or email;
- a fact only the caller has that the site now asks for.

<!-- pomerado:hosted:start
Use a published input instead whenever the value is stable and the caller can supply it
up front, such as a flight number, a date or a quantity. Never ask for a password, a
username or any other login: the host asks for a login itself and signs in. Never ask
for something the page shows, for permission to proceed with the operation the caller
already asked for, or to solve a CAPTCHA.
pomerado:hosted:end -->

## Declare, read, ask

<!-- pomerado:hosted:start
1. Declare every question the run may ask in the contract,
   `defineOperation({ name, input, output, questions }, ...)`, by id, with its `type`
   and a short `prompt`. The publication review reads these declarations once, so the
   prompt names the choice or value, never a private value. Write `questions` as a plain
   literal inside the entrypoint's own `defineOperation` call: during the build the host
   reads it from that source, not from the running script, and a computed or imported
   declaration declares nothing, so every question is refused as `Undeclared`. Each question
   the example asks is also reviewed before the build's owner sees it.
   - `{ type: "choice", prompt, allowOther? }`: one option; `allowOther` lets the caller
     type their own answer, returned as `{ other }`. Own text that repeats exactly one
     offered option's label (or its listed form entry, `id (label)`) returns that option.
   - `{ type: "multi_choice", prompt, minSelections?, maxSelections? }`: several options,
     at least one unless `minSelections` says otherwise, at most the options offered.
   - `{ type: "text", prompt, maxLength? }`: free text.
   - `{ type: "confirm", prompt, followUp? }`: yes or no, returned as `{ confirmed }`.
   - `{ type: "secret", secretKind, prompt, maxLength? }`: a code the site sent
     (`one_time_code`), an authenticator code (`totp`, which a saved login's TOTP fills
     without asking) or other private text (`private_text`). It stays out of traces,
     logs and the minting model. A secret you ask during the build with `request_input`
     comes back to you as a handle such as `{{secret.s1}}`, which the host fills in only
     when your explore, test or `act` source runs live, and only where it is the whole
     string passed to `fill`, `type` or `pressSequentially` or a field of a request to this
     site (core skill); the published script never holds a handle and asks for the value
     with `ask` instead.
2. For a choice, read the options in the execute call that reaches it and return them as
   plain JSON. Each option has a `value` the script acts on and a `label` the caller
   reads. Values are unique within a question. Offer only options the page will accept:
   skip taken seats, disabled slots and sold-out items. The value never leaves the run;
   the caller sees only the label.
3. Mark an option taken from the caller's own account (a saved traveler, address, card
   or account) with `accountSpecific: true` and a `maskedLabel` that keeps it
   recognizable without its numbers or email, such as `"Jane D. •••• 7890"`. The API
   and MCP show the masked label with a notice; only the owner's protected page shows
   the full label. A masked label that still shows five or more digits or an email
   address is replaced by the label's last four digits or a numbered placeholder.
4. Ask once for everything the step needs, between two execute calls:
   - `await ask("code")` returns that question's answer;
   - `await ask(["seat", "note"])` returns one answer per id;
   - `await ask({ seat: { options: seats }, code: {} })` passes a choice's options, and
     nothing for the other types.
pomerado:hosted:end -->

<!-- pomerado:hosted:start
   One ask takes up to eight questions, with up to 50 options per choice. A choice
   returns the chosen `value`, a multi-choice an array of values. Write answers into
   the next call's code with `JSON.stringify`.
pomerado:hosted:end -->

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

<!-- pomerado:hosted:start
A read build's example run, or a write build's `act` step, asks the build's owner
through the same request, and the answer comes back to the running script. Guardian
reviews each question first. When it asks for a rewording, nobody is asked, the `ask`
fails and the execution's result carries `scriptQuestion` with Guardian's rationale:
change the declared question as it says and execute again. If the
owner does not answer in time, the build ends as `no_response`; there is nothing to
retry, and a write step after one that sent something is reported as a possible
change. Do not turn an account-specific choice into a published input to work around
a question.
pomerado:hosted:end -->

`references/caller-choice.ts` books a seat on the caller's chosen flight: it asks for a
seat and a saved traveler once the flight's seat map is shown, then books once and calls
`verified({ confirmation: "message" })` after reading the confirmation back.
`references/caller-code.ts` asks for the code the site sends to confirm an address
change and enters it on the same page.
<!-- pomerado:standalone:start

## Standalone protected answers

Declare questions in the operation contract using the existing SDK schema and ask through `ask`. Ordinary answers are caller input, not extra authority. A `secret` answer is delivered privately for its declared purpose; during minting it returns an opaque handle. Use that handle only as a whole value at an authorized destination, never transformed, logged, returned, stored or read back. Website login credentials are requested only by the host during `authenticate`; TOTP/one-time codes are caller-supplied, with no stored seed automation.

pomerado:standalone:end -->
