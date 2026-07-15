import { validateOperationApproval } from "./approval-validation.mjs";
import { contract } from "./contract-checks.mjs";
import { validateControlRefIntent } from "./control-ref-transport.mjs";
import { digestObject } from "./stack-operation.mjs";

const RELEASE_OPERATION_VERSION = "tabellio-release-operation/v0.1";
const RELEASE_APPROVAL_VERSION = "tabellio-release-approval/v0.1";

export function createReleaseIntent({
  repository,
  version,
  revision,
  pullRequest,
  controlIntent,
  validation,
  release,
  createdAt = new Date().toISOString(),
}) {
  const unsigned = {
    schemaVersion: RELEASE_OPERATION_VERSION,
    repository,
    version,
    tag: `v${version}`,
    revision,
    pullRequest,
    code: { remote: "origin", branch: "main" },
    control: { intent: controlIntent },
    validation,
    release,
    createdAt,
  };
  return validateReleaseIntent({
    ...unsigned,
    integrity: { algorithm: "sha256", digest: digestObject(unsigned) },
  });
}

export function validateReleaseIntent(value) {
  contract.object(value, "intent");
  contract.exactKeys(value, [
    "schemaVersion", "repository", "version", "tag", "revision", "pullRequest", "code",
    "control", "validation", "release", "createdAt", "integrity",
  ], "intent");
  contract.equals(value.schemaVersion, RELEASE_OPERATION_VERSION, "intent.schemaVersion");

  contract.object(value.repository, "intent.repository");
  contract.exactKeys(value.repository, ["id", "owner", "name"], "intent.repository");
  contract.string(value.repository.id, "intent.repository.id");
  contract.slug(value.repository.owner, "intent.repository.owner");
  contract.slug(value.repository.name, "intent.repository.name");

  contract.semver(value.version, "intent.version");
  contract.equals(value.tag, `v${value.version}`, "intent.tag");

  contract.object(value.revision, "intent.revision");
  contract.exactKeys(value.revision, ["commit", "parent"], "intent.revision");
  contract.oid(value.revision.commit, "intent.revision.commit");
  contract.oid(value.revision.parent, "intent.revision.parent");
  if (value.revision.commit.length !== value.revision.parent.length) throw new Error("intent.revision object IDs must use the same format.");

  contract.object(value.pullRequest, "intent.pullRequest");
  contract.exactKeys(value.pullRequest, ["number", "headCommit", "mergeCommit"], "intent.pullRequest");
  contract.positiveInteger(value.pullRequest.number, "intent.pullRequest.number");
  contract.oid(value.pullRequest.headCommit, "intent.pullRequest.headCommit");
  contract.oid(value.pullRequest.mergeCommit, "intent.pullRequest.mergeCommit");
  contract.equals(value.pullRequest.mergeCommit, value.revision.commit, "intent.pullRequest.mergeCommit");

  contract.object(value.code, "intent.code");
  contract.exactKeys(value.code, ["remote", "branch"], "intent.code");
  contract.equals(value.code.remote, "origin", "intent.code.remote");
  contract.equals(value.code.branch, "main", "intent.code.branch");

  contract.object(value.control, "intent.control");
  contract.exactKeys(value.control, ["intent"], "intent.control");
  validateControlRefIntent(value.control.intent);
  contract.equals(value.control.intent.operation, "publish", "intent.control.intent.operation");
  contract.equals(value.control.intent.repository.id, value.repository.id, "intent.control.intent.repository.id");

  contract.object(value.validation, "intent.validation");
  contract.exactKeys(value.validation, ["runId", "resultVersion", "status", "headCommit"], "intent.validation");
  contract.string(value.validation.runId, "intent.validation.runId");
  contract.oid(value.validation.resultVersion, "intent.validation.resultVersion");
  contract.equals(value.validation.status, "passed", "intent.validation.status");
  contract.equals(value.validation.headCommit, value.revision.commit, "intent.validation.headCommit");

  contract.object(value.release, "intent.release");
  contract.exactKeys(value.release, ["title", "notesPath", "notesDigest"], "intent.release");
  contract.string(value.release.title, "intent.release.title");
  contract.safeRelativePath(value.release.notesPath, "intent.release.notesPath");
  contract.sha256(value.release.notesDigest, "intent.release.notesDigest");

  contract.date(value.createdAt, "intent.createdAt");
  contract.object(value.integrity, "intent.integrity");
  contract.exactKeys(value.integrity, ["algorithm", "digest"], "intent.integrity");
  contract.equals(value.integrity.algorithm, "sha256", "intent.integrity.algorithm");
  contract.sha256(value.integrity.digest, "intent.integrity.digest");
  const { integrity: _integrity, ...unsigned } = value;
  contract.equals(value.integrity.digest, digestObject(unsigned), "intent.integrity.digest");
  return value;
}

export function validateReleaseApproval(value, intent, { now = new Date() } = {}) {
  return validateOperationApproval(value, intent, {
    schemaVersion: RELEASE_APPROVAL_VERSION,
    validateIntent: validateReleaseIntent,
    now,
  });
}
