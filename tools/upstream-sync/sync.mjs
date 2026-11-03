import * as NodeURL from "node:url";
import { inspectChanges } from "./check-policy.mjs";
import {
  ancestor,
  api,
  baseBranch,
  branch,
  git,
  labels,
  list,
  requireActions,
  summary,
  syncPull,
  upstream,
} from "./common.mjs";

export function prepareMerge(baseSha, upstreamSha, previousSha) {
  const start = previousSha ?? baseSha;
  git("checkout", "--detach", start);
  for (const target of [baseSha, upstreamSha]) {
    if (ancestor(target, "HEAD")) continue;
    try {
      git("merge", "--no-ff", "--no-edit", target);
    } catch (error) {
      const conflicts = git("diff", "--name-only", "--diff-filter=U", "-z")
        .split("\0")
        .filter(Boolean);
      if (conflicts.length === 0) throw error;
      git("merge", "--abort");
      git("reset", "--hard", start);
      return { headSha: previousSha ?? upstreamSha, conflicts };
    }
  }
  return { headSha: git("rev-parse", "HEAD"), conflicts: [] };
}

async function ensureLabels() {
  const existing = new Set((await list("labels")).map((label) => label.name));
  for (const [kind, name] of Object.entries(labels)) {
    if (!existing.has(name))
      await api("labels", "POST", {
        name,
        color: kind === "sync" ? "0366d6" : "d4c5f9",
        description:
          kind === "paused"
            ? "Pause automatic upstream updates and merging"
            : `Upstream sync: ${kind}`,
      });
  }
}

export async function runSync() {
  requireActions();
  if (process.env.GITHUB_REF !== `refs/heads/${baseBranch}`)
    throw new Error("Dispatch sync from main only");
  const open = await syncPull();
  if (
    open &&
    (open.draft ||
      open.labels.some(({ name }) =>
        [labels.review, labels.conflict, labels.paused].includes(name),
      ))
  ) {
    summary(`Sync PR #${open.number} needs human attention; its branch was left untouched.`);
    return;
  }
  if (
    open &&
    (await list(`pulls/${open.number}/reviews`)).some((review) =>
      ["APPROVED", "CHANGES_REQUESTED"].includes(review.state),
    )
  ) {
    summary(`Sync PR #${open.number} has human review; its branch was left untouched.`);
    return;
  }
  git(
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  );
  git(
    "fetch",
    "--no-tags",
    `https://github.com/${upstream}.git`,
    "+refs/heads/main:refs/remotes/upstream/main",
  );
  const baseSha = git("rev-parse", `refs/remotes/origin/${baseBranch}`);
  const upstreamSha = git("rev-parse", "refs/remotes/upstream/main");
  if (ancestor(upstreamSha, baseSha)) {
    summary("Upstream main is already included in this repository's main.");
    return;
  }
  const remoteRef = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  let previousSha;
  if (remoteRef) {
    git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    previousSha = git("rev-parse", `refs/remotes/origin/${branch}`);
    if (!open) {
      if (!ancestor(previousSha, baseSha))
        throw new Error("An unmerged sync branch exists without an open PR; inspect it manually");
      git(
        "push",
        `--force-with-lease=refs/heads/${branch}:${previousSha}`,
        "origin",
        `:refs/heads/${branch}`,
      );
      previousSha = undefined;
    }
  }
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  const candidate = prepareMerge(baseSha, upstreamSha, previousSha);
  const policy = candidate.conflicts.length
    ? { requiresReview: true, reasons: [] }
    : inspectChanges(baseSha, candidate.headSha);
  const requiresReview = policy.requiresReview || candidate.conflicts.length > 0;
  const state = {
    version: 1,
    upstream,
    upstreamSha,
    baseSha,
    hadConflicts: candidate.conflicts.length > 0,
  };
  const body = [
    `Import upstream through [${upstreamSha.slice(0, 12)}](https://github.com/${upstream}/commit/${upstreamSha}).`,
    "",
    requiresReview
      ? "Human review is required before this sync can merge."
      : "This sync can merge automatically after CI succeeds.",
    "",
    ...candidate.conflicts.map((file) => `- Conflict: \`${file}\``),
    ...policy.reasons.slice(0, 100).map((reason) => `- ${reason}`),
    ...(policy.reasons.length > 100
      ? [
          `- ${policy.reasons.length - 100} more reasons; run the policy checker for the complete list.`,
        ]
      : []),
    "",
    "For review-required changes, approve the current commit; promotion will dispatch CI. Resolve conflicts on this branch, include current main and the upstream commit above, then mark the draft ready for review.",
    "Use a merge commit to preserve upstream ancestry. Add `sync:paused` to stop automation.",
    "",
    "<!-- upstream-sync",
    JSON.stringify(state),
    "-->",
  ].join("\n");
  await ensureLabels();
  const workflowChanges = git(
    "diff",
    "--name-only",
    previousSha ?? baseSha,
    candidate.headSha,
    "--",
    ".github/workflows/",
  );
  if (workflowChanges && process.env.SYNC_WORKFLOW_TOKEN_AVAILABLE !== "true") {
    throw new Error(
      "Upstream changes GitHub workflows. Configure UPSTREAM_SYNC_TOKEN with repository Contents and Workflows write permissions, then rerun Sync upstream. Nothing was pushed to main.",
    );
  }
  git("push", "origin", `${candidate.headSha}:refs/heads/${branch}`);
  const pull = open
    ? await api(`pulls/${open.number}`, "PATCH", {
        title: `chore(sync): import upstream ${upstreamSha.slice(0, 12)}`,
        body,
      })
    : await api("pulls", "POST", {
        title: `chore(sync): import upstream ${upstreamSha.slice(0, 12)}`,
        body,
        head: branch,
        base: baseBranch,
        draft: candidate.conflicts.length > 0,
      });
  await api(`issues/${pull.number}/labels`, "POST", {
    labels: [
      labels.sync,
      ...(requiresReview ? [labels.review] : []),
      ...(candidate.conflicts.length ? [labels.conflict] : []),
    ],
  });
  if (!requiresReview) {
    // Explicit dispatch also works when a GITHUB_TOKEN-created PR does not trigger ordinary PR CI.
    await api("actions/workflows/ci.yml/dispatches", "POST", { ref: branch });
  }
  summary(
    `[Sync PR #${pull.number}](${pull.html_url}) targets ${upstreamSha}; ${requiresReview ? "human review required" : "awaiting CI for automatic merge"}.`,
  );
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await runSync();
}
