# Releasing

Every npm release of `pomerado` comes from the [Release workflow](../.github/workflows/release.yml), with npm provenance. Maintainers never publish from their own machines. GitHub stores no npm token: npm trusted publishing swaps a short lived GitHub OIDC token for rights to this package alone, in the `npm-release` environment, which deploys only from `main`.

There are two channels:

| Dist-tag | What it holds | Install |
| --- | --- | --- |
| `canary` | Every commit merged to `main`, as soon as its checks pass | `npm install pomerado@canary` |
| `latest` | The canary that has run in production | `npm install pomerado` |

`latest` is always a canary, so `npm install pomerado` saves a range such as `^0.2.1-canary.57`. That range also matches later canaries of 0.2.1, which production may never have run, and package managers such as yarn classic and bun install the highest match. To stay on the version you installed, use `npm install --save-exact pomerado` or commit a lockfile.

## Canaries

1. A pull request merges into `main` after a green `CI` check, a `review/clear` check from the independent review, and an `Approval` check. Rulesets on `main` require all three. `Approval` passes at once for a maintainer's pull request from a branch of this repository, and for any other once a code owner approves its current head commit. [The approval gate](#the-approval-gate) describes it.
2. The merge starts the Release workflow. It picks the canary version `X.Y.Z-canary.N`:
   - `X.Y.Z` is the `version` in `package.json` while npm doesn't have it, and the next patch version once it does.
   - `N` is the workflow's run number, so a later canary always sorts higher.
3. The workflow writes that version into `package.json` and runs the full Check workflow on it. Check typechecks, builds, runs the unit and browser tests, and installs the packed tarball in a clean project.
4. The publish job verifies that the tested tarball carries the canary's name and version, and that the version sorts above every version npm has. Then it publishes exactly that tarball under `canary`, with a provenance attestation naming this repository, the workflow and the commit. A re-run that finds the canary already on npm stops without publishing.

A newer merge replaces a canary that is still waiting to start, and the newer canary includes its commits. The replaced merge gets no Check run of its own on `main`, but its pull request passed CI on the same tree.

## Promotion to latest

`latest` moves only to a canary that has run in staging and then been promoted to production. That production deploy is the release approval. When it succeeds, the deploy dispatches the Release workflow on `main` with the version and its sha512 integrity. A production rollback dispatches it again with the older version, so `latest` follows production.

The promote job:

1. Checks that npm has that exact version with that exact integrity, so `latest` names the bytes production tested.
2. Checks the version's SLSA provenance, which npm serves with the version. npm records no `gitHead` for a tarball publish, so the provenance names the commit.
   - Its subject is `pkg:npm/pomerado@<version>`, with a sha512 digest equal to that integrity.
   - It was built by `.github/workflows/release.yml` in this repository, from `refs/heads/main`, on a GitHub-hosted runner. A release from the retired tag workflow, 0.2.0 or earlier, may name its own `v<version>` tag instead of `main`.
   - The commit it names is on `main`.
3. Moves `latest` to the version, unless it already names it, and reads `latest` back. It reads `latest` from the registry's dist-tags endpoint, which the registry serves uncached. `npm view` reads the package document, which npm's CDN caches for up to five minutes, so it can show the old `latest` for that long after a move.
4. Tags that commit `v<version>` and creates the GitHub Release with generated notes, unless a rollback finds them already there. A tag that is already there must point to that commit.

Each step checks before it writes, so re-running a promotion for the version `latest` already names succeeds and changes nothing.

Two tag rulesets cover `v*` tags:

- `release tags` blocks updating, force-pushing and deleting a `v*` tag, with no bypass.
- `release tag creation` blocks creating a `v*` tag. A dedicated release GitHub App bypasses it, so the promote job can tag, while maintainers can't push a release tag by hand. GitHub doesn't accept GitHub Actions as a bypass actor on a tag ruleset, so the workflow's own token can't create the tag.

The creation rule sits in its own ruleset because a bypass covers every rule in its ruleset, and nothing may move or delete a release tag.

The promote job's workflow token only reads contents. Just before the tag step, the job mints a short lived installation token from the release app, scoped to this repository with `contents: write`, and only the tag step uses it. Setting this up takes, once:

1. A GitHub App installed only on this repository, with the repository permission Contents set to read and write and no other permissions or webhook.
2. In the `npm-release` environment, the variable `RELEASE_APP_ID` holding the app's ID and the secret `RELEASE_APP_PRIVATE_KEY` holding one of its private keys.
3. The app added as a bypass actor, always allowed, on the `release tag creation` ruleset.

The promote job checks the variable and secret before it writes anything and fails with an error naming them when either is missing.

To promote by hand, a maintainer runs:

