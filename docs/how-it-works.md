# How it works

Pomerado has three parts. The minter builds an integration, Guardian reviews the minter's work while it builds, and the runtime runs the result. A job model ties them to your MCP client. This page also covers the library interfaces, the line between this repository and other hosts, and the source layout.

## The minter

- The minter is a model agent with a local workspace and a real Chromium browser, driven through native Playwright.
- It reads the site, writes operation modules under `src/`, and runs them against the live site to check them.
- A live example, a live test and a write's first step start over at the site's root, after other tabs close. A build that hasn't signed in starts without the cookies and site storage exploration left. A signed-in build starts from the session saved right after sign-in.
- Its first live step opens the URL you gave, unless that step is one of those resets. Explorations then continue on whatever page the last step left.
- A build counts as signed in only after a request the page sent during its own sign-in steps carried the login's identifier, and one carried a password or code, or you completed an approval, and the page then shows the account. A code the site sent for that sign-in counts too once the agent asked you for it and an explore made a completed `fill`, `type` or `pressSequentially` call with it on a page, frame, locator or keyboard, in a frame on the site or on one of the sign-in origins you configured. A frame with no address of its own, such as `about:srcdoc`, isn't the site. Keys typed with nothing focused count only when every frame of the page is on the site or one of those origins. Waiting for the code field before typing the code makes sure the field is there when the typing starts. A page that already showed an account proves nothing. Every sign-in step drops the saved session, a check included, and a check after a confirmed sign-in starts a new sign-in.
- A signed-in build saves its session before its first live step after sign-in, other than another sign-in step. The save passes through the page-code worker, which caps a result at 1 MiB. A larger session, usually from a big IndexedDB, fails the save. Every later live step except a sign-in step then fails too, since each tries the save first. Signing in again hits the same cap.
- Before it sends a signed-in marker, the minter can test it with `check_signed_in_marker`.
  - The host compares the marker with the pages it saw signed out: the page of the build's first sign-in screen, just before the host types into it, and each page a reset cleared. It reads a page once it loaded, its network went quiet and its document went 1.5 seconds without a change: about 2 seconds after its load, for a fast page. It waits 3 seconds at most, and reads a page still busy then as it is. It keeps only a page on the site's origin that shows something. A page still busy at 3 seconds, or one that showed something only after its document went quiet, counts only where it shows the marker, never to show it absent. The host doesn't see what a page renders after it read it, so a signed-out header that renders more than 1.5 seconds after the page went quiet is missed. Once the host typed a sign-in value in the session, it keeps no sign-in screen's page, since builds in a session share cookies.
  - It then checks the page as it is, the marker's `openPath` or the site's root loaded again, and the newest other page the build explored once its sign-in sent the login. It loads that other page only when the current page shows the marker.
  - The loads move the tab. The host opens the agent's page again when that page showed the marker and isn't the direct answer to a form. Otherwise the tab stays where the loads left it.
  - Once a write session started, the check loads no page and reports itself unavailable.
  - The `signedIn` step refuses a marker that one of those signed-out pages shows.
- A failed write step that may have committed tells the minter to read the site back before any further write. The local host counts a step as possibly sent when it made a browser call, entered a commit mark or lost its result.
- Publishing a write first checks that its session may have sent the write. A step that recorded a confirmation, entered a commit mark or made a browser call counts. Only then is the composed contract read, reviewed and checked against the session.
- It finishes by publishing an entrypoint with JSON Schemas for the input and the output.
- The saved integration holds every file under `src/`, the entrypoint, and the files under `explore/`, `test/` or `scratch/` that they import. Every file under those four folders is saved instead when the workspace has a `package.json` or one of the folders holds `node_modules`, when a saved module reads or loads files another way, such as through `fs`, `createRequire`, a `#` import or Playwright's internal modules, or when one of the files they import is a WebAssembly module, a native addon, or an extensionless file that isn't JavaScript. Paths match in any letter case, as macOS loads files.
- It asks you questions through the job when it needs a login, a code or a choice.
- When a value you gave isn't available on the site, such as a sold-out date or an option the site doesn't list, it asks you whether to change it or stop. The question names your value and offers what the site has. It never picks another value for you.
- It gets 20 minutes of active work. Time spent waiting for your answers doesn't count.
- Its prompts and examples come from `typescript/authoring/`.

