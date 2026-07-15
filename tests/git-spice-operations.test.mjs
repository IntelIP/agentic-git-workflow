import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import {
  createStackOperationIntent,
  validateStackOperationApproval,
  validateStackOperationIntent,
} from "../scripts/lib/stack-operation.mjs";
import {
  ApprovedGitSpiceOperations,
  operationArgs,
  repositoryRefsDigest,
} from "../scripts/providers/git-spice-operations.mjs";
import { createFixture } from "./helpers/git-fixture.mjs";

const createdAt = "2026-07-10T20:00:00.000Z";
const approvedAt = "2026-07-10T20:01:00.000Z";
const expiresAt = "2026-07-10T21:01:00.000Z";
const now = new Date("2026-07-10T20:02:00.000Z");

test("approved git-spice operations execute exact safe argument sets and consume approvals", async (t) => {
  const { capturePath, fixture, operations } = await operationsTestFixture(t, { token: "secret-token" });
  assert.ok(!JSON.stringify(operations).includes("secret-token"));
  const refsDigest = await repositoryRefsDigest(fixture.seed);

  const cases = [
    {
      operation: "submit",
      parameters: { draft: true, title: "Agent change", body: "Evidence body" },
      expected: ["--no-prompt", "branch", "submit", "--branch", "feature", "--no-web", "--nav-comment=false", "--draft", "--title", "Agent change", "--body", "Evidence body"],
    },
    {
      operation: "update",
      parameters: { draft: false },
      expected: ["--no-prompt", "branch", "submit", "--branch", "feature", "--update-only", "--no-web", "--nav-comment=false", "--no-draft"],
    },
    {
      operation: "sync",
      parameters: { restack: "none" },
      expected: ["--no-prompt", "repo", "sync", "--restack=none"],
    },
    {
      operation: "restack",
      parameters: {},
      expected: ["--no-prompt", "branch", "restack", "--branch", "feature"],
    },
    {
      operation: "merge",
      parameters: { method: "squash", readyTimeout: "0", mergeTimeout: "2m" },
      expected: ["--no-prompt", "branch", "merge", "--branch", "feature", "--method", "squash", "--ready-timeout", "0", "--merge-timeout", "2m"],
    },
  ];

  for (const [index, item] of cases.entries()) {
    const intent = createStackOperationIntent({
      operation: item.operation,
      repositoryId: "example/repository",
      headCommit: fixture.featureCommit,
      refsDigest,
      branch: "feature",
      parameters: item.parameters,
      createdAt,
    });
    const approval = approvalFor(intent, `approval-${index}`);
    const result = await operations.execute({ intent, approval, repositoryId: "example/repository", now });
    assert.equal(result.status, "succeeded");
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.deepEqual(captured.args, item.expected);
    assert.equal(captured.hasGitHubToken, true);
    assert.equal(captured.hasTargetLock, true);
    assert.deepEqual(operationArgs(intent), item.expected);
    await assert.rejects(
      operations.execute({ intent, approval, repositoryId: "example/repository", now }),
      /already consumed/,
    );
  }
});