```sh
gh workflow run release.yml --repo Pomerado/pomerado --ref main \
  -f version=0.2.1-canary.57 \
  -f integrity="$(npm view pomerado@0.2.1-canary.57 dist.integrity)"
```

## The approval gate

The [approval gate workflow](../.github/workflows/approval.yml) posts the `Approval` commit status on each open pull request's head commit, with the rules in `tools/approval-gate.ts`:

- A pull request from a branch of this repository passes at once when GitHub's API reports its author with write, maintain or admin permission on the repository. Only users with write access can push to those branches.
- Any other pull request passes once a user that `.github/CODEOWNERS` lists, who also has write permission, approves its current head commit. That includes a maintainer's pull request from a fork, since the fork's owner can push to it without write access here. An approval of an earlier commit stops counting after a push. The pull request fails while any reviewer with write permission has changes requested.
- When several open pull requests share a head commit, the commit passes if any of them passes.

It runs when a pull request opens, reopens, gets a push or leaves draft, and again after each submitted or dismissed review. A maintainer re-evaluates every open pull request with `gh workflow run approval.yml --repo Pomerado/pomerado --ref main`, for example after a GitHub outage left a pull request without the status.

The status comes from a dedicated approval GitHub App, and the ruleset on `main` requires `Approval` from that App. A workflow that a pull request adds runs as GitHub Actions, so a job or status it names `Approval` can't satisfy the rule. Setting this up takes, once, in this order:

1. A GitHub App installed only on this repository, with the repository permissions Commit statuses set to read and write and Pull requests set to read, and no other permissions or webhook. Metadata read comes with every App.
2. An `approval-gate` environment that deploys only from `main`, with no required reviewers. Create it with that branch policy before the workflow first runs and before adding its secret: a workflow that names a missing environment creates it with no branch policy. It holds the variable `APPROVAL_APP_ID`, the App's ID, and the secret `APPROVAL_APP_PRIVATE_KEY`, one of its private keys. Only the approval gate workflow uses it.
3. `Approval` in the required status checks of the ruleset on `main` that requires `CI` and `review/clear`, with the approval App as its source.

The workflow checks the variable and secret first and fails with an error naming them when either is missing. Without the status, the pull request can't merge.

Known limits:

- A dispatch evaluates many commits in one run, so it isn't serialized with the runs for each commit. If a review lands while a dispatch runs, the dispatch can post a verdict that is seconds old. The next event on that pull request, or another dispatch, corrects it.
- The gate doesn't handle `merge_group` events, so a merge queue's commits get no `Approval`. Before `main` adopts a merge queue, the gate needs a `merge_group` path, or the ruleset needs to stop requiring `Approval` on queue commits. Every pull request in a queue has already passed the gate at its head commit.

## CI runners

The [Check workflow](../.github/workflows/check.yml) picks each job's runner from facts GitHub sets about the run, and `typescript/tests/unit/ci-runner-routing.test.ts` checks every route:

| Run | `check` job | Browser jobs | Every other job |
| --- | --- | --- | --- |
| A pull request from a fork | GitHub-hosted | GitHub-hosted | GitHub-hosted |
| A pull request from a branch here by a maintainer | `vars.CI_RUNNER_MAINTAINER` | `vars.CI_RUNNER_MAINTAINER` | GitHub-hosted |
| A pull request from a branch here by anyone else, such as a bot | GitHub-hosted | GitHub-hosted | GitHub-hosted |
| A push to `main`, through the Release workflow | GitHub-hosted | `vars.CI_RUNNER_TRUSTED` | GitHub-hosted |
| A run in another repository that calls `check.yml` | GitHub-hosted | GitHub-hosted | GitHub-hosted |

- **Maintainers.** A maintainer is a login the `CI_MAINTAINERS` variable lists, as a JSON array such as `["octocat"]`. A pull request takes the maintainer route only when its author, the account whose push started the run (`github.actor`) and the account that started this attempt, a re-run included (`github.triggering_actor`), are all listed. Organization membership alone doesn't count: a self-hosted maintainer runner admits only the accounts its own configuration lists, so the route uses a list too, and a run that runner would refuse goes to a GitHub-hosted runner instead of failing there. An unset variable sends every pull request to GitHub-hosted runners. The value must be a JSON array: an invalid one fails the Check workflow for every pull request from a branch here. This is narrower than the approval gate's maintainer, anyone with write access, so another writer's pull requests pass the gate at once but run on GitHub-hosted runners until listed. Keep the list and each self-hosted maintainer runner's own list the same.
- **Switching.** An unset runner variable falls back to a Blacksmith runner. Set a variable to a runner label with 4 vCPUs, as the browser job's `--workers=4` expects, to move those jobs, and delete it to move them back. Deleting a variable doesn't move jobs already waiting for a runner, so cancel and re-run those. Standard GitHub-hosted runners are free for public repositories, and their `ubuntu-latest` has 4 vCPUs.
- **The published tarball.** On a push to `main`, the `check` job builds and tests the tarball the canary publishes, so it runs on a GitHub-hosted runner. It packs, hashes and uploads the tarball before its clean-project install, which resolves packages from the registry without a lockfile, so no such package runs before the bytes are fixed. It records the artifact's ID and the tarball's SHA-256, and the canary job downloads that artifact by ID and refuses to publish any other bytes. Jobs that hold a secret, such as the canary publish, the promotion and the failure alert, also always run on GitHub-hosted runners, which give every job a fresh machine.
- **Merge queues.** A merge queue gets no Check run yet. The change that adds a `merge_group` trigger also decides its route.

