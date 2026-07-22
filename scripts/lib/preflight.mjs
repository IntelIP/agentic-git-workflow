import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { runExternalCommand } from "./external-command.mjs";
import { runGit } from "./git-process.mjs";
import { contract } from "./contract-checks.mjs";
import {
  effectiveGitHubRepository,
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
  codexStateReader = readEffectiveCodexState,
  now = new Date(),
} = {}) {
  if (!PROFILES.has(profile)) throw new Error("profile must be agent or release.");
  const checks = [];
  const resolvedRepo = resolve(repoPath);
  let store = null;
  let repositoryId = null;
  let codexConfigReady = false;
  let codexHookMode = null;
  let codexManagedEvents = [];
  let codexEffectiveHooks = [];

  await record(checks, "node-version", async () => {
    if (majorVersion(nodeVersion) < 20) return blocked(`Node ${nodeVersion} is below required major 20.`, "Install Node.js 20 or later.");
    return passed(`Node ${nodeVersion}.`);
  });

  await record(checks, "git-repository", async () => {
    store = await NativeGitStore.open(resolvedRepo);
    repositoryId = await repositoryIdentity(store);
    return passed(`Repository ${repositoryId}.`);
  });

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
    if (status.enabled !== true) return blocked("Entire is disabled.", "Run entire enable --agent codex --skip-push-sessions with the configured checkpoint remote.");
    if (!Array.isArray(status.agents) || !status.agents.includes("Codex")) {
      return blocked("Entire is enabled without Codex integration.", "Run entire agent add codex.");
    }
    return passed("Entire enabled for Codex.");
  });

  await record(checks, "entire-metadata", () => store
    ? checkEntireMetadata(store, { remoteRefReader, remoteRepositoryReader, profile })
    : blocked("Entire metadata storage could not be inspected.", "Open a Git repository, then rerun preflight."));

  const codexCwd = store ? store.repoPath : resolvedRepo;
  await record(checks, "codex-config", async () => {
    const codexState = await codexStateReader({
      binary: codexBinary,
      cwd: codexCwd,
      timeoutMs: 30_000,
    });
    const hookPolicy = await codexHookPolicy(codexState.requirements, codexState.hooks);
    codexEffectiveHooks = codexState.hooks;
    codexHookMode = hookPolicy.mode;
    codexManagedEvents = hookPolicy.managedEvents;
    const result = await checkCodexConfig({
      commandRunner,
      codexBinary,
      cwd: store?.repoPath ?? resolvedRepo,
      hookPolicy,
    });
    codexConfigReady = result.status === "passed";
    return result;
  });

  await recordRepositoryChecks({
    checks,
    store,
    profile,
    commandRunner,
    ghBinary,
    controlRemote,
    remoteRefReader,
    remoteRepositoryReader,
    codexHookMode,
    codexManagedEvents,
    codexEffectiveHooks,
  });

  await record(checks, "codex-hook-trust", () => codexConfigReady
    ? checkCodexHookTrust({ effectiveHooks: codexEffectiveHooks, managedEvents: codexManagedEvents })
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

function checkCodexHookTrust({ effectiveHooks, managedEvents }) {
  if (managedEvents.length === REQUIRED_CODEX_HOOKS.length) return passed("Four required Entire hooks are enforced by managed Codex policy.");
  const required = REQUIRED_CODEX_HOOKS.filter((hook) => !managedEvents.includes(hook.configEvent));
  const untrusted = required.filter((hook) => !effectiveHooks.some((candidate) => projectHookInventoryMatches(candidate, hook, true)))
    .map((hook) => hook.event);
  return untrusted.length === 0
    ? passed("Required project Entire hooks are trusted in Codex's effective inventory; managed coverage is enforced by policy.")
    : blocked(`Codex Entire hook trust missing or stale: ${untrusted.join(", ")}.`, "Open /hooks in Codex, approve all required repository hooks, then rerun preflight.");
}

async function checkCodexConfig({ commandRunner, codexBinary, cwd, hookPolicy }) {
  const result = await commandRunner({
    binary: codexBinary,
    args: ["features", "list"],
    cwd,
    timeoutMs: 30_000,
  });
  if (!/^hooks\s+\S+\s+true\s*$/m.test(result.stdout)) {
    return blocked("Codex hooks are disabled in the effective configuration.", "Enable Codex hooks, then rerun preflight.");
  }
  if (hookPolicy.blocker) return hookPolicy.blocker;
  if (hookPolicy.mode === "managed") {
    return passed("Codex configuration is valid and required Entire hooks are managed.");
  }
  return passed("Codex configuration is valid and hooks are effectively enabled.");
}

async function codexHookPolicy(requirements, effectiveHooks) {
  const managedEvents = managedEntireHookEvents(effectiveHooks);
  const missing = REQUIRED_CODEX_HOOKS.filter((required) => !managedEvents.includes(required.configEvent)).map((required) => required.event);
  if (missing.length === 0) return { mode: "managed", blocker: null, managedEvents };
  if (managedHooksOnly(requirements)) {
    return {
      mode: "managed",
      blocker: blocked(`Managed Codex Entire hooks missing: ${missing.join(", ")}.`, "Install all four required Entire hooks in managed Codex policy, then rerun preflight."),
      managedEvents,
    };
  }
  return { mode: projectHookMode(managedEvents), blocker: null, managedEvents };
}

function projectHookMode(managedEvents) {
  return managedEvents.length > 0 ? "mixed" : "project";
}

function managedHooksOnly(requirements) {
  return requirements != null && requirements.allowManagedHooksOnly === true;
}

function managedEntireHookEvents(hooks) {
  const inventory = Array.isArray(hooks) ? hooks : [];
  return REQUIRED_CODEX_HOOKS.filter((required) => inventory.some((hook) => managedHookMatches(hook, required)))
    .map((required) => required.configEvent);
}

function managedHookMatches(hook, required) {
  const candidate = Object.assign({}, hook);
  const identity = JSON.stringify({
    isManaged: candidate.isManaged,
    enabled: candidate.enabled,
    trustStatus: candidate.trustStatus,
  });
  const requiredIdentity = JSON.stringify({
    isManaged: true,
    enabled: true,
    trustStatus: "managed",
  });
  return [
    identity === requiredIdentity,
    managedEventNameMatches(candidate.eventName, required),
    hookGroupAppliesToAll(candidate, required.configEvent),
    matchesRequiredEntireHook({ type: candidate.handlerType, command: candidate.command, async: candidate.async }, required.command),
  ].every(Boolean);
}

function projectHookInventoryMatches(hook, required, requireTrust) {
  const candidate = Object.assign({}, hook);
  const identityMatches = candidate.isManaged === false
    && candidate.source === "project"
    && candidate.enabled === true;
  const trustMatches = requireTrust === false || candidate.trustStatus === "trusted";
  return [
    identityMatches,
    trustMatches,
    managedEventNameMatches(candidate.eventName, required),
    hookGroupAppliesToAll(candidate, required.configEvent),
    matchesRequiredEntireHook({ type: candidate.handlerType, command: candidate.command, async: candidate.async }, required.command),
  ].every(Boolean);
}

function managedEventNameMatches(eventName, required) {
  return [lowerCamel(required.configEvent), required.event].includes(eventName);
}

function lowerCamel(value) {
  return value[0].toLowerCase() + value.slice(1);
}

async function readEffectiveCodexState({ binary, cwd, timeoutMs }) {
  return new Promise((resolveState, rejectState) => {
    const child = spawn(binary, ["app-server", "--stdio"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", NO_COLOR: "1" },
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Codex effective requirements query timed out.")), timeoutMs);

    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) rejectState(error);
      else resolveState(result);
    };
    const state = { requirements: undefined, hooks: undefined };
    const send = (message) => {
      if (settled || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) finish(error);
      });
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => handleCodexAppServerLine(line, { send, finish, state, cwd }));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", finish);
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`Codex effective requirements query exited before response (${code ?? signal ?? "unknown"}): ${stderr.trim()}`));
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "tabellio-preflight", version: PREFLIGHT_VERSION },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function handleCodexAppServerLine(line, context) {
  const message = parseCodexAppServerLine(line, context.finish);
  if (message === null) return;
  const handlers = {
    1: handleCodexInitializeResponse,
    2: handleCodexRequirementsResponse,
    3: handleCodexHooksResponse,
  };
  handlers[message.id]?.(message, context);
}

