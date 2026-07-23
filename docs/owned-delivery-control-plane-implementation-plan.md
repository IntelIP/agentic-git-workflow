# Owned Delivery Control Plane Implementation Plan

## Principal Brief

- Outcome: private analytics and change-request MVP with outage-tolerant local operation and approved native squash publication.
- Acceptance source: this plan, `docs/owned-delivery-control-plane-system-design.md`, `docs/analytics-data-model.md`, existing Tabellio schemas, and Plane work items.
- Invariants: exact commits, immutable source evidence, unknown-not-zero semantics, no force push, no stale-base bypass, no secret/transcript leakage.
- Risk: high for native merge and branch-policy migration; medium for analytics and local UI.
- External authority: no branch-policy, merge, release, deployment, infrastructure, billing, DNS, or paid action without separate approval.
- Stop conditions: missing exact-head proof, incomplete required cost telemetry, source-schema drift, unsafe publisher scope, stale base, conflict, or failed sandbox recovery.
- Integration owner: primary Tabellio task owns contract reconciliation and exact-head validation.

## Existing Plane Authority

| Work item | State | Role |
| --- | --- | --- |
| `INTB-258` | Backlog | Core v1 qualification epic |
| `INTB-259` | Completed | IntelIP WIP reconciliation |
| `INTB-260` | Completed | Release truth and v0.5.0 qualification |
| `INTB-261` | Backlog | Cross-repository analytics baseline |
| `INTB-262` | Backlog | Read-only frontend prototype and decision |

## Sprint Schedule

| Sprint | Dates | Milestone |
| --- | --- | --- |
| Planning closeout | 2026-07-23 to 2026-07-26 | Contracts and Plane successor work |
| Sprint 1 | 2026-07-27 to 2026-08-09 | Analytics dataset and deterministic report |
| Sprint 2 | 2026-08-10 to 2026-08-23 | Local dashboard and owned change-request shell |
| Sprint 3 | 2026-08-24 to 2026-09-06 | Exact candidate and shadow native merge |
| Sprint 4 | 2026-09-07 to 2026-09-20 | Sandbox direct merge and recovery |
| Sprint 5 | 2026-09-21 to 2026-10-04 | Tabellio dogfood and readiness decision |
| Contingency | 2026-10-05 to 2026-10-18 | External policy/security blockers only |

## Tasks

| Task | Type | Owner | Isolation | Outcome | Blocked By | Acceptance | Forbidden Outcomes | Required Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Analytics storage prototype | Prototype | analytics storage | Temporary worktree | Select SQLite driver and package boundary | Approved data model | Node 20+, rebuild, transaction, packaging proof | Adding dependency to core commands | Benchmark report, package dry-run, security review |
| Delivery identity contract | Implementation | analytics contracts | Dedicated branch/worktree | Stable `DeliveryChange` and external-link schemas | System design | Multi-task and optional-PR fixtures validate | GitHub PR as required identity | Schema, unit, semantic evidence |
| Provenance and migrations | Implementation | analytics store | Dedicated branch/worktree | SQLite schema, migrations, rebuild | Storage prototype, identity contract | Idempotent import and deterministic rebuild | Source evidence mutation | Schema, workflow, security evidence |
| Local collectors | Implementation | local ingestion | Dedicated branch/worktree | Git, Tabellio ref, Entire, receipt collectors | Provenance contract | Incremental cursors and duplicate replay pass | Transcript/source-content duplication | Workflow and security evidence |
| Remote collectors | Implementation | provider ingestion | Dedicated branch/worktree | Plane, GitHub, Actions collectors | Provenance contract | Timeout, rate-limit, partial-data tests pass | Provider failure blocking local ingestion | Workflow, operational, cost evidence |
| Projection engine | Implementation | analytics metrics | Dedicated branch/worktree | Versioned delivery metrics and completeness | Collectors, metric definitions | Golden dataset produces stable digest | Unknown converted to zero; causal claims | Semantic, workflow, cost evidence |
| Baseline report | Manual/implementation | analytics baseline | Dedicated branch/worktree | Cross-repository report for 3–5 repos | Projection engine | Human-reviewed correlations and provenance | Agent leaderboard or LOC scoring | Report artifact, source digest, review |
| Query API | Implementation | local service | Dedicated branch/worktree | Localhost read API and durable jobs | Store and projections | Contract, pagination, job recovery pass | Public listener or embedded provider token | Schema, workflow, security evidence |
| Analytics UI prototype | Prototype | operator UI | Dedicated branch/worktree | Repository, change, repair, validation, wait views | Query API | Rendered desktop/mobile proof and useful decision test | UI-owned metric formulas | Visual, accessibility, semantic evidence |
| ChangeRequest v0.1 | Implementation | change-request contracts | Dedicated branch/worktree | Provider-neutral lifecycle and links | Delivery identity | Local change request works with no PR | GitHub-only required fields | Schema, semantic, workflow evidence |
| Review shell | Implementation | review UI/service | Dedicated branch/worktree | Diff timeline, findings, repairs, stale anchors | ChangeRequest contract | Commit-bound comment and restack tests | Silent line-anchor remap | Workflow, visual, security evidence |
| Candidate builder | Implementation | native merge core | Dedicated branch/worktree | Exact squash candidate `C` from `B`, `H`, `T` | ChangeRequest contract | Conflict/stale/metadata fixtures pass | Ref mutation or force push | Static, schema, semantic, security evidence |
| Native merge intent | Implementation | merge contracts | Dedicated branch/worktree | Integrity-bound plan, approval, receipt | Candidate builder | Tamper, expiry, reuse, stale base reject | Agent self-approval | Schema, workflow, security evidence |
| Shadow merge | Implementation | merge evaluator | Dedicated branch/worktree | Candidate comparison without remote mutation | Merge intent, exact validation | GitHub comparison and crash recovery pass | Updating `main` | Workflow, operational evidence |
| Publication outbox | Implementation | publication coordinator | Dedicated branch/worktree | Durable staging/status/main phases | Shadow merge | Idempotent retry and partial recovery | Unreceipted remote mutation | Workflow, operational, security evidence |
| Publisher identity research | Research/manual | GitHub integration | No implementation branch | Minimum GitHub App/token scope and protection design | Shadow merge | Human-approved permission matrix | Creating app or changing policy | Primary-source report and decision |
| Sandbox publisher | Implementation | GitHub publisher | Dedicated sandbox repo/worktree | Candidate ref, merge-ready status, fast-forward main | Publisher decision, outbox | Direct sandbox merge and rollback pass | Force push, admin bypass without policy | Operational, security, exact-candidate evidence |
| Tabellio dogfood | Manual/implementation | integration owner | Dedicated branch/worktree | First real PR-less Tabellio merge | Sandbox acceptance and separate approval | Remote exact commit, receipt, analytics, recovery | Protection change before approval | Full exact-head validation, fresh review, rollback proof |

