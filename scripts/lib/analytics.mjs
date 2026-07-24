import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";

import { runGit } from "./git-process.mjs";
import { canonicalJson } from "./context-packet.mjs";
import { parseGitHubRepositoryRemote } from "./github-repository.mjs";
import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";
import { normalizeRepositoryRemote } from "./repository-identity.mjs";
import { validateReviewCycle } from "./review-cycle.mjs";
import { validateValidationResult } from "./validation-runner.mjs";

const ANALYTICS_SCHEMA_VERSION = "tabellio-analytics-dataset/v0.1";
const ANALYTICS_SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/analytics-dataset.v0.1.schema.json", import.meta.url),
  "utf8",
));

const METRIC_DEFINITIONS = Object.freeze([
  defineMetric("commitCount", "count", "Commits reachable from HEAD whose commit time falls inside the observation window.", ["git"], "Unavailable when local Git cannot be read."),
  defineMetric("validationAttemptCount", "count", "Tabellio validation results completed inside the observation window.", ["tabellio-validation"], "Unavailable when the validation ref is absent or unreadable."),
  defineMetric("validationPassRate", "ratio", "Passed validation attempts divided by all terminal validation attempts in the window.", ["tabellio-validation"], "Unavailable when there are no terminal attempts; never reported as zero."),
  defineMetric("costTelemetryCoverage", "ratio", "Validation attempts with complete required cost telemetry divided by validation attempts.", ["tabellio-validation"], "Unavailable when there are no validation attempts."),
  defineMetric("entireCheckpointCount", "count", "Distinct metadata-only Entire checkpoint sessions visible in the checkpoint ref.", ["entire"], "Unavailable when the metadata ref is absent; transcript bodies are never read."),
  defineMetric("reviewFindingCount", "count", "Review feedback records stored in Tabellio review cycles.", ["tabellio-review"], "Unavailable when the review ref is absent."),
  defineMetric("repairCount", "count", "Review fix records stored in Tabellio review cycles.", ["tabellio-review"], "Unavailable when the review ref is absent."),
  defineMetric("worktreeDirty", "boolean", "Whether Git reports tracked or untracked worktree changes at observation time.", ["git"], "Unavailable when local Git cannot be read."),
  defineMetric("evidenceCompleteness", "ratio", "Available evidence sources divided by the seven declared source systems.", ["git", "tabellio-validation", "tabellio-review", "entire", "plane", "github", "github-actions"], "A missing source reduces completeness; it is not converted to zero-valued evidence."),
  defineMetric("deliveryChangeCount", "count", "Delivery changes explicitly included in the sanitized provider snapshot.", ["plane", "github"], "Unavailable when no provider snapshot is supplied."),
  defineMetric("taskToPrTraceability", "ratio", "Delivery changes linked to both a Plane story and GitHub pull request divided by eligible delivery changes.", ["plane", "github"], "Unavailable until compatible Plane and GitHub snapshots are supplied."),
  defineMetric("leadTimeHours", "hours", "Elapsed time from work-item creation to merge for linked delivery changes.", ["plane", "github"], "Unavailable until linked timestamps are supplied."),
  defineMetric("cycleTimeHours", "hours", "Elapsed time from first implementation activity to merge for linked delivery changes.", ["git", "plane", "github"], "Unavailable until linked timestamps are supplied."),
  defineMetric("ciDisagreementRate", "ratio", "Candidates where hosted CI and exact-candidate validation disagree divided by compared candidates.", ["github-actions", "tabellio-validation"], "Unavailable until hosted-check evidence is supplied."),
  defineMetric("releaseLagHours", "hours", "Elapsed time from merge to first containing release.", ["github"], "Unavailable until merge and release evidence is supplied."),
  defineMetric("repositoryAdoption", "ratio", "Available Tabellio-native evidence sources divided by validation, review, and Entire sources.", ["tabellio-validation", "tabellio-review", "entire"], "Measured from source availability, not commit volume or developer ranking.")
]);

const DECLARED_SOURCE_SYSTEMS = Object.freeze([
  "git",
  "tabellio-validation",
  "tabellio-review",
  "entire",
  "plane",
  "github",
  "github-actions",
]);

const AVAILABILITY_METRICS = new Set(["evidenceCompleteness", "repositoryAdoption"]);

const PROVIDER_SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion",
  "repository",
  "capturedAt",
  "sources",
  "deliveryChanges",
]);

const PROVIDER_SOURCE_FIELDS = Object.freeze(["status", "version", "reason"]);

const DELIVERY_CHANGE_FIELDS = Object.freeze([
  "id",
  "linkBasis",
  "linkEvidence",
  "planeStoryId",
  "pullRequestNumber",
  "storyCreatedAt",
  "firstActivityAt",
  "mergedAt",
  "releasedAt",
  "headCommit",
  "validationStatus",
  "hostedStatus",
]);

export async function collectAnalyticsDataset({ id, repositories, observedAt, since, until }) {
  assertDateRange({ observedAt, since, until });
  assertRepositoryInputs(id, repositories);
  const seen = new Set();
  for (const repository of repositories) {
    if (seen.has(repository.id)) throw new Error(`Duplicate repository id: ${repository.id}.`);
    seen.add(repository.id);
  }

  const collected = await Promise.all(repositories.map((repository) =>
    collectRepositorySafely({ ...repository, observedAt, since, until })
  ));
  assertRequiredRepositories(repositories, collected);
  collected.sort((left, right) => left.id.localeCompare(right.id));
  const dataset = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    id,
    observedAt,
    window: { since, until },
    metricDefinitions: METRIC_DEFINITIONS,
    repositories: collected,
  };
  dataset.integrity = { algorithm: "sha256", digest: digestCanonical(dataset) };
  return dataset;
}

function assertRepositoryInputs(id, repositories) {
  if (!id) throw new Error("Analytics collection requires an id and at least one repository.");
  if (!isNonEmptyArray(repositories)) throw new Error("Analytics collection requires an id and at least one repository.");
  const invalid = repositories.find(hasIncompleteRepositoryInput);
  if (invalid) throw new Error("Each repository requires id and path.");
}

function hasIncompleteRepositoryInput(repository) {
  return !repository?.id || !repository?.path;
}

function assertRequiredRepositories(inputs, collected) {
  const failed = inputs.find((input, index) =>
    input.required === true && collected[index]?.headCommit === null
  );
  if (failed) throw new Error(`Required repository ${failed.id} could not be collected.`);
}

