# Analytics Data Model

## Design Rules

- Source evidence remains authoritative.
- Imported observations append; current projections may change.
- Unknown never equals zero.
- Event time and observation time remain separate.
- Every metric traces to immutable provenance.
- Metric formulas and completeness semantics are versioned.
- Portable records exclude local paths, credentials, transcript bodies, and source contents.
- SQLite is a rebuildable local projection, not a new code or evidence authority.

## Logical Layers

```text
source provenance
  -> normalized delivery domain
  -> versioned metric projections
```

## Provenance Tables

### `source_records`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | text primary key | Stable internal identifier |
| `source_system` | text | `git`, `tabellio-validation`, `tabellio-review`, `entire`, `plane`, `github`, `github-actions`, `receipt` |
| `source_locator` | text | Repository/ref/object namespace without credentials |
| `external_id` | text | Provider-native identifier |
| `source_version` | text | Git OID, updated timestamp, ETag, or provider version |
| `schema_version` | text nullable | Source contract version |
| `occurred_at` | timestamp nullable | When source event happened |
| `observed_at` | timestamp | When collector observed it |
| `content_digest` | text | SHA-256 of bounded canonical source representation |
| `ingest_status` | text | `accepted`, `blocked`, `superseded` |
| `error_code` | text nullable | Stable bounded reason |
| `provenance_pointer` | text | Git ref/object, provider URL, or local authority identifier |

Unique constraint:

```text
(source_system, source_locator, external_id, source_version)
```

### `ingestion_cursors`

| Field | Type |
| --- | --- |
| `collector_id` | text primary key |
| `source_locator` | text |
| `cursor_value` | text nullable |
| `last_success_at` | timestamp nullable |
| `last_attempt_at` | timestamp nullable |
| `status` | text |
| `error_code` | text nullable |

Cursor advances only in the same successful transaction as accepted source records.

### `ingestion_jobs`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `job_type` | text |
| `idempotency_key` | text unique |
| `status` | text |
| `attempt_count` | integer |
| `scheduled_at` | timestamp |
| `started_at` | timestamp nullable |
| `heartbeat_at` | timestamp nullable |
| `completed_at` | timestamp nullable |
| `error_code` | text nullable |

Lifecycle:

```text
pending -> running -> completed
                   -> failed -> pending
                   -> cancelled
```

## Identity Tables

### `repositories`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `canonical_repository_id` | text unique |
| `provider` | text |
| `default_branch` | text |
| `object_format` | text |
| `active` | integer boolean |
| `first_observed_at` | timestamp |
| `last_observed_at` | timestamp |

### `local_repository_mappings`

Local-only table. Never exported.

| Field | Type |
| --- | --- |
| `repository_id` | text primary key |
| `canonical_path` | text unique |
| `available` | integer boolean |
| `last_checked_at` | timestamp |

### `delivery_changes`

Primary analytics unit.

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `repository_id` | text foreign key |
| `title` | text |
| `state` | text |
| `base_commit` | text |
| `head_commit` | text |
| `candidate_commit` | text nullable |
| `merge_commit` | text nullable |
| `merge_method` | text nullable |
| `created_at` | timestamp |
| `work_started_at` | timestamp nullable |
| `ready_at` | timestamp nullable |
| `merged_at` | timestamp nullable |
| `released_at` | timestamp nullable |
| `closed_at` | timestamp nullable |

Lifecycle:

```text
planned
-> active
-> validating
-> reviewing
-> repairing
-> ready
-> publication_queued
-> merged
-> released

Any non-terminal state may become blocked.
Blocked returns only through a new source event.
Abandoned is terminal.
```

### `external_links`

| Field | Type |
| --- | --- |
| `delivery_change_id` | text foreign key |
| `system` | text |
| `object_type` | text |
| `external_id` | text |
| `url` | text nullable |
| `relationship` | text |

Unique constraint:

```text
(system, object_type, external_id, relationship)
```

One change may link one Plane story, zero or one GitHub PR, many Codex tasks, many Entire sessions, and many release records.

## Timeline Tables

### `change_events`

Immutable normalized timeline.

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `event_type` | text |
| `actor_type` | text |
| `actor_id` | text nullable |
| `occurred_at` | timestamp |
| `observed_at` | timestamp |
| `source_record_id` | text foreign key |
| `metadata_json` | text |

Unique constraint:

```text
(source_record_id, event_type, delivery_change_id)
```

### `execution_runs`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `runtime` | text |
| `agent` | text |
| `model` | text nullable |
| `started_at` | timestamp |
| `completed_at` | timestamp nullable |
| `status` | text |
| `input_tokens` | integer nullable |
| `output_tokens` | integer nullable |
| `cache_read_tokens` | integer nullable |
| `cost_usd` | numeric nullable |
| `cost_telemetry_complete` | integer boolean |
| `source_record_id` | text foreign key |

### `checkpoints`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `execution_run_id` | text nullable foreign key |
| `checkpoint_external_id` | text |
| `commit_oid` | text |
| `created_at` | timestamp |
| `files_touched` | integer nullable |
| `input_tokens` | integer nullable |
| `output_tokens` | integer nullable |
| `summary_digest` | text nullable |
| `source_record_id` | text foreign key |

Transcript content is excluded.

## Validation And Review Tables

### `validation_attempts`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `run_id` | text |
| `candidate_commit` | text |
| `suite_id` | text |
| `runner_id` | text |
| `status` | text |
| `started_at` | timestamp |
| `completed_at` | timestamp |
| `duration_ms` | integer |
| `total_cost_usd` | numeric |
| `cost_telemetry_complete` | integer boolean |
| `source_record_id` | text foreign key |

### `validator_results`

