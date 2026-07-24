# Development Analytics Metrics

## Decision Boundary

The primary unit is a delivery change, not a developer, agent, commit, or token. Repository aggregates describe system behavior only. They must not become individual productivity rankings.

## Completeness

Each repository analytics metric has one of two states:

- `measured`: the declared numerator, denominator, and sources support the value.
- `unavailable`: required evidence is absent, blocked, malformed, or has no eligible denominator.

`unavailable` always carries `null`. Missing evidence never becomes numeric zero.
The earlier design draft listed `not_applicable`, but the v0.1 portable dataset never emitted that state. Producers must migrate draft records to `unavailable` with a bounded reason before v0.1 validation. Other Tabellio contracts, including cost telemetry, retain their separately defined `not_applicable` state.

## Baseline Metrics

| Metric | Unit | Decision Use | Primary Sources |
| --- | --- | --- | --- |
| `commitCount` | count | Window context only; never delivery value | Git |
| `validationAttemptCount` | count | Validation activity | Tabellio validation ref |
| `validationPassRate` | ratio | Terminal validation outcome mix | Tabellio validation ref |
| `costTelemetryCoverage` | ratio | Whether cost claims are supportable | Validator evidence |
| `entireCheckpointCount` | count | Durable agent-work checkpoint adoption | Entire metadata ref |
| `reviewFindingCount` | count | Review workload | Tabellio review ref |
| `repairCount` | count | Review-to-repair activity | Tabellio review ref |
| `worktreeDirty` | boolean | Cleanup state at observation | Git |
| `evidenceCompleteness` | ratio | Available declared sources | All declared sources |
| `taskToPrTraceability` | ratio | Story-to-publication linkage | Plane and GitHub |
| `leadTimeHours` | hours | Work-item creation to merge | Plane and GitHub |
| `cycleTimeHours` | hours | First implementation activity to merge | Git, Plane, GitHub |
| `ciDisagreementRate` | ratio | Hosted CI versus exact validation divergence | GitHub Actions and Tabellio |
| `releaseLagHours` | hours | Merge-to-release delay | GitHub |
| `repositoryAdoption` | ratio | Native Tabellio evidence-source availability | Validation, review, Entire |

The executable definitions live in `scripts/lib/analytics.mjs` and are embedded into every dataset. Reports bind observation timestamps, exact repository heads, source versions, and source-content digests.

## Privacy

Collectors read Git metadata, validation results, review ledgers, and Entire metadata filenames. They do not read Entire transcript bodies, source file contents, credentials, environment variables, or private provider response bodies.

Local repository paths are configuration only and are excluded from portable datasets and reports.

## Provider Snapshots

Remote reads are captured outside the analytics core as sanitized `tabellio-analytics-provider-snapshot/v0.1` documents. A repository config may point to one with `providerSnapshot`.

Snapshots contain only:

- source status and provider version;
- delivery-change identifiers;
- Plane story and GitHub pull-request identifiers;
- exact head commit;
- bounded lifecycle timestamps;
- exact validation and hosted-check outcomes;
- explicit, manually reconciled, or unlinked relationship basis.

Manual reconciliation requires a bounded evidence statement. Missing Plane, GitHub, or Actions snapshots remain unavailable; the collector never invents links from similar titles.

Executable validation requires the complete canonical metric-definition set and every required repository metric. Provider-derived timing and CI comparison metrics remain unavailable unless each declared source is available. Malformed provider records block provider metrics without aborting local Git collection, and provider read failures use bounded reasons that exclude local paths.

## Storage Decision

Sprint 1 uses canonical JSON as the portable rebuild artifact. This keeps Node 20 core commands dependency-free and makes the baseline reviewable without a database runtime.

SQLite remains an optional local projection behind the Sprint 2 query-service boundary. The database may be deleted and rebuilt from source records; it never becomes code, evidence, or product authority.
