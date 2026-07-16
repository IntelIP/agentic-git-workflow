import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  ApprovedControlRefTransport,
  snapshotControlRefs,
} from "./control-ref-transport.mjs";
import { runExternalCommand } from "./external-command.mjs";
import { parseGitHubRepositoryRemote, readRemoteRefOid } from "./github-repository.mjs";
import { runGit } from "./git-process.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import { repositoryIdentity } from "./repository-identity.mjs";
import { validateReleaseApproval, validateReleaseIntent } from "./release-operation.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

const PHASES = ["verify", "control-refs", "tag", "github-release"];

export class ReleaseExecutor {
  constructor({ repoPath, stateRoot, actions, lockRunner = withOperationLock }) {
    this.repoPath = repoPath;
    this.stateRoot = stateRoot;
    this.actions = actions;
    this.lockRunner = lockRunner;
  }

  static async open({
    repoPath = process.cwd(),
    stateRoot = null,
    ghBinary = "gh",
    commandRunner = runExternalCommand,
    remoteRefReader = readRemoteRefOid,
    codeRepositoryReader = repositoryIdentity,
    controlRepositoryReader = privateGitHubRemoteRepository,
  } = {}) {
    const store = await NativeGitStore.open(resolve(repoPath));
    const common = (await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: store.repoPath })).stdout.trim();
    const root = stateRoot ? resolve(stateRoot) : resolve(store.repoPath, common, "tabellio", "release-operations");
    const actions = new ReleaseActions({ store, ghBinary, commandRunner, remoteRefReader, codeRepositoryReader, controlRepositoryReader });
    return new ReleaseExecutor({ repoPath: store.repoPath, stateRoot: root, actions });
  }

  async execute({ intent, approval, now = new Date() }) {
    validateReleaseIntent(intent);
    validateReleaseApproval(approval, intent, { now });
    return this.lockRunner({
      repoPath: this.repoPath,
      stateRoot: this.stateRoot,
      lockName: "release-operation",
      label: "release operation",
    }, () => this.#executeLocked({ intent, approval, now }));
  }

  async #executeLocked({ intent, approval, now }) {
    await mkdir(this.stateRoot, { recursive: true });
    const path = resolve(this.stateRoot, `${approval.id}.json`);
    const existing = await readState(path);
    let state = resumeOrCreate(existing, intent, approval, now);
    if (state.status === "succeeded") return { ...state, receiptPath: path };

    const verification = state.phases.find((entry) => entry.id === "verify");
    state = await executePhase({ state, current: verification, phase: "verify", path, actions: this.actions, intent, approval, now });
    for (const phase of PHASES.slice(1)) {
      const current = state.phases.find((entry) => entry.id === phase);
      if (current.status === "completed") continue;
      state = await executePhase({ state, current, phase, path, actions: this.actions, intent, approval, now });
    }
    await completeRelease(path, state);
    return { ...state, receiptPath: path };
  }
}

class ReleaseActions {
  constructor({
    store,
    ghBinary = "gh",
    commandRunner = runExternalCommand,
    remoteRefReader = readRemoteRefOid,
    codeRepositoryReader = repositoryIdentity,
    controlRepositoryReader = privateGitHubRemoteRepository,
  }) {
    this.store = store;
    this.ghBinary = ghBinary;
    this.commandRunner = commandRunner;
    this.remoteRefReader = remoteRefReader;
    this.codeRepositoryReader = codeRepositoryReader;
    this.controlRepositoryReader = controlRepositoryReader;
  }

  async run(phase, context) {
    const action = {
      verify: this.#verify,
      "control-refs": this.#publishControl,
      tag: this.#publishTag,
      "github-release": this.#publishRelease,
    }[phase];
    if (!action) throw new Error(`Unsupported release phase: ${phase}.`);
    return action.call(this, context);
  }

