import assert from "node:assert/strict";
import { mkdir, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { GitJsonLedger } from "../scripts/lib/git-json-ledger.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { repositoryIdentity } from "../scripts/lib/repository-identity.mjs";
import {
  latestValidationResult,
  ValidationRunner,
  validateValidationManifest,
  validateValidationResult,
  validateValidatorEvidence,
} from "../scripts/lib/validation-runner.mjs";
import { NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFeatureFixture, identityEnv } from "./helpers/git-fixture.mjs";

test("validation runner executes exact committed manifests and stores bounded results", async (t) => {
  const previousArtifactBaseUri = process.env.TABELLIO_ARTIFACT_BASE_URI;
  const previousTestSecret = process.env.TABELLIO_TEST_SECRET;
  process.env.TABELLIO_ARTIFACT_BASE_URI = "artifact+test://validation/run/";
  process.env.TABELLIO_TEST_SECRET = "must-not-cross-boundary";
  t.after(() => {
    if (previousArtifactBaseUri === undefined) delete process.env.TABELLIO_ARTIFACT_BASE_URI;
    else process.env.TABELLIO_ARTIFACT_BASE_URI = previousArtifactBaseUri;
    if (previousTestSecret === undefined) delete process.env.TABELLIO_TEST_SECRET;
    else process.env.TABELLIO_TEST_SECRET = previousTestSecret;
  });
  const fixture = await createFeatureFixture(t);
  const manifestPath = `${fixture.seed}/tabellio.validation.json`;
  await writeFile(manifestPath, JSON.stringify(manifest([
    command("tests", [process.execPath, "-e", 'process.stdout.write("x".repeat(20000))']),
    command("isolated-home", [process.execPath, "-e", 'if (!process.env.HOME.includes("TabellioValidation-") || process.env.HOME.includes(".git")) process.exit(2);process.stdout.write(process.env.HOME)']),
    command("artifact-uri", [process.execPath, "-e", 'if (process.env.TABELLIO_ARTIFACT_BASE_URI !== "artifact+test://validation/run/") process.exit(2)']),
    command("secret-isolated", [process.execPath, "-e", 'if (process.env.TABELLIO_TEST_SECRET !== undefined) process.exit(2)']),
    command("readonly-cache", [process.execPath, "-e", 'const fs=require("node:fs");const p=process.env.HOME+"/go/pkg/mod/example/.github";fs.mkdirSync(p,{recursive:true});fs.chmodSync(p,0o500);fs.chmodSync(process.env.HOME+"/go/pkg/mod/example",0o500)']),
  ]), null, 2));
  await commit(fixture.seed, "Add passing validation", "validation-pass");
  const passingHead = await head(fixture.seed);

  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  const repositoryId = await repositoryIdentity(store, "example/repository");
  const passed = await runner.run({
    repositoryId,
    commit: passingHead,
    base: "main",
    runnerId: "test-runner",
    now: new Date("2026-07-10T20:00:00.000Z"),
  });
  assert.equal(passed.result.status, "passed");
  assert.deepEqual(passed.result.checkpoints, ["validation-pass"]);
  assert.equal(passed.result.commands[0].stdout.bytes, 20000);
  assert.equal(passed.result.commands[0].stdout.truncated, true);
  assert.equal(Buffer.byteLength(passed.result.commands[0].stdout.tail), 16 * 1024);
  assert.equal(passed.result.commands[1].status, "passed");
  const isolatedHome = passed.result.commands[1].stdout.tail;
  assert.match(isolatedHome, /TabellioValidation-[^/]+\/Home$/);
  assert.equal(await stat(isolatedHome).catch((error) => error.code), "ENOENT");
  assert.equal(passed.result.commands[2].status, "passed");
  assert.equal(passed.result.commands[3].status, "passed");
  assert.equal(passed.result.commands[4].status, "passed");
  assert.equal(validateValidationResult(passed.result), passed.result);
  assert.deepEqual(await latestValidationResult(ledger, passingHead), passed.result);
  const otherRepository = await runner.run({
    repositoryId: "other/repository",
    commit: passingHead,
    base: "main",
    runnerId: "other-runner",
    now: new Date("2026-07-10T21:00:00.000Z"),
  });
  assert.deepEqual(await latestValidationResult(ledger, passingHead), otherRepository.result);
  assert.deepEqual(await latestValidationResult(ledger, passingHead, repositoryId), passed.result);
  assert.equal(await latestValidationResult(ledger, passingHead, "missing/repository"), null);

  await writeFile(manifestPath, JSON.stringify(manifest([
    command("fails", [process.execPath, "-e", "process.exit(3)"]),
    command("skipped", [process.execPath, "-e", "process.exit(0)"]),
  ]), null, 2));
  await commit(fixture.seed, "Add failing validation", "validation-fail");
  const failingHead = await head(fixture.seed);
  const failed = await runner.run({
    repositoryId,
    commit: failingHead,
    base: "main",
    runnerId: "test-runner",
  });
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.commands[0].exitCode, 3);
  assert.equal(failed.result.commands[1].status, "skipped");
  assert.deepEqual(failed.result.checkpoints, ["validation-fail", "validation-pass"]);

  const worktrees = await runGit({ args: ["worktree", "list", "--porcelain"], cwd: fixture.seed });
  assert.equal(worktrees.stdout.includes(passed.result.runId), false);
  const status = await runGit({ args: ["status", "--porcelain=v1"], cwd: fixture.seed });
  assert.equal(status.stdout, "");
});

