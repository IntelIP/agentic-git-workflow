import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureContext } from "../scripts/lib/capture-context.mjs";
import { validateLedgerSnapshot } from "../scripts/lib/ledger-provider.mjs";
import { EntireLedgerProvider } from "../scripts/providers/entire-ledger-provider.mjs";
import { NativeGitStore } from "../scripts/providers/native-git-store.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";

test("Entire adapter captures metadata-only checkpoints and binds context", async (t) => {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-entire-"));
  t.after(() => removeTestRoots(fixture.root, toolRoot));
  const checkpointId = "abcdef123456";
  await runGit({ args: ["switch", "-c", "agent/entire", "main"], cwd: fixture.seed });
  await writeFile(join(fixture.seed, "ENTIRE.md"), "ledger\n");
  await runGit({ args: ["add", "ENTIRE.md"], cwd: fixture.seed });
  await runGit({
    args: ["commit", "-m", "Add Entire ledger", "-m", `Entire-Checkpoint: ${checkpointId}`],
    cwd: fixture.seed,
    env: identityEnv(),
  });
  const headCommit = await runGit({ args: ["rev-parse", "HEAD"], cwd: fixture.seed }).then((result) => result.stdout.trim());
  const binary = await fakeEntire(toolRoot, checkpointEnvelope(checkpointId));
  const provider = await EntireLedgerProvider.open(fixture.seed, { binary });
  const snapshot = await provider.snapshot({
    repositoryId: "example/repository",
    baseRevision: "main",
    headRevision: "agent/entire",
    capturedAt: "2026-07-10T12:00:00.000Z",
  });

  assert.equal(snapshot.provider.version, "0.7.7");
  assert.equal(snapshot.checkpoints.length, 1);
  assert.equal(snapshot.checkpoints[0].id, checkpointId);
  assert.deepEqual(snapshot.checkpoints[0].commits, [headCommit]);
  assert.equal(snapshot.checkpoints[0].summary, "Checkpoint metadata captured successfully.");
  assert.equal(JSON.stringify(snapshot).includes("transcript"), false);
  assert.equal(validateLedgerSnapshot(snapshot), snapshot);

  const store = await NativeGitStore.open(fixture.seed);
  const packet = await captureContext({
    store,
    baseRevision: "main",
    headRevision: "agent/entire",
    runId: "run-entire",
    repositoryId: "example/repository",
    actor: { type: "agent", id: "codex" },
    taskSummary: "Bind Entire checkpoint metadata.",
    createdAt: "2026-07-10T12:00:00.000Z",
    ledgerProvider: provider,
    requireLedger: true,
  });
  assert.deepEqual(packet.checkpoints, [{
    provider: "entire",
    id: checkpointId,
    ref: "entire/checkpoints/v1",
    commit: headCommit,
    digest: snapshot.checkpoints[0].digest,
    summary: "Checkpoint metadata captured successfully.",
  }]);
});

test("mandatory Entire mode rejects a change without checkpoint trailers", async (t) => {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-entire-empty-"));
  t.after(() => removeTestRoots(fixture.root, toolRoot));
  const binary = await fakeEntire(toolRoot, checkpointEnvelope("abcdef123456"));
  const provider = await EntireLedgerProvider.open(fixture.seed, { binary });
  const store = await NativeGitStore.open(fixture.seed);

  await assert.rejects(
    captureContext({
      store,
      baseRevision: "main",
      headRevision: "main",
      runId: "run-missing-entire",
      repositoryId: "example/repository",
      actor: { type: "agent", id: "codex" },
      taskSummary: "Require Entire.",
      ledgerProvider: provider,
      requireLedger: true,
    }),
    /Entire checkpoint required/,
  );
});

test("Entire adapter rejects partial checkpoint metadata", async (t) => {
  const fixture = await createFixture();
  const toolRoot = await mkdtemp(join(tmpdir(), "tabellio-entire-partial-"));
  t.after(() => removeTestRoots(fixture.root, toolRoot));
  const checkpointId = "abcdef123456";
  const binary = await fakeEntire(toolRoot, { ...checkpointEnvelope(checkpointId), partial: true });
  const provider = await EntireLedgerProvider.open(fixture.seed, { binary });

  await assert.rejects(provider.checkpoint(checkpointId), /metadata is partial/);
});

function checkpointEnvelope(checkpointId) {
  return {
    checkpoint_id: checkpointId,
    strategy: "manual-commit",
    branch: "agent/entire",
    checkpoints_count: 1,
    files_touched: ["ENTIRE.md"],
    session_count: 1,
    sessions: [{
      index: 0,
      session_id: "session-example",
      agent: "codex",
      model: "gpt-5.5",
      kind: "work",
      created_at: "2026-07-10T11:30:00Z",
      files_touched: ["ENTIRE.md"],
      token_usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 20,
      },
      summary: {
        intent: "Add GitHub-bound checkpoint capture.",
        outcome: "Checkpoint metadata captured successfully.",
      },
    }],
  };
}

function removeTestRoots(...roots) {
  return Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

async function fakeEntire(root, envelope) {
  const binary = join(root, "entire");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "version") {
  process.stdout.write("Entire CLI 0.7.7\\nGo version: go1.26.4\\nOS/Arch: darwin/arm64\\n");
  process.exit(0);
}
const expectedPrefix = ["checkpoint", "explain", "--json", "--checkpoint"];
if (JSON.stringify(args.slice(0, 4)) !== JSON.stringify(expectedPrefix) || args[5] !== "--no-pager") {
  process.stderr.write("unexpected args: " + JSON.stringify(args));
  process.exit(2);
}
const envelope = ${JSON.stringify(envelope)};
envelope.checkpoint_id = args[4];
process.stdout.write(JSON.stringify(envelope) + "\\n");
`;
  await writeFile(binary, source);
  await chmod(binary, 0o755);
  return binary;
}
