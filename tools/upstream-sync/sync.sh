#!/usr/bin/env bash
# Opens a PR that merges pingdotgg/t3code main into main. See README.md.
set -euo pipefail

: "${GH_TOKEN:?Set UPSTREAM_SYNC_TOKEN in the upstream-sync environment}"
: "${GH_REPO:?Set GH_REPO to the destination repository}"

branch=automation/upstream-sync

# `gh pr merge --auto` merges at once when nothing is pending, so refuse unless main requires an up-to-date Check.
queue_merge() {
  local pr=$1 head=$2 guarded
  guarded=$(gh api "repos/$GH_REPO/rules/branches/main" --jq 'any(.[]; .type == "required_status_checks"
    and .parameters.strict_required_status_checks_policy
    and any(.parameters.required_status_checks[]; .context == "Check"))')
  if [[ $guarded != true ]]; then
    echo "::error::Sync PR is open, but main does not require an up-to-date Check status, so auto-merge was not enabled."
    return 1
  fi
  gh pr merge "$pr" --auto --merge --match-head-commit "$head"
}

# Same-repository only: a fork can open a PR from a branch with this name.
pull=$(gh pr list --base main --head "$branch" --state open \
  --json number,isDraft,isCrossRepository,headRefOid,autoMergeRequest \
  --jq 'map(select(.isCrossRepository | not)) | .[0] // empty')
if [[ -n $pull ]]; then
  echo "Sync PR #$(jq -r .number <<<"$pull") is already open; leaving its branch unchanged."
  if jq -e '(.isDraft | not) and .autoMergeRequest == null' <<<"$pull" >/dev/null; then
    queue_merge "$(jq -r .number <<<"$pull")" "$(jq -r .headRefOid <<<"$pull")"
  fi
  exit 0
fi

git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
git fetch --no-tags https://github.com/pingdotgg/t3code.git +refs/heads/main:refs/remotes/upstream/main
if git merge-base --is-ancestor upstream/main origin/main; then
  echo "main already includes upstream."
  exit 0
fi

previous=$(git ls-remote --heads origin "refs/heads/$branch" | cut -f1)
if [[ -n $previous ]]; then
  git fetch --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  previous=$(git rev-parse "origin/$branch")
  if ! git merge-base --is-ancestor "$previous" origin/main; then
    echo "::error::$branch has unmerged commits and no open PR. Inspect it, then delete it to resume syncing."
    exit 1
  fi
  git push --force-with-lease="refs/heads/$branch:$previous" origin ":refs/heads/$branch"
fi

upstream_sha=$(git rev-parse upstream/main)
body="Merges pingdotgg/t3code main at $upstream_sha."
draft=()
if tree=$(git merge-tree --write-tree --name-only --no-messages origin/main upstream/main); then
  head=$(git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit-tree "$tree" -p origin/main -p upstream/main -m "Merge pingdotgg/t3code main at ${upstream_sha:0:12}")
  body+=$'\n\nGitHub merges this PR after required CI passes. Keep the merge commit to preserve upstream history.'
else
  status=$?
  if ((status != 1)); then
    echo "::error::git merge-tree failed with exit code $status."
    exit "$status"
  fi
  # Exit 1 means conflicts: line 1 is the tree, then one conflicted path per line.
  head=$upstream_sha
  draft=(--draft)
  body+=$'\n\nResolve conflicts by merging main into this branch, then mark the PR ready. '
  body+=$'The next sync run enables auto-merge.\n\nConflicting files:\n\n'
  # Indented code prevents conflict paths from becoming mentions in the PR body.
  body+=$(tail -n +2 <<<"$tree" | sed 's/^/    /')
fi

git push origin "$head:refs/heads/$branch"
pr=$(gh pr create --base main --head "$branch" --title "chore(sync): import upstream ${upstream_sha:0:12}" \
  --body "$body" "${draft[@]}")
echo "$pr"
if [[ ${#draft[@]} == 0 ]]; then
  queue_merge "$pr" "$head"
fi
