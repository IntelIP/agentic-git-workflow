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
node --check scripts/write-tabellio-evidence-envelope.mjs
```

Check the reusable workflow syntax before release:

```bash
actionlint
```

Install `actionlint` from the official `rhysd/actionlint` release or a trusted package manager before running this command.

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
- CI workflow permissions
- SARIF or security reporting

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

- update `CHANGELOG.md`
- confirm README examples use the intended release tag
- run local checks
- run workflow syntax validation
- confirm the latest `main` Scorecard run passes
- create the GitHub release from a clean `main` commit
