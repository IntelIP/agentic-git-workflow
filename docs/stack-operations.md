# Approved Stack Operations

Tabellio wraps git-spice writes in a two-file approval protocol. The agent plans an exact operation first. A separate approver authorizes the resulting digest. Execution fails if the repository, branch, branch head, complete local branch set, parameters, expiry, or approval digest changed.

Supported operations:

| Operation | git-spice action | Side effect |
| --- | --- | --- |
| `submit` | `branch submit` | Pushes a branch and creates a change request |
| `update` | `branch submit --update-only` | Pushes and updates an existing change request |
| `sync` | `repo sync` | Fetches remote state and may remove locally tracked merged branches |
| `restack` | `branch restack` | Rebases one tracked branch onto its current base |
| `merge` | `branch merge` | Merges one change request through the forge |

The wrapper never exposes git-spice force push, hook bypass, or stale-base bypass flags. Restack is separate from sync because a normal repository sync does not rewrite every independently stale branch.

## Plan

Create an immutable intent before any remote write:

```bash
node scripts/tabellio-stack-operation.mjs plan \
  --operation submit \
  --repo . \
  --branch agent/example \
  --title "Example change" \
  --body-file /path/to/pr-body.md \
  --draft true \
  --out /tmp/stack-intent.json
```

The intent includes the repository identity, exact branch head, digest of all local branch refs, operation parameters, creation time, and SHA-256 integrity digest.

## Approve

The approving system writes a separate receipt:

```json
{
  "schemaVersion": "tabellio-stack-approval/v0.1",
  "id": "approval-20260710-001",
  "intentDigest": "<digest from the intent>",
  "approved": true,
  "approvedBy": "reviewer-id",
  "approvedAt": "2026-07-10T12:01:00.000Z",
  "expiresAt": "2026-07-10T12:31:00.000Z",
  "reason": "Validated evidence and approved submission."
}
```

Validate both files without executing:

```bash
node scripts/check-tabellio-stack-operation.mjs \
  --intent /tmp/stack-intent.json \
  --approval /tmp/stack-approval.json
```

## Execute

For a self-hosted Forgejo repository using HTTPS:

```bash
node scripts/tabellio-stack-operation.mjs execute \
  --repo . \
  --intent /tmp/stack-intent.json \
  --approval /tmp/stack-approval.json \
  --token-file /secure/path/forgejo-token \
  --git-username forgejo-user
```

The token is supplied to the Forgejo API through `FORGEJO_TOKEN`. Git HTTPS authentication uses an internal askpass process, so the token never enters the remote URL or command arguments. Prefer SSH for Git transport and the operating-system keyring for long-lived production use.

Each approved attempt creates a receipt below Git's private common directory. Approval IDs are one-use even when execution fails. Concurrent Tabellio stack writes are locked. Failed receipts retain sanitized diagnostics without PR bodies or token values.

git-spice 0.30 requires an explicit repository opt-in before forge merge:

```bash
git config spice.experiment.merge true
```

## Security Boundary

The approval JSON is an auditable intent binding, not cryptographic proof of reviewer identity. The system issuing approvals must control write access to approval files. Signed approvals remain future work.

Token-file mode is intended for a trusted repository or isolated CI job. Git hooks inherit child-process environment; do not expose a privileged token to untrusted hooks. Use repository-scoped, short-lived tokens and separate Git transport credentials wherever possible.
