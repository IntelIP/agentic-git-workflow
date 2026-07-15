import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runExternalCommand } from "./external-command.mjs";
import { runGit } from "./git-process.mjs";
import { contract } from "./contract-checks.mjs";
import {
  parseGitHubRepositoryRemote,
  readRemoteRefOid,
  sameGitHubRepository,
} from "./github-repository.mjs";
import { validatePlatformConfig } from "./platform-config.mjs";
import { repositoryIdentity } from "./repository-identity.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

const PREFLIGHT_VERSION = "tabellio-preflight/v0.1";
const PROFILES = new Set(["agent", "release"]);
const MINIMUM_ENTIRE_VERSION = [0, 7, 7];

export async function runPreflight({
  repoPath = process.cwd(),
  profile = "agent",
  entireBinary = "entire",
  ghBinary = "gh",
  commandRunner = runExternalCommand,
  controlRemote = null,
  remoteRefReader = readRemoteRefOid,
  nodeVersion = process.versions.node,
  now = new Date(),
} = {}) {
  if (!PROFILES.has(profile)) throw new Error("profile must be agent or release.");
  const checks = [];
  const resolvedRepo = resolve(repoPath);
  let store = null;
  let repositoryId = null;

  await record(checks, "node-version", async () => {
    if (majorVersion(nodeVersion) < 20) return blocked(`Node ${nodeVersion} is below required major 20.`, "Install Node.js 20 or later.");
    return passed(`Node ${nodeVersion}.`);
  });

  await record(checks, "git-repository", async () => {
    store = await NativeGitStore.open(resolvedRepo);
    repositoryId = await repositoryIdentity(store);
    return passed(`Repository ${repositoryId}.`);
  });

  await recordRepositoryChecks({ checks, store, profile, commandRunner, ghBinary, controlRemote, remoteRefReader });

  await record(checks, "entire-version", async () => {
    const result = await commandRunner({ binary: entireBinary, args: ["--version"], cwd: resolvedRepo, timeoutMs: 30_000 });
    const version = parseEntireVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) return blocked("Entire CLI version could not be parsed.", "Install Entire CLI 0.7.7 or later.");
    if (compareVersion(version, MINIMUM_ENTIRE_VERSION) < 0) {
      return blocked(`Entire CLI ${version.join(".")} is below required 0.7.7.`, "Upgrade Entire CLI.");
    }
    return passed(`Entire CLI ${version.join(".")}.`);
  });

  await record(checks, "entire-enabled", async () => {
    const result = await commandRunner({ binary: entireBinary, args: ["status", "--json"], cwd: resolvedRepo, timeoutMs: 30_000 });
    const status = JSON.parse(result.stdout);
    if (status.enabled !== true) return blocked("Entire is disabled.", "Run entire enable --agent codex --strategy manual-commit.");
    if (!Array.isArray(status.agents) || !status.agents.includes("Codex")) {
      return blocked("Entire is enabled without Codex integration.", "Run entire agent add codex.");
    }
    return passed("Entire enabled for Codex.");
  });

  await record(checks, "entire-doctor", async () => {
    const result = await commandRunner({ binary: entireBinary, args: ["doctor"], cwd: resolvedRepo, timeoutMs: 30_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (/Codex hook trust:\s*REVIEW NEEDED/i.test(output)) {
      return blocked("Codex Entire hooks are not trusted on this machine.", "Open /hooks in Codex, approve all four repository hooks, then rerun preflight.");
    }
    if (!/Metadata branches:\s*OK/i.test(output)) {
      return blocked("Entire metadata branches are unhealthy or unverifiable.", "Run entire doctor and resolve metadata branch errors.");
    }
    if (!/Codex hook trust:/i.test(output)) {
      return blocked("Entire doctor did not verify Codex hook trust.", "Reinstall Entire Codex hooks and approve them through /hooks.");
    }
    return passed("Entire metadata and Codex hook trust healthy.");
  });

  await record(checks, "github-auth", async () => {
    await commandRunner({ binary: ghBinary, args: ["auth", "status", "--hostname", "github.com"], cwd: resolvedRepo, timeoutMs: 30_000 });
    return passed("GitHub CLI authenticated for github.com.");
  });

  const status = preflightStatus(checks);
  return validatePreflightResult({
    schemaVersion: PREFLIGHT_VERSION,
    profile,
    repository: { id: knownRepositoryId(repositoryId) },
    status,
    checks,
    checkedAt: now.toISOString(),
  });
}

export function validatePreflightResult(value) {
  contract.object(value, "preflight");
  contract.exactKeys(value, ["schemaVersion", "profile", "repository", "status", "checks", "checkedAt"], "preflight");
  contract.equals(value.schemaVersion, PREFLIGHT_VERSION, "preflight.schemaVersion");
  contract.member(value.profile, ["agent", "release"], "preflight.profile");
  contract.object(value.repository, "preflight.repository");
  contract.exactKeys(value.repository, ["id"], "preflight.repository");
  contract.string(value.repository.id, "preflight.repository.id");
  contract.member(value.status, ["ready", "blocked"], "preflight.status");
  validatePreflightChecks(value.checks);
  contract.equals(value.status, preflightStatus(value.checks), "preflight.status");
  contract.date(value.checkedAt, "preflight.checkedAt");
  return value;
}

async function recordRepositoryChecks({ checks, store, profile, commandRunner, ghBinary, controlRemote, remoteRefReader }) {
  if (!store) return;
  await record(checks, "platform-contract", () => checkPlatformContract(store));
  await record(checks, "github-remotes", () => checkGitHubRemotes({ store, commandRunner, ghBinary, controlRemote }));
  await record(checks, "codex-hooks", () => checkCodexHooks(store));
  if (profile === "release") await record(checks, "clean-main", () => checkCleanMain(store, remoteRefReader));
}

async function checkPlatformContract(store) {
  const source = await readFile(resolve(store.repoPath, "tabellio.platform.json"), "utf8");
  validatePlatformConfig(JSON.parse(source));
  return passed("GitHub code storage and external control-state contract valid.");
}

async function checkGitHubRemotes({ store, commandRunner, ghBinary, controlRemote }) {
  const platform = await readPlatformConfig(store);
  const configuredControl = platform.workflow.controlRemoteName;
  const selectedControl = controlRemote || configuredControl;
  const selectionBlocker = controlSelectionBlocker(selectedControl, configuredControl);
  if (selectionBlocker) return selectionBlocker;
  const [originUrl, controlUrl] = await Promise.all([
    store.gitConfig("remote.origin.url"),
    store.gitConfig(`remote.${selectedControl}.url`),
  ]);
  const origin = parseGitHubRepositoryRemote(originUrl);
  const control = parseGitHubRepositoryRemote(controlUrl);
  const remoteBlocker = githubRemoteBlocker({ originUrl, controlUrl, origin, control, selectedControl });
  if (remoteBlocker) return remoteBlocker;
  const result = await commandRunner({
    binary: ghBinary,
    args: ["repo", "view", control.fullName, "--json", "nameWithOwner,isPrivate"],
    cwd: store.repoPath,
    timeoutMs: 30_000,
  });
  return privateControlResult(JSON.parse(result.stdout), control, selectedControl);
}

function controlSelectionBlocker(selected, configured) {
  if (selected === configured) return null;
  return blocked(`Selected control remote ${selected} does not match platform remote ${configured}.`, `Use --control-remote ${configured}.`);
}

function githubRemoteBlocker({ originUrl, controlUrl, origin, control, selectedControl }) {
  return firstBlocker([
    () => originUrl ? null : blocked("origin remote missing.", "Configure GitHub code remote as origin."),
    () => controlUrl ? null : blocked(`${selectedControl} remote missing.`, "Configure the private GitHub control remote."),
    () => origin ? null : blocked("origin is not a supported GitHub remote.", "Set origin to the canonical GitHub repository."),
    () => control ? null : blocked(`${selectedControl} is not a supported GitHub remote.`, "Set the control remote to the private GitHub control repository."),
    () => sameGitHubRepository(origin, control) ? blocked("origin and control target the same GitHub repository.", "Use separate GitHub repositories for code and private control state.") : null,
  ], null);
}

function privateControlResult(repository, control, selectedControl) {
  if (String(repository.nameWithOwner).toLowerCase() !== control.key) {
    return blocked("GitHub returned a different control repository identity.", "Correct the control remote and GitHub authentication scope.");
  }
  if (repository.isPrivate !== true) {
    return blocked(`Control repository ${control.fullName} is public.`, "Make the GitHub control repository private before continuing.");
  }
  return passed(`origin and ${selectedControl} are distinct; control repository is private.`);
}

async function checkCodexHooks(store) {
  const hooks = JSON.parse(await readFile(resolve(store.repoPath, ".codex/hooks.json"), "utf8"));
  const declared = new Map(Object.entries(hooks.hooks || {}).map(([name, entries]) => [name.toLowerCase(), entries]));
  const required = new Map([
    ["sessionstart", "session-start"],
    ["userpromptsubmit", "user-prompt-submit"],
    ["stop", "stop"],
    ["posttooluse", "post-tool-use"],
  ]);
  const missing = [...required].filter(([event, command]) => !hasEntireHook(declared.get(event), command)).map(([event]) => event);
  if (missing.length > 0) return blocked(`Codex Entire hooks missing: ${missing.join(", ")}.`, "Reinstall Entire Codex hooks for this repository.");
  return passed("Four required Entire Codex hook commands declared.");
}

async function checkCleanMain(store, remoteRefReader) {
  const [status, branch, head, trackedMain] = await Promise.all([
    runGit({ args: ["status", "--porcelain=v1"], cwd: store.repoPath }),
    runGit({ args: ["branch", "--show-current"], cwd: store.repoPath }),
    store.resolveRef("HEAD"),
    store.resolveRef("origin/main"),
  ]);
  const branchName = branch.stdout.trim();
  const rules = [
    () => status.stdout === "" ? null : blocked("Worktree is not clean.", "Commit or remove local changes before release planning."),
    () => branchName === "main" ? null : blocked(`Current branch is ${branchName || "detached"}.`, "Switch to main before release planning."),
    () => head === trackedMain ? null : blocked("main does not equal tracked origin/main.", "Fetch and fast-forward main before release planning."),
  ];
  const localBlocker = firstBlocker(rules, null);
  if (localBlocker) return localBlocker;
  const liveMain = await remoteRefReader({ repoPath: store.repoPath, remote: "origin", ref: "refs/heads/main" });
  if (head !== liveMain) return blocked("main does not equal live origin/main.", "Fetch and fast-forward main before release planning.");
  return passed(`Clean main equals live origin/main at ${head}.`);
}

async function readPlatformConfig(store) {
  const source = await readFile(resolve(store.repoPath, "tabellio.platform.json"), "utf8");
  return validatePlatformConfig(JSON.parse(source));
}

function hasEntireHook(entries, expectedCommand) {
  if (!Array.isArray(entries)) return false;
  const commandPattern = new RegExp(`(?:^|[\\s;&|'\"])(?:exec\\s+)?entire\\s+hooks\\s+codex\\s+${expectedCommand}(?=$|[\\s;&|'\"])`);
  return entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => {
    if (hook?.type !== "command" || typeof hook.command !== "string") return false;
    return commandPattern.test(hook.command);
  }));
}

