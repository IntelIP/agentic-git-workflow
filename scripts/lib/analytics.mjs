import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";

import { runGit } from "./git-process.mjs";
import { canonicalJson } from "./context-packet.mjs";
import { parseGitHubRepositoryRemote } from "./github-repository.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
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

export async function collectAnalyticsDataset({ id, repositories, observedAt, since, until }) {
  assertDateRange({ observedAt, since, until });
  assertRepositoryInputs(id, repositories);
  const seen = new Set();
  for (const repository of repositories) {
    if (seen.has(repository.id)) throw new Error(`Duplicate repository id: ${repository.id}.`);
    seen.add(repository.id);
  }

  const collected = await Promise.all(repositories.map((repository) =>
    collectRepository({ ...repository, observedAt, since, until })
  ));
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

export function validateAnalyticsDataset(dataset) {
  const schemaErrors = validateJsonSchema(dataset, ANALYTICS_SCHEMA);
  if (schemaErrors.length > 0) throwValidationErrors(schemaErrors);
  const definitions = asArray(dataset?.metricDefinitions);
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const repositoryErrors = asArray(dataset?.repositories).flatMap((repository) =>
    validateRepositoryMetrics(repository, definitionIds)
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

function hasRepositories(dataset) {
  return isNonEmptyArray(dataset?.repositories);
}

function hasMetricDefinitions(dataset) {
  return hasCompleteDefinitions(dataset?.metricDefinitions);
}

function validateRepositoryMetrics(repository, definitionIds) {
  const errors = compactErrors([
    errorUnless(hasRepositoryIdentity(repository), "Repository identity is incomplete."),
    errorUnless(isCommitOid(repository.headCommit), `${repository.id}: invalid head commit.`),
  ]);
  const sourceIds = new Set((repository.sources ?? []).map((source) => source.id));
  const metrics = repository.metrics ?? {};
  const missingMetricErrors = [...definitionIds]
    .filter((metricId) => !Object.hasOwn(metrics, metricId))
    .map((metricId) => `${repository.id}: required metric ${metricId} is missing.`);
  const metricErrors = Object.entries(metrics).flatMap(([metricId, metric]) =>
    validateMetric(repository.id, metricId, metric, definitionIds, sourceIds)
  );
  return [...errors, ...missingMetricErrors, ...metricErrors];
}

function validateMetric(repositoryId, metricId, metric, definitionIds, sourceIds) {
  const prefix = `${repositoryId}/${metricId}`;
  return compactErrors([
    errorUnless(definitionIds.has(metricId), `${repositoryId}: unknown metric ${metricId}.`),
    errorUnless(isMetricStatus(metric.status), `${prefix}: invalid status.`),
    errorUnless(hasValidMetricValue(metric), `${prefix}: metric value does not match status.`),
    errorUnless(metricSourcesExist(metric, sourceIds), `${prefix}: unknown source id.`),
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

function isMetricStatus(status) {
  return ["measured", "unavailable", "not_applicable"].includes(status);
}

function hasValidMetricValue(metric) {
  return metric.status === "measured" ? metric.value !== null : metric.value === null;
}

function metricSourcesExist(metric, sourceIds) {
  return asArray(metric.sourceIds).every((sourceId) => sourceIds.has(sourceId));
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
  return `${lines.join("\n")}\n`;
}

function renderRepositoryRow(repository) {
  return [
    `| ${repository.canonicalRepositoryId}`,
    `\`${repository.headCommit.slice(0, 12)}\``,
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
    `- HEAD: \`${repository.headCommit}\` at ${repository.headCommittedAt}`,
    ...repository.sources.map((source) =>
      `- ${source.system}: ${source.status}; version ${source.sourceVersion ?? "unknown"}; digest ${source.contentDigest ?? "unavailable"}`
    ),
    "",
  ];
}

async function collectRepository({ id, path, providerSnapshot, observedAt, since, until }) {
  const repositoryPath = await realpath(path);
  const [head, committedAt, branch, remote, status, commits] = await Promise.all([
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, ["show", "-s", "--format=%cI", "HEAD"]),
    git(repositoryPath, ["branch", "--show-current"]),
    git(repositoryPath, ["remote", "get-url", "origin"], [0, 2]),
    git(repositoryPath, ["status", "--porcelain=v1"]),
    git(repositoryPath, ["rev-list", "--count", `--since=${since}`, `--until=${until}`, "HEAD"]),
  ]);
  const githubRepository = parseGitHubRepositoryRemote(remote);
  const canonicalRepositoryId = githubRepository?.fullName
    ?? (remote ? normalizeRepositoryRemote(remote) : `local/${id}`);
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
    validate: validateValidationResult,
  });
  const review = await collectJsonRef(repositoryPath, {
    id: `${id}:tabellio-review`,
    system: "tabellio-review",
    ref: "refs/tabellio/reviews",
    observedAt,
    include: (name) => name.endsWith(".json"),
    validate: (value) => validateReviewCycle(value, { allowLegacyUnknownMergeabilityReady: true }),
  });
  const entire = await collectEntireMetadata(repositoryPath, { id: `${id}:entire`, observedAt });
  const provider = await collectProviderSnapshot({ id, canonicalRepositoryId, providerSnapshot, observedAt });
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
  const ciComparisons = changes.filter(hasComparableCiStatus);
  const ciDisagreements = ciComparisons.filter((change) => change.validationStatus !== change.hostedStatus);
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
  return Boolean(change.planeStoryId) && Boolean(change.pullRequestNumber);
}

function hasComparableCiStatus(change) {
  return isComparableStatus(change.validationStatus) && isComparableStatus(change.hostedStatus);
}

function isComparableStatus(value) {
  return ["passed", "failed", "blocked"].includes(value);
}

async function collectProviderSnapshot({ id, canonicalRepositoryId, providerSnapshot, observedAt }) {
  if (!providerSnapshot) {
    const reason = "No sanitized provider snapshot supplied to the read-only collector.";
    return providerFailure({ id, observedAt, reason, status: "unavailable" });
  }
  const loaded = await readProviderSnapshot(providerSnapshot);
  if (loaded.error) {
    return providerFailure({
      id,
      observedAt,
      status: "blocked",
      reason: "Provider snapshot is missing, unreadable, or malformed.",
    });
  }
  const snapshot = loaded.value;
  const errors = validateProviderSnapshot(snapshot, canonicalRepositoryId);
  if (errors.length > 0) {
    return providerFailure({
      id,
      observedAt,
      status: "blocked",
      sourceVersion: fallback(snapshot.capturedAt, null),
      reason: `Provider snapshot is invalid: ${errors.join(" ")}`,
    });
  }
  return buildProviderResult({ id, observedAt, snapshot });
}

function buildProviderResult({ id, observedAt, snapshot }) {
  const sources = ["plane", "github", "github-actions"].map((system) =>
    buildProviderSource({ id, system, observedAt, snapshot })
  );
  return {
    available: providerRequiredSourcesAvailable(sources),
    reason: providerMissingReason(sources),
    changes: snapshot.deliveryChanges,
    sources,
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

function buildProviderSource({ id, system, observedAt, snapshot }) {
  const source = snapshot.sources[system];
  if (source.status !== "available") {
    return unavailableSource({ id: `${id}:${system}`, system, observedAt, reason: source.reason });
  }
  return availableSource({
    id: `${id}:${system}`,
    system,
    observedAt,
    sourceVersion: source.version,
    content: JSON.stringify({
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

function validateProviderSnapshot(snapshot, canonicalRepositoryId) {
  const sourceErrors = ["plane", "github", "github-actions"].flatMap((system) =>
    validateProviderSource(system, snapshot?.sources?.[system])
  );
  const changeErrors = asArray(snapshot?.deliveryChanges).flatMap(validateDeliveryChange);
  return [...validateProviderHeader(snapshot, canonicalRepositoryId), ...sourceErrors, ...changeErrors];
}

function validateProviderHeader(snapshot, canonicalRepositoryId) {
  return compactErrors([
    errorUnless(snapshot?.schemaVersion === "tabellio-analytics-provider-snapshot/v0.1", "Unsupported schemaVersion."),
    errorUnless(snapshot?.repository === canonicalRepositoryId, "Repository identity mismatch."),
    errorUnless(isDateTime(snapshot?.capturedAt), "capturedAt is invalid."),
    errorUnless(hasProviderCollections(snapshot), "sources and deliveryChanges are required."),
  ]);
}

function validateProviderSource(system, source) {
  return compactErrors([
    errorUnless(isProviderSource(source), `${system} source is invalid.`),
    errorUnless(providerSourceHasVersion(source), `${system} source version is required.`),
    errorUnless(providerSourceHasReason(source), `${system} unavailable reason is required.`),
  ]);
}

function validateDeliveryChange(change) {
  if (!isPlainObject(change)) return ["Delivery change must be an object."];
  const changeId = isNonEmptyString(change.id) ? change.id : "delivery change";
  const dateErrors = ["storyCreatedAt", "firstActivityAt", "mergedAt", "releasedAt"]
    .map((field) => errorUnless(isNullableDateTime(change[field]), `${changeId}: ${field} is invalid.`));
  return compactErrors([
    errorUnless(isNonEmptyString(change.id) && isCommitOid(change.headCommit), "Delivery change identity is invalid."),
    errorUnless(isLinkBasis(change.linkBasis), `${changeId}: linkBasis is invalid.`),
    errorUnless(isNullableString(change.linkEvidence), `${changeId}: linkEvidence is invalid.`),
    errorUnless(isLinkEvidence(change), `${changeId}: linkEvidence is required for reconciled links.`),
    errorUnless(isNullableString(change.planeStoryId), `${changeId}: planeStoryId is invalid.`),
    errorUnless(isNullablePositiveInteger(change.pullRequestNumber), `${changeId}: pullRequestNumber is invalid.`),
    ...dateErrors,
    errorUnless(isOutcomeStatus(change.validationStatus), `${changeId}: validationStatus is invalid.`),
    errorUnless(isOutcomeStatus(change.hostedStatus), `${changeId}: hostedStatus is invalid.`),
  ]);
}

function hasProviderCollections(snapshot) {
  return Boolean(snapshot?.sources) && Array.isArray(snapshot?.deliveryChanges);
}

function isProviderSource(source) {
  return Boolean(source) && ["available", "unavailable"].includes(source.status);
}

function providerSourceHasVersion(source) {
  return source?.status !== "available" || Boolean(source.version);
}

function providerSourceHasReason(source) {
  return source?.status !== "unavailable" || Boolean(source.reason);
}

function isNullableDateTime(value) {
  return value === null || isDateTime(value);
}

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
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
  const names = (await git(repositoryPath, ["ls-tree", "-r", "--name-only", ref]))
    .split("\n").filter((name) => name && include(name)).sort();
  const values = [];
  const canonical = [];
  for (const name of names) {
    const raw = await git(repositoryPath, ["show", `${ref}:${name}`]);
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
    const names = (await git(repositoryPath, ["ls-tree", "-r", "--name-only", ref]))
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
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /T/.test(value);
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
