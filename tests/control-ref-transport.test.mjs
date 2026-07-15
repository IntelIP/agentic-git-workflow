import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ApprovedControlRefTransport,
  createControlRefIntent,
  snapshotControlRefs,
  validateControlRefApproval,
  validateControlRefIntent,
} from "../scripts/lib/control-ref-transport.mjs";
import { GitJsonLedger } from "../scripts/lib/git-json-ledger.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { createFixture } from "./helpers/git-fixture.mjs";

const createdAt = "2026-07-10T12:00:00.000Z";
const approvedAt = "2026-07-10T12:01:00.000Z";
const expiresAt = "2026-07-10T13:01:00.000Z";
const now = new Date("2026-07-10T12:02:00.000Z");

test("approved control refs publish and fetch exact fast-forward state", async (t) => {
  const fixture = await createFixture();
  await addControlRemote(fixture.seed, fixture.bare);
  const stateRoot = await mkdtemp(join(tmpdir(), "tabellio-control-ref-"));
  removeAfter(t, fixture.root, stateRoot);

  const { intent: publish } = await createValidationPublishIntent(fixture.seed);
  validateControlRefIntent(publish);
  const publisher = await ApprovedControlRefTransport.open({ repoPath: fixture.seed, stateRoot: join(stateRoot, "publish") });
  const published = await publisher.execute({ intent: publish, approval: approvalFor(publish, "publish-once"), repositoryId: "example/repository", now });
  assert.equal(published.status, "succeeded");
  assert.equal(published.refs[0].status, "published");
  await assert.rejects(
    publisher.execute({ intent: publish, approval: approvalFor(publish, "publish-once"), repositoryId: "example/repository", now }),
    /already consumed/,
  );

  const consumer = join(fixture.root, "consumer");
  await runGit({ args: ["clone", fixture.bare, consumer], cwd: fixture.root });
  await addControlRemote(consumer, fixture.bare);
  const fetch = createControlRefIntent({
    operation: "fetch",
    repositoryId: "example/repository",
    remote: "ledger",
    refs: await snapshotControlRefs({ repoPath: consumer, remote: "ledger", refs: ["refs/tabellio/validations"] }),
    createdAt,
  });
  const fetcher = await ApprovedControlRefTransport.open({ repoPath: consumer, stateRoot: join(stateRoot, "fetch") });
  const fetched = await fetcher.execute({ intent: fetch, approval: approvalFor(fetch, "fetch-once"), repositoryId: "example/repository", now });
  assert.equal(fetched.refs[0].status, "fetched");
  const local = await runGit({ args: ["rev-parse", "refs/tabellio/validations"], cwd: consumer });
  assert.equal(local.stdout.trim(), fetch.refs[0].remoteOid);
});

test("control ref operations reject tampering, expiry, and changed refs", async (t) => {
  const fixture = await createFixture();
  await addControlRemote(fixture.seed, fixture.bare);
  const stateRoot = await mkdtemp(join(tmpdir(), "tabellio-control-ref-block-"));
  removeAfter(t, fixture.root, stateRoot);
  const { intent, ledger } = await createValidationPublishIntent(fixture.seed);
  const tampered = structuredClone(intent);
  tampered.remote = "other";
  assert.throws(() => validateControlRefIntent(tampered), /digest does not match/);
  const expired = { ...approvalFor(intent, "expired"), expiresAt: approvedAt };
  assert.throws(() => validateControlRefApproval(expired, intent, { now }), /later than/);
  await ledger.write("runs/two.json", { status: "passed" }, { expectedVersion: await ledger.version() });
  const transport = await ApprovedControlRefTransport.open({ repoPath: fixture.seed, stateRoot });
  await assert.rejects(
    transport.execute({ intent, approval: approvalFor(intent, "stale-local"), repositoryId: "example/repository", now }),
    /Local control ref changed/,
  );
});

test("control ref transport opens bare repositories", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const transport = await ApprovedControlRefTransport.open({ repoPath: fixture.bare });
  assert.equal(transport.repoPath, await realpath(fixture.bare));
});

