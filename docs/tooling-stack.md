# Agentic Tooling Stack

Tabellio now owns the minimum Git substrate agents need. It uses standard Git rather than requiring a proprietary code-storage API. A forge can still store repositories and host review.

The main idea: agentic Git should be built around more than a patch. It should preserve the work request, the reason for the change, the runtime that produced it, the commands that ran, the checkpoints that explain it, and the side effects that require approval.

## Layer Map

| Layer | Tooling | Role In The Workflow | Tabellio Boundary |
| --- | --- | --- | --- |
| Work request | Issue, ticket, chat request, or manual prompt | Defines why the change exists | Captured as `taskSource` |
| Coding runtime | [OpenAI Codex](https://openai.com/codex/) or another coding agent | Produces the branch, diff, and validation attempts | Captured as `actor`, `agentRuntime`, and `commandsRun` |
| Git substrate | Standard Git CLI, bare repositories, and worktrees | Stores repositories, branches, commits, patches, and agent-created code state | Implemented by `NativeGitStore` |
| Checkpoint ledger | [Entire Checkpoints](https://entire.io/) and [Entire CLI](https://github.com/entireio/cli) | Links commits to agent sessions, prompts, transcript context, token usage, and attribution | Referenced as an artifact or runtime tool, not required by core |
| Evidence gate | Tabellio | Writes and validates the PR evidence envelope and external-action policy | Core product surface |
| Stacked review | [Graphite](https://graphite.dev/) or Graphite-like stacked PR tooling | Keeps dependent PRs small, ordered, reviewable, and resubmittable | Captured through stack metadata in future versions |
| Forge and CI | GitHub or another forge | Optionally hosts review, checks, artifacts, and merge state | Adapter boundary; not required by native core |
| Repo hygiene | [OpenSSF Scorecard](https://securityscorecards.dev/), [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html), and static checks | Adds public health and automated review signals | Recorded as checks or artifacts |

## Tool Tags

| Tool | Tag | Why It Matters |
| --- | --- | --- |
| [Entire](https://entire.io/) | `entire` | Checkpoint and session ledger for agent-assisted work, with checkpoint metadata stored in Git |
| [Graphite](https://graphite.dev/) | `graphite` | Stacked PR and code review workflow for keeping agent-produced changes reviewable |
| [OpenAI Codex](https://openai.com/codex/) | `codex` | Coding and review agent used to produce or inspect changes |

These tools remain optional. Native context capture calls only local Node.js and Git processes.

## Control-Plane Shape

```text
task source
  -> coding agent run
  -> isolated Git worktree
  -> commits and Git-note checkpoints
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
- Git-note checkpoint reading
- deterministic merge preview
- compare-and-swap ref updates
- integrity-protected context packet
- GitHub Actions evidence workflow
- evidence JSON envelope
- default-deny external-action policy
- local writer and validators
- PR template and docs
- OpenSSF Scorecard signal

Not included yet:

- remote repository transport or hosting service
- Entire checkpoint ingestion
- Graphite stack metadata ingestion
- Codex review automation
- signed evidence
- formal SLSA or in-toto compliance

## Future Integration Points

| Integration | Evidence Field |
| --- | --- |
| Forge repository or branch id | adapter metadata outside the provider-neutral core |
| Entire checkpoint id | `artifacts[]`, future `checkpoints[]` |
| Graphite stack id or parent PR | future `stack` metadata |
| Codex review result | `checks[]` and `artifacts[]` |
| Plane or ticket system item | `taskSource.url` |
