import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  collectAnalyticsDataset,
  renderAnalyticsReport,
  validateAnalyticsDataset,
} from "../scripts/lib/analytics.mjs";
import { canonicalJson } from "../scripts/lib/context-packet.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { assertOutputBoundary } from "../scripts/lib/output-boundary.mjs";
import { identityEnv } from "./helpers/git-fixture.mjs";

const OBSERVED_AT = "2026-07-23T20:00:00.000Z";
const SINCE = "2026-07-01T00:00:00.000Z";
const UNTIL = "2026-07-23T19:59:59.000Z";
const execFileAsync = promisify(execFile);

test("analytics collection is deterministic, provenance-bound, and preserves unknown metrics", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const providerSnapshot = join(fixture.root, "provider-snapshot.json");
  await writeFile(providerSnapshot, JSON.stringify({
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository: "example/analytics",
    capturedAt: OBSERVED_AT,
    sources: {
      plane: { status: "available", version: "plane-2026-07-23" },
      github: { status: "available", version: "github-2026-07-23" },
      "github-actions": { status: "available", version: "actions-2026-07-23" }
    },
    deliveryChanges: [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: "Fixture contract",
      planeStoryId: "INTB-1",
      pullRequestNumber: 1,
      storyCreatedAt: "2026-07-10T10:00:00.000Z",
      firstActivityAt: "2026-07-10T12:00:00.000Z",
      mergedAt: "2026-07-11T12:00:00.000Z",
      releasedAt: "2026-07-12T12:00:00.000Z",
      headCommit: fixture.head,
      validationStatus: "passed",
      hostedStatus: "passed"
    }]
  }));
  const input = {
    id: "fixture-baseline",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  };
  const first = await collectAnalyticsDataset(input);
  const second = await collectAnalyticsDataset(input);

  assert.deepEqual(first, second);
  assert.equal(validateAnalyticsDataset(first), first);
  assert.equal(first.repositories[0].canonicalRepositoryId, "example/analytics");
  assert.equal(first.repositories[0].metrics.commitCount.value, 1);
  assert.equal(first.repositories[0].metrics.validationAttemptCount.value, 1);
  assert.equal(first.repositories[0].metrics.validationPassRate.value, 1);
  assert.equal(first.repositories[0].metrics.costTelemetryCoverage.value, 0);
  assert.equal(first.repositories[0].metrics.entireCheckpointCount.value, 1);
  assert.equal(first.repositories[0].metrics.reviewFindingCount.value, 0);
  assert.equal(first.repositories[0].metrics.repairCount.value, 0);
  assert.equal(first.repositories[0].metrics.taskToPrTraceability.value, 1);
  assert.equal(first.repositories[0].metrics.leadTimeHours.value, 26);
  assert.equal(first.repositories[0].metrics.cycleTimeHours.value, 24);
  assert.equal(first.repositories[0].metrics.ciDisagreementRate.value, 0);
  assert.equal(first.repositories[0].metrics.releaseLagHours.value, 24);
  assert.equal(first.repositories[0].deliveryChanges[0].validationStatus, "passed");
  assert(!JSON.stringify(first).includes(fixture.repo));
  assert(!JSON.stringify(first).includes("private transcript"));
  assert.match(renderAnalyticsReport(first), /Missing Evidence/);
  assert.match(renderAnalyticsReport(first), /taskToPrTraceability/);
});

test("repository ordering is locale-independent", async (t) => {
  const first = await createEmptyAnalyticsRepository(t, "tabellio-analytics-order-first-");
  const second = await createEmptyAnalyticsRepository(t, "tabellio-analytics-order-second-");
  await runGit({ cwd: first.repo, args: ["remote", "set-url", "origin", "https://example.com/first.git"] });
  await runGit({ cwd: second.repo, args: ["remote", "set-url", "origin", "https://example.com/second.git"] });

  const dataset = await collectAnalyticsDataset({
    id: "locale-independent-order",
    repositories: [
      { id: "ä", path: first.repo },
      { id: "z", path: second.repo },
    ],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  assert.deepEqual(dataset.repositories.map((repository) => repository.id), ["z", "ä"]);
});

test("provider source provenance retains capture time and digest identity", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-capture.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  await writeFile(providerSnapshot, JSON.stringify(document));

  const input = {
    id: "provider-capture-baseline",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  };
  const first = await collectAnalyticsDataset(input);
  document.capturedAt = "2026-07-23T19:00:00.000Z";
  await writeFile(providerSnapshot, JSON.stringify(document));
  const second = await collectAnalyticsDataset(input);
  const firstPlane = first.repositories[0].sources.find((source) => source.system === "plane");
  const secondPlane = second.repositories[0].sources.find((source) => source.system === "plane");

  assert.equal(firstPlane.observedAt, OBSERVED_AT);
  assert.equal(secondPlane.observedAt, document.capturedAt);
  assert.notEqual(firstPlane.contentDigest, secondPlane.contentDigest);
});

test("provider versions cannot postdate their snapshot capture", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-future-version.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.capturedAt = "2026-07-23T18:00:00.000Z";
  document.sources.plane.version = "2026-07-23T19:00:00.000Z";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-future-version");

  assert.equal(repository.metrics.deliveryChangeCount.status, "unavailable");
  assert.equal(repository.deliveryChanges.length, 0);
});

test("unsafe provider versions are blocked before portable export", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-unsafe-version.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const [index, prefix] of ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"].entries()) {
    const snapshot = providerSnapshotDocument(fixture.head);
    snapshot.sources.github.version = `${prefix}private-value`;
    await writeFile(providerSnapshot, JSON.stringify(snapshot));

    const repository = await collectProviderRepository(
      fixture,
      providerSnapshot,
      `provider-unsafe-version-${index}`,
    );
    const serialized = JSON.stringify(repository);

    assert.equal(repository.sources.find((source) => source.system === "github").status, "blocked");
    assert(!serialized.includes(`${prefix}private-value`));
  }

  for (const [index, credential] of [
    "https://alice:hunter2@example.com/private",
    "sk_live_1234567890abcdef",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-abcdefghij",
    "npm_12345678901234567890",
  ].entries()) {
    const snapshot = providerSnapshotDocument(fixture.head);
    snapshot.sources.github.version = credential;
    await writeFile(providerSnapshot, JSON.stringify(snapshot));

    const repository = await collectProviderRepository(
      fixture,
      providerSnapshot,
      `provider-additional-credential-${index}`,
    );
    assert.equal(repository.sources.find((source) => source.system === "github").status, "blocked");
    assert.equal(JSON.stringify(repository).includes(credential), false);
  }
});

test("commit count traverses non-monotonic commit dates", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-commit-window-");
  await commitFixtureFile(repo, "older-middle.txt", "older middle\n", "2026-06-01T00:00:00Z");
  await commitFixtureFile(repo, "new-head.txt", "new head\n", "2026-07-20T00:00:00Z");

  const repository = await collectSingleRepository(repo, "commit-window");

  assert.equal(repository.metrics.commitCount.value, 2);
});

