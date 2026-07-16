import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createControlRefIntent, snapshotControlRefs } from "../scripts/lib/control-ref-transport.mjs";
import { GitJsonLedger } from "../scripts/lib/git-json-ledger.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { createReleaseIntent, validateReleaseApproval, validateReleaseIntent } from "../scripts/lib/release-operation.mjs";
import { planRelease } from "../scripts/lib/release-planner.mjs";
import { ReleaseExecutor } from "../scripts/lib/release-workflow.mjs";
import { ReviewCycleManager } from "../scripts/lib/review-cycle.mjs";
import { NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";
import { platformFixture } from "./helpers/platform-fixture.mjs";

const createdAt = "2026-07-15T12:00:00.000Z";
const approvedAt = "2026-07-15T12:01:00.000Z";
const expiresAt = "2026-07-15T13:01:00.000Z";
const now = new Date("2026-07-15T12:02:00.000Z");

test("release intent binds merged commit, validation, control refs, notes, and approval", () => {
  const intent = exampleIntent();
  assert.equal(validateReleaseIntent(intent), intent);
  const approval = approvalFor(intent, "release-contract");
  assert.equal(validateReleaseApproval(approval, intent, { now }), approval);
  const tampered = structuredClone(intent);
  tampered.release.title = "Changed";
  assert.throws(() => validateReleaseIntent(tampered), /integrity.digest/);
  const longApproval = { ...approval, expiresAt: "2026-07-15T13:01:00.001Z" };
  assert.throws(() => validateReleaseApproval(longApproval, intent, { now }), /must not exceed one hour/);
  assert.throws(() => exampleIntent({ releaseCreatedAt: "1" }), /ISO date-time/);
  assert.throws(() => exampleIntent({ owner: "different" }), /must match/);
  assert.throws(() => exampleIntent({ controlRepositoryId: "github.com/example/repository" }), /must differ/);
});

test("release executor resumes failed phases without repeating completed work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-release-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let failed = false;
  const actions = {
    async run(phase) {
      calls.push(phase);
      if (phase === "tag" && !failed) {
        failed = true;
        throw new Error("simulated tag failure");
      }
      return { phase };
    },
  };
  const executor = new ReleaseExecutor({
    repoPath: root,
    stateRoot: root,
    actions,
    lockRunner: async (_options, action) => action(),
  });
  const intent = exampleIntent();
  const approval = approvalFor(intent, "resume-release");
  await assert.rejects(executor.execute({ intent, approval, now }), /simulated tag failure/);
  const receipt = await executor.execute({ intent, approval, now });
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(calls, ["verify", "control-refs", "tag", "verify", "tag", "github-release"]);
  assert.equal(receipt.phases.every((phase) => phase.status === "completed"), true);
});

test("release executor serializes concurrent execution of the same approval", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  let unblock;
  const actions = {
    async run(phase) {
      if (phase === "verify") await new Promise((resolve) => { unblock = resolve; });
      return { phase };
    },
  };
  const executor = new ReleaseExecutor({
    repoPath: fixture.seed,
    stateRoot: join(fixture.root, "release-lock-state"),
    actions,
  });
  const intent = exampleIntent();
  const approval = approvalFor(intent, "concurrent-release");
  const first = executor.execute({ intent, approval, now });
  while (!unblock) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(executor.execute({ intent, approval, now }), /Another release operation is active/);
  unblock();
  assert.equal((await first).status, "succeeded");
});