function parseCodexAppServerLine(line, finish) {
  try {
    return JSON.parse(line);
  } catch {
    finish(new Error("Codex app-server returned invalid JSON."));
    return null;
  }
}

function handleCodexInitializeResponse(message, { send, finish, cwd }) {
  if (message.error) {
    finish(codexRequirementsError(message.error));
    return;
  }
  if (message.result) {
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "configRequirements/read", params: null });
    send({ id: 3, method: "hooks/list", params: { cwds: [cwd] } });
  }
}

function handleCodexRequirementsResponse(message, context) {
  if (message.error) {
    context.finish(codexRequirementsError(message.error));
    return;
  }
  if (message.result && Object.hasOwn(message.result, "requirements")) {
    context.state.requirements = message.result.requirements;
    finishCodexStateWhenReady(context);
  }
}

function handleCodexHooksResponse(message, context) {
  if (message.error) {
    context.finish(codexRequirementsError(message.error));
    return;
  }
  try {
    const entries = message.result.data;
    const entry = entries.find((candidate) => candidate.cwd === context.cwd) ?? entries[0];
    requireHookInventory(entry);
    requireErrorFreeHookInventory(entry.errors);
    context.state.hooks = entry.hooks;
    finishCodexStateWhenReady(context);
  } catch (error) {
    context.finish(error);
  }
}

