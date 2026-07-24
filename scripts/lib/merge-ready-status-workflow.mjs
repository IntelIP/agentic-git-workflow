import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GitJsonLedger } from "./git-json-ledger.mjs";
import { effectiveGitHubRepository } from "./github-repository.mjs";
import { assertExternalStateRoot, canonicalProspectivePath } from "./external-state-root.mjs";
import {
  assertIntentMatchesValidation,
  createMergeReadyStatusIntent,
  validateMergeReadyStatusApproval,
  validateMergeReadyStatusIntent,
} from "./merge-ready-status.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import { repositoryIdentity } from "./repository-identity.mjs";
import { latestValidationResult } from "./validation-runner.mjs";
import { GitHubStatusPublisher } from "../providers/github-status-publisher.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";
import { runGit } from "./git-process.mjs";

export async function planMergeReadyStatus({
  repoPath = process.cwd(),
  repositoryId = null,
  commit = "HEAD",
  manifestPath = "tabellio.validation.json",
  ledgerRef = "refs/tabellio/validations",
  targetUrl = null,
  createdAt = new Date().toISOString(),
}) {
  const store = await NativeGitStore.open(resolve(repoPath));
  const repository = await effectiveGitHubRepository(store, "origin");
  const identity = await repositoryIdentity(store, repositoryId);
  if (identity.toLowerCase() !== repository.identity.toLowerCase()) {
    throw new Error(`Repository identity mismatch: expected ${repository.identity}, found ${identity}.`);
  }
  const canonicalIdentity = repository.identity;
  const headCommit = await store.resolveRef(commit);
  const ledger = await GitJsonLedger.open({ repoPath: store.repoPath, ref: ledgerRef });
  const validation = await latestValidationResult(ledger, headCommit, canonicalIdentity, { manifestPath });
  if (validation === null) {
    throw new Error(`No exact-head validation exists for ${headCommit} and ${manifestPath}.`);
  }
  return createMergeReadyStatusIntent({
    repository: { id: canonicalIdentity, owner: repository.owner, name: repository.name },
    commit: headCommit,
    validation,
    targetUrl,
    createdAt,
  });
}

export class MergeReadyStatusExecutor {
  constructor({ store, ledger, publisher, stateRoot, lock = withOperationLock }) {
    this.store = store;
    this.ledger = ledger;
    this.publisher = publisher;
    this.stateRoot = resolve(stateRoot);
    this.lock = lock;
  }

  static async open({
    repoPath = process.cwd(),
    ledgerRef = "refs/tabellio/validations",
    stateRoot = null,
    token,
    apiUrl,
    fetchImpl,
  }) {
    const store = await NativeGitStore.open(resolve(repoPath));
    const ledger = await GitJsonLedger.open({ repoPath: store.repoPath, ref: ledgerRef });
    const root = stateRoot === null
      ? await defaultStateRoot(store.repoPath)
      : resolve(stateRoot);
    if (stateRoot !== null) {
      const canonicalRoot = await canonicalProspectivePath(root);
      for (const protectedRoot of await statusStateProtectedRoots(store.repoPath)) {
        assertExternalStateRoot(protectedRoot, canonicalRoot, "Merge-ready status");
      }
    }
    return new MergeReadyStatusExecutor({
      store,
      ledger,
      publisher: new GitHubStatusPublisher({ token, baseUrl: apiUrl, fetchImpl }),
      stateRoot: root,
    });
  }

  async execute({ intent, approval, now = new Date() }) {
    validateMergeReadyStatusIntent(intent);
    validateMergeReadyStatusApproval(approval, intent, { now });
    return this.lock({
      repoPath: this.store.repoPath,
      stateRoot: this.stateRoot,
      lockName: "merge-ready-status",
      label: "merge-ready status publication",
    }, () => this.#executeLocked({ intent, approval, now }));
  }

  async #executeLocked({ intent, approval, now }) {
    const validation = await verifyExecutionBindings({
      store: this.store,
      ledger: this.ledger,
      intent,
    });
    assertIntentMatchesValidation(intent, validation);
    const { receipt, receiptPath } = await reserveReceipt(this.stateRoot, approval, intent, now);
    return publishStatus({
      publisher: this.publisher,
      intent,
      receipt,
      receiptPath,
    });
  }
}

