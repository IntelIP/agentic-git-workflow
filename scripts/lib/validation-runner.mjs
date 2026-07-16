import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { LedgerConflictError } from "./git-json-ledger.mjs";
import { runGit } from "./git-process.mjs";
import { digestObject } from "./stack-operation.mjs";

const VALIDATION_MANIFEST_SCHEMA_VERSION_V1 = "tabellio-validation/v0.1";
const VALIDATION_MANIFEST_SCHEMA_VERSION_V2 = "tabellio-validation/v0.2";
const VALIDATION_RESULT_SCHEMA_VERSION_V1 = "tabellio-validation-result/v0.1";
const VALIDATION_RESULT_SCHEMA_VERSION_V2 = "tabellio-validation-result/v0.2";
const VALIDATION_RESULT_SCHEMA_VERSION_V3 = "tabellio-validation-result/v0.3";
const VALIDATOR_EVIDENCE_SCHEMA_VERSION = "tabellio-validator-evidence/v0.1";
const VALIDATOR_TYPES = ["static", "schema", "semantic", "workflow", "visual", "operational", "security"];
const MAX_OUTPUT_TAIL_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

export class ValidationRunner {
  constructor({ store, ledger }) {
    this.store = store;
    this.ledger = ledger;
  }

  async run({
    repositoryId,
    commit,
    base,
    checkpointHead = null,
    checkpointBase = null,
    manifestPath = "tabellio.validation.json",
    runnerId = "local",
    now = new Date(),
  }) {
    requiredString(repositoryId, "repositoryId");
    requiredString(runnerId, "runnerId");
    validateRelativePath(manifestPath, "manifestPath");
    if ((checkpointHead === null) !== (checkpointBase === null)) throw new Error("checkpointHead and checkpointBase must be supplied together.");
    const revision = await resolveRevision(this.store, base, commit);
    const checkpointRevision = checkpointHead === null
      ? revision
      : await resolveRevision(this.store, checkpointBase, checkpointHead);
    const manifestSource = await runGit({
      args: ["show", `${revision.headCommit}:${manifestPath}`],
      cwd: this.store.repoPath,
    });
    const manifest = JSON.parse(manifestSource.stdout);
    validateValidationManifest(manifest);
    const checkpoints = await checkpointIds(this.store.repoPath, checkpointRevision.mergeBase, checkpointRevision.headCommit);
    if (manifest.requireEntireCheckpoint && checkpoints.length === 0) {
      throw new Error(`Checkpoint range ${checkpointRevision.mergeBase}..${checkpointRevision.headCommit} has no Entire checkpoint.`);
    }

    const runId = `validation-${randomUUID()}`;
    const common = await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: this.store.repoPath });
    const workspaceRoot = resolve(this.store.repoPath, common.stdout.trim(), "tabellio", "validation-workspaces");
    const workspace = resolve(workspaceRoot, runId);
    const home = resolve(workspaceRoot, `${runId}.home`);
    await mkdir(workspaceRoot, { recursive: true });
    if (await stat(workspace).catch(() => null)) throw new Error(`Validation workspace already exists: ${workspace}.`);
    const startedAt = now.toISOString();
    const definitions = manifest.schemaVersion === VALIDATION_MANIFEST_SCHEMA_VERSION_V1
      ? manifest.commands
      : manifest.validators;
    let execution = null;
    try {
      await runGit({ args: ["worktree", "add", "--detach", workspace, revision.headCommit], cwd: this.store.repoPath });
      await mkdir(resolve(home, "tmp"), { recursive: true });
      execution = await runValidationDefinitions({ manifest, definitions, workspace, home });
    } finally {
      await runGit({
        args: ["worktree", "remove", "--force", workspace],
        cwd: this.store.repoPath,
        acceptableExitCodes: [0, 128],
      }).catch(() => {});
      await removeGeneratedTree(workspace);
      await removeGeneratedTree(home);
    }
    const completedAt = new Date().toISOString();
    const result = buildValidationResult({
      manifest,
      definitions,
      execution,
      runId,
      repositoryId,
      revision,
      checkpointRevision,
      manifestPath,
      runnerId,
      checkpoints,
      startedAt,
      completedAt,
    });
    result.integrity.digest = validationResultDigest(result);
    validateValidationResult(result);
    const path = validationPath(revision.headCommit, runId);
    const written = await writeResultWithRetry(this.ledger, path, result);
    return { result, path, version: written.version };
  }
}

async function removeGeneratedTree(path) {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!error || !["EACCES", "EPERM"].includes(error.code)) throw error;
    await makeTreeOwnerWritable(path);
    await rm(path, { recursive: true, force: true });
  }
}

async function makeTreeOwnerWritable(path) {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await chmod(path, info.mode | 0o600);
    return;
  }
  await chmod(path, info.mode | 0o700);
  for (const entry of await readdir(path)) {
    await makeTreeOwnerWritable(resolve(path, entry));
  }
}

