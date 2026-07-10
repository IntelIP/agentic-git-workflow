import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureContext } from "./capture-context.mjs";
import { readContextPacket } from "./context-packet.mjs";
import { runGit } from "./git-process.mjs";
import { repositoryIdentity } from "./repository-identity.mjs";
import { WorkspaceManager } from "./workspace-manager.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

const RUN_SCHEMA_VERSION = "tabellio-run/v0.1";
const DEFAULT_NOTES_REF = "refs/notes/tabellio/context";
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const WRITE_EVIDENCE_SCRIPT = fileURLToPath(new URL("../write-tabellio-evidence-envelope.mjs", import.meta.url));
const CHECK_EVIDENCE_SCRIPT = fileURLToPath(new URL("../check-tabellio-evidence-envelope.mjs", import.meta.url));
const CHECK_EXTERNAL_ACTIONS_SCRIPT = fileURLToPath(new URL("../check-tabellio-external-actions.mjs", import.meta.url));

export class AgentRunManager {
  constructor({ store, runRoot, workspaceRoot }) {
    this.store = store;
    this.runRoot = runRoot;
    this.workspaceRoot = workspaceRoot;
    this.runsRoot = join(runRoot, "runs");
    this.artifactsRoot = join(runRoot, "artifacts");
    this.workspaceManager = new WorkspaceManager({ store, root: workspaceRoot });
  }

