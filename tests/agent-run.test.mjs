import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { AgentRunManager } from "../scripts/lib/agent-run.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url).pathname;
const cli = join(projectRoot, "scripts/tabellio-run.mjs");

test("agent-run CLI completes checkpointed work and promotes exact validated head", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "agent-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-e2e"];

  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--base", "main",
    "--task-summary", "exercise the local lifecycle",
  ]);
  assert.equal(started.state.status, "active");
  assert.equal(started.state.repository.baseCommit, fixture.mainCommit);

  await writeFile(join(started.paths.workspace, "AGENT.md"), "checkpointed change\n");
  await commitAll(started.paths.workspace, "agent checkpoint");
  const checkpointed = await runCli(["checkpoint", ...common, "--summary", "first committed change"]);
  assert.equal(checkpointed.state.checkpoints.length, 1);

  await writeFile(join(started.paths.workspace, "FINAL.md"), "validated change\n");
  await commitAll(started.paths.workspace, "agent finish");
  const finished = await runCli([
    "finish", ...common, "--",
    process.execPath, "-e", "if (!require('fs').existsSync('FINAL.md')) process.exit(9)",
  ]);
  assert.equal(finished.state.status, "completed");
  assert.equal(finished.state.validation.status, "passed");

  const context = JSON.parse(await readFile(finished.paths.context, "utf8"));
  const evidence = JSON.parse(await readFile(finished.paths.evidence, "utf8"));
  assert.deepEqual(context.changeSet.files.map((file) => file.path), ["AGENT.md", "FINAL.md"]);
  assert.deepEqual(context.checkpoints.map((checkpoint) => checkpoint.summary), ["first committed change"]);
  assert.equal(evidence.git.sha, context.refs.head.commit);
  assert.equal(evidence.context.digest, context.integrity.digest);
  assert.equal(evidence.artifacts[0].path, "tabellio-evidence.json");
  assert(evidence.commandsRun.some((command) => command.status === "passed" && command.command.includes("FINAL.md")));
  assert.doesNotMatch(await readFile(finished.paths.state, "utf8"), new RegExp(escapeRegExp(fixture.root)));
  assert.doesNotMatch(await readFile(finished.paths.evidence, "utf8"), new RegExp(escapeRegExp(fixture.root)));

  const promoted = await runCli(["promote", ...common]);
  assert.equal(promoted.state.status, "promoted");
  const store = await NativeGitStore.open(fixture.bare);
  assert.equal(await store.resolveRef("refs/heads/main"), promoted.state.headCommit);
  assert.deepEqual((await runCli(["status", ...common])).state, promoted.state);
  assert.deepEqual((await runCli(["promote", ...common])).state, promoted.state);
});

test("agent-run CLI anchors its default state root to the target repository", async (t) => {
  const fixture = await createFixture();
  const callerRoot = await mkdtemp(join(tmpdir(), "tabellio-agent-run-caller-"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  t.after(() => rm(callerRoot, { recursive: true, force: true }));

  const common = ["--repo", fixture.seed, "--run-id", "run-default-root"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/default-root",
    "--task-summary", "anchor state to target repository",
  ], { cwd: callerRoot });

  assert.equal(started.paths.state, join(await realpath(fixture.seed), ".tabellio", "runs", "run-default-root.json"));
  assert.equal((await runCli(["status", ...common], { cwd: projectRoot })).state.status, "active");
  await assert.rejects(readFile(join(callerRoot, ".tabellio", "runs", "run-default-root.json"), "utf8"), { code: "ENOENT" });
});

test("agent-run CLI records failed validation and blocks promotion", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "failed-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-failed"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "record failed validation",
  ]);
  await writeFile(join(started.paths.workspace, "FAILURE.md"), "committed\n");
  await commitAll(started.paths.workspace, "failing run");

  const failed = await runCliFailure(["finish", ...common, "--", process.execPath, "-e", "process.exit(7)"]);
  assert.equal(failed.state.status, "validation_failed");
  assert.equal(failed.state.validation.exitCode, 7);
  const failedCommand = JSON.parse(await readFile(failed.paths.evidence, "utf8")).commandsRun[0];
  assert.equal(failedCommand.status, "failed");
  assert.equal(failedCommand.exitCode, 7);

  const blocked = await runCliFailure(["promote", ...common]);
  assert.match(blocked.error, /status validation_failed/);
  const store = await NativeGitStore.open(fixture.bare);
  assert.equal(await store.resolveRef("refs/heads/main"), fixture.mainCommit);
});

test("agent-run promotion rejects a target branch that moved after start", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "stale-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-stale"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "reject stale promotion",
  ]);
  await writeFile(join(started.paths.workspace, "AGENT.md"), "agent\n");
  await commitAll(started.paths.workspace, "agent work");
  const finished = await runCli(["finish", ...common, "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(finished.state.status, "completed");

  await writeFile(join(fixture.seed, "CONCURRENT.md"), "concurrent\n");
  await commitAll(fixture.seed, "concurrent base change");
  await runGit({ args: ["push", "origin", "main"], cwd: fixture.seed });

  const blocked = await runCliFailure(["promote", ...common]);
  assert.equal(blocked.name, "RefConflictError");
  assert.match(blocked.error, /changed; expected/);
  assert.equal((await runCli(["status", ...common])).state.status, "completed");
});

test("agent-run checkpoint rejects uncommitted workspace changes", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "dirty-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-dirty"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "reject dirty checkpoint",
  ]);
  await writeFile(join(started.paths.workspace, "DIRTY.md"), "dirty\n");
  const blocked = await runCliFailure(["checkpoint", ...common, "--summary", "not committed"]);
  assert.match(blocked.error, /workspace must be clean/);
});

