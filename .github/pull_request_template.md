## What changed and why?

Describe the problem and the resulting behavior. Link related issues.

## Risk class

<!--
Keep one line.
High: authentication, credentials or secrets handling, permissions, data deletion, the release workflow, or anything that changes what leaves the user's machine. A high-risk change also needs a second independent review of its security, data safety and rollback plan.
Medium: any other change to how the package behaves.
Low: documentation, tests, internal tooling and copy.
-->

Low / Medium / High, because ...

## Rollback plan

How to undo this if it goes wrong, for example reverting this pull request and releasing again, and anything a revert alone doesn't undo.

## How it was tested

List the checks you ran and their results, including anything you could not run.

- [ ] Added a failing test first for a change in behavior, or explained why none applies.
- [ ] Updated the docs and CHANGELOG.md when public behavior changed.
- [ ] Followed the [contributing guide](https://github.com/Pomerado/pomerado/blob/main/CONTRIBUTING.md).
