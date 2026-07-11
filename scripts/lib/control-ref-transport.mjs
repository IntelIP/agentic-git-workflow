import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { runGit } from "./git-process.mjs";
import { digestObject } from "./stack-operation.mjs";

export const CONTROL_REF_INTENT_VERSION = "tabellio-control-ref-operation/v0.1";
export const CONTROL_REF_APPROVAL_VERSION = "tabellio-control-ref-approval/v0.1";
export const CONTROL_REFS = [
  "refs/tabellio/reviews",
  "refs/tabellio/validations",
  "refs/heads/entire/checkpoints/v1",
];

export function createControlRefIntent({ operation, repositoryId, remote, refs, createdAt = new Date().toISOString() }) {
  const unsigned = {
    schemaVersion: CONTROL_REF_INTENT_VERSION,
    operation,
    repository: { id: repositoryId },
    remote,
    refs: refs.map(({ name, localOid, remoteOid }) => ({ name, localOid, remoteOid })),
    createdAt,
  };
  return validateControlRefIntent({
    ...unsigned,
    integrity: { algorithm: "sha256", digest: digestObject(unsigned) },
  });
}

export function validateControlRefIntent(value) {
  object(value, "intent");
  exact(value, ["schemaVersion", "operation", "repository", "remote", "refs", "createdAt", "integrity"], "intent");
  equals(value.schemaVersion, CONTROL_REF_INTENT_VERSION, "intent.schemaVersion");
  member(value.operation, ["publish", "fetch"], "intent.operation");
  object(value.repository, "intent.repository");
  exact(value.repository, ["id"], "intent.repository");
  string(value.repository.id, "intent.repository.id");
  remoteName(value.remote);
  if (!Array.isArray(value.refs) || value.refs.length === 0) throw new Error("intent.refs must be a non-empty array.");
  const names = new Set();
  for (const [index, entry] of value.refs.entries()) {
    object(entry, `intent.refs[${index}]`);
    exact(entry, ["name", "localOid", "remoteOid"], `intent.refs[${index}]`);
    if (!CONTROL_REFS.includes(entry.name)) throw new Error(`intent.refs[${index}].name is not an allowed control ref.`);
    if (names.has(entry.name)) throw new Error(`intent.refs contains duplicate ref ${entry.name}.`);
    names.add(entry.name);
    nullableOid(entry.localOid, `intent.refs[${index}].localOid`);
    nullableOid(entry.remoteOid, `intent.refs[${index}].remoteOid`);
    if (value.operation === "publish" && entry.localOid === null) throw new Error(`publish requires local ref ${entry.name}.`);
    if (value.operation === "fetch" && entry.remoteOid === null) throw new Error(`fetch requires remote ref ${entry.name}.`);
  }
  date(value.createdAt, "intent.createdAt");
  object(value.integrity, "intent.integrity");
  exact(value.integrity, ["algorithm", "digest"], "intent.integrity");
  equals(value.integrity.algorithm, "sha256", "intent.integrity.algorithm");
  sha256(value.integrity.digest, "intent.integrity.digest");
  const { integrity: _integrity, ...unsigned } = value;
  if (digestObject(unsigned) !== value.integrity.digest) throw new Error("intent.integrity.digest does not match the control-ref intent.");
  return value;
}

export function validateControlRefApproval(value, intent, { now = new Date() } = {}) {
  validateControlRefIntent(intent);
  object(value, "approval");
  exact(value, ["schemaVersion", "id", "intentDigest", "approved", "approvedBy", "approvedAt", "expiresAt", "reason"], "approval");
  equals(value.schemaVersion, CONTROL_REF_APPROVAL_VERSION, "approval.schemaVersion");
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) throw new Error("approval.id contains unsupported characters.");
  equals(value.intentDigest, intent.integrity.digest, "approval.intentDigest");
  equals(value.approved, true, "approval.approved");
  string(value.approvedBy, "approval.approvedBy");
  string(value.reason, "approval.reason");
  date(value.approvedAt, "approval.approvedAt");
  date(value.expiresAt, "approval.expiresAt");
  const approvedAt = Date.parse(value.approvedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (approvedAt < Date.parse(intent.createdAt)) throw new Error("approval.approvedAt must not precede the intent.");
  if (expiresAt <= approvedAt) throw new Error("approval.expiresAt must be later than approval.approvedAt.");
  if (now.getTime() < approvedAt) throw new Error("approval is not active yet.");
  if (now.getTime() >= expiresAt) throw new Error("approval has expired.");
  return value;
}

