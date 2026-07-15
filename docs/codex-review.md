# Codex Review

Codex review inspects the GitHub pull-request diff and evidence, then emits `tabellio-agent-review/v0.1` for the durable review cycle. It does not replace deterministic checks.

## Local Preflight

Run review against the exact GitHub pull-request head:

```bash
CODEX_HOME=/tmp/codex-review-home codex review --base main
```

Use an isolated `CODEX_HOME` when local MCP configuration could add noise or private integrations.

Serialize actionable findings into the agent-review contract, validate them with `scripts/check-tabellio-agent-review.mjs`, then import them with `tabellio-review`. The review ledger keeps provider feedback, triage, fixes, head remapping, and validation readiness under `refs/tabellio/reviews`.

## Review Inputs

Give Codex these facts from the change request and local ledgers:

- task source
- intended behavior
- evidence artifact path
- commands run
- known skipped checks
- protected side effects requested or blocked

## Review Boundary

Codex review should flag correctness risks, missing tests, stale evidence, unsafe side effects, and unclear PR scope.

Codex review is not:

- branch protection
- dependency update automation
- deployment approval
- substitute for human ownership
- proof that agent output is secure