test("approved release publishes exact control ref, annotated tag, and GitHub release in isolated repos", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await configureRepositoryIdentity(fixture.seed);
  const control = join(fixture.root, "control.git");
  await NativeGitStore.createBare(control);
  await runGit({ args: ["remote", "add", "control", control], cwd: fixture.seed });
  const notesPath = "docs/releases/v1.2.3.md";
  await mkdir(join(fixture.seed, "docs", "releases"), { recursive: true });
  await writeFile(join(fixture.seed, "package.json"), '{"version":"1.2.3"}\n');
  await writeFile(join(fixture.seed, notesPath), "Release 1.2.3\n");
  await runGit({ args: ["add", "package.json", notesPath], cwd: fixture.seed });
  await runGit({
    args: ["commit", "-m", "Prepare release", "-m", "Entire-Checkpoint: abcdef123456"],
    cwd: fixture.seed,
    env: identityEnv(),
  });
  await runGit({ args: ["push", "origin", "main"], cwd: fixture.seed });
  const store = await NativeGitStore.open(fixture.seed);
  const repositoryId = "github.com/example/repository";
  const head = await store.resolveRef("HEAD");
  const parent = await store.resolveRef("HEAD^");
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const validationWrite = await ledger.write("commits/result.json", { status: "passed" }, { expectedVersion: null });
  const controlIntent = createControlRefIntent({
    operation: "publish",
    repositoryId,
    remote: "control",
    refs: await snapshotControlRefs({ repoPath: fixture.seed, remote: "control", refs: ["refs/tabellio/validations"] }),
    createdAt,
  });
  const intent = createReleaseIntent({
    repository: { id: repositoryId, owner: "example", name: "repository" },
    version: "1.2.3",
    revision: { commit: head, parent },
    pullRequest: { number: 7, headCommit: parent, mergeCommit: head },
    controlIntent,
    controlRepository: { id: "github.com/example/repository-control" },
    validation: { runId: "validation-test", resultVersion: validationWrite.version, status: "passed", headCommit: head },
    release: { title: "Tabellio v1.2.3", notesPath, notesDigest: digest("Release 1.2.3\n") },
    createdAt,
  });
  const ghCalls = [];
  const publishedNotes = [];
  let existingRelease = null;
  const commandRunner = async ({ args }) => {
    ghCalls.push(args);
    if (args[1] === "view") {
      if (existingRelease) return { stdout: JSON.stringify(existingRelease), stderr: "", exitCode: 0, signal: null };
      throw Object.assign(new Error("not found"), { exitCode: 1 });
    }
    const notesFile = args[args.indexOf("--notes-file") + 1];
    publishedNotes.push(await readFile(notesFile, "utf8"));
    return { stdout: "https://github.com/example/repository/releases/tag/v1.2.3\n", stderr: "", exitCode: 0, signal: null };
  };
  const stateRoot = join(fixture.root, "release-state");
  let liveReads = 0;
  let currentControlIdentity = intent.control.repository.id;
  let currentControlPrivate = true;
  const executor = await ReleaseExecutor.open({
    repoPath: fixture.seed,
    stateRoot,
    commandRunner,
    remoteRefReader: async () => { liveReads += 1; return head; },
    codeRepositoryReader: async () => repositoryId,
    controlRepositoryReader: async () => ({ id: currentControlIdentity, isPrivate: currentControlPrivate }),
  });
  const approval = approvalFor(intent, "publish-release");
  await runGit({ args: ["tag", intent.tag, head], cwd: fixture.seed });
  await runGit({ args: ["push", "origin", intent.tag], cwd: fixture.seed });
  await runGit({ args: ["tag", "-d", intent.tag], cwd: fixture.seed });
  const rejectControl = join(control, "hooks", "pre-receive");
  await writeFile(rejectControl, "#!/bin/sh\nexit 1\n");
  await chmod(rejectControl, 0o755);
  await assert.rejects(executor.execute({ intent, approval, now }), /git push/);
  await rm(rejectControl);
  currentControlIdentity = "github.com/example/retargeted-control";
  await assert.rejects(executor.execute({ intent, approval, now }), /control repository identity changed/);
  currentControlIdentity = intent.control.repository.id;
  currentControlPrivate = false;
  await assert.rejects(executor.execute({ intent, approval, now }), /control repository is not private/);
  currentControlPrivate = true;
  await assert.rejects(executor.execute({ intent, approval, now }), /remotely as a lightweight tag/);
  await runGit({ args: ["push", "origin", `:refs/tags/${intent.tag}`], cwd: fixture.seed });
  await writeFile(join(fixture.seed, notesPath), "MUTATED WORKTREE NOTES\n");
  await assert.rejects(executor.execute({ intent, approval, now }), /clean worktree/);
  await runGit({ args: ["restore", notesPath], cwd: fixture.seed });
  const receipt = await executor.execute({ intent, approval, now });
  assert.equal(receipt.status, "succeeded");
  assert.equal(liveReads, 6);
  assert.equal(ghCalls.length, 2);
  assert.deepEqual(publishedNotes, ["Release 1.2.3\n"]);
  const remoteTag = await runGit({ args: ["ls-remote", "--tags", "origin", "refs/tags/v1.2.3^{}"], cwd: fixture.seed });
  assert.equal(remoteTag.stdout.split(/\s+/)[0], head);
  const remoteControl = await runGit({ args: ["ls-remote", "control", "refs/tabellio/validations"], cwd: fixture.seed });
  assert.equal(remoteControl.stdout.split(/\s+/)[0], controlIntent.refs[0].localOid);
  const stored = JSON.parse(await readFile(join(stateRoot, "publish-release.json"), "utf8"));
  assert.equal(stored.status, "succeeded");

  existingRelease = {
    tagName: intent.tag,
    name: intent.release.title,
    body: "wrong release body\n",
    url: "https://github.com/example/repository/releases/tag/v1.2.3",
    isDraft: false,
    isPrerelease: false,
  };
  await assert.rejects(
    executor.execute({ intent, approval: approvalFor(intent, "mismatched-existing-release"), now }),
    /Existing GitHub release does not match final release intent/,
  );
});

