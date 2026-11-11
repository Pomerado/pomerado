#!/usr/bin/env bash
# Selects a pull request's tests from the newest test map, for .github/workflows/check.yml. It
# downloads the map from the newest scheduled or dispatched run of test-map.yml on this
# repository's main, never from a pull request's own run, then runs tools/test-map.ts select and
# guard. No map, or one that can't be downloaded, selects every test.
#
# Environment: GH_TOKEN, REPO (owner/name), BASE and HEAD (the pull request's commits), TESTED
# (the commit the tests run on, such as the pull request's merge commit; HEAD by default), and
# ENFORCE (`true` writes the selection as the test jobs' inputs and makes the guard fail the step;
# anything else only records it). Writes selection.json to the folder given as the first argument.
set -euo pipefail

out="${1:?usage: test-map-select.sh <folder>}"
tool="$(dirname "${BASH_SOURCE[0]}")/test-map.ts"
tested="${TESTED:-$HEAD}"
mkdir -p "$out"
map_dir="$(mktemp -d)"
trap 'rm -rf "$map_dir"' EXIT

newest=$(gh api "repos/$REPO/actions/workflows/test-map.yml/runs?branch=main&status=success&per_page=30" \
  --jq "[.workflow_runs[] | select((.event == \"schedule\" or .event == \"workflow_dispatch\")
    and .head_repository.full_name == \"$REPO\")][0].id // empty" || true)
if [ -n "$newest" ]; then
  gh run download "$newest" -R "$REPO" -n test-map -D "$map_dir" ||
    echo "::warning::Could not download the test map from run $newest"
fi

if [ "${ENFORCE:-}" = true ]; then
  node "$tool" select --enforce --map "$map_dir/test-map.json" --base "$BASE" --head "$HEAD" \
    --tested "$tested" --out "$out/selection.json"
  node "$tool" guard --selection "$out/selection.json" --base "$BASE" --head "$HEAD"
else
  node "$tool" select --map "$map_dir/test-map.json" --base "$BASE" --head "$HEAD" \
    --tested "$tested" --out "$out/selection.json"
  node "$tool" guard --warn --selection "$out/selection.json" --base "$BASE" --head "$HEAD"
fi
