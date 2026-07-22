import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import { runPreflight, validatePreflightResult } from "../scripts/lib/preflight.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";
import { platformFixture } from "./helpers/platform-fixture.mjs";

test("preflight proves GitHub and Entire readiness without exposing credentials", async (t) => {
  const fixture = await preparedFixture(t);
  const result = await runPreparedPreflight(fixture, {
    profile: "agent",
    commandRunner: fakeCommands(),
    now: new Date("2026-07-15T12:00:00.000Z"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.every((check) => check.status === "passed"), true);
  assert.equal(JSON.stringify(result).includes("gho_secret"), false);
  assert.equal(validatePreflightResult(result), result);
});

test("preflight fails early with exact Codex hook approval remedy", async (t) => {
  const fixture = await preparedFixture(t);
  await writeCodexTrust(fixture, ["session_start", "user_prompt_submit", "stop"]);
  const result = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(result.status, "blocked");
  const trust = result.checks.find((check) => check.id === "codex-hook-trust");
  assert.equal(trust.status, "blocked");
  assert.match(trust.resolution, /Open \/hooks in Codex/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { digest: "sha256:" + "a".repeat(64) });
  const stale = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(stale.checks.find((check) => check.id === "codex-hook-trust").detail, /stale/);
});

test("preflight requires active hooks and a trusted project layer", async (t) => {
  const fixture = await preparedFixture(t);
  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { hooksEnabled: false, hooksComment: true });
  const disabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands({ effectiveHooks: false }) });
  assert.match(disabled.checks.find((check) => check.id === "codex-config").detail, /disabled/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES));
  await writeFile(join(fixture.seed, ".codex", "config.toml"), "[features]\nhooks = false # project override\n");
  const projectDisabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands({ effectiveHooks: false }) });
  assert.match(projectDisabled.checks.find((check) => check.id === "codex-config").detail, /disabled/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { hooksEnabled: false });
  await writeFile(join(fixture.seed, ".codex", "config.toml"), "[features]\nhooks = true # effective project override\n");
  const projectEnabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(projectEnabled.checks.find((check) => check.id === "codex-hook-trust").status, "passed");
  await rm(join(fixture.seed, ".codex", "config.toml"));

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { disabledEvent: "stop" });
  const handlerDisabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(handlerDisabled.checks.find((check) => check.id === "codex-hook-trust").detail, /stop/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { projectTrusted: false });
  const untrusted = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(untrusted.checks.find((check) => check.id === "codex-hook-trust").detail, /missing or stale/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { encodeKeys: true });
  const escaped = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(escaped.checks.find((check) => check.id === "codex-hook-trust").status, "passed");

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { literalKeys: true });
  const literal = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(literal.checks.find((check) => check.id === "codex-hook-trust").status, "passed");

  const hooksPath = join(fixture.seed, ".codex", "hooks.json");
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  hooks.hooks.Stop[0].hooks[0].additionalContextLimit = 999;
  await writeFile(hooksPath, JSON.stringify(hooks));
  const stopContext = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(stopContext.checks.find((check) => check.id === "codex-hook-trust").status, "passed");

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { malformedEnabledEvent: "stop" });
  const malformedState = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(malformedState.checks.find((check) => check.id === "codex-hook-trust").detail, /stop/);

  fixture.codexRequirements = { allowManagedHooksOnly: true, hooks: {} };
  const missingManaged = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(missingManaged.checks.find((check) => check.id === "codex-config").detail, /Managed Codex Entire hooks missing/);
  assert.match(missingManaged.checks.find((check) => check.id === "codex-hook-trust").detail, /unproven/);

  const managedInventory = effectiveManagedHooks(managedEntireRequirements());
  fixture.codexRequirements = { allowManagedHooksOnly: true };
  const inventoryOnlyManaged = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands(),
    codexStateReader: async () => ({ requirements: fixture.codexRequirements, hooks: managedInventory }),
  });
  assert.equal(inventoryOnlyManaged.checks.find((check) => check.id === "codex-config").status, "passed");
  assert.equal(inventoryOnlyManaged.checks.find((check) => check.id === "codex-hooks").status, "passed");
  assert.match(inventoryOnlyManaged.checks.find((check) => check.id === "codex-hook-trust").detail, /managed Codex policy/);

  fixture.codexRequirements = managedEntireRequirements();
  await writeFile(join(fixture.seed, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }));
  const managed = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(managed.checks.find((check) => check.id === "codex-config").status, "passed");
  assert.equal(managed.checks.find((check) => check.id === "codex-hooks").status, "passed");
  assert.match(managed.checks.find((check) => check.id === "codex-hook-trust").detail, /managed Codex policy/);

  fixture.codexRequirements.hooks.Stop[0].hooks[0].async = true;
  const asynchronousManaged = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(asynchronousManaged.checks.find((check) => check.id === "codex-config").detail, /stop/);
  fixture.codexRequirements.hooks.Stop[0].hooks[0].async = false;

  const snakeCaseManaged = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands(),
    codexStateReader: async () => ({
      requirements: fixture.codexRequirements,
      hooks: effectiveManagedHooks(fixture.codexRequirements).map((hook) => ({
        ...hook,
        eventName: hookEventSnakeCase(hook.eventName),
      })),
    }),
  });
  assert.equal(snakeCaseManaged.checks.find((check) => check.id === "codex-config").status, "passed");

  fixture.codexRequirements.allowManagedHooksOnly = false;
  const managedWithoutLockdown = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(managedWithoutLockdown.checks.find((check) => check.id === "codex-config").status, "passed");
  assert.match(managedWithoutLockdown.checks.find((check) => check.id === "codex-hook-trust").detail, /managed Codex policy/);

  fixture.codexRequirements.allowManagedHooksOnly = true;
  fixture.codexRequirements.hooks.UserPromptSubmit[0].matcher = "ignored";
  fixture.codexRequirements.hooks.Stop[0].matcher = "ignored";
  const ignoredManagedMatchers = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(ignoredManagedMatchers.checks.find((check) => check.id === "codex-config").status, "passed");

  fixture.codexRequirements.hooks.PostToolUse[0].matcher = "^NoSuchTool$";
  const filteredManaged = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(filteredManaged.checks.find((check) => check.id === "codex-config").detail, /post_tool_use/);

  fixture.codexRequirements = managedEntireRequirements();
  fixture.codexRequirements.allowManagedHooksOnly = false;
  delete fixture.codexRequirements.hooks.UserPromptSubmit;
  delete fixture.codexRequirements.hooks.Stop;
  await writeEntireHooks(fixture.seed, (command) => `entire hooks codex ${command}`);
  const projectHooks = JSON.parse(await readFile(join(fixture.seed, ".codex", "hooks.json"), "utf8"));
  delete projectHooks.hooks.SessionStart;
  delete projectHooks.hooks.PostToolUse;
  await writeFile(join(fixture.seed, ".codex", "hooks.json"), JSON.stringify(projectHooks));
  await writeCodexTrust(fixture, ["user_prompt_submit", "stop"]);
  const mixed = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(mixed.checks.find((check) => check.id === "codex-config").status, "passed");
  assert.equal(mixed.checks.find((check) => check.id === "codex-hooks").status, "passed");
  assert.equal(mixed.checks.find((check) => check.id === "codex-hook-trust").status, "passed");
});

