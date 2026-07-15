# Getting Started

Tabellio captures GitHub-bound context and can attach a machine-readable evidence packet to pull requests. Humans, CI, and coding agents use the same contract.

## Requirements

- Git repository
- Node.js 20 or later
- Git 2.38 or later with `merge-tree --write-tree`
- git-spice 0.18 or later for optional stack snapshots
- Entire CLI 0.7.7 or later for mandatory checkpoint metadata export

GitHub is the canonical code store through the `origin` remote. Tabellio does not use it for private agent transcripts, validation results, review ledgers, or control refs. No hosted workflow runtime is required.

Enable Entire for Codex before creating agent commits:

```bash
entire enable --agent codex --project
```

Every agent change range must contain at least one `Entire-Checkpoint` commit trailer. Context capture fails closed when no checkpoint exists. Use `--ledger git-note` only while migrating an older repository.

## Capture A Stack

Initialize git-spice in a normal working repository, then capture its local stack graph without contacting GitHub:

```bash
git-spice repo init
node scripts/tabellio-stack.mjs \
  --repo . \
  --repo-id example/repository \
  --out tabellio-stack.json
node scripts/check-tabellio-stack.mjs --stack tabellio-stack.json
```

The snapshot adapter uses documented JSON output and disables change-request status and comment queries. Approved write operations use the separate flow in [Approved stack operations](stack-operations.md).

## Configure The Platform

`tabellio.platform.json` makes the operating model explicit: GitHub code storage, git-spice stacks, and a private GitHub `control` remote for Entire checkpoints, validation, and review state.

```bash
npm run tabellio:platform:check
```

Run `tabellio-validate` from any trusted worker. The runner checks out the exact revision in an isolated worktree, executes only argv arrays committed in `tabellio.validation.json`, bounds captured output, and writes the result to `refs/tabellio/validations`.

```bash
node scripts/tabellio-validate.mjs run \
  --repo . \
  --repo-id example/repository \
  --commit HEAD \
  --manifest tabellio.validation.json
```

The worker can be a local agent or an operator-managed scheduled service. Tabellio's contract stays identical.

## Share Control State

Review cycles, validation results, and Entire checkpoints use standard Git refs. Publishing or fetching them requires an integrity-bound plan and short-lived approval:

```bash
node scripts/tabellio-control-ref.mjs plan \
  --operation publish \
  --remote "$TABELLIO_CONTROL_REMOTE" \
  --repo-id example/repository \
  --out /tmp/control-ref-intent.json
```

`TABELLIO_CONTROL_REMOTE` must name a separately configured private GitHub repository remote. It cannot be `origin`. Create a matching `tabellio-control-ref-approval/v0.1` document after reviewing the exact local and remote OIDs, then execute it once with `tabellio-control-ref.mjs execute`. Multi-ref publication is atomic. Non-fast-forward publication, divergence, changed refs, expired approvals, and reused approvals fail closed.

## Local Validation

From this repository:

```bash
npm run check
node scripts/check-tabellio-stack.mjs --stack examples/tabellio-stack/minimal-stack.json
node scripts/check-tabellio-ledger.mjs --ledger examples/tabellio-ledger/minimal-ledger.json
node scripts/capture-tabellio-context.mjs --repo . --repo-id example/repository --base main --head HEAD --out /tmp/tabellio-context.json
node scripts/check-tabellio-context.mjs --context /tmp/tabellio-context.json
node scripts/write-tabellio-evidence-envelope.mjs --context /tmp/tabellio-context.json --out /tmp/tabellio-pr-evidence.json
node scripts/check-tabellio-evidence-envelope.mjs --evidence /tmp/tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence /tmp/tabellio-pr-evidence.json
```

From a repository that does not vendor Tabellio, install the package on the trusted worker and run the same commands there.

## Change Request Copy

Add the Tabellio checklist to the repository PR template:

```markdown
## Tabellio Evidence

- [ ] Evidence envelope generated
- [ ] Evidence envelope validated
- [ ] Required commands listed with pass/fail/skipped status
- [ ] Changed files listed
- [ ] External action policy present
- [ ] No protected side effect attempted without explicit approval
```

The full GitHub pull-request template lives at `templates/pull_request_template.md`.

## Protected Side Effects

These action classes are default-deny:

- deployment
- database migration
- infrastructure change
- DNS or hosting change
- billing or live-money action
- credentialed provider read
- secret-value read
- destructive workspace action

If any class is marked `attempted: true`, it must also be marked `approved: true`.

## First Adoption Change

Keep the first PR small:

1. Add `tabellio.platform.json` and `tabellio.validation.json`.
2. Enable Entire and initialize git-spice.
3. Push a code branch to `origin` and open a thin pull request.
4. Run exact-head validation and sync the durable review cycle.
5. Publish control refs to the configured external destination with an approved one-use operation.

Before production deployment, apply the concurrency, worker isolation, backup, and monitoring guidance in [Operations hardening](operations-hardening.md).