function requireHookInventory(entry) {
  if (!Array.isArray(entry?.hooks)) throw new Error("Codex hooks/list returned no hook inventory for the repository.");
}

function requireErrorFreeHookInventory(errors = []) {
  if (errors.length > 0) throw new Error(`Codex hooks/list reported errors: ${errors.map((error) => error.message).join(", ")}`);
}

function finishCodexStateWhenReady({ state, finish }) {
  if (state.requirements !== undefined && state.hooks !== undefined) finish(null, state);
}

function codexRequirementsError(error) {
  return new Error(`Codex effective requirements query failed: ${error.message ?? "unknown error"}`);
}

async function checkEntireMetadata(store, options) {
  const transport = await checkEntireCheckpointTransport(store, options.remoteRepositoryReader);
  if (transport) return transport;
  return checkEntireMetadataBranch(store, options.remoteRefReader, options.profile);
}

async function checkEntireCheckpointTransport(store, remoteRepositoryReader) {
  const settings = await readEntireTransportSettings(store);
  const remotes = configuredCheckpointRemotes(settings.local, settings.project);
  if (remotes.blocker) return remotes.blocker;
  const control = await remoteRepositoryReader(store, settings.platform.workflow.controlRemoteName);
  return checkpointTransportPolicyBlockers(remotes, control, settings).find(Boolean) ?? null;
}

async function readEntireTransportSettings(store) {
  const [local, project, platform] = await Promise.all([
    readJsonIfExists(resolve(store.repoPath, ".entire", "settings.local.json")),
    readJsonIfExists(resolve(store.repoPath, ".entire", "settings.json")),
    readPlatformConfig(store),
  ]);
  return { local, project, platform };
}

function configuredCheckpointRemotes(local, project) {
  const projectRemote = checkpointRemote(project);
  const projectBlocker = requiredCheckpointRemoteBlocker(projectRemote);
  if (projectBlocker) return { blocker: projectBlocker };
  const localRemote = checkpointRemote(local);
  const localBlocker = optionalCheckpointRemoteBlocker(localRemote);
  if (localBlocker) return { blocker: localBlocker };
  return {
    blocker: null,
    project: projectRemote.repository,
    effective: localRemote.repository ?? projectRemote.repository,
  };
}

function requiredCheckpointRemoteBlocker(remote) {
  if (remote.error) return checkpointRemoteBlocker(remote.error);
  if (remote.repository === null) return checkpointRemoteBlocker("Project Entire checkpoint remote is not configured.");
  return null;
}

function optionalCheckpointRemoteBlocker(remote) {
  return remote.error ? checkpointRemoteBlocker(remote.error) : null;
}

function checkpointTransportPolicyBlockers(remotes, control, settings) {
  return [
    repositoryMatchBlocker(remotes.project, control, "Project"),
    repositoryMatchBlocker(remotes.effective, control, "Effective"),
    automaticCheckpointPushBlocker(settings.local, settings.project),
  ];
}

function repositoryMatchBlocker(remote, control, scope) {
  return sameGitHubRepository(remote, control)
    ? null
    : checkpointRemoteBlocker(`${scope} Entire checkpoint remote does not match Tabellio's control repository.`);
}

function automaticCheckpointPushBlocker(local, project) {
  return project?.strategy_options?.push_sessions === false && effectivePushSessions(local, project) === false
    ? null
    : blocked(
        "Entire automatic checkpoint pushing is not disabled.",
        "Run entire configure --project --skip-push-sessions, then rerun preflight.",
      );
}

function checkpointRemote(settings) {
  const remote = settings?.strategy_options?.checkpoint_remote;
  return remote === undefined ? { repository: null, error: null } : parseCheckpointRemote(remote);
}

