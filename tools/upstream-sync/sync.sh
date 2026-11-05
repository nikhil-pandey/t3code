#!/usr/bin/env bash
# Opens a bot-authored snapshot PR and preserves upstream history separately. See README.md.
set -euo pipefail

: "${GH_TOKEN:?Set UPSTREAM_SYNC_TOKEN in the upstream-sync environment}"
: "${GH_REPO:?Set GH_REPO to the destination repository}"

branch=automation/upstream-sync
revision_file=tools/upstream-sync/upstream-revision

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
upstream_sha=$(git rev-parse upstream/main)
last_upstream=$(git show "origin/main:$revision_file")
if ! git merge-base --is-ancestor "$last_upstream" "$upstream_sha"; then
  echo "::error::Upstream history no longer contains the last imported revision. Inspect it before syncing."
  exit 1
fi
git push origin "$upstream_sha:refs/heads/upstream-main"
if [[ $last_upstream == "$upstream_sha" ]]; then
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

body="Imports pingdotgg/t3code main at $upstream_sha as one bot-authored snapshot.

Original commits are preserved on upstream-main. Do not merge that branch into this PR."
draft=()
# Snapshot commits do not carry upstream ancestry, so use the recorded revision as the merge base.
if tree=$(git merge-tree --write-tree --name-only --no-messages --merge-base="$last_upstream" \
  origin/main "$upstream_sha"); then
  body+=$'\n\nGitHub merges this PR after required CI passes.'
else
  status=$?
  if ((status != 1)); then
    echo "::error::git merge-tree failed with exit code $status."
    exit "$status"
  fi
  # Exit 1 means conflicts: line 1 is the tree, then one conflicted path per line.
  draft=(--draft)
  body+=$'\n\nThis draft contains a provisional merge. Inspect every file listed below against the pinned upstream '
  body+=$'revision, including binary or rename conflicts without text markers. Edit and commit the resolutions '
  body+=$'directly on this branch, keep upstream-revision unchanged, then mark the PR ready. '
  body+=$'The next sync run enables auto-merge.\n\nConflicting files:\n\n'
  # Indented code prevents conflict paths from becoming mentions in the PR body.
  body+=$(tail -n +2 <<<"$tree" | sed 's/^/    /')
fi

# Record the import in the snapshot without touching the checkout's index.
index_dir=$(mktemp -d)
trap 'rm -rf "$index_dir"' EXIT
export GIT_INDEX_FILE="$index_dir/index"
git read-tree "${tree%%$'\n'*}"
revision_blob=$(printf '%s\n' "$upstream_sha" | git hash-object -w --stdin)
git update-index --add --cacheinfo "100644,$revision_blob,$revision_file"
tree=$(git write-tree)
head=$(git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit-tree "$tree" -p origin/main -m "Sync upstream at ${upstream_sha:0:12}")

git push origin "$head:refs/heads/$branch"
pr=$(gh pr create --base main --head "$branch" --title "chore(sync): import upstream ${upstream_sha:0:12}" \
  --body "$body" "${draft[@]}")
echo "$pr"
if [[ ${#draft[@]} == 0 ]]; then
  queue_merge "$pr" "$head"
fi
