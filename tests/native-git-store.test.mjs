import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { GitCommandError, runGit } from "../scripts/lib/git-process.mjs";
import { WorkspaceManager } from "../scripts/lib/workspace-manager.mjs";
import { RefConflictError, NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";

test("native store reads Git state and isolates worktrees", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const store = await NativeGitStore.open(fixture.bare, { workspaceRoot: fixture.workspaces });
  const manager = new WorkspaceManager({ store, root: fixture.workspaces });
  const featureCommit = await store.resolveRef("refs/heads/feature");
  assert.equal(featureCommit, fixture.featureCommit);
  assert.deepEqual(await store.listFiles("refs/heads/feature"), ["README.md"]);

  const diff = await store.getDiff("refs/heads/main", "refs/heads/feature");
  assert.deepEqual(diff.files, [
    { status: "D", path: "BASE_ONLY.md" },
    { status: "M", path: "README.md" },
  ]);

  const workspace = await manager.create({
    runId: "run-1",
    branch: "agent/run-1",
    startPoint: "refs/heads/feature",
  });
  assert.equal(workspace.startCommit, featureCommit);
  assert.equal(await runGit({ args: ["rev-parse", "HEAD"], cwd: workspace.path }).then((result) => result.stdout.trim()), featureCommit);
  await manager.remove({ runId: "run-1" });
  await assert.rejects(
    manager.create({ runId: "../escape", branch: "agent/escape", startPoint: "main" }),
    /safe path segment/,
  );
});

test("merge preview reports conflicts without mutating refs", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = await NativeGitStore.open(fixture.bare);

  for (const [branch, content] of [["feature", "feature\n"], ["main", "main\n"]]) {
    await runGit({ args: ["switch", branch], cwd: fixture.seed });
    await writeFile(join(fixture.seed, "MY_CONFLICT_FILE"), content);
    await writeFile(join(fixture.seed, "Auto-merging path.txt"), content);
    await runGit({ args: ["add", "-A"], cwd: fixture.seed });
    await runGit({ args: ["commit", "-m", `${branch} adversarial paths`], cwd: fixture.seed, env: identityEnv() });
    await runGit({ args: ["push", "origin", branch], cwd: fixture.seed });
  }

  const before = await store.resolveRef("refs/heads/main");
  const preview = await store.previewMerge({ base: "refs/heads/main", head: "refs/heads/feature" });
  const after = await store.resolveRef("refs/heads/main");

  assert.equal(preview.clean, false);
  assert.deepEqual(preview.conflictFiles, ["Auto-merging path.txt", "MY_CONFLICT_FILE", "README.md"]);
  assert.equal(before, after);
});

test("compare-and-swap rejects a stale ref update", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = await NativeGitStore.open(fixture.bare);

  await store.compareAndSwapRef({
    ref: "refs/heads/cas-target",
    newRevision: "refs/heads/feature",
  });
  await store.compareAndSwapRef({
    ref: "refs/heads/cas-target",
    newRevision: "refs/heads/main",
    expectedOldCommit: fixture.featureCommit,
  });

  await assert.rejects(
    store.compareAndSwapRef({
      ref: "refs/heads/cas-target",
      newRevision: "refs/heads/feature",
      expectedOldCommit: fixture.featureCommit,
    }),
    RefConflictError,
  );
});

test("worktree paths cannot escape the managed root", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = await NativeGitStore.open(fixture.bare, { workspaceRoot: fixture.workspaces });

  await assert.rejects(
    store.createWorkspace({
      path: resolve(fixture.workspaces, "..", "escape"),
      branch: "agent/escape",
      startPoint: "refs/heads/main",
    }),
    /must be a child/,
  );

  const outside = join(fixture.root, "outside");
  const linked = join(fixture.workspaces, "linked");
  await mkdir(outside);
  await symlink(outside, linked);
  await assert.rejects(
    store.createWorkspace({
      path: join(linked, "escape"),
      branch: "agent/symlink-escape",
      startPoint: "refs/heads/main",
    }),
    /must be a child/,
  );
});

test("checkpoint notes expose digestable content", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = await NativeGitStore.open(fixture.bare);
  await runGit({
    gitDir: fixture.bare,
    args: ["notes", "--ref=tabellio/context", "add", "-m", '{"summary":"agent checkpoint"}', fixture.featureCommit],
    env: identityEnv(),
  });

  assert.equal(
    await store.readNote("refs/heads/feature"),
    '{"summary":"agent checkpoint"}',
  );
});

test("NUL-delimited reads preserve unusual Git paths", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const unusualPath = "line\nbreak.txt";
  await runGit({ args: ["switch", "feature"], cwd: fixture.seed });
  await writeFile(join(fixture.seed, unusualPath), "unusual\n");
  await runGit({ args: ["add", "-A"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "unusual path"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["push", "origin", "feature"], cwd: fixture.seed });

  const store = await NativeGitStore.open(fixture.bare);
  assert((await store.listFiles("refs/heads/feature")).includes(unusualPath));
  assert((await store.getDiff("refs/heads/main", "refs/heads/feature")).files.some((file) => file.path === unusualPath));
});

test("compare-and-swap creates refs in SHA-256 repositories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-sha256-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repository");
  await runGit({ args: ["init", "--object-format=sha256", "--initial-branch=main", repo] });
  await runGit({
    args: ["commit", "--allow-empty", "-m", "base"],
    cwd: repo,
    env: identityEnv(),
  });
  const store = await NativeGitStore.open(repo);
  const result = await store.compareAndSwapRef({
    ref: "refs/heads/agent/sha256",
    newRevision: "HEAD",
  });

  assert.equal(result.newCommit.length, 64);
  assert.equal(await store.resolveRef("refs/heads/agent/sha256"), result.newCommit);
});

test("Git process rejects commands terminated by timeout", async () => {
  await assert.rejects(
    runGit({
      args: ["-c", "alias.tabellio-timeout=!sleep 2", "tabellio-timeout"],
      timeoutMs: 10,
    }),
    (error) => error instanceof GitCommandError && error.exitCode === null && error.signal === "SIGTERM",
  );
});
