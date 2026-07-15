import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { LedgerConflictError } from "./git-json-ledger.mjs";
import { runGit } from "./git-process.mjs";
import { digestObject } from "./stack-operation.mjs";

const VALIDATION_MANIFEST_SCHEMA_VERSION = "tabellio-validation/v0.1";
const VALIDATION_RESULT_SCHEMA_VERSION = "tabellio-validation-result/v0.1";
const MAX_OUTPUT_TAIL_BYTES = 16 * 1024;

export class ValidationRunner {
  constructor({ store, ledger }) {
    this.store = store;
    this.ledger = ledger;
  }

  async run({
    repositoryId,
    commit,
    base,
    manifestPath = "tabellio.validation.json",
    runnerId = "local",
    now = new Date(),
  }) {
    requiredString(repositoryId, "repositoryId");
    requiredString(runnerId, "runnerId");
    validateRelativePath(manifestPath, "manifestPath");
    const [headCommit, baseCommit] = await Promise.all([
      this.store.resolveRef(commit),
      this.store.resolveRef(base),
    ]);
    const mergeBase = (await runGit({
      args: ["merge-base", baseCommit, headCommit],
      cwd: this.store.repoPath,
    })).stdout.trim();
    const manifestSource = await runGit({
      args: ["show", `${headCommit}:${manifestPath}`],
      cwd: this.store.repoPath,
    });
    const manifest = JSON.parse(manifestSource.stdout);
    validateValidationManifest(manifest);
    const checkpoints = await checkpointIds(this.store.repoPath, mergeBase, headCommit);
    if (manifest.requireEntireCheckpoint && checkpoints.length === 0) {
      throw new Error(`Validation range ${mergeBase}..${headCommit} has no Entire checkpoint.`);
    }

    const runId = `validation-${randomUUID()}`;
    const common = await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: this.store.repoPath });
    const workspaceRoot = resolve(this.store.repoPath, common.stdout.trim(), "tabellio", "validation-workspaces");
    const workspace = resolve(workspaceRoot, runId);
    const home = resolve(workspaceRoot, `${runId}.home`);
    await mkdir(workspaceRoot, { recursive: true });
    if (await stat(workspace).catch(() => null)) throw new Error(`Validation workspace already exists: ${workspace}.`);
    const startedAt = now.toISOString();
    const commands = [];
    try {
      await runGit({ args: ["worktree", "add", "--detach", workspace, headCommit], cwd: this.store.repoPath });
      await mkdir(resolve(home, "tmp"), { recursive: true });
      let stopped = false;
      for (const command of manifest.commands) {
        if (stopped) {
          commands.push(skippedCommand(command));
          continue;
        }
        const result = await runValidationCommand(command, workspace, home);
        commands.push(result);
        if (manifest.failFast && command.required && result.status !== "passed") stopped = true;
      }
    } finally {
      await runGit({
        args: ["worktree", "remove", "--force", workspace],
        cwd: this.store.repoPath,
        acceptableExitCodes: [0, 128],
      }).catch(() => {});
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
    const completedAt = new Date().toISOString();
    const requiredFailed = commands.some((command, index) => manifest.commands[index].required && command.status !== "passed");
    const result = {
      schemaVersion: VALIDATION_RESULT_SCHEMA_VERSION,
      runId,
      repository: { id: repositoryId },
      revision: { baseCommit, mergeBase, headCommit },
      suite: {
        id: manifest.id,
        manifestPath,
        manifestDigest: digestObject(manifest),
      },
      runner: { id: runnerId, runtime: `node-${process.version}` },
      status: requiredFailed ? "failed" : "passed",
      checkpoints,
      commands,
      startedAt,
      completedAt,
      integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    };
    result.integrity.digest = validationResultDigest(result);
    validateValidationResult(result);
    const path = validationPath(headCommit, runId);
    const written = await writeResultWithRetry(this.ledger, path, result);
    return { result, path, version: written.version };
  }
}

export async function latestValidationResult(ledger, commit, repositoryId = null) {
  oid(commit, "commit");
  if (repositoryId !== null) requiredString(repositoryId, "repositoryId");
  const prefix = `commits/${commit}`;
  const listed = await ledger.list(prefix);
  let latest = null;
  for (const path of listed.paths) {
    const record = await ledger.read(path);
    if (!record.value) continue;
    validateValidationResult(record.value);
    if (record.value.revision.headCommit !== commit) throw new Error(`Validation result ${path} is stored under the wrong commit.`);
    if (repositoryId !== null && record.value.repository.id !== repositoryId) continue;
    if (!latest || Date.parse(record.value.completedAt) > Date.parse(latest.completedAt)) latest = record.value;
  }
  return latest;
}

