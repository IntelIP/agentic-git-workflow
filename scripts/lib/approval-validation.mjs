const APPROVAL_KEYS = ["schemaVersion", "id", "intentDigest", "approved", "approvedBy", "approvedAt", "expiresAt", "reason"];

export function validateOperationApproval(value, intent, { schemaVersion, validateIntent, now = new Date() }) {
  validateIntent(intent);
  record(value, "approval");
  exactKeys(value, APPROVAL_KEYS, "approval");
  equals(value.schemaVersion, schemaVersion, "approval.schemaVersion");
  validateIdentity(value, intent);
  const window = approvalWindow(value);
  validateSequence(window, intent);
  validateActiveWindow(window, now);
  return value;
}

function validateIdentity(value, intent) {
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) throw new Error("approval.id contains unsupported characters.");
  equals(value.intentDigest, intent.integrity.digest, "approval.intentDigest");
  equals(value.approved, true, "approval.approved");
  requiredString(value.approvedBy, "approval.approvedBy");
  requiredString(value.reason, "approval.reason");
}

function approvalWindow(value) {
  date(value.approvedAt, "approval.approvedAt");
  date(value.expiresAt, "approval.expiresAt");
  return { approvedAt: Date.parse(value.approvedAt), expiresAt: Date.parse(value.expiresAt) };
}

function validateSequence({ approvedAt, expiresAt }, intent) {
  if (approvedAt < Date.parse(intent.createdAt)) throw new Error("approval.approvedAt must not precede the intent.");
  if (expiresAt <= approvedAt) throw new Error("approval.expiresAt must be later than approval.approvedAt.");
}

function validateActiveWindow({ approvedAt, expiresAt }, now) {
  if (now.getTime() < approvedAt) throw new Error("approval is not active yet.");
  if (now.getTime() >= expiresAt) throw new Error("approval has expired.");
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value);
  const wanted = new Set(expected);
  if (actual.length !== wanted.size) throw new Error(`${path} must contain exactly: ${expected.join(", ")}.`);
  if (actual.some((key) => !wanted.has(key))) throw new Error(`${path} must contain exactly: ${expected.join(", ")}.`);
}

function record(value, path) {
  if (Object.prototype.toString.call(value) !== "[object Object]") throw new Error(`${path} must be an object.`);
}

function requiredString(value, path) {
  if (typeof value !== "string") throw new Error(`${path} must be a non-empty string.`);
  if (!value.trim()) throw new Error(`${path} must be a non-empty string.`);
}

function date(value, path) {
  requiredString(value, path);
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!pattern.test(value)) throw new Error(`${path} must be an ISO date-time string.`);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${path} must be an ISO date-time string.`);
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}.`);
}
