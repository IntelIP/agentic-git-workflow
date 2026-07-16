import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { GitJsonLedger } from "../scripts/lib/git-json-ledger.mjs";
import {
  ReviewCycleManager,
  reviewCycleHasReadyEvidence,
  validateAgentReview,
  validateReviewCycle,
} from "../scripts/lib/review-cycle.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { digestObject } from "../scripts/lib/stack-operation.mjs";
import { NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";

const timestamp = "2026-07-10T20:00:00.000Z";

test("review cycle persists GitHub and agent feedback through triage and checkpoint-bound fixes", async (t) => {
  const { fixture, store, ledger } = await createReviewFixture(t);
  const provider = fakeProvider(fixture);
  const manager = new ReviewCycleManager({
    store,
    ledger,
    provider,
    repositoryId: "example/repository",
    owner: "acme",
    repo: "project",
  });

  let result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date(timestamp) });
  assert.equal(result.cycle.status, "blocked");
  assert.equal(result.cycle.feedback.length, 4);
  assert.equal(result.cycle.feedback.find((item) => item.id === "review:31").disposition, "actionable");
  assert.equal(result.cycle.feedback.find((item) => item.id === "review-comment:41").disposition, "pending");
  assert.match(result.version, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

  result = await manager.triage({
    number: 7,
    feedbackId: "review-comment:41",
    disposition: "informational",
    reason: "Style preference only.",
    actor: "review-agent",
    now: new Date("2026-07-10T20:01:00.000Z"),
  });
  result = await manager.triage({
    number: 7,
    feedbackId: "issue-comment:42",
    disposition: "informational",
    reason: "Acknowledged test reminder.",
    actor: "review-agent",
    now: new Date("2026-07-10T20:02:00.000Z"),
  });
  await runGit({ args: ["switch", "feature"], cwd: fixture.seed });
  await writeFile(`${fixture.seed}/review-fix-1.txt`, "fixed\n");
  await runGit({ args: ["add", "review-fix-1.txt"], cwd: fixture.seed });
  await runGit({
    args: ["commit", "-m", "Fix review feedback", "-m", "Entire-Checkpoint: checkpoint-001"],
    cwd: fixture.seed,
    env: identityEnv(),
  });
  const fixCommit1 = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  result = await manager.recordFix({
    number: 7,
    feedbackIds: ["review:31"],
    commit: fixCommit1,
    checkpointId: "checkpoint-001",
    summary: "Address requested change.",
    actor: "fix-agent",
    now: new Date("2026-07-10T20:03:00.000Z"),
  });
  assert.equal(result.cycle.feedback.find((item) => item.id === "review:31").resolution, "fixed");
  assert.equal(result.cycle.fixes[0].checkpointId, "checkpoint-001");
  await assert.rejects(
    manager.triage({
      number: 7,
      feedbackId: "review:31",
      disposition: "informational",
      reason: "Attempt to rewrite fixed history.",
      actor: "review-agent",
    }),
    /cannot be retriaged/,
  );

  result = await manager.importAgentReview({
    number: 7,
    actor: "codex",
    now: new Date("2026-07-10T20:04:00.000Z"),
    input: {
      schemaVersion: "tabellio-agent-review/v0.1",
      reviewId: "codex-review-001",
      reviewer: { id: "codex", runtime: "openai-codex" },
      repository: { id: "example/repository" },
      changeRequest: { number: 7, headCommit: fixture.featureCommit },
      findings: [
        { id: "finding-1", title: "Guard null input", body: "Add a null guard.", severity: "medium", actionable: true, path: "README.md", line: 1 },
        { id: "finding-2", title: "Naming note", body: "Optional naming thought.", severity: "info", actionable: false, path: null, line: null },
      ],
      createdAt: "2026-07-10T20:03:30.000Z",
    },
  });
  assert.equal(result.cycle.status, "blocked");
  assert.equal(result.cycle.feedback.find((item) => item.id.endsWith("finding-1")).disposition, "actionable");

  await writeFile(`${fixture.seed}/review-fix-2.txt`, "fixed again\n");
  await runGit({ args: ["add", "review-fix-2.txt"], cwd: fixture.seed });
  await runGit({
    args: ["commit", "-m", "Fix agent feedback", "-m", "Entire-Checkpoint: checkpoint-002"],
    cwd: fixture.seed,
    env: identityEnv(),
  });
  const fixCommit2 = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  result = await manager.recordFix({
    number: 7,
    feedbackIds: ["agent:codex-review-001:finding-1"],
    commit: fixCommit2,
    checkpointId: "checkpoint-002",
    summary: "Add null guard.",
    actor: "fix-agent",
    now: new Date("2026-07-10T20:05:00.000Z"),
  });
  assert.equal(result.cycle.status, "blocked");
  assert.equal(result.cycle.fixes.at(-1).published, false);
  provider.setChecks("success");
  provider.setHead(fixCommit2);
  result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date("2026-07-10T20:06:00.000Z") });
  assert.equal(result.cycle.status, "ready");
  assert.equal(reviewCycleHasReadyEvidence(result.cycle, fixCommit2), true);
  assert.equal(result.cycle.fixes.length, 2);
  assert.equal(validateReviewCycle(result.cycle), result.cycle);

  provider.setState("merged");
  result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date("2026-07-10T20:06:30.000Z") });
  assert.equal(result.cycle.status, "merged");
  assert.equal(reviewCycleHasReadyEvidence(result.cycle, fixCommit2), true);
  provider.setState("open");

  provider.setDraft(true);
  result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date("2026-07-10T20:07:00.000Z") });
  assert.equal(result.cycle.status, "draft");
  provider.setDraft(false);
  provider.setMergeable(false);
  result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date("2026-07-10T20:08:00.000Z") });
  assert.equal(result.cycle.status, "blocked");

  const tampered = structuredClone(result.cycle);
  tampered.status = "ready";
  assert.throws(() => validateReviewCycle(tampered), /digest does not match|status does not match/);
  const history = await runGit({ args: ["rev-list", "--count", "refs/tabellio/reviews"], cwd: fixture.seed });
  assert.equal(Number(history.stdout.trim()), 10);
  const worktree = await runGit({ args: ["status", "--porcelain=v1"], cwd: fixture.seed });
  assert.equal(worktree.stdout, "");
});