test("one unreadable repository does not discard healthy repository evidence", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const dataset = await collectAnalyticsDataset({
    id: "partial-repository-baseline",
    repositories: [
      { id: "healthy", path: fixture.repo },
      { id: "missing", path: join(fixture.root, "missing-repository") },
    ],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const healthy = dataset.repositories.find((repository) => repository.id === "healthy");
  const missing = dataset.repositories.find((repository) => repository.id === "missing");

  assert.equal(healthy.metrics.commitCount.status, "measured");
  assert.equal(missing.headCommit, null);
  assert.equal(missing.sources.find((source) => source.system === "git").status, "blocked");
  assert.equal(missing.metrics.commitCount.status, "unavailable");
  assert.equal(validateAnalyticsDataset(dataset), dataset);
  assert.match(renderAnalyticsReport(dataset), /HEAD: unavailable/);
});

test("required repository failures abort collection", async () => {
  await assert.rejects(
    collectAnalyticsDataset({
      id: "required-repository-baseline",
      repositories: [{ id: "required", path: "/definitely/missing/tabellio", required: true }],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    }),
    /Required repository required could not be collected/,
  );
});

test("absent evidence sources remain unavailable instead of becoming zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-missing-"));
  const repo = join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);

  const dataset = await collectAnalyticsDataset({
    id: "missing-baseline",
    repositories: [{ id: "missing", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const metrics = dataset.repositories[0].metrics;

  assert.deepEqual(
    [metrics.validationAttemptCount.status, metrics.validationAttemptCount.value],
    ["unavailable", null],
  );
  assert.deepEqual(
    [metrics.entireCheckpointCount.status, metrics.entireCheckpointCount.value],
    ["unavailable", null],
  );
  assert.equal(metrics.repositoryAdoption.value, 0);
  assert.equal(metrics.repositoryAdoption.denominator, 3);
});

test("dataset validation rejects tampering and zero denominators", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const dataset = await collectAnalyticsDataset({
    id: "tamper-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  dataset.repositories[0].metrics.validationPassRate.denominator = 0;
  assert.throws(() => validateAnalyticsDataset(dataset), /zero denominator|Integrity digest/);
});

test("dataset validation binds Git provenance and revalidates delivery rows", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const providerSnapshotPath = join(fixture.root, "provider-snapshot.json");
  const providerSnapshot = providerSnapshotDocument(fixture.head);
  providerSnapshot.capturedAt = "2026-07-23T19:00:00.000Z";
  await writeFile(providerSnapshotPath, JSON.stringify(providerSnapshot));
  const dataset = await collectAnalyticsDataset({
    id: "provenance-baseline",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot: providerSnapshotPath }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const repository = dataset.repositories[0];
  const gitSource = repository.sources.find((source) => source.system === "git");
  gitSource.sourceVersion = "a".repeat(40);
  resignDataset(dataset);

  assert.throws(() => validateAnalyticsDataset(dataset), /invalid repository revision state/);

  gitSource.sourceVersion = repository.headCommit;
  repository.deliveryChanges.push({
    ...providerSnapshotDocument(fixture.head).deliveryChanges[0],
    id: "forged |\nrow",
  });
  resignDataset(dataset);

  assert.throws(() => validateAnalyticsDataset(dataset), /Delivery change identity is invalid/);

  repository.deliveryChanges.pop();
  repository.deliveryChanges[0].releasedAt = "2026-07-23T19:30:00.000Z";
  resignDataset(dataset);

  assert.throws(
    () => validateAnalyticsDataset(dataset),
    /delivery timestamp is newer than capturedAt/,
  );
});

test("dataset validation constrains Git-backed versions and portable source reasons", async () => {
  const baseline = JSON.parse(await readFile(
    new URL("../reports/analytics/2026-07-23-intb-261-baseline.json", import.meta.url),
    "utf8",
  ));

  const invalidControlOid = structuredClone(baseline);
  invalidControlOid.repositories[0].sources
    .find((source) => source.system === "tabellio-validation").sourceVersion = "not-a-git-oid";
  resignDataset(invalidControlOid);
  assert.throws(
    () => validateAnalyticsDataset(invalidControlOid),
    /Git-backed source version must be a commit OID/,
  );

  const invalidHeadLength = structuredClone(baseline);
  const invalidHead = "a".repeat(41);
  invalidHeadLength.repositories[0].headCommit = invalidHead;
  invalidHeadLength.repositories[0].sources
    .find((source) => source.system === "git").sourceVersion = invalidHead;
  resignDataset(invalidHeadLength);
  assert.throws(
    () => validateAnalyticsDataset(invalidHeadLength),
    /must match pattern|oneOf contract|revision state/,
  );

  const futureProviderVersion = structuredClone(baseline);
  const planeSource = futureProviderVersion.repositories
    .find((repository) => repository.id === "tabellio").sources
    .find((source) => source.system === "plane");
  planeSource.sourceVersion = new Date(Date.parse(planeSource.observedAt) + 1_000).toISOString();
  resignDataset(futureProviderVersion);
  assert.throws(
    () => validateAnalyticsDataset(futureProviderVersion),
    /provider version is newer than its observation/,
  );

  const futureUnavailableProviderVersion = structuredClone(baseline);
  const unavailablePlane = futureUnavailableProviderVersion.repositories[0].sources
    .find((source) => source.system === "plane");
  unavailablePlane.sourceVersion = "2099-01-01T00:00:00.000Z";
  resignDataset(futureUnavailableProviderVersion);
  assert.throws(
    () => validateAnalyticsDataset(futureUnavailableProviderVersion),
    /provider version is newer than its observation/,
  );

  const unsafeReason = structuredClone(baseline);
  const reviewSource = unsafeReason.repositories[0].sources
    .find((source) => source.status === "unavailable");
  reviewSource.reason = "forged |\nmissing evidence";
  resignDataset(unsafeReason);
  assert.throws(() => validateAnalyticsDataset(unsafeReason), /source reason contains unsafe detail/);
});

test("dataset validation rejects not-applicable repository metrics", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const dataset = await collectAnalyticsDataset({
    id: "not-applicable-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  dataset.repositories[0].metrics.commitCount = {
    ...dataset.repositories[0].metrics.commitCount,
    status: "not_applicable",
    value: null,
  };
  resignDataset(dataset);

  assert.throws(() => validateAnalyticsDataset(dataset), /must be one of|invalid status/i);
});

test("dataset validation requires the canonical metric set and definitions", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const dataset = await collectAnalyticsDataset({
    id: "contract-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  delete dataset.repositories[0].metrics.commitCount;
  assert.throws(() => validateAnalyticsDataset(dataset), /required metric commitCount is missing/);

  const second = structuredClone(await collectAnalyticsDataset({
    id: "definition-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  }));
  second.metricDefinitions[0] = { ...second.metricDefinitions[0], unit: "score" };
  assert.throws(() => validateAnalyticsDataset(second), /Metric definitions are incomplete/);
});

test("dataset validation executes the published schema contract", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const dataset = await collectAnalyticsDataset({
    id: "schema-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  dataset.repositories[0].unexpected = "forbidden";
  dataset.repositories[0].sources[0].status = "invented";
  resignDataset(dataset);

  assert.throws(
    () => validateAnalyticsDataset(dataset),
    /unexpected is not allowed|status must be one of/,
  );
});

test("dataset validation enforces window ordering and metric semantics", async (t) => {
  const fixture = await createAnalyticsFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const dataset = await collectAnalyticsDataset({
    id: "semantic-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  dataset.window.since = "2026-07-24T00:00:00.000Z";
  resignDataset(dataset);
  assert.throws(() => validateAnalyticsDataset(dataset), /window ordering is invalid/);

  const invalidMetric = await collectAnalyticsDataset({
    id: "metric-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  invalidMetric.repositories[0].metrics.commitCount = {
    ...invalidMetric.repositories[0].metrics.commitCount,
    value: true,
    unit: "ratio",
  };
  resignDataset(invalidMetric);
  assert.throws(
    () => validateAnalyticsDataset(invalidMetric),
    /metric value, unit, or ratio fields violate its definition/,
  );

  const invalidDate = await collectAnalyticsDataset({
    id: "date-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  invalidDate.observedAt = "2026-02-30T00:00:00Z";
  resignDataset(invalidDate);
  assert.throws(
    () => validateAnalyticsDataset(invalidDate),
    /\$\.observedAt must be an ISO date-time/,
  );

  const unsupportedMetric = await collectAnalyticsDataset({
    id: "unsupported-source-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const validationSource = unsupportedMetric.repositories[0].sources
    .find((source) => source.system === "tabellio-validation");
  validationSource.status = "unavailable";
  validationSource.sourceVersion = null;
  validationSource.contentDigest = null;
  validationSource.reason = "Evidence unavailable.";
  unsupportedMetric.repositories[0].metrics.validationAttemptCount = {
    status: "measured",
    value: 1,
    unit: "count",
    sourceIds: [validationSource.id],
    reason: null,
    numerator: null,
    denominator: null,
  };
  resignDataset(unsupportedMetric);
  assert.throws(
    () => validateAnalyticsDataset(unsupportedMetric),
    /sources do not support the metric state or definition/,
  );

  const validForTampering = await collectAnalyticsDataset({
    id: "provenance-baseline",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const futureHead = structuredClone(validForTampering);
  futureHead.repositories[0].headCommittedAt = "2026-07-24T00:00:00.000Z";
  resignDataset(futureHead);
  assert.throws(
    () => validateAnalyticsDataset(futureHead),
    /invalid repository revision state/,
  );

  const missingProvenance = structuredClone(validForTampering);
  const gitSource = missingProvenance.repositories[0].sources
    .find((source) => source.system === "git");
  gitSource.sourceVersion = null;
  gitSource.contentDigest = null;
  gitSource.reason = "Available without immutable provenance.";
  resignDataset(missingProvenance);
  assert.throws(
    () => validateAnalyticsDataset(missingProvenance),
    /available source requires a version/,
  );

  const emptyMetricSources = structuredClone(validForTampering);
  emptyMetricSources.repositories[0].metrics.commitCount.sourceIds = [];
  resignDataset(emptyMetricSources);
  assert.throws(
    () => validateAnalyticsDataset(emptyMetricSources),
    /sources do not support the metric state or definition/,
  );

  const duplicateSources = structuredClone(validForTampering);
  duplicateSources.repositories[0].sources.push(
    structuredClone(duplicateSources.repositories[0].sources[0]),
  );
  resignDataset(duplicateSources);
  assert.throws(
    () => validateAnalyticsDataset(duplicateSources),
    /repository sources must be unique and complete/,
  );

  const futureSource = structuredClone(validForTampering);
  futureSource.repositories[0].sources[0].observedAt = "2026-07-24T00:00:00.000Z";
  resignDataset(futureSource);
  assert.throws(
    () => validateAnalyticsDataset(futureSource),
    /source observation is newer than the dataset/,
  );

  const forgedRepository = structuredClone(validForTampering);
  forgedRepository.repositories[0].id = "bad | forged\nrow";
  forgedRepository.repositories[0].canonicalRepositoryId = "bad | forged\nrow";
  resignDataset(forgedRepository);
  assert.throws(
    () => validateAnalyticsDataset(forgedRepository),
    /Repository identity is incomplete/,
  );

  const inconsistentRatio = structuredClone(validForTampering);
  inconsistentRatio.repositories[0].metrics.evidenceCompleteness.value = 0.5;
  resignDataset(inconsistentRatio);
  assert.throws(
    () => validateAnalyticsDataset(inconsistentRatio),
    /metric value, unit, or ratio fields violate its definition/,
  );

  const missingRequiredSystem = structuredClone(validForTampering);
  const leadTime = missingRequiredSystem.repositories[0].metrics.leadTimeHours;
  leadTime.sourceIds = [missingRequiredSystem.repositories[0].sources
    .find((source) => source.system === "plane").id];
  resignDataset(missingRequiredSystem);
  assert.throws(
    () => validateAnalyticsDataset(missingRequiredSystem),
    /sources do not support the metric state or definition/,
  );

  const falseCompleteness = structuredClone(validForTampering);
  falseCompleteness.repositories[0].metrics.evidenceCompleteness = {
    ...falseCompleteness.repositories[0].metrics.evidenceCompleteness,
    value: 1,
    numerator: 7,
  };
  resignDataset(falseCompleteness);
  assert.throws(
    () => validateAnalyticsDataset(falseCompleteness),
    /sources do not support the metric state or definition/,
  );
});

test("dataset and collection reject duplicate canonical repositories", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-duplicate-repository-");
  await assert.rejects(
    collectAnalyticsDataset({
      id: "duplicate-repository-baseline",
      repositories: [
        { id: "first", path: repo },
        { id: "second", path: repo },
      ],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    }),
    /Duplicate canonical repository/,
  );

  const dataset = await collectAnalyticsDataset({
    id: "unique-repository-baseline",
    repositories: [{ id: "first", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  dataset.repositories.push(structuredClone(dataset.repositories[0]));
  dataset.repositories[1].id = "second";
  resignDataset(dataset);
  assert.throws(
    () => validateAnalyticsDataset(dataset),
    /Canonical repositories must be unique/,
  );
});

test("dataset validation enforces metric reason semantics", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-metric-reason-");
  const dataset = await collectAnalyticsDataset({
    id: "metric-reason-baseline",
    repositories: [{ id: "fixture", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  const measuredReason = structuredClone(dataset);
  measuredReason.repositories[0].metrics.commitCount.reason = "Contradictory reason.";
  resignDataset(measuredReason);
  assert.throws(() => validateAnalyticsDataset(measuredReason), /metric value, unit, or ratio fields/);

  const unavailableReason = structuredClone(dataset);
  unavailableReason.repositories[0].metrics.validationPassRate.reason = null;
  resignDataset(unavailableReason);
  assert.throws(() => validateAnalyticsDataset(unavailableReason), /metric value, unit, or ratio fields/);
});

test("repository identity excludes local paths and URL credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-private-remote-"));
  const repo = join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);

  await runGit({ cwd: repo, args: ["remote", "set-url", "origin", join(root, "private-control.git")] });
  const localDataset = await collectAnalyticsDataset({
    id: "private-local",
    repositories: [{ id: "fixture", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  assert.match(localDataset.repositories[0].canonicalRepositoryId, /^remote\/[0-9a-f]{16}$/);
  assert(!JSON.stringify(localDataset).includes(root));

  await runGit({
    cwd: repo,
    args: ["remote", "set-url", "origin", "https://agent:private-token@example.com/org/repository.git"],
  });
  const credentialDataset = await collectAnalyticsDataset({
    id: "private-credential",
    repositories: [{ id: "fixture", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(credentialDataset.repositories[0].canonicalRepositoryId, "example.com/org/repository");
  assert(!JSON.stringify(credentialDataset).includes("private-token"));

  for (const [index, remote] of [
    "ssh://git@example.com/home/alice/private/repository.git",
    "git@example.com:/home/alice/private/repository.git",
  ].entries()) {
    await runGit({ cwd: repo, args: ["remote", "set-url", "origin", remote] });
    const sshDataset = await collectAnalyticsDataset({
      id: `private-ssh-${index}`,
      repositories: [{ id: "fixture", path: repo }],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    });
    assert.match(sshDataset.repositories[0].canonicalRepositoryId, /^remote\/[0-9a-f]{16}$/);
    assert(!JSON.stringify(sshDataset).includes("/home/alice"));
  }

  for (const remote of [
    "ssh://git@gitlab.com/acme/project.git",
    "ssh://deploy@gitlab.com/acme/project.git",
  ]) {
    await runGit({ cwd: repo, args: ["remote", "set-url", "origin", remote] });
    const sshDataset = await collectAnalyticsDataset({
      id: "portable-ssh",
      repositories: [{ id: "fixture", path: repo }],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    });
    assert.equal(sshDataset.repositories[0].canonicalRepositoryId, "gitlab.com/acme/project");
  }
});

test("credential-shaped branch names never enter portable analytics", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-private-branch-");
  const credential = "github_pat_private-branch-value";
  await runGit({ cwd: repo, args: ["switch", "-c", `feature/${credential}`] });

  const dataset = await collectAnalyticsDataset({
    id: "private-branch",
    repositories: [{ id: "fixture", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(dataset.repositories[0].headCommit, null);
  assert.equal(JSON.stringify(dataset).includes(credential), false);

  const tampered = structuredClone(dataset);
  const repository = tampered.repositories[0];
  const gitSource = repository.sources.find((source) => source.system === "git");
  repository.headCommit = "a".repeat(40);
  repository.headCommittedAt = "2026-07-10T12:00:00.000Z";
  repository.branch = credential;
  gitSource.status = "available";
  gitSource.sourceVersion = repository.headCommit;
  gitSource.contentDigest = "b".repeat(64);
  gitSource.reason = null;
  resignDataset(tampered);
  assert.throws(() => validateAnalyticsDataset(tampered), /invalid repository revision state/);
});

test("analytics collector rejects colliding dataset and report paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-output-collision-"));
  const outputPath = join(root, "analytics-output");
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/tabellio-analytics.mjs", import.meta.url)),
      "collect",
      "--config", fileURLToPath(new URL("../examples/tabellio-analytics/minimal-repositories.json", import.meta.url)),
      "--id", "output-collision",
      "--since", SINCE,
      "--until", UNTIL,
      "--out", outputPath,
      "--report", outputPath,
    ], { encoding: "utf8" }),
    (error) => error.code === 1
      && /must resolve to distinct paths/.test(error.stderr),
  );
  await assert.rejects(readFile(outputPath), (error) => error.code === "ENOENT");

  const shared = join(root, "shared-output");
  const datasetLink = join(root, "dataset-link");
  const reportLink = join(root, "report-link");
  await symlink(shared, datasetLink);
  await symlink(shared, reportLink);
  await assertAnalyticsOutputCollision(datasetLink, reportLink, /must not be symbolic links/);
  await assert.rejects(readFile(shared), (error) => error.code === "ENOENT");

  await writeFile(shared, "unchanged");
  const datasetHardLink = join(root, "dataset-hard-link");
  const reportHardLink = join(root, "report-hard-link");
  await link(shared, datasetHardLink);
  await link(shared, reportHardLink);
  await assertAnalyticsOutputCollision(datasetHardLink, reportHardLink, /must resolve to distinct files/);
  assert.equal(await readFile(shared, "utf8"), "unchanged");

  const configPath = join(root, "config.json");
  const reportPath = join(root, "config-report.md");
  await writeFile(configPath, JSON.stringify({
    repositories: [{ id: "example", path: fileURLToPath(new URL("..", import.meta.url)) }],
  }));
  await assertConfigAliasRejected(configPath, configPath, reportPath);

  const configHardLink = join(root, "config-hard-link.json");
  await link(configPath, configHardLink);
  await assertConfigAliasRejected(configPath, configHardLink, reportPath);
  assert.match(await readFile(configPath, "utf8"), /repositories/);

  await assert.rejects(
    assertOutputBoundary({
      outputs: [configPath],
      protectedInputs: [configPath],
      duplicatePathMessage: "duplicate",
      symbolicLinkMessage: "symbolic",
      outputAliasMessage: "output alias",
      inputAliasMessage: "input alias",
    }),
    /input alias/,
  );
});

async function assertConfigAliasRejected(configPath, datasetPath, reportPath) {
  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/tabellio-analytics.mjs", import.meta.url)),
      "collect",
      "--config", configPath,
      "--id", "config-alias",
      "--since", SINCE,
      "--until", UNTIL,
      "--out", datasetPath,
      "--report", reportPath,
    ], { encoding: "utf8" }),
    (error) => error.code === 1 && /must not alias --config/.test(error.stderr),
  );
  assert.match(await readFile(configPath, "utf8"), /repositories/);
}

async function assertAnalyticsOutputCollision(datasetPath, reportPath, message) {
  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/tabellio-analytics.mjs", import.meta.url)),
      "collect",
      "--config", fileURLToPath(new URL("../examples/tabellio-analytics/minimal-repositories.json", import.meta.url)),
      "--id", "output-alias-collision",
      "--since", SINCE,
      "--until", UNTIL,
      "--out", datasetPath,
      "--report", reportPath,
    ], { encoding: "utf8" }),
    (error) => error.code === 1 && message.test(error.stderr),
  );
}

test("dataset validation rejects non-portable source identifiers", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-source-id-");
  const dataset = await collectAnalyticsDataset({
    id: "source-id-baseline",
    repositories: [{ id: "fixture", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const repository = dataset.repositories[0];
  const source = repository.sources[0];
  const originalId = source.id;
  source.id = "/Users/alice/private";
  for (const metric of Object.values(repository.metrics)) {
    metric.sourceIds = metric.sourceIds.map((id) =>
      id === originalId ? source.id : id
    );
  }
  resignDataset(dataset);

  assert.throws(
    () => validateAnalyticsDataset(dataset),
    (error) => /source id is not portable/.test(error.message)
      && !error.message.includes("/Users/alice/private"),
  );
});

test("analytics collection rejects unsafe configured identifiers", async () => {
  await assert.rejects(
    collectAnalyticsDataset({
      id: "bad | forged\nrow",
      repositories: [{ id: "fixture", path: "." }],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    }),
    /safe portable id/,
  );
  await assert.rejects(
    collectAnalyticsDataset({
      id: "safe-baseline",
      repositories: [{ id: "bad | forged\nrow", path: "." }],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    }),
    /safe portable id/,
  );
  await assert.rejects(
    collectAnalyticsDataset({
      id: "/Users/alice/private-baseline",
      repositories: [{ id: "fixture", path: "." }],
      observedAt: OBSERVED_AT,
      since: SINCE,
      until: UNTIL,
    }),
    /safe portable id/,
  );
});

test("bare repositories preserve Git analytics while worktree state stays unavailable", async (t) => {
  const { root, repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-bare-");
  await commitFixtureFile(
    repo,
    "tabellio.platform.json",
    JSON.stringify({ workflow: { controlRemoteName: "control" } }),
    "2026-07-10T12:00:00.000Z",
  );
  await createMetadataRef(repo, {
    branch: "bare-control-entire",
    ref: "refs/remotes/control/entire/checkpoints/v1",
    files: { "aa/session/metadata.json": "{}" },
  });
  const entireCommit = (await runGit({
    cwd: repo,
    args: ["rev-parse", "refs/remotes/control/entire/checkpoints/v1"],
  })).stdout.trim();
  await runGit({ cwd: repo, args: ["tag", "bare-entire-fixture", entireCommit] });
  const bare = join(root, "repository.git");
  await runGit({ cwd: root, args: ["clone", "--bare", repo, bare] });
  await runGit({
    cwd: bare,
    args: ["update-ref", "refs/remotes/control/entire/checkpoints/v1", entireCommit],
  });
  await writeFile(join(bare, "tabellio.platform.json"), JSON.stringify({
    workflow: { controlRemoteName: "untrusted-loose-file" },
  }));

  const dataset = await collectAnalyticsDataset({
    id: "bare-baseline",
    repositories: [{ id: "bare", path: bare }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  validateAnalyticsDataset(dataset);
  const repository = dataset.repositories[0];

  assert.match(repository.headCommit, /^[0-9a-f]{40}$/);
  assert.equal(repository.metrics.commitCount.status, "measured");
  assert.equal(repository.metrics.worktreeDirty.status, "unavailable");
  assert.equal(repository.metrics.worktreeDirty.value, null);
  assert.match(repository.metrics.worktreeDirty.reason, /no worktree/i);
  assert.equal(repository.metrics.entireCheckpointCount.status, "measured");
  assert.equal(repository.metrics.entireCheckpointCount.value, 1);
});

test("provider read failures are blocked without leaking local paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-provider-read-"));
  const repo = join(root, "repo");
  const missingSnapshot = join(root, "private-secret-provider.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);

  const dataset = await collectAnalyticsDataset({
    id: "provider-read-baseline",
    repositories: [{ id: "fixture", path: repo, providerSnapshot: missingSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const serialized = JSON.stringify(dataset);

  assert(!serialized.includes(root));
  assert(!serialized.includes("private-secret-provider.json"));
  assert.match(serialized, /Provider snapshot is missing, unreadable, or malformed/);
});

test("null provider snapshots remain blocked without aborting collection", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-null.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(providerSnapshot, "null");

  const dataset = await collectAnalyticsDataset({
    id: "provider-null-baseline",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(dataset.repositories[0].deliveryChanges.length, 0);
  assert.equal(dataset.repositories[0].metrics.taskToPrTraceability.status, "unavailable");
  assert.match(
    dataset.repositories[0].sources.find((source) => source.system === "plane").reason,
    /Provider snapshot is invalid/,
  );
});

test("unexpected provider fields are rejected before portable export", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-private-field.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.deliveryChanges[0].privatePayload = "do-not-export";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const dataset = await collectAnalyticsDataset({
    id: "provider-private-field-baseline",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const serialized = JSON.stringify(dataset);

  assert(!serialized.includes("do-not-export"));
  assert.match(serialized, /Provider snapshot is invalid/);
  assert.equal(dataset.repositories[0].deliveryChanges.length, 0);
});

test("provider source metadata is typed, privacy-safe, and case-normalized", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-source-contract.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const malformed = providerSnapshotDocument(fixture.head);
  malformed.sources.plane.version = { invalid: true };
  await writeFile(providerSnapshot, JSON.stringify(malformed));

  const malformedRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-source-type");

  assert.equal(malformedRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert.match(
    malformedRepository.sources.find((source) => source.system === "plane").reason,
    /Provider snapshot is invalid/,
  );

  const sensitive = providerSnapshotDocument(fixture.head, {
    sources: {
      plane: { status: "unavailable", reason: "/home/alice/private/token.txt" },
      github: { status: "available", version: "github-2026-07-23" },
      "github-actions": { status: "available", version: "actions-2026-07-23" },
    },
  });
  await writeFile(providerSnapshot, JSON.stringify(sensitive));
  const sensitiveRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-source-private");

  assert.equal(sensitiveRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert(!JSON.stringify(sensitiveRepository).includes("/home/alice"));

  sensitive.sources.plane.reason = "api_key=qwertyuiopasdfgh";
  await writeFile(providerSnapshot, JSON.stringify(sensitive));
  const apiKeyRepository = await collectProviderRepository(
    fixture,
    providerSnapshot,
    "provider-source-api-key",
  );
  assert.equal(apiKeyRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert(!JSON.stringify(apiKeyRepository).includes("qwertyuiopasdfgh"));

  const sensitiveFields = providerSnapshotDocument(fixture.head);
  sensitiveFields.sources.plane.version = "/Users/alice/private-version";
  sensitiveFields.deliveryChanges[0].linkBasis = "manual-reconciliation";
  sensitiveFields.deliveryChanges[0].linkEvidence = "Bearer private-token";
  sensitiveFields.deliveryChanges[0].id = "/Users/alice/private-change";
  sensitiveFields.deliveryChanges[0].planeStoryId = "token=private-story";
  await writeFile(providerSnapshot, JSON.stringify(sensitiveFields));
  const sensitiveFieldsRepository = await collectProviderRepository(
    fixture,
    providerSnapshot,
    "provider-field-private",
  );

  assert.equal(sensitiveFieldsRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert(!JSON.stringify(sensitiveFieldsRepository).includes("/Users/alice"));
  assert(!JSON.stringify(sensitiveFieldsRepository).includes("private-token"));
  assert(!JSON.stringify(sensitiveFieldsRepository).includes("private-story"));

  const normalized = providerSnapshotDocument(fixture.head);
  normalized.repository = "EXAMPLE/ANALYTICS";
  await writeFile(providerSnapshot, JSON.stringify(normalized));
  const normalizedRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-source-case");

  assert.equal(normalizedRepository.metrics.deliveryChangeCount.status, "measured");

  const weakEtag = providerSnapshotDocument(fixture.head);
  weakEtag.sources.github.version = 'W/"github-snapshot-123"';
  await writeFile(providerSnapshot, JSON.stringify(weakEtag));
  const weakEtagRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-source-etag");

  assert.equal(weakEtagRepository.metrics.deliveryChangeCount.status, "measured");
});

test("provider source metadata rejects state-inapplicable fields", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-source-state-fields.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const availableWithReason = providerSnapshotDocument(fixture.head);
  availableWithReason.sources.github.reason = {
    privateProviderResponse: "customer confidential data",
  };
  await writeFile(providerSnapshot, JSON.stringify(availableWithReason));
  const availableRepository = await collectProviderRepository(
    fixture,
    providerSnapshot,
    "provider-available-reason",
  );
  assert.equal(availableRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert(!JSON.stringify(availableRepository).includes("customer confidential data"));

  const unavailableWithVersion = providerSnapshotDocument(fixture.head);
  unavailableWithVersion.sources.github = {
    status: "unavailable",
    reason: "Provider unavailable.",
    version: { privateProviderResponse: "customer confidential data" },
  };
  await writeFile(providerSnapshot, JSON.stringify(unavailableWithVersion));
  const unavailableRepository = await collectProviderRepository(
    fixture,
    providerSnapshot,
    "provider-unavailable-version",
  );
  assert.equal(unavailableRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert(!JSON.stringify(unavailableRepository).includes("customer confidential data"));
});

test("malformed provider changes block provider metrics without aborting collection", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-invalid.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(providerSnapshot, JSON.stringify(providerSnapshotDocument(fixture.head, {
    deliveryChanges: [null, {
      id: "bad-link",
      linkBasis: "explicit",
      linkEvidence: null,
      planeStoryId: { invalid: true },
      pullRequestNumber: "not-a-number",
      storyCreatedAt: null,
      firstActivityAt: null,
      mergedAt: null,
      releasedAt: null,
      headCommit: fixture.head,
      validationStatus: "passed",
      hostedStatus: "passed",
    }],
  })));

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-invalid");

  assert.equal(repository.deliveryChanges.length, 0);
  assert.equal(repository.metrics.taskToPrTraceability.status, "unavailable");
  assert.match(repository.sources.find((source) => source.system === "plane").reason, /Provider snapshot is invalid/);

  const manyInvalid = providerSnapshotDocument(fixture.head, {
    deliveryChanges: Array.from({ length: 20 }, () => null),
  });
  await writeFile(providerSnapshot, JSON.stringify(manyInvalid));
  const bounded = await collectProviderRepository(fixture, providerSnapshot, "provider-invalid-many");
  const boundedReason = bounded.sources.find((source) => source.system === "plane").reason;

  assert(boundedReason.length <= 300);
});

test("duplicate provider delivery identifiers block provider metrics", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-duplicate.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.deliveryChanges.push(structuredClone(document.deliveryChanges[0]));
  await writeFile(providerSnapshot, JSON.stringify(document));

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-duplicate");

  assert.equal(repository.deliveryChanges.length, 0);
  assert.equal(repository.metrics.deliveryChangeCount.status, "unavailable");
  assert.match(
    repository.sources.find((source) => source.system === "plane").reason,
    /Provider snapshot is invalid/,
  );
});

test("provider evidence cannot postdate observation or violate lifecycle ordering", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-time-invalid.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const future = providerSnapshotDocument(fixture.head);
  future.capturedAt = "2026-07-24T00:00:00.000Z";
  await writeFile(providerSnapshot, JSON.stringify(future));

  const futureRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-future");

  assert.equal(futureRepository.metrics.deliveryChangeCount.status, "unavailable");
  assert.match(
    futureRepository.sources.find((source) => source.system === "plane").reason,
    /Provider snapshot is invalid/,
  );

  const reversed = providerSnapshotDocument(fixture.head);
  reversed.deliveryChanges[0].releasedAt = "2026-07-11T00:00:00.000Z";
  await writeFile(providerSnapshot, JSON.stringify(reversed));
  const reversedRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-reversed");

  assert.equal(reversedRepository.metrics.releaseLagHours.status, "unavailable");
  assert.match(
    reversedRepository.sources.find((source) => source.system === "github").reason,
    /Provider snapshot is invalid/,
  );
});

test("invalid provider capture versions never leak into blocked source provenance", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-invalid-capture.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.capturedAt = "/Users/alice/private-capture";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-invalid-capture");
  const providerSources = repository.sources
    .filter((source) => ["plane", "github", "github-actions"].includes(source.system));

  assert(providerSources.every((source) => source.status === "blocked" && source.sourceVersion === null));
  assert(!JSON.stringify(repository).includes(document.capturedAt));
});

test("explicitly unlinked changes do not inflate task-to-PR traceability", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-unlinked.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.deliveryChanges[0].linkBasis = "unlinked";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-unlinked");

  assert.equal(repository.metrics.taskToPrTraceability.status, "measured");
  assert.equal(repository.metrics.taskToPrTraceability.value, 0);
  assert.equal(repository.metrics.taskToPrTraceability.numerator, 0);
  assert.equal(repository.metrics.leadTimeHours.status, "unavailable");
  assert.equal(repository.metrics.cycleTimeHours.status, "unavailable");
});

test("provider identifiers cannot inject report rows", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-report-injection.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.deliveryChanges[0].id = "change|forged\nrow";
  document.deliveryChanges[0].planeStoryId = "INTB-1|forged";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-report-injection");

  assert.equal(repository.deliveryChanges.length, 0);
  assert(!JSON.stringify(repository).includes("forged"));
});

test("analytics reports escape active provider content", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-active-markdown.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.deliveryChanges[0].id = "<img src=x onerror=alert(1)>";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const dataset = await collectAnalyticsDataset({
    id: "<script>alert(1)</script>",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const report = renderAnalyticsReport(dataset);

  assert(!report.includes("<script>"));
  assert(!report.includes("<img"));
  assert.match(report, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("CI disagreement uses unique exact-head validation evidence", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-ci-binding.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const document = providerSnapshotDocument(fixture.head);
  document.deliveryChanges[0].validationStatus = "failed";
  await writeFile(providerSnapshot, JSON.stringify(document));

  const exactRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-ci-exact");

  assert.equal(exactRepository.metrics.ciDisagreementRate.status, "measured");
  assert.equal(exactRepository.metrics.ciDisagreementRate.value, 0);

  document.deliveryChanges[0].headCommit = "f".repeat(40);
  await writeFile(providerSnapshot, JSON.stringify(document));
  const missingRepository = await collectProviderRepository(fixture, providerSnapshot, "provider-ci-missing");

  assert.equal(missingRepository.metrics.ciDisagreementRate.status, "unavailable");
});

test("exact-head reconciliation selects the latest validation rerun", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-validation-rerun.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const provider = providerSnapshotDocument(fixture.head);
  await writeFile(providerSnapshot, JSON.stringify(provider));

  const failed = JSON.parse(await controlFixture(
    "../examples/tabellio-validation/minimal-result.json",
    "example/analytics",
    fixture.head,
  ));
  failed.runId = "validation-rerun-failed";
  failed.status = "failed";
  failed.commands[0].status = "failed";
  failed.commands[0].exitCode = 1;
  setValidationTimes(failed, "2026-07-23T17:00:00.000Z", "2026-07-23T17:01:00.000Z");
  resignDataset(failed);

  const passed = JSON.parse(await controlFixture(
    "../examples/tabellio-validation/minimal-result.json",
    "example/analytics",
    fixture.head,
  ));
  passed.runId = "validation-rerun-passed";
  setValidationTimes(passed, "2026-07-23T18:00:00.000Z", "2026-07-23T18:01:00.000Z");
  resignDataset(passed);

  await createMetadataRef(fixture.repo, {
    branch: "validation-reruns",
    ref: "refs/tabellio/validations",
    files: {
      [`commits/${fixture.head}/${failed.runId}.json`]: JSON.stringify(failed),
      [`commits/${fixture.head}/${passed.runId}.json`]: JSON.stringify(passed),
    },
  });

  const repository = await collectProviderRepository(fixture, providerSnapshot, "validation-rerun");

  assert.equal(repository.deliveryChanges[0].validationStatus, "passed");
  assert.equal(repository.metrics.ciDisagreementRate.value, 0);
  assert.equal(repository.metrics.validationAttemptCount.value, 2);
});

test("exact-head reconciliation ignores validation evidence completed after provider observation", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-historical.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const provider = providerSnapshotDocument(fixture.head);
  provider.capturedAt = "2026-07-23T19:00:00.000Z";
  await writeFile(providerSnapshot, JSON.stringify(provider));

  const past = JSON.parse(await controlFixture(
    "../examples/tabellio-validation/minimal-result.json",
    "example/analytics",
    fixture.head,
  ));
  const future = structuredClone(past);
  future.runId = "validation-future-001";
  setValidationTimes(future, "2026-07-23T19:29:59.000Z", "2026-07-23T19:30:00.000Z");
  resignDataset(future);
  await createMetadataRef(fixture.repo, {
    branch: "historical-validations",
    ref: "refs/tabellio/validations",
    files: {
      [`commits/${fixture.head}/${past.runId}.json`]: JSON.stringify(past),
      [`commits/${fixture.head}/${future.runId}.json`]: JSON.stringify(future),
    },
  });

  const repository = await collectProviderRepository(fixture, providerSnapshot, "provider-historical");

  assert.equal(repository.deliveryChanges[0].validationStatus, "passed");
  assert.equal(repository.metrics.ciDisagreementRate.status, "measured");
  assert.equal(repository.metrics.ciDisagreementRate.value, 0);
});

test("provider-derived metrics require their declared evidence sources", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-partial.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(providerSnapshot, JSON.stringify(providerSnapshotDocument(fixture.head, {
    sources: {
      plane: { status: "unavailable", reason: "Plane snapshot unavailable." },
      github: { status: "available", version: "github-2026-07-23" },
      "github-actions": { status: "unavailable", reason: "Actions snapshot unavailable." },
    },
  })));

  const dataset = await collectAnalyticsDataset({
    id: "provider-partial-baseline",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const metrics = dataset.repositories[0].metrics;

  assert.deepEqual([metrics.leadTimeHours.status, metrics.leadTimeHours.value], ["unavailable", null]);
  assert.deepEqual([metrics.cycleTimeHours.status, metrics.cycleTimeHours.value], ["unavailable", null]);
  assert.deepEqual([metrics.ciDisagreementRate.status, metrics.ciDisagreementRate.value], ["unavailable", null]);
  assert.equal(metrics.releaseLagHours.status, "measured");
});

test("partial provider sources cannot export unsupported evidence", async (t) => {
  const fixture = await createAnalyticsFixture();
  const providerSnapshot = join(fixture.root, "provider-partial.json");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const missingPlane = providerSnapshotDocument(fixture.head);
  missingPlane.sources.plane = { status: "unavailable", reason: "Plane capture unavailable." };
  await writeFile(providerSnapshot, JSON.stringify(missingPlane));

  const withoutPlane = await collectProviderRepository(fixture, providerSnapshot, "provider-without-plane");

  assert.equal(withoutPlane.deliveryChanges.length, 1);
  assert.equal(withoutPlane.deliveryChanges[0].planeStoryId, null);
  assert.equal(withoutPlane.deliveryChanges[0].storyCreatedAt, null);
  assert.equal(withoutPlane.deliveryChanges[0].linkBasis, "unlinked");
  assert.equal(withoutPlane.metrics.deliveryChangeCount.status, "unavailable");

  const fabricatedPlane = await collectAnalyticsDataset({
    id: "fabricated-plane",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  Object.assign(fabricatedPlane.repositories[0].deliveryChanges[0], {
    linkBasis: "explicit",
    linkEvidence: "Unsupported link",
    planeStoryId: "INTB-999",
    storyCreatedAt: "2026-07-10T10:00:00.000Z",
  });
  resignDataset(fabricatedPlane);
  assert.throws(
    () => validateAnalyticsDataset(fabricatedPlane),
    /Plane delivery fields require available Plane evidence/,
  );

  const missingActions = providerSnapshotDocument(fixture.head);
  missingActions.sources["github-actions"] = { status: "unavailable", reason: "Actions capture unavailable." };
  missingActions.deliveryChanges[0].validationStatus = "failed";
  missingActions.deliveryChanges[0].hostedStatus = "passed";
  await writeFile(providerSnapshot, JSON.stringify(missingActions));

  const withoutActions = await collectProviderRepository(fixture, providerSnapshot, "provider-without-actions");

  assert.equal(withoutActions.deliveryChanges[0].validationStatus, "passed");
  assert.equal(withoutActions.deliveryChanges[0].hostedStatus, "unavailable");

  const fabricatedHostedStatus = await collectAnalyticsDataset({
    id: "fabricated-hosted-status",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  fabricatedHostedStatus.repositories[0].deliveryChanges[0].hostedStatus = "passed";
  resignDataset(fabricatedHostedStatus);
  assert.throws(
    () => validateAnalyticsDataset(fabricatedHostedStatus),
    /hosted status requires available GitHub Actions evidence/,
  );

  const missingGithub = providerSnapshotDocument(fixture.head);
  missingGithub.sources.github = { status: "unavailable", reason: "GitHub capture unavailable." };
  await writeFile(providerSnapshot, JSON.stringify(missingGithub));
  const fabricatedWithoutGithub = await collectAnalyticsDataset({
    id: "provider-without-github",
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  fabricatedWithoutGithub.repositories[0].deliveryChanges = structuredClone(
    missingGithub.deliveryChanges,
  );
  resignDataset(fabricatedWithoutGithub);
  assert.throws(
    () => validateAnalyticsDataset(fabricatedWithoutGithub),
    /delivery changes require available GitHub evidence/,
  );
});

test("malformed validation evidence blocks its metrics without blocking local Git", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-malformed-");
  await createMetadataRef(repo, {
    branch: "validation",
    ref: "refs/tabellio/validations",
    files: { "commits/bad/validation.json": "{not-json\n" },
  });

  const repository = await collectSingleRepository(repo, "malformed");
  const validationSource = repository.sources.find((source) => source.system === "tabellio-validation");

  assert.equal(validationSource.status, "blocked");
  assert.equal(repository.metrics.validationAttemptCount.value, null);
  assert.equal(repository.metrics.commitCount.status, "measured");
});

test("control refs parse quoted paths before enforcing canonical identity", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-quoted-control-");
  const head = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  await createMetadataRef(repo, {
    branch: "quoted-validation",
    ref: "refs/tabellio/validations",
    files: {
      "commits/odd\nname/validation.json": await controlFixture(
        "../examples/tabellio-validation/minimal-result.json",
        "example/analytics",
        head,
      ),
    },
  });
  await createMetadataRef(repo, {
    branch: "quoted-entire",
    ref: "refs/heads/entire/checkpoints/v1",
    files: { "aa/session\nname/metadata.json": "{}" },
  });

  const repository = await collectSingleRepository(repo, "quoted-control");

  assert.equal(
    repository.sources.find((source) => source.system === "tabellio-validation").status,
    "blocked",
  );
  assert.equal(repository.metrics.validationAttemptCount.status, "unavailable");
  assert.equal(repository.metrics.entireCheckpointCount.value, 1);
});

test("misplaced and duplicate control records block inflated metrics", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-duplicate-control-");
  const head = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  const validation = await controlFixture(
    "../examples/tabellio-validation/minimal-result.json",
    "example/analytics",
    head,
  );
  const review = await controlFixture(
    "../examples/tabellio-review/minimal-cycle.json",
    "example/analytics",
    head,
  );
  await createMetadataRef(repo, {
    branch: "duplicate-validation",
    ref: "refs/tabellio/validations",
    files: {
      [`commits/${head}/validation-example-001.json`]: validation,
      [`commits/${head}/validation-copy.json`]: validation,
    },
  });
  await createMetadataRef(repo, {
    branch: "duplicate-review",
    ref: "refs/tabellio/reviews",
    files: {
      "cycles/github-7-2f1c855615a1fc66.json": review,
      "cycles/github-7-1111111111111111.json": review,
    },
  });

  const repository = await collectSingleRepository(repo, "duplicate-control");

  assertControlSourcesBlocked(repository, /path or identity is invalid/);
});

test("schema-invalid control records block their source metrics", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-invalid-record-");
  await createMetadataRef(repo, {
    branch: "validation-invalid",
    ref: "refs/tabellio/validations",
    files: {
      "commits/bad/validation.json": JSON.stringify({
        schemaVersion: "tabellio-validation-result/v0.3",
        status: "passed",
        completedAt: "2026-07-20T12:00:00.000Z",
        validators: [],
      }),
    },
  });

  const repository = await collectSingleRepository(repo, "invalid-record");
  const validationSource = repository.sources.find((source) => source.system === "tabellio-validation");

  assert.equal(validationSource.status, "blocked");
  assert.match(validationSource.reason, /Schema-invalid JSON/);
  assert.equal(repository.metrics.validationAttemptCount.value, null);
});

test("control-ref parse failures never export attacker-controlled paths", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-private-control-path-");
  await createMetadataRef(repo, {
    branch: "private-control-path",
    ref: "refs/tabellio/validations",
    files: { "commits/ghs_private-token.json": "{not-json\n" },
  });

  const repository = await collectSingleRepository(repo, "private-control-path");
  const serialized = JSON.stringify(repository);

  assert.match(
    repository.sources.find((source) => source.system === "tabellio-validation").reason,
    /Malformed JSON in control record/,
  );
  assert(!serialized.includes("ghs_private-token"));
});

test("control records for another repository block their source metrics", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-foreign-control-");
  await createMetadataRef(repo, {
    branch: "foreign-validation",
    ref: "refs/tabellio/validations",
    files: {
      "commits/foreign/validation.json": await controlFixture(
        "../examples/tabellio-validation/minimal-result.json",
        "foreign/repository",
      ),
    },
  });
  await createMetadataRef(repo, {
    branch: "foreign-review",
    ref: "refs/tabellio/reviews",
    files: {
      "cycles/foreign.json": await controlFixture(
        "../examples/tabellio-review/minimal-cycle.json",
        "foreign/repository",
      ),
    },
  });

  const repository = await collectSingleRepository(repo, "foreign-control");

  assertControlSourcesBlocked(repository, /Schema-invalid JSON/);
});

test("control refs newer than the observation are blocked", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-future-control-");
  await createMetadataRef(repo, {
    branch: "future-validation",
    ref: "refs/tabellio/validations",
    committedAt: "2026-07-24T06:00:00Z",
    files: {
      "commits/future/validation.json": await controlFixture(
        "../examples/tabellio-validation/minimal-result.json",
        "example/analytics",
      ),
    },
  });

  const repository = await collectSingleRepository(repo, "future-control");
  const source = repository.sources.find((entry) => entry.system === "tabellio-validation");
  assert.equal(source.status, "blocked");
  assert.match(source.reason, /newer than the requested observation/);
  assert.equal(repository.metrics.validationAttemptCount.status, "unavailable");
});

test("Entire metadata is collected from the configured control remote", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-control-");
  await createMetadataRef(repo, {
    branch: "control-entire",
    ref: "refs/remotes/control/entire/checkpoints/v1",
    files: { "aa/session/metadata.json": "{}" },
  });
  await commitFixtureFile(
    repo,
    "tabellio.platform.json",
    JSON.stringify({ workflow: { controlRemoteName: "control" } }),
    "2026-07-10T12:00:00.000Z",
  );

  const repository = await collectSingleRepository(repo, "control");
  const checkpointMetric = repository.metrics.entireCheckpointCount;

  assert.equal(checkpointMetric.status, "measured");
  assert.equal(checkpointMetric.value, 1);
  assert.equal(
    repository.sources.find((source) => source.system === "entire").sourceVersion.length,
    40,
  );

  await writeFile(join(repo, "tabellio.platform.json"), "{malformed");
  const malformedWorktree = await collectSingleRepository(repo, "control-malformed");
  assert.equal(malformedWorktree.metrics.entireCheckpointCount.status, "unavailable");
});

test("Entire refs newer than the observation are blocked", async (t) => {
  const { repo } = await createEmptyAnalyticsRepository(t, "tabellio-analytics-future-entire-");
  await createMetadataRef(repo, {
    branch: "future-entire",
    ref: "refs/heads/entire/checkpoints/v1",
    committedAt: "2026-07-24T06:00:00Z",
    files: { "aa/session/metadata.json": "{}" },
  });

  const repository = await collectSingleRepository(repo, "future-entire");
  const source = repository.sources.find((entry) => entry.system === "entire");
  assert.equal(source.status, "blocked");
  assert.match(source.reason, /newer than the requested observation/);
  assert.equal(repository.metrics.entireCheckpointCount.status, "unavailable");
});

test("analytics JSON schema remains loadable and identifies the executable contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/analytics-dataset.v0.1.schema.json", import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const, "tabellio-analytics-dataset/v0.1");
  assert.equal(schema.additionalProperties, false);
});

test("published package includes analytics baselines required by product validation", async () => {
  const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert(packageDocument.files.includes("reports"));
});

test("analytics validator separates direct failure exits from runner evidence evaluation", async (t) => {
  const fixture = await createAnalyticsFixture();
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-validator-"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = await collectAnalyticsDataset({
    id: "semantic-failure",
    repositories: [{ id: "fixture", path: fixture.repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const datasetPath = join(root, "dataset.json");
  const reportPath = join(root, "report.md");
  const evidencePath = join(root, "evidence.json");
  const directEvidencePath = join(root, "direct-evidence.json");
  const expectedDigestEvidencePath = join(root, "expected-digest-evidence.json");
  const malformedDatasetPath = join(root, "malformed-dataset.json");
  const malformedEvidencePath = join(root, "malformed-evidence.json");
  const malformedOperationalEvidencePath = join(root, "malformed-operational-evidence.json");
  const invalidJsonDatasetPath = join(root, "invalid-json-dataset.json");
  const invalidJsonEvidencePath = join(root, "invalid-json-evidence.json");
  const missingEvidencePath = join(root, "missing-evidence.json");
  const binaryDatasetPath = join(root, "binary-dataset.json");
  const binaryEvidencePath = join(root, "binary-evidence.json");
  const duplicateDatasetPath = join(root, "duplicate-dataset.json");
  const duplicateReportPath = join(root, "duplicate-report.md");
  const duplicateEvidencePath = join(root, "duplicate-evidence.json");
  const credentialDatasetPath = join(root, "credential-dataset.json");
  const credentialReportPath = join(root, "credential-report.md");
  const credentialEvidencePath = join(root, "credential-evidence.json");
  await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(reportPath, renderAnalyticsReport(dataset));

  await assertValidatorAliasRejected(datasetPath, reportPath, datasetPath, dataset.schemaVersion);

  const validatorInputHardLink = join(root, "validator-input-hard-link.json");
  await link(datasetPath, validatorInputHardLink);
  await assertValidatorAliasRejected(
    datasetPath,
    reportPath,
    validatorInputHardLink,
    dataset.schemaVersion,
  );

  const result = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "semantic",
    "--validator-id", "analytics-semantic-test",
    "--dataset", datasetPath,
    "--report", reportPath,
    "--out", evidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));

  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.artifacts.length, 2);
  assert.equal(evidence.metrics.find((metric) => metric.name === "analytics_semantic_pass").value, 0);

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "schema",
    "--validator-id", "analytics-schema-expected-digest-test",
    "--dataset", datasetPath,
    "--report", reportPath,
    "--expected-digest", "f".repeat(64),
    "--out", expectedDigestEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const expectedDigestEvidence = JSON.parse(
    await readFile(expectedDigestEvidencePath, "utf8"),
  );
  assert.equal(expectedDigestEvidence.status, "failed");
  assert.match(expectedDigestEvidence.summary, /approved baseline digest/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
      "--profile", "semantic",
      "--validator-id", "analytics-semantic-direct-test",
      "--dataset", datasetPath,
      "--report", reportPath,
      "--out", directEvidencePath,
    ], { encoding: "utf8" }),
    (error) => error.code === 1,
  );
  assert.equal(JSON.parse(await readFile(directEvidencePath, "utf8")).status, "failed");

  await writeFile(malformedDatasetPath, JSON.stringify({
    schemaVersion: "tabellio-analytics-dataset/v0.1",
    repositories: [null],
  }));
  const malformedResult = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "semantic",
    "--validator-id", "analytics-semantic-malformed-test",
    "--dataset", malformedDatasetPath,
    "--report", reportPath,
    "--out", malformedEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const malformedEvidence = JSON.parse(await readFile(malformedEvidencePath, "utf8"));

  assert.equal(malformedResult.stderr, "");
  assert.equal(malformedEvidence.status, "failed");
  assert.equal(malformedEvidence.summary.includes("\n"), false);
  assert(malformedEvidence.summary.length <= 2_000);
  assert.equal(
    malformedEvidence.metrics.find((metric) => metric.name === "analytics_semantic_pass").value,
    0,
  );

  await writeFile(invalidJsonDatasetPath, "{invalid-json\n");
  const invalidJsonResult = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "schema",
    "--validator-id", "analytics-schema-invalid-json-test",
    "--dataset", invalidJsonDatasetPath,
    "--report", reportPath,
    "--out", invalidJsonEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const invalidJsonEvidence = JSON.parse(await readFile(invalidJsonEvidencePath, "utf8"));

  assert.equal(invalidJsonResult.stderr, "");
  assert.equal(invalidJsonEvidence.status, "failed");
  assert.equal(invalidJsonEvidence.summary, "Dataset JSON is invalid.");
  assert.equal(invalidJsonEvidence.artifacts.length, 2);
  assert.equal(
    invalidJsonEvidence.metrics.find((metric) => metric.name === "analytics_schema_pass").value,
    0,
  );

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "schema",
    "--validator-id", "analytics-schema-missing-input-test",
    "--dataset", join(root, "missing-dataset.json"),
    "--report", reportPath,
    "--out", missingEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const missingEvidence = JSON.parse(await readFile(missingEvidencePath, "utf8"));
  assert.equal(missingEvidence.status, "blocked");
  assert.equal(missingEvidence.artifacts.length, 1);

  const binaryDataset = Buffer.from([0xff, 0xfe, 0xfd]);
  await writeFile(binaryDatasetPath, binaryDataset);
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "schema",
    "--validator-id", "analytics-schema-binary-input-test",
    "--dataset", binaryDatasetPath,
    "--report", reportPath,
    "--out", binaryEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const binaryEvidence = JSON.parse(await readFile(binaryEvidencePath, "utf8"));
  assert.equal(binaryEvidence.status, "failed");
  assert.equal(binaryEvidence.artifacts[0].bytes, binaryDataset.byteLength);
  assert.equal(
    binaryEvidence.artifacts[0].digest,
    createHash("sha256").update(binaryDataset).digest("hex"),
  );

  const malformedOperationalResult = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "operational",
    "--validator-id", "analytics-operational-malformed-test",
    "--dataset", malformedDatasetPath,
    "--report", reportPath,
    "--out", malformedOperationalEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const malformedOperationalEvidence = JSON.parse(
    await readFile(malformedOperationalEvidencePath, "utf8"),
  );

  assert.equal(malformedOperationalResult.stderr, "");
  assert.equal(malformedOperationalEvidence.status, "failed");

  const duplicateDataset = structuredClone(dataset);
  const repositoryAliases = [
    "Example/Analytics",
    "example/Analytics",
    "EXAMPLE/ANALYTICS",
    "example/analytics",
  ];
  duplicateDataset.repositories = Array.from(
    { length: 4 },
    (_, index) => ({
      ...structuredClone(dataset.repositories[0]),
      id: `duplicate-${index}`,
      canonicalRepositoryId: repositoryAliases[index],
    }),
  );
  resignDataset(duplicateDataset);
  await writeFile(duplicateDatasetPath, JSON.stringify(duplicateDataset));
  await writeFile(duplicateReportPath, renderAnalyticsReport(dataset));
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "semantic",
    "--validator-id", "analytics-semantic-duplicate-test",
    "--dataset", duplicateDatasetPath,
    "--report", duplicateReportPath,
    "--out", duplicateEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const duplicateEvidence = JSON.parse(await readFile(duplicateEvidencePath, "utf8"));

  assert.equal(duplicateEvidence.status, "failed");
  assert.equal(
    duplicateEvidence.metrics.find((metric) => metric.name === "analytics_repository_count").value,
    1,
  );

  const sensitiveDataset = structuredClone(dataset);
  const sensitiveChange = {
    ...providerSnapshotDocument(fixture.head).deliveryChanges[0],
    id: "github_pat_EXPOSED-CREDENTIAL",
  };
  sensitiveDataset.repositories[0].deliveryChanges.push(sensitiveChange, sensitiveChange);
  resignDataset(sensitiveDataset);
  await writeFile(duplicateDatasetPath, JSON.stringify(sensitiveDataset));
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "schema",
    "--validator-id", "analytics-schema-sensitive-summary-test",
    "--dataset", duplicateDatasetPath,
    "--report", reportPath,
    "--out", duplicateEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const sensitiveEvidence = JSON.parse(await readFile(duplicateEvidencePath, "utf8"));

  assert.equal(sensitiveEvidence.status, "failed");
  assert.equal(sensitiveEvidence.summary.includes("github_pat_"), false);
  assert.match(sensitiveEvidence.summary, /Delivery change identity is invalid/);
  assert.equal(sensitiveEvidence.artifacts.length, 2);

  const urlCredentialDataset = structuredClone(dataset);
  urlCredentialDataset["https://alice:hunter2@example.com/private"] = true;
  resignDataset(urlCredentialDataset);
  await writeFile(duplicateDatasetPath, JSON.stringify(urlCredentialDataset));
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "schema",
    "--validator-id", "analytics-schema-url-credential-summary-test",
    "--dataset", duplicateDatasetPath,
    "--report", reportPath,
    "--out", duplicateEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const urlCredentialSummaryEvidence = JSON.parse(
    await readFile(duplicateEvidencePath, "utf8"),
  );
  assert.equal(urlCredentialSummaryEvidence.status, "failed");
  assert.match(urlCredentialSummaryEvidence.summary, /sensitive details were redacted/);
  assert.equal(urlCredentialSummaryEvidence.summary.includes("hunter2"), false);

  const credentialDataset = structuredClone(dataset);
  const unavailableMetric = Object.values(credentialDataset.repositories[0].metrics)
    .find((metric) => metric.status === "unavailable");
  unavailableMetric.reason = "ghs_private-token";
  resignDataset(credentialDataset);
  await writeFile(credentialDatasetPath, JSON.stringify(credentialDataset));
  await writeFile(credentialReportPath, renderAnalyticsReport(dataset));
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "security",
    "--validator-id", "analytics-security-credential-test",
    "--dataset", credentialDatasetPath,
    "--report", credentialReportPath,
    "--out", credentialEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const credentialEvidence = JSON.parse(await readFile(credentialEvidencePath, "utf8"));

  assert.equal(credentialEvidence.status, "failed");
  assert.equal(
    credentialEvidence.metrics.find((metric) => metric.name === "analytics_privacy_pass").value,
    0,
  );

  await writeFile(
    credentialReportPath,
    "Remote URLs remain portable: https://example.com/home/alice\n",
  );
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "security",
    "--validator-id", "analytics-security-url-test",
    "--dataset", datasetPath,
    "--report", credentialReportPath,
    "--out", credentialEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  assert.equal(
    JSON.parse(await readFile(credentialEvidencePath, "utf8")).status,
    "passed",
  );

  await writeFile(
    credentialReportPath,
    [
      "Local paths must be blocked:",
      "/home/alice/repo",
      "/etc/ssh/ssh_config",
      "path=/home/alice/repo",
      "file:///home/alice/repo",
      "C:\\Users\\alice\\repo",
      "\\\\server\\share",
      "",
    ].join("\n"),
  );
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
    "--profile", "security",
    "--validator-id", "analytics-security-path-test",
    "--dataset", datasetPath,
    "--report", credentialReportPath,
    "--out", credentialEvidencePath,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  const pathEvidence = JSON.parse(await readFile(credentialEvidencePath, "utf8"));

  assert.equal(pathEvidence.status, "failed");
  assert.equal(
    pathEvidence.metrics.find((metric) => metric.name === "analytics_privacy_pass").value,
    0,
  );
});

async function assertValidatorAliasRejected(datasetPath, reportPath, outPath, schemaVersion) {
  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url)),
      "--profile", "schema",
      "--validator-id", "analytics-output-alias-test",
      "--dataset", datasetPath,
      "--report", reportPath,
      "--out", outPath,
      "--exit-mode", "evidence",
    ], { encoding: "utf8" }),
    (error) => error.code === 1 && /must not alias an input artifact/.test(error.stderr),
  );
  assert.equal(JSON.parse(await readFile(datasetPath, "utf8")).schemaVersion, schemaVersion);
}

test("analytics semantic and security profiles bind delivery meaning and decoded sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-review-findings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseline = JSON.parse(await readFile(
    new URL("../reports/analytics/2026-07-23-intb-261-baseline.json", import.meta.url),
    "utf8",
  ));
  const reportPath = fileURLToPath(
    new URL("../reports/analytics/2026-07-23-intb-261-baseline.md", import.meta.url),
  );
  const validatorPath = fileURLToPath(
    new URL("../scripts/tabellio-analytics-validator.mjs", import.meta.url),
  );
  const sourcePath = fileURLToPath(
    new URL("../reports/analytics/sources/2026-07-23-tabellio-provider-snapshot.json", import.meta.url),
  );

  async function runProfile(candidate, name, profile = "semantic", extraArgs = []) {
    const datasetPath = join(root, `${name}.json`);
    const evidencePath = join(root, `${name}-evidence.json`);
    await writeFile(datasetPath, JSON.stringify(candidate));
    await execFileAsync(process.execPath, [
      validatorPath,
      "--profile", profile,
      "--validator-id", `analytics-${profile}-${name}`,
      "--dataset", datasetPath,
      "--report", reportPath,
      ...(profile === "semantic" && !extraArgs.includes("--source")
        ? ["--source", sourcePath]
        : []),
      ...extraArgs,
      "--out", evidencePath,
      "--exit-mode", "evidence",
    ], { encoding: "utf8" });
    return JSON.parse(await readFile(evidencePath, "utf8"));
  }

  const wrongRepositorySet = structuredClone(baseline);
  wrongRepositorySet.repositories[0].canonicalRepositoryId = "Substitute/Repository";
  resignDataset(wrongRepositorySet);
  assert.match(
    (await runProfile(wrongRepositorySet, "repository-set")).summary,
    /Canonical baseline repository set does not match/,
  );

  const unlinked = structuredClone(baseline);
  const trace = unlinked.repositories.find((repository) => repository.id === "tabellio")
    .deliveryChanges[0];
  trace.linkBasis = "unlinked";
  trace.linkEvidence = null;
  trace.planeStoryId = null;
  trace.pullRequestNumber = null;
  resignDataset(unlinked);
  assert.match(
    (await runProfile(unlinked, "unlinked-trace")).summary,
    /No linked Plane-to-pull-request delivery trace/,
  );

  const contradictory = structuredClone(baseline);
  contradictory.repositories.find((repository) => repository.id === "tabellio")
    .metrics.deliveryChangeCount.value = 7;
  resignDataset(contradictory);
  assert.match(
    (await runProfile(contradictory, "contradictory-metric")).summary,
    /metric contradicts delivery trace rows/,
  );

  const fabricatedTrace = structuredClone(baseline);
  fabricatedTrace.repositories.find((repository) => repository.id === "tabellio")
    .deliveryChanges[0].planeStoryId = "INTB-999";
  resignDataset(fabricatedTrace);
  assert.match(
    (await runProfile(fabricatedTrace, "fabricated-trace")).summary,
    /Delivery traces do not match the committed provider snapshot/,
  );

  const fabricatedValidationStatus = structuredClone(baseline);
  fabricatedValidationStatus.repositories.find((repository) => repository.id === "tabellio")
    .deliveryChanges[0].validationStatus = "failed";
  resignDataset(fabricatedValidationStatus);
  assert.match(
    (await runProfile(fabricatedValidationStatus, "fabricated-validation-status")).summary,
    /Delivery traces do not match the committed provider snapshot/,
  );

  const unboundRepository = structuredClone(baseline);
  unboundRepository.repositories.find((repository) => repository.id === "condere")
    .deliveryChanges = structuredClone(
      baseline.repositories.find((repository) => repository.id === "tabellio").deliveryChanges,
    );
  resignDataset(unboundRepository);
  assert.match(
    (await runProfile(unboundRepository, "unbound-repository")).summary,
    /provider evidence lacks a decoded source snapshot/,
  );

  const contradictoryCi = structuredClone(baseline);
  const tabellio = contradictoryCi.repositories.find(
    (repository) => repository.id === "tabellio",
  );
  const validationSource = tabellio.sources.find(
    (source) => source.system === "tabellio-validation",
  );
  Object.assign(validationSource, {
    status: "available",
    sourceVersion: "a".repeat(40),
    contentDigest: "b".repeat(64),
    reason: null,
  });
  Object.assign(tabellio.metrics.validationAttemptCount, {
    status: "measured",
    value: 1,
    reason: null,
  });
  Object.assign(tabellio.metrics.validationPassRate, {
    status: "measured",
    value: 1,
    numerator: 1,
    denominator: 1,
    reason: null,
  });
  Object.assign(tabellio.metrics.costTelemetryCoverage, {
    status: "measured",
    value: 1,
    numerator: 1,
    denominator: 1,
    reason: null,
  });
  tabellio.metrics.evidenceCompleteness.value = 1;
  tabellio.metrics.evidenceCompleteness.numerator = 7;
  tabellio.metrics.repositoryAdoption.value = 1;
  tabellio.metrics.repositoryAdoption.numerator = 3;
  Object.assign(tabellio.metrics.ciDisagreementRate, {
    status: "measured",
    value: 1,
    numerator: 1,
    denominator: 1,
    reason: null,
  });
  resignDataset(contradictoryCi);
  assert.match(
    (await runProfile(contradictoryCi, "contradictory-ci")).summary,
    /ciDisagreementRate: metric contradicts delivery trace rows/,
  );

  const decodedPath = structuredClone(baseline);
  decodedPath.repositories[0].metrics.validationPassRate.reason = "/Users/alice/private/repo";
  resignDataset(decodedPath);
  const decodedPathRaw = JSON.stringify(decodedPath)
    .replace("/Users/alice/private/repo", "\\u002fUsers\\u002falice\\u002fprivate\\u002frepo");
  const decodedPathFile = join(root, "decoded-path.json");
  await writeFile(decodedPathFile, decodedPathRaw);
  const decodedPathEvidence = join(root, "decoded-path-evidence.json");
  await execFileAsync(process.execPath, [
    validatorPath,
    "--profile", "security",
    "--validator-id", "analytics-security-decoded-path",
    "--dataset", decodedPathFile,
    "--report", reportPath,
    "--out", decodedPathEvidence,
    "--exit-mode", "evidence",
  ], { encoding: "utf8" });
  assert.equal(JSON.parse(await readFile(decodedPathEvidence, "utf8")).status, "failed");

  const sensitiveSourcePath = join(root, "provider-sensitive-source.json");
  await writeFile(sensitiveSourcePath, JSON.stringify({ reason: "token=private-value" }));
  const sourceEvidence = await runProfile(
    baseline,
    "sensitive-source",
    "security",
    ["--source", sensitiveSourcePath],
  );
  assert.equal(sourceEvidence.status, "failed");
  assert.equal(sourceEvidence.artifacts.length, 3);

  const urlCredentialSourcePath = join(root, "provider-url-credential.json");
  await writeFile(
    urlCredentialSourcePath,
    JSON.stringify({ callback: "https://alice:hunter2@example.com/private" }),
  );
  const urlCredentialEvidence = await runProfile(
    baseline,
    "url-credential-source",
    "security",
    ["--source", urlCredentialSourcePath],
  );
  assert.equal(urlCredentialEvidence.status, "failed");

  const extraFieldSourcePath = join(root, "provider-extra-field.json");
  const extraFieldSource = JSON.parse(await readFile(sourcePath, "utf8"));
  extraFieldSource.privateResponseBody = { customer: "internal provider prose" };
  await writeFile(extraFieldSourcePath, JSON.stringify(extraFieldSource));
  for (const profile of ["semantic", "security"]) {
    const extraFieldEvidence = await runProfile(
      baseline,
      `extra-field-${profile}`,
      profile,
      ["--source", extraFieldSourcePath],
    );
    assert.equal(extraFieldEvidence.status, "failed");
    assert.match(extraFieldEvidence.summary, /unexpected field privateResponseBody/);
  }

  const extraProviderSourcePath = join(root, "provider-extra-source.json");
  const extraProviderSource = JSON.parse(await readFile(sourcePath, "utf8"));
  extraProviderSource.sources.privateProviderResponse = {
    customerNames: ["Acme Internal"],
    body: "confidential issue description",
  };
  await writeFile(extraProviderSourcePath, JSON.stringify(extraProviderSource));
  for (const profile of ["semantic", "security"]) {
    const extraProviderSourceEvidence = await runProfile(
      baseline,
      `extra-provider-source-${profile}`,
      profile,
      ["--source", extraProviderSourcePath],
    );
    assert.equal(extraProviderSourceEvidence.status, "failed");
    assert.match(extraProviderSourceEvidence.summary, /unexpected field privateProviderResponse/);
  }
});

async function createAnalyticsFixture() {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-"));
  const repo = join(root, "repo");
  await initializeRepository(repo);
  const head = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  await createMetadataRef(repo, {
    branch: "validation",
    ref: "refs/tabellio/validations",
    files: {
      [`commits/${head}/validation-example-001.json`]: await controlFixture(
        "../examples/tabellio-validation/minimal-result.json",
        "example/analytics",
        head,
      ),
    },
  });
  await createMetadataRef(repo, {
    branch: "review",
    ref: "refs/tabellio/reviews",
    files: {
      "cycles/github-7-2f1c855615a1fc66.json": await controlFixture(
        "../examples/tabellio-review/minimal-cycle.json",
        "example/analytics",
        head,
      ),
    },
  });
  await createMetadataRef(repo, {
    branch: "entire",
    ref: "refs/heads/entire/checkpoints/v1",
    files: {
      "aa/session/metadata.json": "{}",
      "aa/session/0/metadata.json": "{}",
      "aa/session/0/full.jsonl": "private transcript\n",
    },
  });
  return { root, repo, head };
}

async function createEmptyAnalyticsRepository(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repo = join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);
  return { root, repo };
}

async function collectSingleRepository(repo, id) {
  const dataset = await collectAnalyticsDataset({
    id: `${id}-baseline`,
    repositories: [{ id, path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  return dataset.repositories[0];
}

async function collectProviderRepository(fixture, providerSnapshot, id) {
  const dataset = await collectAnalyticsDataset({
    id: `${id}-baseline`,
    repositories: [{ id: "fixture", path: fixture.repo, providerSnapshot }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  return dataset.repositories[0];
}

function resignDataset(dataset) {
  delete dataset.integrity;
  dataset.integrity = {
    algorithm: "sha256",
    digest: createHash("sha256").update(canonicalJson(dataset)).digest("hex"),
  };
}

function assertControlSourcesBlocked(repository, reason) {
  assert.equal(repository.metrics.validationAttemptCount.status, "unavailable");
  assert.equal(repository.metrics.reviewFindingCount.status, "unavailable");
  for (const system of ["tabellio-validation", "tabellio-review"]) {
    assert.match(repository.sources.find((source) => source.system === system).reason, reason);
  }
}

async function controlFixture(relativeUrl, repositoryId, headCommit = null) {
  const value = JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
  value.repository.id = repositoryId;
  bindValidationHead(value, headCommit);
  bindReviewHead(value, headCommit);
  resignDataset(value);
  return JSON.stringify(value);
}

function bindValidationHead(value, headCommit) {
  if (!headCommit || !value.revision) return;
  value.revision.headCommit = headCommit;
  value.checkpointRevision.headCommit = headCommit;
}

function bindReviewHead(value, headCommit) {
  if (!headCommit || !value.changeRequest) return;
  value.changeRequest.headCommit = headCommit;
  value.checks.commit = headCommit;
}

function setValidationTimes(value, startedAt, completedAt) {
  value.startedAt = startedAt;
  value.completedAt = completedAt;
  for (const command of value.commands) {
    command.startedAt = startedAt;
    command.completedAt = completedAt;
  }
}

function providerSnapshotDocument(headCommit, overrides = {}) {
  return {
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository: "example/analytics",
    capturedAt: OBSERVED_AT,
    sources: overrides.sources ?? {
      plane: { status: "available", version: "plane-2026-07-23" },
      github: { status: "available", version: "github-2026-07-23" },
      "github-actions": { status: "available", version: "actions-2026-07-23" },
    },
    deliveryChanges: overrides.deliveryChanges ?? [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: "Fixture contract",
      planeStoryId: "INTB-1",
      pullRequestNumber: 1,
      storyCreatedAt: "2026-07-10T10:00:00.000Z",
      firstActivityAt: "2026-07-10T12:00:00.000Z",
      mergedAt: "2026-07-11T12:00:00.000Z",
      releasedAt: "2026-07-12T12:00:00.000Z",
      headCommit,
      validationStatus: "passed",
      hostedStatus: "passed",
    }],
  };
}

async function initializeRepository(repo) {
  await runGit({ args: ["init", "--initial-branch=main", repo] });
  await runGit({ cwd: repo, args: ["remote", "add", "origin", "https://github.com/example/analytics.git"] });
  await writeFile(join(repo, "README.md"), "analytics fixture\n");
  await runGit({ cwd: repo, args: ["add", "README.md"] });
  await runGit({
    cwd: repo,
    args: ["commit", "-m", "fixture"],
    env: { ...identityEnv(), GIT_AUTHOR_DATE: "2026-07-10T12:00:00Z", GIT_COMMITTER_DATE: "2026-07-10T12:00:00Z" },
  });
}

async function commitFixtureFile(repo, name, content, committedAt) {
  await writeFile(join(repo, name), content);
  await runGit({ cwd: repo, args: ["add", name] });
  await runGit({
    cwd: repo,
    args: ["commit", "-m", name],
    env: {
      ...identityEnv(),
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
}

async function createMetadataRef(
  repo,
  { branch, ref, files, committedAt = "2026-07-23T19:00:00Z" },
) {
  await runGit({ cwd: repo, args: ["switch", "-c", `metadata-${branch}`] });
  for (const [name, content] of Object.entries(files)) {
    const path = join(repo, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await runGit({ cwd: repo, args: ["add", "-A"] });
  await runGit({
    cwd: repo,
    args: ["commit", "-m", `${branch} metadata`],
    env: {
      ...identityEnv(),
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
  const commit = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  await runGit({ cwd: repo, args: ["update-ref", ref, commit] });
  await runGit({ cwd: repo, args: ["switch", "main"] });
  await runGit({ cwd: repo, args: ["branch", "-D", `metadata-${branch}`] });
}