  static async open({ repoPath = process.cwd(), runRoot = null } = {}) {
    const repository = await NativeGitStore.open(repoPath);
    const absoluteRunRoot = runRoot === null ? join(repository.repoPath, ".tabellio") : resolve(runRoot);
    const workspaceRoot = join(absoluteRunRoot, "workspaces");
    await Promise.all([
      mkdir(join(absoluteRunRoot, "runs"), { recursive: true }),
      mkdir(join(absoluteRunRoot, "artifacts"), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    const store = await NativeGitStore.open(repoPath, { workspaceRoot });
    return new AgentRunManager({ store, runRoot: absoluteRunRoot, workspaceRoot });
  }

  async start({
    runId,
    baseRef = "main",
    branch = `agent/${runId}`,
    repositoryId = null,
    actor = { type: "agent", id: process.env.USER ?? "local-agent" },
    taskSummary,
    notesRef = DEFAULT_NOTES_REF,
    createdAt = new Date().toISOString(),
  }) {
    return this.#withLock(runId, async () => {
      requiredString(taskSummary, "taskSummary");
      if (branch.startsWith("refs/")) throw new Error("branch must be a branch name, not a full ref.");
      await this.store.validateBranch(branch);
      if (await this.store.hasRef(branchRef(branch))) throw new Error(`Run branch ${branch} already exists.`);
      if (await stat(this.#workspacePath(runId)).catch(() => null)) throw new Error(`Run workspace ${runId} already exists.`);
      const base = normalizeBranchRef(baseRef);
      const baseCommit = await this.store.resolveRef(base.ref);
      const identity = await repositoryIdentity(this.store, repositoryId);
      const state = {
        schemaVersion: RUN_SCHEMA_VERSION,
        runId,
        status: "starting",
        repository: { id: identity, baseRef: base.ref, baseName: base.name, baseCommit },
        workspace: { branch },
        actor,
        task: { summary: taskSummary.trim() },
        notesRef,
        checkpoints: [],
        headCommit: null,
        validation: null,
        context: null,
        completedAt: null,
        promotedAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      validateAgentRunState(state);
      await this.#createState(state);

      try {
        await this.workspaceManager.create({ runId, branch, startPoint: baseCommit });
      } catch (error) {
        await rm(this.#statePath(runId), { force: true });
        throw error;
      }
      state.status = "active";
      state.updatedAt = new Date().toISOString();
      await this.#saveState(state);
      return this.#result(state);
    });
  }

  async checkpoint({ runId, summary }) {
    return this.#withLock(runId, async () => {
      const state = await this.#readState(runId);
      requireStatus(state, ["active", "validation_failed"]);
      requiredString(summary, "summary");
      await this.#requireRunWorkspace(state);
      const headCommit = await this.store.resolveRef(branchRef(state.workspace.branch));
      await this.#requireRunAncestor(state, headCommit);
      if (state.checkpoints.some((checkpoint) => checkpoint.commit === headCommit)) {
        throw new Error(`Run ${runId} already has a checkpoint for ${headCommit}.`);
      }

      const existing = await this.store.readNote(headCommit, { notesRef: state.notesRef });
      let checkpoint;
      if (existing !== null) {
        checkpoint = recoverCheckpoint(existing, state.runId, headCommit);
      } else {
        checkpoint = {
          commit: headCommit,
          summary: summary.trim().slice(0, 500),
          createdAt: new Date().toISOString(),
        };
        const note = JSON.stringify({
          schemaVersion: "tabellio-checkpoint/v0.1",
          runId: state.runId,
          summary: checkpoint.summary,
          createdAt: checkpoint.createdAt,
        });
        await this.store.writeNote(headCommit, { notesRef: state.notesRef, note });
      }

      state.checkpoints.push(checkpoint);
      state.updatedAt = new Date().toISOString();
      await this.#saveState(state);
      return this.#result(state);
    });
  }

  async finish({ runId, validationCommand, onValidationOutput = null }) {
    return this.#withLock(runId, async () => {
      const state = await this.#readState(runId);
      requireStatus(state, ["active", "validation_failed"]);
      if (!Array.isArray(validationCommand) || validationCommand.length === 0) {
        throw new Error("finish requires a validation command after --.");
      }
      if (validationCommand.some((argument) => typeof argument !== "string" || argument === "")) {
        throw new Error("validation command arguments must be non-empty strings.");
      }

      await this.#requireRunWorkspace(state);
      const headCommit = await this.store.resolveRef(branchRef(state.workspace.branch));
      await this.#requireRunAncestor(state, headCommit);
      for (const checkpoint of state.checkpoints) {
        if (!(await this.store.isAncestor(checkpoint.commit, headCommit))) {
          throw new Error(`Checkpoint ${checkpoint.commit} is not an ancestor of run head ${headCommit}.`);
        }
      }

      const workspacePath = this.#workspacePath(runId);
      const execution = await runValidation(validationCommand, workspacePath);
      if (onValidationOutput) onValidationOutput({ stdout: execution.stdout, stderr: execution.stderr });
      const { stdout: _stdout, stderr: _stderr, ...validation } = execution;
      if (!(await workspaceIsClean(workspacePath))) {
        validation.status = "failed";
        validation.exitCode = 1;
        validation.error = "Validation left the agent workspace dirty.";
      }
      if (await workspaceBranch(workspacePath) !== branchRef(state.workspace.branch)) {
        validation.status = "failed";
        validation.exitCode = 1;
        validation.error = "Validation changed the checked-out workspace branch.";
      }
      const postValidationHead = await this.store.resolveRef(branchRef(state.workspace.branch));
      if (postValidationHead !== headCommit) {
        validation.status = "failed";
        validation.exitCode = 1;
        validation.error = "Validation changed the run branch HEAD.";
      }

      const packet = await captureContext({
        store: this.store,
        baseRevision: state.repository.baseCommit,
        headRevision: headCommit,
        baseName: state.repository.baseName,
        headName: state.workspace.branch,
        notesRef: state.notesRef,
        checkpointCommits: state.checkpoints.map((checkpoint) => checkpoint.commit),
        runId: state.runId,
        repositoryId: state.repository.id,
        actor: state.actor,
        taskSummary: state.task.summary,
      });

      const paths = this.#paths(runId);
      await mkdir(paths.artifactRoot, { recursive: true });
      await writeFile(paths.context, `${JSON.stringify(packet, null, 2)}\n`);
      await readContextPacket(paths.context);
      await runNodeScript(WRITE_EVIDENCE_SCRIPT, ["--context", paths.context, "--out", paths.evidence], {
        cwd: workspacePath,
        env: {
          TABELLIO_VALIDATION_COMMAND: validation.display,
          TABELLIO_VALIDATION_STATUS: validation.status,
          TABELLIO_VALIDATION_EXIT_CODE: validation.exitCode === null ? "" : String(validation.exitCode),
          TABELLIO_RUNTIME_NAME: "tabellio-agent-run",
          TABELLIO_RUNTIME_TOOLING: "git,node,tabellio",
        },
      });
      await runNodeScript(CHECK_EVIDENCE_SCRIPT, ["--evidence", paths.evidence], { cwd: workspacePath });
      await runNodeScript(CHECK_EXTERNAL_ACTIONS_SCRIPT, ["--evidence", paths.evidence], { cwd: workspacePath });

      const completedAt = new Date().toISOString();
      state.status = validation.status === "passed" ? "completed" : "validation_failed";
      state.headCommit = headCommit;
      state.validation = validation;
      state.context = {
        digest: packet.integrity.digest,
        mergeClean: packet.mergePreview.clean,
        changedFileCount: packet.changeSet.files.length,
      };
      state.completedAt = state.status === "completed" ? completedAt : null;
      state.promotedAt = null;
      state.updatedAt = completedAt;
      await this.#saveState(state);
      return this.#result(state);
    });
  }

  async promote({ runId }) {
    return this.#withLock(runId, async () => {
      const state = await this.#readState(runId);
      if (state.status === "promoted") return this.#result(state);
      requireStatus(state, ["completed"]);
      const headCommit = await this.store.resolveRef(branchRef(state.workspace.branch));
      if (headCommit !== state.headCommit) {
        throw new Error(`Run branch changed after validation; expected ${state.headCommit}, found ${headCommit}.`);
      }
      await this.#requireRunAncestor(state, headCommit);
      const preview = await this.store.previewMerge({ base: state.repository.baseCommit, head: headCommit });
      if (!preview.clean) throw new Error(`Run ${runId} cannot be promoted because merge preview has conflicts.`);

      await this.store.fastForwardRef({
        ref: state.repository.baseRef,
        newRevision: headCommit,
        expectedOldCommit: state.repository.baseCommit,
      });
      state.status = "promoted";
      state.promotedAt = new Date().toISOString();
      state.updatedAt = state.promotedAt;
      await this.#saveState(state);
      return this.#result(state);
    });
  }

  async status({ runId }) {
    return this.#result(await this.#readState(runId));
  }

  async #requireRunAncestor(state, headCommit) {
    if (!(await this.store.isAncestor(state.repository.baseCommit, headCommit))) {
      throw new Error(`Run head ${headCommit} is not descended from frozen base ${state.repository.baseCommit}.`);
    }
  }

  async #requireRunWorkspace(state) {
    const workspacePath = this.#workspacePath(state.runId);
    const expectedBranch = branchRef(state.workspace.branch);
    const actualBranch = await workspaceBranch(workspacePath);
    if (actualBranch !== expectedBranch) {
      throw new Error(`Run ${state.runId} workspace must have ${expectedBranch} checked out; found ${actualBranch ?? "detached HEAD"}.`);
    }
    if (!(await workspaceIsClean(workspacePath))) {
      throw new Error(`Run ${state.runId} workspace must be clean; commit or discard changes first.`);
    }
  }

  async #withLock(runId, action) {
    validateRunId(runId);
    const lockPath = join(this.runsRoot, `${runId}.lock`);
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`Run ${runId} is busy.`);
      throw error;
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  async #createState(state) {
    try {
      await writeFile(this.#statePath(state.runId), serializeState(state), { flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`Run ${state.runId} already exists.`);
      throw error;
    }
  }

  async #readState(runId) {
    validateRunId(runId);
    let state;
    try {
      state = JSON.parse(await readFile(this.#statePath(runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Run ${runId} does not exist.`);
      throw error;
    }
    validateAgentRunState(state);
    return state;
  }

  async #saveState(state) {
    validateAgentRunState(state);
    const statePath = this.#statePath(state.runId);
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, serializeState(state));
    await rename(temporaryPath, statePath);
  }

  #result(state) {
    const paths = this.#paths(state.runId);
    return {
      ok: !["starting", "validation_failed"].includes(state.status),
      state,
      paths: {
        state: this.#statePath(state.runId),
        workspace: this.#workspacePath(state.runId),
        context: paths.context,
        evidence: paths.evidence,
      },
    };
  }

  #statePath(runId) {
    validateRunId(runId);
    return join(this.runsRoot, `${runId}.json`);
  }

  #workspacePath(runId) {
    validateRunId(runId);
    return join(this.workspaceRoot, runId);
  }

  #paths(runId) {
    validateRunId(runId);
    const artifactRoot = join(this.artifactsRoot, runId);
    return {
      artifactRoot,
      context: join(artifactRoot, "tabellio-context.json"),
      evidence: join(artifactRoot, "tabellio-evidence.json"),
    };
  }
}

