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
const PROVIDER_SOURCE_SYSTEMS = Object.freeze(["plane", "github", "github-actions"]);
const PROVIDER_SOURCE_STATE_FIELDS = Object.freeze({
  available: Object.freeze(["status", "version"]),
  unavailable: Object.freeze(["reason", "status"]),
});

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
  assertUniqueCanonicalRepositories(collected);
  collected.sort((left, right) => compareCodePoints(left.id, right.id));
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
  if (!isSafeAnalyticsIdentifier(id)) throw new Error("Analytics collection requires a safe portable id.");
  if (!isNonEmptyArray(repositories)) throw new Error("Analytics collection requires an id and at least one repository.");
  const invalid = repositories.find(hasIncompleteRepositoryInput);
  if (invalid) throw new Error("Each repository requires a safe portable id and path.");
}

function hasIncompleteRepositoryInput(repository) {
  return !isSafeAnalyticsIdentifier(repository?.id) || !repository?.path;
}

function assertRequiredRepositories(inputs, collected) {
  const failed = inputs.find((input, index) =>
    input.required === true && collected[index]?.headCommit === null
  );
  if (failed) throw new Error(`Required repository ${failed.id} could not be collected.`);
}

function assertUniqueCanonicalRepositories(repositories) {
  const duplicate = duplicateValues(
    repositories.map((repository) => comparableRepositoryId(repository.canonicalRepositoryId)),
  )[0];
  if (duplicate) throw new Error(`Duplicate canonical repository: ${duplicate}.`);
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
    errorUnless(hasUniqueCanonicalRepositories(dataset), "Canonical repositories must be unique."),
    errorUnless(hasMetricDefinitions(dataset), "Metric definitions are incomplete."),
  ]);
}

function hasAnalyticsSchema(dataset) {
  return dataset?.schemaVersion === ANALYTICS_SCHEMA_VERSION;
}

