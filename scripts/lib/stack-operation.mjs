import { createHash } from "node:crypto";

export const STACK_OPERATION_SCHEMA_VERSION = "tabellio-stack-operation/v0.1";
export const STACK_APPROVAL_SCHEMA_VERSION = "tabellio-stack-approval/v0.1";
export const STACK_OPERATIONS = ["submit", "update", "sync", "restack", "merge"];

export function createStackOperationIntent({
  operation,
  repositoryId,
  headCommit,
  refsDigest,
  branch,
  parameters,
  createdAt = new Date().toISOString(),
}) {
  const unsigned = {
    schemaVersion: STACK_OPERATION_SCHEMA_VERSION,
    operation,
    repository: { id: repositoryId, headCommit, refsDigest },
    branch,
    parameters,
    createdAt,
  };
  const intent = {
    ...unsigned,
    integrity: {
      algorithm: "sha256",
      digest: digestObject(unsigned),
    },
  };
  return validateStackOperationIntent(intent);
}

export function validateStackOperationIntent(value) {
  object(value, "intent");
  exactKeys(value, ["schemaVersion", "operation", "repository", "branch", "parameters", "createdAt", "integrity"], "intent");
  equals(value.schemaVersion, STACK_OPERATION_SCHEMA_VERSION, "intent.schemaVersion");
  member(value.operation, STACK_OPERATIONS, "intent.operation");
  object(value.repository, "intent.repository");
  exactKeys(value.repository, ["id", "headCommit", "refsDigest"], "intent.repository");
  string(value.repository.id, "intent.repository.id");
  oid(value.repository.headCommit, "intent.repository.headCommit");
  if (!/^[0-9a-f]{64}$/.test(value.repository.refsDigest)) throw new Error("intent.repository.refsDigest must be a SHA-256 digest.");
  string(value.branch, "intent.branch");
  branchName(value.branch, "intent.branch");
  date(value.createdAt, "intent.createdAt");
  validateParameters(value.operation, value.parameters);
  object(value.integrity, "intent.integrity");
  exactKeys(value.integrity, ["algorithm", "digest"], "intent.integrity");
  equals(value.integrity.algorithm, "sha256", "intent.integrity.algorithm");
  if (!/^[0-9a-f]{64}$/.test(value.integrity.digest)) throw new Error("intent.integrity.digest must be a SHA-256 digest.");
  const { integrity: _integrity, ...unsigned } = value;
  const expected = digestObject(unsigned);
  if (value.integrity.digest !== expected) throw new Error("intent.integrity.digest does not match the operation intent.");
  return value;
}

export function validateStackOperationApproval(value, intent, { now = new Date() } = {}) {
  validateStackOperationIntent(intent);
  object(value, "approval");
  exactKeys(value, ["schemaVersion", "id", "intentDigest", "approved", "approvedBy", "approvedAt", "expiresAt", "reason"], "approval");
  equals(value.schemaVersion, STACK_APPROVAL_SCHEMA_VERSION, "approval.schemaVersion");
  string(value.id, "approval.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) throw new Error("approval.id contains unsupported characters.");
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

export function digestObject(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateParameters(operation, value) {
  object(value, "intent.parameters");
  if (operation === "submit") {
    exactKeys(value, ["draft", "title", "body"], "intent.parameters");
    boolean(value.draft, "intent.parameters.draft");
    string(value.title, "intent.parameters.title");
    if (typeof value.body !== "string") throw new Error("intent.parameters.body must be a string.");
  } else if (operation === "update") {
    exactKeys(value, ["draft"], "intent.parameters");
    if (value.draft !== null) boolean(value.draft, "intent.parameters.draft");
  } else if (operation === "sync") {
    exactKeys(value, ["restack"], "intent.parameters");
    member(value.restack, ["none", "aboves", "upstack"], "intent.parameters.restack");
  } else if (operation === "restack") {
    exactKeys(value, [], "intent.parameters");
  } else {
    exactKeys(value, ["method", "readyTimeout", "mergeTimeout"], "intent.parameters");
    member(value.method, ["merge", "squash", "rebase"], "intent.parameters.method");
    duration(value.readyTimeout, "intent.parameters.readyTimeout");
    duration(value.mergeTimeout, "intent.parameters.mergeTimeout");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
}

function date(value, path) {
  string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be an ISO date-time string.`);
  }
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

function branchName(value, path) {
  if (value.startsWith("-") || value.startsWith("refs/") || value.includes("..") || /[~^:?*[\\\s]/.test(value)) {
    throw new Error(`${path} must be a safe branch name.`);
  }
}

function duration(value, path) {
  string(value, path);
  if (!/^(?:0|[1-9]\d*(?:ms|s|m|h))$/.test(value)) throw new Error(`${path} must be 0 or a duration ending in ms, s, m, or h.`);
}