export function validateAgentRunState(value) {
  requireObject(value, "agent run");
  exactKeys(value, [
    "schemaVersion", "runId", "status", "repository", "workspace", "actor", "task", "notesRef",
    "checkpoints", "headCommit", "validation", "context", "completedAt", "promotedAt", "createdAt", "updatedAt",
  ], "agent run");
  equals(value.schemaVersion, RUN_SCHEMA_VERSION, "schemaVersion");
  validateRunId(value.runId);
  oneOf(value.status, ["starting", "active", "validation_failed", "completed", "promoted"], "status");

  requireObject(value.repository, "repository");
  exactKeys(value.repository, ["id", "baseRef", "baseName", "baseCommit"], "repository");
  requiredString(value.repository.id, "repository.id");
  if (/^(?:\/|file:|[A-Za-z]:[\\/])/.test(value.repository.id) || value.repository.id.includes("\\")) {
    throw new Error("repository.id must not expose a local filesystem path.");
  }
  if (!value.repository.baseRef.startsWith("refs/heads/")) throw new Error("repository.baseRef must be a branch ref.");
  requiredString(value.repository.baseName, "repository.baseName");
  oid(value.repository.baseCommit, "repository.baseCommit");

  requireObject(value.workspace, "workspace");
  exactKeys(value.workspace, ["branch"], "workspace");
  requiredString(value.workspace.branch, "workspace.branch");
  if (value.workspace.branch.startsWith("refs/")) throw new Error("workspace.branch must not be a full ref.");

  requireObject(value.actor, "actor");
  exactKeys(value.actor, ["type", "id"], "actor");
  oneOf(value.actor.type, ["human", "agent", "ci", "system"], "actor.type");
  requiredString(value.actor.id, "actor.id");

  requireObject(value.task, "task");
  exactKeys(value.task, ["summary"], "task");
  requiredString(value.task.summary, "task.summary");
  requiredString(value.notesRef, "notesRef");
  if (!value.notesRef.startsWith("refs/notes/")) throw new Error("notesRef must be under refs/notes/.");

  if (!Array.isArray(value.checkpoints)) throw new Error("checkpoints must be an array.");
  const checkpointCommits = new Set();
  value.checkpoints.forEach((checkpoint, index) => {
    requireObject(checkpoint, `checkpoints[${index}]`);
    exactKeys(checkpoint, ["commit", "summary", "createdAt"], `checkpoints[${index}]`);
    oid(checkpoint.commit, `checkpoints[${index}].commit`);
    if (checkpoint.commit.length !== value.repository.baseCommit.length) throw new Error(`checkpoints[${index}].commit uses the wrong object format.`);
    if (checkpointCommits.has(checkpoint.commit)) throw new Error(`checkpoints contains duplicate commit ${checkpoint.commit}.`);
    checkpointCommits.add(checkpoint.commit);
    requiredString(checkpoint.summary, `checkpoints[${index}].summary`);
    if (checkpoint.summary.length > 500) throw new Error(`checkpoints[${index}].summary must be at most 500 characters.`);
    dateTime(checkpoint.createdAt, `checkpoints[${index}].createdAt`);
  });

  nullableOid(value.headCommit, "headCommit", value.repository.baseCommit.length);
  validateValidation(value.validation);
  validateContext(value.context);
  nullableDateTime(value.completedAt, "completedAt");
  nullableDateTime(value.promotedAt, "promotedAt");
  dateTime(value.createdAt, "createdAt");
  dateTime(value.updatedAt, "updatedAt");

  if (["validation_failed", "completed", "promoted"].includes(value.status)) {
    if (!value.headCommit || !value.validation || !value.context) throw new Error(`${value.status} runs require headCommit, validation, and context.`);
  }
  if (["starting", "active"].includes(value.status) && [value.headCommit, value.validation, value.context, value.completedAt, value.promotedAt].some((field) => field !== null)) {
    throw new Error(`${value.status} runs cannot contain completion state.`);
  }
  if (value.status === "validation_failed" && value.validation?.status !== "failed") throw new Error("validation_failed runs require failed validation.");
  if (value.status === "validation_failed" && (value.completedAt !== null || value.promotedAt !== null)) throw new Error("validation_failed runs cannot be completed or promoted.");
  if (["completed", "promoted"].includes(value.status) && value.validation?.status !== "passed") throw new Error(`${value.status} runs require passed validation.`);
  if (["completed", "promoted"].includes(value.status) && !value.completedAt) throw new Error(`${value.status} runs require completedAt.`);
  if (value.status === "completed" && value.promotedAt !== null) throw new Error("completed runs cannot contain promotedAt.");
  if (value.status === "promoted" && !value.promotedAt) throw new Error("promoted runs require promotedAt.");
  return value;
}

