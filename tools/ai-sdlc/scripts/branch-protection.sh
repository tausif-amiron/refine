#!/usr/bin/env bash
# Configure and verify branch protection on main: no path from an agent to main without a person.
#   scripts/branch-protection.sh apply    # set protection (needs repo admin)
#   scripts/branch-protection.sh verify   # read it back and fail if anything is missing
set -euo pipefail
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
branch=${BRANCH:-main}
checks='["checks","secrets","sast"]'

case "${1:-verify}" in
  apply)
    # Merge commits only, head branch deleted on merge (docs/CONVENTIONS.md#merging). Repo settings, so this also
    # works on plans where branch protection is unavailable (private repos on GitHub Free).
    gh api -X PATCH "repos/$repo" -F allow_merge_commit=true -F allow_squash_merge=false \
      -F allow_rebase_merge=false -F delete_branch_on_merge=true >/dev/null
    echo "merge settings applied to $repo: merge commits only, delete branch on merge"
    gh api -X PUT "repos/$repo/branches/$branch/protection" --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $checks },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
    echo "protection applied to $repo@$branch"
    ;;
  verify)
    fail=0
    r=$(gh api "repos/$repo")
    jq -e '.allow_merge_commit == true and .allow_squash_merge == false and .allow_rebase_merge == false' <<<"$r" >/dev/null || { echo "merge settings: only merge commits must be allowed"; fail=1; }
    jq -e '.delete_branch_on_merge == true' <<<"$r" >/dev/null || { echo "merge settings: head branches are not deleted on merge"; fail=1; }
    p=$(gh api "repos/$repo/branches/$branch/protection" 2>/dev/null) || { echo "branch protection: none on $branch (or unavailable on this GitHub plan)"; p='{}'; fail=1; }
    jq -e '.required_pull_request_reviews.required_approving_review_count >= 1' <<<"$p" >/dev/null || { echo "missing: required approving review"; fail=1; }
    jq -e '.required_pull_request_reviews.require_code_owner_reviews == true' <<<"$p" >/dev/null || { echo "missing: code owner review"; fail=1; }
    jq -e '.enforce_admins.enabled == true' <<<"$p" >/dev/null || { echo "missing: enforce for admins"; fail=1; }
    jq -e '.allow_force_pushes.enabled == false' <<<"$p" >/dev/null || { echo "force pushes allowed"; fail=1; }
    for c in checks secrets sast; do
      jq -e --arg c "$c" '.required_status_checks.contexts | index($c)' <<<"$p" >/dev/null || { echo "missing required check: $c"; fail=1; }
    done
    grep -qE '^[^#[:space:]]' .github/CODEOWNERS || { echo "CODEOWNERS has no owners"; fail=1; }
    [ $fail -eq 0 ] && echo "branch protection verified on $repo@$branch" || exit 1
    echo "Final proof (do once, by hand): push a commit straight to $branch from a non-admin token and confirm it is rejected."
    ;;
  *) echo "usage: $0 apply|verify"; exit 2 ;;
esac
