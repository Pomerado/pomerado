#!/usr/bin/env bash
# The scan steps of the secret-scan and content-scan jobs in check.yml, kept here so tests can run
# them. Run it from the root of the repository to scan.
#
#   bash tools/ci-scan.sh range     print the commit range this event scans, or an empty line
#   bash tools/ci-scan.sh secrets   run gitleaks, at $GITLEAKS, on that range and on the tree
#   bash tools/ci-scan.sh content   run tools/check-public-content.ts on the tree and that range
#
# The event comes from EVENT, REF, PR_BASE, PR_HEAD, PUSH_BEFORE and PUSH_AFTER.
set -euo pipefail

tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

is_commit() {
  [ -n "$1" ] && git cat-file -e "$1^{commit}" 2>/dev/null
}

# A pull request scans its commits. A branch push scans the pushed commits, or only the tree when
# a force push left no earlier commit to start from. A tag push, such as a release, scans the tree.
# A range that names a missing commit fails: gitleaks passes an unreadable range as clean.
commit_range() {
  case ${EVENT:-} in
    pull_request)
      if ! is_commit "${PR_BASE:-}" || ! is_commit "${PR_HEAD:-}"; then
        echo "::error::Can't read the pull request's commits ${PR_BASE:-none}..${PR_HEAD:-none}." >&2
        return 1
      fi
      echo "$PR_BASE..$PR_HEAD"
      ;;
    push)
      if [[ ${REF:-} != refs/heads/* ]]; then
        echo ""
      elif ! is_commit "${PUSH_AFTER:-}"; then
        echo "::error::Can't read the pushed commit ${PUSH_AFTER:-none}." >&2
        return 1
      elif ! is_commit "${PUSH_BEFORE:-}"; then
        echo "::warning::No earlier commit to start from. Only the tree is scanned." >&2
        echo ""
      else
        echo "$PUSH_BEFORE..$PUSH_AFTER"
      fi
      ;;
    *) echo "" ;;
  esac
}

secrets() {
  local range
  range=$(commit_range)
  if [ -n "$range" ]; then
    "$GITLEAKS" git --config .gitleaks.toml --redact --no-banner --log-opts="$range" .
  fi
  # The tree too, on every event. `git log -p` shows no diff for a merge commit, so a secret added
  # while resolving a merge exists only in the tree.
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