### Failures a build survives

- A diagnostic copy the host can't keep, such as an execution's diagnostics or a readable model transcript, is a recorded gap in the outcome's diagnostics. The build goes on, however many gaps there are.
- The raw record of each model call is the one required trace. A host that keeps one through `retainRuntimeRecord` must store it before the next model call. If it can't, the attempt stops with `hostFailure: "diagnostic_retention"`. A host without `retainRuntimeRecord`, such as the local host, has no required trace.
- A review whose evidence the host can't keep is a review outage. The minter may resubmit until reviews have been unavailable for the review outage budget, 15 minutes by default.
- An execution whose capture the host can't produce or screen comes back as a capture gap: its result is withheld and its effect is possible. A publication whose capture evidence is unavailable comes back `not_published` with `retryable: true` until the review outage budget runs out. Neither runs a write again.
- A publication dependency that stays unavailable, such as the registry, its source store, or a screening step or source read that names no file to fix, comes back with `retryable: true` until the review outage budget runs out.
- `report_blocked` ends the build only when Guardian allows the explanation, or when its review stays unavailable past the review outage budget, which leaves the caller only the reason's fixed sentence. An unavailable review comes back with `retryable: true` before that. When Guardian asks for a reword, the minter gets the rationale, and may revise the explanation, which Guardian reviews again, or withdraw it and go on.
- A `contract_input_mismatch` or `contract_output_mismatch` refusal's recovery is `correct_source` in a read build and `write_completion` in a write build.

### Publication decisions

- `path_screening` stays a refusal the minter fixes, since it can mean a source path holds a credential.
- Each `finish_build` decision, refused or published, is a `PublicationDecision`: its code, reason, execution, time, failed checks and recovery path. The tool result carries its `decisionId`. The harness's own refusals before publication runs, such as an invalid request, and a host fallback's publication after unresolved input feedback are decisions too.
- A host keeps them as evidence through `MintDependencies.publicationDecisions`, which records each decision and lists the build's decisions. The local host keeps them in memory for the request.
- A question review and a blocked-explanation review get the latest refusals as `question_review.publicationDecisions`, so Guardian reads what the host refused, not only the minter's account of it.

## Guardian

- Guardian is a second model that reviews the minter's work before it takes effect.
- While minting, it reviews each browser call before it runs, each question before it reaches you, and the finished source before Pomerado saves it.
- A denied call never reaches the website.
- Guardian doesn't review a saved integration's runs. It approved the source while minting, so running an integration makes no model request and needs no model key.
- Its policy in `typescript/src/guardian/upstream-policy.md` is adapted from OpenAI Codex under the Apache License 2.0.

### Review requests

