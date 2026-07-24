import { validateOperationApproval } from "./approval-validation.mjs";
import { contract } from "./contract-checks.mjs";
import { digestObject } from "./stack-operation.mjs";
import { validateValidationResult } from "./validation-runner.mjs";

const INTENT_VERSION = "tabellio-merge-ready-status-intent/v0.1";
const APPROVAL_VERSION = "tabellio-merge-ready-status-approval/v0.1";
const CONTEXT = "Tabellio / merge-ready";
const MAX_APPROVAL_MS = 60 * 60 * 1000;
const STATUS_BY_VALIDATION = Object.freeze({
  passed: {
    state: "success",
    description: "Exact-head Tabellio validation passed.",
  },
  failed: {
    state: "failure",
    description: "Exact-head Tabellio validation failed.",
  },
  blocked: {
    state: "error",
    description: "Exact-head Tabellio validation is blocked.",
  },
});

export function createMergeReadyStatusIntent({
  repository,
  commit,
  validation,
  targetUrl = null,
  createdAt = new Date().toISOString(),
}) {
  validateValidationResult(validation);
  const status = STATUS_BY_VALIDATION[validation.status];
  if (!status) throw new Error(`Unsupported validation status: ${validation.status}.`);
  const unsigned = {
    schemaVersion: INTENT_VERSION,
    repository,
    commit,
    validation: {
      runId: validation.runId,
      resultDigest: validation.integrity.digest,
      status: validation.status,
      completedAt: validation.completedAt,
      manifestPath: validation.suite.manifestPath,
      manifestDigest: validation.suite.manifestDigest,
    },
    status: {
      context: CONTEXT,
      state: status.state,
      description: status.description,
      targetUrl,
    },
    createdAt,
  };
  return validateMergeReadyStatusIntent({
    ...unsigned,
    integrity: { algorithm: "sha256", digest: digestObject(unsigned) },
  });
}

export function validateMergeReadyStatusIntent(value) {
  contract.object(value, "intent");
  contract.exactKeys(
    value,
    ["schemaVersion", "repository", "commit", "validation", "status", "createdAt", "integrity"],
    "intent",
  );
  contract.equals(value.schemaVersion, INTENT_VERSION, "intent.schemaVersion");

  validateRepository(value.repository);

  contract.oid(value.commit, "intent.commit");

  contract.object(value.validation, "intent.validation");
  contract.exactKeys(
    value.validation,
    ["runId", "resultDigest", "status", "completedAt", "manifestPath", "manifestDigest"],
    "intent.validation",
  );
  contract.string(value.validation.runId, "intent.validation.runId");
  contract.sha256(value.validation.resultDigest, "intent.validation.resultDigest");
  contract.member(value.validation.status, Object.keys(STATUS_BY_VALIDATION), "intent.validation.status");
  contract.date(value.validation.completedAt, "intent.validation.completedAt");
  contract.safeRelativePath(value.validation.manifestPath, "intent.validation.manifestPath");
  contract.sha256(value.validation.manifestDigest, "intent.validation.manifestDigest");

  contract.object(value.status, "intent.status");
  contract.exactKeys(value.status, ["context", "state", "description", "targetUrl"], "intent.status");
  contract.equals(value.status.context, CONTEXT, "intent.status.context");
  const expectedStatus = STATUS_BY_VALIDATION[value.validation.status];
  contract.equals(value.status.state, expectedStatus.state, "intent.status.state");
  contract.equals(value.status.description, expectedStatus.description, "intent.status.description");
  validateTargetUrl(value.status.targetUrl, "intent.status.targetUrl");

  contract.date(value.createdAt, "intent.createdAt");
  if (Date.parse(value.createdAt) < Date.parse(value.validation.completedAt)) {
    throw new Error("intent.createdAt must not predate validation completion.");
  }
  validateIntentIntegrity(value);
  return value;
}

export function validateMergeReadyStatusApproval(value, intent, { now = new Date() } = {}) {
  const approval = validateOperationApproval(value, intent, {
    schemaVersion: APPROVAL_VERSION,
    validateIntent: validateMergeReadyStatusIntent,
    now,
  });
  if (Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt) > MAX_APPROVAL_MS) {
    throw new Error("Merge-ready status approval lifetime must not exceed one hour.");
  }
  return approval;
}

export function assertIntentMatchesValidation(intent, validation) {
  validateMergeReadyStatusIntent(intent);
  validateValidationResult(validation);
  contract.equals(validation.repository.id.toLowerCase(), intent.repository.id.toLowerCase(), "validation.repository.id");
  contract.equals(validation.revision.headCommit, intent.commit, "validation.revision.headCommit");
  contract.equals(validation.runId, intent.validation.runId, "validation.runId");
  contract.equals(validation.integrity.digest, intent.validation.resultDigest, "validation.integrity.digest");
  contract.equals(validation.status, intent.validation.status, "validation.status");
  contract.equals(validation.completedAt, intent.validation.completedAt, "validation.completedAt");
  contract.equals(validation.suite.manifestPath, intent.validation.manifestPath, "validation.suite.manifestPath");
  contract.equals(validation.suite.manifestDigest, intent.validation.manifestDigest, "validation.suite.manifestDigest");
  return validation;
}

function validateTargetUrl(value, path) {
  if (value === null) return;
  const parsed = parseAbsoluteUrl(value, path);
  requireSecureUrl(parsed, path);
  requireCredentialFreeUrl(parsed, path);
}

function validateRepository(value) {
  const path = "intent.repository";
  contract.object(value, path);
  contract.exactKeys(value, ["id", "owner", "name"], path);
  for (const key of ["owner", "name"]) validateRepositorySlug(value[key], `${path}.${key}`);
  contract.string(value.id, `${path}.id`);
  const canonical = `github.com/${value.owner}/${value.name}`;
  if (value.id.toLowerCase() !== canonical.toLowerCase()) {
    throw new Error(`${path}.id must match ${path}.owner and ${path}.name.`);
  }
}

function validateRepositorySlug(value, path) {
  contract.slug(value, path);
  if (value === "." || value === "..") throw new Error(`${path} must not be "." or "..".`);
}

function validateIntentIntegrity(value) {
  const path = "intent.integrity";
  contract.object(value.integrity, path);
  contract.exactKeys(value.integrity, ["algorithm", "digest"], path);
  contract.equals(value.integrity.algorithm, "sha256", `${path}.algorithm`);
  contract.sha256(value.integrity.digest, `${path}.digest`);
  const { integrity: _integrity, ...unsigned } = value;
  contract.equals(value.integrity.digest, digestObject(unsigned), `${path}.digest`);
}

function parseAbsoluteUrl(value, path) {
  contract.string(value, path);
  if (!URL.canParse(value)) throw new Error(`${path} must be null or an absolute URL.`);
  return new URL(value);
}

function requireSecureUrl(value, path) {
  const local = new Set(["localhost", "127.0.0.1"]).has(value.hostname);
  const allowed = value.protocol === "https:" || (value.protocol === "http:" && local);
  if (!allowed) throw new Error(`${path} must use HTTPS unless it targets localhost.`);
}

function requireCredentialFreeUrl(value, path) {
  if (`${value.username}${value.password}` !== "") throw new Error(`${path} must not contain credentials.`);
}