test("release planning binds merged PR proof after exact validation and terminal review sync", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const control = join(fixture.root, "control-plan.git");
  await NativeGitStore.createBare(control);
  await runGit({ args: ["remote", "add", "control", control], cwd: fixture.seed });
  const notesPath = "docs/releases/v2.0.0.md";
  await mkdir(join(fixture.seed, "docs", "releases"), { recursive: true });
  await writeFile(join(fixture.seed, "package.json"), '{"version":"2.0.0"}\n');
  await writeFile(join(fixture.seed, "CHANGELOG.md"), "## 2.0.0 - 2026-07-15\n");
  await writeFile(join(fixture.seed, notesPath), "Release 2.0.0\n");
  await writeFile(join(fixture.seed, "tabellio.validation.json"), JSON.stringify({
    schemaVersion: "tabellio-validation/v0.1",
    id: "release-plan-test",
    failFast: true,
    requireEntireCheckpoint: true,
    commands: [{ id: "pass", argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeoutMs: 10_000, required: true }],
  }));
  await writeFile(join(fixture.seed, "tabellio.platform.json"), JSON.stringify(platformFixture()));
  await runGit({ args: ["add", "package.json", "CHANGELOG.md", "tabellio.validation.json", "tabellio.platform.json", notesPath], cwd: fixture.seed });
  await runGit({
    args: ["commit", "-m", "Merge release", "-m", "Entire-Checkpoint: abcdef123456"],
    cwd: fixture.seed,
    env: identityEnv(),
  });
  await runGit({ args: ["push", "origin", "main"], cwd: fixture.seed });
  await runGit({ args: ["remote", "set-url", "origin", "https://github.com/example/repository.git"], cwd: fixture.seed });
  await runGit({ args: ["remote", "set-url", "control", "https://github.com/example/repository-control.git"], cwd: fixture.seed });
  await runGit({ args: ["config", `url.file://${control}.insteadOf`, "https://github.com/example/repository-control.git"], cwd: fixture.seed });
  const store = await NativeGitStore.open(fixture.seed);
  const head = await store.resolveRef("HEAD");
  const parent = await store.resolveRef("HEAD^");
  await runGit({ args: ["update-ref", "refs/heads/entire/checkpoints/v1", head], cwd: fixture.seed });
  const provider = mergedProvider({ head: parent, base: parent });
  const reviewLedger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/reviews" });
  const readyManager = new ReviewCycleManager({
    store,
    ledger: reviewLedger,
    provider: readyProvider({ head: parent, base: parent }),
    repositoryId: "github.com/example/repository",
    owner: "example",
    repo: "repository",
  });
  assert.equal((await readyManager.sync({ number: 9, actor: "test", now })).cycle.status, "ready");
  const commandRunner = async ({ args }) => {
    if (args[0] === "pr" && args[1] === "view") {
      return { stdout: JSON.stringify({ state: "MERGED", headRefOid: parent, mergeCommit: { oid: head } }), stderr: "", exitCode: 0, signal: null };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(planRelease({
    repoPath: fixture.seed,
    owner: "example",
    repo: "repository",
    number: 9,
    version: "2.0.0",
    notesPath,
    manifestPath: "alternate.validation.json",
    preflightRunner: async () => ({ status: "ready", checks: [] }),
    now,
  }), /manifestPath must be "tabellio.validation.json"/);
  await assert.rejects(planRelease({
    repoPath: fixture.seed,
    owner: "example",
    repo: "other-repository",
    number: 9,
    version: "2.0.0",
    notesPath,
    preflightRunner: async () => ({ status: "ready", checks: [] }),
    now,
  }), /does not match origin example\/repository/);
  const intent = await planRelease({
    repoPath: fixture.seed,
    repositoryId: "github.com/example/repository",
    owner: "example",
    repo: "repository",
    number: 9,
    version: "2.0.0",
    notesPath,
    token: "test-token",
    commandRunner,
    preflightRunner: async () => ({ status: "ready", checks: [] }),
    githubProvider: provider,
    now,
  });
  assert.equal(intent.revision.commit, head);
  assert.equal(intent.pullRequest.headCommit, parent);
  assert.equal(intent.validation.status, "passed");
  assert.equal(intent.control.repository.id, "github.com/example/repository-control");
  assert.equal(intent.control.intent.refs.length, 3);
  assert.equal(validateReleaseIntent(intent), intent);
});

test("release receipt schema fixes every phase to its canonical position", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/release-operation-receipt.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.phases.prefixItems.map((entry) => entry.$ref), [
    "#/$defs/verifyPhase",
    "#/$defs/controlRefsPhase",
    "#/$defs/tagPhase",
    "#/$defs/githubReleasePhase",
  ]);
  assert.equal(schema.properties.phases.items, false);
  assert.equal(schema.$defs.verifyPhase.allOf[1].properties.id.const, "verify");
  assert.equal(schema.$defs.controlRefsPhase.allOf[1].properties.id.const, "control-refs");
  assert.equal(schema.$defs.tagPhase.allOf[1].properties.id.const, "tag");
  assert.equal(schema.$defs.githubReleasePhase.allOf[1].properties.id.const, "github-release");
});

