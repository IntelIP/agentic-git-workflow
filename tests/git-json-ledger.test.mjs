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

test("Git JSON ledger atomically moves and rewrites an entry", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/reviews" });
  const first = await ledger.write("cycles/legacy.json", { schema: "v1" }, { expectedVersion: null });
  const moved = await ledger.write(
    "cycles/current.json",
    { schema: "v2" },
    { expectedVersion: first.version, replacePath: "cycles/legacy.json" },
  );

  assert.equal((await ledger.read("cycles/legacy.json")).value, null);
  assert.deepEqual(await ledger.read("cycles/current.json"), {
    value: { schema: "v2" },
    version: moved.version,
  });
  assert.deepEqual((await ledger.list("cycles")).paths, ["cycles/current.json"]);
  await assert.rejects(
    ledger.write("cycles/next.json", {}, { expectedVersion: moved.version, replacePath: "cycles/missing.json" }),
    /does not exist/,
  );
});

test("concurrent Git JSON ledger writers allow exactly one compare-and-swap winner", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/reviews" });
  const second = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/reviews" });
  const settled = await Promise.allSettled([
    first.write("cycles/first.json", { writer: "first" }, { expectedVersion: null }),
    second.write("cycles/second.json", { writer: "second" }, { expectedVersion: null }),
  ]);
  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert(rejected[0].reason instanceof LedgerConflictError);
  const listed = await first.list("cycles");
  assert.equal(listed.paths.length, 1);
});
