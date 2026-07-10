import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, validateContextPacket } from "./lib/context-packet.mjs";

const args = parseArgs(process.argv.slice(2));
const evidencePath = args.evidence ?? "tabellio-pr-evidence.json";
const root = process.cwd();
const absoluteEvidencePath = isAbsolute(evidencePath) ? evidencePath : join(root, evidencePath);
const evidenceRoot = dirname(absoluteEvidencePath);
const requiredActionClasses = [
  "deployment",
  "database-migration",
  "infrastructure-change",
  "dns-or-hosting-change",
  "billing-or-live-money",
  "credentialed-provider-read",
  "secret-value-read",
  "destructive-workspace-action",
];

const blockers = [];
const warnings = [];
let evidence = null;

try {
  evidence = readJson(evidencePath);
  validateEvidence(evidence, blockers, warnings);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}

const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "tabellio_evidence_envelope_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  evidencePath,
  schemaPath: "schemas/evidence-envelope.schema.json",
  externalActionPolicySchemaPath: "schemas/external-action-policy.schema.json",
  requiredActionClasses,
  summary: evidence
    ? {
        schemaVersion: evidence.schemaVersion ?? null,
        runId: evidence.runId ?? null,
        repo: evidence.repo ?? null,
        changedFileCount: Array.isArray(evidence.changedFiles) ? evidence.changedFiles.length : null,
        commandCount: Array.isArray(evidence.commandsRun) ? evidence.commandsRun.length : null,
        checkCount: Array.isArray(evidence.checks) ? evidence.checks.length : null,
      }
    : null,
  warnings,
  blockers,
};

if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));

function validateEvidence(value, localBlockers, localWarnings) {
  if (!isObject(value)) {
    localBlockers.push("Evidence must be a JSON object.");
    return;
  }

  stringEquals(value.schemaVersion, "tabellio-evidence/v0.1", "schemaVersion", localBlockers);
  requiredString(value.runId, "runId", localBlockers);
  requiredString(value.repo, "repo", localBlockers);
  requiredString(value.createdAt, "createdAt", localBlockers);

  validateGit(value.git, localBlockers);
  validateActor(value.actor, localBlockers);
  validateAgentRuntime(value.agentRuntime, localBlockers);
  validateTaskSource(value.taskSource, localBlockers);
  validateStringArray(value.changedFiles, "changedFiles", localBlockers);
  validateCommands(value.commandsRun, localBlockers);
  validateChecks(value.checks, localBlockers);
  validateApprovals(value.approvals, localBlockers);
  validateArtifacts(value.artifacts, value, localBlockers);
  validateExternalActionPolicy(value.externalActionPolicy, localBlockers, localWarnings);
  if (value.context !== undefined) validateContextBinding(value.context, value, localBlockers);
}

function validateGit(value, localBlockers) {
  if (!isObject(value)) {
    localBlockers.push("git must be an object.");
    return;
  }
  requiredString(value.baseRef, "git.baseRef", localBlockers);
  requiredString(value.headRef, "git.headRef", localBlockers);
  requiredString(value.sha, "git.sha", localBlockers);
}

function validateActor(value, localBlockers) {
  if (!isObject(value)) {
    localBlockers.push("actor must be an object.");
    return;
  }
  oneOf(value.type, ["human", "agent", "ci", "system"], "actor.type", localBlockers);
  requiredString(value.id, "actor.id", localBlockers);
}

function validateAgentRuntime(value, localBlockers) {
  if (!isObject(value)) {
    localBlockers.push("agentRuntime must be an object.");
    return;
  }
  requiredString(value.name, "agentRuntime.name", localBlockers);
}

function validateTaskSource(value, localBlockers) {
  if (!isObject(value)) {
    localBlockers.push("taskSource must be an object.");
    return;
  }
  oneOf(value.type, ["issue", "pull_request", "chat", "ticket", "manual", "other"], "taskSource.type", localBlockers);
  requiredString(value.summary, "taskSource.summary", localBlockers);
}

function validateCommands(value, localBlockers) {
  if (!Array.isArray(value)) {
    localBlockers.push("commandsRun must be an array.");
    return;
  }
  if (value.length === 0) localBlockers.push("commandsRun must contain at least one command.");
  value.forEach((command, index) => {
    const path = `commandsRun[${index}]`;
    if (!isObject(command)) {
      localBlockers.push(`${path} must be an object.`);
      return;
    }
    requiredString(command.command, `${path}.command`, localBlockers);
    oneOf(command.status, ["passed", "failed", "skipped"], `${path}.status`, localBlockers);
  });
}

