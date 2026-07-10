# Evidence Schema

The evidence envelope is the core Tabellio contract.

Schema files:

- `schemas/evidence-envelope.schema.json`
- `schemas/external-action-policy.schema.json`
- `schemas/context-packet.schema.json`
- `schemas/agent-run-state.schema.json`

## Required Envelope Fields

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Contract version. Current value: `tabellio-evidence/v0.1` |
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

When evidence is written with `--context`, it also carries an optional `context` binding. That binding pins the evidence to the context digest and its base, head, and merge-base commits. Old `tabellio-evidence/v0.1` envelopes remain valid without it.

## Context Packet

`tabellio-context/v0.1` records:

- repository identity without a local filesystem path
- actor and task summary
- named base, head, and merge-base refs with immutable commit IDs
- changed file status and paths
- Git-note checkpoint digests and allowlisted summaries
- read-only merge result and conflict paths
- SHA-256 integrity over canonical JSON without the `integrity` field

The evidence envelope's self artifact uses `canonical-json-without-this-artifact-sha256`. This avoids a circular file hash while making tampering detectable. Normal artifacts use `file-bytes`.

## Minimal Valid Fixture

The smallest maintained valid fixture lives at `examples/tabellio-evidence/minimal-evidence.json`.

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

This policy validates declared intent and results. It does not monitor operating-system calls or prove that an undeclared provider action never happened. Runtime sandboxing and credential isolation remain separate controls.

## Validation Commands

```bash
node scripts/check-tabellio-evidence-envelope.mjs --evidence tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence tabellio-pr-evidence.json
node scripts/check-tabellio-context.mjs --context tabellio-context.json
node scripts/check-tabellio-run.mjs --state examples/tabellio-run/minimal-run.json
```

Generate and validate:

```bash
node scripts/write-tabellio-evidence-envelope.mjs --out tabellio-pr-evidence.json
node scripts/check-tabellio-evidence-envelope.mjs --evidence tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence tabellio-pr-evidence.json
```

Bind evidence to native Git context:

```bash
node scripts/write-tabellio-evidence-envelope.mjs \
  --context tabellio-context.json \
  --out tabellio-pr-evidence.json
```

## Boundary

This schema is simpler than SLSA provenance or in-toto link metadata. Future versions can export to those formats, but v0.1.0 does not claim compliance.
