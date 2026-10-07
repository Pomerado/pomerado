# Changelog

## Unreleased

### Breaking changes

- `misplacedHandleRule` is no longer exported from `pomerado/core/mint/secret-handles`.
  - Migrate by calling `secretHandleRefusal`, which returns the whole refusal.
- A local build follows these read and write rules:
  - A read build may run its live example again. Its owner may approve turning it into a write build before it runs one.
  - `testInput` runs only on a read build's live test, as JSON text, at most twice per attempt. Any other use is refused before review.
  - `exampleInput` is a JSON object and runs only when the caller's input is empty: on a read build's example, or on a write build's act steps. The first act step Guardian allows fixes it for the session. Later act steps run it, and may repeat it unchanged or omit it. A different one, or one added after the session started without it, is refused before review. Guardian reviews these act steps under a stricter effect: every value in that input, and any add-on or optional purchase the step chooses, must come from the request or an answered question, while values the page supplies follow the general policy. Publication decodes the composed contract against that input.
  - A write build refuses a live example or live test, and a live explore once its first act step ran. An unchanged act step right after one that may have changed the site is refused until another act step reads the result.
  - Once a write session started, an `authenticate` step without `signInStep` is refused, since it would run the agent's own source outside the session's act steps. A `signInStep` the host fills still runs.
  - `inspect` and `residual` are refused before review. A local build keeps no write maintenance, so it has no possible write to recover.
  - A secret handle is refused before Guardian reviews the step, instead of failing after review, when this attempt never issued it, when it sits in the source an example publishes, or when it is misplaced. A misplaced handle's refusal names its file and line. An offline step runs handle text as written.
  - A Guardian outage is retried for up to five minutes before the step reports the review as unavailable. A spent model quota ends the build with `model_quota_exhausted`.

### Other changes