test("preflight follows Codex's canonical hook source in linked worktrees", async (t) => {
  const fixture = await preparedFixture(t);
  await runGit({ args: ["add", "--", ".codex/hooks.json", "tabellio.platform.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Commit linked worktree inputs"], cwd: fixture.seed, env: identityEnv() });
  const linked = join(fixture.root, "linked");
  await runGit({ args: ["worktree", "add", "--detach", linked, "HEAD"], cwd: fixture.seed });
  try {
    const result = await runPreparedPreflight(fixture, { repoPath: linked, commandRunner: fakeCommands() });
    assertHookChecksPassed(result);

    const linkedHooksPath = join(linked, ".codex", "hooks.json");
    const linkedHooks = JSON.parse(await readFile(linkedHooksPath, "utf8"));
    delete linkedHooks.hooks.Stop;
    await writeFile(linkedHooksPath, JSON.stringify(linkedHooks));
    const staleLinked = await runPreparedPreflight(fixture, { repoPath: linked, commandRunner: fakeCommands() });
    assert.equal(staleLinked.checks.find((check) => check.id === "codex-hooks").status, "passed");
  } finally {
    await runGit({ args: ["worktree", "remove", "--force", linked], cwd: fixture.seed });
  }
});

test("preflight accepts effective project hooks from TOML sources", async (t) => {
  const fixture = await preparedFixture(t);
  const hooks = (await effectiveProjectHooks(fixture)).map((hook) => ({
    ...hook,
    sourcePath: fixture.codexConfigPath,
  }));
  const result = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands(),
    codexStateReader: async () => ({ requirements: fixture.codexRequirements, hooks }),
  });
  assertHookChecksPassed(result);
});

