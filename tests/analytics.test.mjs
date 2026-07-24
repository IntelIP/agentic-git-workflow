import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      "commits/past/validation.json": JSON.stringify(past),
      "commits/future/validation.json": JSON.stringify(future),
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

  const missingActions = providerSnapshotDocument(fixture.head);
  missingActions.sources["github-actions"] = { status: "unavailable", reason: "Actions capture unavailable." };
  missingActions.deliveryChanges[0].validationStatus = "failed";
  missingActions.deliveryChanges[0].hostedStatus = "passed";
  await writeFile(providerSnapshot, JSON.stringify(missingActions));

  const withoutActions = await collectProviderRepository(fixture, providerSnapshot, "provider-without-actions");

  assert.equal(withoutActions.deliveryChanges[0].validationStatus, "passed");
  assert.equal(withoutActions.deliveryChanges[0].hostedStatus, "unavailable");
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

  assert.equal(repository.metrics.validationAttemptCount.status, "unavailable");
  assert.equal(repository.metrics.reviewFindingCount.status, "unavailable");
  assert.match(
    repository.sources.find((source) => source.system === "tabellio-validation").reason,
    /Schema-invalid JSON/,
  );
  assert.match(
    repository.sources.find((source) => source.system === "tabellio-review").reason,
    /Schema-invalid JSON/,
  );
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

test("analytics JSON schema remains loadable and identifies the executable contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/analytics-dataset.v0.1.schema.json", import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const, "tabellio-analytics-dataset/v0.1");
  assert.equal(schema.additionalProperties, false);
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
  const malformedDatasetPath = join(root, "malformed-dataset.json");
  const malformedEvidencePath = join(root, "malformed-evidence.json");
  const malformedOperationalEvidencePath = join(root, "malformed-operational-evidence.json");
  const duplicateDatasetPath = join(root, "duplicate-dataset.json");
  const duplicateReportPath = join(root, "duplicate-report.md");
  const duplicateEvidencePath = join(root, "duplicate-evidence.json");
  const credentialDatasetPath = join(root, "credential-dataset.json");
  const credentialReportPath = join(root, "credential-report.md");
  const credentialEvidencePath = join(root, "credential-evidence.json");
  await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(reportPath, renderAnalyticsReport(dataset));

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
  assert.equal(evidence.metrics.find((metric) => metric.name === "analytics_semantic_pass").value, 0);

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
    repositories: [{ deliveryChanges: [null], metrics: {}, sources: {} }],
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
  assert.equal(
    malformedEvidence.metrics.find((metric) => metric.name === "analytics_semantic_pass").value,
    0,
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
  await writeFile(duplicateReportPath, renderAnalyticsReport(duplicateDataset));
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

  const credentialDataset = structuredClone(dataset);
  const unavailableMetric = Object.values(credentialDataset.repositories[0].metrics)
    .find((metric) => metric.status === "unavailable");
  unavailableMetric.reason = "ghs_private-token";
  resignDataset(credentialDataset);
  await writeFile(credentialDatasetPath, JSON.stringify(credentialDataset));
  await writeFile(credentialReportPath, renderAnalyticsReport(credentialDataset));
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

async function createAnalyticsFixture() {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-"));
  const repo = join(root, "repo");
  await initializeRepository(repo);
  const head = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  await createMetadataRef(repo, {
    branch: "validation",
    ref: "refs/tabellio/validations",
    files: {
      "commits/example/validation.json": await controlFixture(
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
      "cycles/example.json": await controlFixture(
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

async function createMetadataRef(repo, { branch, ref, files }) {
  await runGit({ cwd: repo, args: ["switch", "-c", `metadata-${branch}`] });
  for (const [name, content] of Object.entries(files)) {
    const path = join(repo, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await runGit({ cwd: repo, args: ["add", "-A"] });
  await runGit({ cwd: repo, args: ["commit", "-m", `${branch} metadata`], env: identityEnv() });
  const commit = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  await runGit({ cwd: repo, args: ["update-ref", ref, commit] });
  await runGit({ cwd: repo, args: ["switch", "main"] });
  await runGit({ cwd: repo, args: ["branch", "-D", `metadata-${branch}`] });
}
