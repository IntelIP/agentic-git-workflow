import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createMergeReadyStatusIntent,
  validateMergeReadyStatusApproval,
  validateMergeReadyStatusIntent,
} from "../scripts/lib/merge-ready-status.mjs";
import { MergeReadyStatusExecutor } from "../scripts/lib/merge-ready-status-workflow.mjs";
import { digestObject } from "../scripts/lib/stack-operation.mjs";
import {
  GitHubStatusPublishError,
  GitHubStatusPublisher,
} from "../scripts/providers/github-status-publisher.mjs";

const now = new Date("2026-07-24T12:10:00.000Z");
const createdAt = "2026-07-24T12:00:00.000Z";
const expiresAt = "2026-07-24T13:00:00.000Z";
const repository = {
  id: "github.com/IntelIP/Tabellio",
  owner: "IntelIP",
  name: "Tabellio",
};

test("merge-ready status intent binds exact validation and derives the fixed success context", async () => {
  const validation = await validationFixture();
  const intent = createMergeReadyStatusIntent({
    repository,
    commit: validation.revision.headCommit,
    validation,
    targetUrl: "https://example.test/evidence/validation-example-001",
    createdAt,
  });

  assert.equal(intent.status.context, "Tabellio / merge-ready");
  assert.equal(intent.status.state, "success");
  assert.equal(intent.validation.resultDigest, validation.integrity.digest);
  assert.equal(validateMergeReadyStatusIntent(intent), intent);

  const tampered = structuredClone(intent);
  tampered.commit = "c".repeat(40);
  assert.throws(() => validateMergeReadyStatusIntent(tampered), /integrity.digest/);
});

test("merge-ready status derives failure and schema contracts forbid extension fields", async () => {
  const validation = await validationFixture();
  validation.status = "failed";
  validation.commands[0].status = "failed";
  validation.commands[0].exitCode = 1;
  const { integrity: _integrity, ...unsigned } = validation;
  validation.integrity.digest = digestObject(unsigned);
  const intent = createMergeReadyStatusIntent({
    repository,
    commit: validation.revision.headCommit,
    validation,
    createdAt,
  });
  assert.equal(intent.status.state, "failure");

  const [intentSchema, approvalSchema, receiptSchema] = await Promise.all([
    schema("merge-ready-status-intent.schema.json"),
    schema("merge-ready-status-approval.schema.json"),
    schema("merge-ready-status-receipt.schema.json"),
  ]);
  assert.equal(intentSchema.additionalProperties, false);
  assert.equal(intentSchema.properties.status.properties.context.const, "Tabellio / merge-ready");
  assert.deepEqual(intentSchema.properties.validation.properties.status.enum, ["passed", "failed", "blocked"]);
  assert.equal(approvalSchema.additionalProperties, false);
  assert.equal(approvalSchema.properties.approved.const, true);
  assert.equal(receiptSchema.additionalProperties, false);
  assert.deepEqual(receiptSchema.properties.status.enum, ["attempted", "succeeded", "failed"]);
});

test("merge-ready status approval is exact-intent, active, and capped at one hour", async () => {
  const validation = await validationFixture();
  const intent = createMergeReadyStatusIntent({
    repository,
    commit: validation.revision.headCommit,
    validation,
    createdAt,
  });
  const approval = approvalFor(intent, "publish-status");
  assert.equal(validateMergeReadyStatusApproval(approval, intent, { now }), approval);
  assert.throws(
    () => validateMergeReadyStatusApproval(
      { ...approval, expiresAt: "2026-07-24T13:00:00.001Z" },
      intent,
      { now },
    ),
    /lifetime must not exceed one hour/,
  );
  assert.throws(
    () => validateMergeReadyStatusApproval(
      { ...approval, intentDigest: "f".repeat(64) },
      intent,
      { now },
    ),
    /approval.intentDigest/,
  );
});