export function validateAnalyticsDataset(dataset) {
  const schemaErrors = validateJsonSchema(dataset, ANALYTICS_SCHEMA);
  if (schemaErrors.length > 0) throwValidationErrors(schemaErrors);
  const definitions = asArray(dataset?.metricDefinitions);
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const repositoryErrors = asArray(dataset?.repositories).flatMap((repository) =>
    validateRepositoryMetrics(repository, definitionIds, dataset?.observedAt)
  );
  const errors = [...validateDatasetHeader(dataset), ...repositoryErrors, ...validateDatasetIntegrity(dataset)];
  throwValidationErrors(errors);
  return dataset;
}

function validateDatasetHeader(dataset) {
  return compactErrors([
    errorUnless(hasAnalyticsSchema(dataset), "Unsupported analytics schemaVersion."),
    errorUnless(hasDatasetId(dataset), "Dataset id is required."),
    errorUnless(hasObservedAt(dataset), "observedAt must be an ISO date-time."),
    errorUnless(hasValidWindow(dataset), "Window requires ISO since and until."),
    errorUnless(hasCoherentWindow(dataset), "Analytics window ordering is invalid."),
    errorUnless(hasRepositories(dataset), "At least one repository is required."),
    errorUnless(hasMetricDefinitions(dataset), "Metric definitions are incomplete."),
  ]);
}

function hasAnalyticsSchema(dataset) {
  return dataset?.schemaVersion === ANALYTICS_SCHEMA_VERSION;
}

function hasDatasetId(dataset) {
  return Boolean(dataset?.id);
}

function hasObservedAt(dataset) {
  return isDateTime(dataset?.observedAt);
}

function hasValidWindow(dataset) {
  return validWindow(dataset?.window);
}

function hasCoherentWindow(dataset) {
  if (!hasObservedAt(dataset) || !hasValidWindow(dataset)) return false;
  return Date.parse(dataset.window.since) < Date.parse(dataset.window.until)
    && Date.parse(dataset.observedAt) >= Date.parse(dataset.window.until);
}

function hasRepositories(dataset) {
  return isNonEmptyArray(dataset?.repositories);
}

function hasMetricDefinitions(dataset) {
  return hasCompleteDefinitions(dataset?.metricDefinitions);
}

function validateRepositoryMetrics(repository, definitionIds, observedAt) {
  const sources = repository.sources ?? [];
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const errors = compactErrors([
    errorUnless(hasRepositoryIdentity(repository), "Repository identity is incomplete."),
    errorUnless(hasCanonicalSources(sources), `${repository.id}: repository sources must be unique and complete.`),
    errorUnless(hasValidRepositoryRevision(repository, sourceMap, observedAt), `${repository.id}: invalid repository revision state.`),
  ]);
  const sourceErrors = sources.flatMap((source) =>
    validateSourceProvenance(repository.id, source, observedAt)
  );
  const metrics = repository.metrics ?? {};
  const missingMetricErrors = [...definitionIds]
    .filter((metricId) => !Object.hasOwn(metrics, metricId))
    .map((metricId) => `${repository.id}: required metric ${metricId} is missing.`);
  const metricErrors = Object.entries(metrics).flatMap(([metricId, metric]) =>
    validateMetric(repository.id, metricId, metric, definitionIds, sourceMap)
  );
  return [...errors, ...sourceErrors, ...missingMetricErrors, ...metricErrors];
}

function validateMetric(repositoryId, metricId, metric, definitionIds, sourceMap) {
  const prefix = `${repositoryId}/${metricId}`;
  const definition = METRIC_DEFINITIONS.find((entry) => entry.id === metricId);
  return compactErrors([
    errorUnless(definitionIds.has(metricId), `${repositoryId}: unknown metric ${metricId}.`),
    errorUnless(isMetricStatus(metric.status), `${prefix}: invalid status.`),
    errorUnless(hasValidMetricValue(metric), `${prefix}: metric value does not match status.`),
    errorUnless(metricMatchesDefinition(metric, definition), `${prefix}: metric value, unit, or ratio fields violate its definition.`),
    errorUnless(metricSourcesSupportDefinition(metricId, metric, definition, sourceMap), `${prefix}: sources do not support the metric state or definition.`),
    errorUnless(metric.denominator !== 0, `${prefix}: zero denominator is forbidden.`),
  ]);
}

function validateDatasetIntegrity(dataset) {
  const expectedDigest = dataset?.integrity?.digest;
  if (!isSha256(expectedDigest)) return ["Integrity digest is invalid."];
  const unsigned = structuredClone(dataset);
  delete unsigned.integrity;
  return digestCanonical(unsigned) === expectedDigest ? [] : ["Integrity digest does not match canonical dataset."];
}

function validWindow(window) {
  return isDateTime(window?.since) && isDateTime(window?.until);
}

function hasCompleteDefinitions(definitions) {
  return Array.isArray(definitions) && canonicalJson(definitions) === canonicalJson(METRIC_DEFINITIONS);
}

function hasRepositoryIdentity(repository) {
  return Boolean(repository?.id) && Boolean(repository?.canonicalRepositoryId);
}

function hasCanonicalSources(sources) {
  const ids = sources.map((source) => source.id);
  const systems = sources.map((source) => source.system);
  return sources.length === DECLARED_SOURCE_SYSTEMS.length
    && new Set(ids).size === ids.length
    && canonicalJson([...systems].sort()) === canonicalJson([...DECLARED_SOURCE_SYSTEMS].sort());
}

function hasValidRepositoryRevision(repository, sourceMap, observedAt) {
  const gitSource = [...sourceMap.values()].find((source) => source.system === "git");
  if (gitSource?.status === "available") {
    return [
      isCommitOid(repository.headCommit),
      isDateTime(repository.headCommittedAt),
      isNonEmptyString(repository.branch),
      isDateTime(observedAt) && Date.parse(repository.headCommittedAt) <= Date.parse(observedAt),
    ].every(Boolean);
  }
  return [
    repository.headCommit === null,
    repository.headCommittedAt === null,
    repository.branch === null,
  ].every(Boolean);
}

function validateSourceProvenance(repositoryId, source, observedAt) {
  const prefix = `${repositoryId}/${source.id}`;
  const validators = {
    available: validateAvailableSource,
    unavailable: validateUnavailableSource,
    blocked: validateUnavailableSource,
  };
  return [
    errorUnless(Date.parse(source.observedAt) <= Date.parse(observedAt), `${prefix}: source observation is newer than the dataset.`),
    ...validators[source.status](prefix, source),
  ].filter(Boolean);
}