function validateChecks(value, localBlockers) {
  if (!Array.isArray(value)) {
    localBlockers.push("checks must be an array.");
    return;
  }
  if (value.length === 0) localBlockers.push("checks must contain at least one check.");
  value.forEach((check, index) => {
    const path = `checks[${index}]`;
    if (!isObject(check)) {
      localBlockers.push(`${path} must be an object.`);
      return;
    }
    requiredString(check.name, `${path}.name`, localBlockers);
    oneOf(check.status, ["passed", "failed", "skipped", "pending"], `${path}.status`, localBlockers);
  });
}

function validateApprovals(value, localBlockers) {
  if (!Array.isArray(value)) {
    localBlockers.push("approvals must be an array.");
    return;
  }
  value.forEach((approval, index) => {
    const path = `approvals[${index}]`;
    if (!isObject(approval)) {
      localBlockers.push(`${path} must be an object.`);
      return;
    }
    requiredString(approval.actionClass, `${path}.actionClass`, localBlockers);
    oneOf(approval.status, ["not_required", "required", "approved", "denied"], `${path}.status`, localBlockers);
  });
}

function validateArtifacts(value, envelope, localBlockers) {
  if (!Array.isArray(value)) {
    localBlockers.push("artifacts must be an array.");
    return;
  }
  value.forEach((artifact, index) => {
    const path = `artifacts[${index}]`;
    if (!isObject(artifact)) {
      localBlockers.push(`${path} must be an object.`);
      return;
    }
    requiredString(artifact.name, `${path}.name`, localBlockers);
    requiredString(artifact.path, `${path}.path`, localBlockers);
    if (artifact.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      localBlockers.push(`${path}.sha256 must be a lowercase SHA-256 digest.`);
    }
    if (artifact.hashScope !== undefined) {
      oneOf(artifact.hashScope, ["file-bytes", "canonical-json-without-this-artifact-sha256"], `${path}.hashScope`, localBlockers);
    }
    if (artifact.hashScope === "canonical-json-without-this-artifact-sha256") {
      if (!artifact.sha256) {
        localBlockers.push(`${path}.sha256 is required for canonical evidence integrity.`);
      } else {
        const copy = structuredClone(envelope);
        delete copy.artifacts[index].sha256;
        const expected = createHash("sha256").update(canonicalJson(copy)).digest("hex");
        if (artifact.sha256 !== expected) localBlockers.push(`${path}.sha256 does not match the evidence envelope.`);
      }
    }
    if (artifact.hashScope === "file-bytes") {
      if (!artifact.sha256) {
        localBlockers.push(`${path}.sha256 is required for file-byte integrity.`);
      } else {
        try {
          const absolute = isAbsolute(artifact.path) ? artifact.path : resolve(evidenceRoot, artifact.path);
          const expected = createHash("sha256").update(readFileSync(absolute)).digest("hex");
          if (artifact.sha256 !== expected) localBlockers.push(`${path}.sha256 does not match the artifact bytes.`);
        } catch (error) {
          localBlockers.push(`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  });
}

function validateContextBinding(value, envelope, localBlockers) {
  if (!isObject(value)) {
    localBlockers.push("context must be an object.");
    return;
  }
  stringEquals(value.schemaVersion, "tabellio-context/v0.1", "context.schemaVersion", localBlockers);
  requiredString(value.packetPath, "context.packetPath", localBlockers);
  if (!/^[0-9a-f]{64}$/.test(value.digest ?? "")) localBlockers.push("context.digest must be a SHA-256 digest.");
  for (const field of ["baseCommit", "headCommit", "mergeBaseCommit"]) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value[field] ?? "")) localBlockers.push(`context.${field} must be a Git object ID.`);
  }
  if (typeof value.mergeClean !== "boolean") localBlockers.push("context.mergeClean must be a boolean.");
  if (value.headCommit !== envelope.git?.sha) localBlockers.push("context.headCommit must match git.sha.");
  try {
    const packet = readJsonFromEvidence(value.packetPath);
    validateContextPacket(packet);
    if (packet.integrity.digest !== value.digest) localBlockers.push("context.digest must match the context packet.");
    if (packet.refs.base.commit !== value.baseCommit) localBlockers.push("context.baseCommit must match the context packet.");
    if (packet.refs.head.commit !== value.headCommit) localBlockers.push("context.headCommit must match the context packet.");
    if (packet.refs.mergeBase.commit !== value.mergeBaseCommit) localBlockers.push("context.mergeBaseCommit must match the context packet.");
    if (packet.mergePreview.clean !== value.mergeClean) localBlockers.push("context.mergeClean must match the context packet.");
    if (packet.runId !== envelope.runId) localBlockers.push("context packet runId must match the evidence envelope.");
    if (packet.repository.id !== envelope.repo) localBlockers.push("context packet repository must match the evidence envelope.");
  } catch (error) {
    localBlockers.push(`context packet is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateExternalActionPolicy(value, localBlockers, localWarnings) {
  if (!isObject(value)) {
    localBlockers.push("externalActionPolicy must be an object.");
    return;
  }
  oneOf(value.defaultMode, ["deny", "default-deny"], "externalActionPolicy.defaultMode", localBlockers);
  if (!Array.isArray(value.actionClasses)) {
    localBlockers.push("externalActionPolicy.actionClasses must be an array.");
    return;
  }

  const entriesById = new Map();
  value.actionClasses.forEach((entry, index) => {
    const path = `externalActionPolicy.actionClasses[${index}]`;
    if (!isObject(entry)) {
      localBlockers.push(`${path} must be an object.`);
      return;
    }
    requiredString(entry.id, `${path}.id`, localBlockers);
    if (entry.id) entriesById.set(entry.id, entry);
    if (entry.requiresExplicitApproval !== true) {
      localBlockers.push(`${path}.requiresExplicitApproval must be true.`);
    }
    if (typeof entry.approved !== "boolean") {
      localBlockers.push(`${path}.approved must be a boolean.`);
    }
    if (typeof entry.attempted !== "boolean") {
      localBlockers.push(`${path}.attempted must be a boolean.`);
    }
    if (entry.approved !== true && entry.attempted === true) {
      localBlockers.push(`${path} attempted an external action without approval.`);
    }
    validateStringArray(entry.expectedSideEffects, `${path}.expectedSideEffects`, localBlockers);
    if (!Array.isArray(entry.forbiddenSideEffects) || entry.forbiddenSideEffects.length === 0) {
      localBlockers.push(`${path}.forbiddenSideEffects must be a non-empty array.`);
    } else {
      validateStringArray(entry.forbiddenSideEffects, `${path}.forbiddenSideEffects`, localBlockers);
    }
    requiredString(entry.verificationCommand, `${path}.verificationCommand`, localBlockers);
  });

  if (entriesById.size !== value.actionClasses.length) {
    localBlockers.push("externalActionPolicy.actionClasses must not contain duplicate ids.");
  }

  for (const actionClass of requiredActionClasses) {
    if (!entriesById.has(actionClass)) {
      localBlockers.push(`externalActionPolicy is missing required action class ${actionClass}.`);
    }
  }

  for (const entry of value.actionClasses) {
    if (entry?.approved === true && entry?.attempted !== true) {
      localWarnings.push(`${entry.id} is approved but not attempted; verify this was intentional.`);
    }
  }
}

function validateStringArray(value, path, localBlockers) {
  if (!Array.isArray(value)) {
    localBlockers.push(`${path} must be an array.`);
    return;
  }
  value.forEach((entry, index) => requiredString(entry, `${path}[${index}]`, localBlockers));
}

function requiredString(value, path, localBlockers) {
  if (typeof value !== "string" || value.trim() === "") {
    localBlockers.push(`${path} must be a non-empty string.`);
  }
}

function stringEquals(value, expected, path, localBlockers) {
  if (value !== expected) localBlockers.push(`${path} must be ${expected}.`);
}

function oneOf(value, allowed, path, localBlockers) {
  if (!allowed.includes(value)) {
    localBlockers.push(`${path} must be one of: ${allowed.join(", ")}.`);
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(relativePath) {
  const absolute = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
  if (!existsSync(absolute)) throw new Error(`${relativePath} is missing.`);
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function readJsonFromEvidence(path) {
  const absolute = isAbsolute(path) ? path : resolve(evidenceRoot, path);
  if (!existsSync(absolute)) throw new Error(`${path} is missing.`);
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--evidence") parsed.evidence = argv[++index];
  }
  return parsed;
}
