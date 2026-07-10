# Agentic Tooling Stack

Tabellio now owns the minimum Git substrate agents need. It uses standard Git rather than requiring a proprietary code-storage API. A forge can still store repositories and host review.

The main idea: agentic Git should be built around more than a patch. It should preserve the work request, the reason for the change, the runtime that produced it, the commands that ran, the checkpoints that explain it, and the side effects that require approval.

## Layer Map

| Layer | Tooling | Role In The Workflow | Tabellio Boundary |
| --- | --- | --- | --- |
| Work request | Issue, ticket, chat request, or manual prompt | Defines why the change exists | Captured as `taskSource` |
| Coding runtime | [OpenAI Codex](https://openai.com/codex/) or another coding agent | Produces the branch, diff, and validation attempts | Captured as `actor`, `agentRuntime`, and `commandsRun` |
| Git substrate | Standard Git CLI, bare repositories, and worktrees | Stores repositories, branches, commits, patches, and agent-created code state | Implemented by `NativeGitStore` |
| Checkpoint ledger | [Entire Checkpoints](https://entire.io/) and [Entire CLI](https://github.com/entireio/cli) | Links commits to agent sessions, prompts, transcript context, token usage, and attribution | Required default through `EntireLedgerProvider`; metadata normalized as `tabellio-ledger/v0.1` |
| Evidence gate | Tabellio | Writes and validates the PR evidence envelope and external-action policy | Core product surface |
| Stacked review | [git-spice](https://abhinav.github.io/git-spice/) | Keeps dependent change requests small, ordered, reviewable, and resubmittable across Forgejo, Gitea, GitLab, Bitbucket, or GitHub | Read through `GitSpiceStackManager` into `tabellio-stack/v0.1` |
| Forge and CI | Forgejo, Gitea, GitLab, Bitbucket, GitHub, or another Git remote | Optionally hosts review, checks, artifacts, and merge state | Read-only Forgejo API adapter implemented; not required by native core |
| Repo hygiene | [OpenSSF Scorecard](https://securityscorecards.dev/), [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html), and static checks | Adds public health and automated review signals | Recorded as checks or artifacts |

## Tool Tags

| Tool | Tag | Why It Matters |
| --- | --- | --- |
| [Entire](https://entire.io/) | `entire` | Checkpoint and session ledger for agent-assisted work, with checkpoint metadata stored in Git |
| [git-spice](https://abhinav.github.io/git-spice/) | `git-spice` | Offline-first stacked branch and change-request workflow with forge-specific adapters |
| [OpenAI Codex](https://openai.com/codex/) | `codex` | Coding and review agent used to produce or inspect changes |

Entire is required by default for context capture. Legacy Git-note capture remains an explicit migration mode. All ledger reads stay local through the installed Entire CLI.

## Control-Plane Shape

```text
task source
  -> coding agent run
  -> isolated Git worktree
  -> commits and Entire checkpoints
  -> immutable context packet
  -> read-only merge preview
  -> evidence envelope
  -> optional forge review and checks
  -> explicit compare-and-swap merge or release gate
```

The product opportunity is the control plane tying those objects together:

- `AgentRun`: who or what produced the change
- `Checkpoint`: where the session and reasoning context live
- `ChangeSet`: what files and commits changed
- `PatchStack`: how dependent PRs relate
- `EvidenceEnvelope`: what was validated
- `ReviewThread`: what humans or agents asked to fix
- `MergeGate`: what must pass before merge
- `ReleaseIntent`: what protected side effects require approval

## Current Unreleased Scope

Included:

- local agent-run lifecycle and state machine
- explicit fast-forward compare-and-swap promotion
- native Git repository provider
- contained per-run worktrees
- Entire checkpoint metadata ingestion
- legacy Git-note checkpoint reading
- deterministic merge preview
- compare-and-swap ref updates
- integrity-protected context packet
- GitHub Actions evidence workflow
- evidence JSON envelope
- default-deny external-action policy
- local writer and validators
- PR template and docs
- OpenSSF Scorecard signal
- disposable Forgejo 15.0.3 lab bound to localhost
- read-only Forgejo provider for repositories, pull requests, reviews, comments, and commit statuses
- approval-gated git-spice submit, update, sync, and merge operations with one-use receipts

Not included yet:

- production Forgejo deployment or remote repository transport
- transcript indexing or storage outside Entire
- general review-thread mutation and signed approvals
- Codex review automation
- signed evidence
- formal SLSA or in-toto compliance

## Future Integration Points

| Integration | Evidence Field |
| --- | --- |
| Forge repository or branch id | adapter metadata outside the provider-neutral core |
| Entire checkpoint id | `tabellio-ledger/v0.1` and context `checkpoints[]` |
| git-spice branch parent or change-request id | `tabellio-stack/v0.1` snapshot |
| Codex review result | `checks[]` and `artifacts[]` |
| Plane or ticket system item | `taskSource.url` |

## git-spice Boundary

Tabellio invokes the installed `git-spice` executable with prompts and remote status lookups disabled. It consumes documented JSON output from `git-spice log short --json`, normalizes that output, and excludes local worktree paths.

Tabellio does not read or modify git-spice's internal `refs/spice/data` layout. Read-only snapshots and approval-gated write operations use separate adapters. Submit, update, sync, and merge require an integrity-bound intent plus a short-lived, one-use approval receipt.

git-spice is GPL-3.0-or-later and is not bundled or linked into the Apache-2.0 Tabellio package. Operators install the separate executable. Modifications or redistribution of git-spice must follow its license.

## Entire Boundary

Tabellio calls `entire checkpoint explain --json` and stores normalized metadata only. Transcript bytes never enter context or ledger snapshots. Missing checkpoints fail default context capture; `--ledger git-note` exists only for migration.

Entire remains the source of truth for transcripts, rewind, and resume. Tabellio stores checkpoint IDs, commit bindings, summaries, token totals, and integrity digests for orchestration and review.

This repository disables automatic checkpoint pushes until a private Forgejo destination exists. Commit trailers remain shareable; transcript-bearing checkpoint data stays local during migration.

## Forgejo Boundary

`ForgejoProvider` reads the documented Forgejo v1 API. It normalizes repository identity, pull requests, reviews, inline comments, issue comments, and commit status without exposing the access token. The CLI accepts tokens only through a file or environment variable; URLs containing credentials are rejected.

The disposable lab pins Forgejo 15.0.3, binds HTTP and SSH to localhost, disables registration and Actions, and stores all state below ignored `.tabellio/forgejo/`. The lab proves API compatibility; it is not production infrastructure. Write and merge operations remain a later approval-gated adapter slice.