export async function snapshotControlRefs({ repoPath, remote, refs, env = {} }) {
  remoteName(remote);
  const unique = [...new Set(refs)];
  if (unique.length === 0 || unique.some((ref) => !CONTROL_REFS.includes(ref))) throw new Error("refs must be a non-empty subset of canonical control refs.");
  return Promise.all(unique.map(async (name) => ({
    name,
    localOid: await localOid(repoPath, name),
    remoteOid: await remoteOid(repoPath, remote, name, env),
  })));
}

export class ApprovedControlRefTransport {
  #env;

  constructor({ repoPath, stateRoot, env = {} }) {
    this.repoPath = repoPath;
    this.stateRoot = stateRoot;
    this.#env = env;
  }

  static async open({ repoPath = process.cwd(), stateRoot = null, env = {} } = {}) {
    const inputPath = resolve(repoPath);
    const bare = (await runGit({ args: ["rev-parse", "--is-bare-repository"], cwd: inputPath })).stdout.trim() === "true";
    const top = bare
      ? await realpath(inputPath)
      : (await runGit({ args: ["rev-parse", "--show-toplevel"], cwd: inputPath })).stdout.trim();
    const common = (await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: top })).stdout.trim();
    return new ApprovedControlRefTransport({
      repoPath: top,
      stateRoot: stateRoot === null ? resolve(top, common, "tabellio", "control-ref-operations") : resolve(stateRoot),
      env,
    });
  }

  async execute({ intent, approval, repositoryId, now = new Date() }) {
    validateControlRefIntent(intent);
    validateControlRefApproval(approval, intent, { now });
    if (repositoryId !== intent.repository.id) throw new Error(`Operation repository mismatch: expected ${intent.repository.id}, found ${repositoryId}.`);
    return this.#withLock(async () => {
      for (const entry of intent.refs) {
        const actual = await localOid(this.repoPath, entry.name);
        if (actual !== entry.localOid) throw new Error(`Local control ref changed after planning: ${entry.name}.`);
      }
      const receiptPath = join(this.stateRoot, `${approval.id}.json`);
      const handle = await open(receiptPath, "wx").catch((error) => {
        if (error?.code === "EEXIST") throw new Error(`Approval ${approval.id} was already consumed.`);
        throw error;
      });
      const receipt = {
        schemaVersion: "tabellio-control-ref-operation-receipt/v0.1",
        approvalId: approval.id,
        intentDigest: intent.integrity.digest,
        operation: intent.operation,
        repository: intent.repository.id,
        remote: intent.remote,
        refs: intent.refs.map((entry) => ({ name: entry.name, before: entry.localOid, after: null, status: "pending" })),
        status: "attempted",
        attemptedAt: now.toISOString(),
        completedAt: null,
        error: null,
      };
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await handle.close();
      try {
        for (const entry of intent.refs) {
          const actualRemote = await remoteOid(this.repoPath, intent.remote, entry.name, this.#env);
          if (actualRemote !== entry.remoteOid) throw new Error(`Remote control ref changed after planning: ${entry.name}.`);
        }
        const results = intent.operation === "publish"
          ? await this.#publish(intent.remote, intent.refs)
          : await this.#fetch(intent.remote, intent.refs);
        for (const [index, entry] of intent.refs.entries()) {
          const result = results[index];
          receipt.refs[index] = { name: entry.name, before: entry.localOid, after: result.after, status: result.status };
        }
        receipt.status = "succeeded";
        receipt.completedAt = new Date().toISOString();
        await atomicWrite(receiptPath, receipt);
        return { ...receipt, receiptPath };
      } catch (error) {
        receipt.status = "failed";
        receipt.completedAt = new Date().toISOString();
        receipt.error = { name: error instanceof Error ? error.name : "Error", message: sanitize(error instanceof Error ? error.message : String(error)) };
        await atomicWrite(receiptPath, receipt);
        throw error;
      }
    });
  }

  async #publish(remote, entries) {
    for (const entry of entries) {
      if (entry.remoteOid !== null) {
        await this.#fetchObjects(remote, entry.name);
        if (!await isAncestor(this.repoPath, entry.remoteOid, entry.localOid)) throw new Error(`Publish would not fast-forward ${entry.name}; fetch and reconcile first.`);
      }
    }
    await runGit({
      args: [
        "push",
        "--atomic",
        ...entries.map((entry) => `--force-with-lease=${entry.name}:${entry.remoteOid ?? ""}`),
        remote,
        ...entries.map((entry) => `${entry.localOid}:${entry.name}`),
      ],
      cwd: this.repoPath,
      env: this.#env,
    });
    return entries.map((entry) => ({
      after: entry.localOid,
      status: entry.remoteOid === entry.localOid ? "unchanged" : "published",
    }));
  }

  async #fetch(remote, entries) {
    const updates = [];
    const results = [];
    for (const entry of entries) {
      await this.#fetchObjects(remote, entry.name);
      if (entry.localOid !== null && !await isAncestor(this.repoPath, entry.localOid, entry.remoteOid)) {
        if (await isAncestor(this.repoPath, entry.remoteOid, entry.localOid)) {
          results.push({ after: entry.localOid, status: "local_ahead" });
          continue;
        }
        throw new Error(`Fetch would diverge ${entry.name}; reconcile explicitly.`);
      }
      if (entry.localOid !== entry.remoteOid) {
        updates.push({ ref: entry.name, newOid: entry.remoteOid, oldOid: entry.localOid ?? "0".repeat(entry.remoteOid.length) });
      }
      results.push({ after: entry.remoteOid, status: entry.localOid === entry.remoteOid ? "unchanged" : "fetched" });
    }
    if (updates.length > 0) await updateRefsAtomically(this.repoPath, updates);
    return results;
  }

  async #fetchObjects(remote, ref) {
    await runGit({ args: ["fetch", "--no-tags", "--no-write-fetch-head", remote, ref], cwd: this.repoPath, env: this.#env });
  }

  async #withLock(action) {
    await mkdir(this.stateRoot, { recursive: true });
    const path = join(this.stateRoot, "active.lock");
    const handle = await open(path, "wx").catch((error) => {
      if (error?.code === "EEXIST") throw new Error("Another control-ref operation is active.");
      throw error;
    });
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(path, { force: true });
    }
  }
}