async function runValidationDefinitions({ manifest, definitions, workspace, home }) {
  const typed = manifest.schemaVersion === VALIDATION_MANIFEST_SCHEMA_VERSION_V2;
  const commands = [];
  const validators = [];
  let stopped = false;
  for (const definition of definitions) {
    if (stopped) {
      commands.push(skippedCommand(definition));
      if (typed) validators.push(skippedValidator(definition));
      continue;
    }
    const commandResult = await runValidationCommand(definition, workspace, home);
    commands.push(commandResult);
    const gateStatus = typed
      ? await appendValidatorResult(validators, definition, commandResult, workspace)
      : commandResult.status;
    stopped = manifest.failFast && definition.required && gateStatus !== "passed";
  }
  return { commands, validators };
}

async function appendValidatorResult(validators, definition, commandResult, workspace) {
  const result = await evaluateValidator(definition, commandResult, workspace);
  validators.push(result);
  return result.status;
}

function buildValidationResult({
  manifest,
  definitions,
  execution,
  runId,
  repositoryId,
  revision,
  checkpointRevision,
  manifestPath,
  runnerId,
  checkpoints,
  startedAt,
  completedAt,
}) {
  const typed = manifest.schemaVersion === VALIDATION_MANIFEST_SCHEMA_VERSION_V2;
  const decision = typed ? validationDecision(execution.validators) : null;
  const requiredFailed = execution.commands.some((command, index) => definitions[index].required && command.status !== "passed");
  const result = {
    schemaVersion: typed ? VALIDATION_RESULT_SCHEMA_VERSION_V3 : VALIDATION_RESULT_SCHEMA_VERSION_V2,
    runId,
    repository: { id: repositoryId },
    revision,
    checkpointRevision,
    suite: {
      id: manifest.id,
      manifestPath,
      manifestDigest: digestObject(manifest),
    },
    runner: { id: runnerId, runtime: `node-${process.version}` },
    status: decision?.status ?? (requiredFailed ? "failed" : "passed"),
    checkpoints,
    commands: execution.commands,
    startedAt,
    completedAt,
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
  };
  if (!typed) return result;
  result.acceptance = acceptanceResult(manifest.acceptance);
  result.validators = execution.validators;
  result.decision = decision;
  return result;
}

function acceptanceResult(acceptance) {
  return {
    id: acceptance.id,
    source: acceptance.source,
    risk: acceptance.risk,
    digest: digestObject(acceptance),
    requiredValidatorTypes: [...acceptance.requiredValidatorTypes],
  };
}

export async function latestValidationResult(ledger, commit, repositoryId = null) {
  oid(commit, "commit");
  if (repositoryId !== null) requiredString(repositoryId, "repositoryId");
  const prefix = `commits/${commit}`;
  const listed = await ledger.list(prefix);
  let latest = null;
  for (const path of listed.paths) {
    const record = await ledger.read(path);
    if (!record.value) continue;
    validateValidationResult(record.value);
    if (record.value.revision.headCommit !== commit) throw new Error(`Validation result ${path} is stored under the wrong commit.`);
    if (repositoryId !== null && record.value.repository.id !== repositoryId) continue;
    if (!latest || Date.parse(record.value.completedAt) > Date.parse(latest.completedAt)) latest = record.value;
  }
  return latest;
}

export function validateValidationManifest(value) {
  object(value, "validation manifest");
  member(
    value.schemaVersion,
    [VALIDATION_MANIFEST_SCHEMA_VERSION_V1, VALIDATION_MANIFEST_SCHEMA_VERSION_V2],
    "validation manifest.schemaVersion",
  );
  requiredString(value.id, "validation manifest.id");
  boolean(value.failFast, "validation manifest.failFast");
  boolean(value.requireEntireCheckpoint, "validation manifest.requireEntireCheckpoint");
  if (value.schemaVersion === VALIDATION_MANIFEST_SCHEMA_VERSION_V2) {
    exactKeys(
      value,
      ["schemaVersion", "id", "failFast", "requireEntireCheckpoint", "acceptance", "validators"],
      "validation manifest",
    );
    validateAcceptanceContract(value.acceptance);
    validateValidators(value.validators, value.acceptance.requiredValidatorTypes);
    return value;
  }
  exactKeys(value, ["schemaVersion", "id", "failFast", "requireEntireCheckpoint", "commands"], "validation manifest");
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 50) {
    throw new Error("validation manifest.commands must contain 1 to 50 commands.");
  }
  const ids = new Set();
  for (const [index, command] of value.commands.entries()) {
    const path = `validation manifest.commands[${index}]`;
    object(command, path);
    exactKeys(command, ["id", "argv", "cwd", "timeoutMs", "required"], path);
    requiredString(command.id, `${path}.id`);
    if (ids.has(command.id)) throw new Error(`validation manifest.commands contains duplicate id ${command.id}.`);
    ids.add(command.id);
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.length > 100) throw new Error(`${path}.argv must contain 1 to 100 arguments.`);
    command.argv.forEach((argument, argumentIndex) => requiredString(argument, `${path}.argv[${argumentIndex}]`));
    validateRelativePath(command.cwd, `${path}.cwd`, { allowDot: true });
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 60 * 60 * 1000) {
      throw new Error(`${path}.timeoutMs must be between 100 and 3600000.`);
    }
    boolean(command.required, `${path}.required`);
  }
  return value;
}

