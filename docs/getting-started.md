# Getting Started

Evident adds a machine-readable evidence packet to pull requests. It is agent-agnostic: humans, CI, coding agents, and mixed workflows can all produce the same review surface.

## Requirements

- GitHub repository
- GitHub Actions enabled
- Node.js 20 or later
- Pull request review flow

## Add The Reusable Workflow

Create `.github/workflows/evident.yml` in the consumer repository:

```yaml
name: Evident Evidence

on:
  pull_request:

permissions:
  contents: read
  actions: read

jobs:
  evidence:
    uses: IntelIP/agentic-git-workflow/.github/workflows/evident-evidence.yml@v0.1.0
    with:
      # Replace with the repository's normal validation command.
      validation_command: npm test
      toolkit_ref: v0.1.0
```

`toolkit_ref` is required when the consumer repository does not vendor the Evident scripts. In consumer repositories, setting it forces the workflow to use the pinned Evident toolkit instead of PR-controlled local scripts. Pin it to the same release tag or SHA as the reusable workflow. Before the first release tag exists, use `main` for both refs.

## What The Workflow Does

1. Checks out the pull request repository.
2. Runs the optional validation command before adding any fallback toolkit files.
3. Uses local Evident scripts when the repository vendors them.
4. Otherwise checks out the Evident toolkit at `toolkit_ref`.
5. Writes `evident-pr-evidence.json`.
6. Validates the evidence envelope.
7. Checks the default-deny external action policy.
8. Uploads the evidence artifact.

## Local Validation

From this repository:

```bash
npm run check
node scripts/write-evident-evidence-envelope.mjs --out /tmp/evident-pr-evidence.json
node scripts/check-evident-evidence-envelope.mjs --evidence /tmp/evident-pr-evidence.json
node scripts/check-evident-external-actions.mjs --evidence /tmp/evident-pr-evidence.json
```

From a consumer repository that does not vendor the scripts, use the GitHub Actions workflow as the integration point.

## Pull Request Copy

Add the Evident checklist to the repository PR template:

```markdown
## Evident Evidence

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
4. Confirm `Evident evidence` passes.
5. Confirm the uploaded artifact contains `evident-pr-evidence.json`.
