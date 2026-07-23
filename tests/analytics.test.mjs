import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectAnalyticsDataset,
  renderAnalyticsReport,
  validateAnalyticsDataset,
} from "../scripts/lib/analytics.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { identityEnv } from "./helpers/git-fixture.mjs";

const OBSERVED_AT = "2026-07-23T20:00:00.000Z";
const SINCE = "2026-07-01T00:00:00.000Z";
const UNTIL = "2026-07-23T19:59:59.000Z";

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
  assert.equal(first.repositories[0].metrics.costTelemetryCoverage.value, 1);
  assert.equal(first.repositories[0].metrics.entireCheckpointCount.value, 1);
  assert.equal(first.repositories[0].metrics.reviewFindingCount.value, 1);
  assert.equal(first.repositories[0].metrics.repairCount.value, 1);
  assert.equal(first.repositories[0].metrics.taskToPrTraceability.value, 1);
  assert.equal(first.repositories[0].metrics.leadTimeHours.value, 26);
  assert.equal(first.repositories[0].metrics.cycleTimeHours.value, 24);
  assert.equal(first.repositories[0].metrics.ciDisagreementRate.value, 0);
  assert.equal(first.repositories[0].metrics.releaseLagHours.value, 24);
  assert(!JSON.stringify(first).includes(fixture.repo));
  assert(!JSON.stringify(first).includes("private transcript"));
  assert.match(renderAnalyticsReport(first), /Missing Evidence/);
  assert.match(renderAnalyticsReport(first), /taskToPrTraceability/);
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

test("malformed validation evidence blocks its metrics without blocking local Git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-malformed-"));
  const repo = join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);
  await createMetadataRef(repo, {
    branch: "validation",
    ref: "refs/tabellio/validations",
    files: { "commits/bad/validation.json": "{not-json\n" },
  });

  const dataset = await collectAnalyticsDataset({
    id: "malformed-baseline",
    repositories: [{ id: "malformed", path: repo }],
    observedAt: OBSERVED_AT,
    since: SINCE,
    until: UNTIL,
  });
  const repository = dataset.repositories[0];
  const validationSource = repository.sources.find((source) => source.system === "tabellio-validation");

  assert.equal(validationSource.status, "blocked");
  assert.equal(repository.metrics.validationAttemptCount.value, null);
  assert.equal(repository.metrics.commitCount.status, "measured");
});

test("analytics JSON schema remains loadable and identifies the executable contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/analytics-dataset.v0.1.schema.json", import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const, "tabellio-analytics-dataset/v0.1");
  assert.equal(schema.additionalProperties, false);
});

async function createAnalyticsFixture() {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-"));
  const repo = join(root, "repo");
  await initializeRepository(repo);
  await createMetadataRef(repo, {
    branch: "validation",
    ref: "refs/tabellio/validations",
    files: {
      "commits/example/validation.json": JSON.stringify({
        schemaVersion: "tabellio-validation-result/v0.3",
        status: "passed",
        completedAt: "2026-07-20T12:00:00.000Z",
        validators: [
          { id: "static", type: "static", required: true, status: "passed" },
          {
            id: "semantic",
            type: "semantic",
            required: true,
            status: "passed",
            evidence: { report: { cost: { telemetry: "available", usd: 0, modelCalls: 0, toolCalls: 0 } } },
          },
        ],
      }),
    },
  });
  await createMetadataRef(repo, {
    branch: "review",
    ref: "refs/tabellio/reviews",
    files: {
      "cycles/example.json": JSON.stringify({ feedback: [{ id: "finding" }], fixes: [{ id: "repair" }] }),
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
  const head = (await runGit({ cwd: repo, args: ["rev-parse", "HEAD"] })).stdout.trim();
  return { root, repo, head };
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
