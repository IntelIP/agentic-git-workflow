import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { runGit } from "../lib/git-process.mjs";
import { repositoryIdentity } from "../lib/repository-identity.mjs";
import {
  digestObject,
  validateStackOperationApproval,
  validateStackOperationIntent,
} from "../lib/stack-operation.mjs";
import { runGitSpice } from "./git-spice-stack-manager.mjs";
import { NativeGitStore } from "./native-git-store.mjs";

const DEFAULT_TIMEOUT_MS = 35 * 60 * 1000;

export class ApprovedGitSpiceOperations {
  #env;

  constructor({ store, stateRoot, binary = "git-spice", timeoutMs = DEFAULT_TIMEOUT_MS, env = {} }) {
    this.store = store;
    this.stateRoot = stateRoot;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.#env = env;
  }

  static async open({ repoPath = process.cwd(), stateRoot = null, ...options } = {}) {
    const store = await NativeGitStore.open(repoPath);
    const commonDir = await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: store.repoPath });
    return new ApprovedGitSpiceOperations({
      ...options,
      store,
      stateRoot: stateRoot === null
        ? resolve(store.repoPath, commonDir.stdout.trim(), "tabellio", "stack-operations")
        : resolve(stateRoot),
    });
  }

  async execute({ intent, approval, repositoryId = null, now = new Date() }) {
    validateStackOperationIntent(intent);
    validateStackOperationApproval(approval, intent, { now });
    await this.store.validateBranch(intent.branch);
    const actualRepositoryId = await repositoryIdentity(this.store, repositoryId);
    if (actualRepositoryId !== intent.repository.id) {
      throw new Error(`Operation repository mismatch: expected ${intent.repository.id}, found ${actualRepositoryId}.`);
    }
    return this.#withLock(async () => {
      const clean = await runGit({
        args: ["status", "--porcelain=v1", "-z", "--", ".", ":(exclude).tabellio"],
        cwd: this.store.repoPath,
      });
      if (clean.stdout !== "") throw new Error("Stack write operations require a clean working tree.");
      const headBefore = await this.#branchHead(intent.branch);
      if (headBefore !== intent.repository.headCommit) {
        throw new Error(`Operation head mismatch for ${intent.branch}: expected ${intent.repository.headCommit}, found ${headBefore}.`);
      }
      const refsDigest = await repositoryRefsDigest(this.store.repoPath);
      if (refsDigest !== intent.repository.refsDigest) {
        throw new Error("Operation branch-set mismatch; local branch refs changed after planning.");
      }

      const receiptPath = join(this.stateRoot, `${approval.id}.json`);
      const handle = await open(receiptPath, "wx").catch((error) => {
        if (error?.code === "EEXIST") throw new Error(`Approval ${approval.id} was already consumed.`);
        throw error;
      });
      const attemptedAt = now.toISOString();
      const receipt = {
        schemaVersion: "tabellio-stack-operation-receipt/v0.1",
        approvalId: approval.id,
        intentDigest: intent.integrity.digest,
        operation: intent.operation,
        repository: intent.repository.id,
        branch: intent.branch,
        headBefore,
        headAfter: null,
        status: "attempted",
        attemptedAt,
        completedAt: null,
        error: null,
      };
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await handle.close();

      try {
        const args = operationArgs(intent);
        await runGitSpice({
          binary: this.binary,
          args,
          cwd: this.store.repoPath,
          timeoutMs: this.timeoutMs,
          env: this.#env,
        });
        receipt.headAfter = await this.#branchHead(intent.branch, { optional: intent.operation === "sync" || intent.operation === "merge" });
        receipt.status = "succeeded";
        receipt.completedAt = new Date().toISOString();
        await atomicWrite(receiptPath, receipt);
        return { ...receipt, receiptPath };
      } catch (error) {
        const safeError = new StackOperationExecutionError(intent.operation, error, [
          this.#env.FORGEJO_TOKEN,
          intent.parameters.title,
          intent.parameters.body,
        ]);
        receipt.status = "failed";
        receipt.completedAt = new Date().toISOString();
        receipt.error = {
          name: safeError.name,
          message: safeError.message,
        };
        await atomicWrite(receiptPath, receipt);
        throw safeError;
      }
    });
  }

  async #branchHead(branch, { optional = false } = {}) {
    try {
      const result = await runGit({ args: ["rev-parse", `refs/heads/${branch}`], cwd: this.store.repoPath });
      return result.stdout.trim();
    } catch (error) {
      if (optional) return null;
      throw error;
    }
  }

  async #withLock(action) {
    await mkdir(this.stateRoot, { recursive: true });
    const lockPath = join(this.stateRoot, "active.lock");
    const handle = await open(lockPath, "wx").catch((error) => {
      if (error?.code === "EEXIST") throw new Error("Another stack write operation is active.");
      throw error;
    });
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}

export class StackOperationExecutionError extends Error {
  constructor(operation, cause, secrets = []) {
    const detail = sanitize(cause?.stderr, secrets);
    super(`git-spice ${operation} operation failed${detail ? `: ${detail}` : "."}`);
    this.name = "StackOperationExecutionError";
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}

export async function readStackOperationFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function operationArgs(intent) {
  validateStackOperationIntent(intent);
  const common = ["--no-prompt"];
  if (intent.operation === "submit") {
    return [
      ...common,
      "branch", "submit",
      "--branch", intent.branch,
      "--no-web",
      "--nav-comment=false",
      intent.parameters.draft ? "--draft" : "--no-draft",
      "--title", intent.parameters.title,
      "--body", intent.parameters.body,
    ];
  }
  if (intent.operation === "update") {
    const draft = intent.parameters.draft === null ? [] : [intent.parameters.draft ? "--draft" : "--no-draft"];
    return [
      ...common,
      "branch", "submit",
      "--branch", intent.branch,
      "--update-only",
      "--no-web",
      "--nav-comment=false",
      ...draft,
    ];
  }
  if (intent.operation === "sync") {
    return [...common, "repo", "sync", `--restack=${intent.parameters.restack}`];
  }
  return [
    ...common,
    "branch", "merge",
    "--branch", intent.branch,
    "--method", intent.parameters.method,
    "--ready-timeout", intent.parameters.readyTimeout,
    "--merge-timeout", intent.parameters.mergeTimeout,
  ];
}

export async function repositoryRefsDigest(cwd) {
  const result = await runGit({
    args: ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"],
    cwd,
  });
  return digestObject(result.stdout.split(/\r?\n/).filter(Boolean).sort());
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function sanitize(value, secrets) {
  let output = typeof value === "string" ? value.trim() : "";
  for (const secret of secrets) {
    if (typeof secret === "string" && secret !== "") output = output.split(secret).join("[REDACTED]");
  }
  return output.slice(0, 1_000);
}
