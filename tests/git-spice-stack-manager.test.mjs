import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateStackSnapshot } from "../scripts/lib/stack-manager.mjs";
import {
  GitSpiceCommandError,
  GitSpiceStackManager,
} from "../scripts/providers/git-spice-stack-manager.mjs";
import { createFixture } from "./helpers/git-fixture.mjs";

test("git-spice adapter produces provider-neutral stack snapshots", async (t) => {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-git-spice-"));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(toolRoot, { recursive: true, force: true }),
  ]));
  const binary = await fakeGitSpice(toolRoot, [
    { name: "feature-2", current: true, down: { name: "feature-1", needsRestack: true } },
    {
      name: "main",
      ups: [{ name: "feature-1" }],
    },
    {
      name: "feature-1",
      down: { name: "main" },
      ups: [{ name: "feature-2" }],
      worktree: "/private/worktree/path",
      change: { id: "#12", url: "https://forgejo.example.test/org/repo/pulls/12" },
      push: { ahead: 1, behind: 0, needsPush: true },
    },
  ]);
  const manager = await GitSpiceStackManager.open(fixture.seed, { binary });
  const snapshot = await manager.snapshot({
    repositoryId: "example/repository",
    capturedAt: "2026-07-10T12:00:00.000Z",
  });

  assert.equal(snapshot.provider.version, "0.30.1");
  assert.equal(snapshot.currentBranch, "feature-2");
  assert.deepEqual(snapshot.roots, ["main"]);
  assert.deepEqual(snapshot.branches.map((branch) => branch.name), ["feature-1", "feature-2", "main"]);
  assert.equal(snapshot.branches[0].checkedOutElsewhere, true);
  assert.equal(snapshot.branches[0].changeRequest.status, null);
  assert.equal(snapshot.branches[1].needsRestack, true);
  assert.equal(JSON.stringify(snapshot).includes("/private/worktree/path"), false);
  assert.equal(validateStackSnapshot(snapshot), snapshot);
});

test("git-spice adapter rejects malformed JSON output", async (t) => {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-git-spice-invalid-"));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(toolRoot, { recursive: true, force: true }),
  ]));
  const binary = await fakeGitSpice(toolRoot, null);
  const manager = await GitSpiceStackManager.open(fixture.seed, { binary });

  await assert.rejects(
    manager.snapshot({ repositoryId: "example/repository" }),
    /git-spice JSON line 1 is invalid/,
  );
});

test("git-spice adapter rejects upstream JSON shape drift", async (t) => {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-git-spice-shape-"));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(toolRoot, { recursive: true, force: true }),
  ]));
  const binary = await fakeGitSpice(toolRoot, [{ name: "main", ups: "feature" }]);
  const manager = await GitSpiceStackManager.open(fixture.seed, { binary });

  await assert.rejects(
    manager.snapshot({ repositoryId: "example/repository" }),
    /git-spice branch main.ups must be an array/,
  );
});

test("git-spice adapter reports a missing executable", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manager = await GitSpiceStackManager.open(fixture.seed, {
    binary: join(fixture.root, "missing-git-spice"),
  });

  await assert.rejects(
    manager.toolVersion(),
    (error) => error instanceof GitSpiceCommandError && /not installed or not executable/.test(error.message),
  );
});

test("stack validation rejects inconsistent relationships", () => {
  const value = {
    schemaVersion: "tabellio-stack/v0.1",
    repository: { id: "example/repository" },
    provider: { id: "git-spice", version: "0.30.1" },
    capturedAt: "2026-07-10T12:00:00.000Z",
    currentBranch: "feature",
    roots: ["main"],
    branches: [
      branch({ name: "main", children: ["feature"] }),
      branch({ name: "feature", current: true, parent: null }),
    ],
  };

  assert.throws(() => validateStackSnapshot(value), /roots must list every branch without a parent/);
});

function branch(overrides) {
  return {
    name: "main",
    current: false,
    parent: null,
    children: [],
    needsRestack: false,
    checkedOutElsewhere: false,
    changeRequest: null,
    push: null,
    ...overrides,
  };
}

async function fakeGitSpice(root, branches) {
  const binary = join(root, "git-spice");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "version --short") {
  process.stdout.write("v0.30.1\\n");
  process.exit(0);
}
const expected = ["--no-prompt", "log", "short", "--all", "--json", "--cr-status=false", "--cr-comments=false"];
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  process.stderr.write("unexpected args: " + JSON.stringify(args));
  process.exit(2);
}
${branches === null
    ? 'process.stdout.write("not-json\\n");'
    : `for (const branch of ${JSON.stringify(branches)}) process.stdout.write(JSON.stringify(branch) + "\\n");`}
`;
  await writeFile(binary, source);
  await chmod(binary, 0o755);
  return binary;
}