function validateAvailableSource(prefix, source) {
  return compactErrors([
    errorUnless(isNonEmptyString(source.sourceVersion), `${prefix}: available source requires a version.`),
    errorUnless(providerSourceVersionSafe(source), `${prefix}: provider version contains unsafe detail.`),
    errorUnless(isSha256(source.contentDigest), `${prefix}: available source requires a content digest.`),
    errorUnless(source.reason === null, `${prefix}: available source cannot have a reason.`),
  ]);
}

function providerSourceVersionSafe(source) {
  if (!["plane", "github", "github-actions"].includes(source.system)) return true;
  return isSafeProviderVersion(source.sourceVersion);
}

function validateUnavailableSource(prefix, source) {
  return compactErrors([
    errorUnless(source.contentDigest === null, `${prefix}: unavailable source cannot have a content digest.`),
    errorUnless(isNonEmptyString(source.reason), `${prefix}: unavailable source requires a reason.`),
    errorUnless(providerSourceReasonSafe(source), `${prefix}: provider reason contains unsafe detail.`),
  ]);
}

function providerSourceReasonSafe(source) {
  if (!["plane", "github", "github-actions"].includes(source.system)) return true;
  return isSafeProviderReason(source.reason);
}

function isMetricStatus(status) {
  return ["measured", "unavailable", "not_applicable"].includes(status);
}

function hasValidMetricValue(metric) {
  return metric.status === "measured" ? metric.value !== null : metric.value === null;
}

function metricMatchesDefinition(metric, definition) {
  if (!definition) return false;
  if (metric.unit !== definition.unit) return false;
  if (metric.status !== "measured") return isEmptyMetricValue(metric);
  return MEASURED_METRIC_VALIDATORS[definition.unit](metric);
}

const MEASURED_METRIC_VALIDATORS = Object.freeze({
  boolean: (metric) =>
    typeof metric.value === "boolean" && hasNoRatioFields(metric),
  count: (metric) =>
    Number.isInteger(metric.value) && metric.value >= 0 && hasNoRatioFields(metric),
  ratio: (metric) => [
    isBoundedRatio(metric.value),
    isNonNegativeFinite(metric.numerator),
    Number.isInteger(metric.denominator),
    metric.denominator > 0,
    metric.numerator <= metric.denominator,
    ratioMatchesFraction(metric),
  ].every(Boolean),
  hours: (metric) =>
    isNonNegativeFinite(metric.value)
      && metric.numerator === null
      && Number.isInteger(metric.denominator)
      && metric.denominator > 0,
});

function isEmptyMetricValue(metric) {
  return metric.value === null && hasNoRatioFields(metric);
}

function hasNoRatioFields(metric) {
  return metric.numerator === null && metric.denominator === null;
}

function isBoundedRatio(value) {
  return isNonNegativeFinite(value) && value <= 1;
}

function ratioMatchesFraction(metric) {
  if (!Number.isFinite(metric.numerator) || !Number.isFinite(metric.denominator)) return false;
  return Math.abs(metric.value - (metric.numerator / metric.denominator)) <= 1e-12;
}

function metricSourcesSupportDefinition(metricId, metric, definition, sourceMap) {
  if (!definition) return false;
  const sources = asArray(metric.sourceIds).map((sourceId) => sourceMap.get(sourceId));
  return [
    sources.length > 0,
    new Set(metric.sourceIds).size === metric.sourceIds.length,
    sources.every(Boolean),
    sources.every((source) => definition.sourceSystems.includes(source?.system)),
    hasEveryRequiredSourceSystem(sources, definition.sourceSystems),
    metricSourceAvailabilityMatches(metricId, metric, sources),
  ].every(Boolean);
}

function hasEveryRequiredSourceSystem(sources, requiredSystems) {
  const observedSystems = new Set(sources.map((source) => source?.system));
  return requiredSystems.every((system) => observedSystems.has(system));
}

function metricSourceAvailabilityMatches(metricId, metric, sources) {
  return AVAILABILITY_METRICS.has(metricId)
    ? availabilityMetricMatchesSources(metric, sources)
    : metric.status !== "measured" || sources.every((source) => source?.status === "available");
}

function availabilityMetricMatchesSources(metric, sources) {
  const availableCount = sources.filter((source) => source?.status === "available").length;
  return [
    metric.status === "measured",
    metric.numerator === availableCount,
    metric.denominator === sources.length,
  ].every(Boolean);
}