test("validation runner accepts external workspace roots and rejects repository-internal roots", async (t) => {
  const fixture = await createFeatureFixture(t);
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifest([
    command("external-home", [process.execPath, "-e", "process.stdout.write(process.env.HOME)"]),
  ]), null, 2));
  await commit(fixture.seed, "Add external workspace validation", "external-workspace");
  const { store, ledger, externalRoot } = await externalValidationHarness(fixture);
  const result = await new ValidationRunner({ store, ledger, workspaceRoot: externalRoot }).run({
    repositoryId: "example/repository",
    commit: "HEAD",
    base: "main",
  });
  assert.equal(result.result.status, "passed");
  const isolatedHome = result.result.commands[0].stdout.tail;
  assert.equal(isolatedHome.startsWith(`${await realpath(externalRoot)}/TabellioValidation-`), true);
  assert.equal(await stat(isolatedHome).catch((error) => error.code), "ENOENT");

  const repositoryInternal = new ValidationRunner({
    store,
    ledger,
    workspaceRoot: join(fixture.seed, ".git", "tabellio", "validation-workspaces"),
  });
  await assert.rejects(
    repositoryInternal.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /outside the repository and Git common directory/,
  );

  const repositoryRoot = new ValidationRunner({ store, ledger, workspaceRoot: fixture.seed });
  await assert.rejects(
    repositoryRoot.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /outside the repository and Git common directory/,
  );

  const gitAlias = join(fixture.root, "GitAlias");
  await symlink(join(fixture.seed, ".git"), gitAlias);
  const canonicalGitAlias = new ValidationRunner({ store, ledger, workspaceRoot: gitAlias });
  await assert.rejects(
    canonicalGitAlias.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /outside the repository and Git common directory/,
  );

  const missingGitAliasChild = join(gitAlias, "tabellio-validation-created");
  const canonicalMissingGitAlias = new ValidationRunner({ store, ledger, workspaceRoot: missingGitAliasChild });
  await assert.rejects(
    canonicalMissingGitAlias.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /outside the repository and Git common directory/,
  );
  assert.equal(
    await stat(join(fixture.seed, ".git", "tabellio-validation-created")).catch((error) => error.code),
    "ENOENT",
  );

  const repositoryAlias = join(fixture.root, "RepositoryAlias");
  await symlink(fixture.seed, repositoryAlias);
  const canonicalRepositoryAlias = new ValidationRunner({ store, ledger, workspaceRoot: repositoryAlias });
  await assert.rejects(
    canonicalRepositoryAlias.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /outside the repository and Git common directory/,
  );
});

test("validation runner blocks result publication when Git worktree cleanup fails", async (t) => {
  const fixture = await createFeatureFixture(t);
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifest([
    command("break-worktree-registration", [process.execPath, "-e", 'require("node:fs").unlinkSync(".git")']),
  ]), null, 2));
  await commit(fixture.seed, "Add cleanup failure validation", "cleanup-failure");
  const validationHead = await head(fixture.seed);
  const { store, ledger, externalRoot } = await externalValidationHarness(fixture);

  await assert.rejects(
    new ValidationRunner({ store, ledger, workspaceRoot: externalRoot }).run({
      repositoryId: "example/repository",
      commit: validationHead,
      base: "main",
    }),
    /git worktree remove --force .* failed with exit code 128/,
  );
  assert.equal(await latestValidationResult(ledger, validationHead), null);
  assert.deepEqual(await readdir(externalRoot), []);
});

