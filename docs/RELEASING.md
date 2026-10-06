# Releasing

Every npm release of `pomerado` comes from GitHub Actions with npm provenance. Maintainers never publish from their own machines. GitHub stores no npm token.

1. A maintainer merges a pull request into `main` that sets the new `version` in `package.json` and records the release's changes under that version in [CHANGELOG.md](../CHANGELOG.md). Breaking changes get migration steps and, while the major version is 0, a new minor version.
2. A maintainer tags that commit with `v` and the same version, then pushes the tag.

   ```sh
   version=$(node -p "require('./package.json').version")
   git tag "v$version" <commit-on-main>
   git push origin "v$version"
   ```

3. The tag starts the [Release workflow](../.github/workflows/release.yml). It runs the full Check workflow first. Check typechecks, builds, runs the unit and browser tests, and installs the packed tarball in a clean project.
4. The workflow stops if the tag differs from `package.json`, the commit is not on `main`, or the tested tarball carries another name or version.
5. The `main` check proves the tagged commit is on `main`. It does not prove that anyone reviewed it.
6. The publish job runs in the `npm-release` environment. The environment deploys only from `v*` tags.
7. A tag ruleset blocks moving or deleting any `v*` tag.
8. npm trusted publishing swaps a short lived GitHub OIDC token for publish rights to this package only. npm publishes the exact tarball the checks tested, with a provenance attestation naming this repository, the workflow, and the commit.

A broken release gets a new patch version. npm never accepts the same version twice.

Consumers verify a release by installing it with npm and running `npm audit signatures` in the same project.

```sh
npm install pomerado
npm audit signatures
```

The output counts `pomerado` among packages with a verified registry signature and a verified attestation. The npm package page links each attested version to the workflow run that built it. Versions 0.1.1 and earlier predate this process and carry no attestation.