export function renderAnalyticsReport(dataset) {
  validateAnalyticsDataset(dataset);
  const lines = [
    `# ${dataset.id}`,
    "",
    `Observed: ${dataset.observedAt}`,
    `Window: ${dataset.window.since} to ${dataset.window.until}`,
    `Dataset digest: \`${dataset.integrity.digest}\``,
    "",
    "## Interpretation Boundary",
    "",
    "Repository rows describe evidence coverage and delivery-system behavior. They do not rank developers, infer user value from commit volume, or compare incompatible missing denominators.",
    "",
    "## Repository Baseline",
    "",
    "| Repository | Head | Commits | Validations | Pass rate | Cost coverage | Entire checkpoints | Evidence coverage | Adoption | Dirty |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...dataset.repositories.map(renderRepositoryRow),
    "",
    ...renderDeliveryTrace(dataset.repositories),
    "",
    "## Missing Evidence",
    "",
    ...dataset.repositories.flatMap(renderMissingEvidence),
    "## Metric Definitions",
    "",
    ...dataset.metricDefinitions.map((definition) =>
      `- \`${definition.id}\` (${definition.unit}): ${definition.definition} Missing: ${definition.missingSemantics}`
    ),
    "",
    "## Provenance",
    "",
    ...dataset.repositories.flatMap(renderRepositoryProvenance),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderRepositoryRow(repository) {
  return [
    `| ${repository.canonicalRepositoryId}`,
    repository.headCommit ? `\`${repository.headCommit.slice(0, 12)}\`` : "unknown",
    display(repository.metrics.commitCount),
    display(repository.metrics.validationAttemptCount),
    display(repository.metrics.validationPassRate),
    display(repository.metrics.costTelemetryCoverage),
    display(repository.metrics.entireCheckpointCount),
    display(repository.metrics.evidenceCompleteness),
    display(repository.metrics.repositoryAdoption),
    display(repository.metrics.worktreeDirty),
  ].join(" | ") + " |";
}

function renderDeliveryTrace(repositories) {
  const changes = repositories.flatMap((repository) =>
    repository.deliveryChanges.map((change) => ({ repository: repository.canonicalRepositoryId, ...change }))
  );
  if (changes.length === 0) return ["## Delivery Change Trace", "", "No sanitized provider changes supplied; linked delivery metrics remain unknown."];
  return [
    "## Delivery Change Trace",
    "",
    "| Repository | Change | Link basis | Plane | PR | Head | Exact validation | Hosted CI | Merged | Released |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
    ...changes.map(renderDeliveryChangeRow),
  ];
}

function renderDeliveryChangeRow(change) {
  return `| ${change.repository} | ${change.id} | ${change.linkBasis} | ${fallback(change.planeStoryId, "unknown")} | ${fallback(change.pullRequestNumber, "unknown")} | \`${change.headCommit.slice(0, 12)}\` | ${change.validationStatus} | ${change.hostedStatus} | ${fallback(change.mergedAt, "unknown")} | ${fallback(change.releasedAt, "unknown")} |`;
}

function renderMissingEvidence(repository) {
  const missing = repository.sources.filter((source) => source.status !== "available");
  const details = missing.length === 0
    ? ["None."]
    : missing.map((source) => `- ${source.system}: ${source.status} — ${source.reason}`);
  return [`### ${repository.canonicalRepositoryId}`, "", ...details, ""];
}

function renderRepositoryProvenance(repository) {
  return [
    `### ${repository.canonicalRepositoryId}`,
    "",
    repository.headCommit
      ? `- HEAD: \`${repository.headCommit}\` at ${repository.headCommittedAt}`
      : "- HEAD: unavailable",
    ...repository.sources.map((source) =>
      `- ${source.system}: ${source.status}; version ${source.sourceVersion ?? "unknown"}; digest ${source.contentDigest ?? "unavailable"}`
    ),
    "",
  ];
}

async function collectRepositorySafely(input) {
  try {
    return await collectRepository(input);
  } catch {
    return failedRepository(input.id, input.observedAt);
  }
}

function failedRepository(id, observedAt) {
  const reason = "Local Git repository is missing, unreadable, or invalid.";
  const sources = DECLARED_SOURCE_SYSTEMS.map((system) => blockedSource({
    id: `${id}:${system}`,
    system,
    observedAt,
    sourceVersion: null,
    reason,
  }));
  return {
    id,
    canonicalRepositoryId: `unavailable/${id}`,
    headCommit: null,
    headCommittedAt: null,
    branch: null,
    sources,
    metrics: unavailableRepositoryMetrics(sources, reason),
    deliveryChanges: [],
  };
}

function unavailableRepositoryMetrics(sources, reason) {
  const bySystem = new Map(sources.map((source) => [source.system, source]));
  const metrics = Object.fromEntries(METRIC_DEFINITIONS.map((definition) => [
    definition.id,
    missing(definition.unit, definition.sourceSystems.map((system) => bySystem.get(system).id), reason),
  ]));
  metrics.evidenceCompleteness = measured(0, "ratio", sources.map((source) => source.id), 0, sources.length);
  const nativeSources = ["tabellio-validation", "tabellio-review", "entire"].map((system) => bySystem.get(system));
  metrics.repositoryAdoption = measured(0, "ratio", nativeSources.map((source) => source.id), 0, nativeSources.length);
  return metrics;
}

async function collectRepository({ id, path, providerSnapshot, observedAt, since, until }) {
  const repositoryPath = await realpath(path);
  const [head, committedAt, branch, remote, status, commits] = await Promise.all([
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, ["show", "-s", "--format=%cI", "HEAD"]),
    git(repositoryPath, ["branch", "--show-current"]),
    git(repositoryPath, ["remote", "get-url", "origin"], [0, 2]),
    git(repositoryPath, ["status", "--porcelain=v1"]),
    git(repositoryPath, ["rev-list", "--count", `--since-as-filter=${since}`, `--until=${until}`, "HEAD"]),
  ]);
  assertHeadObserved(committedAt, observedAt);
  const canonicalRepositoryId = canonicalRepositoryIdentity(remote, id);
  const validationRecordValidator = repositoryControlValidator(canonicalRepositoryId, validateValidationResult);
  const reviewRecordValidator = repositoryControlValidator(
    canonicalRepositoryId,
    (cycle) => validateReviewCycle(cycle, { allowLegacyUnknownMergeabilityReady: true }),
  );
  const gitSource = availableSource({
    id: `${id}:git`,
    system: "git",
    observedAt,
    sourceVersion: head,
    content: JSON.stringify({ head, committedAt, branch, status, commits }),
  });
  const validation = await collectJsonRef(repositoryPath, {
    id: `${id}:tabellio-validation`,
    system: "tabellio-validation",
    ref: "refs/tabellio/validations",
    observedAt,
    include: (name) => name.endsWith(".json"),
    validate: validationRecordValidator,
  });
  const review = await collectJsonRef(repositoryPath, {
    id: `${id}:tabellio-review`,
    system: "tabellio-review",
    ref: "refs/tabellio/reviews",
    observedAt,
    include: (name) => name.endsWith(".json"),
    validate: reviewRecordValidator,
  });
  const entire = await collectEntireMetadata(repositoryPath, { id: `${id}:entire`, observedAt });
  const providerSnapshotResult = await collectProviderSnapshot({ id, canonicalRepositoryId, providerSnapshot, observedAt });
  const provider = reconcileProviderChanges(providerSnapshotResult, validation.values);
  const sources = [gitSource, validation.source, review.source, entire.source, ...provider.sources];
  const metrics = buildRepositoryMetrics({
    commits,
    status,
    since,
    until,
    gitSource,
    validation,
    review,
    entire,
    provider,
    sources,
  });
  return {
    id,
    canonicalRepositoryId,
    headCommit: head,
    headCommittedAt: committedAt,
    branch: fallback(branch, "(detached)"),
    sources,
    metrics,
    deliveryChanges: provider.changes,
  };
}

function assertHeadObserved(committedAt, observedAt) {
  const valid = isDateTime(committedAt) && Date.parse(committedAt) <= Date.parse(observedAt);
  if (!valid) throw new Error("Repository HEAD commit is newer than the observation time.");
}

function canonicalRepositoryIdentity(remote, id) {
  const githubRepository = parseGitHubRepositoryRemote(remote);
  if (githubRepository) return githubRepository.fullName;
  return remote ? normalizeRepositoryRemote(remote) : `local/${id}`;
}

function repositoryControlValidator(canonicalRepositoryId, validate) {
  return (value) => validateRepositoryControlRecord(value, canonicalRepositoryId, validate);
}

function validateRepositoryControlRecord(value, canonicalRepositoryId, validate) {
  validate(value);
  if (!repositoryIdsMatch(value?.repository?.id, canonicalRepositoryId)) {
    throw new Error("Control record repository identity mismatch.");
  }
}

function repositoryIdsMatch(left, right) {
  return comparableRepositoryId(left) === comparableRepositoryId(right);
}

function comparableRepositoryId(value) {
  return String(value ?? "")
    .trim()
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function buildRepositoryMetrics({ commits, status, since, until, gitSource, validation, review, entire, provider, sources }) {
  const terminalValidations = validation.values.filter((value) =>
    isTerminalValidationInWindow(value, since, until)
  );
  const passedValidations = terminalValidations.filter((value) => value.status === "passed");
  const costComplete = terminalValidations.filter(validationCostComplete);
  const reviewFindings = review.values.reduce((count, value) => count + arrayLength(value.feedback), 0);
  const repairs = review.values.reduce((count, value) => count + arrayLength(value.fixes), 0);
  const availableCount = sources.filter((source) => source.status === "available").length;
  const nativeSources = [validation.source, review.source, entire.source];
  const nativeAvailable = nativeSources.filter((source) => source.status === "available").length;
  const changes = provider.changes;
  const traced = changes.filter(hasTaskAndPullRequest);
  const leadTimes = changes.flatMap((change) => durationHours(change.storyCreatedAt, change.mergedAt));
  const cycleTimes = changes.flatMap((change) => durationHours(change.firstActivityAt, change.mergedAt));
  const releaseLags = changes.flatMap((change) => durationHours(change.mergedAt, change.releasedAt));
  const ciComparisons = changes.flatMap((change) =>
    exactCiComparison(change, validation.values)
  );
  const ciDisagreements = ciComparisons.filter((comparison) =>
    comparison.validationStatus !== comparison.hostedStatus
  );
  const providerSourceIds = provider.sources.slice(0, 2).map((source) => source.id);
  return {
    commitCount: measured(Number(commits), "count", [gitSource.id]),
    validationAttemptCount: availabilityCount(validation.source, terminalValidations.length, "count"),
    validationPassRate: ratioMetric(validation.source, passedValidations.length, terminalValidations.length),
    costTelemetryCoverage: ratioMetric(validation.source, costComplete.length, terminalValidations.length),
    entireCheckpointCount: availabilityCount(entire.source, entire.count, "count"),
    reviewFindingCount: availabilityCount(review.source, reviewFindings, "count"),
    repairCount: availabilityCount(review.source, repairs, "count"),
    worktreeDirty: measured(status.length > 0, "boolean", [gitSource.id]),
    evidenceCompleteness: measured(availableCount / DECLARED_SOURCE_SYSTEMS.length, "ratio", sources.map((source) => source.id), availableCount, DECLARED_SOURCE_SYSTEMS.length),
    deliveryChangeCount: providerMetric(provider, measured(changes.length, "count", providerSourceIds), "count", providerSourceIds),
    taskToPrTraceability: providerMetric(provider, ratioOrMissing(traced.length, changes.length, "ratio", providerSourceIds, "No eligible delivery changes in the provider snapshot."), "ratio", providerSourceIds),
    leadTimeHours: providerMetric(provider, averageOrMissing(leadTimes, "hours", providerSourceIds, "No linked story creation and merge timestamps."), "hours", providerSourceIds),
    cycleTimeHours: providerMetric(provider, averageOrMissing(cycleTimes, "hours", [gitSource.id, ...providerSourceIds], "No linked first-activity and merge timestamps."), "hours", [gitSource.id, ...providerSourceIds]),
    ciDisagreementRate: sourceMetric([validation.source, provider.sources[2]], ratioOrMissing(ciDisagreements.length, ciComparisons.length, "ratio", [validation.source.id, provider.sources[2].id], "No candidates have both hosted and exact validation outcomes."), "ratio"),
    releaseLagHours: sourceMetric([provider.sources[1]], averageOrMissing(releaseLags, "hours", [provider.sources[1].id], "No linked merge and release timestamps."), "hours"),
    repositoryAdoption: measured(nativeAvailable / nativeSources.length, "ratio", nativeSources.map((source) => source.id), nativeAvailable, nativeSources.length),
  };
}

function providerMetric(provider, availableMetric, unit, sourceIds) {
  return provider.available ? availableMetric : missing(unit, sourceIds, provider.reason);
}

function sourceMetric(sources, availableMetric, unit) {
  const unavailable = sources.find((source) => source.status !== "available");
  return unavailable
    ? missing(unit, sources.map((source) => source.id), unavailable.reason)
    : availableMetric;
}

function isTerminalValidationInWindow(value, since, until) {
  return isOutcomeStatus(value?.status) && value.status !== "unavailable" && inWindow(value.completedAt, since, until);
}

function hasTaskAndPullRequest(change) {
  return change.linkBasis !== "unlinked"
    && Boolean(change.planeStoryId)
    && Boolean(change.pullRequestNumber);
}

function exactCiComparison(change, validations) {
  if (!isComparableStatus(change.hostedStatus)) return [];
  const matches = validations.filter((validation) =>
    validation?.revision?.headCommit === change.headCommit
      && isComparableStatus(validation.status)
  );
  if (matches.length !== 1) return [];
  return [{
    validationStatus: matches[0].status,
    hostedStatus: change.hostedStatus,
  }];
}

function reconcileProviderChanges(provider, validations) {
  const actionsAvailable = provider.sources[2].status === "available";
  return {
    ...provider,
    changes: provider.changes.map((change) => ({
      ...change,
      validationStatus: exactValidationStatus(change, validations),
      hostedStatus: actionsAvailable ? change.hostedStatus : "unavailable",
    })),
  };
}

function exactValidationStatus(change, validations) {
  const matches = validations.filter((validation) =>
    validation?.revision?.headCommit === change.headCommit
      && isComparableStatus(validation.status)
  );
  return matches.length === 1 ? matches[0].status : "unavailable";
}

function isComparableStatus(value) {
  return ["passed", "failed", "blocked"].includes(value);
}

async function collectProviderSnapshot({ id, canonicalRepositoryId, providerSnapshot, observedAt }) {
  if (!providerSnapshot) {
    return providerFailure({
      id,
      observedAt,
      reason: "No sanitized provider snapshot supplied to the read-only collector.",
      status: "unavailable",
    });
  }
  const loaded = await readProviderSnapshot(providerSnapshot);
  if (loaded.error) return unreadableProviderFailure({ id, observedAt });
  return collectLoadedProviderSnapshot({ id, canonicalRepositoryId, observedAt, snapshot: loaded.value });
}

function unreadableProviderFailure({ id, observedAt }) {
  return providerFailure({
    id,
    observedAt,
    status: "blocked",
    reason: "Provider snapshot is missing, unreadable, or malformed.",
  });
}

function collectLoadedProviderSnapshot({ id, canonicalRepositoryId, observedAt, snapshot }) {
  const errors = validateProviderSnapshot(snapshot, canonicalRepositoryId, observedAt);
  if (errors.length > 0) {
    return providerFailure({
      id,
      observedAt,
      status: "blocked",
      sourceVersion: fallback(snapshot?.capturedAt, null),
      reason: `Provider snapshot is invalid (${errors.length} validation errors).`,
    });
  }
  return buildProviderResult({ id, snapshot });
}

function buildProviderResult({ id, snapshot }) {
  const sources = ["plane", "github", "github-actions"].map((system) =>
    buildProviderSource({ id, system, snapshot })
  );
  const available = providerRequiredSourcesAvailable(sources);
  const githubAvailable = sources[1].status === "available";
  const planeAvailable = sources[0].status === "available";
  return {
    available,
    reason: providerMissingReason(sources),
    changes: githubAvailable
      ? snapshot.deliveryChanges.map((change) => planeAvailable ? change : redactPlaneEvidence(change))
      : [],
    sources,
  };
}

function redactPlaneEvidence(change) {
  return {
    ...change,
    linkBasis: "unlinked",
    linkEvidence: null,
    planeStoryId: null,
    storyCreatedAt: null,
  };
}

function providerRequiredSourcesAvailable(sources) {
  return sources[0].status === "available" && sources[1].status === "available";
}

function providerMissingReason(sources) {
  const missing = sources.find((source) => source.status !== "available");
  return missing ? missing.reason : null;
}

async function readProviderSnapshot(path) {
  try {
    return { value: JSON.parse(await readFile(await realpath(path), "utf8")), error: null };
  } catch {
    return { value: null, error: true };
  }
}

function buildProviderSource({ id, system, snapshot }) {
  const source = snapshot.sources[system];
  if (source.status !== "available") {
    return unavailableSource({
      id: `${id}:${system}`,
      system,
      observedAt: snapshot.capturedAt,
      reason: source.reason,
    });
  }
  return availableSource({
    id: `${id}:${system}`,
    system,
    observedAt: snapshot.capturedAt,
    sourceVersion: source.version,
    content: JSON.stringify({
      capturedAt: snapshot.capturedAt,
      source,
      changes: snapshot.deliveryChanges.map((change) => providerProjection(change, system)),
    }),
  });
}

function providerFailure({ id, observedAt, reason, status, sourceVersion = null }) {
  const factory = status === "blocked" ? blockedSource : unavailableSource;
  return {
    available: false,
    reason,
    changes: [],
    sources: ["plane", "github", "github-actions"].map((system) => factory({
      id: `${id}:${system}`,
      system,
      observedAt,
      sourceVersion,
      reason,
    })),
  };
}

function validateProviderSnapshot(snapshot, canonicalRepositoryId, observedAt) {
  const sourceErrors = ["plane", "github", "github-actions"].flatMap((system) =>
    validateProviderSource(system, snapshot?.sources?.[system], snapshot?.capturedAt)
  );
  const changeErrors = asArray(snapshot?.deliveryChanges).flatMap((change) =>
    validateDeliveryChange(change, snapshot?.capturedAt)
  );
  return [
    ...validateProviderHeader(snapshot, canonicalRepositoryId, observedAt),
    ...sourceErrors,
    ...changeErrors,
    ...duplicateDeliveryChangeErrors(snapshot?.deliveryChanges),
  ];
}

function duplicateDeliveryChangeErrors(changes) {
  const ids = asArray(changes)
    .map((change) => change?.id)
    .filter(isNonEmptyString);
  return duplicateValues(ids).map((id) => `Duplicate delivery change id: ${id}.`);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateProviderHeader(snapshot, canonicalRepositoryId, observedAt) {
  return compactErrors([
    ...unexpectedFieldErrors(snapshot, PROVIDER_SNAPSHOT_FIELDS, "Provider snapshot"),
    errorUnless(hasProviderSchema(snapshot), "Unsupported schemaVersion."),
    errorUnless(hasProviderRepository(snapshot, canonicalRepositoryId), "Repository identity mismatch."),
    errorUnless(hasProviderCaptureTime(snapshot), "capturedAt is invalid."),
    errorUnless(providerCaptureNotAfter(snapshot, observedAt), "capturedAt is newer than observedAt."),
    errorUnless(hasProviderCollections(snapshot), "sources and deliveryChanges are required."),
  ]);
}

function hasProviderSchema(snapshot) {
  return snapshot?.schemaVersion === "tabellio-analytics-provider-snapshot/v0.1";
}

function hasProviderRepository(snapshot, canonicalRepositoryId) {
  return repositoryIdsMatch(snapshot?.repository, canonicalRepositoryId);
}

function hasProviderCaptureTime(snapshot) {
  return isDateTime(snapshot?.capturedAt);
}

function providerCaptureNotAfter(snapshot, observedAt) {
  return dateNotAfter(snapshot?.capturedAt, observedAt);
}

function validateProviderSource(system, source, observedAt) {
  return compactErrors([
    ...unexpectedFieldErrors(source, PROVIDER_SOURCE_FIELDS, `${system} source`),
    errorUnless(isProviderSource(source), `${system} source is invalid.`),
    errorUnless(providerSourceHasVersion(source), `${system} source version is required.`),
    errorUnless(providerSourceHasReason(source), `${system} unavailable reason is required.`),
    errorUnless(versionNotAfter(source?.version, observedAt), `${system} source version is newer than observedAt.`),
  ]);
}

function validateDeliveryChange(change, capturedAt) {
  if (!isPlainObject(change)) return ["Delivery change must be an object."];
  const changeId = isNonEmptyString(change.id) ? change.id : "delivery change";
  const dateErrors = ["storyCreatedAt", "firstActivityAt", "mergedAt", "releasedAt"]
    .map((field) => errorUnless(isNullableDateTime(change[field]), `${changeId}: ${field} is invalid.`));
  return compactErrors([
    ...unexpectedFieldErrors(change, DELIVERY_CHANGE_FIELDS, changeId),
    errorUnless(isSafeProviderText(change.id) && isCommitOid(change.headCommit), "Delivery change identity is invalid."),
    errorUnless(isLinkBasis(change.linkBasis), `${changeId}: linkBasis is invalid.`),
    errorUnless(isNullableString(change.linkEvidence), `${changeId}: linkEvidence is invalid.`),
    errorUnless(isLinkEvidence(change), `${changeId}: linkEvidence is required for reconciled links.`),
    errorUnless(isSafeLinkEvidence(change), `${changeId}: linkEvidence contains unsafe detail.`),
    errorUnless(isNullableSafeProviderText(change.planeStoryId), `${changeId}: planeStoryId is invalid.`),
    errorUnless(isNullablePositiveInteger(change.pullRequestNumber), `${changeId}: pullRequestNumber is invalid.`),
    ...dateErrors,
    errorUnless(hasCoherentDeliveryLifecycle(change), `${changeId}: delivery lifecycle ordering is invalid.`),
    errorUnless(deliveryDatesNotAfter(change, capturedAt), `${changeId}: delivery timestamp is newer than capturedAt.`),
    errorUnless(isOutcomeStatus(change.validationStatus), `${changeId}: validationStatus is invalid.`),
    errorUnless(isOutcomeStatus(change.hostedStatus), `${changeId}: hostedStatus is invalid.`),
  ]);
}

function hasCoherentDeliveryLifecycle(change) {
  return [
    orderedDates(change.storyCreatedAt, change.firstActivityAt),
    orderedDates(change.storyCreatedAt, change.mergedAt),
    orderedDates(change.firstActivityAt, change.mergedAt),
    orderedDates(change.mergedAt, change.releasedAt),
  ].every(Boolean);
}

function deliveryDatesNotAfter(change, capturedAt) {
  return ["storyCreatedAt", "firstActivityAt", "mergedAt", "releasedAt"]
    .every((field) => dateNotAfter(change[field], capturedAt));
}

function orderedDates(earlier, later) {
  return earlier === null || later === null || Date.parse(earlier) <= Date.parse(later);
}

function versionNotAfter(version, observedAt) {
  return !isDateTime(version) || dateNotAfter(version, observedAt);
}

function dateNotAfter(value, upperBound) {
  return !isDateTime(value) || !isDateTime(upperBound) || Date.parse(value) <= Date.parse(upperBound);
}

function hasProviderCollections(snapshot) {
  return Boolean(snapshot?.sources) && Array.isArray(snapshot?.deliveryChanges);
}

function isProviderSource(source) {
  return Boolean(source) && ["available", "unavailable"].includes(source.status);
}

function providerSourceHasVersion(source) {
  return source?.status !== "available" || isNonEmptyString(source.version);
}

function providerSourceHasReason(source) {
  return source?.status !== "unavailable" || isSafeProviderReason(source.reason);
}

function isSafeProviderReason(reason) {
  return isSafeProviderText(reason);
}

function isSafeLinkEvidence(change) {
  return change.linkEvidence === null || isSafeProviderText(change.linkEvidence);
}

function isSafeProviderText(value) {
  if (!isNonEmptyString(value) || value.length > 300) return false;
  return !/[\\/]/.test(value) && !hasCredentialShape(value);
}

function isSafeProviderVersion(value) {
  return [
    isNonEmptyString(value),
    value?.length <= 300,
    !hasCredentialShape(value),
    providerVersionShapeSafe(value),
  ].every(Boolean);
}

function providerVersionShapeSafe(value) {
  return isHttpEntityTag(value) || !/[\\/]/.test(value);
}

function isHttpEntityTag(value) {
  return /^(?:W\/)?"[^"\\\r\n]*"$/.test(value);
}

function hasCredentialShape(value) {
  return /(?:bearer\s|github_pat_|ghp_|(?:password|token|secret)\s*[=:])/i.test(value);
}

function isNullableDateTime(value) {
  return value === null || isDateTime(value);
}

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
}

function isNullableSafeProviderText(value) {
  return value === null || isSafeProviderText(value);
}

function isNullablePositiveInteger(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unexpectedFieldErrors(value, allowedFields, label) {
  if (!isPlainObject(value)) return [];
  const allowed = new Set(allowedFields);
  return Object.keys(value)
    .filter((field) => !allowed.has(field))
    .map((field) => `${label}: unexpected field ${field}.`);
}

function isOutcomeStatus(value) {
  return ["passed", "failed", "blocked", "unavailable"].includes(value);
}

function isLinkBasis(value) {
  return ["explicit", "manual-reconciliation", "unlinked"].includes(value);
}

function isLinkEvidence(change) {
  return change.linkBasis === "manual-reconciliation" ? Boolean(change.linkEvidence) : true;
}

function providerProjection(change, system) {
  if (system === "plane") return { id: change.id, linkBasis: change.linkBasis, linkEvidence: change.linkEvidence, planeStoryId: change.planeStoryId, storyCreatedAt: change.storyCreatedAt };
  if (system === "github-actions") return { id: change.id, headCommit: change.headCommit, hostedStatus: change.hostedStatus };
  return {
    id: change.id,
    pullRequestNumber: change.pullRequestNumber,
    firstActivityAt: change.firstActivityAt,
    mergedAt: change.mergedAt,
    releasedAt: change.releasedAt,
    headCommit: change.headCommit,
  };
}

async function collectJsonRef(repositoryPath, { id, system, ref, observedAt, include, validate }) {
  const exists = await runGit({
    cwd: repositoryPath,
    args: ["show-ref", "--verify", "--quiet", ref],
    acceptableExitCodes: [0, 1],
  });
  if (exists.exitCode !== 0) {
    return { source: unavailableSource({ id, system, observedAt, reason: `${ref} is absent.` }), values: [] };
  }
  const version = await git(repositoryPath, ["rev-parse", ref]);
  const names = (await git(repositoryPath, ["ls-tree", "-r", "--name-only", version]))
    .split("\n").filter((name) => name && include(name)).sort();
  const values = [];
  const canonical = [];
  for (const name of names) {
    const raw = await git(repositoryPath, ["show", `${version}:${name}`]);
    const record = parseControlRecord(raw, validate);
    if (record.error) {
      return {
        source: blockedSource({ id, system, observedAt, sourceVersion: version, reason: `${record.error} at ${name}.` }),
        values: [],
      };
    }
    values.push(record.value);
    canonical.push([name, record.value]);
  }
  return {
    source: availableSource({ id, system, observedAt, sourceVersion: version, content: JSON.stringify(canonical) }),
    values,
  };
}

async function collectEntireMetadata(repositoryPath, { id, observedAt }) {
  const controlRemote = await configuredControlRemote(repositoryPath);
  const candidates = [
    "refs/heads/entire/checkpoints/v1",
    ...(controlRemote ? [`refs/remotes/${controlRemote}/entire/checkpoints/v1`] : []),
  ];
  for (const ref of candidates) {
    const exists = await runGit({
      cwd: repositoryPath,
      args: ["show-ref", "--verify", "--quiet", ref],
      acceptableExitCodes: [0, 1],
    });
    if (exists.exitCode !== 0) continue;
    const version = await git(repositoryPath, ["rev-parse", ref]);
    const names = (await git(repositoryPath, ["ls-tree", "-r", "--name-only", version]))
      .split("\n")
      .filter((name) => /^[^/]+\/[^/]+\/metadata\.json$/.test(name))
      .sort();
    return {
      source: availableSource({ id, system: "entire", observedAt, sourceVersion: version, content: JSON.stringify(names) }),
      count: names.length,
    };
  }
  return {
    source: unavailableSource({ id, system: "entire", observedAt, reason: "Entire metadata checkpoint ref is absent." }),
    count: 0,
  };
}

function parseControlRecord(raw, validate) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { value: null, error: "Malformed JSON" };
  }
  try {
    validate(value);
    return { value, error: null };
  } catch {
    return { value: null, error: "Schema-invalid JSON" };
  }
}