This routing is not a security boundary. A fork's pull request runs its own copy of the workflow, so it can name any runner label, and so can anyone with write access in a branch. Every outside contributor's runs wait for a maintainer's approval, and the maintainer checks changes to `.github/`, `package.json` and the lockfile before approving. A self-hosted runner that either variable names must enforce its route on its own side:

- **A job-started hook** in the runner's image, set through `ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's own environment, reads the event GitHub delivers in `GITHUB_EVENT_PATH` and refuses the job before any step runs unless it is one the runner takes. It refuses anything it can't read, and fails on a timeout.
  - It goes by `GITHUB_EVENT_NAME`, not the payload's shape: `pull_request_review` and `pull_request_target` payloads carry the same pull request fields.
  - It compares names exactly, with case, since GitHub's expressions compare strings without case and git refs have it.
  - A maintainer runner takes only a `pull_request` whose head repository is this repository and not a fork, and whose author, sender (the account whose push started it) and triggering actor (the account that started this attempt, since a re-run keeps the first attempt's payload) are all maintainers. The hook can't read repository variables, so the runner's own configuration lists the maintainers, preferably by user ID, since a login can change hands.
  - A trusted runner takes only a push to `refs/heads/main` whose `GITHUB_WORKFLOW_REF` is this repository's `release.yml` on `refs/heads/main`.
- **Separate runners.** The trusted runner and the maintainer runner use separate machines, namespaces and registration credentials, and no runner can read any registration credential. Whoever holds the trusted runner's credential can take its jobs.
- **A fresh, unprivileged job.** One job per runner, no Docker daemon, no privilege escalation, no service account token or cloud credentials, and no route to the cluster's API, cloud metadata services or private networks. No volume, package store or cache is shared between the two runners. The image is pinned by digest.
- **Registration.** The maintainer runner registers to this repository only, or to an organization runner group limited to it with "Allow public repositories" on. The trusted runner needs an organization runner group: limited to this repository, with "Allow public repositories" on, and with workflow access limited to `Pomerado/pomerado/.github/workflows/check.yml@refs/heads/main`. A group's workflow list names the workflow that defines the jobs, here the called `check.yml`.
- **The image** already holds Node, pnpm and Chromium with its system libraries, built from public sources only. Where it can't install packages, as root or through `sudo`, the browser job installs Chromium without system libraries.
- **A sandboxed kernel.** A maintainer runner may run its jobs under a user-space kernel such as gVisor, so the tests must pass there too. File-confinement code must not depend on Linux behavior gVisor doesn't share, such as `O_NOFOLLOW` with `O_DIRECTORY`.

## Changes and versions

Record user-facing changes in [CHANGELOG.md](../CHANGELOG.md) in the pull request that makes them. Bump `version` in `package.json` to start a new release line: a breaking change gets migration steps and, while the major version is 0, a new minor version.

A pull request that removes a `./core/*` export hosts use, or changes one incompatibly, also raises `pomerado.hostProtocol` in `package.json` by one. `tools/check-host-protocol.ts` runs first in `pnpm test` and fails when a `./core/*` export that the `canary` or `latest` version on npm has is gone and the protocol didn't rise above theirs, or when the protocol is lower than theirs. It can't see an incompatible change inside a module, so raise the number by hand for that. A release run fails when it can't read npm; a pull request or a local run warns and goes on.

Changes go under `Unreleased`. The pull request that bumps `version` renames `Unreleased` to the `X.Y.Z` of the canaries that shipped those changes, as in `X.Y.Z-canary.N`, and lists its own changes under a new `Unreleased`.

## Failures

A failed canary or promotion posts to the maintainers' alerts channel from the `slack-alerts` environment, with a link to the run. A broken canary gets fixed by the next merge. npm never accepts the same version twice.

## Verifying a release

Consumers verify a release by installing it with npm and running `npm audit signatures` in the same project.

```sh
npm install pomerado
npm audit signatures
```

The output counts `pomerado` among packages with a verified registry signature and a verified attestation. The npm package page links each attested version to the workflow run that built it. Versions 0.1.1 and earlier predate this process and carry no attestation.
