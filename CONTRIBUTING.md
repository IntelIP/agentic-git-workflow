# Contributing

## Principles

Keep the workflow:

- agent-agnostic
- Git-native
- dependency-light
- deterministic before AI-assisted
- default-deny for external side effects
- clear about evidence versus claims

## Local Checks

Run the full local check:

```bash
npm run check
```

Generate and validate a fresh evidence packet:

```bash
node scripts/write-tabellio-evidence-envelope.mjs --out /tmp/tabellio-pr-evidence.json
node scripts/check-tabellio-evidence-envelope.mjs --evidence /tmp/tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence /tmp/tabellio-pr-evidence.json
```

Check script syntax:

```bash
node --check scripts/check-tabellio-evidence-envelope.mjs
node --check scripts/check-tabellio-external-actions.mjs
node --check scripts/check-tabellio-run.mjs
node --check scripts/tabellio-run.mjs
node --check scripts/write-tabellio-evidence-envelope.mjs
```

Validate the canonical platform and exact-commit manifest before release:

```bash
npm run tabellio:platform:check
node scripts/check-tabellio-validation.mjs --manifest tabellio.validation.json
```

## Pull Requests

Each PR should include:

- evidence envelope path or artifact
- commands run
- check result summary
- external-action policy summary
- skipped-check notes, if any

Do not include:

- secret values
- private session logs
- local machine paths
- provider account data
- unredacted credentials

## Sensitive Changes

Ask for extra review when changing:

- required evidence fields
- required action classes
- default-deny behavior
- approval handling
- control-ref allow lists and approval checks
- forge credentials or validation worker isolation

## Documentation Style

Prefer:

- short sections
- tables for comparisons
- code blocks for commands
- direct current-state wording

Avoid:

- compliance claims not implemented by code
- long roadmap text in the README
- burying security boundaries in prose

## Release Prep

Before tagging a release:

- run `node scripts/tabellio-preflight.mjs --profile release`
- keep preflight read-only; run `entire doctor` only as an explicit operator-approved repair step
- update `CHANGELOG.md`
- confirm README examples use the intended release tag
- run local checks
- run an exact-head `tabellio-validate` pass
- confirm the durable review cycle is ready
- tag from a clean `origin/main` commit

After the release PR is explicitly merged, use `tabellio-release plan` to run merged-head validation, synchronize the terminal review cycle, and bind exact publishable control refs. Review the generated intent, create a short-lived `tabellio-release-approval/v0.1`, then run `tabellio-release execute` once. The executor publishes control refs, the annotated tag, and the GitHub release. It never merges the pull request.
