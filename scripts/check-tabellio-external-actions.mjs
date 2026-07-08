import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const evidencePath = args.evidence ?? "tabellio-pr-evidence.json";
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

let policy = null;
try {
  const source = readJson(evidencePath);
  policy = source.externalActionPolicy ?? source;
  validatePolicy(policy);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}

const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "external_action_policy_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  evidencePath,
  requiredActionClasses,
  actionClassCount: Array.isArray(policy?.actionClasses) ? policy.actionClasses.length : null,
  warnings,
  blockers,
};

if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));

function validatePolicy(value) {
  if (!isObject(value)) {
    blockers.push("externalActionPolicy must be an object.");
    return;
  }
  if (!["deny", "default-deny"].includes(value.defaultMode)) {
    blockers.push("externalActionPolicy.defaultMode must be deny or default-deny.");
  }
  if (!Array.isArray(value.actionClasses)) {
    blockers.push("externalActionPolicy.actionClasses must be an array.");
    return;
  }

  const byId = new Map();
  value.actionClasses.forEach((entry, index) => {
    const path = `externalActionPolicy.actionClasses[${index}]`;
    if (!isObject(entry)) {
      blockers.push(`${path} must be an object.`);
      return;
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      blockers.push(`${path}.id must be a non-empty string.`);
      return;
    }
    if (byId.has(entry.id)) blockers.push(`${path}.id duplicates ${entry.id}.`);
    byId.set(entry.id, entry);
    if (entry.requiresExplicitApproval !== true) {
      blockers.push(`${path}.requiresExplicitApproval must be true.`);
    }
    if (entry.attempted === true && entry.approved !== true) {
      blockers.push(`${entry.id} attempted without explicit approval.`);
    }
    if (!Array.isArray(entry.expectedSideEffects)) {
      blockers.push(`${path}.expectedSideEffects must be an array.`);
    }
    if (!Array.isArray(entry.forbiddenSideEffects) || entry.forbiddenSideEffects.length === 0) {
      blockers.push(`${path}.forbiddenSideEffects must be a non-empty array.`);
    }
    if (typeof entry.verificationCommand !== "string" || entry.verificationCommand.trim() === "") {
      blockers.push(`${path}.verificationCommand must be a non-empty string.`);
    }
    if (entry.approved === true && entry.attempted !== true) {
      warnings.push(`${entry.id} approved but not attempted.`);
    }
  });

  for (const actionClass of requiredActionClasses) {
    if (!byId.has(actionClass)) blockers.push(`missing required action class ${actionClass}.`);
  }
}

function readJson(relativePath) {
  const absolute = isAbsolute(relativePath) ? relativePath : join(process.cwd(), relativePath);
  if (!existsSync(absolute)) throw new Error(`${relativePath} is missing.`);
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--evidence") parsed.evidence = argv[++index];
  }
  return parsed;
}
