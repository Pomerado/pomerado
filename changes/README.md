# Changelog fragments

Record a user-facing change in a new file in this folder, not in [CHANGELOG.md](../CHANGELOG.md). Every pull request that edits the top of CHANGELOG.md conflicts with every other one that does, while a new file conflicts with nothing.

Name the file for the change, in lowercase letters, digits and dashes, such as `sign-in-popup-check.md`. Start it with a header that names its section, then write the entry as you would in CHANGELOG.md:

```markdown
---
section: Breaking changes
---

- `checkAutofillSignedIn` now returns `failed: "sign_in_popup_open"` while a sign-in pop-up is still open.
  - Migrate a host that maps each failure, such as in an exhaustive check, by handling `sign_in_popup_open`.
```

- `section` is `Breaking changes`, `Other changes` or `Fixes`, the sections CHANGELOG.md uses.
- Every entry starts with `- `, and its other lines are indented under it. A breaking change lists its migration steps.
- One file holds the entries of one section. A change with entries in two sections uses two files.

`node tools/changelog.ts check` checks every fragment, and `corepack pnpm test` runs it. Each canary's packed CHANGELOG.md lists the fragments under Unreleased, and the pull request that bumps `version` moves them into CHANGELOG.md under the outgoing version with `node tools/changelog.ts release X.Y.Z`. [Releasing](../docs/RELEASING.md#changes-and-versions) has the details.
