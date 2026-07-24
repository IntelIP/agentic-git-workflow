# Owned Delivery Control Plane System Design

## Status

- Decision status: approved for durable planning and Plane story creation.
- Implementation status: not started.
- Publication status: no branch-protection, merge, deployment, or paid-work authority granted.
- Target MVP completion: 2026-10-04.
- Guarded completion window: 2026-10-18 when external GitHub policy or publisher-identity coordination blocks rollout.

## Problem

Tabellio preserves exact commits, agent checkpoints, review state, validation evidence, approvals, and release receipts, but delivery information remains spread across local Git repositories, private control refs, Entire, Plane, GitHub, and GitHub Actions. GitHub also owns the current pull-request shell and hosted quality checks. A GitHub incident therefore blocks coordination and publication while obscuring whether elapsed delivery time came from agent work, repair, validation, human approval, or provider wait.

## Destination

Build a private, single-operator delivery control plane for the current Codex workflow:

1. Treat a `DeliveryChange` as the primary analytics unit.
2. Associate one Plane story and one or more Codex tasks, runs, checkpoints, commits, validations, reviews, repairs, approvals, publications, and releases with that change.
3. Keep GitHub as canonical code, tag, and release storage.
4. Make Tabellio authoritative for change-request state, review readiness, exact-candidate validation, analytics, merge intent, and publication queueing.
5. Continue local coding, checkpointing, review, validation, and analytics during GitHub incidents.
6. Publish an approved squash candidate directly to protected `main` without requiring a GitHub pull request.

## Users And Workflow

### Primary user

One operator developing across multiple repositories with multiple Codex tasks on one primary machine. GitHub Actions remains an optional remote evidence source, not the only validation worker.

### Target workflow

```text
Plane story
  -> Codex tasks and agent runs
  -> local Git commits and Entire checkpoints
  -> Tabellio change request
  -> review findings and repairs
  -> exact squash candidate
  -> exact-candidate validation
  -> short-lived human merge approval
  -> queued GitHub publication
  -> protected fast-forward main update
  -> merge receipt, release evidence, and analytics
```

## Requirements

- Preserve current Git, validation, review, Entire, release, and evidence contracts.
- Keep source evidence immutable and independently verifiable.
- Derive analytics from source evidence without rewriting it.
- Mark missing evidence and cost telemetry as unknown or blocked, never zero.
- Separate agent work, validation compute, repair, provider wait, and human approval time.
- Continue useful local workflow when GitHub APIs or Actions are unavailable.
- Use an embedded, private analytics store with deterministic rebuild.
- Make ingestion idempotent and schema-version aware.
- Bind review, validation, approval, and publication to one exact candidate commit.
- Reject stale-base, conflicting, tampered, expired, or incomplete merge attempts.
- Preserve GitHub force-push and branch-deletion protections.
- Roll out direct merge through shadow mode and a sandbox before changing Tabellio branch protection.

## Non-Goals

- Replacing GitHub as Git code storage.
- Multi-tenant SaaS, enterprise authentication, billing, or hosted deployment.
- Employee or agent leaderboards.
- Lines-of-code productivity scoring.
- Full Codex transcript indexing.
- Causal productivity claims from correlation alone.
- Merge, release, branch-policy, infrastructure, or paid action without separate approval.
- General-purpose Git forge or source browser.

## Current State

### Existing contracts

| Surface | Current contract |
| --- | --- |
| Agent lifecycle | `schemas/agent-run-state.schema.json` |
| Git context | `schemas/context-packet.schema.json` |
| Checkpoints | `schemas/ledger-snapshot.schema.json` |
| Evidence | `schemas/evidence-envelope.schema.json` |
| Validation | `schemas/validation-result.v0.3.schema.json` |
| Review | `schemas/review-cycle.v0.3.schema.json` |
| Stack operation | `schemas/stack-operation.schema.json` |
| Release | `schemas/release-operation.schema.json` and receipt schema |
| Platform | `tabellio.platform.json` |

### Existing implementation