export async function readControlRefFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function localOid(cwd, ref) {
  const result = await runGit({ args: ["rev-parse", "--verify", "--end-of-options", ref], cwd, acceptableExitCodes: [0, 1, 128] });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function remoteOid(cwd, remote, ref, env) {
  const result = await runGit({ args: ["ls-remote", "--refs", remote, ref], cwd, env });
  const lines = result.stdout.trim() === "" ? [] : result.stdout.trim().split(/\r?\n/);
  if (lines.length > 1) throw new Error(`Remote returned multiple values for ${ref}.`);
  if (lines.length === 0) return null;
  const [oid, name] = lines[0].split(/\s+/);
  if (name !== ref || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error(`Remote returned an invalid value for ${ref}.`);
  return oid;
}

async function isAncestor(cwd, ancestor, descendant) {
  const result = await runGit({ args: ["merge-base", "--is-ancestor", ancestor, descendant], cwd, acceptableExitCodes: [0, 1] });
  return result.exitCode === 0;
}

function updateRefsAtomically(cwd, updates) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["update-ref", "--stdin", "-m", "tabellio: approved atomic control ref fetch"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Atomic control-ref update failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${stderr.trim() ? `: ${stderr.trim().slice(0, 1_000)}` : "."}`));
    });
    child.stdin.end(`${updates.map(({ ref, newOid, oldOid }) => `update ${ref} ${newOid} ${oldOid}`).join("\n")}\n`);
  });
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function sanitize(value) {
  return value.replace(/https?:\/\/[^\s@]+@/g, "https://[REDACTED]@").slice(0, 1_000);
}

function remoteName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("intent.remote must be a safe Git remote name.");
}

function nullableOid(value, path) {
  if (value !== null && (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) throw new Error(`${path} must be null or a Git object ID.`);
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${path} must be a SHA-256 digest.`);
}

function exact(value, keys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${path} must contain exactly: ${expected.join(", ")}.`);
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function member(value, values, path) {
  if (!values.includes(value)) throw new Error(`${path} must be one of: ${values.join(", ")}.`);
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}.`);
}

function date(value, path) {
  string(value, path);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${path} must be an ISO date-time string.`);
}