- Each Guardian review of a local build carries that step's own context: the effects its kind of step may have, the files its entrypoint imports, the last six step results, the input schema of the latest example or contract run, the page the browser last showed with a redacted readable capture, a command's sandbox limits, steps still running and whether the browser has opened yet. A step that starts on a reset page, such as a live example, gets no page, nor does a question it asks while it runs. A question review gets no allowed effects. A read step's effects keep the limits the request states, such as a date range or filter, and tell Guardian that context the request gives, such as today's date, is no filter unless the request applies it.
- The minter and Guardian read today's date and time in UTC from the build's observations. Guardian's review of a contract run says what that run does.
- `pomerado/core/mint/review-context` and `pomerado/core/mint/step-checks` export these rules for other hosts, and `secretHandleRefusal` joins `pomerado/core/mint/secret-handles`.
- Guardian's review of a contract run carries the input that run decodes: the example's input, or the write session's.
- A page with more than 10,000 elements is not captured for Guardian, which reads that the page was too large. A page that does not answer within the capture's time, as when its scripts keep it busy, is not captured either, and the browser keeps running. A capture is cut to 256 KiB in the browser, before it reaches the host.
- A caller's secret is also redacted in the forms a page or URL shows it: trimmed, with its whitespace collapsed, with each `'` doubled or its control characters escaped as a page snapshot writes them, and percent-encoded as `encodeURIComponent` or a form writes it, or as Chromium writes it into a URL's query, path or fragment, in either hex case. A capture cut at 256 KiB keeps no prefix of a secret the cut split. A secret that cannot be percent-encoded no longer fails its registration.
- The core authoring skill has a write build whose caller sent an empty input pass the request's values as `exampleInput` on each act step that needs them, as a read does on its example. An optional input plus a declared question is only for a value the request leaves open, and a required field is never made optional with nothing that asks.
- Guardian's question review counts only the host's own masks and `{{secret.<id>}}` handles as stand-ins for a supplied value. A placeholder written into the intent text in place of a value, such as `"[redacted value]"`, supplies nothing, so a question asking for that value is not redundant. The caller-input skill says the same.
- Guardian's execution review applies its `intent_derived` input rule to a write's act step as well as a read's example.

## 0.3.0

This release lets the person answering a minting question use their own words on any choice, records each Guardian review attempt's timing, stops runs of a built integration from calling Guardian, and starts runs, live examples and a write session's first step from the site root. It changes answer and question shapes that 0.2.0 cannot read: upgrade every host that reads stored requests or answers before any that writes them.

### Breaking changes

- `ValidAnswer` values change type. A choice's value is `ChoiceValue` (`string | { other } | { option, note }`), and a multiple choice's is `MultiChoiceValue` (`readonly string[] | { options, other?, note? }`). Code that reads `.other` after a `typeof value !== "string"` check, or treats a multiple choice's value as an array, no longer compiles.
  - Migrate with `pickedOption(value)` for a choice's picked option, and an `"options" in value` check for a multiple choice.
- `ChoiceQuestion` gains `allowNote`, and `MultiChoiceQuestion` gains `allowOther` and `allowNote`. Every choice and multiple choice the minting agent asks carries `allowOther: true, allowNote: true`.
- `InvalidAnswer`'s `reason` adds `note_not_allowed`, for a note on a question without `allowNote`.
  - Migrate by giving any exhaustive check or list of reasons the new one.
- `AgentRequest`'s choices are `ProposedChoiceQuestion` and `ProposedMultiChoiceQuestion`, without `allowOther`. A `request_input` call that sets `allowOther` or `allowNote` is answered `question_invalid` and asked again without it.
  - Migrate any recorded model responses that set `allowOther`.
- `isReadOrWriteChoice` now accepts a read-or-write choice with `allowOther`. `AnsweredQuestion` gains optional `other` and `note`.
- Version 0.2.0 cannot read requests or answers in the new shapes: its strict decoders refuse the new question fields, and its `validateAnswer` and `validateKeptAnswers` refuse `{ option, note }` and `{ options, … }` as `malformed`. Upgrade every host that reads stored requests or answers before any that writes them, and do not roll back once they are stored.
- Guardian now reviews the read-or-write question the minter asks first, since it accepts the person's own words. A host whose question review refuses that question must allow it, or the first turn fails.
- New exports: `ChoiceValue`, `MultiChoiceValue`, `pickedOption`, `ProposedChoiceQuestion` and `ProposedMultiChoiceQuestion` from `pomerado/core/runtime/input-request`, and `withOwnWords` from `pomerado/core/mint/contracts`.
- Runs of a built integration, through `run` or a served integration MCP, no longer call Guardian and need no model key. Guardian still reviews minting. A run no longer checks its `intent`, `effect` or `authenticationOrigins`.
  - Migrate by checking a call's intent and effect in your host before it runs, if you relied on the run doing it.
- `pomerado run` no longer requires `--intent`, and it ignores `--intent` and `--effect`.
  - Migrate by dropping both flags. Neither limits what a run does.
- A run, through `run` or a served integration MCP, starts at the site root of its URL and no longer loads the URL's path. `pomerado run` and each served call start fresh, in a new browser context. A library caller's run closes the scope's other tabs and keeps its cookies and storage.
  - Migrate by having an operation that needs a deeper page navigate there itself, as its example already starts at the root.
- A live example, a live test and a write session's first `act` step start at the site root after other tabs close. A build that hasn't signed in clears the cookies and site storage exploration left. A signed-in build restores the session saved right after sign-in, or keeps its session when none was saved. Later `act` steps, explorations and inspections continue the current page. The first live step that isn't reset still loads the request's URL.
  - Migrate by writing example, test and first-step source that runs its flow from the root, as the authoring guide already asks.
- A sign-in check counts only after the build's own sign-in steps typed the login's identifier and a password or code, or the user completed an approval. A code the site sent for that sign-in, which the agent asked for, counts as its code once an explore's `fill`, `type` or `pressSequentially` call entered it in the page and completed. Source that only holds the code counts nothing. Before that, the check returns `signedIn: false` with `failed: "credentials_not_submitted"` and leaves the build signed out. Every sign-in step drops the session saved after the last sign-in, a check included, and a check after a confirmed sign-in starts a new one, so checking again is refused.
  - Migrate by sending the sign-in screens' `signInStep` fields before the `signedIn` check, and checking once per sign-in.
- `MintDependencies.priorAttemptMayHaveChanged` is removed, with the notice it added to the agent's first input.
  - Migrate by giving the agent your own notice through `drainStartIncidents` if a restarted write build must read back before it writes again.
- In `pomerado/core/destinations/autofill-step`, `AutofillInspection.screen` adds a required `origin`, which `inspectAutofillStep` sets. A filled `AutofillStepReport`'s `submit` adds `"stayed_disabled"`: the fields were filled, but the submit stayed disabled through the wait, so the host never clicked it.
  - Migrate by setting `origin` on any inspection you build yourself, and by handling `"stayed_disabled"` in any exhaustive check on `submit`.

### Other changes

- Guardian diagnostics record each review attempt's interval, failed source-read duration, session permit wait, and scheduled retry backoff. Follow-up rounds for a skipped entrypoint read stay inside one attempt, and its closing record counts them. A private host kind, whose transcript is not kept, can forward its finite model and tool timing through `observeModelTrace`.
- `pomerado/runtime` exports `CalendarDate`, a date-only `YYYY-MM-DD` schema that refuses a date that does not exist, such as `2026-02-30`, with the calendar check `fillDate` already made. Its JSON Schema is `format: "date"`. It sets no date range. The forms skill and the date examples use it, and say that a range's order, a past date or a booking limit is the tool's own `InvalidInput` check.
- A generated integration's MCP tool names the failing input path and rule when arguments do not match its schema, and a failed job reports the tool's own `InvalidInput` message.
- The person answering a minting question may always answer a choice or multiple choice in their own words: their own text instead of an option, or a note beside the options they pick. The host marks every choice and multiple choice the minting agent asks with `allowOther` and the new `allowNote`, and Guardian now reviews the effect question too, since its answer may be free text. An answer in the person's own words to a read-or-write question approves no write: the effect question is asked again, and a write upgrade leaves the build read-only without settling it.
  - A choice answer may now be `{ "option": id, "note": text }`, and a multiple choice answer `{ "options": [ids], "other": text, "note": text }` (`other` and `note` optional). `other` counts toward `minSelections` but not `maxSelections`, and unlike a choice's own text it is never turned into a pick.
  - Answered questions in Guardian reviews carry the person's `other` and `note`. A note counts as the person's own words for `ownerNamedOrigins`, unless it only repeats an offered option.
- Integrations generated by earlier versions still have README text that asks for `OPENAI_API_KEY`. They no longer need it.
- A failed run that has no more specific message now reads "Operation failed. Check the local browser and integration configuration." Minting keeps its message.
- `pomerado/core/runtime/start-state` holds the start-state decision (`startStateFor`, `shouldSaveSession`, `isFirstWriteStep`), the per-build `makeStartTracker`, and the page reset: `startPage` with its required `StartPageHooks`, `localStartHooks`, and the `resetPageCode`, `stopLoadingCode` and `saveSessionCode` browser code.
- A signed-in build's saved session must fit the page-code worker's 1 MiB result cap. A larger one fails the save and every later live step other than a sign-in step, and a new sign-in hits the same cap.
- Every merge to `main` publishes a canary, `X.Y.Z-canary.N`, under the `canary` dist-tag: `npm install pomerado@canary`. `latest` moves to the canary that Pomerado's hosted service promotes to production, so `npm install pomerado` gets the build production runs. The range it saves, such as `^0.2.1-canary.57`, also matches later canaries, so install with `--save-exact` or keep a lockfile. See [Releasing](docs/RELEASING.md).
- A host sign-in step fills a form whose submit is disabled, `aria-disabled` or in a disabled fieldset until the fields hold input. The host waits up to 5 seconds for the page to enable the submit, then clicks it, and never clicks it while it is disabled. It reads whether the submit is disabled the way Playwright's click does, which page scripts can't change. An `aria-disabled` wrapper keeps a submit waiting only when the submit itself has an ARIA role, as Playwright judges it. A page that changes the form's controls three times during the wait is refused. A submit in an `inert` region is still refused before anything is typed.
- Guardian's review of a host sign-in step shows the origin of the frame the step's controls are in, as the browser reports it, and no longer requires the submit to be enabled. The auth skill likewise lets the minter record a submit the page has not enabled yet.
- A write session step can carry `withheldConfirmation` when it read the site's confirmation but the host did not accept its result. It leaves the session open, so a later step that only reads the confirmation back confirms it. Publishing against the withheld step returns `read_back_required` unless `finish_build` passes `readBackUnavailable`, the reason no step can read the confirmation back. The host's `publish` receives that reason, screened. The step's receipt shows `withheldConfirmation` with an instruction never to repeat the write, and it keeps the attempt open for publication when live execution ends. A host that sets it must settle the step's entered commit marks for later act steps.
- Guardian's execution review treats the site's own page traffic as the website's behavior. Scripts, trackers and beacons the page loads, with whatever caller input the site gives them, are never a reason to deny or escalate, and the off-site rule judges only what the source itself sends. An anonymous recent-search or search-state save the page fires on a read's search is part of that read. A recording gap in a step result no longer stops live probes, and it still leaves that execution possibly dispatched.
- Guardian's question review no longer reads host sign-in rules, including an earlier review's text, as the owner forbidding sign-in. Only trusted intent or an owner's answer can. It no longer rewords a sign-in method or account question because sign-in is not yet proven required.
- The minter skills have it read back each value before a write's commit, on every branch of the composed script, and fail before the commit on a mismatch. They also accept a page's recent-search save as normal, and look everywhere the site keeps a value before calling it unavailable.

### Fixes

- A local edit the minter can't apply now says the edit was not applied and why. That covers a patch that doesn't match, a file that already exists or is missing, and a file past the size or file-count limit. The file is unchanged, and no new folder is left behind. These edits no longer report "Workspace edit outcome unknown".
- The minter's `read_source` now reads local workspace files. Through 0.2.0 every local read failed as unavailable, because the local workspace refused the one extra byte the minter asks for to detect an oversized file. A file past 8 MiB is still refused.
- Local runs stage authored source a level below the SDK, as the workspace guide describes. The documented `../../runtime/index.js` import from `src/` and the skill references' imports now load. Integrations saved with `../runtime/index.js` still run unchanged.

## 0.2.0

This release changes how a host embeds the minting core's authoring and which MCP entry a generated integration writes. Other standalone use through `pomerado`, `pomerado/mcp` and the CLI needs no change.

License: MIT from 0.2.0 (was AGPL-3.0-only through 0.1.2). No CLA.

### Breaking changes

- Authoring files carry standalone text with named sections, `<!-- pomerado:section ID -->`. Each ID starts with its file's key: the skill name in `<skill>/SKILL.md`, `agents.` in `workspace/AGENTS.md` and `guide.` in `workspace/README.md`. A section's standalone text, if it has any, is its default.
- `loadAuthoringSkills` and `loadWorkspaceGuide` from `pomerado/core/mint/skills` default to `"standalone"`, which renders each section's standalone text. `"hosted"` no longer renders host text from the package. It loads a directory the host composed first and refuses any section left in it.
  - Migrate by copying `getAuthoringDirectory()`, replacing every section with your own text, and loading the copy with an explicit `"hosted"`.
- The skill catalog lists only the skills the package ships: `core`, `auth`, `pagination`, `forms`, `writes` and `caller-input`. The `testing`, `recovery`, `captcha`, `browser-recovery`, `http-mcp` and `publication` entries are gone. The workspace guide installs only `README.md` beside `AGENTS.md`, without the four `reference/` sections. `writes` has one description in both modes.
  - Migrate by loading your own skills and reference sections beside the package's, in the order your model should see them.
- In `pomerado/core/runtime/provider-metadata`, `ProxySwitchSummary` is now `BrowserRecoverySummary` and `RetainedProxyError` is now `RetainedNetworkError`. Their shapes and values are unchanged.
  - Migrate by renaming the imports, or by declaring your own type of the same shape.
- `MintEntryNavigation`'s replaced-browser `reason` is open: `"sign_in"`, `"recovery"` or a reason the host defines and explains in `instruction`.
  - Migrate by giving any exhaustive check on `reason` a default branch.
- The optional `captcha_state` and `request_browser_recovery` tools get generic descriptions. `MintDependencies.hostToolDescriptions` takes a host's own.
  - Migrate by passing the descriptions your host relied on.
- A generated integration writes `mcp.json`, a standard `mcpServers` entry with no key, in place of `codex-mcp.toml`. Its README lists the add command for Claude Code, Codex and Gemini CLI.
  - `configPath` from `prepareIntegration()`, and `integration.configPath` in a finished `mint` job's output, now point to that JSON file instead of the TOML.
  - Authored source may no longer use these top-level names, compared case-insensitively: `mcp.json`, `.mcp.json`, `.vscode`, `.cursor`, `.codex`, `.gemini` and `.claude`. `deployment.json`, `mcp.mjs`, `readme.md` and `codex-mcp.toml` stay reserved.
  - Migrate by adding the integration with the command in its README, or by copying the entry in `mcp.json` into your client. Read `configPath` as JSON. Integrations minted earlier keep their TOML and still run.
- `MintFailure` adds the reason `definition_login_reference`. A host may refuse publication with it when a tool's definition quotes the build's account reference, and the agent is told which part to rewrite.
  - Migrate by giving any exhaustive check on `reason` a default branch.

### Other changes

- Seven headings that rendered empty in standalone mode now have standalone text, in `core/SKILL.md`, `auth/SKILL.md` and `workspace/AGENTS.md`.
- Section markers are checked strictly in both modes: an unterminated, unspaced, duplicated or foreign section, a stray end marker, a section inside a code fence and any other `pomerado:`, in any case, all fail the load.
- The `pomerado-mcp` bin starts when run through npx or a global install. Earlier versions exited without starting the server.
- The shared core skill suggests typed output: numbers for prices, amounts and counts with the currency or unit in its own field, ISO 8601 for dates and times, minutes for durations and one field per fact. These are suggestions, not checks.
- Guardian's question review allows a question about which sign-in method or account to use, or how to reach the sign-in, when the choices it names match what the page shows. The shared workspace guide says asking it is expected. Guardian also no longer rewords any question only because `allowedEffects` is empty.
- `ScriptQuestionDeclarations` refuses the whole record when any question id is invalid, instead of dropping that entry. A question id starts with a lowercase letter and uses only lowercase letters, digits and underscores, up to 64 characters.
- `MintDependencies.redactCallerText` lets a host remove private values, such as the build's account reference, from what the agent writes for its caller: a request's notice, prompts and option labels, and a blocked explanation. The agent's own transcript is unchanged.
- `MintDependencies.priorAttemptMayHaveChanged` tells the agent of a restarted write build that an earlier attempt may have changed the website, so it reads back before any write. A `not_opened` entry navigation may carry `reason: "prior_effect"` when the host skipped it for that reason.

## 0.1.2

- Guardian's upstream policy, adapted from OpenAI Codex, carries its Apache-2.0 notice, and the package ships `third-party/codex/LICENSE` and `third-party/codex/NOTICE`. Guardian drops the notice before the policy reaches the model.
- Failure-detail comments no longer name a hosted service's internal paths.
- `FailureSubCause` adds `browser_page_call_failed`, for a page command the browser answered with a failure, such as a script error or a timeout.
- This is the first release published with npm provenance.