function exampleIntent({
  releaseCreatedAt = createdAt,
  repositoryId = "github.com/example/repository",
  owner = "example",
  repoName = "repository",
  controlRepositoryId = "github.com/example/repository-control",
} = {}) {
  const controlIntent = createControlRefIntent({
    operation: "publish",
    repositoryId,
    remote: "control",
    refs: [{ name: "refs/tabellio/validations", localOid: "c".repeat(40), remoteOid: "b".repeat(40) }],
    createdAt,
  });
  return createReleaseIntent({
    repository: { id: repositoryId, owner, name: repoName },
    version: "1.2.3",
    revision: { commit: "d".repeat(40), parent: "a".repeat(40) },
    pullRequest: { number: 7, headCommit: "c".repeat(40), mergeCommit: "d".repeat(40) },
    controlIntent,
    controlRepository: { id: controlRepositoryId },
    validation: { runId: "validation-example", resultVersion: "e".repeat(40), status: "passed", headCommit: "d".repeat(40) },
    release: { title: "Tabellio v1.2.3", notesPath: "docs/releases/v1.2.3.md", notesDigest: digest("notes") },
    createdAt: releaseCreatedAt,
  });
}

function approvalFor(intent, id) {
  return {
    schemaVersion: "tabellio-release-approval/v0.1",
    id,
    intentDigest: intent.integrity.digest,
    approved: true,
    approvedBy: "human-reviewer",
    approvedAt,
    expiresAt,
    reason: "Approved exact release operation.",
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function configureRepositoryIdentity(repoPath) {
  await runGit({ args: ["config", "user.name", "Tabellio Test"], cwd: repoPath });
  await runGit({ args: ["config", "user.email", "tabellio@example.invalid"], cwd: repoPath });
}

function mergedProvider({ head, base }) {
  return {
    async changeRequest() {
      return {
        id: "9",
        number: 9,
        title: "Release",
        state: "merged",
        draft: false,
        mergeable: null,
        source: { branch: "release", commit: head },
        target: { branch: "main", commit: base },
        author: "agent",
        webUrl: "https://github.com/example/repository/pull/9",
        createdAt,
        updatedAt: createdAt,
      };
    },
    async listReviews() { return []; },
    async listReviewComments() { return []; },
    async listIssueComments() { return []; },
    async commitStatus() { return { commit: head, state: "success", total: 0, statuses: [] }; },
  };
}

function readyProvider({ head, base }) {
  const provider = mergedProvider({ head, base });
  return {
    ...provider,
    async changeRequest() {
      return { ...await provider.changeRequest(), state: "open", mergeable: true };
    },
  };
}
