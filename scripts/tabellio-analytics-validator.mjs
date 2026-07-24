#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { assertAllowedOptions, parseOptionPairs, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { renderAnalyticsReport, validateAnalyticsDataset } from "./lib/analytics.mjs";

const PROFILES = ["schema", "semantic", "workflow", "operational", "security"];
const PROFILE_VALIDATORS = Object.freeze({
  schema: validateSchemaProfile,
  semantic: validateSemanticProfile,
  workflow: validateWorkflowProfile,
  operational: validateOperationalProfile,
  security: validateSecurityProfile,
});

try {
  const options = parseOptionPairs(process.argv.slice(2), "analytics validator");
  assertAllowedOptions(options, ["profile", "validatorId", "dataset", "report", "out", "exitMode"]);
  requireOptions(options, ["profile", "validatorId", "dataset", "report", "out"], "analytics validator");
  if (!PROFILES.includes(options.profile)) throw new Error(`Unsupported analytics validator profile: ${options.profile}.`);
  if (options.exitMode !== undefined && options.exitMode !== "evidence") {
    throw new Error(`Unsupported analytics validator exit mode: ${options.exitMode}.`);
  }

  const datasetPath = resolve(options.dataset);
  const reportPath = resolve(options.report);
  const datasetInput = await readInput(datasetPath, "Dataset");
  const reportInput = await readInput(reportPath, "Report");
  const readErrors = compact([datasetInput.error, reportInput.error]);
  const inputErrors = [...readErrors];
  let dataset = null;
  if (datasetInput.raw !== null) {
    try {
      dataset = JSON.parse(datasetInput.raw);
    } catch {
      inputErrors.push("Dataset JSON is invalid.");
    }
  }
  const startedAt = performance.now();
  const result = inputErrors.length > 0
    ? inputFailureResult(options.profile, inputErrors)
    : runProfile(options.profile, {
      dataset,
      datasetRaw: datasetInput.raw,
      reportRaw: reportInput.raw,
    });
  const durationMs = performance.now() - startedAt;
  const evidence = {
    schemaVersion: "tabellio-validator-evidence/v0.1",
    validatorId: options.validatorId,
    status: readErrors.length > 0
      ? "blocked"
      : (result.errors.length === 0 ? "passed" : "failed"),
    summary: evidenceSummary(result),
    metrics: [...result.metrics, { name: "analytics_validator_duration_ms", value: durationMs, unit: "milliseconds" }],
    cost: { telemetry: "available", usd: 0, modelCalls: 0, toolCalls: 0 },
    artifacts: [
      artifactFromInput("analytics-dataset", datasetInput.bytes, "application/json"),
      artifactFromInput("analytics-report", reportInput.bytes, "text/markdown"),
    ].filter(Boolean),
  };
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: evidence.status === "passed", profile: options.profile, out, status: evidence.status }));
  if (evidence.status !== "passed" && options.exitMode !== "evidence") process.exitCode = 1;
} catch (error) {
  reportCliError(error);
}

function runProfile(profile, context) {
  return PROFILE_VALIDATORS[profile](context);
}

function inputFailureResult(profile, errors) {
  const metrics = {
    schema: [metric("analytics_schema_pass", 0, "boolean")],
    semantic: [
      metric("analytics_semantic_pass", 0, "boolean"),
      metric("analytics_repository_count", 0, "count"),
      metric("analytics_trace_count", 0, "count"),
    ],
    workflow: [metric("analytics_report_reproducible", 0, "boolean")],
    operational: [metric("analytics_projection_25x_duration_ms", 0, "milliseconds")],
    security: [metric("analytics_privacy_pass", 0, "boolean")],
  };
  return result("Analytics validator input is readable and parseable.", errors, metrics[profile]);
}

function evidenceSummary(result) {
  const raw = result.errors.length === 0 ? result.summary : result.errors.join(" ");
  const singleLine = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (containsSensitiveEvidenceText(singleLine)) {
    return `Analytics validation failed with ${result.errors.length} issue(s); sensitive details were redacted.`;
  }
  return (singleLine || "Analytics validation failed.").slice(0, 2_000);
}

function containsSensitiveEvidenceText(value) {
  return [
    /github_pat_|gh[pousr]_|bearer\s|(?:password|token|secret)\s*[=:]/i.test(value),
    /full\.jsonl|private transcript/i.test(value),
    containsLocalFilesystemPath(value),
  ].some(Boolean);
}

async function readInput(path, label) {
  try {
    const bytes = await readFile(path);
    return { bytes, raw: bytes.toString("utf8"), error: null };
  } catch {
    return { bytes: null, raw: null, error: `${label} could not be read.` };
  }
}

function validateSchemaProfile({ dataset }) {
  const errors = captureError(() => validateAnalyticsDataset(dataset));
  return result("Analytics dataset schema, metric state, source links, and integrity are valid.", errors, [
    metric("analytics_schema_pass", errors.length === 0 ? 1 : 0, "boolean"),
  ]);
}

