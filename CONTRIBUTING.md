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
node scripts/write-evident-evidence-envelope.mjs --out /tmp/evident-pr-evidence.json
node scripts/check-evident-evidence-envelope.mjs --evidence /tmp/evident-pr-evidence.json
node scripts/check-evident-external-actions.mjs --evidence /tmp/evident-pr-evidence.json
```

Check script syntax:

```bash
node --check scripts/check-evident-evidence-envelope.mjs
node --check scripts/check-evident-external-actions.mjs
node --check scripts/write-evident-evidence-envelope.mjs
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
