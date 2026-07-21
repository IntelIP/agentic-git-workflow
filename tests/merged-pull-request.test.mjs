import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergedPullRequestForCommit } from "../scripts/lib/merged-pull-request.mjs";

const mergeCommit = "a".repeat(40);
const headCommit = "b".repeat(40);

test("merged pull-request resolution binds a squash commit to its durable pull ref", () => {
  const result = mergedPullRequestForCommit([
    pullRequest({ mergeCommit: "c".repeat(40), headCommit: "d".repeat(40), number: 23 }),
    pullRequest({ mergeCommit, headCommit, number: 24 }),
  ], mergeCommit);

  assert.deepEqual(result, {
    number: 24,
    headCommit,
    fetchRef: "refs/pull/24/head",
    localRef: "refs/remotes/origin/pull/24/head",
  });
});

test("merged pull-request resolution preserves direct-push checkpoint behavior", () => {
  assert.equal(mergedPullRequestForCommit([], mergeCommit), null);
  assert.equal(mergedPullRequestForCommit([
    { ...pullRequest({ mergeCommit, headCommit, number: 24 }), merged_at: null },
  ], mergeCommit), null);
});

test("merged pull-request resolution fails closed on ambiguous or malformed evidence", () => {
  assert.throws(
    () => mergedPullRequestForCommit([
      pullRequest({ mergeCommit, headCommit, number: 24 }),
      pullRequest({ mergeCommit, headCommit: "c".repeat(40), number: 25 }),
    ], mergeCommit),
    /multiple merged pull requests/,
  );
  assert.throws(
    () => mergedPullRequestForCommit([pullRequest({ mergeCommit, headCommit: "short", number: 24 })], mergeCommit),
    /full hexadecimal Git object ID/,
  );
});

test("product validation workflow preserves merged execution and exact checkpoint proof", async () => {
  const workflow = await readFile(new URL("../.github/workflows/product-validation.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /commits\/\$MERGED_COMMIT\/pulls/);
  assert.match(workflow, /set -o pipefail/);
  assert.match(workflow, /test "\$actual_head" = "\$CHECKPOINT_EXPECTED_HEAD"/);
  assert.match(workflow, /--checkpoint-base "\$base_ref" --checkpoint-head "\$CHECKPOINT_HEAD"/);
});

function pullRequest({ mergeCommit: mergedCommit, headCommit: head, number }) {
  return {
    number,
    merged_at: "2026-07-21T10:03:06Z",
    merge_commit_sha: mergedCommit,
    head: { sha: head },
  };
}