test("review readiness consumes only the latest validation for the exact PR head", async (t) => {
  const { fixture, store, ledger, validationLedger } = await createReviewFixture(t);
  const provider = emptyProvider(fixture);
  const manager = new ReviewCycleManager({
    store,
    ledger,
    validationLedger,
    provider,
    repositoryId: "example/repository",
    owner: "acme",
    repo: "project",
  });

  let result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date(timestamp) });
  assert.equal(result.cycle.status, "validating");
  const passed = validationResult(fixture.featureCommit, "validation-pass", "passed", "2026-07-10T20:01:00.000Z");
  let current = await validationLedger.read(`commits/${fixture.featureCommit}/${passed.runId}.json`);
  await validationLedger.write(`commits/${fixture.featureCommit}/${passed.runId}.json`, passed, { expectedVersion: current.version });
  result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date("2026-07-10T20:02:00.000Z") });
  assert.equal(result.cycle.status, "ready");
  assert.equal(result.cycle.checks.statuses[0].context, "tabellio/test-suite");

  const failed = validationResult(fixture.featureCommit, "validation-fail", "failed", "2026-07-10T20:03:00.000Z");
  current = await validationLedger.read(`commits/${fixture.featureCommit}/${failed.runId}.json`);
  await validationLedger.write(`commits/${fixture.featureCommit}/${failed.runId}.json`, failed, { expectedVersion: current.version });
  result = await manager.sync({ number: 7, actor: "sync-agent", now: new Date("2026-07-10T20:04:00.000Z") });
  assert.equal(result.cycle.status, "blocked");
});

test("agent review contract bounds finding count and text size", () => {
  const input = {
    schemaVersion: "tabellio-agent-review/v0.1",
    reviewId: "bounded-review",
    reviewer: { id: "codex", runtime: "openai-codex" },
    repository: { id: "example/repository" },
    changeRequest: { number: 7, headCommit: "a".repeat(40) },
    findings: [],
    createdAt: timestamp,
  };
  const finding = { id: "finding", title: "Title", body: "Body", severity: "medium", actionable: true, path: null, line: null };
  input.findings = Array.from({ length: 1_001 }, (_value, index) => ({ ...finding, id: `finding-${index}` }));
  assert.throws(() => validateAgentReview(input), /at most 1000/);
  input.findings = [{ ...finding, body: "x".repeat(65_537) }];
  assert.throws(() => validateAgentReview(input), /at most 65536/);
});