export function validateValidationResult(value) {
  object(value, "validation result");
  member(
    value.schemaVersion,
    [VALIDATION_RESULT_SCHEMA_VERSION_V1, VALIDATION_RESULT_SCHEMA_VERSION_V2, VALIDATION_RESULT_SCHEMA_VERSION_V3],
    "validation result.schemaVersion",
  );
  exactKeys(value, validationResultKeys(value.schemaVersion), "validation result");
  requiredString(value.runId, "validation result.runId");
  object(value.repository, "validation result.repository");
  exactKeys(value.repository, ["id"], "validation result.repository");
  requiredString(value.repository.id, "validation result.repository.id");
  validateRevision(value.revision, "validation result.revision");
  validateCheckpointRevision(value);
  object(value.suite, "validation result.suite");
  exactKeys(value.suite, ["id", "manifestPath", "manifestDigest"], "validation result.suite");
  requiredString(value.suite.id, "validation result.suite.id");
  validateRelativePath(value.suite.manifestPath, "validation result.suite.manifestPath");
  sha256(value.suite.manifestDigest, "validation result.suite.manifestDigest");
  object(value.runner, "validation result.runner");
  exactKeys(value.runner, ["id", "runtime"], "validation result.runner");
  requiredString(value.runner.id, "validation result.runner.id");
  requiredString(value.runner.runtime, "validation result.runner.runtime");
  member(
    value.status,
    value.schemaVersion === VALIDATION_RESULT_SCHEMA_VERSION_V3 ? ["passed", "failed", "blocked"] : ["passed", "failed"],
    "validation result.status",
  );
  stringArray(value.checkpoints, "validation result.checkpoints");
  if (!Array.isArray(value.commands) || value.commands.length === 0) throw new Error("validation result.commands must be a non-empty array.");
  value.commands.forEach((command, index) => validateCommandResult(command, `validation result.commands[${index}]`));
  date(value.startedAt, "validation result.startedAt");
  date(value.completedAt, "validation result.completedAt");
  object(value.integrity, "validation result.integrity");
  exactKeys(value.integrity, ["algorithm", "digest"], "validation result.integrity");
  equals(value.integrity.algorithm, "sha256", "validation result.integrity.algorithm");
  sha256(value.integrity.digest, "validation result.integrity.digest");
  if (validationResultDigest(value) !== value.integrity.digest) throw new Error("validation result integrity digest does not match.");
  if (value.schemaVersion === VALIDATION_RESULT_SCHEMA_VERSION_V3) {
    validateAcceptanceResult(value.acceptance);
    if (!Array.isArray(value.validators) || value.validators.length === 0) {
      throw new Error("validation result.validators must be a non-empty array.");
    }
    value.validators.forEach((validator, index) => validateValidatorResult(validator, `validation result.validators[${index}]`));
    const commandIds = value.commands.map((command) => command.id);
    const validatorIds = value.validators.map((validator) => validator.id);
    if (JSON.stringify(commandIds) !== JSON.stringify(validatorIds)) {
      throw new Error("validation result validators must align with command ids and order.");
    }
    validateValidationDecision(value.decision, value.validators);
    if (value.status !== value.decision.status) throw new Error("validation result status does not match decision status.");
    return value;
  }
  const expectedStatus = value.commands.some((command) => command.required && command.status !== "passed") ? "failed" : "passed";
  if (value.status !== expectedStatus) throw new Error("validation result status does not match required command results.");
  return value;
}

function validationResultKeys(schemaVersion) {
  const keys = ["schemaVersion", "runId", "repository", "revision", "suite", "runner", "status", "checkpoints", "commands", "startedAt", "completedAt", "integrity"];
  if (schemaVersion === VALIDATION_RESULT_SCHEMA_VERSION_V3) {
    return [...keys, "checkpointRevision", "acceptance", "validators", "decision"];
  }
  return schemaVersion === VALIDATION_RESULT_SCHEMA_VERSION_V2 ? [...keys, "checkpointRevision"] : keys;
}

function validateCheckpointRevision(value) {
  if ([VALIDATION_RESULT_SCHEMA_VERSION_V2, VALIDATION_RESULT_SCHEMA_VERSION_V3].includes(value.schemaVersion)) {
    validateRevision(value.checkpointRevision, "validation result.checkpointRevision");
  }
}

