# Analytics And Change-Request API Contract

## Boundary

Localhost, single-operator, read-mostly API. No public network listener, multi-user auth, or remote mutation authority in MVP. Long-running collection and rebuild work uses durable jobs.

Version prefix:

```text
/api/v1
```

## Resources

### Repositories

```text
GET /api/v1/repositories
GET /api/v1/repositories/{repositoryId}
GET /api/v1/repositories/{repositoryId}/metrics
GET /api/v1/repositories/{repositoryId}/changes
```

### Delivery changes

```text
GET /api/v1/changes
GET /api/v1/changes/{changeId}
GET /api/v1/changes/{changeId}/timeline
GET /api/v1/changes/{changeId}/metrics
GET /api/v1/changes/{changeId}/validations
GET /api/v1/changes/{changeId}/reviews
```

### Change requests

```text
POST /api/v1/change-requests
GET  /api/v1/change-requests
GET  /api/v1/change-requests/{changeRequestId}
POST /api/v1/change-requests/{changeRequestId}/reviews
POST /api/v1/change-requests/{changeRequestId}/merge-plans
```

Mutation endpoints create local control records only. They never push GitHub state.

### Jobs

```text
POST /api/v1/jobs/collect
POST /api/v1/jobs/rebuild
GET  /api/v1/jobs/{jobId}
POST /api/v1/jobs/{jobId}/cancel
```

Collection and rebuild return `202 Accepted`.

### Provider state

```text
GET /api/v1/providers
GET /api/v1/providers/{providerId}/intervals
GET /api/v1/publication-outbox
```

### Merge intents

```text
GET  /api/v1/merge-intents/{intentId}
POST /api/v1/change-requests/{changeRequestId}/merge-plans
```

MVP API does not execute merges. Approved merge execution remains a separate CLI/operation boundary.

## Request Models

### Create change request

```json
{
  "repositoryId": "github.com/IntelIP/Tabellio",
  "title": "Add deterministic analytics ingestion",
  "baseRef": "refs/heads/main",
  "headRef": "refs/heads/codex/analytics-ingestion",
  "taskLinks": [
    {
      "system": "plane",
      "objectType": "work-item",
      "externalId": "INTB-261"
    }
  ]
}
```

### Create review record

```json
{
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "summary": "Exact candidate review",
  "findings": [
    {
      "severity": "P2",
      "path": "scripts/lib/example.mjs",
      "line": 42,
      "body": "Finding body remains bounded by review contract."
    }
  ]
}
```

### Plan merge

```json
{
  "method": "squash",
  "targetRef": "refs/heads/main",
  "expectedBaseCommit": "0123456789abcdef0123456789abcdef01234567"
}
```

Only `squash` is accepted in MVP.

### Start collection

```json
{
  "collectorIds": ["git", "tabellio-validation", "tabellio-review", "entire", "plane", "github", "github-actions"],
  "repositoryIds": ["github.com/IntelIP/Tabellio"]
}
```

## Response Models

### Delivery change summary

```json
{
  "id": "change-example",
  "repositoryId": "github.com/IntelIP/Tabellio",
  "state": "validating",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "headCommit": "89abcdef0123456789abcdef0123456789abcdef",
  "candidateCommit": null,
  "links": [],
  "timing": {
    "cycleTimeMs": null,
    "agentExecutionMs": 120000,
    "validationMs": 45000,
    "repairMs": 0,
    "providerWaitMs": 30000,
    "humanApprovalWaitMs": 0
  },
  "completeness": "partial",
  "confidence": "measured"
}
```

### Metric observation

```json
{
  "metricKey": "first-pass-validation-rate",
  "metricVersion": 1,
  "scopeType": "repository",
  "scopeId": "github.com/IntelIP/Tabellio",
  "windowStart": "2026-07-01T00:00:00Z",
  "windowEnd": "2026-08-01T00:00:00Z",
  "numericValue": 0.75,
  "unit": "ratio",
  "completeness": "complete",
  "confidence": "derived",
  "inputDigest": "sha256-value"
}
```

### Job

```json
{
  "id": "job-example",
  "type": "collect",
  "status": "running",
  "attemptCount": 1,
  "scheduledAt": "2026-07-27T12:00:00Z",
  "startedAt": "2026-07-27T12:00:01Z",
  "heartbeatAt": "2026-07-27T12:00:05Z",
  "completedAt": null,
  "error": null
}
```

## Status Lifecycle

### Jobs

```text
pending -> running -> completed
                   -> failed -> pending
                   -> cancelled
```

### Change requests

```text
draft
-> active
-> validating
-> reviewing
-> repairing
-> ready
-> publication_queued
-> merged

blocked may interrupt any non-terminal state.
abandoned is terminal.
```

### Errors

```json
{
  "error": {
    "code": "stale_base",
    "message": "Change request base no longer matches target branch.",
    "retryable": false,
    "details": {
      "expected": "0123456789abcdef0123456789abcdef01234567",
      "actual": "89abcdef0123456789abcdef0123456789abcdef"
    }
  }
}
```

Stable codes:

- `invalid_request`
- `not_found`
- `conflict`
- `stale_base`
- `source_unavailable`
- `schema_unsupported`
- `job_already_running`
- `job_cancelled`
- `validation_not_ready`
- `review_not_ready`
- `approval_required`
- `publication_blocked`

## Auth

- Bind to loopback only.
- Require a per-install local bearer secret for mutation endpoints.
- Permit optional unauthenticated read access only when explicitly configured.
- Never expose GitHub, Plane, or provider tokens through responses or logs.
- Native merge execution uses a separate short-lived approval file and publisher credential path.

## Idempotency

- Job creation accepts `Idempotency-Key`.
- Change-request creation accepts a stable repository/base/head key.
- Review import keys on source review identifier and version.
- Merge planning keys on change request, exact base, exact head, and method.
- Publication uses operation intent digest.

## Pagination

List endpoints use:

```text
?limit=50&cursor=<opaque>
```

Maximum limit: 100.

## Compatibility

- API version remains independent from source-schema versions.
- New response fields are additive within `v1`.
- Removed or retyped fields require `v2`.
- Unknown source schemas produce blocked ingestion records, not guessed response values.
- GitHub PR identifiers remain optional external links.