## Dependency Graph

```text
storage prototype
  -> delivery identity
      -> provenance and migrations
          -> local collectors
          -> remote collectors
              -> projection engine
                  -> baseline report
                  -> query API
                      -> analytics UI

delivery identity
  -> ChangeRequest v0.1
      -> review shell
      -> candidate builder
          -> native merge intent
              -> shadow merge
                  -> publication outbox
                  -> publisher identity decision
                      -> sandbox publisher
                          -> Tabellio dogfood
```

## Parallelization

- Local and remote collectors may run independently after provenance contracts land.
- Baseline-report preparation and query API may run independently after projections stabilize.
- Review shell and candidate builder may run independently after `ChangeRequest v0.1`.
- Publisher research may begin during shadow implementation but cannot authorize or mutate provider state.
- One integrator owns schema reconciliation, migration order, exact-head validation, and final candidate selection.

## Planned Files

Potential surfaces; exact paths remain implementation-ticket decisions:

- `schemas/delivery-change.v0.1.schema.json`
- `schemas/change-request.v0.1.schema.json`
- `schemas/native-merge-operation.v0.1.schema.json`
- `schemas/native-merge-approval.v0.1.schema.json`
- `schemas/native-merge-receipt.v0.1.schema.json`
- `scripts/lib/analytics-store.mjs`
- `scripts/lib/analytics-ingestion.mjs`
- `scripts/lib/analytics-projections.mjs`
- `scripts/lib/change-request.mjs`
- `scripts/lib/native-merge.mjs`
- `scripts/lib/publication-outbox.mjs`
- `scripts/providers/github-publisher.mjs`
- `scripts/tabellio-analytics.mjs`
- `scripts/tabellio-change-request.mjs`
- `scripts/tabellio-native-merge.mjs`
- `tests/analytics-*.test.mjs`
- `tests/change-request*.test.mjs`
- `tests/native-merge*.test.mjs`

UI location is not fixed until frontend prototype decision.

## Tests

- Schema positive, negative, bounds, unknown-field, and compatibility fixtures.
- Import replay, cursor atomicity, migration rollback, full rebuild, and digest stability.
- Multi-task/one-change, one-task/multi-change, optional PR, and missing-source identity cases.
- Overlapping run interval union and provider-wait separation.
- Missing token/cost evidence remains unknown.
- GitHub/Plane timeouts, rate limits, malformed payloads, and partial results.
- Job crash, stale heartbeat, cancellation, and idempotent recovery.
- Conflict, stale base, concurrent merge, candidate tampering, approval expiry/reuse, and dirty worktree.
- Partial publication after candidate ref, status, or main update.
- Sandbox rollback and recovery.
- UI desktop/mobile, empty, partial, blocked, loading, and error states.

## Quality Gates

- Acceptance outcomes, invariants, forbidden outcomes, risk, and validator types declared before implementation review.
- Focused tests pass.
- Fallow changed-code audit introduces no findings.
- Full committed manifest runs on exact candidate.
- Required validators end `passed`; missing proof ends `blocked`.
- Cost telemetry complete for required validators.
- Fresh-context Codex review binds exact pushed head.
- Publication and merge remain explicit approval gates.

## Rollout

1. Keep GitHub PR workflow unchanged.
2. Deliver analytics store and reports.
3. Deliver read-only UI and local change requests.
4. Run native merge in shadow mode.
5. Prove publisher in sandbox.
6. Request explicit branch-policy and dogfood approval.
7. Preserve GitHub PR fallback until dogfood closeout.

## Risks

- Native SQLite packaging and Node 20 compatibility.
- Clock skew and incomplete source timestamps.
- GitHub App scope and organization-policy delays.
- Review anchor drift after restack.
- Direct-merge authority concentration.
- Analytics misuse as productivity surveillance.
- Scope growth into forge, hosting, or multi-user features.

## Publication Boundary

This plan authorizes planning artifacts and Plane work decomposition only. It does not authorize:

- branch-protection changes;
- GitHub App creation or credential changes;
- direct merge;
- PR merge;
- release or npm publication;
- deployment, infrastructure, DNS, billing, or paid work.

## Integration Owner

Primary Tabellio development task owns integration. Each implementation task returns exact branch/head, owned files, remaining dirty state, acceptance evidence, forbidden-outcome result, cost, and blockers.

## Learning Closeout

- Recurring deterministic defects become tests, schemas, or validators.
- Conditional workflow defects become repository guidance or skills.
- Product decisions stay in these design artifacts and Plane.
- One-off observations remain task evidence.
