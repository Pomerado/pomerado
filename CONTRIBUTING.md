# Contributing

Pomerado does not accept outside pull requests yet. We will open them once the review and approval gate described under [Changes](#changes) is live. Until then we close pull requests from anyone other than the maintainers without review.

Issues are welcome. Open one for a bug, a question or an idea. Report security problems privately with **Report a vulnerability** on the [Security tab](https://github.com/Pomerado/pomerado/security), never in a public issue.

## Build from source

Use macOS or Linux, Node 24.21 or a later Node 24 release, pnpm 10.34.5, git 2.36 or later, and jq.

```sh
git clone https://github.com/Pomerado/pomerado.git
cd pomerado
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm build
```

On Linux, run `corepack pnpm exec playwright install --with-deps chromium` if Chromium's system libraries are missing.

To run your build as an MCP server, point your client at the built entry with Node. Use absolute paths.

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pomerado/dist/typescript/src/standalone/mcp-cli.js", "mint", "--root", "/absolute/path/to/integrations"]
    }
  }
}
```

- `node -p 'process.execPath'` prints the Node path, and `pwd` in the checkout prints the repository path.
- The server needs `OPENAI_API_KEY` in its environment to mint. [Client settings](docs/getting-started.md#client-settings) shows how each client passes it.
- The clone and build route works without an npm release. Integrations minted by your build run on your build.

## Build and test

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

- The maintainers are Alan ([@alanmrsa](https://github.com/alanmrsa)) and Akshay ([@AkshayM21](https://github.com/AkshayM21)).
- Every change goes through a pull request, the maintainers' own included. Nobody pushes to `main` directly.
- A pull request merges only after an independent review and green CI.
- Rulesets on `main` enforce this. They require a pull request, a green `CI` check and a `review/clear` check from the independent review on the current head, a branch that is up to date with `main`, and a code owner's approval. A push after the approval dismisses it. A repository admin may merge without the approval, but never without the two checks.
- Maintainers merge by hand with a merge commit until a merge queue takes over.
- A maintainer will also approve each CI run of an outside pull request.
- Each merge to `main` publishes a canary to npm. [Releasing](docs/RELEASING.md) describes canaries and how `latest` moves.
- CI checks every pull request, and each canary before it publishes. A merge that a newer merge replaces before its canary starts gets no run of its own on `main`. Its pull request already passed CI on the same tree. CI runs typecheck, build, unit tests, the packed package check, browser tests, a gitleaks secret scan and a public content scan. Run `node tools/check-public-content.ts` before you push.
- Code, tests and pull request text stay free of customer data, credentials and internal references.

## License

Pomerado is licensed under the MIT License. See [LICENSE](LICENSE). Contributions are accepted under the same MIT License, inbound = outbound. There is no Contributor License Agreement.

Third-party code keeps its own license. The Guardian policy in `typescript/src/guardian/upstream-policy.md` is adapted from OpenAI Codex under the Apache License 2.0. Its license and notice are in [third-party/codex/](third-party/codex/).