function firstBlocker(rules, fallback) {
  for (const rule of rules) {
    const result = rule();
    if (result) return result;
  }
  return fallback;
}

function validatePreflightChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error("preflight.checks must be non-empty.");
  const ids = new Set();
  for (const [index, check] of checks.entries()) {
    validatePreflightCheck(check, index, ids);
  }
}

function validatePreflightCheck(check, index, ids) {
  const path = `preflight.checks[${index}]`;
  contract.object(check, path);
  contract.exactKeys(check, ["id", "required", "status", "detail", "resolution"], path);
  contract.string(check.id, `${path}.id`);
    if (ids.has(check.id)) throw new Error(`preflight.checks contains duplicate id ${check.id}.`);
  ids.add(check.id);
  contract.equals(check.required, true, `${path}.required`);
  contract.member(check.status, ["passed", "blocked"], `${path}.status`);
  contract.string(check.detail, `${path}.detail`);
  validateResolution(check, path);
}

function validateResolution(check, path) {
  if (check.status === "blocked") contract.string(check.resolution, `${path}.resolution`);
  if (check.status === "passed") contract.equals(check.resolution, null, `${path}.resolution`);
}

function preflightStatus(checks) {
  const blockedCheck = checks.find((check) => check.required && check.status === "blocked");
  return blockedCheck ? "blocked" : "ready";
}

function knownRepositoryId(value) {
  return value || "unknown";
}

async function record(checks, id, action) {
  try {
    const result = await action();
    checks.push({ id, required: true, ...result });
  } catch (error) {
    checks.push({
      id,
      required: true,
      status: "blocked",
      detail: safeError(error),
      resolution: defaultResolution(id),
    });
  }
}

function passed(detail) {
  return { status: "passed", detail, resolution: null };
}

function blocked(detail, resolution) {
  return { status: "blocked", detail, resolution };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/gho_[A-Za-z0-9_]+/g, "[REDACTED]").slice(0, 500);
}

function defaultResolution(id) {
  if (id.startsWith("entire")) return "Install or repair Entire, then rerun preflight.";
  if (id === "github-auth") return "Run gh auth login for github.com.";
  return "Resolve this required check, then rerun preflight.";
}

function parseEntireVersion(value) {
  const match = value.match(/Entire CLI\s+(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1).map(Number) : null;
}

function majorVersion(value) {
  const match = String(value).match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = versionPart(left, index) - versionPart(right, index);
    if (delta !== 0) return delta;
  }
  return 0;
}

function versionPart(version, index) {
  return Number.isInteger(version[index]) ? version[index] : 0;
}
