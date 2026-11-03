import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export const repository = "nikhil-pandey/t3code";
export const upstream = "pingdotgg/t3code";
export const branch = "automation/upstream-sync";
export const baseBranch = "main";
export const labels = {
  sync: "upstream-sync",
  review: "sync:needs-review",
  conflict: "sync:conflict",
  paused: "sync:paused",
};

export function requireActions() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== repository) {
    throw new Error(`This automation runs only in GitHub Actions for ${repository}`);
  }
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required");
}

export function git(...args) {
  return NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function ancestor(older, newer) {
  const result = NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", older, newer]);
  if (result.status !== 0 && result.status !== 1) throw new Error("Cannot establish Git ancestry");
  return result.status === 0;
}

export async function api(path, method = "GET", body) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

export async function list(path) {
  const values = [];
  for (let page = 1; ; page++) {
    const result = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = Array.isArray(result) ? result : result.workflow_runs;
    if (!Array.isArray(items)) throw new Error(`Unexpected paginated response for ${path}`);
    values.push(...items);
    if (items.length < 100) return values;
  }
}

export async function syncPull() {
  const pulls = await api(
    `pulls?state=open&base=${baseBranch}&head=nikhil-pandey:${branch}&per_page=100`,
  );
  if (pulls.length > 1) throw new Error("Multiple open sync pull requests");
  const pull = pulls[0];
  if (
    pull &&
    (pull.user.login !== "github-actions[bot]" || pull.head.repo?.full_name !== repository)
  ) {
    throw new Error("The sync branch has a pull request not owned by this automation");
  }
  return pull;
}

export function metadata(pull) {
  const match = /<!-- upstream-sync\n([^\n]+)\n-->/.exec(pull.body ?? "");
  const value = match ? JSON.parse(match[1]) : null;
  if (value?.upstream !== upstream || !/^[a-f0-9]{40}$/.test(value.upstreamSha ?? "")) {
    throw new Error("Missing or invalid upstream sync metadata");
  }
  return value;
}

export function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

export function event() {
  return JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
}
