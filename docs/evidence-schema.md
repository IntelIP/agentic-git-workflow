# Evidence Schema

The evidence envelope is the core Evident contract.

Schema files:

- `schemas/evidence-envelope.schema.json`
- `schemas/external-action-policy.schema.json`

## Required Envelope Fields

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Contract version. Current value: `evident-evidence/v0.1` |
| `runId` | Unique evidence run id |
| `repo` | Repository name |
| `git` | Base ref, head ref, SHA, optional PR metadata |
| `actor` | Human, agent, CI, or system identity |
| `agentRuntime` | Runtime/tooling metadata |
| `taskSource` | Why work started |
| `changedFiles` | Files changed by the PR or local run |
| `commandsRun` | Commands executed and their statuses |
| `checks` | Higher-level validation results |
| `approvals` | Approval status by action class |
| `externalActionPolicy` | Default-deny side-effect policy |
| `artifacts` | Evidence artifacts produced by the run |
| `createdAt` | Creation timestamp |

## Minimal Valid Fixture

The smallest maintained valid fixture lives at `examples/evident-evidence/minimal-evidence.json`.

Use that fixture instead of copying a shortened shape: the validators require at least one command, one check, and the complete default-deny action-class set.

## Status Values

| Field | Allowed Values |
| --- | --- |
| `commandsRun[].status` | `passed`, `failed`, `skipped` |
| `checks[].status` | `passed`, `failed`, `skipped`, `pending` |
| `approvals[].status` | `not_required`, `required`, `approved`, `denied` |

Failed and skipped checks should stay visible. A failing evidence packet is better than a missing one.

## External Action Policy

`externalActionPolicy.defaultMode` must be `deny` or `default-deny`.

Required action classes:

- `deployment`
- `database-migration`
- `infrastructure-change`
- `dns-or-hosting-change`
- `billing-or-live-money`
- `credentialed-provider-read`
- `secret-value-read`
- `destructive-workspace-action`

Each action class requires:

| Field | Rule |
| --- | --- |
| `requiresExplicitApproval` | Must be `true` |
| `approved` | Boolean approval state |
| `attempted` | Boolean execution-attempt state |
| `expectedSideEffects` | Array |
| `forbiddenSideEffects` | Non-empty array |
| `verificationCommand` | Non-empty string |

The checker fails when `attempted: true` and `approved !== true`.

## Validation Commands

```bash
node scripts/check-evident-evidence-envelope.mjs --evidence evident-pr-evidence.json
node scripts/check-evident-external-actions.mjs --evidence evident-pr-evidence.json
```

Generate and validate:

```bash
node scripts/write-evident-evidence-envelope.mjs --out evident-pr-evidence.json
node scripts/check-evident-evidence-envelope.mjs --evidence evident-pr-evidence.json
node scripts/check-evident-external-actions.mjs --evidence evident-pr-evidence.json
```

## Boundary

This schema is simpler than SLSA provenance or in-toto link metadata. Future versions can export to those formats, but v0.1.0 does not claim compliance.
