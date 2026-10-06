#!/usr/bin/env bash
# The scan steps of the secret-scan and content-scan jobs in check.yml, kept here so tests can run
# them. Run it from the root of the repository to scan.
#
#   bash tools/ci-scan.sh range     print the commits this event scans as a git range, or a blank line
#   bash tools/ci-scan.sh secrets   run gitleaks, at $GITLEAKS, on those commits and on the tree
#   bash tools/ci-scan.sh content   run tools/check-public-content.ts on the tree and those commits
#
# The event comes from EVENT, REF, PR_BASE, PR_HEAD, PUSH_BEFORE and PUSH_AFTER.
set -euo pipefail

tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

is_commit() {
  [ -n "$1" ] && git cat-file -e "$1^{commit}" 2>/dev/null
}

# A pull request scans its commits, base..head. A branch push scans the pushed commits,
# before..after, or every commit reachable from after when a force push left no earlier commit. A
# tag push, such as a release, scans no commits. A range that names a missing commit, or one in a
# shallow checkout, fails: gitleaks passes a range it can't read in full as clean.
commit_range() {
  local range
  case ${EVENT:-} in
    pull_request)
      if ! is_commit "${PR_BASE:-}" || ! is_commit "${PR_HEAD:-}"; then
        echo "::error::Can't read the pull request's commits ${PR_BASE:-none}..${PR_HEAD:-none}." >&2
        return 1
      fi
      range="$PR_BASE..$PR_HEAD"
      ;;
    push)
      if [[ ${REF:-} != refs/heads/* ]]; then
        echo ""
        return 0
      fi
      if ! is_commit "${PUSH_AFTER:-}"; then
        echo "::error::Can't read the pushed commit ${PUSH_AFTER:-none}." >&2
        return 1
      fi
      if is_commit "${PUSH_BEFORE:-}"; then
        range="$PUSH_BEFORE..$PUSH_AFTER"
      else
        echo "::warning::No earlier commit to start from. Every commit reachable from $PUSH_AFTER is scanned." >&2
        range=$PUSH_AFTER
      fi
      ;;
    *)
      echo ""
      return 0
      ;;
  esac
  if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
    echo "::error::The checkout is shallow, so $range can't be scanned in full. Use fetch-depth: 0." >&2
    return 1
  fi
  echo "$range"
}

secrets() {
  local range
  range=$(commit_range)
  if [ -n "$range" ]; then
    # Each commit's diff, with --remerge-diff showing what a merge commit changed beyond an
    # automatic merge, such as a conflict resolution or a file added in the merge. Plain
    # `git log -p` shows merges no diff. gitleaks passes a git log that fails as clean, so the same
    # log runs first to prove it reads.
    if ! git log --remerge-diff --format=%H "$range" -- >/dev/null; then
      echo "::error::git can't list $range with --remerge-diff, which needs git 2.36 or later." >&2
      return 1
    fi
    "$GITLEAKS" git --config .gitleaks.toml --redact --no-banner --log-opts="--remerge-diff $range" .
  fi
  # Every event also scans the checked-out tree.
  "$GITLEAKS" dir --config .gitleaks.toml --redact --no-banner .
}

content() {
  local range
  range=$(commit_range)
  if [ -n "$range" ]; then
    node "$tools/check-public-content.ts" --commits "$range"
  else
    node "$tools/check-public-content.ts"
  fi
}

case ${1:-} in
  range) commit_range ;;
  secrets) secrets ;;
  content) content ;;
  *)
    echo "Usage: bash tools/ci-scan.sh range|secrets|content" >&2
    exit 2
    ;;
esac