test("multi-ref publication is atomic when one remote ref is rejected", async (t) => {
  const fixture = await createFixture();
  await addControlRemote(fixture.seed, fixture.bare);
  const stateRoot = await mkdtemp(join(tmpdir(), "tabellio-control-ref-atomic-"));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(stateRoot, { recursive: true, force: true }),
  ]));
  for (const ref of ["refs/tabellio/validations", "refs/tabellio/reviews"]) {
    const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref });
    await ledger.write("state/one.json", { ref }, { expectedVersion: null });
  }
  const hook = join(fixture.bare, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/tabellio/reviews" ]; then exit 1; fi\ndone\nexit 0\n`);
  await chmod(hook, 0o755);
  const intent = createControlRefIntent({
    operation: "publish",
    repositoryId: "example/repository",
    remote: "ledger",
    refs: await snapshotControlRefs({
      repoPath: fixture.seed,
      remote: "ledger",
      refs: ["refs/tabellio/validations", "refs/tabellio/reviews"],
    }),
    createdAt,
  });
  const transport = await ApprovedControlRefTransport.open({ repoPath: fixture.seed, stateRoot });
  await assert.rejects(
    transport.execute({ intent, approval: approvalFor(intent, "atomic-rejection"), repositoryId: "example/repository", now }),
    /git push .* failed/,
  );
  const remote = await runGit({
    args: ["ls-remote", "--refs", "ledger", "refs/tabellio/validations", "refs/tabellio/reviews"],
    cwd: fixture.seed,
  });
  assert.equal(remote.stdout, "");
});

test("code-storage remote rejects control-state publication", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ledger = await GitJsonLedger.open({ repoPath: fixture.seed, ref: "refs/tabellio/validations" });
  await ledger.write("runs/one.json", { status: "passed" }, { expectedVersion: null });

  await assert.rejects(
    snapshotControlRefs({ repoPath: fixture.seed, remote: "origin", refs: ["refs/tabellio/validations"] }),
    /must not target code-storage remote origin/,
  );
  assert.throws(
    () => createControlRefIntent({
      operation: "publish",
      repositoryId: "example/repository",
      remote: "origin",
      refs: [{ name: "refs/tabellio/validations", localOid: "a".repeat(40), remoteOid: null }],
      createdAt,
    }),
    /must not target code-storage remote origin/,
  );
});

test("control-ref JSON schema encodes runtime uniqueness and required OIDs", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/control-ref-operation.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.refs.uniqueItems, true);
  assert.equal(schema.properties.refs.maxItems, 3);
  assert.equal(schema.properties.refs.allOf.length, 3);
  const publish = schema.allOf.find((rule) => rule.if.properties.operation.const === "publish");
  const fetch = schema.allOf.find((rule) => rule.if.properties.operation.const === "fetch");
  assert.equal(publish.then.properties.refs.items.properties.localOid.type, "string");
  assert.equal(fetch.then.properties.refs.items.properties.remoteOid.type, "string");
});

function approvalFor(intent, id) {
  return {
    schemaVersion: "tabellio-control-ref-approval/v0.1",
    id,
    intentDigest: intent.integrity.digest,
    approved: true,
    approvedBy: "human-reviewer",
    approvedAt,
    expiresAt,
    reason: "Approved exact control-ref transfer.",
  };
}

async function addControlRemote(repoPath, barePath) {
  await runGit({ args: ["remote", "add", "ledger", barePath], cwd: repoPath });
}

async function createValidationPublishIntent(repoPath) {
  const ledger = await GitJsonLedger.open({ repoPath, ref: "refs/tabellio/validations" });
  await ledger.write("runs/one.json", { status: "passed" }, { expectedVersion: null });
  const intent = createControlRefIntent({
    operation: "publish",
    repositoryId: "example/repository",
    remote: "ledger",
    refs: await snapshotControlRefs({ repoPath, remote: "ledger", refs: ["refs/tabellio/validations"] }),
    createdAt,
  });
  return { intent, ledger };
}

function removeAfter(t, ...paths) {
  t.after(() => Promise.all(paths.map((path) => rm(path, { recursive: true, force: true }))));
}
