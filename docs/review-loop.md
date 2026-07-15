# Durable Review And Fix Loop

GitHub provides the visible pull-request surface. Tabellio keeps the full review state outside code storage on `refs/tabellio/reviews` as immutable JSON ledger commits updated with compare-and-swap.

## State Flow

```text
GitHub reviews/comments/checks -----+
                                    +-> review cycle -> triage -> fix commit + Entire checkpoint
Codex or another agent review ------+                       |
                                                            v
                                             approved restack/update
                                                            |
                                                            v
                                              GitHub resync -> ready
```

Review status is deterministic:

| Status | Meaning |
| --- | --- |
| `draft` | GitHub still marks the pull request as draft |
| `needs_triage` | New feedback has not been classified |
| `changes_requested` | Actionable feedback remains open |
| `update_required` | Fix exists locally but is not in the remote PR head |
| `blocked` | A remote check failed or GitHub reports the change as non-mergeable |
| `validating` | No validation result exists yet, or checks are pending/running |
| `ready` | Feedback is handled, fixes are published, and checks are clear |
| `merged` / `closed` | Pull-request terminal state |

## Sync GitHub

```bash
node scripts/tabellio-review.mjs sync \
  --repo . \
  --owner example \
  --remote-repo project \
  --number 7 \
  --token-file /secure/path/github-token \
  --actor review-sync-agent
```

Sync imports GitHub reviews, inline review comments, issue comments, commit statuses, check runs, and the newest Tabellio validation for the PR head. `GITHUB_TOKEN` may replace `--token-file`; `GITHUB_API_URL` or `--api-url` may target GitHub Enterprise Server. Missing GitHub items are retained as stale evidence rather than silently deleted. A PR with no validation remains `validating`.

## Migrate A v0.1 Cycle

Review cycles created before the GitHub-only boundary use `tabellio-review-cycle/v0.1` and a legacy ledger path. Preview the deterministic migration first:

```bash
node scripts/tabellio-review.mjs migrate \
  --repo . \
  --repo-id IntelIP/Tabellio \
  --owner IntelIP \
  --remote-repo Tabellio \
  --number 7 \
  --target-number 14 \
  --legacy-repo-id old-owner/old-repository \
  --legacy-owner old-owner \
  --legacy-remote-repo old-repository
```

Apply the verified plan explicitly:

```bash
node scripts/tabellio-review.mjs migrate \
  --repo . \
  --repo-id IntelIP/Tabellio \
  --owner IntelIP \
  --remote-repo Tabellio \
  --number 7 \
  --target-number 14 \
  --legacy-repo-id old-owner/old-repository \
  --legacy-owner old-owner \
  --legacy-remote-repo old-repository \
  --apply true
```

`--number` identifies the legacy cycle. `--target-number` identifies the corresponding GitHub pull request and defaults to `--number`. Legacy identity options default to the target coordinates, so they are needed only when the repository moved or was renamed. The migration verifies the v0.1 integrity digest and source identity, maps repository and provider identity to the GitHub target, rewrites feedback sources, replaces the pull-request URL with its canonical GitHub URL, clears obsolete provider check links, recomputes integrity, and atomically moves the ledger entry to its v0.2 path. It can also atomically correct a previously migrated cycle whose GitHub PR number was mapped incorrectly; that recovery path additionally requires `--remap-current true`. The current ledger tree contains only the v0.2 entry; prior forms remain recoverable from Git history. Repeating the command reports `current` without writing another commit.

Migration marks the provider-owned change-request ID as pending. Run `sync` for the target GitHub PR immediately after applying so GitHub refreshes the ID, title, state, head/base commits, feedback, and checks.

## Import A Codex Review

Codex and other agents emit `tabellio-agent-review/v0.1`:

```bash
node scripts/tabellio-review.mjs import \
  --repo . \
  --owner example \
  --remote-repo project \
  --number 7 \
  --input /tmp/codex-review.json \
  --actor codex
```

Imports fail when the repository, PR number, or reviewed head commit is stale. Agent findings therefore remain tied to the exact diff reviewed.

## Triage And Fix

```bash
node scripts/tabellio-review.mjs triage \
  --repo . --owner example --remote-repo project --number 7 \
  --feedback-id review-comment:41 \
  --disposition actionable \
  --reason "Correctness issue" \
  --actor reviewer

node scripts/tabellio-review.mjs fix \
  --repo . --owner example --remote-repo project --number 7 \
  --feedback-ids review-comment:41 \
  --commit HEAD \
  --checkpoint 61229f2bfcff \
  --summary "Added null guard and regression test" \
  --actor fix-agent
```

A fix must descend from the last synchronized PR head. Its commit range must contain exactly one matching `Entire-Checkpoint` trailer. The cycle stays `update_required` until a later GitHub sync proves the fix is contained in the remote PR head.

git-spice restacks rewrite commit IDs. Tabellio retains `originalCommit` and remaps the active fix commit by its unique Entire checkpoint after the rewritten branch is pushed. Ambiguous checkpoint matches stay unpublished and cannot become ready.

## Storage And Transport

Ledger writes create normal Git blobs, trees, and commits without changing the working tree. Concurrent writers use compare-and-swap on `refs/tabellio/reviews`; stale writers fail instead of overwriting newer state. The same implementation works in normal and bare repositories. The latest cycle retains the newest 100 audit events; older versions remain recoverable from the ledger's Git commit history.

To share the ledger, configure a separate private GitHub repository as the control-state remote, for example:

```bash
git push "$TABELLIO_CONTROL_REMOTE" refs/tabellio/reviews:refs/tabellio/reviews
git fetch "$TABELLIO_CONTROL_REMOTE" refs/tabellio/reviews:refs/tabellio/reviews
```

The private GitHub control remote must not be `origin`. Publishing that ref is a remote write and uses the same explicit approval boundary as other Git transport mutations.
