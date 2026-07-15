# Agentic Tooling Stack

Tabellio owns the minimum Git substrate agents need. It uses standard Git rather than requiring a proprietary code-storage API. GitHub is the code store and thin pull-request shell, not the workflow control plane.

The main idea: agentic Git should be built around more than a patch. It should preserve the work request, the reason for the change, the runtime that produced it, the commands that ran, the checkpoints that explain it, and the side effects that require approval.

## Layer Map

| Layer | Tooling | Role In The Workflow | Tabellio Boundary |
| --- | --- | --- | --- |
| Work request | Issue, ticket, chat request, or manual prompt | Defines why the change exists | Captured as `taskSource` |
| Coding runtime | [OpenAI Codex](https://openai.com/codex/) or another coding agent | Produces the branch, diff, and validation attempts | Captured as `actor`, `agentRuntime`, and `commandsRun` |
| Git substrate | Standard Git CLI, bare repositories, and worktrees | Stores repositories, branches, commits, patches, and agent-created code state | Implemented by `NativeGitStore` |
| Checkpoint ledger | [Entire Checkpoints](https://entire.io/) and [Entire CLI](https://github.com/entireio/cli) | Links commits to agent sessions, prompts, transcript context, token usage, and attribution | Required default through `EntireLedgerProvider`; metadata normalized as `tabellio-ledger/v0.1` |
| Evidence gate | Tabellio | Writes and validates the change evidence envelope and external-action policy | Core product surface |
| Stacked review | [git-spice](https://abhinav.github.io/git-spice/) | Keeps dependent changes small, ordered, reviewable, and resubmittable | Read through `GitSpiceStackManager` into `tabellio-stack/v0.1` |
| Code storage | GitHub `origin` | Stores ordinary code branches and tags; provides a thin pull-request shell | No private control refs or agent transcripts |
| Validation workers | Local agents or operator-managed workers | Run committed argv manifests against exact commits | Durable results under `refs/tabellio/validations` |
| Control-ref transport | Standard Git protocol | Shares review, validation, and Entire state | Approval-gated and fast-forward-only |

## Tool Tags

| Tool | Tag | Why It Matters |
| --- | --- | --- |
| [Entire](https://entire.io/) | `entire` | Checkpoint and session ledger for agent-assisted work, with checkpoint metadata stored in Git |
| [git-spice](https://abhinav.github.io/git-spice/) | `git-spice` | Offline-first stacked branch and GitHub pull-request workflow |
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
  -> exact-commit validation result
  -> thin code pull request
  -> approved control-ref publication
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
- evidence JSON envelope
- default-deny external-action policy
- local writer and validators
- GitHub pull-request template and docs
- read-only GitHub provider for repositories, pull requests, reviews, comments, commit statuses, and check runs
- approval-gated git-spice submit, update, sync, restack, and merge operations with one-use receipts
- Git-native review ledger with GitHub feedback, agent findings, triage, fixes, and readiness state
- GitHub-bound exact-commit validation runner with durable results on `refs/tabellio/validations`
- explicit GitHub code-storage and external control-state contract
- approval-gated fast-forward transport for review, validation, and Entire refs

Not included yet:

- external control-state service selection and deployment
- transcript indexing or storage outside Entire
- GitHub comment publication, general review-thread mutation, and signed approvals
- Codex review automation
- signed evidence
- formal SLSA or in-toto compliance

## Future Integration Points

| Integration | Evidence Field |
| --- | --- |
| GitHub repository or branch id | GitHub identity bound to the context and evidence records |
| Entire checkpoint id | `tabellio-ledger/v0.1` and context `checkpoints[]` |
| git-spice branch parent or change-request id | `tabellio-stack/v0.1` snapshot |
| Codex review result | `checks[]` and `artifacts[]` |
| Plane or ticket system item | `taskSource.url` |

## git-spice Boundary

Tabellio invokes the installed `git-spice` executable with prompts and remote status lookups disabled. It consumes documented JSON output from `git-spice log short --json`, normalizes that output, and excludes local worktree paths.

Tabellio does not read or modify git-spice's internal `refs/spice/data` layout. Read-only snapshots and approval-gated write operations use separate adapters. Submit, update, sync, restack, and merge require an integrity-bound intent plus a short-lived, one-use approval receipt.

git-spice is GPL-3.0-or-later and is not bundled or linked into the Apache-2.0 Tabellio package. Operators install the separate executable. Modifications or redistribution of git-spice must follow its license.

## Entire Boundary

Tabellio calls `entire checkpoint explain --json` and stores normalized metadata only. Transcript bytes never enter context or ledger snapshots. Missing checkpoints fail default context capture; `--ledger git-note` exists only for migration.

Entire remains the source of truth for transcripts, rewind, and resume. Tabellio stores checkpoint IDs, commit bindings, summaries, token totals, and integrity digests for orchestration and review.

This repository disables automatic checkpoint pushes to `origin`. Commit trailers remain shareable; transcript-bearing checkpoint data stays local until an external control-state destination is configured.

## GitHub Code-Storage Boundary

GitHub receives ordinary code branches, tags, and the minimum pull-request metadata needed for human accountability. `refs/tabellio/reviews`, `refs/tabellio/validations`, and `refs/heads/entire/checkpoints/v1` remain external. The control-ref transport rejects `origin` even when a caller supplies it explicitly.

The boundary is contractual, not only documentary: `tabellio.platform.json`, its JSON Schema, runtime validation, and transport tests all fail closed on GitHub or publication-policy drift. See [GitHub code-storage boundary](github-code-storage-boundary.md).

## GitHub Review Adapter

`GitHubProvider` reads the versioned GitHub REST API and normalizes repository identity, pull requests, reviews, inline comments, issue comments, commit statuses, and check runs. The token stays in a file or `GITHUB_TOKEN`; credential-bearing API URLs are rejected.