  async #verify({ intent }) {
    const [repositoryId, controlRepository, head, trackedMain, packageResult, notesSource, refs] = await Promise.all([
      this.codeRepositoryReader(this.store),
      this.controlRepositoryReader(this.store, intent.control.intent.remote, this.ghBinary, this.commandRunner),
      this.store.resolveRef("HEAD"),
      this.store.resolveRef("origin/main"),
      runGit({ args: ["show", `${intent.revision.commit}:package.json`], cwd: this.store.repoPath }),
      sourceAtCommit(this.store.repoPath, intent.revision.commit, intent.release.notesPath),
      snapshotControlRefs({
        repoPath: this.store.repoPath,
        remote: intent.control.intent.remote,
        refs: intent.control.intent.refs.map((entry) => entry.name),
      }),
    ]);
    const liveMain = await this.remoteRefReader({ repoPath: this.store.repoPath, remote: "origin", ref: "refs/heads/main" });
    const status = await runGit({ args: ["status", "--porcelain=v1"], cwd: this.store.repoPath });
    const branch = await runGit({ args: ["branch", "--show-current"], cwd: this.store.repoPath });
    assertReleaseRepository({ repositoryId, controlRepository, head, trackedMain, liveMain, branch: branch.stdout, status: status.stdout }, intent);
    assertReleaseArtifacts({ packageSource: packageResult.stdout, notesSource, refs }, intent);
    return { commit: head, version: intent.version, controlIntentDigest: intent.control.intent.integrity.digest };
  }

  async #publishControl({ intent, approval, now }) {
    const controlRepository = await this.controlRepositoryReader(this.store, intent.control.intent.remote, this.ghBinary, this.commandRunner);
    assertControlRepository(controlRepository, intent);
    const snapshot = await snapshotControlRefs({
      repoPath: this.store.repoPath,
      remote: intent.control.intent.remote,
      refs: intent.control.intent.refs.map((entry) => entry.name),
    });
    const publication = controlPublicationState(snapshot, intent.control.intent.refs);
    if (publication === "published") {
      return { status: "already-published", refs: snapshot.map((entry) => entry.name) };
    }
    const controlApproval = {
      schemaVersion: "tabellio-control-ref-approval/v0.1",
      id: `${approval.id.slice(0, 80)}-control-${randomUUID()}`,
      intentDigest: intent.control.intent.integrity.digest,
      approved: true,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
      reason: `Release ${intent.tag}: ${approval.reason}`,
    };
    const transport = await ApprovedControlRefTransport.open({ repoPath: this.store.repoPath });
    const result = await transport.execute({
      intent: intent.control.intent,
      approval: controlApproval,
      repositoryId: intent.repository.id,
      now,
    });
    return { status: result.status, approvalId: result.approvalId, refs: result.refs };
  }

  async #publishTag({ intent }) {
    const repositoryId = await this.codeRepositoryReader(this.store);
    assertEqual(repositoryId, intent.repository.id, "Release repository identity changed before tag publication.");
    let local = await localTagState(this.store.repoPath, intent.tag);
    const remote = await remoteTagState(this.store.repoPath, intent.code.remote, intent.tag);
    assertTagTarget(local, intent, "locally");
    assertTagTarget(remote, intent, "remotely");
    await ensureLocalTag(this.store.repoPath, intent, local);
    local = await localTagState(this.store.repoPath, intent.tag);
    assertTagTarget(local, intent, "locally");
    await ensureRemoteTag(this.store.repoPath, intent, remote);
    return { tag: intent.tag, commit: intent.revision.commit, status: tagPublishStatus(remote) };
  }

  async #publishRelease({ intent }) {
    const repository = `${intent.repository.owner}/${intent.repository.name}`;
    const notesSource = await sourceAtCommit(this.store.repoPath, intent.revision.commit, intent.release.notesPath);
    if (sha256(notesSource) !== intent.release.notesDigest) throw new Error("Release notes at the approved commit do not match release intent.");
    const existing = await optionalCommand(this.commandRunner, {
      binary: this.ghBinary,
      args: ["release", "view", intent.tag, "--repo", repository, "--json", "tagName,name,body,url,isDraft,isPrerelease"],
      cwd: this.store.repoPath,
      timeoutMs: 30_000,
    });
    if (existing) return reconcileExistingRelease(existing.stdout, intent);
    const created = await withTemporaryReleaseNotes(notesSource, async (notesFile) => this.commandRunner({
      binary: this.ghBinary,
      args: [
        "release", "create", intent.tag,
        "--repo", repository,
        "--title", intent.release.title,
        "--notes-file", notesFile,
        "--verify-tag",
      ],
      cwd: this.store.repoPath,
      timeoutMs: 15 * 60 * 1000,
    }));
    return { status: "published", url: created.stdout.trim(), tag: intent.tag };
  }
}