test("preflight accepts valid ULID checkpoint directory layouts", async (t) => {
  const fixture = await preparedFixture(t);
  const checkpointId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const checkpointRoot = join(fixture.seed, "01", checkpointId.slice(2));
  await rename(join(fixture.seed, "ab"), join(fixture.seed, "01"));
  await rename(join(fixture.seed, "01", "cdef123456"), checkpointRoot);
  const rootMetadataPath = join(checkpointRoot, "metadata.json");
  const rootMetadata = JSON.parse(await readFile(rootMetadataPath, "utf8"));
  const sessionPrefix = `/01/${checkpointId.slice(2)}/0`;
  rootMetadata.checkpoint_id = checkpointId;
  rootMetadata.sessions[0] = {
    metadata: `${sessionPrefix}/metadata.json`,
    transcript: `${sessionPrefix}/full.jsonl`,
    content_hash: `${sessionPrefix}/content_hash.txt`,
  };
  await writeFile(rootMetadataPath, JSON.stringify(rootMetadata));
  await writeFile(join(checkpointRoot, "0", "metadata.json"), JSON.stringify({
    checkpoint_id: checkpointId,
    session_id: "session-fixture",
  }) + "\n");
  await runGit({ args: ["add", "-A"], cwd: fixture.seed });
  await commitCheckpointAndAssertValid(fixture, "Use ULID checkpoint layout");
});

test("preflight streams checkpoint transcripts larger than the Git command buffer", async (t) => {
  const fixture = await preparedFixture(t);
  const transcriptPath = join(fixture.seed, "ab", "cdef123456", "0", "full.jsonl");
  const contentHashPath = join(fixture.seed, "ab", "cdef123456", "0", "content_hash.txt");
  const transcript = `${JSON.stringify({ payload: "x".repeat(2048) })}\n`.repeat(5200);
  assert.ok(Buffer.byteLength(transcript) > 10 * 1024 * 1024);
  await writeFile(transcriptPath, transcript);
  await writeFile(contentHashPath, `sha256:${createHash("sha256").update(transcript).digest("hex")}\n`);
  await runGit({ args: ["add", "--", "ab/cdef123456/0"], cwd: fixture.seed });
  await commitCheckpointAndAssertValid(fixture, "Add large valid transcript");
});