export function validateValidationManifest(value) {
  object(value, "validation manifest");
  exactKeys(value, ["schemaVersion", "id", "failFast", "requireEntireCheckpoint", "commands"], "validation manifest");
  equals(value.schemaVersion, VALIDATION_MANIFEST_SCHEMA_VERSION, "validation manifest.schemaVersion");
  requiredString(value.id, "validation manifest.id");
  boolean(value.failFast, "validation manifest.failFast");
  boolean(value.requireEntireCheckpoint, "validation manifest.requireEntireCheckpoint");
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 50) {
    throw new Error("validation manifest.commands must contain 1 to 50 commands.");
  }
  const ids = new Set();
  for (const [index, command] of value.commands.entries()) {
    const path = `validation manifest.commands[${index}]`;
    object(command, path);
    exactKeys(command, ["id", "argv", "cwd", "timeoutMs", "required"], path);
    requiredString(command.id, `${path}.id`);
    if (ids.has(command.id)) throw new Error(`validation manifest.commands contains duplicate id ${command.id}.`);
    ids.add(command.id);
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.length > 100) throw new Error(`${path}.argv must contain 1 to 100 arguments.`);
    command.argv.forEach((argument, argumentIndex) => requiredString(argument, `${path}.argv[${argumentIndex}]`));
    validateRelativePath(command.cwd, `${path}.cwd`, { allowDot: true });
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 60 * 60 * 1000) {
      throw new Error(`${path}.timeoutMs must be between 100 and 3600000.`);
    }
    boolean(command.required, `${path}.required`);
  }
  return value;
}

export function validateValidationResult(value) {
  object(value, "validation result");
  exactKeys(value, ["schemaVersion", "runId", "repository", "revision", "suite", "runner", "status", "checkpoints", "commands", "startedAt", "completedAt", "integrity"], "validation result");
  equals(value.schemaVersion, VALIDATION_RESULT_SCHEMA_VERSION, "validation result.schemaVersion");
  requiredString(value.runId, "validation result.runId");
  object(value.repository, "validation result.repository");
  exactKeys(value.repository, ["id"], "validation result.repository");
  requiredString(value.repository.id, "validation result.repository.id");
  object(value.revision, "validation result.revision");
  exactKeys(value.revision, ["baseCommit", "mergeBase", "headCommit"], "validation result.revision");
  oid(value.revision.baseCommit, "validation result.revision.baseCommit");
  oid(value.revision.mergeBase, "validation result.revision.mergeBase");
  oid(value.revision.headCommit, "validation result.revision.headCommit");
  object(value.suite, "validation result.suite");
  exactKeys(value.suite, ["id", "manifestPath", "manifestDigest"], "validation result.suite");
  requiredString(value.suite.id, "validation result.suite.id");
  validateRelativePath(value.suite.manifestPath, "validation result.suite.manifestPath");
  sha256(value.suite.manifestDigest, "validation result.suite.manifestDigest");
  object(value.runner, "validation result.runner");
  exactKeys(value.runner, ["id", "runtime"], "validation result.runner");
  requiredString(value.runner.id, "validation result.runner.id");
  requiredString(value.runner.runtime, "validation result.runner.runtime");
  member(value.status, ["passed", "failed"], "validation result.status");
  stringArray(value.checkpoints, "validation result.checkpoints");
  if (!Array.isArray(value.commands) || value.commands.length === 0) throw new Error("validation result.commands must be a non-empty array.");
  value.commands.forEach((command, index) => validateCommandResult(command, `validation result.commands[${index}]`));
  date(value.startedAt, "validation result.startedAt");
  date(value.completedAt, "validation result.completedAt");
  object(value.integrity, "validation result.integrity");
  exactKeys(value.integrity, ["algorithm", "digest"], "validation result.integrity");
  equals(value.integrity.algorithm, "sha256", "validation result.integrity.algorithm");
  sha256(value.integrity.digest, "validation result.integrity.digest");
  if (validationResultDigest(value) !== value.integrity.digest) throw new Error("validation result integrity digest does not match.");
  const expectedStatus = value.commands.some((command) => command.required && command.status !== "passed") ? "failed" : "passed";
  if (value.status !== expectedStatus) throw new Error("validation result status does not match required command results.");
  return value;
}

async function runValidationCommand(command, workspace, home) {
  const cwd = resolve(workspace, command.cwd);
  if (relative(workspace, cwd).startsWith("..") || isAbsolute(relative(workspace, cwd))) throw new Error(`Command ${command.id} cwd escapes validation workspace.`);
  const startedAt = new Date();
  const execution = await spawnCaptured(command.argv, {
    cwd,
    timeoutMs: command.timeoutMs,
    home,
  });
  const completedAt = new Date();
  return {
    id: command.id,
    argv: [...command.argv],
    cwd: command.cwd,
    required: command.required,
    status: execution.timedOut ? "timed_out" : execution.spawnError ? "error" : execution.exitCode === 0 ? "passed" : "failed",
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    stdout: execution.stdout,
    stderr: execution.stderr,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    error: execution.spawnError,
  };
}

