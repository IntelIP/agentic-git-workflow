import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { GitJsonLedger } from "../scripts/lib/git-json-ledger.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { repositoryIdentity } from "../scripts/lib/repository-identity.mjs";
import {
  latestValidationResult,
  ValidationRunner,
  validateValidationManifest,
  validateValidationResult,
} from "../scripts/lib/validation-runner.mjs";
import { NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";

test("validation runner executes exact committed manifests and stores bounded results", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await runGit({ args: ["switch", "feature"], cwd: fixture.seed });
  const manifestPath = `${fixture.seed}/tabellio.validation.json`;
  await writeFile(manifestPath, JSON.stringify(manifest([
    command("tests", [process.execPath, "-e", 'process.stdout.write("x".repeat(20000))']),
    command("isolated-home", [process.execPath, "-e", 'if (!process.env.HOME.includes("validation-workspaces")) process.exit(2)']),
  ]), null, 2));
  await commit(fixture.seed, "Add passing validation", "validation-pass");
  const passingHead = await head(fixture.seed);

  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  const repositoryId = await repositoryIdentity(store, "example/repository");
  const passed = await runner.run({
    repositoryId,
    commit: passingHead,
    base: "main",
    runnerId: "test-runner",
    now: new Date("2026-07-10T20:00:00.000Z"),
  });
  assert.equal(passed.result.status, "passed");
  assert.deepEqual(passed.result.checkpoints, ["validation-pass"]);
  assert.equal(passed.result.commands[0].stdout.bytes, 20000);
  assert.equal(passed.result.commands[0].stdout.truncated, true);
  assert.equal(Buffer.byteLength(passed.result.commands[0].stdout.tail), 16 * 1024);
  assert.equal(passed.result.commands[1].status, "passed");
  assert.equal(validateValidationResult(passed.result), passed.result);
  assert.deepEqual(await latestValidationResult(ledger, passingHead), passed.result);
  const otherRepository = await runner.run({
    repositoryId: "other/repository",
    commit: passingHead,
    base: "main",
    runnerId: "other-runner",
    now: new Date("2026-07-10T21:00:00.000Z"),
  });
  assert.deepEqual(await latestValidationResult(ledger, passingHead), otherRepository.result);
  assert.deepEqual(await latestValidationResult(ledger, passingHead, repositoryId), passed.result);
  assert.equal(await latestValidationResult(ledger, passingHead, "missing/repository"), null);

  await writeFile(manifestPath, JSON.stringify(manifest([
    command("fails", [process.execPath, "-e", "process.exit(3)"]),
    command("skipped", [process.execPath, "-e", "process.exit(0)"]),
  ]), null, 2));
  await commit(fixture.seed, "Add failing validation", "validation-fail");
  const failingHead = await head(fixture.seed);
  const failed = await runner.run({
    repositoryId,
    commit: failingHead,
    base: "main",
    runnerId: "test-runner",
  });
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.commands[0].exitCode, 3);
  assert.equal(failed.result.commands[1].status, "skipped");
  assert.deepEqual(failed.result.checkpoints, ["validation-fail", "validation-pass"]);

  const worktrees = await runGit({ args: ["worktree", "list", "--porcelain"], cwd: fixture.seed });
  assert.equal(worktrees.stdout.includes(passed.result.runId), false);
  const status = await runGit({ args: ["status", "--porcelain=v1"], cwd: fixture.seed });
  assert.equal(status.stdout, "");
});

test("validation manifest rejects shell-like ambiguity and missing checkpoint ranges", async (t) => {
  assert.throws(
    () => validateValidationManifest(manifest([command("escape", ["node", "test.js"], "../outside")])),
    /safe relative path/,
  );
  assert.throws(
    () => validateValidationManifest({ ...manifest([]), commands: [] }),
    /1 to 50/,
  );

  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await runGit({ args: ["switch", "feature"], cwd: fixture.seed });
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifest([
    command("tests", [process.execPath, "-e", "process.exit(0)"]),
  ]), null, 2));
  await runGit({ args: ["add", "tabellio.validation.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Manifest without checkpoint"], cwd: fixture.seed, env: identityEnv() });
  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  await assert.rejects(
    runner.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" }),
    /has no Entire checkpoint/,
  );
});

test("validation runner terminates timed-out commands and skips remaining fail-fast work", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await runGit({ args: ["switch", "feature"], cwd: fixture.seed });
  await writeFile(`${fixture.seed}/tabellio.validation.json`, JSON.stringify(manifest([
    command("timeout", [process.execPath, "-e", "setTimeout(() => {}, 5000)"], ".", 150),
    command("must-skip", [process.execPath, "-e", "process.exit(0)"]),
  ]), null, 2));
  await commit(fixture.seed, "Add timeout validation", "validation-timeout");
  const store = await NativeGitStore.open(fixture.seed);
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  const runner = new ValidationRunner({ store, ledger });
  const started = Date.now();
  const result = await runner.run({ repositoryId: "example/repository", commit: "HEAD", base: "main" });
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.commands[0].status, "timed_out");
  assert(["SIGTERM", "SIGKILL"].includes(result.result.commands[0].signal));
  assert.equal(result.result.commands[1].status, "skipped");
  assert(Date.now() - started < 3_000);
});

function manifest(commands) {
  return {
    schemaVersion: "tabellio-validation/v0.1",
    id: "test-suite",
    failFast: true,
    requireEntireCheckpoint: true,
    commands,
  };
}

function command(id, argv, cwd = ".", timeoutMs = 10_000) {
  return { id, argv, cwd, timeoutMs, required: true };
}

async function commit(cwd, message, checkpoint) {
  await runGit({ args: ["add", "tabellio.validation.json"], cwd });
  await runGit({
    args: ["commit", "-m", message, "-m", `Entire-Checkpoint: ${checkpoint}`],
    cwd,
    env: identityEnv(),
  });
}

async function head(cwd) {
  return (await runGit({ args: ["rev-parse", "HEAD"], cwd })).stdout.trim();
}