function validateRevision(value, path) {
  object(value, path);
  exactKeys(value, ["baseCommit", "mergeBase", "headCommit"], path);
  oid(value.baseCommit, `${path}.baseCommit`);
  oid(value.mergeBase, `${path}.mergeBase`);
  oid(value.headCommit, `${path}.headCommit`);
}

function validateAcceptanceContract(value) {
  object(value, "validation manifest.acceptance");
  exactKeys(
    value,
    ["id", "source", "risk", "outcomes", "invariants", "forbiddenOutcomes", "requiredValidatorTypes"],
    "validation manifest.acceptance",
  );
  requiredString(value.id, "validation manifest.acceptance.id");
  requiredString(value.source, "validation manifest.acceptance.source");
  member(value.risk, ["low", "medium", "high", "critical"], "validation manifest.acceptance.risk");
  boundedUniqueStrings(value.outcomes, "validation manifest.acceptance.outcomes", { minimum: 1, maximum: 50 });
  boundedUniqueStrings(value.invariants, "validation manifest.acceptance.invariants", { minimum: 0, maximum: 50 });
  boundedUniqueStrings(value.forbiddenOutcomes, "validation manifest.acceptance.forbiddenOutcomes", { minimum: 0, maximum: 50 });
  enumArray(
    value.requiredValidatorTypes,
    VALIDATOR_TYPES,
    "validation manifest.acceptance.requiredValidatorTypes",
    { minimum: 1, maximum: VALIDATOR_TYPES.length },
  );
}

function validateValidators(value, requiredTypes) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("validation manifest.validators must contain 1 to 50 validators.");
  }
  const ids = new Set();
  for (const [index, validator] of value.entries()) {
    validateValidatorDefinition(validator, index);
    if (ids.has(validator.id)) throw new Error(`validation manifest.validators contains duplicate id ${validator.id}.`);
    ids.add(validator.id);
  }
  for (const type of requiredTypes) {
    if (!value.some((validator) => validator.type === type && validator.required)) {
      throw new Error(`validation manifest requires a required ${type} validator.`);
    }
  }
}

function validateValidatorDefinition(validator, index) {
  const path = `validation manifest.validators[${index}]`;
  object(validator, path);
  exactKeys(validator, ["id", "type", "argv", "cwd", "timeoutMs", "required", "evidence", "policy"], path);
  requiredString(validator.id, `${path}.id`);
  member(validator.type, VALIDATOR_TYPES, `${path}.type`);
  validateValidatorCommand(validator, path);
  validateValidatorEvidenceDeclaration(validator, path);
  validateValidatorPolicy(validator.policy, `${path}.policy`, validator.evidence !== null);
}

function validateValidatorCommand(validator, path) {
  if (!Array.isArray(validator.argv) || validator.argv.length === 0 || validator.argv.length > 100) {
    throw new Error(`${path}.argv must contain 1 to 100 arguments.`);
  }
  validator.argv.forEach((argument, argumentIndex) => requiredString(argument, `${path}.argv[${argumentIndex}]`));
  validateRelativePath(validator.cwd, `${path}.cwd`, { allowDot: true });
  if (!Number.isInteger(validator.timeoutMs) || validator.timeoutMs < 100 || validator.timeoutMs > 60 * 60 * 1000) {
    throw new Error(`${path}.timeoutMs must be between 100 and 3600000.`);
  }
  boolean(validator.required, `${path}.required`);
}

function validateValidatorEvidenceDeclaration(validator, path) {
  if (validator.evidence === null) {
    if (validator.type !== "static") throw new Error(`${path}.evidence is required for ${validator.type} validators.`);
    return;
  }
  object(validator.evidence, `${path}.evidence`);
  exactKeys(validator.evidence, ["path"], `${path}.evidence`);
  validateRelativePath(validator.evidence.path, `${path}.evidence.path`);
}

function validateValidatorPolicy(value, path, hasEvidence) {
  object(value, path);
  exactKeys(value, ["metricThresholds", "maxCostUsd", "requireCostTelemetry"], path);
  validateMetricThresholds(value.metricThresholds, `${path}.metricThresholds`);
  validateCostPolicy(value, path);
  if ((value.metricThresholds.length > 0 || value.requireCostTelemetry || value.maxCostUsd !== null) && !hasEvidence) {
    throw new Error(`${path} requires an evidence report.`);
  }
}