- `NativeGitStore` resolves immutable commits, creates isolated worktrees, previews merges with `git merge-tree`, and updates local refs with expected-old compare-and-swap.
- `GitJsonLedger` stores durable review and validation records on Git refs.
- `ReviewCycleManager` normalizes GitHub and agent review findings, repairs, checks, and readiness.
- `ValidationRunner` executes committed validators on exact candidates and records complete cost decisions.
- `ControlRefTransport` publishes private refs with integrity-bound approval.
- `ReleaseExecutor` uses phase receipts and re-verifies approved state before publication.
- GitHub Actions currently supplies Tests, Fallow changed-code, Package dry-run, and product-validation jobs.
- GitHub classic branch protection currently requires a pull-request review flow, conversation resolution, and three Actions checks.

## Known Facts

- GitHub code storage has no approved replacement.
- Code and public releases remain on GitHub.
- Private `control` storage is separate from `origin` but still shares GitHub availability.
- Local validation and Git-native evidence survive GitHub incidents.
- Direct merge is blocked by current branch protection until a separately approved migration.
- Current package supports Node.js 20+ and has zero runtime dependencies.
- Analytics needs embedded persistence; core validation and review commands should remain dependency-free.

## Human Decisions

- Private, single-operator MVP.
- `DeliveryChange` is primary analytics unit.
- Codex tasks are contributing execution records, not productivity wins.
- GitHub remains canonical code and publication storage.
- GitHub merge and release may wait during an outage.
- Tabellio owns the change-request shell and merge readiness.
- Native merge MVP uses squash only.
- SQLite is allowed behind an optional analytics boundary; zero-dependency core remains intact.

## Not Yet Specified

- Concrete SQLite Node driver. Resolve with a packaging and performance prototype.
- Final local web framework. Resolve after query-contract prototype.
- GitHub App versus other scoped publisher identity. Resolve before sandbox publication.
- Exact repository set for the first 3–5-repository analytics baseline.

## Options Considered

### GitHub pull requests remain authoritative

Lowest implementation effort. Fails outage-resilience and owned-analytics goals because review lifecycle and merge readiness remain provider-controlled.

### Tabellio owns change requests; GitHub receives thin mirrored pull requests

Improves local workflow and analytics. Still requires GitHub PR creation and PR-specific protection for every merge.

### Tabellio owns change requests and direct protected publication

Chosen. GitHub stores code and enforces a scoped publisher identity plus one `Tabellio / merge-ready` status. Tabellio owns the review, validation, approval, and publication receipt.

### Replace GitHub code storage

Rejected. No usable alternative exists, and building a Git forge is outside product scope.

## Chosen Design

### Architectural layers

```text
immutable source evidence
  -> idempotent collectors
  -> normalized delivery database
  -> versioned metric projections
  -> localhost query API and UI
  -> change-request review and merge services
  -> GitHub publication outbox and reconciler
```

### Source authority

| Data | Authority |
| --- | --- |
| Code and commit objects | Git |
| Work intent and agile state | Plane |
| Agent checkpoint metadata | Entire |
| Validation results | `refs/tabellio/validations` |
| Review and repair state | `refs/tabellio/reviews` |
| Change-request current projection | Local analytics/control database, rebuildable from events |
| Merge and release attempts | Integrity-bound operation receipts |
| Public branch, tag, and release state | GitHub |

### Database boundary

SQLite stores provenance, normalized delivery facts, local job state, publication outbox state, and versioned analytics projections. It never becomes the sole authority for commits, validations, reviews, approvals, or publications. Loss or corruption triggers rebuild from source evidence.

Core CLIs remain dependency-free. Analytics storage lives behind `AnalyticsStore`; driver and UI dependencies remain optional and isolated.

### Change-request boundary

`ChangeRequest v0.1` identifies repository, base, head, stack position, delivery change, current state, reviews, checks, exact candidate, and publication state without requiring a GitHub PR number. GitHub identifiers appear only as external links.

### Native squash candidate

Given immutable base `B` and change head `H`:

1. Resolve and verify `B` and `H`.
2. Compute merge base and merged tree `T` with `git merge-tree`.
3. Reject conflicts or unexpected ancestry.
4. Create candidate commit `C` with tree `T`, one parent `B`, and approved canonical metadata.
5. Store `C` under a local Tabellio candidate ref.
6. Validate exact `C` while binding checkpoint evidence to `B..H`.
7. Bind review readiness and merge intent to `B`, `H`, `T`, and `C`.

### Native publication

