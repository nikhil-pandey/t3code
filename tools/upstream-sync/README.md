# Upstream sync

[`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml) runs daily at 06:17 UTC, or manually from `main`. It
merges [pingdotgg/t3code](https://github.com/pingdotgg/t3code) `main` into `automation/upstream-sync` and opens a PR
that GitHub auto-merges after required CI passes. It never pushes to `main` and never rewrites an open PR's branch.

## Setup

- In repository settings, enable **Allow auto-merge** and **Allow merge commits**.
- Add an active ruleset on `main` that requires PRs and the **Check** status, with **Require branches to be up to date
  before merging**. Do not give the bot a bypass. To merge syncs without review, set required approvals to zero.
  Without this rule, the workflow opens the PR but fails instead of enabling auto-merge.
- Create an **upstream-sync** environment that only allows deployments from `main`. Add the **UPSTREAM_SYNC_TOKEN**
  environment secret: a fine-grained token for this repository with read/write access to **Contents**,
  **Pull requests**, and **Workflows**. PRs opened with this token run the usual CI.

## Operating

- **Conflicts:** the workflow opens a draft PR that lists the conflicting files. Its branch is upstream `main`, so
  resolve by merging `main` into it, then mark the PR ready. The next run enables auto-merge.
- **Stale PR:** if `main` moves while a sync PR is open, use **Update branch** or merge `main` into it. Newer upstream
  commits wait until the open PR merges.
- **Failed checks:** these block the merge. Fix the problem on the branch or rerun the check.
- **Leftover branch:** a merged sync branch is deleted and reused. If the branch has commits that never reached `main`
  and has no open PR, the run fails until someone inspects and deletes it.
- **Pausing:** to pause one sync, convert its PR to a draft. To pause all syncs, disable the workflow.

Always merge sync PRs with a merge commit so upstream history is kept. Put our own changes in separate feature PRs.
