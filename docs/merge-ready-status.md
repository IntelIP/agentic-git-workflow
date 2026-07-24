# Merge-Ready Status

Tabellio can publish one exact-candidate GitHub commit status without using GitHub Actions as the validation runtime.

The flow has three separate authorities:

1. `tabellio-validate gate` runs the committed manifest on a trusted worker and writes exact-head evidence to `refs/tabellio/validations`.
2. `tabellio-merge-ready plan` reads the newest matching validation and creates an integrity-bound status intent. Planning performs no network write.
3. `tabellio-merge-ready execute` requires a separate, active approval plus a scoped GitHub credential before it publishes `Tabellio / merge-ready`.

GitHub Actions, a self-hosted service, Buildkite, a local coordinator, or a Codex PR workflow may invoke these commands. The scheduler supplies capacity. Tabellio owns the exact-candidate decision.

Codex/Entire validation tasks must start inside the target repository or worktree so Entire can link the candidate commit to truthful session provenance.

## Validate

```bash
tabellio-validate gate \
  --repo . \
  --repo-id github.com/OWNER/REPOSITORY \
  --base main \
  --commit HEAD \
  --manifest tabellio.validation.json \
  --runner-id local-worker
```

Only a result stored under the exact commit, repository identity, and manifest path can be planned for publication.

## Plan

```bash
tabellio-merge-ready plan \
  --repo . \
  --repo-id github.com/OWNER/REPOSITORY \
  --commit HEAD \
  --manifest tabellio.validation.json \
  --out /secure/operator/status-intent.json
```

The intent fixes:

- repository owner and name;
- exact commit;
- validation run and integrity digest;
- validation completion time and manifest digest;
- the sole status context `Tabellio / merge-ready`;
- the status state derived from `passed`, `failed`, or `blocked`.

Callers cannot turn a failed or blocked validation into `success`.

## Approve

Approval is a separate JSON artifact:

```json
{
  "schemaVersion": "tabellio-merge-ready-status-approval/v0.1",
  "id": "status-20260724-001",
  "intentDigest": "INTENT_SHA256",
  "approved": true,
  "approvedBy": "Hudson Aikins",
  "approvedAt": "2026-07-24T12:00:00.000Z",
  "expiresAt": "2026-07-24T13:00:00.000Z",
  "reason": "Publish the exact validation decision for this candidate."
}
```

Approval lifetime cannot exceed one hour. Approval predating the intent, expired approval, digest mismatch, reuse, and repository or validation drift fail closed.

## Execute

```bash
tabellio-merge-ready execute \
  --repo . \
  --intent /secure/operator/status-intent.json \
  --approval /secure/operator/status-approval.json \
  --token-file /secure/operator/github-status-token
```

`GITHUB_TOKEN` may replace `--token-file`. Do not put a token in command arguments, intent, approval, manifest, logs, or repository files.

Execution re-reads the validation ledger, resolves the exact commit, verifies repository identity, consumes the approval once, publishes the commit status, and writes a durable receipt under Git common state. HTTP failures redact the credential and remain `failed`.

## Security Boundary

- This command publishes a GitHub commit status. It does not push code, merge, release, deploy, modify branch protection, or change billing.
- Use a dedicated GitHub App installation token or other credential limited to commit-status publication for the target repositories.
- The publisher sends that credential only to `https://api.github.com`. `--api-url` and `GITHUB_API_URL` accept HTTP or HTTPS loopback URLs only for injected local tests; GitHub Enterprise Server and other remote API hosts are unsupported until repository identity and policy represent them.
- Do not run untrusted repository validation on a persistent machine containing credentials. Use an ephemeral VM, container, or sandbox.
- Branch protection migration remains a separate human decision after sandbox proof.

## PR Workflow Integration

The PR workflow can replace hosted validation coordination with:

```text
validate exact head
  -> inspect passed/failed/blocked evidence
  -> plan fixed merge-ready status
  -> obtain short-lived human approval
  -> publish status
  -> continue review and merge-readiness checks
```

Automatic triggering still requires a scheduler or worker process. This CLI provides the portable validation-to-status contract; it is not an always-running daemon.
