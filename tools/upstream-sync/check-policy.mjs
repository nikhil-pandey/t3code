import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const pathRules = [
  [/^(?:\.github|\.agents|tools\/upstream-sync)\//, "Sync policy or GitHub automation changed"],
  [
    /^(?:infra|scripts|native|packaging|patches|\.repos)\//,
    "Infrastructure, build tooling or native code changed",
  ],
  [
    /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|[^/]*lock[^/]*|Cargo\.toml|go\.mod|go\.sum|Gemfile|Podfile|requirements[^/]*|pyproject\.toml)(?:$|\.)/i,
    "Dependencies changed",
  ],
  [
    /(?:^|\/)(?:[^/]*config\.[^/]+|\.env[^/]*|\.npmrc|\.gitmodules|\.gitattributes|AGENTS\.md|CLAUDE\.md|\.task-cache\.json|eas\.json|t3\.json|Dockerfile|Makefile)$/i,
    "Build or runtime configuration changed",
  ],
  [
    /\.(?:gradle|plist|entitlements|xcconfig|podspec)$|(?:^|\/)AndroidManifest\.xml$/i,
    "Native configuration changed",
  ],
  [
    /(?:telemetry|analytics|observability|observe|sourcemap|crashreport|favicon)/i,
    "Privacy-sensitive instrumentation changed",
  ],
  [
    /(?:^|\/)(?:cloud|relay|auth(?:orization)?|provider[^/]*|updates?|connection|usage|triage|resourceTelemetry|diagnostics|secret-provider[^/]*)\//i,
    "Network, identity or diagnostic integration changed",
  ],
  [
    /(?:^|\/)(?:[^/]*(?:auth|update|network|notification|registration|relay|tracing|backgroundActivity|background-activity)[^/]*|http|ws|server|serverRuntimeStartup|runtime|bootstrap|bin|main|index)\.(?:[cm]?[jt]sx?|swift|kt)$/i,
    "Application initialization or network entry point changed",
  ],
  [
    /^(?:apps\/mobile\/modules|apps\/desktop\/src\/(?:electron|ipc))\//,
    "Native application bridge changed",
  ],
];

const telemetryChange =
  /\b(?:telemetry|analytics|posthog|sentry|opentelemetry|otlp|axiom|observe|crashReportsEnabled|dispatchingEnabled|errorHandlingEnabled|DO_NOT_TRACK|NO_TRACK|CLERK_TELEMETRY_DISABLED|Expo-Fatal-Error|EAS-Client-ID|x-user-staging-id)\b/i;
const addedNetwork =
  /https?:\/\/|wss?:\/\/|\b(?:fetch|sendBeacon|XMLHttpRequest|WebSocket|EventSource|axios|HttpClient|HttpClientRequest|URLSession|OkHttpClient|curl|wget|Invoke-WebRequest)\b|\b(?:https?|net|tls)\s*\./i;
const addedDependencyImport =
  /\b(?:from\s+|(?:import|require)\s*(?:\(\s*)?)["'](?![./]|node:|@t3tools\/)/;

export function classifyChanges(files) {
  const reasons = new Set();
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new Error("Changed paths must be nonempty strings");
    }
    for (const [pattern, reason] of pathRules) {
      if (pattern.test(file)) reasons.add(`${reason}: ${file}`);
    }
  }
  return { requiresReview: reasons.size > 0, reasons: [...reasons].sort() };
}

function git(args) {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveCommit(revision) {
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error("Both base and head revisions are required");
  }
  return git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim();
}

export function inspectChanges(base, head) {
  const revisions = [resolveCommit(base), resolveCommit(head)];
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const files = git([...diff, "--name-only", "-z", ...revisions, "--"])
    .split("\0")
    .filter(Boolean);
  const reasons = new Set(classifyChanges(files).reasons);
  const raw = git([...diff, "--raw", "-z", ...revisions, "--"]).split("\0");
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const [oldMode, newMode] = raw[index].slice(1).split(" ");
    if ([oldMode, newMode].some((mode) => mode === "120000" || mode === "160000")) {
      reasons.add(`Symlink or submodule changed: ${raw[index + 1]}`);
    }
    if (newMode === "100755" && oldMode !== newMode) {
      reasons.add(`Executable permission added: ${raw[index + 1]}`);
    }
  }
  for (const record of git([...diff, "--numstat", "-z", ...revisions, "--"]).split("\0")) {
    if (record.startsWith("-\t-\t")) reasons.add(`Binary file changed: ${record.slice(4)}`);
  }
  // Documentation prose is not executable; source/config additions still need a content-level review gate.
  const contentFiles = files.filter((file) => !/\.(?:md|txt|rst)$/i.test(file));
  if (contentFiles.length > 0) {
    const patch = git([...diff, "--no-color", "--unified=0", ...revisions, "--", ...contentFiles]);
    for (const line of patch.split("\n")) {
      if ((!line.startsWith("+") && !line.startsWith("-")) || /^[+-]{3}/.test(line)) continue;
      if (telemetryChange.test(line.slice(1)))
        reasons.add("Telemetry or privacy controls changed in source");
      if (!line.startsWith("+")) continue;
      if (addedNetwork.test(line.slice(1)))
        reasons.add("Network access or endpoint added in source");
      if (addedDependencyImport.test(line.slice(1)))
        reasons.add("External dependency import added in source");
    }
  }
  return { requiresReview: reasons.size > 0, reasons: [...reasons].sort() };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node check-policy.mjs BASE HEAD");
    process.stdout.write(
      `${JSON.stringify(inspectChanges(process.argv[2], process.argv[3]), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Unable to inspect upstream changes: ${error.message}\n`);
    process.exitCode = 1;
  }
}
