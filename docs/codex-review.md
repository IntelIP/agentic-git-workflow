# Codex Review

Codex review is an optional review layer for Tabellio pull requests. It should inspect the diff and the evidence packet, not replace deterministic checks.

## Local Preflight

Run local review before requesting a cloud review:

```bash
CODEX_HOME=/tmp/codex-review-home codex review --base main
```

Use an isolated `CODEX_HOME` when local MCP configuration could add noise or private integrations.

## Cloud Review

After the PR is open and checks are current, request review in the pull request:

```text
@codex review
```

Cloud review requires the GitHub connector to be configured for the account and organization.

## Review Inputs

Give Codex these facts in the PR body or comments:

- task source
- intended behavior
- evidence artifact path
- commands run
- known skipped checks
- protected side effects requested or blocked

## Review Boundary

Codex review should flag correctness risks, missing tests, stale evidence, unsafe side effects, and unclear PR scope.

Codex review should not be treated as:

- branch protection
- dependency update automation
- deployment approval
- substitute for human ownership
- proof that agent output is secure