function validateMetricThresholds(value, path) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${path} must contain at most 100 thresholds.`);
  const metrics = new Set();
  for (const [index, threshold] of value.entries()) {
    const thresholdPath = `${path}[${index}]`;
    object(threshold, thresholdPath);
    exactKeys(threshold, ["metric", "operator", "value"], thresholdPath);
    requiredString(threshold.metric, `${thresholdPath}.metric`);
    if (metrics.has(threshold.metric)) throw new Error(`${path} contains duplicate metric ${threshold.metric}.`);
    metrics.add(threshold.metric);
    member(threshold.operator, ["gte", "lte", "eq"], `${thresholdPath}.operator`);
    finiteNumber(threshold.value, `${thresholdPath}.value`);
  }
}

function validateCostPolicy(value, path) {
  if (value.maxCostUsd !== null) nonNegativeNumber(value.maxCostUsd, `${path}.maxCostUsd`);
  boolean(value.requireCostTelemetry, `${path}.requireCostTelemetry`);
  if (value.maxCostUsd !== null && value.requireCostTelemetry !== true) {
    throw new Error(`${path}.requireCostTelemetry must be true when maxCostUsd is set.`);
  }
}

export function validateValidatorEvidence(value) {
  object(value, "validator evidence");
  exactKeys(value, ["schemaVersion", "validatorId", "status", "summary", "metrics", "cost", "artifacts"], "validator evidence");
  equals(value.schemaVersion, VALIDATOR_EVIDENCE_SCHEMA_VERSION, "validator evidence.schemaVersion");
  requiredString(value.validatorId, "validator evidence.validatorId");
  member(value.status, ["passed", "failed", "blocked"], "validator evidence.status");
  requiredString(value.summary, "validator evidence.summary");
  maxLength(value.summary, 2_000, "validator evidence.summary");
  validateEvidenceMetrics(value.metrics);
  validateEvidenceCost(value.cost);
  validateEvidenceArtifacts(value.artifacts);
  return value;
}

function validateEvidenceMetrics(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("validator evidence.metrics must contain at most 100 metrics.");
  const metricNames = new Set();
  for (const [index, metric] of value.entries()) {
    const path = `validator evidence.metrics[${index}]`;
    object(metric, path);
    exactKeys(metric, ["name", "value", "unit"], path);
    requiredString(metric.name, `${path}.name`);
    if (metricNames.has(metric.name)) throw new Error(`validator evidence.metrics contains duplicate name ${metric.name}.`);
    metricNames.add(metric.name);
    finiteNumber(metric.value, `${path}.value`);
    requiredString(metric.unit, `${path}.unit`);
  }
}

function validateEvidenceArtifacts(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error("validator evidence.artifacts must contain at most 50 artifacts.");
  for (const [index, artifact] of value.entries()) validateEvidenceArtifact(artifact, `validator evidence.artifacts[${index}]`);
}

function validateEvidenceCost(value) {
  object(value, "validator evidence.cost");
  exactKeys(value, ["telemetry", "usd", "modelCalls", "toolCalls"], "validator evidence.cost");
  member(value.telemetry, ["available", "unavailable", "not_applicable"], "validator evidence.cost.telemetry");
  if (value.telemetry === "available") {
    nonNegativeNumber(value.usd, "validator evidence.cost.usd");
    nonNegativeInteger(value.modelCalls, "validator evidence.cost.modelCalls");
    nonNegativeInteger(value.toolCalls, "validator evidence.cost.toolCalls");
  } else if (value.usd !== null || value.modelCalls !== null || value.toolCalls !== null) {
    throw new Error("validator evidence cost values must be null when telemetry is unavailable or not applicable.");
  }
}

function validateEvidenceArtifact(value, path) {
  object(value, path);
  exactKeys(value, ["name", "uri", "digest", "mediaType", "bytes"], path);
  requiredString(value.name, `${path}.name`);
  durableUri(value.uri, `${path}.uri`);
  sha256(value.digest, `${path}.digest`);
  requiredString(value.mediaType, `${path}.mediaType`);
  nonNegativeInteger(value.bytes, `${path}.bytes`);
}

function validateAcceptanceResult(value) {
  object(value, "validation result.acceptance");
  exactKeys(value, ["id", "source", "risk", "digest", "requiredValidatorTypes"], "validation result.acceptance");
  requiredString(value.id, "validation result.acceptance.id");
  requiredString(value.source, "validation result.acceptance.source");
  member(value.risk, ["low", "medium", "high", "critical"], "validation result.acceptance.risk");
  sha256(value.digest, "validation result.acceptance.digest");
  enumArray(
    value.requiredValidatorTypes,
    VALIDATOR_TYPES,
    "validation result.acceptance.requiredValidatorTypes",
    { minimum: 1, maximum: VALIDATOR_TYPES.length },
  );
}

function validateValidatorResult(value, path) {
  object(value, path);
  exactKeys(value, ["id", "type", "required", "status", "evidence", "reasons"], path);
  requiredString(value.id, `${path}.id`);
  member(value.type, VALIDATOR_TYPES, `${path}.type`);
  boolean(value.required, `${path}.required`);
  member(value.status, ["passed", "failed", "blocked", "skipped"], `${path}.status`);
  boundedUniqueStrings(value.reasons, `${path}.reasons`, { minimum: 0, maximum: 128 });
  if (value.evidence === null) return;
  object(value.evidence, `${path}.evidence`);
  exactKeys(value.evidence, ["path", "digest", "report"], `${path}.evidence`);
  validateRelativePath(value.evidence.path, `${path}.evidence.path`);
  sha256(value.evidence.digest, `${path}.evidence.digest`);
  validateValidatorEvidence(value.evidence.report);
  if (digestObject(value.evidence.report) !== value.evidence.digest) throw new Error(`${path}.evidence digest does not match report.`);
  if (value.evidence.report.validatorId !== value.id) throw new Error(`${path}.evidence validator id does not match.`);
}

function validateValidationDecision(value, validators) {
  object(value, "validation result.decision");
  exactKeys(value, ["status", "reasons", "totalCostUsd", "costTelemetryComplete"], "validation result.decision");
  member(value.status, ["passed", "failed", "blocked"], "validation result.decision.status");
  boundedUniqueStrings(value.reasons, "validation result.decision.reasons", { minimum: 0, maximum: 6_400 });
  nonNegativeNumber(value.totalCostUsd, "validation result.decision.totalCostUsd");
  boolean(value.costTelemetryComplete, "validation result.decision.costTelemetryComplete");
  const expected = validationDecision(validators);
  if (
    value.status !== expected.status
    || JSON.stringify(value.reasons) !== JSON.stringify(expected.reasons)
    || value.totalCostUsd !== expected.totalCostUsd
    || value.costTelemetryComplete !== expected.costTelemetryComplete
  ) {
    throw new Error("validation result decision does not match validator results.");
  }
}

async function runValidationCommand(command, workspace, home) {
  const cwd = resolveWorkspacePath(workspace, command.cwd, `Command ${command.id} cwd`);
  const startedAt = new Date();
  const execution = await spawnCaptured(command.argv, {
    cwd,
    timeoutMs: command.timeoutMs,
    home,
  });
  const completedAt = new Date();
  return {
    id: command.id,
    argv: [...command.argv],
    cwd: command.cwd,
    required: command.required,
    status: execution.timedOut ? "timed_out" : execution.spawnError ? "error" : execution.exitCode === 0 ? "passed" : "failed",
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    stdout: execution.stdout,
    stderr: execution.stderr,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    error: execution.spawnError,
  };
}

async function evaluateValidator(validator, commandResult, workspace) {
  const base = validatorResultBase(validator);
  const commandGate = validatorCommandGate(validator, commandResult.status);
  if (commandGate) return { ...base, ...commandGate };
  if (validator.evidence === null) return base;

  let evidence;
  try {
    evidence = await loadValidatorEvidence(workspace, validator.evidence.path, validator.id);
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      reasons: blockedReasons(validator, `evidence_invalid:${boundedReason(error instanceof Error ? error.message : String(error))}`),
    };
  }
  const evaluation = evaluateEvidencePolicy(validator, evidence.report);
  return { ...base, ...evaluation, evidence };
}

function validatorResultBase(validator) {
  return {
    id: validator.id,
    type: validator.type,
    required: validator.required,
    status: "passed",
    evidence: null,
    reasons: [],
  };
}

function validatorCommandGate(validator, status) {
  if (status === "timed_out") return { status: "blocked", reasons: blockedReasons(validator, "command_timed_out") };
  if (status === "error") return { status: "blocked", reasons: blockedReasons(validator, "command_error") };
  if (status === "skipped") return { status: "skipped", reasons: ["fail_fast"] };
  if (status !== "failed") return null;
  return validator.evidence === null
    ? { status: "failed", reasons: ["command_failed"] }
    : { status: "blocked", reasons: blockedReasons(validator, "validator_command_failed") };
}

function evaluateEvidencePolicy(validator, report) {
  const evaluations = [
    reportedEvidenceStatus(report.status),
    evaluateMetricPolicy(report.metrics, validator.policy.metricThresholds),
    evaluateCostPolicy(report.cost, validator.policy),
  ];
  const status = aggregateStatus(evaluations.map((evaluation) => evaluation.status));
  const reasons = [...new Set(evaluations.flatMap((evaluation) => evaluation.reasons))].sort();
  return { status, reasons };
}

function reportedEvidenceStatus(status) {
  if (status === "failed") return { status, reasons: ["evidence_reported_failed"] };
  if (status === "blocked") return { status, reasons: ["evidence_reported_blocked"] };
  return { status: "passed", reasons: [] };
}

function evaluateMetricPolicy(metrics, thresholds) {
  const evaluations = thresholds.map((threshold) => evaluateMetricThreshold(metrics, threshold));
  const status = aggregateStatus(evaluations.map((evaluation) => evaluation.status));
  return { status, reasons: evaluations.flatMap((evaluation) => evaluation.reasons) };
}

function evaluateMetricThreshold(metrics, threshold) {
  const metric = metrics.find((candidate) => candidate.name === threshold.metric);
  if (!metric) return { status: "blocked", reasons: [`metric_missing:${threshold.metric}`] };
  if (thresholdPassed(metric.value, threshold.operator, threshold.value)) return { status: "passed", reasons: [] };
  return {
    status: "failed",
    reasons: [`threshold_not_met:${threshold.metric}:${threshold.operator}:${threshold.value}`],
  };
}

function evaluateCostPolicy(cost, policy) {
  if (policy.requireCostTelemetry && cost.telemetry !== "available") {
    return { status: "blocked", reasons: ["cost_telemetry_unavailable"] };
  }
  if (policy.maxCostUsd !== null && cost.telemetry === "available" && cost.usd > policy.maxCostUsd) {
    return { status: "failed", reasons: [`cost_budget_exceeded:${policy.maxCostUsd}`] };
  }
  return { status: "passed", reasons: [] };
}

async function loadValidatorEvidence(workspace, evidencePath, validatorId) {
  const path = resolveWorkspacePath(workspace, evidencePath, `Validator ${validatorId} evidence`);
  const metadata = await stat(path).catch(() => {
    throw new Error("file is missing or unreadable");
  });
  if (!metadata.isFile()) throw new Error("must be a regular file");
  if (metadata.size > MAX_EVIDENCE_BYTES) throw new Error(`exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  const source = await readFile(path).catch(() => {
    throw new Error("file is unreadable");
  });
  let report;
  try {
    report = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("is not valid JSON");
  }
  validateValidatorEvidence(report);
  if (report.validatorId !== validatorId) throw new Error(`validatorId must be ${validatorId}`);
  return {
    path: evidencePath,
    digest: digestObject(report),
    report,
  };
}

