# Native Git Foundation

Tabellio's core works without a GitHub API or a proprietary code-storage service. It uses the installed Git executable, standard object storage, bare repositories, refs, notes, and worktrees.

## Architecture

```text
agent or CLI
  -> GitProcess
  -> RepositoryStore contract
  -> NativeGitStore
  -> normal or bare Git repository
       |-> contained worktrees
       |-> refs and commits
       |-> refs/notes/tabellio/context
```

## Safety Properties

- Commands use `execFile("git", args)`. No command string reaches a shell.
- Ref reads resolve to immutable commit IDs before diff or merge work.
- Each agent run gets a worktree under a configured root.
- Workspace paths outside that root are rejected.
- Merge preview uses `git merge-tree`; it does not checkout or update the target branch.
- Target ref writes use `git update-ref <ref> <new> <expected-old>`.
- A stale expected commit raises `RefConflictError` instead of overwriting concurrent work.
- Git credential prompts are disabled in automated processes.

## Repository Contract

`RepositoryStore` separates agent workflow logic from storage implementation. `NativeGitStore` implements:

| Operation | Git primitive |
| --- | --- |
| Resolve ref | `rev-parse --verify` |
| List files | `ls-tree` |
| Diff commits | `diff --name-status` |
| Create workspace | `worktree add --no-track -b` |
| Remove workspace | `worktree remove` |
| Read checkpoint | `notes show` |
| Preview merge | `merge-base` and `merge-tree --write-tree` |
| Safe ref update | `update-ref` with expected old object ID |

## Context Lifecycle

1. Resolve base and head names once to immutable commits.
2. Compute the agent changed-file set from merge-base to head.
3. Read an optional checkpoint note from `refs/notes/tabellio/context`.
4. Preview the merge without mutating a ref or worktree.
5. Write canonical `tabellio-context/v0.1` JSON with integrity digest.
6. Validate the context packet.
7. Optionally write a v0.1 evidence envelope bound to that packet.
8. Only an explicit higher-level action may update a target ref.

## Example

```bash
node scripts/capture-tabellio-context.mjs \
  --repo /srv/git/product.git \
  --repo-id company/product \
  --base refs/heads/main \
  --head refs/heads/agent/run-42 \
  --run-id run-42 \
  --task-summary "Add deterministic import validation" \
  --out tabellio-context.json

node scripts/check-tabellio-context.mjs --context tabellio-context.json

node scripts/write-tabellio-evidence-envelope.mjs \
  --context tabellio-context.json \
  --out tabellio-pr-evidence.json
```

The packet contains repository identity, not `/srv/git/product.git`. Local paths remain execution details.

## Current Boundary

The foundation manages local Git state. It does not authenticate to a remote, host repositories, open pull requests, merge a PR, deploy code, or execute protected external actions. GitHub can remain code storage and review transport without becoming Tabellio's workflow database.
