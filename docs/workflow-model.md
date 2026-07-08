# Tabellio Workflow Model

Tabellio turns an agentic coding run into a reviewable pull request packet.

## Core Objects

| Object | Role |
| --- | --- |
| Task source | Why the work started: issue, chat request, ticket, prompt, or manual request |
| Runtime | Human, CI process, coding agent, or mixed toolchain that produced the change |
| Evidence envelope | JSON record of Git state, changed files, commands, checks, approvals, side-effect policy, and artifacts |
| External action policy | Default-deny policy for deploys, migrations, infra, DNS, billing, secrets, provider reads, and destructive actions |
| Pull request | Human review surface for the diff plus evidence summary |
| Stack | Ordered PR chain for larger changes |
| Merge queue | Optional final validation point before main |

## Tooling Layers

| Layer | Example Tooling | Role |
| --- | --- | --- |
| Git substrate | GitHub, Code Storage | Stores repositories, branches, commits, and patch state |
| Session ledger | Entire | Preserves checkpoint and agent-run context for later review |
| Evidence gate | Tabellio | Validates commands, checks, changed files, approvals, and side-effect policy |
| Stacked review | Graphite | Keeps related PRs small, ordered, and reviewable |
| Agent review | Codex review | Adds optional diff and evidence review by an agent |

## Standard Flow

```text
task
  -> branch
  -> small change
  -> deterministic checks
  -> evidence envelope
  -> evidence validation
  -> external-action check
  -> pull request
  -> review
  -> merge
```

## Review Packet

Each PR should expose:

- task source
- changed files
- commands run
- checks passed, failed, skipped, or pending
- required approvals
- external actions attempted or blocked
- evidence artifact path

Evidence is not a claim that the work is correct. Evidence is the record reviewers inspect before trusting the work.

## Stack Discipline

Use stacked PRs when a task contains separate concepts:

- schema or substrate
- validator script
- workflow wiring
- UI or docs
- eval coverage

Each PR should explain only its own change. Avoid one evidence envelope that tries to justify a whole roadmap.

## External Action Discipline

Default posture: no external side effects without explicit approval.

Protected classes:

| Class | Examples |
| --- | --- |
| deployment | Production deploy, hosting mutation |
| database migration | Schema or data mutation |
| infrastructure change | Cloud resource mutation |
| DNS or hosting change | DNS update, host config update |
| billing or live-money | Paid resource change, transaction |
| credentialed provider read | API call using private credentials |
| secret-value read | Reading or logging secret values |
| destructive workspace action | File deletion, force push, history rewrite |

The workflow can document planned side effects before approval. It should not execute them.

## Reviewer Checklist

- Does the task source match the diff?
- Are changed files listed?
- Did required commands run?
- Are skipped commands explained?
- Does the policy still default to deny?
- Did any protected action happen without approval?
- Is the PR small enough to review?
- Is evidence current for the final PR state?

## Extension Points

Future versions can add:

- signed evidence
- SLSA provenance export
- in-toto link metadata
- OpenTelemetry spans
- model/tool eval suites
- Graphite stack metadata
- GitHub merge queue metadata
