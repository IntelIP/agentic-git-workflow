import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const evidencePath = args.evidence ?? "tabellio-pr-evidence.json";
const root = process.cwd();
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
  validateArtifacts(value.artifacts, localBlockers);
  validateExternalActionPolicy(value.externalActionPolicy, localBlockers, localWarnings);
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

function validateArtifacts(value, localBlockers) {
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
  });
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
    if (entry.approved !== true && entry.attempted === true) {
      localBlockers.push(`${path} attempted an external action without approval.`);
    }
    if (!Array.isArray(entry.expectedSideEffects)) {
      localBlockers.push(`${path}.expectedSideEffects must be an array.`);
    }
    if (!Array.isArray(entry.forbiddenSideEffects)) {
      localBlockers.push(`${path}.forbiddenSideEffects must be an array.`);
    }
    requiredString(entry.verificationCommand, `${path}.verificationCommand`, localBlockers);
  });

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

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--evidence") parsed.evidence = argv[++index];
  }
  return parsed;
}