| Field | Type |
| --- | --- |
| `validation_attempt_id` | text foreign key |
| `validator_id` | text |
| `validator_type` | text |
| `required` | integer boolean |
| `status` | text |
| `duration_ms` | integer |
| `reason_code` | text nullable |
| `metrics_json` | text |
| `artifact_count` | integer |

Primary key:

```text
(validation_attempt_id, validator_id)
```

### `review_cycles`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `round` | integer |
| `status` | text |
| `started_at` | timestamp |
| `completed_at` | timestamp nullable |
| `finding_count` | integer |
| `actionable_count` | integer |
| `source_record_id` | text foreign key |

### `review_findings`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `review_cycle_id` | text foreign key |
| `severity` | text nullable |
| `disposition` | text |
| `resolution` | text |
| `path` | text nullable |
| `line` | integer nullable |
| `commit_oid` | text nullable |
| `created_at` | timestamp |
| `resolved_at` | timestamp nullable |
| `repair_id` | text nullable |
| `source_record_id` | text foreign key |

### `repairs`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `original_commit` | text |
| `repair_commit` | text |
| `checkpoint_id` | text |
| `started_at` | timestamp nullable |
| `published_at` | timestamp nullable |
| `validation_passed_at` | timestamp nullable |
| `source_record_id` | text foreign key |

## Wait And Publication Tables

### `provider_intervals`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text nullable foreign key |
| `provider` | text |
| `operation` | text |
| `status` | text |
| `started_at` | timestamp |
| `ended_at` | timestamp nullable |
| `reason_code` | text |
| `source_record_id` | text nullable foreign key |

### `merge_operations`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `delivery_change_id` | text foreign key |
| `intent_digest` | text unique |
| `approval_id` | text nullable |
| `base_commit` | text |
| `head_commit` | text |
| `tree_oid` | text |
| `candidate_commit` | text |
| `target_ref` | text |
| `status` | text |
| `planned_at` | timestamp |
| `approved_at` | timestamp nullable |
| `executed_at` | timestamp nullable |
| `receipt_digest` | text nullable |
| `failure_code` | text nullable |

### `publication_outbox`

| Field | Type |
| --- | --- |
| `id` | text primary key |
| `operation_type` | text |
| `idempotency_key` | text unique |
| `intent_digest` | text |
| `status` | text |
| `attempt_count` | integer |
| `next_attempt_at` | timestamp |
| `started_at` | timestamp nullable |
| `completed_at` | timestamp nullable |
| `remote_evidence_json` | text nullable |
| `error_code` | text nullable |

Lifecycle:

```text
queued -> running -> succeeded
                  -> retryable -> queued
                  -> blocked
                  -> cancelled
```

## Analytics Tables

### `metric_definitions`

| Field | Type |
| --- | --- |
| `metric_key` | text |
| `version` | integer |
| `name` | text |
| `description` | text |
| `unit` | text |
| `formula` | text |
| `required_sources_json` | text |
| `created_at` | timestamp |

Primary key:

```text
(metric_key, version)
```

### `metric_observations`

| Field | Type |
| --- | --- |
| `metric_key` | text |
| `metric_version` | integer |
| `scope_type` | text |
| `scope_id` | text |
| `window_start` | timestamp |
| `window_end` | timestamp |
| `numeric_value` | numeric nullable |
| `text_value` | text nullable |
| `completeness` | text |
| `confidence` | text |
| `computed_at` | timestamp |
| `input_digest` | text |

Completeness:

```text
complete | partial | unknown
```

Confidence:

```text
measured | derived | inferred
```

## Materialized Views

- `delivery_change_summary`
- `repository_health_daily`
- `validation_reliability_daily`
- `review_repair_daily`
- `provider_wait_daily`
- `agent_cost_daily`
- `wip_aging`
- `evidence_completeness`

UI reads these views. UI does not own metric formulas.

## Core Metric Definitions

| Metric | Formula |
| --- | --- |
| Lead time | `merged_at - Plane story created or accepted start` |
| Cycle time | `merged_at - work_started_at` |
| Agent execution | Union of overlapping execution-run intervals |
| Validation time | Sum of required validation attempt durations |
| Repair time | `repair validation passed - actionable finding created` |
| Provider wait | Union of provider-blocked intervals |
| Human approval wait | `approved_at - ready_at` |
| First-pass rate | Changes whose first required validation passed / changes with required validation |
| Repair load | Repair commits / merged delivery changes |
| Evidence completeness | Observed required source classes / required source classes |
| Effective delivery time | Cycle time - provider wait - human approval wait |

Every formula ships with an explicit version.

## Indexes

- `source_records(source_system, source_locator, observed_at)`
- `change_events(delivery_change_id, occurred_at)`
- `external_links(system, object_type, external_id)`
- `execution_runs(delivery_change_id, started_at)`
- `validation_attempts(delivery_change_id, started_at)`
- `validation_attempts(candidate_commit)`
- `review_cycles(delivery_change_id, round)`
- `review_findings(review_cycle_id, resolution)`
- `provider_intervals(provider, started_at)`
- `publication_outbox(status, next_attempt_at)`
- `metric_observations(scope_type, scope_id, metric_key, window_end)`

## Migration Notes

- Maintain a schema version table.
- Use forward-only numbered migrations.
- Back up database before migration.
- Run migrations inside transactions.
- Keep source records when projections change.
- Rebuild materialized projections after metric-definition changes.
- Supply a full rebuild command that starts from an empty database.

## Compatibility Fallbacks

- Existing GitHub PR workflow remains supported while native merge is shadowed.
- Missing Codex task metadata falls back to Entire checkpoint/run associations.
- Unavailable GitHub or Plane data preserves last observation and marks current metrics partial.
- Unknown schema versions remain blocked source records until an adapter exists.
- A broken analytics database never blocks current core validation or review commands.
