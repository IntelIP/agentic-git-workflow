#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { assertAllowedOptions, parseOptionPairs, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { renderAnalyticsReport, validateAnalyticsDataset } from "./lib/analytics.mjs";

const PROFILES = ["schema", "semantic", "workflow", "operational", "security"];
const REQUIRED_BASELINE_REPOSITORIES = Object.freeze([
  "intelip/condere",
  "intelip/probanda",
  "intelip/tabellio",
  "intelip/vaticor",
]);
const PROFILE_VALIDATORS = Object.freeze({
  schema: validateSchemaProfile,
  semantic: validateSemanticProfile,
  workflow: validateWorkflowProfile,
  operational: validateOperationalProfile,
  security: validateSecurityProfile,
});

try {
  const options = parseOptionPairs(process.argv.slice(2), "analytics validator");
  assertAllowedOptions(options, ["profile", "validatorId", "dataset", "report", "source", "out", "exitMode"]);
  requireOptions(options, ["profile", "validatorId", "dataset", "report", "out"], "analytics validator");
  if (!PROFILES.includes(options.profile)) throw new Error(`Unsupported analytics validator profile: ${options.profile}.`);
  if (options.exitMode !== undefined && options.exitMode !== "evidence") {
    throw new Error(`Unsupported analytics validator exit mode: ${options.exitMode}.`);
  }

  const datasetPath = resolve(options.dataset);
  const reportPath = resolve(options.report);
  const datasetInput = await readInput(datasetPath, "Dataset");
  const reportInput = await readInput(reportPath, "Report");
  const sourceInput = options.source
    ? await readInput(resolve(options.source), "Source")
    : { bytes: null, raw: null, error: null };
  const readErrors = compact([datasetInput.error, reportInput.error, sourceInput.error]);
  const inputErrors = [...readErrors];
  let dataset = null;
  let source = null;
  if (datasetInput.raw !== null) {
    try {
      dataset = JSON.parse(datasetInput.raw);
    } catch {
      inputErrors.push("Dataset JSON is invalid.");
    }
  }
  if (sourceInput.raw !== null) {
    try {
      source = JSON.parse(sourceInput.raw);
    } catch {
      inputErrors.push("Source JSON is invalid.");
    }
  }
  const startedAt = performance.now();
  const result = inputErrors.length > 0
    ? inputFailureResult(options.profile, inputErrors)
    : runProfile(options.profile, {
      dataset,
      datasetRaw: datasetInput.raw,
      reportRaw: reportInput.raw,
      source,
      sourceRaw: sourceInput.raw,
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
      artifactFromInput("analytics-source", sourceInput.bytes, "application/json"),
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

function validateSemanticProfile({ dataset, reportRaw, source }) {
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
  const collectedRepositoryIds = repositories
    .filter(hasCollectedGitEvidence)
    .map((repository) => repository.canonicalRepositoryId.toLowerCase())
    .sort();
  const linkedTraces = traces.filter(hasLinkedTrace);
  const deliveryMetricErrors = repositories.flatMap(validateDeliveryMetrics);
  const providerEvidenceErrors = validateProviderEvidence(dataset, source);
  const errors = compact([
    ...datasetErrors,
    ...deliveryMetricErrors,
    ...providerEvidenceErrors,
    errorUnless(collectedRepositoryCount >= 4, "Fewer than four distinct repositories were compared."),
    errorUnless(
      JSON.stringify(collectedRepositoryIds) === JSON.stringify(REQUIRED_BASELINE_REPOSITORIES),
      "Canonical baseline repository set does not match IntelIP/Condere, IntelIP/Probanda, IntelIP/Tabellio, and IntelIP/Vaticor.",
    ),
    errorUnless(traces.length >= 1, "No cross-system delivery trace is present."),
    errorUnless(linkedTraces.length >= 1, "No linked Plane-to-pull-request delivery trace is present."),
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

function validateSecurityProfile({ dataset, datasetRaw, reportRaw, source, sourceRaw }) {
  const payload = [
    datasetRaw,
    reportRaw,
    sourceRaw,
    JSON.stringify(dataset),
    JSON.stringify(source),
  ].filter(Boolean).join("\n");
  const forbidden = [
    ["/Users/", "Local home path leaked."],
    ["/private/", "Private temporary path leaked."],
    ["full.jsonl", "Entire transcript filename leaked."],
    ["private transcript", "Transcript content leaked."],
    [/github_pat_|gh[pousr]_/i, "GitHub token prefix leaked."],
    [/bearer\s/i, "Bearer credential leaked."],
    [/(?:password|token|secret)\s*[=:]/i, "Credential-shaped value leaked."],
    [/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i, "URL credential leaked."],
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

function hasLinkedTrace(change) {
  return hasLinkProvenance(change)
    && change.linkBasis !== "unlinked"
    && typeof change.planeStoryId === "string"
    && Number.isInteger(change.pullRequestNumber);
}

function validateDeliveryMetrics(repository) {
  const changes = deliveryChanges(repository);
  const linked = changes.filter(hasLinkedTrace);
  const expected = {
    deliveryChangeCount: deliveryCountProjection(repository, changes),
    taskToPrTraceability: traceabilityProjection(repository, changes, linked),
    leadTimeHours: leadTimeProjection(repository, linked),
    cycleTimeHours: cycleTimeProjection(repository, linked),
    ciDisagreementRate: ciDisagreementProjection(repository, changes),
    releaseLagHours: releaseLagProjection(repository, changes),
  };
  return Object.entries(expected).flatMap(([metricId, projection]) =>
    validateDeliveryMetric(repository, metricId, projection)
  );
}

function validateProviderEvidence(dataset, snapshot) {
  const repository = findTabellioRepository(dataset);
  if (!repository) {
    return ["Committed Tabellio provider snapshot is required for semantic validation."];
  }
  if (!isRecord(snapshot)) {
    return ["Committed Tabellio provider snapshot is required for semantic validation."];
  }
  const expectedChanges = providerBoundChanges(snapshot.deliveryChanges);
  const actualChanges = providerBoundChanges(repository.deliveryChanges);
  return compact([
    errorUnless(
      isTabellioProviderSnapshot(snapshot),
      "Provider snapshot repository does not match IntelIP/Tabellio.",
    ),
    errorUnless(
      JSON.stringify(actualChanges) === JSON.stringify(expectedChanges),
      "Delivery traces do not match the committed provider snapshot.",
    ),
    ...["plane", "github", "github-actions"].flatMap((system) =>
      validateProviderSourceBinding(repository, snapshot, system)
    ),
  ]);
}

function findTabellioRepository(dataset) {
  if (!Array.isArray(dataset?.repositories)) return null;
  return dataset.repositories.find(isTabellioRepository) ?? null;
}

function isTabellioRepository(repository) {
  if (!isRecord(repository)) return false;
  if (typeof repository.canonicalRepositoryId !== "string") return false;
  return repository.canonicalRepositoryId.toLowerCase() === "intelip/tabellio";
}

function isTabellioProviderSnapshot(snapshot) {
  return typeof snapshot.repository === "string"
    && snapshot.repository.toLowerCase() === "intelip/tabellio";
}

function providerBoundChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map(providerBoundChange).sort(compareChangeIds);
}

function providerBoundChange(change) {
  const entry = isRecord(change) ? change : {};
  return {
    id: entry.id,
    linkBasis: entry.linkBasis,
    linkEvidence: entry.linkEvidence,
    planeStoryId: entry.planeStoryId,
    pullRequestNumber: entry.pullRequestNumber,
    storyCreatedAt: entry.storyCreatedAt,
    firstActivityAt: entry.firstActivityAt,
    mergedAt: entry.mergedAt,
    releasedAt: entry.releasedAt,
    headCommit: entry.headCommit,
    validationStatus: entry.validationStatus,
    hostedStatus: entry.hostedStatus,
  };
}

function compareChangeIds(left, right) {
  return String(left.id).localeCompare(String(right.id));
}

function validateProviderSourceBinding(repository, snapshot, system) {
  const actual = findRepositorySource(repository, system);
  if (!actual) {
    return [`${system}: available committed provider source is required.`];
  }
  const expected = findProviderSource(snapshot, system);
  if (!expected) {
    return [`${system}: available committed provider source is required.`];
  }
  if (expected.status !== "available") {
    return [`${system}: available committed provider source is required.`];
  }
  const content = JSON.stringify({
    capturedAt: snapshot.capturedAt,
    source: expected,
    changes: providerSnapshotChanges(snapshot).map((change) => providerProjection(change, system)),
  });
  return compact([
    errorUnless(actual.status === "available", `${system}: dataset source is not available.`),
    errorUnless(actual.observedAt === snapshot.capturedAt, `${system}: observation time does not match provider snapshot.`),
    errorUnless(actual.sourceVersion === expected.version, `${system}: source version does not match provider snapshot.`),
    errorUnless(actual.contentDigest === sha256(content), `${system}: source digest does not match provider snapshot.`),
  ]);
}

function findRepositorySource(repository, system) {
  if (!Array.isArray(repository.sources)) return null;
  return repository.sources.find((source) => isSourceSystem(source, system)) ?? null;
}

function findProviderSource(snapshot, system) {
  if (!isRecord(snapshot.sources)) return null;
  return isRecord(snapshot.sources[system]) ? snapshot.sources[system] : null;
}

function providerSnapshotChanges(snapshot) {
  return Array.isArray(snapshot.deliveryChanges) ? snapshot.deliveryChanges : [];
}

function isSourceSystem(source, system) {
  return isRecord(source) && source.system === system;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerProjection(change, system) {
  if (system === "plane") {
    return {
      id: change.id,
      linkBasis: change.linkBasis,
      linkEvidence: change.linkEvidence,
      planeStoryId: change.planeStoryId,
      storyCreatedAt: change.storyCreatedAt,
    };
  }
  if (system === "github-actions") {
    return { id: change.id, headCommit: change.headCommit, hostedStatus: change.hostedStatus };
  }
  return {
    id: change.id,
    pullRequestNumber: change.pullRequestNumber,
    firstActivityAt: change.firstActivityAt,
    mergedAt: change.mergedAt,
    releasedAt: change.releasedAt,
    headCommit: change.headCommit,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deliveryChanges(repository) {
  const changes = Array.isArray(repository?.deliveryChanges) ? repository.deliveryChanges : [];
  return changes.filter(isObject);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object";
}

function deliveryCountProjection(repository, changes) {
  return hasAvailableSources(repository, ["plane", "github"])
    ? measuredCount(changes.length)
    : null;
}

function traceabilityProjection(repository, changes, linked) {
  if (!hasAvailableSources(repository, ["plane", "github"]) || changes.length === 0) return null;
  return measuredRatio(linked.length, changes.length);
}

function leadTimeProjection(repository, linked) {
  if (!hasAvailableSources(repository, ["plane", "github"])) return null;
  return measuredAverage(linked.flatMap((change) =>
    durationHours(change.storyCreatedAt, change.mergedAt)
  ));
}

function cycleTimeProjection(repository, linked) {
  if (!hasAvailableSources(repository, ["git", "plane", "github"])) return null;
  return measuredAverage(linked.flatMap((change) =>
    durationHours(change.firstActivityAt, change.mergedAt)
  ));
}

function releaseLagProjection(repository, changes) {
  if (!hasAvailableSources(repository, ["github"])) return null;
  return measuredAverage(changes.flatMap((change) =>
    durationHours(change.mergedAt, change.releasedAt)
  ));
}

function ciDisagreementProjection(repository, changes) {
  if (!hasAvailableSources(repository, ["tabellio-validation", "github-actions"])) return null;
  const comparable = changes.filter(hasComparableCiStatuses);
  if (comparable.length === 0) return null;
  const disagreements = comparable.filter((change) =>
    change.validationStatus !== change.hostedStatus
  ).length;
  return measuredRatio(disagreements, comparable.length);
}

function hasComparableCiStatuses(change) {
  return isComparableStatus(change.validationStatus)
    && isComparableStatus(change.hostedStatus);
}

function isComparableStatus(status) {
  return ["passed", "failed", "blocked"].includes(status);
}

function validateDeliveryMetric(repository, metricId, projection) {
  const actual = repository?.metrics?.[metricId];
  const validator = projection === null
    ? unavailableProjectionMatches
    : measuredProjectionMatches;
  const valid = validator(actual, projection);
  return valid ? [] : [`delivery/${metricId}: metric contradicts delivery trace rows.`];
}

function unavailableProjectionMatches(actual) {
  return Boolean(actual) && actual.status === "unavailable";
}

function measuredProjectionMatches(actual, projection) {
  if (!actual) return false;
  if (actual.status !== "measured") return false;
  return metricProjectionMatches(actual, projection);
}

function hasAvailableSources(repository, systems) {
  const sources = Array.isArray(repository?.sources) ? repository.sources : [];
  return systems.every((system) =>
    sources.some((source) =>
      source?.system === system && source.status === "available"
    )
  );
}

function measuredCount(value) {
  return { value, numerator: null, denominator: null };
}

function measuredRatio(numerator, denominator) {
  return { value: numerator / denominator, numerator, denominator };
}

function measuredAverage(values) {
  if (values.length === 0) return null;
  return {
    value: values.reduce((sum, value) => sum + value, 0) / values.length,
    numerator: null,
    denominator: values.length,
  };
}

function durationHours(start, end) {
  const duration = Date.parse(end) - Date.parse(start);
  return isNonNegativeFinite(duration) ? [duration / 3_600_000] : [];
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function metricProjectionMatches(actual, expected) {
  if (expected === null) return false;
  return nearlyEqual(actual.value, expected.value)
    && actual.numerator === expected.numerator
    && actual.denominator === expected.denominator;
}

function nearlyEqual(left, right) {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= 1e-12;
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