function skippedCommand(command) {
  return {
    id: command.id,
    argv: [...command.argv],
    cwd: command.cwd,
    required: command.required,
    status: "skipped",
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

function spawnCaptured(argv, { cwd, timeoutMs, home }) {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: validationEnvironment(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = outputAccumulator();
    const stderr = outputAccumulator();
    let spawnError = null;
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    child.stdout?.on("data", stdout.add);
    child.stderr?.on("data", stderr.add);
    child.once("error", (error) => { spawnError = error.message; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal ?? null,
        timedOut,
        spawnError,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      });
    });
  });
}

function outputAccumulator() {
  const hash = createHash("sha256");
  let bytes = 0;
  let tail = Buffer.alloc(0);
  return {
    add(chunk) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      tail = Buffer.concat([tail, buffer]).subarray(-MAX_OUTPUT_TAIL_BYTES);
    },
    finish() {
      return {
        bytes,
        digest: hash.digest("hex"),
        tail: tail.toString("utf8"),
        truncated: bytes > MAX_OUTPUT_TAIL_BYTES,
      };
    },
  };
}

function emptyOutput() {
  return { bytes: 0, digest: createHash("sha256").update("").digest("hex"), tail: "", truncated: false };
}

async function checkpointIds(cwd, baseCommit, headCommit) {
  const result = await runGit({
    args: ["log", "--format=%(trailers:key=Entire-Checkpoint,valueonly)", "--no-merges", `${baseCommit}..${headCommit}`],
    cwd,
  });
  return [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].sort();
}

async function writeResultWithRetry(ledger, path, result) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await ledger.read(path);
    if (current.value !== null) throw new Error(`Validation result already exists: ${path}.`);
    try {
      return await ledger.write(path, result, { expectedVersion: current.version });
    } catch (error) {
      if (!(error instanceof LedgerConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error("Unable to write validation result after concurrent updates.");
}

function validationPath(commit, runId) {
  return `commits/${commit}/${runId}.json`;
}

function validationResultDigest(value) {
  const { integrity: _integrity, ...unsigned } = value;
  return digestObject(unsigned);
}

function validationEnvironment(home) {
  const allowed = ["PATH", "LANG", "LC_ALL", "TERM"];
  const env = Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, HOME: home, TMPDIR: resolve(home, "tmp"), CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
}

function validateCommandResult(value, path) {
  object(value, path);
  exactKeys(value, ["id", "argv", "cwd", "required", "status", "exitCode", "signal", "durationMs", "stdout", "stderr", "startedAt", "completedAt", "error"], path);
  requiredString(value.id, `${path}.id`);
  if (!Array.isArray(value.argv) || value.argv.length === 0) throw new Error(`${path}.argv must be non-empty.`);
  value.argv.forEach((argument, index) => requiredString(argument, `${path}.argv[${index}]`));
  validateRelativePath(value.cwd, `${path}.cwd`, { allowDot: true });
  boolean(value.required, `${path}.required`);
  member(value.status, ["passed", "failed", "error", "timed_out", "skipped"], `${path}.status`);
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) throw new Error(`${path}.exitCode must be an integer or null.`);
  if (value.signal !== null) requiredString(value.signal, `${path}.signal`);
  if (!Number.isInteger(value.durationMs) || value.durationMs < 0) throw new Error(`${path}.durationMs must be a non-negative integer.`);
  validateOutput(value.stdout, `${path}.stdout`);
  validateOutput(value.stderr, `${path}.stderr`);
  if (value.startedAt !== null) date(value.startedAt, `${path}.startedAt`);
  if (value.completedAt !== null) date(value.completedAt, `${path}.completedAt`);
  if (value.error !== null) requiredString(value.error, `${path}.error`);
  if (value.status === "skipped" && (value.startedAt !== null || value.completedAt !== null)) throw new Error(`${path} skipped timestamps must be null.`);
}

function validateOutput(value, path) {
  object(value, path);
  exactKeys(value, ["bytes", "digest", "tail", "truncated"], path);
  if (!Number.isInteger(value.bytes) || value.bytes < 0) throw new Error(`${path}.bytes must be a non-negative integer.`);
  sha256(value.digest, `${path}.digest`);
  if (typeof value.tail !== "string") throw new Error(`${path}.tail must be a string.`);
  boolean(value.truncated, `${path}.truncated`);
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value === "" || /[\0\r\n]/.test(value)) throw new Error(`${path} must be a non-empty single-line string.`);
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
}

function member(value, values, path) {
  if (!values.includes(value)) throw new Error(`${path} must be one of: ${values.join(", ")}.`);
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}.`);
}

function oid(value, path) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`${path} must be a Git object ID.`);
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${path} must be a SHA-256 digest.`);
}

function date(value, path) {
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${path} must be an ISO date-time.`);
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new Error(`${path} must be an array of non-empty strings.`);
  if (new Set(value).size !== value.length) throw new Error(`${path} must contain unique values.`);
}

function validateRelativePath(value, path, { allowDot = false } = {}) {
  requiredString(value, path);
  if ((allowDot && value === ".")) return;
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${path} must be a safe relative path.`);
  }
}
