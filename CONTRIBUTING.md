# Contributing

Pomerado does not accept outside pull requests yet. We will open contributions once a Contributor License Agreement is in place. Until then we close pull requests from anyone other than the maintainers without review.

Issues are welcome. Open one for a bug, a question or an idea. Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Build and test

Use macOS or Linux, Node 24.21 or a later Node 24 release, pnpm 10.34.5, git 2.36 or later, and jq.

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

## Changes

- The maintainers, Alan ([@alanmrsa](https://github.com/alanmrsa)) and Akshay ([@AkshayM21](https://github.com/AkshayM21)), push to `main` directly or open a pull request.
- CI checks every pull request and every push to `main`. It runs typecheck, build, unit tests, the packed package check, browser tests, a gitleaks secret scan and a public content scan. Run `node tools/check-public-content.ts` before you push.
- A maintainer may merge their own pull request.
- Code, tests and pull request text stay free of customer data, credentials and internal references.

## License

Pomerado is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Third-party code keeps its own license. The Guardian policy in `typescript/src/guardian/upstream-policy.md` is adapted from OpenAI Codex under the Apache License 2.0. Its license and notice are in [third-party/codex/](third-party/codex/).