async function createReviewFixture(t) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  return {
    fixture,
    store: await NativeGitStore.open(fixture.seed),
    ledger: await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/reviews" }),
    validationLedger: await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" }),
  };
}

function fakeProvider(fixture) {
  let checkState = "failure";
  let headCommit = fixture.featureCommit;
  let draft = false;
  let mergeable = true;
  let state = "open";
  return {
    setChecks(value) { checkState = value; },
    setHead(value) { headCommit = value; },
    setDraft(value) { draft = value; },
    setMergeable(value) { mergeable = value; },
    setState(value) { state = value; },
    async changeRequest() {
      return {
        id: "21",
        number: 7,
        title: "Agent change",
        state,
        draft,
        mergeable,
        source: { branch: "feature", commit: headCommit },
        target: { branch: "main", commit: fixture.mainCommit },
        author: "agent",
        webUrl: "https://github.com/acme/project/pull/7",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
    async listReviews() {
      return [{
        id: "31",
        state: "request_changes",
        body: "Handle the edge case.",
        commit: fixture.featureCommit,
        dismissed: false,
        stale: false,
        author: "reviewer",
        submittedAt: timestamp,
        updatedAt: timestamp,
        webUrl: "https://github.com/acme/project/pull/7#pullrequestreview-31",
      }];
    },
    async listReviewComments() {
      return [{
        id: "41",
        reviewId: "31",
        body: "Consider a clearer name.",
        path: "README.md",
        line: 1,
        commit: fixture.featureCommit,
        author: "reviewer",
        resolvedBy: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        webUrl: "https://github.com/acme/project/pull/7#discussion_r41",
      }];
    },
    async listIssueComments() {
      return [{
        id: "42",
        body: "Please run the full checks.",
        author: "reviewer",
        createdAt: timestamp,
        updatedAt: timestamp,
        webUrl: "https://github.com/acme/project/pull/7#issuecomment-42",
      }];
    },
    async commitStatus() {
      const failed = checkState === "failure";
      return {
        commit: fixture.featureCommit,
        state: checkState,
        total: 1,
        statuses: failed ? [{
          id: "51",
          context: "tests",
          state: "failure",
          description: "Tests failed",
          targetUrl: "https://github.com/acme/project/actions/runs/51",
          createdAt: timestamp,
          updatedAt: timestamp,
        }] : [{
          id: "52",
          context: "tests",
          state: "success",
          description: "Tests passed",
          targetUrl: "https://github.com/acme/project/actions/runs/52",
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
      };
    },
  };
}

function emptyProvider(fixture) {
  return {
    async changeRequest() {
      return {
        id: "21",
        number: 7,
        title: "Agent change",
        state: "open",
        draft: false,
        mergeable: true,
        source: { branch: "feature", commit: fixture.featureCommit },
        target: { branch: "main", commit: fixture.mainCommit },
        author: "agent",
        webUrl: "https://github.com/acme/project/pull/7",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
    async listReviews() { return []; },
    async listReviewComments() { return []; },
    async listIssueComments() { return []; },
    async commitStatus() {
      return { commit: fixture.featureCommit, state: "none", total: 0, statuses: [] };
    },
  };
}

function validationResult(commit, runId, status, completedAt) {
  const commandStatus = status === "passed" ? "passed" : "failed";
  const value = {
    schemaVersion: "tabellio-validation-result/v0.1",
    runId,
    repository: { id: "example/repository" },
    revision: { baseCommit: "a".repeat(40), mergeBase: "a".repeat(40), headCommit: commit },
    suite: { id: "test-suite", manifestPath: "tabellio.validation.json", manifestDigest: "c".repeat(64) },
    runner: { id: "test", runtime: "node-test" },
    status,
    checkpoints: ["checkpoint-001"],
    commands: [{
      id: "tests",
      argv: ["npm", "test"],
      cwd: ".",
      required: true,
      status: commandStatus,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdout: { bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", tail: "", truncated: false },
      stderr: { bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", tail: "", truncated: false },
      startedAt: "2026-07-10T20:00:00.000Z",
      completedAt,
      error: null,
    }],
    startedAt: "2026-07-10T20:00:00.000Z",
    completedAt,
  };
  value.integrity = { algorithm: "sha256", digest: digestObject(value) };
  return value;
}
