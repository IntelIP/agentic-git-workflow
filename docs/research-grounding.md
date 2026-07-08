# Tabellio Research Grounding

Tabellio combines proven software-delivery patterns for AI-assisted pull requests.

It does not introduce a new security standard. It applies existing ideas from provenance, code review, merge queues, static analysis, evals, and observability.

## Thesis

Agentic development should stay Git-native:

1. Keep changes small.
2. Record machine-readable evidence.
3. Run deterministic checks.
4. Default-deny external side effects.
5. Review through normal pull requests.
6. Merge only after current checks pass.

The agent is optional. The evidence contract is the product.

## Prior Art Map

| Pattern | Example Sources | What Tabellio Borrows |
| --- | --- | --- |
| Provenance | [SLSA](https://slsa.dev/spec/v1.0/levels), [SLSA build provenance](https://slsa.dev/spec/draft/build-provenance) | Record where work came from, what inputs existed, and which process produced the artifact |
| Supply-chain steps | [in-toto](https://in-toto.io/), [in-toto docs](https://in-toto.io/docs/getting-started/) | Treat plan, edit, test, review, and merge as auditable steps |
| Merge safety | [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Validate the final merge state, not just stale local state |
| OSS repo structure | [Vercel AI SDK](https://github.com/vercel/ai), [Next.js](https://github.com/vercel/next.js), [Vercel CLI](https://github.com/vercel/vercel) | Keep the README short, link docs clearly, and surface contributing, security, and license files |
| Stacked review | [Graphite](https://graphite.dev/) | Split large agent work into reviewable PRs |
| Agentic Git substrate | [Code Storage](https://code.storage/) | Treat repositories, branches, commits, patches, and code-like artifacts as machine-addressable product data |
| Agent session ledger | [Entire](https://entire.io/), [Entire glossary](https://docs.entire.io/glossary) | Attach checkpoint and session context to code changes without making the PR body the only audit record |
| Review-time analysis | [Google Tricorder](https://research.google.com/pubs/archive/43322.pdf), [Google SWE book: static analysis](https://abseil.io/resources/swe-book/html/ch20.html) | Put actionable automated checks in the review path |
| OSS health | [OpenSSF Scorecard](https://github.com/ossf/scorecard), [Scorecard](https://scorecard.dev/) | Track public repo hygiene without making it a deployment gate |
| Agent evals | [Inspect AI](https://inspect.aisi.org.uk/), [OpenAI Evals](https://github.com/openai/evals) | Test agent behavior over repeated tasks, not one-off claims |
| Coding agents | [SWE-agent](https://github.com/swe-agent/swe-agent) | Support real repository workflows while staying agent-agnostic |
| Observability | [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/) | Make runs inspectable through structured traces, logs, and artifacts |

## Mapping To This Repo

| Repo Primitive | Grounded By | Purpose |
| --- | --- | --- |
| Evidence envelope | SLSA, in-toto | Structured audit packet for PRs |
| External action policy | Security review, deployment controls | Prevent hidden deploys, migrations, secret reads, provider reads, and destructive actions |
| Evidence workflow | GitHub Actions, reusable workflows | Run evidence checks in CI |
| PR template | Code review practice | Put evidence summary in front of reviewers |
| Scorecard workflow | OpenSSF Scorecard | Track public repo health |
| Tooling stack guide | Code Storage, Entire, Graphite | Tag the workflow ecosystem while keeping vendor APIs outside v0.1.0 core |

## Claims We Can Make

- Evidence-backed PR workflow for agentic development
- SLSA-inspired provenance for AI-assisted changes
- in-toto-inspired step records
- Agent-agnostic Git governance
- Default-deny external action policy
- CI-validated evidence envelope

## Claims We Should Avoid

- SLSA compliant
- in-toto verified
- Autonomous deployment safety
- Replacement for human review
- Guaranteed secure agent output
- Formal supply-chain security

## Next Research-Backed Extensions

| Extension | Why It Matters |
| --- | --- |
| Signed evidence | Improves tamper resistance |
| SLSA export | Bridges to existing supply-chain tooling |
| in-toto link export | Models each workflow step explicitly |
| OpenTelemetry spans | Makes agent runs easier to debug |
| Agent eval suite | Tests approval-boundary behavior |
| Stack metadata | Makes multi-PR agent work easier to inspect |

## Boundary

Current v0.1.0 is intentionally modest. It is a structured evidence and review workflow, not a formal supply-chain security implementation.