function thresholdPassed(actual, operator, expected) {
  if (operator === "gte") return actual >= expected;
  if (operator === "lte") return actual <= expected;
  return actual === expected;
}

function blockedReasons(validator, reason) {
  const reasons = [reason];
  if (validator.policy.requireCostTelemetry) reasons.push("cost_telemetry_unavailable");
  return [...new Set(reasons)].sort();
}

function validationDecision(validators) {
  const required = validators.filter((validator) => validator.required);
  const status = aggregateStatus(required.map((validator) => validator.status));
  const reasons = [...new Set(required.flatMap((validator) => validator.reasons.map((reason) => `${validator.id}:${reason}`)))].sort();
  const totalCostUsd = Math.round(validators.reduce((total, validator) => {
    const cost = validator.evidence?.report.cost;
    return total + (cost?.telemetry === "available" ? cost.usd : 0);
  }, 0) * 100_000_000) / 100_000_000;
  const costTelemetryComplete = !required.some((validator) => validator.reasons.includes("cost_telemetry_unavailable"));
  return { status, reasons, totalCostUsd, costTelemetryComplete };
}

function aggregateStatus(statuses) {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.some((status) => status !== "passed")) return "failed";
  return "passed";
}

function skippedValidator(validator) {
  return {
    id: validator.id,
    type: validator.type,
    required: validator.required,
    status: "skipped",
    evidence: null,
    reasons: validator.policy.requireCostTelemetry ? ["cost_telemetry_unavailable", "fail_fast"] : ["fail_fast"],
  };
}