function resumeOrCreate(existing, intent, approval, now) {
  if (!existing) return initialState(intent, approval, now);
  validateResumeState(existing, intent, approval);
  return existing;
}

async function executePhase({ state, current, phase, path, actions, intent, approval, now }) {
  current.status = "running";
  current.startedAt ||= new Date().toISOString();
  current.error = null;
  state.status = "running";
  state.updatedAt = new Date().toISOString();
  await writeState(path, state);
  try {
    current.evidence = await actions.run(phase, { intent, approval, now });
    completePhase(current, state);
    await writeState(path, state);
    return state;
  } catch (error) {
    failPhase(current, state, error);
    await writeState(path, state);
    throw error;
  }
}

function completePhase(current, state) {
  current.status = "completed";
  current.completedAt = new Date().toISOString();
  state.updatedAt = current.completedAt;
}

function failPhase(current, state, error) {
  current.status = "failed";
  current.error = safeError(error);
  current.completedAt = new Date().toISOString();
  state.status = "failed";
  state.updatedAt = current.completedAt;
}

async function completeRelease(path, state) {
  state.status = "succeeded";
  state.completedAt = new Date().toISOString();
  state.updatedAt = state.completedAt;
  await writeState(path, state);
}

function assertReleaseRepository(actual, intent) {
  assertReleaseRevision(actual, intent);
  assertReleaseWorkspace(actual);
}

function assertReleaseRevision(actual, intent) {
  assertEqual(actual.repositoryId, intent.repository.id, "Release repository identity changed.");
  assertControlRepository(actual.controlRepository, intent);
  assertEqual(actual.head, intent.revision.commit, "Release HEAD changed after planning.");
  assertEqual(actual.trackedMain, actual.head, "Release commit no longer equals tracked origin/main.");
  assertEqual(actual.liveMain, actual.head, "Release commit no longer equals live origin/main.");
}

function assertReleaseWorkspace(actual) {
  if (actual.branch.trim() !== "main") throw new Error("Release execution requires main.");
  if (actual.status !== "") throw new Error("Release execution requires a clean worktree.");
}

function assertReleaseArtifacts(actual, intent) {
  if (JSON.parse(actual.packageSource).version !== intent.version) throw new Error("package.json version changed after release planning.");
  if (sha256(actual.notesSource) !== intent.release.notesDigest) throw new Error("Release notes changed after release planning.");
  controlPublicationState(actual.refs, intent.control.intent.refs);
}

function assertTagTarget(target, intent, location) {
  if (!target) return;
  if (!target.annotated) throw new Error(`${intent.tag} exists ${location} as a lightweight tag.`);
  if (target.target !== intent.revision.commit) throw new Error(`${intent.tag} exists ${location} at a different commit.`);
}

async function ensureLocalTag(repoPath, intent, local) {
  if (local) return;
  await runGit({
    args: ["tag", "-a", intent.tag, "-m", intent.release.title, intent.revision.commit],
    cwd: repoPath,
  });
}

async function ensureRemoteTag(repoPath, intent, remote) {
  if (remote) return;
  await runGit({ args: ["push", intent.code.remote, intent.tag], cwd: repoPath, timeoutMs: 15 * 60 * 1000 });
}

function tagPublishStatus(remote) {
  return remote ? "already-published" : "published";
}

function reconcileExistingRelease(source, intent) {
  const release = JSON.parse(source);
  const body = typeof release.body === "string" ? release.body : "";
  const matches = [
    release.tagName === intent.tag,
    release.name === intent.release.title,
    typeof release.body === "string",
    sha256(body) === intent.release.notesDigest,
    release.isDraft === false,
    release.isPrerelease === false,
  ];
  if (matches.includes(false)) throw new Error("Existing GitHub release does not match final release intent.");
  return { status: "already-published", url: release.url, tag: release.tagName };
}

function initialState(intent, approval, now) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: "tabellio-release-operation-receipt/v0.1",
    approvalId: approval.id,
    intentDigest: intent.integrity.digest,
    repository: intent.repository.id,
    version: intent.version,
    status: "pending",
    phases: PHASES.map((id) => ({ id, status: "pending", startedAt: null, completedAt: null, evidence: null, error: null })),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

