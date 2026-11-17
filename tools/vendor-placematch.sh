#!/usr/bin/env bash
# Builds PlaceMatch, the address matcher the address picker runs, at the commit
# third-party/placematch/source.json pins, and copies its JavaScript loader, WebAssembly module and
# license files into third-party/placematch/. The build copies them into the package beside the
# picker (tools/copy-assets.ts), so a script loads PlaceMatch from its own package, with no network.
#
# To move to another PlaceMatch commit, set "commit" in source.json and run this from the root of
# the repository. It needs git, jq and a Rust toolchain with the wasm32-unknown-unknown target. It
# writes each copied file's SHA-256 into source.json, which a unit test checks against the files.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pin="$root/third-party/placematch/source.json"
repository=$(jq -er .repository "$pin")
commit=$(jq -er .commit "$pin")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$work" init --quiet src
git -C "$work/src" fetch --quiet --depth 1 "$repository" "$commit"
git -C "$work/src" checkout --quiet FETCH_HEAD
# Paths the module names in its panic messages are remapped, so the build is the same on any machine.
cargo_home=$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd)
(cd "$work/src" && RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$work/src=/placematch" \
  cargo build --locked --quiet --profile wasm --target wasm32-unknown-unknown -p placematch-wasm)

out="$root/third-party/placematch"
install -m 644 "$work/src/target/wasm32-unknown-unknown/wasm/placematch_wasm.wasm" "$out/placematch.wasm"
cp "$work/src/js/placematch.mjs" "$out/placematch.mjs"
for file in LICENSE LICENSE-UNICODE NOTICE; do
  cp "$work/src/$file" "$out/$file"
done

hashes=$(for file in placematch.mjs placematch.wasm; do
  printf '%s\t%s\n' "$file" "$(sha256sum "$out/$file" | cut -d' ' -f1)"
done | jq -R 'split("\t") | { (.[0]): .[1] }' | jq -s add)
jq --argjson sha256 "$hashes" --arg toolchain "$(rustc --version | cut -d' ' -f2)" \
  '.sha256 = $sha256 | .toolchain = $toolchain' "$pin" > "$work/source.json"
mv "$work/source.json" "$pin"
echo "PlaceMatch $commit: $(wc -c < "$out/placematch.wasm") bytes of WebAssembly"
