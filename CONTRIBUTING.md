# Contributing

Pomerado does not accept outside pull requests yet. We will open contributions once a Contributor License Agreement is in place. Until then we close pull requests from outside the team without review.

Issues are welcome. Open one for a bug, a question or an idea. Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Build and test

Use macOS or Linux, Node 24.21 or a later Node 24 release, and pnpm 10.34.5.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm exec playwright install chromium
corepack pnpm test:browser
npm pack --dry-run
```

Tests use synthetic sites and scripted model responses. They need no model API key or Pomerado account.

## Pull requests

- Every change reaches `main` through a pull request.
- A code owner reviews and approves each pull request.
- CI runs typecheck, build, unit tests, the packed package check and browser tests. All of them must pass.
- Approved pull requests merge through the merge queue, which runs CI again on the combined change.
- Code, tests and pull request text stay free of customer data, credentials and internal references.

## License

Pomerado is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Third-party code keeps its own license. The Guardian policy in `typescript/src/guardian/upstream-policy.md` is adapted from OpenAI Codex under the Apache License 2.0. Its license and notice are in [third-party/codex/](third-party/codex/).