async function configuredControlRemote(repositoryPath) {
  try {
    const platform = JSON.parse(await readFile(`${repositoryPath}/tabellio.platform.json`, "utf8"));
    return safeControlRemote(platform?.workflow?.controlRemoteName);
  } catch {
    return null;
  }
}

function safeControlRemote(remote) {
  return typeof remote === "string" && /^[A-Za-z0-9._-]+$/.test(remote) ? remote : null;
}

async function git(cwd, args, acceptableExitCodes = [0]) {
  const result = await runGit({ cwd, args, acceptableExitCodes });
  return result.stdout.trim();
}

function validationCostComplete(result) {
  if (!Array.isArray(result?.validators)) return false;
  return result.validators.every((validator) => {
    if (!validator.required || validator.type === "static") return true;
    return validator.evidence?.report?.cost?.telemetry === "available";
  });
}

function defineMetric(id, unit, definition, sourceSystems, missingSemantics) {
  return Object.freeze({ id, unit, definition, sourceSystems, missingSemantics });
}

function availableSource({ id, system, observedAt, sourceVersion, content }) {
  return { id, system, status: "available", observedAt, sourceVersion, contentDigest: sha256(content), reason: null };
}

function unavailableSource({ id, system, observedAt, reason }) {
  return { id, system, status: "unavailable", observedAt, sourceVersion: null, contentDigest: null, reason };
}