function validateValidation(value) {
  if (value === null) return;
  requireObject(value, "validation");
  exactKeys(value, ["command", "display", "status", "exitCode", "signal", "error", "completedAt"], "validation");
  if (!Array.isArray(value.command) || value.command.length === 0 || value.command.some((item) => typeof item !== "string" || item === "")) {
    throw new Error("validation.command must contain command arguments.");
  }
  requiredString(value.display, "validation.display");
  oneOf(value.status, ["passed", "failed"], "validation.status");
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) throw new Error("validation.exitCode must be an integer or null.");
  if (value.signal !== null && typeof value.signal !== "string") throw new Error("validation.signal must be a string or null.");
  if (value.error !== null && typeof value.error !== "string") throw new Error("validation.error must be a string or null.");
  dateTime(value.completedAt, "validation.completedAt");
}

function validateContext(value) {
  if (value === null) return;
  requireObject(value, "context");
  exactKeys(value, ["digest", "mergeClean", "changedFileCount"], "context");
  if (!/^[0-9a-f]{64}$/.test(value.digest)) throw new Error("context.digest must be a SHA-256 digest.");
  if (typeof value.mergeClean !== "boolean") throw new Error("context.mergeClean must be a boolean.");
  if (!Number.isInteger(value.changedFileCount) || value.changedFileCount < 0) throw new Error("context.changedFileCount must be a non-negative integer.");
}

