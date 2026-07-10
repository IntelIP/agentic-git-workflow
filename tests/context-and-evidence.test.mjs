import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { captureContext, localRepositoryId } from "../scripts/lib/capture-context.mjs";
import { validateAgentRunState } from "../scripts/lib/agent-run.mjs";
import { contextDigest, createContextPacket, validateContextPacket } from "../scripts/lib/context-packet.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { createFixture } from "./helpers/git-fixture.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url).pathname;

test("context integrity rejects tampering", () => {
  const oid = "a".repeat(40);
  const packet = createContextPacket({
    runId: "run-1",
    repository: { id: "example/repository", storage: "native-git" },
    actor: { type: "agent", id: "codex" },
    task: { summary: "test context" },
    refs: {
      base: { name: "main", commit: oid },
      head: { name: "feature", commit: oid },
      mergeBase: { name: "merge-base", commit: oid },
    },
    changeSet: { files: [] },
    mergePreview: { clean: true, tree: oid, conflictFiles: [] },
  });
  validateContextPacket(packet);
  packet.task.summary = "tampered";
  assert.throws(() => validateContextPacket(packet), /does not match/);
  assert.throws(
    () => createContextPacket({
      ...packet,
      repository: { id: "/private/repository.git", storage: "native-git" },
    }),
    /must not expose a local filesystem path/,
  );
  assert.throws(
    () => createContextPacket({
      ...packet,
      repository: { id: "C/\\Users\\agent\\secret-product", storage: "native-git" },
    }),
    /must not expose a local filesystem path/,
  );
});

test("runtime context validation rejects schema-disallowed properties", () => {
  const oid = "a".repeat(40);
  const packet = createContextPacket({
    runId: "run-schema",
    repository: { id: "example/repository", storage: "native-git" },
    actor: { type: "agent", id: "codex" },
    task: { summary: "schema parity" },
    refs: {
      base: { name: "main", commit: oid },
      head: { name: "feature", commit: oid },
      mergeBase: { name: "merge-base", commit: oid },
    },
    changeSet: { files: [] },
    mergePreview: { clean: true, tree: oid, conflictFiles: [] },
  });
  packet.repository.unexpected = "rejected";
  packet.integrity.digest = contextDigest(packet);
  assert.throws(() => validateContextPacket(packet), /unsupported properties: unexpected/);
});

test("runtime agent-run validation rejects path leaks and unsupported properties", async () => {
  const state = JSON.parse(await readFile(`${projectRoot}/examples/tabellio-run/minimal-run.json`, "utf8"));
  validateAgentRunState(state);
  state.repository.id = "C/\\Users\\agent\\private-repository";
  assert.throws(() => validateAgentRunState(state), /must not expose a local filesystem path/);
  state.repository.id = "example/repository";
  state.unexpected = true;
  assert.throws(() => validateAgentRunState(state), /unsupported properties: unexpected/);
  delete state.unexpected;
  state.status = "completed";
  assert.throws(() => validateAgentRunState(state), /require headCommit, validation, and context/);
});

test("context creation rejects undefined fields and impossible object IDs", () => {
  const oid = "a".repeat(40);
  const input = {
    runId: "run-serialization",
    repository: { id: "example/repository", storage: "native-git" },
    actor: { type: "agent", id: "codex" },
    task: { summary: "serialization parity" },
    refs: {
      base: { name: "main", commit: oid },
      head: { name: "feature", commit: oid },
      mergeBase: { name: "merge-base", commit: oid },
    },
    changeSet: { files: [{ status: "M", path: "src/index.mjs", previousPath: undefined }] },
    mergePreview: { clean: true, tree: oid, conflictFiles: [] },
  };
  assert.throws(() => createContextPacket(input), /must not be undefined: previousPath/);
  delete input.changeSet.files[0].previousPath;
  input.refs.head.commit = "b".repeat(41);
  assert.throws(() => createContextPacket(input), /hexadecimal object ID/);
});

test("local repository IDs never expose Windows or POSIX parent paths", () => {
  assert.equal(localRepositoryId("C:\\Users\\agent\\repository"), "local/repository");
  assert.equal(localRepositoryId("/Users/agent/repository"), "local/repository");
});

test("capture CLI hashes Windows local origin paths", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const contextPath = `${fixture.root}/windows-origin-context.json`;
  await runGit({
    args: ["config", "remote.origin.url", "C:\\Users\\agent\\secret-product.git"],
    cwd: fixture.bare,
  });

  await runNode("scripts/capture-tabellio-context.mjs", [
    "--repo", fixture.bare,
    "--base", "refs/heads/main",
    "--head", "refs/heads/feature",
    "--run-id", "run-private-origin",
    "--out", contextPath,
  ]);
  const packet = JSON.parse(await readFile(contextPath, "utf8"));
  assert.match(packet.repository.id, /^remote\/[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(packet), /Users|secret-product/);
});

