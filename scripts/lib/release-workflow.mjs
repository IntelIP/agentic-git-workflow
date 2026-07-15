import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ApprovedControlRefTransport,
  snapshotControlRefs,
} from "./control-ref-transport.mjs";
import { runExternalCommand } from "./external-command.mjs";
import { runGit } from "./git-process.mjs";
import { repositoryIdentity } from "./repository-identity.mjs";
import { validateReleaseApproval, validateReleaseIntent } from "./release-operation.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

const PHASES = ["verify", "control-refs", "tag", "github-release"];

export class ReleaseExecutor {
  constructor({ repoPath, stateRoot, actions }) {
    this.repoPath = repoPath;
    this.stateRoot = stateRoot;
    this.actions = actions;
  }

  static async open({ repoPath = process.cwd(), stateRoot = null, ghBinary = "gh", commandRunner = runExternalCommand } = {}) {
    const store = await NativeGitStore.open(resolve(repoPath));
    const common = (await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: store.repoPath })).stdout.trim();
    const root = stateRoot ? resolve(stateRoot) : resolve(store.repoPath, common, "tabellio", "release-operations");
    const actions = new ReleaseActions({ store, ghBinary, commandRunner });
    return new ReleaseExecutor({ repoPath: store.repoPath, stateRoot: root, actions });
  }

  async execute({ intent, approval, now = new Date() }) {
    validateReleaseIntent(intent);
    validateReleaseApproval(approval, intent, { now });
    await mkdir(this.stateRoot, { recursive: true });
    const path = resolve(this.stateRoot, `${approval.id}.json`);
    const existing = await readState(path);
    let state = resumeOrCreate(existing, intent, approval, now);
    if (state.status === "succeeded") return { ...state, receiptPath: path };

    for (const phase of PHASES) {
      const current = state.phases.find((entry) => entry.id === phase);
      if (current.status === "completed") continue;
      state = await executePhase({ state, current, phase, path, actions: this.actions, intent, approval, now });
    }
    await completeRelease(path, state);
    return { ...state, receiptPath: path };
  }
}

class ReleaseActions {
  constructor({ store, ghBinary = "gh", commandRunner = runExternalCommand }) {
    this.store = store;
    this.ghBinary = ghBinary;
    this.commandRunner = commandRunner;
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
    const [repositoryId, head, remoteMain, packageSource, notesSource, refs] = await Promise.all([
      repositoryIdentity(this.store),
      this.store.resolveRef("HEAD"),
      this.store.resolveRef("origin/main"),
      readFile(resolve(this.store.repoPath, "package.json"), "utf8"),
      readFile(resolve(this.store.repoPath, intent.release.notesPath)),
      snapshotControlRefs({
        repoPath: this.store.repoPath,
        remote: intent.control.intent.remote,
        refs: intent.control.intent.refs.map((entry) => entry.name),
      }),
    ]);
    const status = await runGit({ args: ["status", "--porcelain=v1"], cwd: this.store.repoPath });
    const branch = await runGit({ args: ["branch", "--show-current"], cwd: this.store.repoPath });
    assertReleaseRepository({ repositoryId, head, remoteMain, branch: branch.stdout, status: status.stdout }, intent);
    assertReleaseArtifacts({ packageSource, notesSource, refs }, intent);
    return { commit: head, version: intent.version, controlIntentDigest: intent.control.intent.integrity.digest };
  }

  async #publishControl({ intent, approval, now }) {
    const snapshot = await snapshotControlRefs({
      repoPath: this.store.repoPath,
      remote: intent.control.intent.remote,
      refs: intent.control.intent.refs.map((entry) => entry.name),
    });
    if (snapshot.every((entry) => entry.localOid === entry.remoteOid)) {
      return { status: "already-published", refs: snapshot.map((entry) => entry.name) };
    }
    const controlApproval = {
      schemaVersion: "tabellio-control-ref-approval/v0.1",
      id: `${approval.id.slice(0, 110)}-control`,
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
    const local = await localTagTarget(this.store.repoPath, intent.tag);
    const remote = await remoteTagTarget(this.store.repoPath, intent.code.remote, intent.tag);
    assertTagTarget(local, intent, "locally");
    assertTagTarget(remote, intent, "remotely");
    await ensureLocalTag(this.store.repoPath, intent, local);
    await ensureRemoteTag(this.store.repoPath, intent, remote);
    return { tag: intent.tag, commit: intent.revision.commit, status: tagPublishStatus(remote) };
  }

  async #publishRelease({ intent }) {
    const repository = `${intent.repository.owner}/${intent.repository.name}`;
    const existing = await optionalCommand(this.commandRunner, {
      binary: this.ghBinary,
      args: ["release", "view", intent.tag, "--repo", repository, "--json", "tagName,url,isDraft,isPrerelease"],
      cwd: this.store.repoPath,
      timeoutMs: 30_000,
    });
    if (existing) return reconcileExistingRelease(existing.stdout, intent);
    const created = await this.commandRunner({
      binary: this.ghBinary,
      args: [
        "release", "create", intent.tag,
        "--repo", repository,
        "--title", intent.release.title,
        "--notes-file", resolve(this.store.repoPath, intent.release.notesPath),
        "--verify-tag",
      ],
      cwd: this.store.repoPath,
      timeoutMs: 15 * 60 * 1000,
    });
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
  if (actual.repositoryId !== intent.repository.id) throw new Error("Release repository identity changed.");
  if (actual.head !== intent.revision.commit) throw new Error("Release HEAD changed after planning.");
  if (actual.remoteMain !== actual.head) throw new Error("Release commit no longer equals origin/main.");
}

function assertReleaseWorkspace(actual) {
  if (actual.branch.trim() !== "main") throw new Error("Release execution requires main.");
  if (actual.status !== "") throw new Error("Release execution requires a clean worktree.");
}

function assertReleaseArtifacts(actual, intent) {
  if (JSON.parse(actual.packageSource).version !== intent.version) throw new Error("package.json version changed after release planning.");
  if (sha256(actual.notesSource) !== intent.release.notesDigest) throw new Error("Release notes changed after release planning.");
  if (JSON.stringify(actual.refs) !== JSON.stringify(intent.control.intent.refs)) throw new Error("Control refs changed after release planning.");
}

function assertTagTarget(target, intent, location) {
  if (target && target !== intent.revision.commit) throw new Error(`${intent.tag} exists ${location} at a different commit.`);
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
  const mismatched = release.tagName !== intent.tag || release.isDraft || release.isPrerelease;
  if (mismatched) throw new Error("Existing GitHub release does not match final release intent.");
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

async function localTagTarget(repoPath, tag) {
  try {
    return (await runGit({ args: ["rev-parse", `${tag}^{}`], cwd: repoPath })).stdout.trim();
  } catch {
    return null;
  }
}

async function remoteTagTarget(repoPath, remote, tag) {
  const result = await runGit({
    args: ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    cwd: repoPath,
    timeoutMs: 15 * 60 * 1000,
  });
  const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  if (peeled) return peeled[0];
  const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
  return direct ? direct[0] : null;
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
