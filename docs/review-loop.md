# Durable Review And Fix Loop

Tabellio keeps review state in standard Git, not in a GitHub-only database. Forgejo remains the visible collaboration surface. The durable control-plane record lives on `refs/tabellio/reviews` as immutable JSON ledger commits updated with compare-and-swap.

## State Flow

```text
Forgejo reviews/comments/checks ----+
                                    +-> review cycle -> triage -> fix commit + Entire checkpoint
Codex or another agent review ------+                       |
                                                            v
                                             approved restack/update
                                                            |
                                                            v
                                               forge resync -> ready
```

Review status is deterministic:

| Status | Meaning |
| --- | --- |
| `draft` | The forge still marks the change request as draft |
| `needs_triage` | New feedback has not been classified |
| `changes_requested` | Actionable feedback remains open |
| `update_required` | Fix exists locally but is not in the remote PR head |
| `blocked` | A remote check failed or the forge reports the change as non-mergeable |
| `validating` | Checks are pending or running |
| `ready` | Feedback is handled, fixes are published, and checks are clear |
| `merged` / `closed` | Forge terminal state |

## Sync Forgejo

```bash
node scripts/tabellio-review.mjs sync \
  --repo . \
  --owner example \
  --forge-repo project \
  --number 7 \
  --base-url https://forgejo.example.com \
  --token-file /secure/path/forgejo-token \
  --actor review-sync-agent
```

Sync imports reviews, inline review comments, issue comments, and commit checks. Missing provider items are retained as stale evidence rather than silently deleted.

## Import A Codex Review

Codex and other agents emit `tabellio-agent-review/v0.1`:

```bash
node scripts/tabellio-review.mjs import \
  --repo . \
  --owner example \
  --forge-repo project \
  --number 7 \
  --input /tmp/codex-review.json \
  --actor codex
```

Imports fail when the repository, PR number, or reviewed head commit is stale. Agent findings therefore remain tied to the exact diff reviewed.

## Triage And Fix

```bash
node scripts/tabellio-review.mjs triage \
  --repo . --owner example --forge-repo project --number 7 \
  --feedback-id review-comment:41 \
  --disposition actionable \
  --reason "Correctness issue" \
  --actor reviewer

node scripts/tabellio-review.mjs fix \
  --repo . --owner example --forge-repo project --number 7 \
  --feedback-ids review-comment:41 \
  --commit HEAD \
  --checkpoint 61229f2bfcff \
  --summary "Added null guard and regression test" \
  --actor fix-agent
```

A fix must descend from the last synchronized PR head. Its commit range must contain exactly one matching `Entire-Checkpoint` trailer. The cycle stays `update_required` until a later forge sync proves the fix is contained in the remote PR head.

git-spice restacks rewrite commit IDs. Tabellio retains `originalCommit` and remaps the active fix commit by its unique Entire checkpoint after the rewritten branch is pushed. Ambiguous checkpoint matches stay unpublished and cannot become ready.

## Storage And Transport

Ledger writes create normal Git blobs, trees, and commits without changing the working tree. Concurrent writers use compare-and-swap on `refs/tabellio/reviews`; stale writers fail instead of overwriting newer state. The same implementation works in normal and bare repositories. The latest cycle retains the newest 100 audit events; older versions remain recoverable from the ledger's Git commit history.

To share the ledger, configure explicit ref transport for the chosen forge, for example:

```bash
git push origin refs/tabellio/reviews:refs/tabellio/reviews
git fetch origin refs/tabellio/reviews:refs/tabellio/reviews
```

Publishing that ref is a remote write and should use the same explicit approval boundary as other Git transport mutations.
