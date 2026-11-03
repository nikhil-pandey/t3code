# Maintaining the downstream repository

Upstream is [pingdotgg/t3code](https://github.com/pingdotgg/t3code); this repository keeps its own changes on `main`.
Syncs use Git merge ancestry. Do not squash or rebase an upstream sync PR, and never force-push `main`.
Ordinary feature PRs may be squashed. Keep privacy changes focused by subsystem so upstream conflicts remain reviewable.

## Automation

`Sync upstream` runs daily at **06:17 UTC** and can be dispatched manually from `main`. It fetches upstream `main`,
merges it with our current `main`, and opens or updates one `automation/upstream-sync` PR. No new upstream commits means
no change. An already-merged bot branch is deleted with a lease before reuse; open PR branches are never force-pushed.

`Promote upstream sync` runs after successful `CI`, hourly at **:47 UTC** to pick up later approvals, or on manual dispatch
from `main`. It uses the scripts on trusted `main`, checks the current PR head and latest explicitly dispatched CI run,
and merges through GitHub's API. It does not execute candidate code with its write token. GitHub enforces the required
`Check` status and current-base requirement through the main ruleset.

Low-risk, conflict-free changes dispatch CI immediately and merge automatically when it passes. Sensitive changes need
maintainer approval of the current commit before the automation dispatches CI. Changes to dependencies, workflows,
network/identity/telemetry code, native configuration, binary files and runtime/build settings require review.
The checker also examines source additions and removals. It is conservative diff triage, not proof that networking is
absent. It does not remove existing telemetry or replace review/runtime verification of future privacy patches.

The bot creates PRs with `GITHUB_TOKEN` and explicitly dispatches CI rather than relying on token-generated PR events.
GitHub may still show an approval request for the ordinary PR-triggered run. The explicit CI dispatch supplies the
validation used by promotion. Token-authenticated pushes to an existing PR can also start ordinary PR CI before review;
the maintainer approval gate governs promotion, not every native GitHub CI trigger. Human reviews requesting changes
block promotion only when made by a maintainer. The bot checks the latest review state; an approval must match the
current head commit.

## Repository setup

The workflows become available after this setup PR is merged. They are restricted to `nikhil-pandey/t3code`.

1. Enable Actions, and enable **Allow GitHub Actions to create and approve pull requests** in repository Actions settings.
   The automation creates PRs but never submits approval reviews.
2. Keep an active repository ruleset targeting `refs/heads/main`, with no bot bypass, requiring pull requests and the
   `Check` status with **Require branches to be up to date before merging**. Disallow force pushes and branch deletion.
   Set the blanket required-approval count to zero so low-risk syncs can merge; the promotion script enforces the
   additional maintainer approval for sensitive/conflicting syncs. Human feature PR review is a separate policy choice.
3. Create an **`upstream-sync` environment**, restrict its deployment branches to **`main` only**, and put
   **`UPSTREAM_SYNC_TOKEN`** in that environment’s secrets for imports that modify workflow files. Use a
   fine-grained token restricted to this repository with **Contents: read/write** and **Workflows: read/write**.
   The environment restriction keeps the credential available to the trusted sync job and unavailable to candidate CI.
   Do not put this token in repository-wide secrets. A short-lived token issued by a dedicated
   GitHub App is a suitable future replacement. Do not copy a broad personal CLI login into this secret.
   Without this secret, ordinary imports can work, but workflow-changing imports stop with a setup message.
4. Keep inherited production-release owner guards. Add fork-owned release/deployment jobs separately; syncing source
   is not authorization to publish apps, OTA updates, packages or cloud infrastructure.

CI preserves upstream's Blacksmith runner choices for `pingdotgg/t3code`; this repository uses standard GitHub-hosted
Linux and macOS runners. Existing tests, builds and the aggregate `Check` gate are retained.

## Conflicts and human review

Conflicts produce a draft PR containing the target upstream commit and conflicting files. No conflict markers are
committed. For a first conflicting import, its branch points at upstream; merge our `main` into it while resolving.
For an existing PR, its previous branch is preserved and the PR records the newer upstream commit still to include.

Once a sync needs human review, daily runs stop changing its branch. Resolve against both the latest `origin/main` and
the exact upstream SHA in the PR body, preserve our patches, and push the resolution to the same branch. Mark a draft
ready for review and approve the current head. Hourly promotion will dispatch missing CI, then merge after success.
Dispatch `Promote upstream sync` manually to avoid waiting. Failed CI is not repeatedly retried by the schedule; fix
the failure or rerun CI. New commits require new approval and CI.

Adding **`sync:paused`** stops both automatic updates and merging. Remove it to resume. The `sync:needs-review` and
`sync:conflict` labels require approval; they may remain until merge. The bot will not overwrite a branch that has
received approval or requested-changes reviews. If `main` advances, merge it into the sync branch and rerun checks.

Closing an unmerged sync PR leaves its branch for inspection. Before starting a replacement, manually decide what to
do with that branch; the bot will stop rather than discard it. GitHub branch deletion after a successful merge is safe.

Run the policy checker from trusted code against a candidate without checking out or executing candidate scripts:

```sh
node tools/upstream-sync/check-policy.mjs origin/main automation/upstream-sync
```

Review new telemetry SDKs/exporters, external URLs, identity collection, update feeds, native modules and build-variable
injection even if Git reports a clean merge. For shipped builds, verify privacy behavior across all supported platforms.
Keep the upstream LICENSE and relevant attribution when maintaining downstream changes.

## GitHub fork association

This process does not depend on GitHub marking the repository as a fork. Keep the Git `upstream` remote after detachment.
Use **Leave fork network** in the [repository settings](https://github.com/nikhil-pandey/t3code/settings) when eligible.
GitHub warns that fork-associated metadata is permanently removed, so detach before creating important PRs or after
they are merged and their review records have been preserved. Do not delete/recreate the repository or mirror-push
over `main` as part of this automation.

References: [workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[repository rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[fork detachment](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork).
