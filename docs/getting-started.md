# Getting Started

Tabellio captures provider-neutral Git context and can attach a machine-readable evidence packet to pull requests. Humans, CI, and coding agents use the same contract.

## Requirements

- Git repository
- Node.js 20 or later
- Git 2.38 or later with `merge-tree --write-tree`

GitHub and GitHub Actions are required only for the optional reusable workflow below.

## Add The Reusable Workflow

Create `.github/workflows/tabellio.yml` in the consumer repository:

```yaml
name: Tabellio Evidence

on:
  pull_request:

permissions:
  contents: read
  actions: read

jobs:
  evidence:
    uses: IntelIP/Tabellio/.github/workflows/tabellio-evidence.yml@main
    with:
      # Replace with the repository's normal validation command.
      validation_command: npm test
      toolkit_ref: main
```

`toolkit_ref` is required when the consumer repository does not vendor the Tabellio scripts. The example uses `main` while native context capture is unreleased. For production, pin both references to the same release tag or immutable commit SHA containing this feature.

## What The Workflow Does

1. Checks out the pull request repository.
2. Runs Tabellio's unit tests when the workflow runs in the Tabellio repository.
3. Runs the optional consumer validation command before adding fallback toolkit files.
4. Uses local Tabellio scripts when the repository vendors them.
5. Otherwise checks out the Tabellio toolkit at `toolkit_ref`.
6. Captures and validates `tabellio-context.json` from immutable Git commits.
7. Writes `tabellio-pr-evidence.json` bound to the context packet.
8. Validates the evidence envelope.
9. Checks the default-deny external action policy.
10. Uploads both artifacts.

## Local Validation

From this repository:

```bash
npm run check
node scripts/capture-tabellio-context.mjs --repo . --repo-id example/repository --base main --head HEAD --out /tmp/tabellio-context.json
node scripts/check-tabellio-context.mjs --context /tmp/tabellio-context.json
node scripts/write-tabellio-evidence-envelope.mjs --context /tmp/tabellio-context.json --out /tmp/tabellio-pr-evidence.json
node scripts/check-tabellio-evidence-envelope.mjs --evidence /tmp/tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence /tmp/tabellio-pr-evidence.json
```

From a consumer repository that does not vendor the scripts, use the GitHub Actions workflow as the integration point.

## Pull Request Copy

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

The full template lives at `templates/pull_request_template.md`.

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

## First Adoption PR

Keep the first PR small:

1. Add the workflow file.
2. Add the PR template checklist.
3. Open a test pull request.
4. Confirm `Tabellio evidence` passes.
5. Confirm the uploaded artifact contains `tabellio-pr-evidence.json`.