test("preflight verifies Entire metadata ancestry without repairing it", async (t) => {
  const fixture = await preparedFixture(t);
  const localRef = "refs/heads/entire/checkpoints/v1";

  const unpublishedAgent = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands(),
    remoteRefReader: async ({ allowMissing }) => allowMissing ? null : fixture.liveControlOid,
  });
  assert.match(unpublishedAgent.checks.find((check) => check.id === "entire-metadata").detail, /may be created by approved publication/);
  const unpublishedRelease = await runPreparedPreflight(fixture, {
    profile: "release",
    commandRunner: fakeCommands(),
    remoteRefReader: async ({ allowMissing }) => allowMissing ? null : fixture.liveControlOid,
  });
  assert.equal(unpublishedRelease.checks.find((check) => check.id === "entire-metadata").status, "passed");

  await runGit({ args: ["update-ref", "-d", localRef], cwd: fixture.seed });
  const missing = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(missing.checks.find((check) => check.id === "entire-metadata").detail, /missing/);

  const firstRun = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands(),
    remoteRefReader: async ({ allowMissing }) => allowMissing ? null : fixture.liveControlOid,
  });
  assert.equal(firstRun.checks.find((check) => check.id === "entire-metadata").status, "passed");
  await runGit({ args: ["update-ref", localRef, "HEAD"], cwd: fixture.seed });

  const tree = (await runGit({ args: ["rev-parse", "HEAD^{tree}"], cwd: fixture.seed })).stdout.trim();
  const isolated = (await runGit({
    args: ["commit-tree", tree, "-m", "Disconnected checkpoint metadata"],
    cwd: fixture.seed,
    env: identityEnv(),
  })).stdout.trim();
  fixture.liveControlOid = isolated;
  const disconnected = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(disconnected.checks.find((check) => check.id === "entire-metadata").detail, /disconnected/);

  const remoteAhead = (await runGit({
    args: ["commit-tree", tree, "-p", "HEAD", "-m", "Remote checkpoint metadata"],
    cwd: fixture.seed,
    env: identityEnv(),
  })).stdout.trim();
  fixture.liveControlOid = remoteAhead;
  const ahead = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(ahead.checks.find((check) => check.id === "entire-metadata").detail, /ahead/);

  fixture.liveControlOid = "f".repeat(40);
  const unfetched = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(unfetched.checks.find((check) => check.id === "entire-metadata").detail, /not available locally/);

  const codeCommit = (await runGit({ args: ["rev-parse", "HEAD^"], cwd: fixture.seed })).stdout.trim();
  await runGit({ args: ["update-ref", localRef, codeCommit], cwd: fixture.seed });
  fixture.liveControlOid = codeCommit;
  const invalidContents = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(invalidContents.checks.find((check) => check.id === "entire-metadata").detail, /no checkpoint metadata/);

  await runGit({ args: ["update-ref", localRef, "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  const metadataPath = join(fixture.seed, "ab", "cdef123456", "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, session_count: 2 }));
  await runGit({ args: ["add", "--", "ab/cdef123456/metadata.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Mismatch checkpoint session count"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", localRef, "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  const mismatchedCount = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(mismatchedCount.checks.find((check) => check.id === "entire-metadata").detail, /invalid/);

  const sessionMetadataPath = join(fixture.seed, "ab", "cdef123456", "0", "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(sessionMetadataPath, "{}\n");
  await runGit({ args: ["add", "--", "ab/cdef123456"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Invalidate referenced session metadata"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", localRef, "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  const invalidSession = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(invalidSession.checks.find((check) => check.id === "entire-metadata").detail, /invalid/);

  await writeFile(sessionMetadataPath, JSON.stringify({
    checkpoint_id: "abcdef123456",
    session_id: "session-fixture",
  }) + "\n");
  const contentHashPath = join(fixture.seed, "ab", "cdef123456", "0", "content_hash.txt");
  await writeFile(contentHashPath, `sha256:${"0".repeat(64)}\n`);
  await runGit({ args: ["add", "--", "ab/cdef123456"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Invalidate referenced transcript hash"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", localRef, "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  const invalidHash = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(invalidHash.checks.find((check) => check.id === "entire-metadata").detail, /invalid/);

  await writeFile(contentHashPath, "sha256:ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356\n");
  await writeFile(metadataPath, JSON.stringify({ ...metadata, partial: true }));
  await runGit({ args: ["add", "--", "ab/cdef123456"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Make checkpoint metadata partial"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", localRef, "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  const partial = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(partial.checks.find((check) => check.id === "entire-metadata").detail, /invalid/);

  const empty = (await runGit({
    args: ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "Initialize empty checkpoint metadata"],
    cwd: fixture.seed,
    env: identityEnv(),
  })).stdout.trim();
  await runGit({ args: ["update-ref", localRef, empty], cwd: fixture.seed });
  fixture.liveControlOid = empty;
  const emptyAgent = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(emptyAgent.checks.find((check) => check.id === "entire-metadata").status, "passed");
  const emptyRelease = await runPreparedPreflight(fixture, { profile: "release", commandRunner: fakeCommands() });
  assert.match(emptyRelease.checks.find((check) => check.id === "entire-metadata").detail, /no checkpoint metadata/);
});

test("preflight rejects a checkpoint remote outside Tabellio control storage", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, ".entire", "settings.json"), JSON.stringify({
    enabled: true,
    strategy_options: {
      checkpoint_remote: { provider: "github", repo: "example/wrong-control" },
      push_sessions: false,
    },
  }));
  const agent = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(agent.checks.find((check) => check.id === "entire-metadata").detail, /does not match.*control repository/);
  const release = await runPreparedPreflight(fixture, { profile: "release", commandRunner: fakeCommands() });
  assert.match(release.checks.find((check) => check.id === "entire-metadata").detail, /does not match.*control repository/);
});

test("preflight requires an approval-gated Entire checkpoint remote", async (t) => {
  const fixture = await preparedFixture(t);
  await rm(join(fixture.seed, ".entire", "settings.json"));
  const missing = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(missing.checks.find((check) => check.id === "entire-metadata").detail, /checkpoint remote is not configured/);

  await writeFile(join(fixture.seed, ".entire", "settings.json"), JSON.stringify({
    enabled: true,
    strategy_options: {
      checkpoint_remote: { provider: "github", repo: "example/repository-control" },
      push_sessions: true,
    },
  }));
  const automatic = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assertEntireMetadataBlocked(automatic, /automatic checkpoint pushing is not disabled/);

  await writeFile(join(fixture.seed, ".entire", "settings.local.json"), JSON.stringify({
    strategy_options: {
      checkpoint_remote: { provider: "github", repo: "example/repository-control" },
      push_sessions: false,
    },
  }));
  const locallyMaskedAutomatic = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assertEntireMetadataBlocked(locallyMaskedAutomatic, /automatic checkpoint pushing is not disabled/);

  await writeFile(join(fixture.seed, ".entire", "settings.local.json"), JSON.stringify({
    strategy_options: {
      checkpoint_remote: { provider: "github", repo: "example/local-override" },
      push_sessions: false,
    },
  }));
  const overridden = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(overridden.checks.find((check) => check.id === "entire-metadata").detail, /Effective Entire checkpoint remote does not match/);
});

test("preflight uses the repository root and rejects invalid Codex configuration", async (t) => {
  const fixture = await preparedFixture(t);
  const nested = join(fixture.seed, "nested", "path");
  await mkdir(nested, { recursive: true });
  const rooted = await runPreparedPreflight(fixture, { repoPath: nested, commandRunner: fakeCommands() });
  assert.equal(rooted.status, "ready");

  await writeFile(fixture.codexConfigPath, "[features]\nhooks = true\n[features]\nhooks = true\n");
  const invalid = await runPreparedPreflight(fixture, { commandRunner: fakeCommands({ invalidCodexConfig: true }) });
  assert.equal(invalid.checks.find((check) => check.id === "codex-config").status, "blocked");
  assert.match(invalid.checks.find((check) => check.id === "codex-hook-trust").detail, /unproven/);

  const unavailable = await runPreparedPreflight(fixture, {
    codexBinary: "/bin/false",
    codexStateReader: undefined,
    commandRunner: fakeCommands(),
  });
  assert.equal(unavailable.checks.find((check) => check.id === "codex-config").status, "blocked");
});

test("release preflight requires clean main equal to origin main", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, "DIRTY.md"), "dirty\n");
  const result = await runPreparedPreflight(fixture, {
    profile: "release",
    commandRunner: fakeCommands(),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.checks.find((check) => check.id === "clean-main").detail, /not clean/);
});

test("preflight requires executable Entire hook commands, not empty event keys", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, ".codex", "hooks.json"), JSON.stringify({
    hooks: { SessionStart: [], UserPromptSubmit: [], Stop: [], PostToolUse: [] },
  }));
  const result = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  const hooks = result.checks.find((check) => check.id === "codex-hooks");
  assert.equal(hooks.status, "blocked");
  assert.match(hooks.detail, /sessionstart/);

  await writeEntireHooks(fixture.seed, (command) => `false && entire hooks codex ${command}`);
  const disabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(disabled.checks.find((check) => check.id === "codex-hooks").status, "blocked");

  await writeEntireHooks(fixture.seed, (command) => `entire hooks codex ${command}`);
  const hooksPath = join(fixture.seed, ".codex", "hooks.json");
  const platformHooks = JSON.parse(await readFile(hooksPath, "utf8"));
  platformHooks.hooks.UserPromptSubmit[0].matcher = "ignored";
  platformHooks.hooks.Stop[0].matcher = "ignored";
  platformHooks.hooks.SessionStart[0].matcher = "startup|resume|clear|compact";
  platformHooks.hooks.PostToolUse[0].matcher = "*";
  await writeFile(hooksPath, JSON.stringify(platformHooks));
  const documentedAllMatchers = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(documentedAllMatchers.checks.find((check) => check.id === "codex-hooks").status, "passed");

  platformHooks.hooks.PostToolUse[0].matcher = "^NoSuchTool$";
  await writeFile(hooksPath, JSON.stringify(platformHooks));
  const filtered = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(filtered.checks.find((check) => check.id === "codex-hooks").detail, /posttooluse/);

  platformHooks.hooks.PostToolUse[0].matcher = null;
  platformHooks.hooks.Stop[0].hooks[0].async = true;
  await writeFile(hooksPath, JSON.stringify(platformHooks));
  const asynchronous = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(asynchronous.checks.find((check) => check.id === "codex-hooks").detail, /stop/);
});

test("preflight normalizes GitHub remote identities and requires private control storage", async (t) => {
  const fixture = await preparedFixture(t);
  await runGit({ args: ["remote", "set-url", "control", "ssh://git@github.com/example/repository-control.git"], cwd: fixture.seed });
  const sshUrl = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(sshUrl.checks.find((check) => check.id === "github-remotes").status, "passed");

  await runGit({ args: ["remote", "set-url", "--add", "--push", "origin", "https://github.com/example/redirected.git"], cwd: fixture.seed });
  const pushUrl = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(pushUrl.checks.find((check) => check.id === "github-remotes").detail, /effective fetch and push URLs target different/);
  await runGit({ args: ["config", "--unset-all", "remote.origin.pushurl"], cwd: fixture.seed });

  await runGit({ args: ["config", "url.https://github.com/example/rewritten.git.pushInsteadOf", "https://github.com/example/repository.git"], cwd: fixture.seed });
  const rewritten = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(rewritten.checks.find((check) => check.id === "github-remotes").detail, /effective fetch and push URLs target different/);
  await runGit({ args: ["config", "--unset-all", "url.https://github.com/example/rewritten.git.pushInsteadOf"], cwd: fixture.seed });

  await runGit({ args: ["remote", "set-url", "control", "git@github.com:EXAMPLE/REPOSITORY.git"], cwd: fixture.seed });
  const same = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(same.checks.find((check) => check.id === "github-remotes").detail, /same GitHub repository/);

  await runGit({ args: ["remote", "set-url", "control", "git@github.com:example/repository-control.git"], cwd: fixture.seed });
  const publicControl = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands({ privateControl: false }),
  });
  assert.match(publicControl.checks.find((check) => check.id === "github-remotes").detail, /public/);
});

