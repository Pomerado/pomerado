# Changelog

## 0.2.0

This release changes how a host embeds the minting core's authoring. Standalone use through `pomerado`, `pomerado/mcp` and the CLI needs no change.

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

### Other changes

- Seven headings that rendered empty in standalone mode now have standalone text, in `core/SKILL.md`, `auth/SKILL.md` and `workspace/AGENTS.md`.
- Section markers are checked strictly in both modes: an unterminated, unspaced, duplicated or foreign section, a stray end marker, a section inside a code fence and any other `pomerado:`, in any case, all fail the load.

## 0.1.2

- Guardian's upstream policy, adapted from OpenAI Codex, carries its Apache-2.0 notice, and the package ships `third-party/codex/LICENSE` and `third-party/codex/NOTICE`. Guardian drops the notice before the policy reaches the model.
- Failure-detail comments no longer name a hosted service's internal paths.
- `FailureSubCause` adds `browser_page_call_failed`, for a page command the browser answered with a failure, such as a script error or a timeout.
- This is the first release published with npm provenance.