function validateSemanticProfile({ dataset, reportRaw }) {
  const datasetErrors = captureError(() => validateAnalyticsDataset(dataset));
  const repositories = Array.isArray(dataset?.repositories) ? dataset.repositories : [];
  const traces = repositories.flatMap((repository) =>
    Array.isArray(repository?.deliveryChanges) ? repository.deliveryChanges : []
  );
  const unavailableMetrics = repositories.flatMap((repository) =>
    Object.values(repository?.metrics ?? {}).filter((entry) => entry?.status === "unavailable")
  );
  const collectedRepositoryCount = new Set(
    repositories
      .filter(hasCollectedGitEvidence)
      .map((repository) => repository.canonicalRepositoryId.toLowerCase())
  ).size;
  const errors = compact([
    ...datasetErrors,
    errorUnless(collectedRepositoryCount >= 4, "Fewer than four distinct repositories were compared."),
    errorUnless(traces.length >= 1, "No cross-system delivery trace is present."),
    errorUnless(traces.every(hasLinkProvenance), "A delivery trace lacks explicit link provenance."),
    errorUnless(unavailableMetrics.every((entry) => entry.value === null), "Unavailable metrics must be null."),
    errorUnless(reportRaw.includes("They do not rank developers"), "Report lacks the anti-ranking interpretation boundary."),
  ]);
  return result("Four repositories, provenance-linked delivery traces, and unknown-not-zero semantics are present.", errors, [
    metric("analytics_semantic_pass", errors.length === 0 ? 1 : 0, "boolean"),
    metric("analytics_repository_count", collectedRepositoryCount, "count"),
    metric("analytics_trace_count", traces.length, "count"),
  ]);
}

function validateWorkflowProfile({ dataset, reportRaw }) {
  const errors = captureError(() => validateAnalyticsDataset(dataset));
  const rendered = errors.length === 0 ? renderAnalyticsReport(dataset) : "";
  if (rendered !== reportRaw) errors.push("Committed report does not reproduce from the committed dataset.");
  return result("Committed report reproduces byte-for-byte from the integrity-bound dataset.", errors, [
    metric("analytics_report_reproducible", errors.length === 0 ? 1 : 0, "boolean"),
  ]);
}

function validateOperationalProfile({ dataset }) {
  const startedAt = performance.now();
  const errors = captureError(() => {
    for (let index = 0; index < 25; index += 1) {
      validateAnalyticsDataset(dataset);
      renderAnalyticsReport(dataset);
    }
  });
  const durationMs = performance.now() - startedAt;
  if (errors.length === 0 && durationMs > 1_000) {
    errors.push(`Twenty-five local projections took ${durationMs.toFixed(2)}ms.`);
  }
  return result("Twenty-five local validation and report projections complete within one second.", errors, [
    metric("analytics_projection_25x_duration_ms", durationMs, "milliseconds"),
  ]);
}

function validateSecurityProfile({ datasetRaw, reportRaw }) {
  const payload = `${datasetRaw}\n${reportRaw}`;
  const forbidden = [
    ["/Users/", "Local home path leaked."],
    ["/private/", "Private temporary path leaked."],
    ["full.jsonl", "Entire transcript filename leaked."],
    ["private transcript", "Transcript content leaked."],
    [/github_pat_|gh[pousr]_/i, "GitHub token prefix leaked."],
    [/bearer\s/i, "Bearer credential leaked."],
  ];
  const errors = forbidden.flatMap(([needle, message]) =>
    typeof needle === "string" ? (payload.includes(needle) ? [message] : []) : (needle.test(payload) ? [message] : [])
  );
  if (containsLocalFilesystemPath(payload)) errors.push("Local filesystem path leaked.");
  return result("Portable analytics artifacts contain no local paths, transcript bodies, or credential-shaped values.", errors, [
    metric("analytics_privacy_pass", errors.length === 0 ? 1 : 0, "boolean"),
  ]);
}

function containsLocalFilesystemPath(payload) {
  if (/file:\/\/+/i.test(payload)) return true;
  const withoutRemoteUrls = payload.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi,
    "",
  );
  return [
    /(?:^|[^A-Za-z0-9/])\/(?!\/)[^\s"'<>|]+/m,
    /(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]+[^\s"'<>|]+/,
    /(?:^|[^\\])\\{2,}[^\\\s]+\\+/,
  ].some((pattern) => pattern.test(withoutRemoteUrls));
}

function result(summary, errors, metrics) {
  return { summary, errors, metrics };
}

function metric(name, value, unit) {
  return { name, value, unit };
}

function hasLinkProvenance(change) {
  return Boolean(change)
    && typeof change === "object"
    && (change.linkBasis !== "manual-reconciliation" || Boolean(change.linkEvidence));
}

function hasCollectedGitEvidence(repository) {
  return typeof repository?.canonicalRepositoryId === "string"
    && Array.isArray(repository.sources)
    && repository.sources.some((source) =>
      source?.system === "git" && source.status === "available"
    );
}

function captureError(action) {
  try {
    action();
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function errorUnless(condition, message) {
  return condition ? null : message;
}

function compact(values) {
  return values.filter(Boolean);
}

function artifactFromInput(name, bytes, mediaType) {
  if (bytes === null) return null;
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    name,
    uri: `urn:tabellio:analytics:${name}:${digest}`,
    digest,
    mediaType,
    bytes: bytes.byteLength,
  };
}