function parseCheckpointRemote(remote) {
  const shapeError = checkpointRemoteShapeError(remote);
  if (shapeError) return { repository: null, error: shapeError };
  return parseCheckpointRepository(remote);
}

function checkpointRemoteShapeError(remote) {
  if (remote === null) return "Entire checkpoint remote must be an object.";
  if (typeof remote !== "object") return "Entire checkpoint remote must be an object.";
  if (Array.isArray(remote)) return "Entire checkpoint remote must be an object.";
  return null;
}

function parseCheckpointRepository(remote) {
  if (remote.provider !== "github") return { repository: null, error: "Entire checkpoint remote must name a GitHub repository." };
  if (typeof remote.repo !== "string") return { repository: null, error: "Entire checkpoint remote must name a GitHub repository." };
  const repository = parseGitHubRepositoryRemote(`https://github.com/${remote.repo}`);
  return repository === null
    ? { repository: null, error: "Entire checkpoint remote has an invalid GitHub repository." }
    : { repository, error: null };
}

function effectivePushSessions(local, project) {
  return local?.strategy_options?.push_sessions ?? project?.strategy_options?.push_sessions;
}

function checkpointRemoteBlocker(detail) {
  return blocked(
    detail,
    "Run entire configure --project --checkpoint-remote github:OWNER/CONTROL_REPO --skip-push-sessions, then rerun preflight.",
  );
}

async function readJsonIfExists(path) {
  const source = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return source === null ? null : JSON.parse(source);
}

async function checkEntireMetadataBranch(store, remoteRefReader, profile) {
  const platform = await readPlatformConfig(store);
  const localRef = platform.ledger.checkpointRef;
  if (!(await store.hasRef(localRef))) {
    return checkMissingMetadataBranch(store, platform, localRef, remoteRefReader, profile);
  }
  const remote = platform.workflow.controlRemoteName;
  const liveRemote = await remoteRefReader({ repoPath: store.repoPath, remote, ref: localRef, allowMissing: true });
  if (liveRemote === null) {
    return checkUnpublishedEntireMetadata(store, localRef, profile);
  }
  return checkPublishedEntireMetadata(store, localRef, liveRemote, profile);
}

async function checkPublishedEntireMetadata(store, localRef, liveRemote, profile) {
  const localObject = await store.resolveRef(liveRemote).catch(() => null);
  if (!localObject) {
    return blocked("The live remote Entire metadata commit is not available locally.", "Fetch the checkpoint metadata branch, then rerun preflight.");
  }
  if (!(await store.isAncestor(liveRemote, localRef))) {
    return blocked("The live remote Entire metadata branch is ahead, divergent, or disconnected from local metadata.", "Fetch and reconcile the checkpoint metadata branch explicitly, then rerun preflight.");
  }
  return checkEntireMetadataContents(store, localRef, { allowEmpty: profile === "agent" });
}

async function checkUnpublishedEntireMetadata(store, localRef, profile) {
  const result = await checkEntireMetadataContents(store, localRef, { allowEmpty: profile === "agent" });
  return result.status === "blocked"
    ? result
    : passed("Local Entire checkpoint metadata is valid; the control remote ref may be created by approved publication.");
}

async function checkMissingMetadataBranch(store, platform, localRef, remoteRefReader, profile) {
  const blocker = blocked(`Entire metadata branch missing: ${localRef}.`, "Restore the local checkpoint metadata branch, then rerun preflight.");
  if (profile !== "agent") return blocker;
  const liveRemote = await remoteRefReader({
    repoPath: store.repoPath,
    remote: platform.workflow.controlRemoteName,
    ref: localRef,
    allowMissing: true,
  });
  return liveRemote === null
    ? passed("Entire metadata branch is not initialized yet; first agent checkpoint may create it.")
    : blocker;
}