test("stack operations fail closed on tampering, expiry, stale heads, and dirty worktrees", async (t) => {
  const { fixture, operations } = await operationsTestFixture(t);
  const refsDigest = await repositoryRefsDigest(fixture.seed);
  const intent = createStackOperationIntent({
    operation: "update",
    repositoryId: "example/repository",
    headCommit: fixture.featureCommit,
    refsDigest,
    branch: "feature",
    parameters: { draft: null },
    createdAt,
  });
  const tampered = structuredClone(intent);
  tampered.parameters.draft = true;
  assert.throws(() => validateStackOperationIntent(tampered), /digest does not match/);
  const expired = { ...approvalFor(intent, "expired"), expiresAt: approvedAt };
  assert.throws(() => validateStackOperationApproval(expired, intent, { now }), /later than/);

  const stale = createStackOperationIntent({
    ...intent,
    repositoryId: intent.repository.id,
    headCommit: "c".repeat(40),
    refsDigest,
    createdAt,
  });
  await assert.rejects(
    operations.execute({ intent: stale, approval: approvalFor(stale, "stale"), repositoryId: "example/repository", now }),
    /Operation head mismatch/,
  );

  await runGit({ args: ["branch", "concurrent-branch", "main"], cwd: fixture.seed });
  await assert.rejects(
    operations.execute({ intent, approval: approvalFor(intent, "refs-changed"), repositoryId: "example/repository", now }),
    /branch-set mismatch/,
  );
  await runGit({ args: ["branch", "-D", "concurrent-branch"], cwd: fixture.seed });

  await writeFile(join(fixture.seed, "dirty.txt"), "dirty\n");
  await assert.rejects(
    operations.execute({ intent, approval: approvalFor(intent, "dirty"), repositoryId: "example/repository", now }),
    /clean working tree/,
  );
});

test("failed execution consumes approval and stores only a safe error", async (t) => {
  const { fixture, operations, stateRoot } = await operationsTestFixture(t, { fail: true, token: "secret-token" });
  const refsDigest = await repositoryRefsDigest(fixture.seed);
  const intent = createStackOperationIntent({
    operation: "submit",
    repositoryId: "example/repository",
    headCommit: fixture.featureCommit,
    refsDigest,
    branch: "feature",
    parameters: { draft: true, title: "Title", body: "private review context" },
    createdAt,
  });
  const approval = approvalFor(intent, "failure");
  await assert.rejects(
    operations.execute({ intent, approval, repositoryId: "example/repository", now }),
    /git-spice submit operation failed/,
  );
  const receipt = JSON.parse(await readFile(join(stateRoot, "failure.json"), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(JSON.stringify(receipt).includes("private review context"), false);
  assert.equal(JSON.stringify(receipt).includes("secret-token"), false);
  assert.match(receipt.error.message, /\[REDACTED\]/);
  await assert.rejects(
    operations.execute({ intent, approval, repositoryId: "example/repository", now }),
    /already consumed/,
  );
});

function approvalFor(intent, id) {
  return {
    schemaVersion: "tabellio-stack-approval/v0.1",
    id,
    intentDigest: intent.integrity.digest,
    approved: true,
    approvedBy: "human-reviewer",
    approvedAt,
    expiresAt,
    reason: "Approved for integration testing.",
  };
}

async function operationsTestFixture(t, { fail = false, token = null } = {}) {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-git-spice-operation-"));
  const capturePath = join(toolRoot, "capture.json");
  const stateRoot = join(toolRoot, "receipts");
  const binary = await fakeGitSpice(toolRoot, { fail });
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(toolRoot, { recursive: true, force: true }),
  ]));
  const env = { CAPTURE_PATH: capturePath };
  if (token) env.GITHUB_TOKEN = token;
  return {
    capturePath,
    fixture,
    stateRoot,
    operations: await ApprovedGitSpiceOperations.open({ repoPath: fixture.seed, stateRoot, binary, env }),
  };
}

async function fakeGitSpice(root, { fail = false } = {}) {
  const binary = join(root, "git-spice");
  const source = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const capture = process.env.CAPTURE_PATH;
let hasTargetLock = false;
try { execFileSync("git", ["rev-parse", "--verify", "refs/tabellio/locks/stack-write-operation"], { stdio: "ignore" }); hasTargetLock = true; } catch {}
if (capture) writeFileSync(capture, JSON.stringify({ args: process.argv.slice(2), hasGitHubToken: Boolean(process.env.GITHUB_TOKEN), hasTargetLock }));
${fail ? 'process.stderr.write("simulated failure private review context secret-token\\n"); process.exit(2);' : "process.exit(0);"}
`;
  await writeFile(binary, source);
  await chmod(binary, 0o755);
  return binary;
}