function skippedCommand(command) {
  return {
    id: command.id,
    argv: [...command.argv],
    cwd: command.cwd,
    required: command.required,
    status: "skipped",
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

function spawnCaptured(argv, { cwd, timeoutMs, home }) {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: validationEnvironment(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = outputAccumulator();
    const stderr = outputAccumulator();
    let spawnError = null;
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    child.stdout?.on("data", stdout.add);
    child.stderr?.on("data", stderr.add);
    child.once("error", (error) => { spawnError = error.message; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal ?? null,
        timedOut,
        spawnError,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      });
    });
  });
}

function outputAccumulator() {
  const hash = createHash("sha256");
  let bytes = 0;
  let tail = Buffer.alloc(0);
  return {
    add(chunk) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      tail = Buffer.concat([tail, buffer]).subarray(-MAX_OUTPUT_TAIL_BYTES);
    },
    finish() {
      return {
        bytes,
        digest: hash.digest("hex"),
        tail: tail.toString("utf8"),
        truncated: bytes > MAX_OUTPUT_TAIL_BYTES,
      };
    },
  };
}

function emptyOutput() {
  return { bytes: 0, digest: createHash("sha256").update("").digest("hex"), tail: "", truncated: false };
}

async function resolveRevision(store, base, head) {
  const [baseCommit, headCommit] = await Promise.all([
    store.resolveRef(base),
    store.resolveRef(head),
  ]);
  const mergeBase = (await runGit({
    args: ["merge-base", baseCommit, headCommit],
    cwd: store.repoPath,
  })).stdout.trim();
  return { baseCommit, mergeBase, headCommit };
}

async function checkpointIds(cwd, baseCommit, headCommit) {
  const result = await runGit({
    args: ["log", "--format=%(trailers:key=Entire-Checkpoint,valueonly)", "--no-merges", `${baseCommit}..${headCommit}`],
    cwd,
  });
  return [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].sort();
}