test("agent-run finish rejects validation that changes branch HEAD", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "mutating-validation-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-mutating-validation"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "reject validation commits",
  ]);
  await writeFile(join(started.paths.workspace, "AGENT.md"), "agent\n");
  await commitAll(started.paths.workspace, "agent work");
  const validatedHead = await runGit({ args: ["rev-parse", "HEAD"], cwd: started.paths.workspace }).then((result) => result.stdout.trim());

  const failed = await runCliFailure([
    "finish", ...common, "--",
    "git", "-c", "user.name=Tabellio Test", "-c", "user.email=tabellio@example.invalid",
    "commit", "--allow-empty", "-m", "validation mutation",
  ]);
  assert.equal(failed.state.status, "validation_failed");
  assert.equal(failed.state.headCommit, validatedHead);
  assert.equal(failed.state.validation.error, "Validation changed the run branch HEAD.");
  assert.equal(failed.state.validation.exitCode, 1);
  assert.notEqual(await runGit({ args: ["rev-parse", "HEAD"], cwd: started.paths.workspace }).then((result) => result.stdout.trim()), validatedHead);
});

test("agent-run finish rejects a workspace switched away from its run branch", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "switched-workspace-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-switched-workspace"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "reject a different checked-out branch",
  ]);
  await runGit({ args: ["switch", "-c", "other/workspace"], cwd: started.paths.workspace });

  const blocked = await runCliFailure(["finish", ...common, "--", process.execPath, "-e", "process.exit(0)"]);
  assert.match(blocked.error, /must have refs\/heads\/agent\/run-switched-workspace checked out/);
  assert.equal((await runCli(["status", ...common])).state.status, "active");
});

test("agent-run finish records validation that switches the workspace branch as failed", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "validation-switch-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-validation-switch"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "record validation branch switches",
  ]);
  await writeFile(join(started.paths.workspace, "AGENT.md"), "agent\n");
  await commitAll(started.paths.workspace, "agent work");

  const failed = await runCliFailure(["finish", ...common, "--", "git", "switch", "-c", "validation/other"]);
  assert.equal(failed.state.status, "validation_failed");
  assert.equal(failed.state.validation.error, "Validation changed the checked-out workspace branch.");
  assert.equal(failed.state.validation.exitCode, 1);
});

test("agent-run start validates branch before creating durable state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "invalid-start-runs");
  const common = ["--repo", fixture.bare, "--run-root", runRoot, "--run-id", "run-invalid-start"];
  const failed = await runCliFailure([
    "start", ...common,
    "--branch", "invalid branch",
    "--repo-id", "example/agent-run",
    "--task-summary", "reject invalid branch",
  ]);
  assert.match(failed.error, /Invalid branch name/);
  await assert.rejects(readFile(join(runRoot, "runs", "run-invalid-start.json"), "utf8"), { code: "ENOENT" });

  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/agent-run",
    "--task-summary", "retry valid start",
  ]);
  assert.equal(started.state.status, "active");
});

test("agent-run start removes provisional state when worktree creation fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-agent-run-start-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspaces");
  await Promise.all([mkdir(join(root, "runs")), mkdir(join(root, "artifacts")), mkdir(workspaceRoot)]);
  const oid = "a".repeat(40);
  const store = {
    repoPath: root,
    async validateBranch() {},
    async hasRef() { return false; },
    async resolveRef() { return oid; },
    async createWorkspace() { throw new Error("simulated worktree failure"); },
  };
  const manager = new AgentRunManager({ store, runRoot: root, workspaceRoot });

  await assert.rejects(
    manager.start({
      runId: "run-worktree-failure",
      repositoryId: "example/repository",
      taskSummary: "clean provisional state",
    }),
    /simulated worktree failure/,
  );
  await assert.rejects(readFile(join(root, "runs", "run-worktree-failure.json"), "utf8"), { code: "ENOENT" });
});

test("agent-run promotion fast-forwards a checked-out target without desynchronizing it", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = join(fixture.root, "normal-repository-runs");
  const common = ["--repo", fixture.seed, "--run-root", runRoot, "--run-id", "run-normal"];
  const started = await runCli([
    "start", ...common,
    "--repo-id", "example/normal-repository",
    "--task-summary", "keep checked-out main synchronized",
  ]);
  await writeFile(join(started.paths.workspace, "PROMOTED.md"), "promoted\n");
  await commitAll(started.paths.workspace, "normal repository agent work");
  const finished = await runCli(["finish", ...common, "--", process.execPath, "-e", "process.exit(0)"]);
  await writeFile(join(fixture.seed, "README.md"), "uncommitted base edit\n");
  const blocked = await runCliFailure(["promote", ...common]);
  assert.match(blocked.error, /has tracked changes/);
  await writeFile(join(fixture.seed, "README.md"), "main\n");
  const promoted = await runCli(["promote", ...common]);

  assert.equal(promoted.state.status, "promoted");
  assert.equal(await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed }).then((result) => result.stdout.trim()), finished.state.headCommit);
  assert.equal(await readFile(join(fixture.seed, "PROMOTED.md"), "utf8"), "promoted\n");
  assert.equal(await runGit({ args: ["status", "--porcelain"], cwd: fixture.seed }).then((result) => result.stdout), "");
});

async function runCli(args, { cwd = projectRoot } = {}) {
  const result = await execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, USER: "tabellio-test" },
  });
  return JSON.parse(result.stdout);
}

async function runCliFailure(args) {
  try {
    await runCli(args);
  } catch (error) {
    return JSON.parse(error.stdout || error.stderr);
  }
  assert.fail("Expected command to fail.");
}

async function commitAll(cwd, message) {
  await runGit({ args: ["add", "-A"], cwd });
  await runGit({ args: ["commit", "-m", message], cwd, env: identityEnv() });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