test("context capture freezes refs and diffs merge-base to head", async () => {
  const baseCommit = "a".repeat(40);
  const headCommit = "b".repeat(40);
  const mergeBase = "c".repeat(40);
  const tree = "d".repeat(40);
  const calls = [];
  const store = {
    async resolveRef(revision) {
      calls.push(["resolveRef", revision]);
      return revision === "main" ? baseCommit : headCommit;
    },
    async previewMerge(options) {
      calls.push(["previewMerge", options]);
      assert.deepEqual(options, { base: baseCommit, head: headCommit });
      return { baseCommit, headCommit, mergeBase, clean: true, tree, conflictFiles: [] };
    },
    async getDiff(base, head) {
      calls.push(["getDiff", base, head]);
      assert.equal(base, mergeBase);
      assert.equal(head, headCommit);
      return { baseCommit: base, headCommit: head, files: [{ status: "M", path: "src/index.mjs" }] };
    },
    async readNote(revision) {
      calls.push(["readNote", revision]);
      assert.equal(revision, headCommit);
      return null;
    },
  };

  const packet = await captureContext({
    store,
    baseRevision: "main",
    headRevision: "feature",
    baseName: "main",
    headName: "feature",
    runId: "run-frozen",
    repositoryId: "example/repository",
    actor: { type: "agent", id: "codex" },
    taskSummary: "freeze refs",
    createdAt: "2026-07-09T00:00:00.000Z",
  });

  assert.equal(packet.refs.base.commit, baseCommit);
  assert.equal(packet.refs.head.commit, headCommit);
  assert.equal(packet.refs.mergeBase.commit, mergeBase);
  assert.deepEqual(packet.changeSet.files, [{ status: "M", path: "src/index.mjs" }]);
  assert.deepEqual(calls.filter(([name]) => name === "resolveRef"), [
    ["resolveRef", "main"],
    ["resolveRef", "feature"],
  ]);
});

test("capture CLI binds native Git context into evidence", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const contextPath = `${fixture.root}/context.json`;
  const evidencePath = `${fixture.root}/evidence.json`;

  await runNode("scripts/capture-tabellio-context.mjs", [
    "--repo", fixture.bare,
    "--repo-id", "example/native-repository",
    "--base", "refs/heads/main",
    "--head", "refs/heads/feature",
    "--run-id", "run-context-1",
    "--task-summary", "prove native Git binding",
    "--out", contextPath,
  ]);
  const contextCheck = await runNode("scripts/check-tabellio-context.mjs", ["--context", contextPath]);
  assert.equal(JSON.parse(contextCheck.stdout).ok, true);

  await runNode("scripts/write-tabellio-evidence-envelope.mjs", [
    "--context", contextPath,
    "--out", evidencePath,
  ]);
  const evidenceCheck = await runNode("scripts/check-tabellio-evidence-envelope.mjs", ["--evidence", evidencePath]);
  assert.equal(JSON.parse(evidenceCheck.stdout).ok, true);

  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.repo, "example/native-repository");
  assert.equal(evidence.git.sha, context.refs.head.commit);
  assert.equal(evidence.context.digest, context.integrity.digest);
  assert.deepEqual(evidence.changedFiles, ["README.md"]);
});

test("policy checks reject omitted approval booleans", async (t) => {
  const fixturePath = `${projectRoot}/examples/tabellio-evidence/minimal-evidence.json`;
  const evidence = JSON.parse(await readFile(fixturePath, "utf8"));
  delete evidence.externalActionPolicy.actionClasses[0].approved;
  const path = `${projectRoot}/.tmp-invalid-policy-${process.pid}.json`;
  t.after(() => rm(path, { force: true }));
  await writeFile(path, JSON.stringify(evidence));

  await assert.rejects(
    runNode("scripts/check-tabellio-evidence-envelope.mjs", ["--evidence", path]),
    (error) => {
      const output = JSON.parse(error.stdout);
      return output.blockers.some((blocker) => blocker.includes(".approved must be a boolean"));
    },
  );
});

test("file-byte integrity requires a SHA-256 digest", async (t) => {
  const fixturePath = `${projectRoot}/examples/tabellio-evidence/minimal-evidence.json`;
  const evidence = JSON.parse(await readFile(fixturePath, "utf8"));
  evidence.artifacts[0].hashScope = "file-bytes";
  delete evidence.artifacts[0].sha256;
  const path = `${projectRoot}/.tmp-invalid-file-hash-${process.pid}.json`;
  t.after(() => rm(path, { force: true }));
  await writeFile(path, JSON.stringify(evidence));

  await assert.rejects(
    runNode("scripts/check-tabellio-evidence-envelope.mjs", ["--evidence", path]),
    (error) => {
      const output = JSON.parse(error.stdout);
      return output.blockers.some((blocker) => blocker.includes("sha256 is required for file-byte integrity"));
    },
  );
});

test("GitHub adapter checks out immutable PR commits and runs the full repository gate", async () => {
  const workflow = await readFile(`${projectRoot}/.github/workflows/tabellio-evidence.yml`, "utf8");
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /name: Check Tabellio[\s\S]*run: npm run check/);
});

test("adoption docs do not pin the pre-context release", async () => {
  const [readme, gettingStarted, consumerExample] = await Promise.all([
    readFile(`${projectRoot}/README.md`, "utf8"),
    readFile(`${projectRoot}/docs/getting-started.md`, "utf8"),
    readFile(`${projectRoot}/examples/github-actions/tabellio-consumer.yml`, "utf8"),
  ]);
  assert.doesNotMatch(readme, /tabellio-evidence\.yml@v0\.1\.0|toolkit_ref: v0\.1\.0/);
  assert.doesNotMatch(gettingStarted, /tabellio-evidence\.yml@v0\.1\.0|toolkit_ref: v0\.1\.0/);
  assert.doesNotMatch(consumerExample, /tabellio-evidence\.yml@v0\.1\.0|toolkit_ref: v0\.1\.0/);
});

test("required repository validation is recorded in evidence", async (t) => {
  const evidencePath = `${projectRoot}/.tmp-required-validation-${process.pid}.json`;
  t.after(() => rm(evidencePath, { force: true }));
  await runNode("scripts/write-tabellio-evidence-envelope.mjs", ["--out", evidencePath], {
    TABELLIO_REQUIRED_VALIDATION_COMMAND: "npm test",
    TABELLIO_REQUIRED_VALIDATION_STATUS: "success",
  });
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert(evidence.commandsRun.some((command) => command.command === "npm test" && command.status === "passed"));
});

async function runNode(script, args, env = {}) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, USER: "tabellio-test", ...env },
  });
}