test("validation manifest rejects shell-like ambiguity and missing checkpoint ranges", async (t) => {
  assert.throws(
    () => validateValidationManifest(manifest([command("escape", ["node", "test.js"], "../outside")])),
    /safe relative path/,
  );
  assert.throws(
    () => validateValidationManifest({ ...manifest([]), commands: [] }),
    /1 to 50/,
  );

  const fixture = await createFeatureFixture(t);
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifest([
    command("tests", [process.execPath, "-e", "process.exit(0)"]),
  ]), null, 2));
  await runGit({ args: ["add", "tabellio.validation.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Manifest without checkpoint"], cwd: fixture.seed, env: identityEnv() });
  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  await assert.rejects(
    runner.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /has no Entire checkpoint/,
  );
});

test("validation runner terminates timed-out commands and skips remaining fail-fast work", async (t) => {
  const fixture = await createFeatureFixture(t);
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifest([
    command("timeout", [process.execPath, "-e", "setTimeout(() => {}, 5000)"], ".", 150),
    command("must-skip", [process.execPath, "-e", "process.exit(0)"]),
  ]), null, 2));
  await commit(fixture.seed, "Add timeout validation", "validation-timeout");
  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  const started = Date.now();
  const result = await runner.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" });
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.commands[0].status, "timed_out");
  assert(["SIGTERM", "SIGKILL"].includes(result.result.commands[0].signal));
  assert.equal(result.result.commands[1].status, "skipped");
  assert(Date.now() - started < 3_000);
});

test("typed validators enforce semantic metrics and cost budgets with durable evidence", async (t) => {
  const fixture = await createFeatureFixture(t);
  const semantic = validatorEvidence("semantic-eval", {
    metrics: [{ name: "strict_pass_rate", value: 0.9, unit: "ratio" }],
    cost: availableCost(0.11, 5, 12),
  });
  const operational = validatorEvidence("cost-guard", {
    metrics: [{ name: "redis_commands", value: 100, unit: "commands" }],
    cost: availableCost(0, 0, 0),
  });
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(productManifest([
    typedValidator("static-checks", "static", [process.execPath, "-e", "process.exit(0)"], null),
    typedValidator(
      "semantic-eval",
      "semantic",
      evidenceCommand(".tabellio/semantic.json", semantic),
      ".tabellio/semantic.json",
      {
        metricThresholds: [{ metric: "strict_pass_rate", operator: "gte", value: 0.8 }],
        maxCostUsd: 0.5,
        requireCostTelemetry: true,
      },
    ),
    typedValidator(
      "cost-guard",
      "operational",
      evidenceCommand(".tabellio/cost.json", operational),
      ".tabellio/cost.json",
      {
        metricThresholds: [{ metric: "redis_commands", operator: "lte", value: 1_000 }],
        maxCostUsd: 0.1,
        requireCostTelemetry: true,
      },
    ),
  ], ["semantic", "operational"]), null, 2));
  await commit(fixture.seed, "Add product validation", "product-validation-pass");

  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const result = await new ValidationRunner({ store, ledger }).run({
    repositoryId: "example/repository",
    commit: "HEAD",
    base: "main",
    runnerId: "product-validator",
  });

  assert.equal(result.result.schemaVersion, "tabellio-validation-result/v0.3");
  assert.equal(result.result.status, "passed");
  assert.equal(result.result.acceptance.id, "PLANE-101");
  assert.deepEqual(result.result.acceptance.requiredValidatorTypes, ["semantic", "operational"]);
  assert.deepEqual(result.result.validators.map(({ id, type, status }) => ({ id, type, status })), [
    { id: "static-checks", type: "static", status: "passed" },
    { id: "semantic-eval", type: "semantic", status: "passed" },
    { id: "cost-guard", type: "operational", status: "passed" },
  ]);
  assert.equal(result.result.validators[1].evidence.report.metrics[0].value, 0.9);
  assert.equal(result.result.decision.totalCostUsd, 0.11);
  assert.equal(result.result.decision.costTelemetryComplete, true);
  assert.equal(validateValidationResult(result.result), result.result);
});