export async function readMergeReadyStatusFile(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function verifyExecutionBindings({ store, ledger, intent }) {
  const actualIdentity = await repositoryIdentity(store);
  if (actualIdentity.toLowerCase() !== intent.repository.id.toLowerCase()) {
    throw new Error(`Status repository mismatch: expected ${intent.repository.id}, found ${actualIdentity}.`);
  }
  const actualCommit = await store.resolveRef(intent.commit);
  if (actualCommit !== intent.commit) throw new Error("Status commit does not resolve to the approved exact commit.");
  const validation = await latestValidationResult(
    ledger,
    intent.commit,
    intent.repository.id,
    { manifestPath: intent.validation.manifestPath },
  );
  if (validation === null) throw new Error("Approved exact-head validation is no longer available.");
  return validation;
}

async function reserveReceipt(stateRoot, approval, intent, now) {
  await mkdir(stateRoot, { recursive: true });
  const receiptPath = resolve(stateRoot, `${approval.id}.json`);
  const receipt = {
    schemaVersion: "tabellio-merge-ready-status-receipt/v0.1",
    approvalId: approval.id,
    intentDigest: intent.integrity.digest,
    repository: intent.repository.id,
    commit: intent.commit,
    context: intent.status.context,
    state: intent.status.state,
    status: "attempted",
    attemptedAt: now.toISOString(),
    completedAt: null,
    publication: null,
    error: null,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if (error?.code === "EEXIST") throw new Error(`Approval ${approval.id} was already consumed.`);
    throw error;
  });
  return { receipt, receiptPath };
}

async function publishStatus({ publisher, intent, receipt, receiptPath }) {
  try {
    receipt.publication = await publisher.publish({
      owner: intent.repository.owner,
      repo: intent.repository.name,
      commit: intent.commit,
      state: intent.status.state,
      context: intent.status.context,
      description: intent.status.description,
      targetUrl: intent.status.targetUrl,
    });
    assertPublishedStatus(receipt.publication, intent);
    receipt.status = "succeeded";
    receipt.completedAt = new Date().toISOString();
    await atomicWrite(receiptPath, receipt);
    return { receipt, receiptPath };
  } catch (error) {
    receipt.status = "failed";
    receipt.completedAt = new Date().toISOString();
    receipt.error = {
      name: error instanceof Error ? error.name : "Error",
      message: safeErrorMessage(error),
    };
    await atomicWrite(receiptPath, receipt);
    throw error;
  }
}

function assertPublishedStatus(publication, intent) {
  if (publication.commit !== intent.commit) throw new Error("GitHub returned a status for a different commit.");
  if (publication.context !== intent.status.context) throw new Error("GitHub returned a different status context.");
  if (publication.state !== intent.status.state) throw new Error("GitHub returned a different status state.");
}

async function defaultStateRoot(repoPath) {
  const common = await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: repoPath });
  return resolve(repoPath, common.stdout.trim(), "tabellio", "status-publications");
}

async function statusStateProtectedRoots(repoPath) {
  const [common, worktrees] = await Promise.all([
    runGit({ args: ["rev-parse", "--git-common-dir"], cwd: repoPath }),
    runGit({ args: ["worktree", "list", "--porcelain", "-z"], cwd: repoPath }),
  ]);
  const roots = [
    resolve(repoPath, common.stdout.trim()),
    ...worktrees.stdout
      .split("\0")
      .filter((value) => value.startsWith("worktree "))
      .map((value) => value.slice("worktree ".length)),
  ];
  return Promise.all([...new Set(roots)].map(canonicalProspectivePath));
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function safeErrorMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1_000);
}
