import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { runExternalCommand } from "./external-command.mjs";
import { runGit } from "./git-process.mjs";
import { contract } from "./contract-checks.mjs";
import {
  effectiveGitHubRepository,
  readRemoteRefOid,
  sameGitHubRepository,
} from "./github-repository.mjs";
import { validatePlatformConfig } from "./platform-config.mjs";
import { repositoryIdentity } from "./repository-identity.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

const PREFLIGHT_VERSION = "tabellio-preflight/v0.1";
const PROFILES = new Set(["agent", "release"]);
const MINIMUM_ENTIRE_VERSION = [0, 7, 7];
const REQUIRED_CODEX_HOOKS = [
  { configEvent: "SessionStart", event: "session_start", command: "session-start" },
  { configEvent: "UserPromptSubmit", event: "user_prompt_submit", command: "user-prompt-submit" },
  { configEvent: "Stop", event: "stop", command: "stop" },
  { configEvent: "PostToolUse", event: "post_tool_use", command: "post-tool-use" },
];

export async function runPreflight({
  repoPath = process.cwd(),
  profile = "agent",
  entireBinary = "entire",
  ghBinary = "gh",
  codexBinary = "codex",
  commandRunner = runExternalCommand,
  controlRemote = null,
  remoteRefReader = readRemoteRefOid,
  remoteRepositoryReader = effectiveGitHubRepository,
  nodeVersion = process.versions.node,
  codexConfigPath = defaultCodexConfigPath(),
  now = new Date(),
} = {}) {
  if (!PROFILES.has(profile)) throw new Error("profile must be agent or release.");
  const checks = [];
  const resolvedRepo = resolve(repoPath);
  let store = null;
  let repositoryId = null;
  let codexConfigReady = false;

  await record(checks, "node-version", async () => {
    if (majorVersion(nodeVersion) < 20) return blocked(`Node ${nodeVersion} is below required major 20.`, "Install Node.js 20 or later.");
    return passed(`Node ${nodeVersion}.`);
  });

  await record(checks, "git-repository", async () => {
    store = await NativeGitStore.open(resolvedRepo);
    repositoryId = await repositoryIdentity(store);
    return passed(`Repository ${repositoryId}.`);
  });

  await recordRepositoryChecks({ checks, store, profile, commandRunner, ghBinary, controlRemote, remoteRefReader, remoteRepositoryReader });

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

  await record(checks, "entire-metadata", () => store
    ? checkEntireMetadataBranches(store, remoteRefReader)
    : blocked("Entire metadata storage could not be inspected.", "Open a Git repository, then rerun preflight."));

  await record(checks, "codex-config", async () => {
    const result = await commandRunner({
      binary: codexBinary,
      args: ["features", "list"],
      cwd: store?.repoPath ?? resolvedRepo,
      timeoutMs: 30_000,
    });
    if (!/^hooks\s+\S+\s+true\s*$/m.test(result.stdout)) {
      return blocked("Codex hooks are disabled in the effective configuration.", "Enable Codex hooks, then rerun preflight.");
    }
    codexConfigReady = true;
    return passed("Codex configuration is valid and hooks are effectively enabled.");
  });

  await record(checks, "codex-hook-trust", () => codexConfigReady
    ? checkCodexHookTrust({ repoPath: store.repoPath, codexConfigPath })
    : blocked("Codex configuration validity is unproven.", "Correct the Codex configuration, then rerun preflight."));

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

async function checkCodexHookTrust({ repoPath, codexConfigPath }) {
  const canonicalRepo = await realpath(repoPath);
  const hooksPath = await realpath(resolve(repoPath, ".codex", "hooks.json"));
  const [config, hooksSource] = await Promise.all([
    readFile(codexConfigPath, "utf8"),
    readFile(hooksPath, "utf8"),
  ]);
  const configBlocker = codexHookConfigBlocker(config, canonicalRepo);
  if (configBlocker) return configBlocker;
  const expected = expectedEntireHookTrust(JSON.parse(hooksSource), hooksPath);
  const states = codexHookStates(config);
  return codexHookTrustResult(expected, states);
}

function codexHookConfigBlocker(config, canonicalRepo) {
  return codexProjectTrusted(config, canonicalRepo)
    ? null
    : blocked("The repository project layer is not trusted by Codex.", "Trust this repository in Codex, then rerun preflight.");
}

async function checkEntireMetadataBranches(store, remoteRefReader) {
  const platform = await readPlatformConfig(store);
  const localRef = platform.ledger.checkpointRef;
  if (!(await store.hasRef(localRef))) {
    return blocked(`Entire metadata branch missing: ${localRef}.`, "Restore the local checkpoint metadata branch, then rerun preflight.");
  }
  const remote = platform.workflow.controlRemoteName;
  const liveRemote = await remoteRefReader({ repoPath: store.repoPath, remote, ref: localRef });
  const localObject = await store.resolveRef(liveRemote).catch(() => null);
  if (!localObject) {
    return blocked("The live remote Entire metadata commit is not available locally.", "Fetch the checkpoint metadata branch, then rerun preflight.");
  }
  if (!(await store.isAncestor(liveRemote, localRef))) {
    return blocked("The live remote Entire metadata branch is ahead, divergent, or disconnected from local metadata.", "Fetch and reconcile the checkpoint metadata branch explicitly, then rerun preflight.");
  }
  return checkEntireMetadataContents(store, localRef);
}

async function checkEntireMetadataContents(store, localRef) {
  const files = await store.listFiles(localRef);
  const metadataPaths = files.filter((path) => /^[0-9a-f]{2}\/[0-9a-f]{10}\/metadata\.json$/.test(path));
  if (metadataPaths.length === 0) {
    return blocked("Entire metadata branch contains no checkpoint metadata.", "Restore usable Entire checkpoint metadata, then rerun preflight.");
  }
  for (const path of metadataPaths) {
    const result = await runGit({ args: ["show", `${localRef}:${path}`], cwd: store.repoPath, gitDir: store.gitDir });
    const metadata = JSON.parse(result.stdout);
    if (!validCheckpointMetadata(metadata, path, new Set(files))) {
      return blocked(`Entire checkpoint metadata is invalid: ${path}.`, "Repair the checkpoint metadata branch explicitly, then rerun preflight.");
    }
  }
  return passed("Live remote Entire metadata is contained locally and checkpoint contents are valid.");
}

function validCheckpointMetadata(metadata, path, files) {
  const prefix = path.slice(0, -"metadata.json".length);
  const checkpointId = prefix.replaceAll("/", "");
  if (!validCheckpointEnvelope(metadata, checkpointId)) return false;
  return metadata.sessions.every((session) => validCheckpointSession(session, prefix, files));
}

function validCheckpointEnvelope(metadata, checkpointId) {
  return metadata?.checkpoint_id === checkpointId && Array.isArray(metadata.sessions) && metadata.sessions.length > 0;
}

function validCheckpointSession(session, prefix, files) {
  return [session?.metadata, session?.transcript, session?.content_hash].every((path) => typeof path === "string"
    && path.startsWith(`/${prefix}`)
    && files.has(path.slice(1)));
}

function codexHookTrustResult(expected, states) {
  const untrusted = expected.filter((hook) => !hookStateMatches(states.get(hook.key), hook.hash));
  if (expected.length === REQUIRED_CODEX_HOOKS.length && untrusted.length === 0) {
    return passed("Four current Entire hook definitions are enabled and trusted by Codex.");
  }
  const events = untrusted.map((hook) => hook.event);
  return blocked(
    `Codex Entire hook trust missing or stale: ${events.join(", ") || "required hook definitions"}.`,
    "Open /hooks in Codex, approve all four repository hooks, then rerun preflight.",
  );
}

function expectedEntireHookTrust(hooksConfig, hooksPath) {
  return REQUIRED_CODEX_HOOKS.flatMap((required) => {
    const groups = hooksConfig?.hooks?.[required.configEvent];
    return expectedHookInGroups(groups, required, hooksPath);
  });
}

function expectedHookInGroups(groups, required, hooksPath) {
  if (!Array.isArray(groups)) return [];
  for (const [groupIndex, group] of groups.entries()) {
    const handlerIndex = hookCommands(group).findIndex((hook) => matchesRequiredEntireHook(hook, required.command));
    if (handlerIndex < 0) continue;
    const handler = group.hooks[handlerIndex];
    return [{
      event: required.event,
      key: `${hooksPath}:${required.event}:${groupIndex}:${handlerIndex}`,
      hash: codexHookHash(required.event, group, handler),
    }];
  }
  return [];
}

function codexHookHash(event, group, handler) {
  const normalized = normalizedHookHandler(handler, event);
  const identity = {
    event_name: event,
    ...normalizedMatcher(event, group.matcher),
    hooks: [normalized],
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalJson(identity))).digest("hex")}`;
}

function normalizedHookHandler(handler, event) {
  return {
    type: "command",
    command: platformHookCommand(handler),
    timeout: normalizedHookTimeout(handler.timeout),
    async: handler.async === true,
    ...optionalHookFields(handler, event),
  };
}

function platformHookCommand(handler) {
  if (process.platform !== "win32") return handler.command;
  return handler.commandWindows ?? handler.command;
}

function normalizedHookTimeout(timeout) {
  return Math.max(1, timeout ?? 600);
}

function optionalHookFields(handler, event) {
  return Object.fromEntries([
    ["statusMessage", handler.statusMessage],
    ["additionalContextLimit", event === "stop" ? undefined : normalizedAdditionalContextLimit(handler.additionalContextLimit)],
  ].filter(([, value]) => value != null));
}

function normalizedAdditionalContextLimit(value) {
  return value === 2_500 ? undefined : value;
}

function normalizedMatcher(event, matcher) {
  if (["user_prompt_submit", "stop"].includes(event) || matcher == null) return {};
  return { matcher };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function codexHookStates(config) {
  return new Map(tomlQuotedTableSections(config, "hooks.state").flatMap(hookStateEntry));
}

function hookStateEntry(section) {
  const digest = tomlStringAssignment(section.body, "trusted_hash");
  return [[section.key, {
    enabled: tomlBooleanAssignment(section.body, "enabled") !== false,
    trustedHash: /^sha256:[a-f0-9]{64}$/.test(digest ?? "") ? digest : null,
  }]];
}

function hookStateMatches(state, expectedHash) {
  return state?.enabled === true && state.trustedHash === expectedHash;
}

function codexProjectTrusted(config, repoPath) {
  return tomlQuotedTableSections(config, "projects").some((section) => section.key === repoPath
    && tomlStringAssignment(section.body, "trust_level") === "trusted");
}

function decodeTomlBasicString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return null;
  }
}

function tomlQuotedTableSections(config, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\[${escaped}\\.(?:"((?:\\\\.|[^"])*)"|'([^']*)')\\]\\s*(?:#[^\\r\\n]*)?\\r?\\n((?:(?!^\\[)[\\s\\S])*)`, "gm");
  return [...config.matchAll(pattern)].flatMap((match) => {
    const key = match[1] === undefined ? match[2] : decodeTomlBasicString(match[1]);
    return key === null ? [] : [{ key, body: match[3] }];
  });
}

