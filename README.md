# Agentic Git Workflow

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/IntelIP/agentic-git-workflow/badge)](https://scorecard.dev/viewer/?uri=github.com/IntelIP/agentic-git-workflow)

Copyright 2026 IntelIP. Licensed under Apache-2.0.

Evidence-backed pull request workflow for agentic development.

Agentic Git Workflow is not a coding agent. It is a Git governance layer around coding agents, human developers, and CI. It makes agent-assisted changes easier to review by requiring structured evidence, deterministic checks, default-deny external action gates, and merge-queue-compatible pull request discipline.

## Why

AI-assisted code changes need more than a generated diff. Reviewers need to know:

- what task produced the change
- what files changed
- which commands ran
- which checks passed or failed
- whether deployment, migration, infrastructure, billing, live-money, credentialed provider, secret, or destructive actions were attempted
- what evidence artifact can be inspected later

This project packages that evidence contract as reusable docs, schemas, scripts, templates, and GitHub Actions workflow.

## What It Provides

- evidence envelope schema
- external action policy schema
- dependency-free evidence validator
- dependency-free external action checker
- dependency-free evidence writer
- reusable GitHub Actions workflow
- pull request template
- minimal fixture for local testing
- research grounding and OSS readiness docs

## Quick Start

Validate the bundled example:

```bash
node scripts/check-agentic-evidence-envelope.mjs --evidence examples/agentic-evidence/minimal-evidence.json
node scripts/check-agentic-external-actions.mjs --evidence examples/agentic-evidence/minimal-evidence.json
```

Generate evidence from the current Git state:

```bash
node scripts/write-agentic-evidence-envelope.mjs --out agentic-pr-evidence.json
node scripts/check-agentic-evidence-envelope.mjs --evidence agentic-pr-evidence.json
node scripts/check-agentic-external-actions.mjs --evidence agentic-pr-evidence.json
```

Use package scripts when available:

```bash
bun run agentic:evidence:example:check
bun run agentic:evidence:write
bun run agentic:evidence:check
bun run agentic:external-actions:check
```

## Core Model

Every agentic pull request should produce one evidence envelope:

```json
{
  "schemaVersion": "agentic-git-evidence/v0.1",
  "runId": "local-example-001",
  "repo": "example/agentic-git-workflow",
  "git": {
    "baseRef": "main",
    "headRef": "agentic/example-evidence",
    "sha": "0000000000000000000000000000000000000000"
  },
  "changedFiles": ["README.md"],
  "commandsRun": [],
  "checks": [],
  "externalActionPolicy": {
    "defaultMode": "deny",
    "actionClasses": []
  }
}
```

The full contract lives in:

- `schemas/evidence-envelope.schema.json`
- `schemas/external-action-policy.schema.json`
- `docs/evidence-schema.md`

## Default-Deny External Actions

These action classes require explicit approval before attempted execution:

- deployment
- database migration
- infrastructure change
- DNS or hosting change
- billing or live-money action
- credentialed provider read
- secret-value read
- destructive workspace action

The checker fails when an action is marked `attempted: true` without `approved: true`.

## GitHub Actions

The reusable workflow lives at:

```text
.github/workflows/agentic-evidence.yml
```

It can be run directly on pull requests or called from another workflow through `workflow_call`.

## Prior Art

This project is inspired by:

- SLSA provenance
- in-toto supply-chain step metadata
- GitHub merge queues
- Graphite stacked pull requests
- Google Tricorder-style review-time static analysis
- OpenSSF Scorecard
- Inspect AI and other repeatable eval frameworks
- OpenTelemetry-style observable runtime events

See `docs/research-grounding.md`.

## Non-Goals

- no autonomous deployment
- no replacement for human review
- no claim of SLSA compliance
- no claim of in-toto verification
- no secret access
- no provider-specific production workflow in core v0

## Status

Current state: v0.1.0 public initial release.

This package is intentionally small: schemas, scripts, workflow templates, docs, and examples. Product-specific app code and provider workflows are outside the core.
