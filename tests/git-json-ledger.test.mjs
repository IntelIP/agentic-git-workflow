import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { GitJsonLedger, LedgerConflictError } from "../scripts/lib/git-json-ledger.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { createFixture } from "./helpers/git-fixture.mjs";

test("Git JSON ledger persists immutable versioned state without touching the worktree", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/reviews" });
  assert.deepEqual(await ledger.read("cycles/example.json"), { value: null, version: null });

  const first = await ledger.write("cycles/example.json", { round: 1 }, { expectedVersion: null });
  assert.match(first.version, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.deepEqual(await ledger.read("cycles/example.json"), { value: { round: 1 }, version: first.version });

  const second = await ledger.write("cycles/example.json", { round: 2 }, { expectedVersion: first.version });
  assert.equal(second.previousVersion, first.version);
  assert.deepEqual(await ledger.read("cycles/example.json"), { value: { round: 2 }, version: second.version });
  assert.deepEqual(await ledger.list("cycles"), { paths: ["cycles/example.json"], version: second.version });

  await assert.rejects(
    ledger.write("cycles/example.json", { round: 3 }, { expectedVersion: first.version }),
    (error) => error instanceof LedgerConflictError && error.actual === second.version,
  );
  await assert.rejects(
    ledger.write("../escape.json", {}, { expectedVersion: second.version }),
    /unsupported segment|safe relative path/,
  );
  const status = await runGit({ args: ["status", "--porcelain=v1"], cwd: fixture.seed });
  assert.equal(status.stdout, "");
});

test("Git JSON ledger works in a bare repository", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ledger = await GitJsonLedger.open({ repoPath: fixture.bare, ref: "refs/tabellio/reviews" });
  const written = await ledger.write("cycles/bare.json", { durable: true }, { expectedVersion: null });
  assert.deepEqual(await ledger.read("cycles/bare.json"), { value: { durable: true }, version: written.version });
});