function tomlBooleanAssignment(body, key) {
  const value = tomlAssignment(body, key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function tomlStringAssignment(body, key) {
  const value = tomlAssignment(body, key);
  const basic = value?.match(/^"((?:\\.|[^"])*)"$/s);
  if (basic) return decodeTomlBasicString(basic[1]);
  return value?.match(/^'([^']*)'$/s)?.[1] ?? null;
}

function tomlAssignment(body, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const line of body.split(/\r?\n/)) {
    const source = stripTomlComment(line).trim();
    const match = source.match(new RegExp(`^${escaped}\\s*=\\s*(.*?)\\s*$`));
    if (match) return match[1];
  }
  return null;
}

function stripTomlComment(line) {
  for (const token of line.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|#/g)) {
    if (token[0] === "#") return line.slice(0, token.index);
  }
  return line;
}

function defaultCodexConfigPath() {
  return resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "config.toml");
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

async function recordRepositoryChecks({ checks, store, profile, commandRunner, ghBinary, controlRemote, remoteRefReader, remoteRepositoryReader }) {
  if (!store) return;
  await record(checks, "platform-contract", () => checkPlatformContract(store));
  await record(checks, "github-remotes", () => checkGitHubRemotes({ store, commandRunner, ghBinary, controlRemote, remoteRepositoryReader }));
  await record(checks, "codex-hooks", () => checkCodexHooks(store));
  if (profile === "release") await record(checks, "clean-main", () => checkCleanMain(store, remoteRefReader));
}