function hasDatasetId(dataset) {
  return isSafeAnalyticsIdentifier(dataset?.id);
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

function hasUniqueCanonicalRepositories(dataset) {
  const identities = asArray(dataset?.repositories)
    .map((repository) => comparableRepositoryId(repository?.canonicalRepositoryId));
  return identities.every(isNonEmptyString) && new Set(identities).size === identities.length;
}

function hasMetricDefinitions(dataset) {
  return hasCompleteDefinitions(dataset?.metricDefinitions);
}

function validateRepositoryMetrics(repository, definitionIds, observedAt) {
  const sources = repository.sources ?? [];
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const deliveryObservedAt = providerObservationCutoff(sources, observedAt);
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
  const deliveryErrors = repository.deliveryChanges.flatMap((change) =>
    validateDeliveryChange(change, deliveryObservedAt)
  );
  const duplicateDeliveryErrors = duplicateDeliveryChangeErrors(repository.deliveryChanges);
  return [
    ...errors,
    ...sourceErrors,
    ...missingMetricErrors,
    ...metricErrors,
    ...deliveryErrors,
    ...duplicateDeliveryErrors,
  ];
}

function providerObservationCutoff(sources, fallback) {
  const providerTimes = sources
    .filter((source) => ["plane", "github", "github-actions"].includes(source?.system))
    .map((source) => source.observedAt)
    .filter(isDateTime)
    .map(Date.parse);
  return providerTimes.length === 0
    ? fallback
    : new Date(Math.min(...providerTimes)).toISOString();
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
  return isSafeAnalyticsIdentifier(repository?.id)
    && isSafeAnalyticsIdentifier(repository?.canonicalRepositoryId);
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
      gitSource.sourceVersion === repository.headCommit,
      isDateTime(repository.headCommittedAt),
      isSafeBranchName(repository.branch),
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
  const portableId = isSafeAnalyticsIdentifier(source.id);
  const prefix = portableId ? `${repositoryId}/${source.id}` : `${repositoryId}/source`;
  const validators = {
    available: validateAvailableSource,
    unavailable: validateUnavailableSource,
    blocked: validateUnavailableSource,
  };
  return [
    errorUnless(portableId, `${repositoryId}: source id is not portable.`),
    errorUnless(Date.parse(source.observedAt) <= Date.parse(observedAt), `${prefix}: source observation is newer than the dataset.`),
    ...validators[source.status](prefix, source),
  ].filter(Boolean);
}

function validateAvailableSource(prefix, source) {
  return compactErrors([
    errorUnless(isNonEmptyString(source.sourceVersion), `${prefix}: available source requires a version.`),
    errorUnless(gitBackedSourceVersionSafe(source), `${prefix}: Git-backed source version must be a commit OID.`),
    errorUnless(providerSourceVersionSafe(source), `${prefix}: provider version contains unsafe detail.`),
    errorUnless(providerSourceVersionNotAfterObservation(source), `${prefix}: provider version is newer than its observation.`),
    errorUnless(isSha256(source.contentDigest), `${prefix}: available source requires a content digest.`),
    errorUnless(source.reason === null, `${prefix}: available source cannot have a reason.`),
  ]);
}

function gitBackedSourceVersionSafe(source) {
  if (!["git", "tabellio-validation", "tabellio-review", "entire"].includes(source.system)) {
    return true;
  }
  return isCommitOid(source.sourceVersion);
}

function providerSourceVersionSafe(source) {
  if (!["plane", "github", "github-actions"].includes(source.system)) return true;
  return isSafeProviderVersion(source.sourceVersion);
}

function providerSourceVersionNotAfterObservation(source) {
  if (!["plane", "github", "github-actions"].includes(source.system)) return true;
  return versionNotAfter(source.sourceVersion, source.observedAt);
}

function validateUnavailableSource(prefix, source) {
  return compactErrors([
    errorUnless(source.contentDigest === null, `${prefix}: unavailable source cannot have a content digest.`),
    errorUnless(
      source.sourceVersion === null || gitBackedSourceVersionSafe(source),
      `${prefix}: Git-backed source version must be a commit OID.`,
    ),
    errorUnless(
      source.sourceVersion === null || providerSourceVersionSafe(source),
      `${prefix}: provider version contains unsafe detail.`,
    ),
    errorUnless(
      source.sourceVersion === null || providerSourceVersionNotAfterObservation(source),
      `${prefix}: provider version is newer than its observation.`,
    ),
    errorUnless(isNonEmptyString(source.reason), `${prefix}: unavailable source requires a reason.`),
    errorUnless(isSafeProviderReason(source.reason), `${prefix}: source reason contains unsafe detail.`),
  ]);
}

function isMetricStatus(status) {
  return ["measured", "unavailable"].includes(status);
}

function hasValidMetricValue(metric) {
  return metric.status === "measured" ? metric.value !== null : metric.value === null;
}

function metricMatchesDefinition(metric, definition) {
  if (!definition) return false;
  if (metric.unit !== definition.unit) return false;
  return metric.status === "measured"
    ? measuredMetricMatchesDefinition(metric, definition)
    : unavailableMetricMatchesDefinition(metric);
}

function measuredMetricMatchesDefinition(metric, definition) {
  return metric.reason === null && MEASURED_METRIC_VALIDATORS[definition.unit](metric);
}

function unavailableMetricMatchesDefinition(metric) {
  return isEmptyMetricValue(metric) && isSafeProviderReason(metric.reason);
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
    `# ${markdownText(dataset.id)}`,
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
    `| ${markdownText(repository.canonicalRepositoryId)}`,
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
  return `| ${markdownText(change.repository)} | ${markdownText(change.id)} | ${markdownText(change.linkBasis)} | ${markdownText(fallback(change.planeStoryId, "unknown"))} | ${markdownText(fallback(change.pullRequestNumber, "unknown"))} | \`${change.headCommit.slice(0, 12)}\` | ${markdownText(change.validationStatus)} | ${markdownText(change.hostedStatus)} | ${markdownText(fallback(change.mergedAt, "unknown"))} | ${markdownText(fallback(change.releasedAt, "unknown"))} |`;
}

function renderMissingEvidence(repository) {
  const missing = repository.sources.filter((source) => source.status !== "available");
  const details = missing.length === 0
    ? ["None."]
    : missing.map((source) => `- ${markdownText(source.system)}: ${markdownText(source.status)} — ${markdownText(source.reason)}`);
  return [`### ${markdownText(repository.canonicalRepositoryId)}`, "", ...details, ""];
}

function renderRepositoryProvenance(repository) {
  return [
    `### ${markdownText(repository.canonicalRepositoryId)}`,
    "",
    repository.headCommit
      ? `- HEAD: \`${repository.headCommit}\` at ${repository.headCommittedAt}`
      : "- HEAD: unavailable",
    ...repository.sources.map((source) =>
      `- ${markdownText(source.system)}: ${markdownText(source.status)}; version ${markdownText(source.sourceVersion ?? "unknown")}; digest ${markdownText(source.contentDigest ?? "unavailable")}`
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
  const isBare = await git(repositoryPath, ["rev-parse", "--is-bare-repository"]) === "true";
  const [head, committedAt, branch, remote, status, commits] = await Promise.all([
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, ["show", "-s", "--format=%cI", "HEAD"]),
    git(repositoryPath, ["branch", "--show-current"]),
    git(repositoryPath, ["remote", "get-url", "origin"], [0, 2]),
    isBare ? Promise.resolve(null) : git(repositoryPath, ["status", "--porcelain=v1"]),
    git(repositoryPath, ["rev-list", "--count", `--since-as-filter=${since}`, `--until=${until}`, "HEAD"]),
  ]);
  assertHeadObserved(committedAt, observedAt);
  const exportedBranch = fallback(branch, "(detached)");
  if (!isSafeBranchName(exportedBranch)) {
    throw new Error("Repository branch name contains unsafe detail.");
  }
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
    content: JSON.stringify({ head, committedAt, branch, isBare, status, commits }),
  });
  const validation = await collectJsonRef(repositoryPath, {
    id: `${id}:tabellio-validation`,
    system: "tabellio-validation",
    ref: "refs/tabellio/validations",
    observedAt,
    include: (name) => name.endsWith(".json"),
    validate: validationRecordValidator,
    identity: (record) => record.runId,
    pathMatches: validationControlPathMatches,
  });
  const review = await collectJsonRef(repositoryPath, {
    id: `${id}:tabellio-review`,
    system: "tabellio-review",
    ref: "refs/tabellio/reviews",
    observedAt,
    include: (name) => name.endsWith(".json"),
    validate: reviewRecordValidator,
    identity: reviewCycleIdentity,
    pathMatches: reviewControlPathMatches,
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
    branch: exportedBranch,
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
  const linkedChanges = changes.filter(hasTaskAndPullRequest);
  const leadTimes = linkedChanges.flatMap((change) => durationHours(change.storyCreatedAt, change.mergedAt));
  const cycleTimes = linkedChanges.flatMap((change) => durationHours(change.firstActivityAt, change.mergedAt));
  const releaseLags = changes.flatMap((change) => durationHours(change.mergedAt, change.releasedAt));
  const ciComparisons = changes.flatMap((change) =>
    exactCiComparison(change, validation.values, provider.observedAt)
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
    worktreeDirty: status === null
      ? missing("boolean", [gitSource.id], "Bare repository has no worktree.")
      : measured(status.length > 0, "boolean", [gitSource.id]),
    evidenceCompleteness: measured(availableCount / DECLARED_SOURCE_SYSTEMS.length, "ratio", sources.map((source) => source.id), availableCount, DECLARED_SOURCE_SYSTEMS.length),
    deliveryChangeCount: providerMetric(provider, measured(changes.length, "count", providerSourceIds), "count", providerSourceIds),
    taskToPrTraceability: providerMetric(provider, ratioOrMissing(linkedChanges.length, changes.length, "ratio", providerSourceIds, "No eligible delivery changes in the provider snapshot."), "ratio", providerSourceIds),
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

function exactCiComparison(change, validations, cutoff) {
  if (!isComparableStatus(change.hostedStatus)) return [];
  const validation = latestExactHeadValidation(change, validations, cutoff);
  if (!validation) return [];
  return [{
    validationStatus: validation.status,
    hostedStatus: change.hostedStatus,
  }];
}

function reconcileProviderChanges(provider, validations) {
  const actionsAvailable = provider.sources[2].status === "available";
  const cutoff = provider.observedAt;
  return {
    ...provider,
    changes: provider.changes.map((change) => ({
      ...change,
      validationStatus: exactValidationStatus(change, validations, cutoff),
      hostedStatus: actionsAvailable ? change.hostedStatus : "unavailable",
    })),
  };
}

function exactValidationStatus(change, validations, cutoff) {
  return latestExactHeadValidation(change, validations, cutoff)?.status ?? "unavailable";
}

function latestExactHeadValidation(change, validations, cutoff) {
  return validations.filter((validation) =>
    validation?.revision?.headCommit === change.headCommit
      && isComparableStatus(validation.status)
      && dateNotAfter(validation.completedAt, cutoff)
  ).reduce(newerValidation, null);
}

function newerValidation(current, candidate) {
  if (!current) return candidate;
  return Date.parse(candidate.completedAt) > Date.parse(current.completedAt) ? candidate : current;
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
      sourceVersion: safeProviderFailureVersion(snapshot, observedAt),
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
    observedAt: snapshot.capturedAt,
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
    observedAt,
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

function safeProviderFailureVersion(snapshot, observedAt) {
  return hasProviderCaptureTime(snapshot) && providerCaptureNotAfter(snapshot, observedAt)
    ? snapshot.capturedAt
    : null;
}

export function validateProviderSnapshot(snapshot, canonicalRepositoryId, observedAt) {
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
  return duplicateValues(ids).map(() => "Duplicate delivery change id.");
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
    ...unexpectedFieldErrors(snapshot?.sources, PROVIDER_SOURCE_SYSTEMS, "Provider sources"),
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
    errorUnless(providerSourceHasExactStateFields(source), `${system} source fields do not match status.`),
    errorUnless(providerSourceVersionSafeBeforeExport(source), `${system} source version contains unsafe detail.`),
    errorUnless(providerSourceReasonSafeBeforeExport(source), `${system} source reason contains unsafe detail.`),
    errorUnless(versionNotAfter(source?.version, observedAt), `${system} source version is newer than observedAt.`),
  ]);
}

function providerSourceVersionSafeBeforeExport(source) {
  return source?.status !== "available" || isSafeProviderVersion(source.version);
}

function providerSourceReasonSafeBeforeExport(source) {
  return source?.status !== "unavailable" || isSafeProviderReason(source.reason);
}

function validateDeliveryChange(change, capturedAt) {
  if (!isPlainObject(change)) return ["Delivery change must be an object."];
  const changeId = isSafeProviderText(change.id) ? change.id : "Delivery change";
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
  return isPlainObject(snapshot?.sources) && Array.isArray(snapshot?.deliveryChanges);
}

function isProviderSource(source) {
  return Boolean(source) && ["available", "unavailable"].includes(source.status);
}

function providerSourceHasExactStateFields(source) {
  if (!isProviderSource(source)) return false;
  return canonicalJson(Object.keys(source).sort())
    === canonicalJson(PROVIDER_SOURCE_STATE_FIELDS[source.status]);
}

function isSafeProviderReason(reason) {
  return isSafeProviderText(reason);
}

function isSafeLinkEvidence(change) {
  return change.linkEvidence === null || isSafeProviderText(change.linkEvidence);
}

function isSafeProviderText(value) {
  if (!isNonEmptyString(value) || value.length > 300) return false;
  return !hasPortableTextControls(value) && !hasCredentialShape(value);
}

function isSafeAnalyticsIdentifier(value) {
  if (!isNonEmptyString(value)) return false;
  return [
    value.length <= 300,
    !value.startsWith("/"),
    !/^[A-Za-z]:[\\/]/.test(value),
    !value.split("/").includes(".."),
    !/[\u0000-\u001F\u007F|\\]/.test(value),
    !hasCredentialShape(value),
  ].every(Boolean);
}

function isSafeProviderVersion(value) {
  return [
    isNonEmptyString(value),
    value?.length <= 300,
    !hasCredentialShape(value),
    !hasPortableTextControls(value, { allowSlash: true }),
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
  return [
    /(?:bearer\s|github_pat_|gh[pousr]_|(?:password|token|secret)\s*[=:])/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i,
    /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
  ].some((pattern) => pattern.test(String(value)));
}

function isSafeBranchName(value) {
  return isNonEmptyString(value)
    && value.length <= 1024
    && !hasCredentialShape(value)
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function hasPortableTextControls(value, { allowSlash = false } = {}) {
  const unsafe = allowSlash ? /[\u0000-\u001F\u007F|\\]/ : /[\u0000-\u001F\u007F|\\/]/;
  return unsafe.test(value);
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

async function collectJsonRef(
  repositoryPath,
  { id, system, ref, observedAt, include, validate, identity, pathMatches },
) {
  const resolved = await resolveControlRef(repositoryPath, { id, system, ref, observedAt });
  if (resolved.source) return { source: resolved.source, values: [] };
  const version = resolved.version;
  const names = (await listTreeNames(repositoryPath, version))
    .filter(include)
    .sort(compareCodePoints);
  const collected = await readControlRecords(repositoryPath, version, names, {
    validate,
    identity,
    pathMatches,
  });
  if (collected.error) {
    return {
      source: blockedSource({
        id,
        system,
        observedAt,
        sourceVersion: version,
        reason: collected.error,
      }),
      values: [],
    };
  }
  return {
    source: availableSource({
      id,
      system,
      observedAt,
      sourceVersion: version,
      content: JSON.stringify(collected.canonical),
    }),
    values: collected.values,
  };
}

async function readControlRecords(
  repositoryPath,
  version,
  names,
  { validate, identity, pathMatches },
) {
  const values = [];
  const canonical = [];
  const identities = new Set();
  for (const name of names) {
    const raw = await git(repositoryPath, ["show", `${version}:${name}`]);
    const record = parseControlRecord(raw, validate);
    if (record.error) {
      return { error: `${record.error} in control record.`, values: [], canonical: [] };
    }
    const recordIdentity = identity(record.value);
    const identityError = controlIdentityError(
      name,
      record.value,
      recordIdentity,
      identities,
      pathMatches,
    );
    if (identityError) {
      return {
        error: identityError,
        values: [],
        canonical: [],
      };
    }
    identities.add(recordIdentity);
    values.push(record.value);
    canonical.push([name, record.value]);
  }
  return { error: null, values, canonical };
}

function controlIdentityError(name, record, identity, identities, pathMatches) {
  if (!pathMatches(name, record)) return "Control record path or identity is invalid.";
  if (identities.has(identity)) return "Control record path or identity is invalid.";
  return null;
}

function validationControlPathMatches(name, record) {
  return name === `commits/${record.revision.headCommit}/${record.runId}.json`;
}

function reviewControlPathMatches(name, record) {
  const suffix = createHash("sha256")
    .update(reviewRepositoryIdentity(record))
    .digest("hex")
    .slice(0, 16);
  return name === `cycles/github-${record.changeRequest.number}-${suffix}.json`;
}

function reviewCycleIdentity(record) {
  return `${reviewRepositoryIdentity(record)}\0${record.changeRequest.number}`;
}

function reviewRepositoryIdentity(record) {
  return [
    record.repository.id,
    record.provider.owner,
    record.provider.repo,
  ].join("\0");
}

async function resolveControlRef(repositoryPath, { id, system, ref, observedAt }) {
  const exists = await runGit({
    cwd: repositoryPath,
    args: ["show-ref", "--verify", "--quiet", ref],
    acceptableExitCodes: [0, 1],
  });
  if (exists.exitCode !== 0) {
    return {
      source: unavailableSource({
        id,
        system,
        observedAt,
        reason: `${controlSourceLabel(system)} evidence ref is absent.`,
      }),
      version: null,
    };
  }
  const resolved = await resolveObservedRefVersion(repositoryPath, ref, observedAt);
  if (!resolved.observed) {
    return {
      source: blockedSource({
        id,
        system,
        observedAt,
        sourceVersion: resolved.version,
        reason: `${controlSourceLabel(system)} evidence ref is newer than the requested observation.`,
      }),
      version: resolved.version,
    };
  }
  return { source: null, version: resolved.version };
}

async function resolveObservedRefVersion(repositoryPath, ref, observedAt) {
  const version = await git(repositoryPath, ["rev-parse", ref]);
  const committedAt = await git(repositoryPath, ["show", "-s", "--format=%cI", version]);
  return { version, observed: dateNotAfter(committedAt, observedAt) };
}

function controlSourceLabel(system) {
  if (system === "tabellio-validation") return "Validation";
  if (system === "tabellio-review") return "Review";
  return "Control";
}

async function collectEntireMetadata(repositoryPath, { id, observedAt }) {
  const controlRemote = await configuredControlRemote(repositoryPath);
  const candidates = [
    "refs/heads/entire/checkpoints/v1",
    ...(controlRemote ? [`refs/remotes/${controlRemote}/entire/checkpoints/v1`] : []),
  ];
  for (const ref of candidates) {
    const result = await collectEntireRef(repositoryPath, { id, observedAt, ref });
    if (result) return result;
  }
  return {
    source: unavailableSource({ id, system: "entire", observedAt, reason: "Entire metadata checkpoint ref is absent." }),
    count: 0,
  };
}

async function collectEntireRef(repositoryPath, { id, observedAt, ref }) {
  const exists = await runGit({
    cwd: repositoryPath,
    args: ["show-ref", "--verify", "--quiet", ref],
    acceptableExitCodes: [0, 1],
  });
  if (exists.exitCode !== 0) return null;
  const resolved = await resolveObservedRefVersion(repositoryPath, ref, observedAt);
  if (!resolved.observed) {
    return {
      source: blockedSource({
        id,
        system: "entire",
        observedAt,
        sourceVersion: resolved.version,
        reason: "Entire metadata checkpoint ref is newer than the requested observation.",
      }),
      count: 0,
    };
  }
  const version = resolved.version;
  const names = (await listTreeNames(repositoryPath, version))
    .filter((name) => /^[^/]+\/[^/]+\/metadata\.json$/.test(name))
    .sort(compareCodePoints);
  return {
    source: availableSource({ id, system: "entire", observedAt, sourceVersion: version, content: JSON.stringify(names) }),
    count: names.length,
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
  if (await repositoryIsBare(repositoryPath)) {
    return committedPlatformControlRemote(repositoryPath);
  }
  const worktreeConfig = await readPlatformControlRemote(
    () => readFile(`${repositoryPath}/tabellio.platform.json`, "utf8")
  );
  return worktreeConfig.readable ? worktreeConfig.remote : null;
}

async function readPlatformControlRemote(read) {
  try {
    const platform = JSON.parse(await read());
    return {
      readable: true,
      remote: safeControlRemote(platform?.workflow?.controlRemoteName),
    };
  } catch {
    return { readable: false, remote: null };
  }
}

async function repositoryIsBare(repositoryPath) {
  return await git(repositoryPath, ["rev-parse", "--is-bare-repository"]) === "true";
}

async function committedPlatformControlRemote(repositoryPath) {
  const committed = await runGit({
    cwd: repositoryPath,
    args: ["show", "HEAD:tabellio.platform.json"],
    acceptableExitCodes: [0, 128],
  });
  if (committed.exitCode !== 0) return null;
  const config = await readPlatformControlRemote(() => Promise.resolve(committed.stdout));
  return config.remote;
}

function safeControlRemote(remote) {
  return typeof remote === "string" && /^[A-Za-z0-9._-]+$/.test(remote) ? remote : null;
}

async function git(cwd, args, acceptableExitCodes = [0]) {
  const result = await runGit({ cwd, args, acceptableExitCodes });
  return result.stdout.trim();
}

async function listTreeNames(cwd, version) {
  const result = await runGit({
    cwd,
    args: ["ls-tree", "-rz", "--name-only", version],
  });
  return result.stdout.split("\0").filter(Boolean);
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

function compareCodePoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function markdownText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\|`*_[\]{}!])/g, "\\$1");
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
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? "");
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
