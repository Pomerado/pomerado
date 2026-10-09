# Releasing

Every npm release of `pomerado` comes from the [Release workflow](../.github/workflows/release.yml), with npm provenance. Maintainers never publish from their own machines. GitHub stores no npm token: npm trusted publishing swaps a short lived GitHub OIDC token for rights to this package alone, in the `npm-release` environment, which deploys only from `main`.

There are two channels:

| Dist-tag | What it holds | Install |
| --- | --- | --- |
| `canary` | Every commit merged to `main`, as soon as its checks pass | `npm install pomerado@canary` |
| `latest` | The canary that has run in production | `npm install pomerado` |

`latest` is always a canary, so `npm install pomerado` saves a range such as `^0.2.1-canary.57`. That range also matches later canaries of 0.2.1, which production may never have run, and package managers such as yarn classic and bun install the highest match. To stay on the version you installed, use `npm install --save-exact pomerado` or commit a lockfile.

## Canaries

1. A pull request merges into `main` after a green `CI` check, a `review/clear` check from the independent review, and a code owner's approval. Rulesets on `main` enforce all three. A repository admin may merge without the approval, never without the two checks.
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
3. Moves `latest` to the version, unless it already names it, and reads `latest` back, retrying briefly while npm catches up.
4. Tags that commit `v<version>` and creates the GitHub Release with generated notes, unless a rollback finds them already there. A tag that is already there must point to that commit. A tag ruleset blocks moving or deleting any `v*` tag.

To promote by hand, a maintainer runs:

```sh
gh workflow run release.yml --repo Pomerado/pomerado --ref main \
  -f version=0.2.1-canary.57 \
  -f integrity="$(npm view pomerado@0.2.1-canary.57 dist.integrity)"
```

## Changes and versions

Record user-facing changes in [CHANGELOG.md](../CHANGELOG.md) in the pull request that makes them. Bump `version` in `package.json` to start a new release line: a breaking change gets migration steps and, while the major version is 0, a new minor version.

A pull request that removes a `./core/*` export hosts use, or changes one incompatibly, also raises `pomerado.hostProtocol` in `package.json` by one.

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