function validCheckpointId(value) {
  return /^[0-9a-f]{12}$/.test(value) || /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

async function checkEntireMetadataContents(store, localRef, { allowEmpty }) {
  const files = await store.listFiles(localRef);
  const emptyResult = emptyMetadataResult(files, allowEmpty);
  if (emptyResult) return emptyResult;
  const metadataPaths = files.filter((path) => /^(?:[0-9a-f]{2}\/[0-9a-f]{10}|[0-9A-HJKMNP-TV-Z]{2}\/[0-9A-HJKMNP-TV-Z]{24})\/metadata\.json$/.test(path));
  if (metadataPaths.length === 0) {
    return blocked("Entire metadata branch contains no checkpoint metadata.", "Restore usable Entire checkpoint metadata, then rerun preflight.");
  }
  const invalidPath = await firstInvalidMetadataPath(store, localRef, metadataPaths, files);
  return invalidPath
    ? blocked(`Entire checkpoint metadata is invalid: ${invalidPath}.`, "Repair the checkpoint metadata branch explicitly, then rerun preflight.")
    : passed("Live remote Entire metadata is contained locally and checkpoint contents are valid.");
}

function emptyMetadataResult(files, allowEmpty) {
  if (files.length !== 0) return null;
  return allowEmpty
    ? passed("Live remote Entire metadata is contained locally; initialized agent metadata is empty.")
    : blocked("Entire metadata branch contains no checkpoint metadata.", "Create a checkpoint before release preflight, then rerun.");
}

async function firstInvalidMetadataPath(store, localRef, metadataPaths, files) {
  for (const path of metadataPaths) {
    const result = await runGit({ args: ["show", `${localRef}:${path}`], cwd: store.repoPath, gitDir: store.gitDir });
    const metadata = JSON.parse(result.stdout);
    if (!validCheckpointMetadata(metadata, path, new Set(files))) return path;
    if (!(await validCheckpointSessionFiles(store, localRef, metadata))) return path;
  }
  return null;
}

async function validCheckpointSessionFiles(store, localRef, metadata) {
  const results = await Promise.all(metadata.sessions.map(async (session) => {
    const [sessionMetadata, transcript, contentHash] = await Promise.all([
      gitFileText(store, localRef, session.metadata),
      gitTranscriptEvidence(store, localRef, session.transcript),
      gitFileText(store, localRef, session.content_hash),
    ]);
    return validSessionFiles({ sessionMetadata, transcript, contentHash }, metadata.checkpoint_id);
  }));
  return results.every(Boolean);
}

function validSessionFiles({ sessionMetadata, transcript, contentHash }, checkpointId) {
  return [
    validSessionMetadata(sessionMetadata, checkpointId),
    transcript?.valid === true,
    validContentHash(contentHash, transcript),
  ].every(Boolean);
}

function validContentHash(contentHash, transcript) {
  return typeof contentHash === "string" && contentHash.trim() === transcript?.digest;
}

async function gitTranscriptEvidence(store, ref, path) {
  const args = [...(store.gitDir ? [`--git-dir=${store.gitDir}`] : []), "show", `${ref}:${path.slice(1)}`];
  return new Promise((resolveEvidence) => {
    const child = spawn("git", args, {
      cwd: store.repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hash = createHash("sha256");
    let lineCount = 0;
    let linesValid = true;
    child.stdout.on("data", (chunk) => hash.update(chunk));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      lineCount += 1;
      try { JSON.parse(line); } catch { linesValid = false; }
    });
    child.once("error", () => resolveEvidence(null));
    child.once("close", (exitCode) => resolveEvidence(exitCode === 0 ? {
      valid: linesValid && lineCount > 0,
      digest: `sha256:${hash.digest("hex")}`,
    } : null));
  });
}

async function gitFileText(store, ref, path) {
  const result = await runGit({ args: ["show", `${ref}:${path.slice(1)}`], cwd: store.repoPath, gitDir: store.gitDir }).catch(() => null);
  return result?.stdout ?? null;
}

function validSessionMetadata(source, checkpointId) {
  const metadata = parseJson(source);
  return [
    metadata?.checkpoint_id === checkpointId,
    typeof metadata?.session_id === "string",
    metadata?.session_id !== "",
  ].every(Boolean);
}

function parseJson(source) {
  try { return JSON.parse(source); } catch { return null; }
}

function validCheckpointMetadata(metadata, path, files, explicitCheckpointId = null) {
  const prefix = path.slice(0, -"metadata.json".length);
  const checkpointId = explicitCheckpointId ?? prefix.replaceAll("/", "");
  if (!validCheckpointEnvelope(metadata, checkpointId)) return false;
  return metadata.sessions.every((session) => validCheckpointSession(session, prefix, files));
}

function validCheckpointEnvelope(metadata, checkpointId) {
  if (!metadata || typeof metadata !== "object") return false;
  const sessions = Array.isArray(metadata.sessions) ? metadata.sessions : [];
  const checks = [
    metadata.partial !== true,
    metadata.checkpoint_id === checkpointId,
    sessions === metadata.sessions,
    sessions.length > 0,
    checkpointSessionCountMatches(metadata, sessions),
  ];
  return checks.filter(Boolean).length === checks.length;
}

function checkpointSessionCountMatches(metadata, sessions) {
  if (metadata.session_count == null) return true;
  return Number.isInteger(metadata.session_count) && metadata.session_count === sessions.length;
}

function validCheckpointSession(session, prefix, files) {
  return [session?.metadata, session?.transcript, session?.content_hash].every((path) => typeof path === "string"
    && path.startsWith(`/${prefix}`)
    && files.has(path.slice(1)));
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

async function recordRepositoryChecks({ checks, store, profile, commandRunner, ghBinary, controlRemote, remoteRefReader, remoteRepositoryReader, codexHookMode, codexManagedEvents, codexEffectiveHooks }) {
  if (!store) return;
  await record(checks, "platform-contract", () => checkPlatformContract(store));
  await record(checks, "github-remotes", () => checkGitHubRemotes({ store, commandRunner, ghBinary, controlRemote, remoteRepositoryReader }));
  await record(checks, "codex-hooks", () => codexHookMode === "managed"
    ? passed("Project hook declarations are skipped because managed-only Codex policy enforces Entire hooks.")
    : checkCodexHooks(codexEffectiveHooks, codexManagedEvents));
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

function checkCodexHooks(effectiveHooks, managedEvents) {
  const required = REQUIRED_CODEX_HOOKS.filter((hook) => !managedEvents.includes(hook.configEvent));
  const missing = required.filter((hook) => !effectiveHooks.some((candidate) => projectHookInventoryMatches(candidate, hook, false)))
    .map((hook) => hook.configEvent.toLowerCase());
  if (missing.length > 0) return blocked(`Codex Entire hooks missing: ${missing.join(", ")}.`, "Reinstall Entire Codex hooks for this repository.");
  return passed("Required project Entire hook commands declared; managed coverage is enforced by policy.");
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

function hasEntireHook(entries, expectedCommand, event) {
  if (!Array.isArray(entries)) return false;
  return entries.filter((group) => hookGroupAppliesToAll(group, event))
    .some((entry) => hookCommands(entry).some((hook) => matchesRequiredEntireHook(hook, expectedCommand)));
}

function hookGroupAppliesToAll(group, event) {
  return [
    matcherIgnoredForEvent(event),
    documentedAllMatcher(group?.matcher),
    sessionStartMatcherAppliesToAll(group?.matcher, event),
  ].some(Boolean);
}

function matcherIgnoredForEvent(event) {
  return ["userpromptsubmit", "stop"].includes(event.toLowerCase());
}

function documentedAllMatcher(matcher) {
  return matcher == null || ["", "*"].includes(matcher);
}

function sessionStartMatcherAppliesToAll(matcher, event) {
  if (event.toLowerCase() !== "sessionstart" || typeof matcher !== "string") return false;
  try {
    const pattern = new RegExp(matcher);
    return ["startup", "resume", "clear", "compact"].every((source) => pattern.test(source));
  } catch {
    return false;
  }
}

function hookCommands(entry) {
  return Array.isArray(entry?.hooks) ? entry.hooks : [];
}

function matchesRequiredEntireHook(hook, expectedCommand) {
  if (!validEntireHookShape(hook)) return false;
  const direct = new RegExp(`^(?:exec )?entire hooks codex ${expectedCommand}$`);
  const guarded = new RegExp(`^sh -c 'if ! command -v entire >/dev/null 2>&1; then .+; fi; exec entire hooks codex ${expectedCommand}'$`);
  if (!requiredHookCommandMatches(hook.command, [direct, guarded])) return false;
  return hook.commandWindows == null || windowsHookCommandMatches(hook.commandWindows, expectedCommand);
}

function validEntireHookShape(hook) {
  return hook?.type === "command" && hook.async !== true && typeof hook.command === "string";
}

function requiredHookCommandMatches(command, patterns) {
  return typeof command === "string" && patterns.some((pattern) => pattern.test(command));
}

function windowsHookCommandMatches(command, expectedCommand) {
  if (typeof command !== "string") return false;
  const direct = new RegExp(`^(?:exec )?entire(?:\\.exe)? hooks codex ${expectedCommand}$`, "i");
  if (direct.test(command)) return true;
  const guardedCmd = new RegExp(`^cmd(?:\\.exe)? /d /s /c \"where entire(?:\\.exe)? >nul 2>nul && entire(?:\\.exe)? hooks codex ${expectedCommand}\"$`, "i");
  return guardedCmd.test(command);
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