test("GitHub status publisher posts only the approved commit status fields", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({
      method: options.method,
      url: url.toString(),
      authorization: options.headers.Authorization,
      body: JSON.parse(options.body),
    });
    return new Response(JSON.stringify({
      id: 71,
      sha: "b".repeat(40),
      state: "success",
      context: "Tabellio / merge-ready",
      description: "Exact-head Tabellio validation passed.",
      target_url: "https://example.test/evidence",
      created_at: createdAt,
      updated_at: createdAt,
    }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const publisher = new GitHubStatusPublisher({
    baseUrl: "https://127.0.0.1:9443",
    token: "secret-token",
    fetchImpl,
  });
  const result = await publisher.publish({
    owner: "IntelIP",
    repo: "Tabellio",
    commit: "b".repeat(40),
    state: "success",
    context: "Tabellio / merge-ready",
    description: "Exact-head Tabellio validation passed.",
    targetUrl: "https://example.test/evidence",
  });

  assert.equal(result.id, "71");
  assert.deepEqual(requests, [{
    method: "POST",
    url: `https://127.0.0.1:9443/repos/IntelIP/Tabellio/statuses/${"b".repeat(40)}`,
    authorization: "Bearer secret-token",
    body: {
      state: "success",
      context: "Tabellio / merge-ready",
      description: "Exact-head Tabellio validation passed.",
      target_url: "https://example.test/evidence",
    },
  }]);
});

test("GitHub status publisher permits GitHub Cloud and loopback test transports only", () => {
  const options = { token: "secret-token", fetchImpl: async () => new Response() };
  assert.doesNotThrow(() => new GitHubStatusPublisher({
    ...options,
    baseUrl: "https://api.github.com",
  }));
  assert.doesNotThrow(() => new GitHubStatusPublisher({
    ...options,
    baseUrl: "http://localhost:8080",
  }));
  assert.doesNotThrow(() => new GitHubStatusPublisher({
    ...options,
    baseUrl: "https://127.0.0.1:9443",
  }));
  assert.throws(
    () => new GitHubStatusPublisher({ ...options, baseUrl: "https://example.com" }),
    /must target GitHub Cloud or loopback/,
  );
  assert.throws(
    () => new GitHubStatusPublisher({ ...options, baseUrl: "https://api.github.com.example.test" }),
    /must target GitHub Cloud or loopback/,
  );
  assert.throws(
    () => new GitHubStatusPublisher({ ...options, baseUrl: "https://api.github.com:8443" }),
    /must target GitHub Cloud or loopback/,
  );
});

test("GitHub status publisher rejects unsafe endpoints and redacts token failures", async () => {
  assert.throws(
    () => new GitHubStatusPublisher({ baseUrl: "http://example.com", token: "token" }),
    /must target GitHub Cloud or loopback/,
  );
  const publisher = new GitHubStatusPublisher({
    baseUrl: "https://api.github.com",
    token: "secret-token",
    fetchImpl: async () => new Response(
      JSON.stringify({ message: "bad secret-token" }),
      { status: 500, headers: { "content-type": "application/json" } },
    ),
  });
  await assert.rejects(
    publisher.publish({
      owner: "IntelIP",
      repo: "Tabellio",
      commit: "b".repeat(40),
      state: "success",
      context: "Tabellio / merge-ready",
      description: "Exact-head Tabellio validation passed.",
    }),
    (error) => error instanceof GitHubStatusPublishError
      && error.status === 500
      && error.message.includes("[REDACTED]")
      && !error.message.includes("secret-token"),
  );

  const incompletePublisher = new GitHubStatusPublisher({
    baseUrl: "https://api.github.com",
    token: "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({
      id: 72,
      state: "success",
      context: "Tabellio / merge-ready",
    }), { status: 201, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    incompletePublisher.publish({
      owner: "IntelIP",
      repo: "Tabellio",
      commit: "b".repeat(40),
      state: "success",
      context: "Tabellio / merge-ready",
      description: "Exact-head Tabellio validation passed.",
    }),
    /status.sha must be a Git object ID/,
  );
});

test("status executor re-verifies exact validation and consumes one approval once", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-status-"));
  const validation = await validationFixture();
  const intent = createMergeReadyStatusIntent({
    repository,
    commit: validation.revision.headCommit,
    validation,
    createdAt,
  });
  const approval = approvalFor(intent, "one-status");
  const publications = [];
  const executor = new MergeReadyStatusExecutor({
    store: {
      repoPath: root,
      async gitConfig() { return "https://github.com/IntelIP/Tabellio.git"; },
      async resolveRef(value) { return value; },
    },
    ledger: validationLedger(validation),
    publisher: {
      async publish(value) {
        publications.push(value);
        return {
          id: "81",
          commit: value.commit,
          state: value.state,
          context: value.context,
          description: value.description,
          targetUrl: value.targetUrl,
          createdAt,
          updatedAt: createdAt,
        };
      },
    },
    stateRoot: root,
    lock: async (_options, action) => action(),
  });

  const result = await executor.execute({ intent, approval, now });
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(result.receipt.commit, validation.revision.headCommit);
  assert.equal(publications.length, 1);
  assert.equal(JSON.parse(await readFile(result.receiptPath, "utf8")).status, "succeeded");
  await assert.rejects(executor.execute({ intent, approval, now }), /already consumed/);

  const mismatched = structuredClone(intent);
  mismatched.validation.resultDigest = "e".repeat(64);
  const { integrity: _integrity, ...unsigned } = mismatched;
  mismatched.integrity.digest = digestObject(unsigned);
  await assert.rejects(
    executor.execute({ intent: mismatched, approval: approvalFor(mismatched, "mismatch"), now }),
    /validation.integrity.digest/,
  );
});

function approvalFor(intent, id) {
  return {
    schemaVersion: "tabellio-merge-ready-status-approval/v0.1",
    id,
    intentDigest: intent.integrity.digest,
    approved: true,
    approvedBy: "Hudson Aikins",
    approvedAt: createdAt,
    expiresAt,
    reason: "Publish the exact validation decision for this candidate.",
  };
}

async function validationFixture() {
  const source = JSON.parse(await readFile(
    new URL("../examples/tabellio-validation/minimal-result.json", import.meta.url),
    "utf8",
  ));
  source.repository.id = repository.id;
  const { integrity: _integrity, ...unsigned } = source;
  source.integrity.digest = digestObject(unsigned);
  return source;
}

async function schema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

function validationLedger(value) {
  const path = `commits/${value.revision.headCommit}/${value.runId}.json`;
  return {
    async list() { return { paths: [path], version: "d".repeat(40) }; },
    async read(requested) {
      return { value: requested === path ? value : null, version: "d".repeat(40) };
    },
  };
}