async function checkPlatformContract(store) {
  const source = await readFile(resolve(store.repoPath, "tabellio.platform.json"), "utf8");
  validatePlatformConfig(JSON.parse(source));
  return passed("GitHub code storage and external control-state contract valid.");
}

async function checkGitHubRemotes({ store, commandRunner, ghBinary, controlRemote, remoteRepositoryReader }) {
  const platform = await readPlatformConfig(store);
  const configuredControl = platform.workflow.controlRemoteName;
  const selectedControl = controlRemote || configuredControl;
  const selectionBlocker = controlSelectionBlocker(selectedControl, configuredControl);
  if (selectionBlocker) return selectionBlocker;
  const [origin, control] = await Promise.all([
    remoteRepositoryReader(store, "origin"),
    remoteRepositoryReader(store, selectedControl),
  ]);
  if (sameGitHubRepository(origin, control)) {
    return blocked("origin and control target the same GitHub repository.", "Use separate GitHub repositories for code and private control state.");
  }
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
  return entries.some((entry) => hookCommands(entry).some((hook) => matchesRequiredEntireHook(hook, expectedCommand)));
}

function hookCommands(entry) {
  return Array.isArray(entry?.hooks) ? entry.hooks : [];
}

function matchesRequiredEntireHook(hook, expectedCommand) {
  if (!validEntireHookShape(hook)) return false;
  const direct = new RegExp(`^(?:exec )?entire hooks codex ${expectedCommand}$`);
  const guarded = new RegExp(`^sh -c 'if ! command -v entire >/dev/null 2>&1; then .+; fi; exec entire hooks codex ${expectedCommand}'$`);
  const commands = [hook.command, hook.commandWindows].filter((command) => command != null);
  return commands.every((command) => requiredHookCommandMatches(command, [direct, guarded]));
}

function validEntireHookShape(hook) {
  return hook?.type === "command" && hook.async !== true && typeof hook.command === "string";
}

function requiredHookCommandMatches(command, patterns) {
  return typeof command === "string" && patterns.some((pattern) => pattern.test(command));
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