function blockedSource({ id, system, observedAt, sourceVersion, reason }) {
  return { id, system, status: "blocked", observedAt, sourceVersion, contentDigest: null, reason };
}

function measured(value, unit, sourceIds, numerator = null, denominator = null) {
  return { status: "measured", value, unit, sourceIds, reason: null, numerator, denominator };
}

function missing(unit, sourceIds, reason) {
  return { status: "unavailable", value: null, unit, sourceIds, reason, numerator: null, denominator: null };
}

function availabilityCount(source, value, unit) {
  return source.status === "available" ? measured(value, unit, [source.id]) : missing(unit, [source.id], source.reason);
}

function ratioMetric(source, numerator, denominator) {
  if (source.status !== "available") return missing("ratio", [source.id], source.reason);
  if (denominator === 0) return missing("ratio", [source.id], "No eligible observations; denominator is unknown, not zero.");
  return measured(numerator / denominator, "ratio", [source.id], numerator, denominator);
}

function ratioOrMissing(numerator, denominator, unit, sourceIds, reason) {
  if (denominator === 0) return missing(unit, sourceIds, reason);
  return measured(numerator / denominator, unit, sourceIds, numerator, denominator);
}

function averageOrMissing(values, unit, sourceIds, reason) {
  if (values.length === 0) return missing(unit, sourceIds, reason);
  return measured(values.reduce((sum, value) => sum + value, 0) / values.length, unit, sourceIds, null, values.length);
}