test("typed validation distinguishes product failure from blocked evidence", async (t) => {
  const fixture = await createFeatureFixture(t);
  const weakEvidence = validatorEvidence("semantic-eval", {
    metrics: [{ name: "strict_pass_rate", value: 0.2, unit: "ratio" }],
    cost: availableCost(0.6, 1, 2),
  });
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(productManifest([
    typedValidator(
      "semantic-eval",
      "semantic",
      evidenceCommand(".tabellio/semantic.json", weakEvidence),
      ".tabellio/semantic.json",
      {
        metricThresholds: [{ metric: "strict_pass_rate", operator: "gte", value: 0.8 }],
        maxCostUsd: 0.5,
        requireCostTelemetry: true,
      },
    ),
  ], ["semantic"]), null, 2));
  await commit(fixture.seed, "Add failing semantic validation", "product-validation-fail");
  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  const failed = await runner.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" });
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.validators[0].status, "failed");
  assert.deepEqual(failed.result.validators[0].reasons, [
    "cost_budget_exceeded:0.5",
    "threshold_not_met:strict_pass_rate:gte:0.8",
  ]);

  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(productManifest([
    typedValidator(
      "cost-guard",
      "operational",
      [process.execPath, "-e", "process.exit(0)"],
      ".tabellio/missing.json",
      { metricThresholds: [], maxCostUsd: 0.1, requireCostTelemetry: true },
    ),
  ], ["operational"]), null, 2));
  await commit(fixture.seed, "Add blocked operational validation", "product-validation-blocked");
  const blocked = await runner.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" });
  assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.result.validators[0].status, "blocked");
  assert.equal(blocked.result.decision.costTelemetryComplete, false);
  assert(blocked.result.validators[0].reasons.includes("cost_telemetry_unavailable"));
  assert(blocked.result.validators[0].reasons.some((reason) => reason.startsWith("evidence_invalid:")));
});

test("typed validation preserves failure and blocked boundaries across validator kinds", async (t) => {
  const fixture = await createFeatureFixture(t);
  const schemaFailure = validatorEvidence("schema-contract", {
    status: "failed",
    summary: "Structured output included an unsupported field.",
  });
  const missingMetric = validatorEvidence("semantic-eval");
  const unavailableCost = validatorEvidence("cost-guard", {
    cost: { telemetry: "unavailable", usd: null, modelCalls: null, toolCalls: null },
  });
  const manifestValue = productManifest([
    typedValidator("static-checks", "static", [process.execPath, "-e", "process.exit(2)"], null),
    typedValidator(
      "schema-contract",
      "schema",
      evidenceCommand(".tabellio/schema.json", schemaFailure),
      ".tabellio/schema.json",
    ),
    typedValidator(
      "semantic-eval",
      "semantic",
      evidenceCommand(".tabellio/semantic.json", missingMetric),
      ".tabellio/semantic.json",
      {
        metricThresholds: [{ metric: "strict_pass_rate", operator: "gte", value: 0.8 }],
        maxCostUsd: null,
        requireCostTelemetry: false,
      },
    ),
    typedValidator(
      "cost-guard",
      "operational",
      evidenceCommand(".tabellio/cost.json", unavailableCost),
      ".tabellio/cost.json",
      { metricThresholds: [], maxCostUsd: 0.1, requireCostTelemetry: true },
    ),
  ], ["static", "schema", "semantic", "operational"]);
  manifestValue.failFast = false;
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifestValue, null, 2));
  await commit(fixture.seed, "Add validator boundary matrix", "product-validation-boundaries");

  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const result = await new ValidationRunner({ store, ledger }).run({
    repositoryId: "example/repository",
    commit: "HEAD",
    base: "main",
  });

  assert.equal(result.result.status, "blocked");
  assert.deepEqual(result.result.validators.map(({ id, status, reasons }) => ({ id, status, reasons })), [
    { id: "static-checks", status: "failed", reasons: ["command_failed"] },
    { id: "schema-contract", status: "failed", reasons: ["evidence_reported_failed"] },
    { id: "semantic-eval", status: "blocked", reasons: ["metric_missing:strict_pass_rate"] },
    { id: "cost-guard", status: "blocked", reasons: ["cost_telemetry_unavailable"] },
  ]);
  assert.equal(result.result.decision.costTelemetryComplete, false);
});