function validateResumeState(state, intent, approval) {
  if (state.approvalId !== approval.id || state.intentDigest !== intent.integrity.digest) {
    throw new Error("Existing release receipt does not match approval and intent.");
  }
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function localTagState(repoPath, tag) {
  const direct = await runGit({
    args: ["rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}`],
    cwd: repoPath,
    acceptableExitCodes: [0, 1, 128],
  });
  if (direct.exitCode !== 0) return null;
  const type = await runGit({ args: ["cat-file", "-t", direct.stdout.trim()], cwd: repoPath });
  const target = await runGit({ args: ["rev-parse", `${tag}^{}`], cwd: repoPath });
  return { annotated: type.stdout.trim() === "tag", target: target.stdout.trim() };
}

async function remoteTagState(repoPath, remote, tag) {
  const result = await runGit({
    args: ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    cwd: repoPath,
    timeoutMs: 15 * 60 * 1000,
  });
  const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
  const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
  if (!direct) return null;
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  return { annotated: Boolean(peeled), target: peeled?.[0] ?? direct[0] };
}

function controlPublicationState(snapshot, expected) {
  const actualByName = new Map(snapshot.map((entry) => [entry.name, entry]));
  const states = expected.map((approved) => approvedControlRefState(actualByName.get(approved.name), approved));
  if (states.every((state) => state === "published")) return "published";
  if (states.every((state) => state === "pending")) return "pending";
  throw new Error("Control refs are only partially published.");
}

function approvedControlRefState(actual, approved) {
  assertApprovedLocalRef(actual, approved);
  if (actual.remoteOid === approved.localOid) return "published";
  if (actual.remoteOid === approved.remoteOid) return "pending";
  throw new Error(`Approved remote control ref ${approved.name} changed.`);
}

function assertApprovedLocalRef(actual, approved) {
  if (!actual) throw new Error(`Approved local control ref ${approved.name} is missing.`);
  if (actual.localOid !== approved.localOid) throw new Error(`Approved local control ref ${approved.name} changed.`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

async function sourceAtCommit(repoPath, commit, path) {
  return (await runGit({ args: ["show", `${commit}:${path}`], cwd: repoPath })).stdout;
}

async function privateGitHubRemoteRepository(store, remote, ghBinary, commandRunner) {
  const repository = parseGitHubRepositoryRemote(await store.gitConfig(`remote.${remote}.url`));
  if (!repository) throw new Error(`Release ${remote} remote is not a supported GitHub repository.`);
  const result = await commandRunner({
    binary: ghBinary,
    args: ["repo", "view", repository.fullName, "--json", "nameWithOwner,isPrivate"],
    cwd: store.repoPath,
    timeoutMs: 30_000,
  });
  const view = JSON.parse(result.stdout);
  if (String(view.nameWithOwner).toLowerCase() !== repository.key) throw new Error("GitHub returned a different control repository identity.");
  return { id: repository.identity, isPrivate: view.isPrivate === true };
}

function assertControlRepository(actual, intent) {
  assertEqual(actual.id.toLowerCase(), intent.control.repository.id.toLowerCase(), "Release control repository identity changed.");
  if (!actual.isPrivate) throw new Error("Release control repository is not private.");
}

async function withTemporaryReleaseNotes(source, action) {
  const directory = await mkdtemp(join(tmpdir(), "tabellio-release-notes-"));
  const path = join(directory, "notes.md");
  try {
    await writeFile(path, source, { mode: 0o600 });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function optionalCommand(runner, options) {
  try {
    return await runner(options);
  } catch (error) {
    if (isMissingRelease(error)) return null;
    throw error;
  }
}

function isMissingRelease(error) {
  if (errorField(error, "exitCode") !== 1) return false;
  return /release not found|not found|HTTP 404/i.test(commandErrorOutput(error));
}

function commandErrorOutput(error) {
  return `${errorMessage(error)}\n${errorField(error, "stdout")}\n${errorField(error, "stderr")}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorField(error, field) {
  if (typeof error !== "object") return "";
  if (error === null) return "";
  const value = error[field];
  return value === undefined ? "" : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/gho_[A-Za-z0-9_]+/g, "[REDACTED]").slice(0, 500);
}