test("release preflight binds configured control remote and live origin main", async (t) => {
  const fixture = await preparedFixture(t);
  const wrongControl = await runPreparedPreflight(fixture, {
    profile: "release",
    controlRemote: "backup",
    commandRunner: fakeCommands(),
  });
  assert.match(wrongControl.checks.find((check) => check.id === "github-remotes").detail, /does not match platform remote/);

  await runGit({ args: ["add", ".codex/hooks.json", "tabellio.platform.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Add preflight contract"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", "refs/remotes/origin/main", "HEAD"], cwd: fixture.seed });
  const stale = await runPreparedPreflight(fixture, {
    profile: "release",
    commandRunner: fakeCommands(),
    remoteRefReader: async () => "f".repeat(40),
  });
  assert.match(stale.checks.find((check) => check.id === "clean-main").detail, /live origin\/main/);
});

async function preparedFixture(t) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await runGit({ args: ["remote", "set-url", "origin", "https://github.com/example/repository.git"], cwd: fixture.seed });
  await runGit({ args: ["remote", "add", "control", "git@github.com:example/repository-control.git"], cwd: fixture.seed });
  await mkdir(join(fixture.seed, ".codex"), { recursive: true });
  await mkdir(join(fixture.seed, ".entire"), { recursive: true });
  await writeFile(join(fixture.seed, ".entire", "settings.json"), JSON.stringify({
    enabled: true,
    strategy_options: {
      checkpoint_remote: { provider: "github", repo: "example/repository-control" },
      push_sessions: false,
    },
  }));
  await writeEntireHooks(fixture.seed, (command) => `entire hooks codex ${command}`);
  fixture.codexConfigPath = join(fixture.root, "codex-config.toml");
  fixture.codexRequirements = null;
  await writeCodexTrust(fixture, ["session_start", "user_prompt_submit", "stop", "post_tool_use"]);
  await writeFile(join(fixture.seed, "tabellio.platform.json"), JSON.stringify(platformFixture()));
  const checkpointDir = join(fixture.seed, "ab", "cdef123456");
  await mkdir(join(checkpointDir, "0"), { recursive: true });
  await writeFile(join(checkpointDir, "metadata.json"), JSON.stringify({
    checkpoint_id: "abcdef123456",
    sessions: [{
      metadata: "/ab/cdef123456/0/metadata.json",
      transcript: "/ab/cdef123456/0/full.jsonl",
      content_hash: "/ab/cdef123456/0/content_hash.txt",
    }],
  }));
  await writeFile(join(checkpointDir, "0", "metadata.json"), JSON.stringify({
    checkpoint_id: "abcdef123456",
    session_id: "session-fixture",
  }) + "\n");
  await writeFile(join(checkpointDir, "0", "full.jsonl"), "{}\n");
  await writeFile(join(checkpointDir, "0", "content_hash.txt"), "sha256:ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356\n");
  await runGit({ args: ["add", "--", "ab", ".entire/settings.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Add checkpoint metadata fixture"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", "refs/heads/entire/checkpoints/v1", "HEAD"], cwd: fixture.seed });
  await runGit({ args: ["update-ref", "refs/remotes/control/entire/checkpoints/v1", "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  return fixture;
}

async function runPreparedPreflight(fixture, options = {}) {
  return runPreflight({
    repoPath: fixture.seed,
    codexConfigPath: fixture.codexConfigPath,
    codexStateReader: async () => ({
      requirements: fixture.codexRequirements,
      hooks: [
        ...effectiveManagedHooks(fixture.codexRequirements),
        ...await effectiveProjectHooks(fixture),
      ],
    }),
    remoteRefReader: async () => fixture.liveControlOid,
    remoteRefsReader: async () => fixture.liveCheckpointRefs ?? new Map(),
    ...options,
  });
}

const FIXTURE_HOOK_HASHES = {
  session_start: "sha256:a6399ffe129edf2146be06d4ee584e8cb8a7fbb40da326d8ff1c2deb22876ca5",
  user_prompt_submit: "sha256:9c424e2158a618f360a1ae34341d492b8a09a42e920d0bde75da7850c54dd3ef",
  stop: "sha256:edd6678b7563e9c0a42fa2fecbd802d9e228ecb62c8eda3ea033d16cc1f66b54",
  post_tool_use: "sha256:17eefa5e04078c56f71cc43407b870a4590c2b8ed5d9a8b3b70f07e825cd1b8a",
};

async function writeCodexTrust(fixture, events, {
  digest = null,
  hooksEnabled = true,
  projectTrusted = true,
  encodeKeys = false,
  literalKeys = false,
  hooksComment = false,
  disabledEvent = null,
  malformedEnabledEvent = null,
} = {}) {
  fixture.hookTrust = {
    events: new Set(events),
    digest,
    projectTrusted,
    disabledEvent,
    malformedEnabledEvent,
  };
  const repoPath = await realpath(fixture.seed);
  const hooksPath = join(repoPath, ".codex", "hooks.json");
  const sections = events.map((event) => [
    tomlTable("hooks.state", `${hooksPath}:${event}:0:0`, { encode: encodeKeys, literal: literalKeys }),
    `trusted_hash = "${digest ?? FIXTURE_HOOK_HASHES[event]}"`,
    ...(event === disabledEvent ? ["enabled = false"] : []),
    ...(event === malformedEnabledEvent ? ['enabled = "false"'] : []),
  ].join("\n"));
  const config = [
    "[features]",
    `hooks = ${hooksEnabled}${hooksComment ? " # intentionally disabled" : ""}`,
    "",
    tomlTable("projects", repoPath, { literal: literalKeys }),
    `trust_level = "${projectTrusted ? "trusted" : "untrusted"}"`,
    "",
    ...sections,
  ].join("\n\n");
  await writeFile(fixture.codexConfigPath, config + "\n");
}

function tomlKey(value, encode) {
  const escaped = JSON.stringify(value).slice(1, -1);
  return encode ? escaped.replaceAll("/", "\\u002f") : escaped;
}

function tomlTable(prefix, value, { encode = false, literal = false } = {}) {
  if (literal) return `[${prefix}.'${value}']`;
  return `[${prefix}."${tomlKey(value, encode)}"]`;
}

async function writeEntireHooks(repoPath, commandFor) {
  const commands = [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "user-prompt-submit"],
    ["Stop", "stop"],
    ["PostToolUse", "post-tool-use"],
  ];
  const hooks = Object.fromEntries(commands.map(([event, command]) => [
    event,
    [{ hooks: [{ type: "command", command: commandFor(command) }] }],
  ]));
  await writeFile(join(repoPath, ".codex", "hooks.json"), JSON.stringify({ hooks }));
}

function assertHookChecksPassed(result) {
  for (const id of ["codex-hooks", "codex-hook-trust"]) {
    assert.equal(result.checks.find((check) => check.id === id).status, "passed");
  }
}

function assertEntireMetadataBlocked(result, pattern) {
  assert.match(result.checks.find((check) => check.id === "entire-metadata").detail, pattern);
}

async function commitCheckpointAndAssertValid(fixture, message) {
  await runGit({ args: ["commit", "-m", message], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", "refs/heads/entire/checkpoints/v1", "HEAD"], cwd: fixture.seed });
  fixture.liveControlOid = (await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed })).stdout.trim();
  const result = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(result.checks.find((check) => check.id === "entire-metadata").status, "passed");
}

function fakeCommands({ privateControl = true, invalidCodexConfig = false, effectiveHooks = true } = {}) {
  const commands = new Map([
    ["entire:--version", () => result("Entire CLI 0.7.7\n")],
    ["entire:status", () => result('{"enabled":true,"agents":["Codex"],"active_sessions":[]}\n')],
    ["codex:features", () => {
      if (invalidCodexConfig) throw new Error("Codex config.toml contains a duplicate table.");
      return result(`hooks stable ${effectiveHooks}\n`);
    }],
    ["gh:auth", () => result("", "Logged in with gho_secret\n")],
    ["gh:repo", () => result(`${JSON.stringify({ nameWithOwner: "example/repository-control", isPrivate: privateControl })}\n`)],
  ]);
  return async ({ binary, args }) => {
    const handler = commands.get(`${binary}:${args[0]}`);
    if (handler) return handler();
    throw new Error(`Unexpected command: ${binary} ${args.join(" ")}`);
  };
}

function result(stdout, stderr = "") {
  return { stdout, stderr, exitCode: 0, signal: null };
}

function managedEntireRequirements() {
  const events = [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "user-prompt-submit"],
    ["Stop", "stop"],
    ["PostToolUse", "post-tool-use"],
  ];
  return {
    allowManagedHooksOnly: true,
    hooks: Object.fromEntries(events.map(([event, command]) => [
      event,
      [{ hooks: [{ type: "command", command: `entire hooks codex ${command}`, async: false }] }],
    ])),
  };
}

function effectiveManagedHooks(requirements) {
  return Object.entries(requirements?.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap((group) => (
    group.hooks.map((handler) => ({
      isManaged: true,
      enabled: true,
      trustStatus: "managed",
      eventName: event[0].toLowerCase() + event.slice(1),
      handlerType: handler.type,
      command: handler.command,
      async: handler.async,
      matcher: group.matcher ?? null,
    }))
  )));
}

async function effectiveProjectHooks(fixture) {
  const sourcePath = await realpath(join(fixture.seed, ".codex", "hooks.json"));
  const config = JSON.parse(await readFile(sourcePath, "utf8"));
  return Object.entries(config.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap((group, groupIndex) => (
    group.hooks.map((handler, handlerIndex) => ({
      isManaged: false,
      source: "project",
      sourcePath,
      currentHash: FIXTURE_HOOK_HASHES[hookConfigEventName(event)],
      key: `${sourcePath}:${hookConfigEventName(event)}:${groupIndex}:${handlerIndex}`,
      enabled: projectHookEnabled(fixture.hookTrust, hookConfigEventName(event)),
      trustStatus: projectHookTrustStatus(fixture.hookTrust, hookConfigEventName(event)),
      eventName: event[0].toLowerCase() + event.slice(1),
      handlerType: handler.type,
      command: handler.command,
      async: handler.async,
      matcher: group.matcher ?? null,
    }))
  )));
}

function projectHookEnabled(trust, event) {
  return ![trust?.disabledEvent, trust?.malformedEnabledEvent].includes(event);
}

function projectHookTrustStatus(trust, event) {
  const candidate = { events: new Set(), ...trust };
  const sourceState = [candidate.projectTrusted, candidate.events.has(event)].every(Boolean) ? "trusted" : "untrusted";
  const digestState = candidate.digest === null ? "current" : "modified";
  return {
    "trusted:current": "trusted",
    "trusted:modified": "modified",
  }[`${sourceState}:${digestState}`] ?? "untrusted";
}

function hookConfigEventName(event) {
  return hookEventSnakeCase(event[0].toLowerCase() + event.slice(1));
}

function hookEventSnakeCase(eventName) {
  return eventName.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}