test("typed validation contracts reject incomplete product gates and invalid evidence", () => {
  const incomplete = productManifest([
    typedValidator("static-checks", "static", [process.execPath, "-e", "process.exit(0)"], null),
  ], ["semantic"]);
  assert.throws(() => validateValidationManifest(incomplete), /requires a required semantic validator/);

  const missingEvidence = productManifest([
    typedValidator("semantic-eval", "semantic", [process.execPath, "-e", "process.exit(0)"], null),
  ], ["semantic"]);
  assert.throws(() => validateValidationManifest(missingEvidence), /evidence is required/);

  const invalidCost = validatorEvidence("cost-guard", {
    cost: { telemetry: "unavailable", usd: 0, modelCalls: null, toolCalls: null },
  });
  assert.throws(() => validateValidatorEvidence(invalidCost), /cost values must be null/);

  const ephemeralArtifact = validatorEvidence("visual-regression", {
    artifacts: [{
      name: "desktop-diff",
      uri: "file:///tmp/desktop-diff.png",
      digest: "d".repeat(64),
      mediaType: "image/png",
      bytes: 100,
    }],
  });
  assert.throws(() => validateValidatorEvidence(ephemeralArtifact), /must not use an ephemeral file URI/);
});

function manifest(commands) {
  return {
    schemaVersion: "tabellio-validation/v0.1",
    id: "test-suite",
    failFast: true,
    requireEntireCheckpoint: true,
    commands,
  };
}

function command(id, argv, cwd = ".", timeoutMs = 10_000) {
  return { id, argv, cwd, timeoutMs, required: true };
}

function productManifest(validators, requiredValidatorTypes) {
  return {
    schemaVersion: "tabellio-validation/v0.2",
    id: "product-suite",
    failFast: true,
    requireEntireCheckpoint: true,
    acceptance: {
      id: "PLANE-101",
      source: "plane",
      risk: "high",
      outcomes: ["The user receives a correct product result."],
      invariants: ["No live mutation occurs during validation."],
      forbiddenOutcomes: ["Missing cost telemetry is treated as zero cost."],
      requiredValidatorTypes,
    },
    validators,
  };
}

function typedValidator(id, type, argv, evidencePath, policy = null) {
  return {
    id,
    type,
    argv,
    cwd: ".",
    timeoutMs: 10_000,
    required: true,
    evidence: evidencePath === null ? null : { path: evidencePath },
    policy: policy ?? { metricThresholds: [], maxCostUsd: null, requireCostTelemetry: false },
  };
}

function validatorEvidence(validatorId, overrides = {}) {
  return {
    schemaVersion: "tabellio-validator-evidence/v0.1",
    validatorId,
    status: "passed",
    summary: "Validator completed.",
    metrics: [],
    cost: { telemetry: "not_applicable", usd: null, modelCalls: null, toolCalls: null },
    artifacts: [],
    ...overrides,
  };
}

function availableCost(usd, modelCalls, toolCalls) {
  return { telemetry: "available", usd, modelCalls, toolCalls };
}

function evidenceCommand(path, evidence) {
  const source = [
    "const fs = require('node:fs');",
    `fs.mkdirSync(${JSON.stringify(path.split("/").slice(0, -1).join("/"))}, { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(JSON.stringify(evidence))});`,
  ].join("");
  return [process.execPath, "-e", source];
}

async function commit(cwd, message, checkpoint) {
  await runGit({ args: ["add", "tabellio.validation.json"], cwd });
  await runGit({
    args: ["commit", "-m", message, "-m", `Entire-Checkpoint: ${checkpoint}`],
    cwd,
    env: identityEnv(),
  });
}

async function externalValidationHarness(fixture) {
  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const externalRoot = join(fixture.root, "ValidationRoot");
  await mkdir(externalRoot);
  return { store, ledger, externalRoot };
}

async function head(cwd) {
  return (await runGit({ args: ["rev-parse", "HEAD"], cwd })).stdout.trim();
}