Guardian reviews four built-in kinds of request: execution, question, browser recovery and publication. A host can add its own kinds. With a session (`makeGuardian`'s third argument), all of a mint's reviews are turns of one conversation.

- **One request layout.** Every kind sends the same instructions, the same `read_source` tool and the same strict output format, which is the union of all kinds' fields. A kind's own policy and evidence go in its user message under `trusted_review`, so moving from one kind to another keeps the conversation's cached prefix. The host drops fields a kind doesn't use and refuses an outcome the kind may not return. A host adds its own per-kind policy, input and turn limit through `specialize`. It can't change the instructions or the output format.
- **Host-defined kinds.** `reviewHostKind(pending, request, readSource?)` runs a review of a kind the host defines, as one more turn of the same conversation, with the same instructions, tool and output format.
  - The `request` gives the kind's name, its policy (sent as `trusted_review.policy`), its evidence (sent as `host_review`) and the subset of the shared outcomes it may return.
  - It can also give the `labels` its decision may carry and a `private` flag.
  - It returns `{ outcome, rationale, label? }`. The host refuses any other outcome or label.
  - A private kind's evidence, transcript and rationale reach no readable diagnostic. Later reviews' readable model records show its exchange only as a placeholder, including after a compaction.
- **Required read.** `PendingExecution.entrypoint` is the agent's own file. A host that runs it through a wrapper describes the wrapper in `hostWrapper`; Guardian may read it but needn't. An execution review puts the entrypoint's first chunk in its request, so a typical review takes one model call.
  - If the host's read fails, the source is left out and Guardian reads it itself.
  - If only keeping the screened copy fails, the source stays in the request and the gap is recorded as `guardian.source_failed`.
  - An allow counts only while the entrypoint is in view, so after a compaction during the review, Guardian must read it again. `./x` and `x` name the same file.
  - If an allow still lacks the read after two follow-up rounds in the same review, the review fails with `EntrypointNotRead`. That failure is a verdict, so it is never retried.
- **Incremental review.** Before an execution review, the host compares each executed source Guardian already read in this conversation since its last compaction with the current bytes. It lists the identical ones in `trusted_review.unchangedSources`, and Guardian needn't read them again. The entrypoint is still always included.
- **Diagnostics.** Each review emits `guardian.usage` with its model calls and its input, cached, cache-write, output and reasoning token counts. Model diagnostics are reported with or without a session. The wait for a session is emitted as the `guardian.session_wait` interval, and waits between outage retries happen outside the session.
  - Each attempt is one review with its own ID. Its `guardian.started` and its closing `guardian.completed` or `guardian.failed` carry a `timing` with the attempt number, which counts outage retries from 1, and the interval as `performance.now()` offsets. The started record adds that attempt's session permit wait, and the closing record counts any `followUpRounds`. Follow-up rounds for a skipped entrypoint read stay inside one attempt.
  - `guardian.review_retried` carries the scheduled backoff interval and the failed attempt's review ID. A failed source read, the host's own entrypoint read included, records its duration on `guardian.source_failed`.
  - A private host kind keeps no transcript, so its finite model and tool timing goes to `observeModelTrace` instead.

### Publication review

- `finish_build` runs one publication review after its own checks. Guardian reads the files that would ship, the public definition the host writes from the build's name, description and schemas, and the evidence they are judged against.
  - For a read, the evidence is the example's output, with the build's secrets masked and cut at 96 KiB, and the source the example ran, under `executed/`.
  - For a write, it is each act step's source under `publication/session/`, in order, and the output of the step the build names.
- `trusted_publication` indexes those files: whether each ships, whether it is current and who wrote it, the host or the minter. A publication review gets 32 turns.
- Input feedback, such as an account's own number listed as an enum member, goes back to the minter, which gets two rounds to fix it. An `exampleInput` key that the input schema doesn't list comes back the same way. If the feedback remains after that, the build ends unpublished with Guardian's categories and rationale, and `pomerado mint` exits 1.
- Any other denial goes back to the minter with Guardian's reason and findings.
- A host that returns its own `policy` from `specialize` for a publication review keeps exactly the policy, input and turn limit it sends. The core policy, `trusted_publication` and the 32 turns apply only without one. A host can also decode publication decisions itself with `decodePublication`, and end unresolved input feedback its own way with an `InputFeedbackFallback`.

## The runtime

- A saved integration runs as its own MCP stdio server. Its `mcp.mjs` launcher loads the Pomerado installation that minted it and serves the integration's folder, as `pomerado-mcp serve --artifact` does.
- The server validates each call's input against the integration's input schema before it runs anything.
- Each run starts at the site's root, as the integration's example did. The path of the configured URL isn't loaded. An operation that needs a deeper page opens it itself.
- `pomerado run` and each served call open a new browser context, so they start with no cookies or storage. A library caller's runs share the browser context of their `createPomerado` scope, and a run doesn't clear it.
- The operation's output is validated against the output schema before it is returned. It comes back without secret redaction.
- This package has no general privacy screening service. Error messages mask values that look like credentials.
- Operations run in child processes. Page code runs in native Playwright workers.
- Authored code, offline commands and page-code workers run with your user account's file and network access. Guardian review and file checks are not an operating system sandbox. Clearing a worker's `process.env` hides environment variables from that API but doesn't isolate host credentials.

Generated code keeps the Kernel SDK's browser call shape, so the same source also runs on a host that uses Kernel.

```js
const response = await kernel.browsers.playwright.execute(sessionId, {
  code: "return await page.title();",
  timeout_sec: 30,
});
```

- Here `kernel` is a compatibility object that forwards calls to native Playwright over local process IPC. It doesn't load the Kernel SDK or call Kernel.
- Narrow credential-keyboard and browser-ownership checks still use Chromium's low-level CDP primitives where required.
- The local host doesn't mint HTTP variants, record network traffic or produce `captures/routes.json`. It has no `SiteHttp` transport or capture replay helpers. Requests made inside the browser still work.

## Jobs

- A tool call that starts work creates a job in the server's memory and returns its ID.
- `get_job` waits for a change, 20 seconds by default and at most 30. It never starts work again.
- A call to a generated integration waits 20 seconds. It returns the output if the run finished, and a job ID if not.
- A pending question expires after 10 minutes.
- The server runs one job at a time and keeps at most 32 job records. Finished records expire after 15 minutes.
- Each job owns a fresh browser context and closes it when the job ends. A minted integration doesn't inherit the mint's signed-in session.
- A build that signed in saves its sign-in screens and check, with no value, in `auth-fill.json`. Each call replays them before the tool runs.
  - It first checks without values, and asks nothing when the session already shows the account. A served call starts in a fresh browser context, so it asks.
  - Otherwise it asks for the login, and for any code, date of birth, ZIP code or security answer a screen needs. It keeps them in memory for that call only.
  - A rejected username or password is asked again at most twice, and a rejected value is never sent again.
  - A recipe the host can't read, or a sign-in that fails, stops the call before the tool runs. Its job's error then carries no warning that a website action may have taken effect.
  - A run trusts `auth-fill.json` as it trusts `src/`, and edits to either aren't reviewed. An edited recipe still sends values only to the site and its configured sign-in origins. There it can pick a form that sends a value in the page address, as a form that submits with GET does, where the site's logs may keep it.
- A write tool takes an optional `idempotency_key`. A call that repeats the key and input rejoins the first job and acts on nothing, even while that job still runs. The same key with other input is refused, and nothing runs.
- A served integration keeps each keyed job's record in its folder's `.jobs` for a day. The record holds the key, a digest of the input, the job ID, its status and a failed run's commit marks. It never holds the input or the output.
- Two servers on one integration folder share those records, so one key starts one job between them.
- `.jobs` is for servers on one machine. A record names the process that runs its job, and a server on another machine or in another container can't tell whether that process still runs.
- Restarting the server stops running jobs and keeps saved integrations and keyed job records. After a restart, `get_job` and a repeated call find a keyed job's status but not its output. A keyed job the restart stopped reads as failed and is never run again.
- A failed job is never replayed. A website action it already sent may have taken effect.
- The integration's folder is reserved before the mint starts, so a name collision can't run the task and then fail to save it. An unpublished mint removes the folder.

## Library and terminal

The package also works as a library. A library session can mint and run while it keeps the same signed-in browser context.

```js
import { Effect } from "effect";
import { createPomerado, makeTerminalAsker } from "pomerado";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* createPomerado({ ask: makeTerminalAsker() });
      const request = {
        url: "https://example.com",
        intent: "Read the main heading",
        input: {},
        effect: "read",
      };
      const result = yield* session.mint(request);
      if (result.artifact === undefined) throw new Error(result.summary);
      console.log(yield* session.run(result.artifact, request));
    }),
  ),
);
```

- `makeInputAsker` adapts your own chat callback. The callback receives an `InputRequest` and returns raw answers keyed by question ID.
- `makePomeradoMcp` and `makeIntegrationMcp` expose the two local MCP modes as library functions. Their Effect scopes own cleanup.
- `minterProvider` and `guardianProvider` take Agents SDK `ModelProvider` implementations in place of the default OpenAI provider.
- Importing a core module starts no browser, MCP listener or workspace.

The package has these entry points.

- `pomerado`, `pomerado/runtime` and `pomerado/mcp` serve local sessions, the authored browser runtime and local MCP composition.
- Explicit `pomerado/core/*` subpaths, such as `pomerado/core/mint/harness`, `pomerado/core/guardian/review` and `pomerado/core/runtime/host-execute`, let other hosts compose the library. The export map lists the supported modules.
- `pomerado/testing/*` holds reusable test helpers and fixtures. Vitest is an optional peer for helpers that need it.
- `submitJob` from `pomerado/core/runtime/job-store` is the retry-key rule every host shares. A host passes its own `JobStore`, and runs `describeJobStoreContract` from `pomerado/testing/job-store-contract` to check that store.
- `getAuthoringDirectory` and `getGuardianPolicyPath` from `pomerado/assets` return the installed prompt and policy paths.
- `loadAuthoringSkills` and `loadWorkspaceGuide` from `pomerado/core/mint/skills` render each named authoring section's standalone text by default. A host that supplies its own text for those sections composes the directory first, then passes its own `render` function to load it.
- `makeOpenAIReviewer` from `pomerado/core/guardian/openai` takes the host's `GuardianExecutionEnvironment`, the texts that tell Guardian how that host runs code. The local host passes `nativeExecutionEnvironment`.
- `checkWriteSession` from `pomerado/core/mint/write-session` runs a write session's publication checks. It takes the session's non-read request count, which the local host passes as 0. The local host marks each step its effect journal can't rule out as `possiblySent` instead.
- `makeCredentialKeyboard` from `pomerado/core/destinations/credential-keyboard` takes an optional `bindingWorld` function that returns the execution context a credential field resolves in. Without it, the field resolves in the page's main world.

`npx -y -p pomerado pomerado --help` shows the terminal interface for minting and running. Terminal mint keeps its original source-artifact format. Use `pomerado-mcp mint` for generated MCP packaging.

## Other hosts

- This repository is the only source for the shared core, the portable tests, the authoring assets and the local MCP adapters.
- Another host installs the same core as a pinned library package and calls it directly, through the hook interfaces above. Its own frontend, accounts, storage, providers and authoring text live in its own code.
- This package holds the code the local host runs, those hook interfaces, and the signed-in marker checks in `destinations/signed-in-marker.ts`, which a host uses to implement `MintDependencies.checkSignedInMarker`. Code that only another host runs stays in that host.
- A host adopts a tested release through an exact dependency pin with locked integrity, and rolls back by restoring its previous pin. Public commits don't update any host.
- Contributors can test a host against a locally built package before a version is published.

## Source layout

| Path | Responsibility |
| --- | --- |
| `typescript/src/mint/` | Shared minter loop, source tools and completion |
| `typescript/src/guardian/` | Shared review loop, source inspection and policy |
| `typescript/src/runtime/` | Shared operation SDK, schemas, browser call contract, the page each live step starts from, the JobStore hook, the shared retry-key rule and the local job stores |
| `typescript/src/browser/` | Shared browser helpers used by authored operations |
| `typescript/src/destinations/` | Shared sign-in inspection, autofill and trusted credential entry |
| `typescript/src/inputs/` | Input validation, terminal collection and per-session secrets |
| `typescript/src/execution/` | Local workspaces, child processes and native Playwright adapter |
| `typescript/src/standalone/` | Local library, terminal and MCP composition |
| `typescript/src/mcp/schema.ts` | Pure schema adapter shared with the production MCP |
| `typescript/authoring/` | Shared prompts and examples, with sections a host can replace |
