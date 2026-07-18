#!/usr/bin/env bash
set -euo pipefail

package="${1:-}"
case "$package" in
  contracts|telemetry|agent|graph|framework|cli) ;;
  *) echo "usage: $0 <contracts|telemetry|agent|graph|framework|cli> [branch]" >&2; exit 2 ;;
esac

branch="${2:-split/$package}"
git subtree split --prefix "packages/$package" -b "$branch"
echo "created $branch from packages/$package"
echo "push it with: git push <new-repository-remote> $branch:main"
