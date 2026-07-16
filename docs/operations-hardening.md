# Operations Hardening

Tabellio keeps code and control state in standard Git objects, but production safety still depends on bounded workers and disciplined ref publication.

## Concurrency And Recovery

- Review and validation ledgers use compare-and-swap ref updates. Concurrent writers cannot silently overwrite one another.
- Stack and control-ref mutations use crash-safe compare-and-swap locks under local `refs/tabellio/locks/`. A live same-host process or valid cross-host owner blocks another writer.
- A dead same-host process lock is deleted only when its exact Git object ID still matches, so concurrent recovery cannot remove a replacement owner.
- Deploy one writer per repository on shared storage. Cross-host locks fail safe and require operator recovery when the recorded host is permanently unavailable.

## Bounded Work

- Validation manifests allow at most 50 commands, 100 arguments per command, and one-hour command timeouts.
- Timed-out commands receive `SIGTERM`, then `SIGKILL` after one second. Fail-fast suites mark remaining commands skipped.
- Full stdout and stderr are hashed; only the newest 16 KiB of each stream is retained.
- Agent reviews allow at most 1,000 findings. Review cycles bound feedback, fixes, check statuses, titles, bodies, summaries, event details, and retained event history.
- Remote control-ref reads and atomic pushes use a 15-minute timeout. Local atomic ref updates use a 30-second timeout.

## Canonical Code Repository

GitHub `origin` is the canonical code repository and merge authority:

1. Validate the exact pull-request head.
2. Merge through the approved git-spice operation.
3. Fetch canonical `main` from `origin`.
4. Verify local `main` and `origin/main` resolve to the same object ID.

Do not maintain a second merge authority. Independent squash or rebase merges create different histories even when file content matches.

## Control-State Publication

Review cycles, validation results, and Entire checkpoints are published together with `git push --atomic`, explicit force-with-lease expectations, and a one-use approval. Publication permits refs that were already unchanged at planning while rejecting partial publication, non-fast-forward updates, divergence, changed local or remote object IDs, expired approvals, and reused approval IDs. Release retries derive a fresh one-use control approval from the still-active release approval after re-verifying the exact repositories and OIDs.

Automatic Entire session pushes to `origin` remain disabled. The approved control-ref transport publishes `refs/heads/entire/checkpoints/v1` with the review and validation refs only to a separately configured private GitHub repository. Planning and execution reject `origin`, reject repository aliases, and recheck private visibility immediately before publication.

Release planning is local and credentialed-read-only: it requires clean merged `main`, runs exact-head commands from the platform-configured manifest, binds checkpoint evidence to the exact pre-merge pull-request head, requires durable proof that that head reached `ready`, rejects new terminal feedback or failed checks, binds the effective fetch and push targets for both GitHub remotes, and snapshots the resulting control OIDs. Remote publication requires a separate release approval capped at one hour. Execution re-verifies case-normalized code identity plus control identity and privacy before every write, writes an atomic local receipt before each phase, and reruns idempotent reconciliation for control refs, exact annotated-tag objects, and releases after failures or prior success. Pull-request merge remains a separate explicit action because an approval cannot safely bind a squash commit that does not exist yet.

## Production Checklist

- Back up the private GitHub control repository and test restore drills.
- Isolate validation workers for untrusted code; detached worktrees are not sandboxes.
- Scope code-storage and private-control GitHub credentials per repository and keep them out of URLs, arguments, and logs.
- Monitor failed receipts, stale cross-host locks, validation duration, queue depth, and ref divergence.
- Reconcile and republish control refs before retrying any divergence failure.
