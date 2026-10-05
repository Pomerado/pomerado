# Releasing

Every npm release of `pomerado` comes from GitHub Actions with npm provenance. Nobody publishes from a laptop. GitHub stores no npm token.

1. A maintainer opens a pull request that sets the new `version` in `package.json`.
2. The merge queue merges it into `main` after review and checks pass.
3. A maintainer tags the merged commit with `v` and that version, then pushes the tag.

   ```sh
   git tag v0.1.2 <commit-on-main>
   git push origin v0.1.2
   ```

4. The tag starts the [Release workflow](../.github/workflows/release.yml). It runs the full Check workflow first. Check typechecks, builds, runs the unit and browser tests, and installs the packed tarball in a clean project.
5. The workflow stops if the tag differs from `package.json`, the commit is not on `main`, or the tested tarball carries another name or version.
6. The publish job waits in the `npm-release` environment. A second maintainer approves it. Nobody approves their own release, and the environment accepts only `v*` tags.
7. npm trusted publishing swaps a short lived GitHub OIDC token for publish rights to this package only. npm publishes the exact tarball the checks tested, with a provenance attestation naming this repository, the workflow, and the commit.

A broken release gets a new patch version. A published version or its tag never moves.

Consumers verify a release by installing it with npm and running `npm audit signatures` in the same project.

```sh
npm install pomerado
npm audit signatures
```

The output counts `pomerado` among packages with a verified registry signature and a verified attestation. The npm package page links each attested version to the workflow run that built it. Versions 0.1.1 and earlier predate this process and carry no attestation.