1. Revalidate short-lived approval and operation intent.
2. Fetch live `origin/main`.
3. Require live `main == B`.
4. Push `C` to a temporary GitHub candidate branch or ref.
5. Publish app-bound `Tabellio / merge-ready` status for `C`.
6. Perform an ordinary fast-forward push `C -> refs/heads/main`.
7. Verify remote `main == C`.
8. Persist a phase receipt and analytics event.
9. Queue safe staging-ref cleanup separately.

No force push or stale-base bypass is permitted. When live `main` changes, ordinary fast-forward publication fails and the candidate must be rebuilt and revalidated.

## Components

| Component | Responsibility |
| --- | --- |
| `AnalyticsStore` | SQLite abstraction, migrations, transactions, rebuild |
| Source collectors | Git, Tabellio refs, Entire, Plane, GitHub, Actions, receipts |
| Normalizer | Provider-specific input to provider-neutral domain events |
| Projection engine | Versioned metric materialization and completeness |
| Local coordinator | Durable incremental jobs, retries, heartbeats, cancellation |
| Query service | Read-only localhost resources for analytics and change requests |
| Operator UI | Repository, delivery, validation, repair, provider-wait, and WIP views |
| Change-request service | Lifecycle, external links, review state, readiness |
| Candidate builder | Exact squash candidate construction |
| Native merge planner | Integrity-bound merge intent |
| Native merge executor | Approval validation, phase execution, receipt |
| GitHub publisher | Candidate ref, status, main update, verification |
| Publication outbox | Deferred, idempotent provider mutations |
| Reconciler | Remote drift, partial publication, and recovery |

## Runtime Model

- One local coordinator process owns scheduled ingestion and projection jobs.
- Jobs persist before execution and use idempotency keys.
- Worker restart resumes pending or stale-running jobs.
- Source-specific timeouts, bounded retries, and retry-after handling apply.
- GitHub failure never blocks local collectors or projections.
- UI reads projections and job state; long ingestion returns job identifiers rather than holding requests open.
- Only native merge execution may mutate the code remote, and only after a separate approval.

## Observability

Record:

- collector start, completion, cursor, source version, row counts, and failure code;
- projection version, input digest, duration, and affected scopes;
- job queue age, retries, stale heartbeat, and cancellation;
- GitHub availability intervals and deferred-publication duration;
- candidate planning, validation, approval, publication phases, and exact commits;
- cost telemetry state, model/tool calls where supplied, and bounded artifact pointers.

Primary operator durations:

```text
cycle time
agent execution time
validation compute time
repair time
provider wait time
human approval time
```

## Failure Modes

| Failure | Required behavior |
| --- | --- |
| Missing source or secret | Collector blocked; local sources continue; completeness becomes partial |
| GitHub timeout/rate limit | Record provider interval; retain cursor; retry safely |
| Plane unavailable | Preserve last observation; mark current agile projection partial |
| SQLite write failure | Roll back transaction; source cursor does not advance |
| Worker crash | Stale heartbeat recovery; idempotent replay |
| Duplicate source record | Unique provenance key produces no duplicate fact |
| Schema drift | Store blocked ingestion result; do not guess normalization |
| Merge conflict | Candidate planning blocked |
| Stale base | Publication blocked; replan required |
| Validation missing/failed/blocked | Merge readiness blocked |
| Approval expired or reused | Execution rejected |
| Partial GitHub publication | Receipt records phase; reconciler verifies before resume |
| Client disconnect | Durable job continues; status remains queryable |

## Rollout

1. Analytics schema, collectors, deterministic report.
2. Read-only UI and provider-neutral change-request projection.
3. Candidate builder and native merge shadow mode.
4. Sandbox publisher identity, status check, and direct merge.
5. Tabellio dogfood and separately approved protection migration.

Existing GitHub PR workflow remains the compatibility fallback until dogfood acceptance passes.

## Risks

- GitHub App and organization policy may delay publisher rollout.
- Diff comment anchors may become stale after restack or candidate rebuild.
- Source clocks differ; durations require event-time and observation-time separation.
- Incomplete Codex task metadata may require Entire checkpoint fallback.
- SQLite driver packaging may conflict with Node 20 portability.
- Metric definitions may invite false causal interpretation without completeness and confidence.
- Direct-merge authority concentrates risk; publisher scope, receipt integrity, and sandbox proof are mandatory.

## Decision

Proceed with analytics and owned change-request implementation. Direct branch-policy mutation and native merge execution remain separate later approvals after shadow and sandbox evidence.