async function writeResultWithRetry(ledger, path, result) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await ledger.read(path);
    if (current.value !== null) throw new Error(`Validation result already exists: ${path}.`);
    try {
      return await ledger.write(path, result, { expectedVersion: current.version });
    } catch (error) {
      if (!(error instanceof LedgerConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error("Unable to write validation result after concurrent updates.");
}

function validationPath(commit, runId) {
  return `commits/${commit}/${runId}.json`;
}

function validationResultDigest(value) {
  const { integrity: _integrity, ...unsigned } = value;
  return digestObject(unsigned);
}

function validationEnvironment(home) {
  const allowed = ["PATH", "LANG", "LC_ALL", "TERM"];
  const env = Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, HOME: home, TMPDIR: resolve(home, "tmp"), CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
}

function validateCommandResult(value, path) {
  object(value, path);
  exactKeys(value, ["id", "argv", "cwd", "required", "status", "exitCode", "signal", "durationMs", "stdout", "stderr", "startedAt", "completedAt", "error"], path);
  requiredString(value.id, `${path}.id`);
  if (!Array.isArray(value.argv) || value.argv.length === 0) throw new Error(`${path}.argv must be non-empty.`);
  value.argv.forEach((argument, index) => requiredString(argument, `${path}.argv[${index}]`));
  validateRelativePath(value.cwd, `${path}.cwd`, { allowDot: true });
  boolean(value.required, `${path}.required`);
  member(value.status, ["passed", "failed", "error", "timed_out", "skipped"], `${path}.status`);
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) throw new Error(`${path}.exitCode must be an integer or null.`);
  if (value.signal !== null) requiredString(value.signal, `${path}.signal`);
  if (!Number.isInteger(value.durationMs) || value.durationMs < 0) throw new Error(`${path}.durationMs must be a non-negative integer.`);
  validateOutput(value.stdout, `${path}.stdout`);
  validateOutput(value.stderr, `${path}.stderr`);
  if (value.startedAt !== null) date(value.startedAt, `${path}.startedAt`);
  if (value.completedAt !== null) date(value.completedAt, `${path}.completedAt`);
  if (value.error !== null) requiredString(value.error, `${path}.error`);
  if (value.status === "skipped" && (value.startedAt !== null || value.completedAt !== null)) throw new Error(`${path} skipped timestamps must be null.`);
}

function validateOutput(value, path) {
  object(value, path);
  exactKeys(value, ["bytes", "digest", "tail", "truncated"], path);
  if (!Number.isInteger(value.bytes) || value.bytes < 0) throw new Error(`${path}.bytes must be a non-negative integer.`);
  sha256(value.digest, `${path}.digest`);
  if (typeof value.tail !== "string") throw new Error(`${path}.tail must be a string.`);
  boolean(value.truncated, `${path}.truncated`);
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value === "" || /[\0\r\n]/.test(value)) throw new Error(`${path} must be a non-empty single-line string.`);
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
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

function sha256(value, path) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${path} must be a SHA-256 digest.`);
}

function date(value, path) {
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${path} must be an ISO date-time.`);
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new Error(`${path} must be an array of non-empty strings.`);
  if (new Set(value).size !== value.length) throw new Error(`${path} must contain unique values.`);
}

function boundedUniqueStrings(value, path, { minimum, maximum }) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${path} must contain ${minimum} to ${maximum} values.`);
  }
  value.forEach((item, index) => {
    requiredString(item, `${path}[${index}]`);
    maxLength(item, 2_000, `${path}[${index}]`);
  });
  if (new Set(value).size !== value.length) throw new Error(`${path} must contain unique values.`);
}

function enumArray(value, allowed, path, { minimum, maximum }) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${path} must contain ${minimum} to ${maximum} values.`);
  }
  value.forEach((item, index) => member(item, allowed, `${path}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${path} must contain unique values.`);
}

function nonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer.`);
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
}

function nonNegativeNumber(value, path) {
  finiteNumber(value, path);
  if (value < 0) throw new Error(`${path} must be non-negative.`);
}

function maxLength(value, maximum, path) {
  if (typeof value === "string" && value.length > maximum) throw new Error(`${path} must contain at most ${maximum} characters.`);
}

function durableUri(value, path) {
  requiredString(value, path);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${path} must be an absolute URI.`);
  }
  if (parsed.protocol === "file:") throw new Error(`${path} must not use an ephemeral file URI.`);
}

function boundedReason(value) {
  return value.replace(/[\0\r\n]+/g, " ").slice(0, 500);
}

function resolveWorkspacePath(workspace, path, label) {
  const resolved = resolve(workspace, path);
  const relation = relative(workspace, resolved);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`${label} escapes validation workspace.`);
  return resolved;
}

function validateRelativePath(value, path, { allowDot = false } = {}) {
  requiredString(value, path);
  if ((allowDot && value === ".")) return;
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${path} must be a safe relative path.`);
  }
}
