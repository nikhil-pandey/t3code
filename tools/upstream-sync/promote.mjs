import * as NodeURL from "node:url";
import { inspectChanges } from "./check-policy.mjs";
import {
  ancestor,
  api,
  baseBranch,
  branch,
  event,
  git,
  labels,
  list,
  metadata,
  repository,
  requireActions,
  summary,
  syncPull,
} from "./common.mjs";

export function reviewState(reviews, headSha, author) {
  const latest = new Map();
  for (const review of reviews) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latest.set(review.user.login, review);
  }
  return {
    changesRequested: [...latest.values()].some((review) => review.state === "CHANGES_REQUESTED"),
    approvers: [...latest.values()]
      .filter(
        (review) =>
          review.state === "APPROVED" &&
          review.commit_id === headSha &&
          review.user.login !== author &&
          review.user.type === "User",
      )
      .map((review) => review.user.login),
  };
}

export async function runPromotion() {
  requireActions();
  const payload = event();
  if (
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_REF !== `refs/heads/${baseBranch}`
  )
    throw new Error("Dispatch promotion from main only");
  const open = await syncPull();
  if (!open) return summary("No open upstream sync PR.");
  const pull = await api(`pulls/${open.number}`);
  if (pull.draft || pull.labels.some(({ name }) => name === labels.paused))
    return summary("Sync PR is draft or paused; no merge.");
  if (
    pull.base.ref !== baseBranch ||
    pull.head.ref !== branch ||
    pull.base.repo.full_name !== repository
  )
    throw new Error("Unexpected sync PR branches");
  const state = metadata(pull);
  const headSha = pull.head.sha;
  git(
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  );
  const baseSha = git("rev-parse", `refs/remotes/origin/${baseBranch}`);
  if (git("rev-parse", `refs/remotes/origin/${branch}`) !== headSha)
    return summary("Sync branch advanced; wait for its new CI run.");
  if (!ancestor(baseSha, headSha) || !ancestor(state.upstreamSha, headSha))
    return summary(
      "Sync branch must include current main and the requested upstream commit. Merge them and rerun CI.",
    );
  const policy = inspectChanges(baseSha, headSha);
  const rawReviews = await list(`pulls/${pull.number}/reviews`);
  const maintainers = new Set();
  for (const login of new Set(rawReviews.map((review) => review.user.login))) {
    const permission = await api(`collaborators/${encodeURIComponent(login)}/permission`);
    if (["admin", "maintain", "write"].includes(permission.permission)) maintainers.add(login);
  }
  const reviews = reviewState(
    rawReviews.filter((review) => maintainers.has(review.user.login)),
    headSha,
    pull.user.login,
  );
  if (reviews.changesRequested) return summary("A reviewer requested changes; no merge.");
  const needsReview =
    state.hadConflicts ||
    policy.requiresReview ||
    pull.labels.some(({ name }) => name === labels.review || name === labels.conflict);
  if (needsReview && reviews.approvers.length === 0)
    return summary("This sync needs a maintainer approval of the current commit.");
  const rules = await api(`rules/branches/${baseBranch}`);
  const strictCheck = rules.some(
    (rule) =>
      rule.type === "required_status_checks" &&
      rule.parameters?.strict_required_status_checks_policy === true &&
      rule.parameters.required_status_checks?.some((check) => check.context === "Check"),
  );
  if (!strictCheck)
    throw new Error(
      "Main needs an active ruleset requiring Check and an up-to-date branch before automatic merging",
    );
  const runs = await list(
    `actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&head_sha=${headSha}`,
  );
  const relevant = runs.filter(
    (run) => run.head_sha === headSha && run.event === "workflow_dispatch",
  );
  relevant.sort((a, b) => b.id - a.id);
  const latest = relevant[0];
  if (!latest) {
    await api("actions/workflows/ci.yml/dispatches", "POST", { ref: branch });
    return summary("Maintainer approval accepted; dispatched CI for the current sync head.");
  }
  if (latest.status !== "completed" || latest.conclusion !== "success")
    return summary("The latest CI run for the current PR head has not succeeded.");
  if (
    payload.workflow_run &&
    (payload.workflow_run.id !== latest.id ||
      payload.workflow_run.head_repository?.full_name !== repository)
  )
    return summary("Ignoring a stale or unrelated CI event.");
  const current = await api(`pulls/${pull.number}`);
  if (
    current.head.sha !== headSha ||
    current.base.sha !== baseSha ||
    current.draft ||
    JSON.stringify(current.labels.map(({ name }) => name).sort()) !==
      JSON.stringify(pull.labels.map(({ name }) => name).sort())
  )
    return summary("PR changed during validation; no merge.");
  const result = await api(`pulls/${pull.number}/merge`, "PUT", {
    sha: headSha,
    merge_method: "merge",
  });
  if (!result.merged) throw new Error(`GitHub declined the merge: ${result.message}`);
  summary(`Merged [sync PR #${pull.number}](${pull.html_url}) at ${result.sha}.`);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await runPromotion();
}