function recoverCheckpoint(note, runId, commit) {
  try {
    const parsed = JSON.parse(note);
    if (parsed.schemaVersion !== "tabellio-checkpoint/v0.1" || parsed.runId !== runId) throw new Error();
    requiredString(parsed.summary, "checkpoint summary");
    dateTime(parsed.createdAt, "checkpoint createdAt");
    return { commit, summary: parsed.summary, createdAt: parsed.createdAt };
  } catch {
    throw new Error(`Commit ${commit} already has a checkpoint note owned by another workflow.`);
  }
}

function normalizeBranchRef(value) {
  requiredString(value, "baseRef");
  const ref = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  const name = ref.slice("refs/heads/".length);
  if (!name || name.startsWith("refs/")) throw new Error("baseRef must identify a branch.");
  return { ref, name };
}

function branchRef(branch) {
  return `refs/heads/${branch}`;
}

async function workspaceIsClean(path) {
  const result = await runGit({ args: ["status", "--porcelain=v1", "-z"], cwd: path });
  return result.stdout === "";
}

async function workspaceBranch(path) {
  const result = await runGit({
    args: ["symbolic-ref", "-q", "HEAD"],
    cwd: path,
    acceptableExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function runValidation(command, cwd) {
  return new Promise((resolvePromise) => {
    execFile(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: VALIDATION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout = "", stderr = "") => {
      const exitCode = typeof error?.code === "number" ? error.code : error ? null : 0;
      resolvePromise({
        command,
        display: renderCommand(command),
        status: error ? "failed" : "passed",
        exitCode,
        signal: error?.signal ?? null,
        error: error ? validationError(error) : null,
        completedAt: new Date().toISOString(),
        stdout,
        stderr,
      });
    });
  });
}

function runNodeScript(script, args, { cwd, env = {} }) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
    }, (error, stdout = "", stderr = "") => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function renderCommand(command) {
  return command.map((argument) => /^[A-Za-z0-9_./:=+-]+$/.test(argument) ? argument : JSON.stringify(argument)).join(" ");
}

function validationError(error) {
  if (error?.code === "ENOENT") return "Validation executable was not found.";
  if (error?.killed || error?.signal) return `Validation terminated by ${error.signal ?? "timeout"}.`;
  return `Validation exited with code ${typeof error?.code === "number" ? error.code : "unknown"}.`;
}

function serializeState(state) {
  validateAgentRunState(state);
  return `${JSON.stringify(state, null, 2)}\n`;
}

function validateRunId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error("runId must be a safe path segment.");
  }
}

function requireStatus(state, allowed) {
  if (!allowed.includes(state.status)) throw new Error(`Run ${state.runId} has status ${state.status}; expected ${allowed.join(" or ")}.`);
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function exactKeys(value, allowed, path) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${path} contains unsupported properties: ${unsupported.join(", ")}.`);
  const undefinedKeys = Object.keys(value).filter((key) => value[key] === undefined);
  if (undefinedKeys.length > 0) throw new Error(`${path} properties must not be undefined: ${undefinedKeys.join(", ")}.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${expected}.`);
}

function oid(value, path) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`${path} must be a Git object ID.`);
}

function nullableOid(value, path, length) {
  if (value === null) return;
  oid(value, path);
  if (value.length !== length) throw new Error(`${path} uses the wrong object format.`);
}

function dateTime(value, path) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${path} must be an ISO date-time string.`);
  }
}

function nullableDateTime(value, path) {
  if (value !== null) dateTime(value, path);
}
