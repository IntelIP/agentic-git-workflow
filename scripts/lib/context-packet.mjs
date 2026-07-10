import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CONTEXT_SCHEMA_VERSION = "tabellio-context/v0.1";
export const CONTEXT_INTEGRITY_SCOPE = "canonical-json-without-integrity";

export function createContextPacket(input) {
  const packet = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    runId: input.runId,
    repository: input.repository,
    actor: input.actor,
    task: input.task,
    refs: input.refs,
    changeSet: input.changeSet,
    checkpoints: input.checkpoints ?? [],
    mergePreview: input.mergePreview,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  validateContextPacket(packet, { verifyIntegrity: false });
  packet.integrity = {
    algorithm: "sha256",
    scope: CONTEXT_INTEGRITY_SCOPE,
    digest: contextDigest(packet),
  };
  return packet;
}

export async function readContextPacket(path) {
  const packet = JSON.parse(await readFile(path, "utf8"));
  validateContextPacket(packet);
  return packet;
}

export function validateContextPacket(value, { verifyIntegrity = true } = {}) {
  if (!isObject(value)) throw new Error("Context packet must be an object.");
  exactKeys(value, [
    "schemaVersion",
    "runId",
    "repository",
    "actor",
    "task",
    "refs",
    "changeSet",
    "checkpoints",
    "mergePreview",
    "createdAt",
    "integrity",
  ], "context packet");
  equals(value.schemaVersion, CONTEXT_SCHEMA_VERSION, "schemaVersion");
  requiredString(value.runId, "runId");
  requiredString(value.createdAt, "createdAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("createdAt must be an ISO date-time string.");
  }

  requireObject(value.repository, "repository");
  exactKeys(value.repository, ["id", "storage"], "repository");
  requiredString(value.repository.id, "repository.id");
  if (/^(?:\/|file:|[A-Za-z]:[\\/])/.test(value.repository.id) || value.repository.id.includes("\\")) {
    throw new Error("repository.id must not expose a local filesystem path.");
  }
  oneOf(value.repository.storage, ["native-git"], "repository.storage");

  requireObject(value.actor, "actor");
  exactKeys(value.actor, ["type", "id"], "actor");
  oneOf(value.actor.type, ["human", "agent", "ci", "system"], "actor.type");
  requiredString(value.actor.id, "actor.id");

  requireObject(value.task, "task");
  exactKeys(value.task, ["summary"], "task");
  requiredString(value.task.summary, "task.summary");

  requireObject(value.refs, "refs");
  exactKeys(value.refs, ["base", "head", "mergeBase"], "refs");
  for (const key of ["base", "head", "mergeBase"]) {
    requireObject(value.refs[key], `refs.${key}`);
    exactKeys(value.refs[key], ["name", "commit"], `refs.${key}`);
    requiredString(value.refs[key].name, `refs.${key}.name`);
    oid(value.refs[key].commit, `refs.${key}.commit`);
  }
  const repositoryOidLength = value.refs.base.commit.length;
  for (const key of ["head", "mergeBase"]) {
    if (value.refs[key].commit.length !== repositoryOidLength) {
      throw new Error(`refs.${key}.commit must use the repository object format.`);
    }
  }

  requireObject(value.changeSet, "changeSet");
  exactKeys(value.changeSet, ["files"], "changeSet");
  if (!Array.isArray(value.changeSet.files)) throw new Error("changeSet.files must be an array.");
  value.changeSet.files.forEach((file, index) => {
    requireObject(file, `changeSet.files[${index}]`);
    exactKeys(file, ["status", "path", "previousPath"], `changeSet.files[${index}]`);
    if (typeof file.status !== "string" || !/^(?:[ADMTUXB]|[RC][0-9]{1,3})$/.test(file.status)) {
      throw new Error(`changeSet.files[${index}].status must be a Git name-status code.`);
    }
    requiredString(file.path, `changeSet.files[${index}].path`);
    if (file.previousPath !== undefined) requiredString(file.previousPath, `changeSet.files[${index}].previousPath`);
  });

  if (!Array.isArray(value.checkpoints)) throw new Error("checkpoints must be an array.");
  value.checkpoints.forEach((checkpoint, index) => {
    requireObject(checkpoint, `checkpoints[${index}]`);
    exactKeys(checkpoint, ["ref", "commit", "digest", "summary"], `checkpoints[${index}]`);
    requiredString(checkpoint.ref, `checkpoints[${index}].ref`);
    oid(checkpoint.commit, `checkpoints[${index}].commit`);
    if (checkpoint.commit.length !== repositoryOidLength) {
      throw new Error(`checkpoints[${index}].commit must use the repository object format.`);
    }
    oid(checkpoint.digest, `checkpoints[${index}].digest`, 64);
    if (checkpoint.summary !== undefined) {
      requiredString(checkpoint.summary, `checkpoints[${index}].summary`);
      if (checkpoint.summary.length > 500) throw new Error(`checkpoints[${index}].summary must be at most 500 characters.`);
    }
  });

  requireObject(value.mergePreview, "mergePreview");
  exactKeys(value.mergePreview, ["clean", "tree", "conflictFiles"], "mergePreview");
  if (typeof value.mergePreview.clean !== "boolean") throw new Error("mergePreview.clean must be a boolean.");
  if (!Array.isArray(value.mergePreview.conflictFiles)) throw new Error("mergePreview.conflictFiles must be an array.");
  value.mergePreview.conflictFiles.forEach((file, index) => requiredString(file, `mergePreview.conflictFiles[${index}]`));
  if (value.mergePreview.tree !== null) {
    oid(value.mergePreview.tree, "mergePreview.tree");
    if (value.mergePreview.tree.length !== repositoryOidLength) {
      throw new Error("mergePreview.tree must use the repository object format.");
    }
  }

  if (verifyIntegrity) {
    requireObject(value.integrity, "integrity");
    exactKeys(value.integrity, ["algorithm", "scope", "digest"], "integrity");
    equals(value.integrity.algorithm, "sha256", "integrity.algorithm");
    equals(value.integrity.scope, CONTEXT_INTEGRITY_SCOPE, "integrity.scope");
    oid(value.integrity.digest, "integrity.digest", 64);
    const expected = contextDigest(value);
    if (value.integrity.digest !== expected) throw new Error("integrity.digest does not match the context packet.");
  }
  return value;
}

export function contextDigest(value) {
  const { integrity: _integrity, ...content } = value;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${expected}.`);
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function requireObject(value, path) {
  if (!isObject(value)) throw new Error(`${path} must be an object.`);
}

function exactKeys(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unsupported properties: ${unexpected.join(", ")}.`);
  const undefinedKeys = Object.keys(value).filter((key) => value[key] === undefined);
  if (undefinedKeys.length > 0) throw new Error(`${path} properties must not be undefined: ${undefinedKeys.join(", ")}.`);
}

function oid(value, path, length = null) {
  const expression = length ? new RegExp(`^[0-9a-f]{${length}}$`) : /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (typeof value !== "string" || !expression.test(value)) throw new Error(`${path} must be a hexadecimal object ID.`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
