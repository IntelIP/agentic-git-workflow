#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  validateValidationManifest,
  validateValidationResult,
  validateValidatorEvidence,
} from "./lib/validation-runner.mjs";

const type = process.argv[2];
const path = process.argv[3];
const blockers = [];
let value = null;
try {
  if (!path || process.argv.length !== 4 || !["--manifest", "--result", "--evidence"].includes(type)) {
    throw new Error("Usage: check-tabellio-validation (--manifest|--result|--evidence) <path>.");
  }
  value = JSON.parse(await readFile(resolve(path), "utf8"));
  if (type === "--manifest") validateValidationManifest(value);
  else if (type === "--result") validateValidationResult(value);
  else validateValidatorEvidence(value);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}
const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "validation_contract_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  type: type === "--manifest" ? "manifest" : type === "--result" ? "result" : type === "--evidence" ? "evidence" : null,
  path,
  summary: value ? {
    schemaVersion: value.schemaVersion,
    id: value.id ?? value.runId ?? value.validatorId ?? null,
    commandCount: Array.isArray(value.commands) ? value.commands.length : null,
    validatorCount: Array.isArray(value.validators) ? value.validators.length : null,
    metricCount: Array.isArray(value.metrics) ? value.metrics.length : null,
  } : null,
  blockers,
};
if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));