function durationHours(start, end) {
  const duration = parseOptionalDate(end) - parseOptionalDate(start);
  return isNonNegativeFinite(duration) ? [duration / 3_600_000] : [];
}

function display(metric) {
  if (metric.status !== "measured") return "unknown";
  if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(1)}%`;
  return String(metric.value);
}

function digestCanonical(value) {
  return sha256(canonicalJson(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isDateTime(value) {
  return isJsonDateTime(value);
}

function parseOptionalDate(value) {
  return value ? Date.parse(value) : Number.NaN;
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function fallback(value, replacement) {
  return value || replacement;
}

function isCommitOid(value) {
  return /^[0-9a-f]{40,64}$/.test(value ?? "");
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(value ?? "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function errorUnless(condition, message) {
  return condition ? null : message;
}

function compactErrors(errors) {
  return errors.filter(Boolean);
}

function throwValidationErrors(errors) {
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

function assertDateRange({ observedAt, since, until }) {
  if (![observedAt, since, until].every(isDateTime)) throw new Error("observedAt, since, and until must be ISO date-times.");
  if (Date.parse(since) >= Date.parse(until)) throw new Error("Analytics window since must be before until.");
  if (Date.parse(observedAt) < Date.parse(until)) throw new Error("observedAt cannot precede the window end.");
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function inWindow(value, since, until) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(since) && timestamp <= Date.parse(until);
}
