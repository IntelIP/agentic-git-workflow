import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import { createFeatureFixture, identityEnv } from "./helpers/git-fixture.mjs";

const execFileAsync = promisify(execFile);

test("validation gate exits zero only for a passed exact-head result", async (t) => {
  const fixture = await createFeatureFixture(t);
  const workspaceRoot = join(fixture.root, "ValidationRoot");
  await mkdir(workspaceRoot);

  await commitManifest(fixture.seed, manifest([process.execPath, "-e", "process.exit(0)"]), "passing gate");
  const passed = await runGate(fixture.seed, "refs/tabellio/cli-pass", workspaceRoot);
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.output.result.status, "passed");
  assert.deepEqual(await readdir(workspaceRoot), []);

  await commitManifest(fixture.seed, manifest([process.execPath, "-e", "process.exit(3)"]), "failing gate");
  const failed = await runGate(fixture.seed, "refs/tabellio/cli-fail", workspaceRoot);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.output.result.status, "failed");
  assert.deepEqual(await readdir(workspaceRoot), []);
});

test("validation gate binds squash-merge execution to the pre-merge checkpoint revision", async (t) => {
  const fixture = await createFeatureFixture(t);
  const workspaceRoot = join(fixture.root, "SquashValidationRoot");
  await mkdir(workspaceRoot);
  const value = manifest([process.execPath, "-e", "process.exit(0)"]);
  await writeFile(`${fixture.seed}/tabellio.validation.json`, `${JSON.stringify(value, null, 2)}\n`);
  await runGit({ args: ["add", "tabellio.validation.json"], cwd: fixture.seed });
  await runGit({
    args: ["commit", "-m", "Checkpoint pull-request head", "-m", "Entire-Checkpoint: checkpointed-pr-head"],
    cwd: fixture.seed,
    env: identityEnv(),
  });
  const checkpointHead = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();

  await runGit({ args: ["switch", "main"], cwd: fixture.seed });
  await runGit({ args: ["switch", "-c", "squash-merge"], cwd: fixture.seed });
  await commitManifest(fixture.seed, value, "Squash merged pull request");
  const mergedHead = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();

  const result = await runGate(fixture.seed, "refs/tabellio/cli-squash", workspaceRoot, {
    base: fixture.mainCommit,
    checkpointBase: fixture.mainCommit,
    checkpointHead,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.result.revision.headCommit, mergedHead);
  assert.equal(result.output.result.checkpointRevision.headCommit, checkpointHead);
  assert.deepEqual(result.output.result.checkpoints, ["checkpointed-pr-head"]);
  assert.deepEqual(await readdir(workspaceRoot), []);
});

async function commitManifest(repo, value, message) {
  await writeFile(`${repo}/tabellio.validation.json`, `${JSON.stringify(value, null, 2)}\n`);
  await runGit({ args: ["add", "tabellio.validation.json"], cwd: repo });
  await runGit({ args: ["commit", "-m", message], cwd: repo, env: identityEnv() });
}

async function runGate(repo, ledgerRef, workspaceRoot, options = {}) {
  const args = [
    "scripts/tabellio-validate.mjs",
    "gate",
    "--repo", repo,
    "--repo-id", "example/repository",
    "--base", options.base ?? "main",
    "--commit", "HEAD",
    "--manifest", "tabellio.validation.json",
    "--ledger-ref", ledgerRef,
    "--workspace-root", workspaceRoot,
  ];
  args.push(
    ...optionalOption("--checkpoint-base", options.checkpointBase),
    ...optionalOption("--checkpoint-head", options.checkpointHead),
  );
  try {
    const result = await execFileAsync(process.execPath, args, { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    return { exitCode: 0, output: JSON.parse(result.stdout) };
  } catch (error) {
    return { exitCode: error.code, output: JSON.parse(error.stdout) };
  }
}

function optionalOption(flag, value) {
  return value === undefined ? [] : [flag, value];
}

function manifest(argv) {
  return {
    schemaVersion: "tabellio-validation/v0.1",
    id: "cli-gate",
    failFast: true,
    requireEntireCheckpoint: false,
    commands: [
      {
        id: "gate-command",
        argv,
        cwd: ".",
        timeoutMs: 30_000,
        required: true,
      },
    ],
  };
}
