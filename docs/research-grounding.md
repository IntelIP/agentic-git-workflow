# Tabellio Research Grounding

Tabellio combines proven software-delivery patterns for AI-assisted pull requests.

It does not introduce a new security standard. It applies existing ideas from provenance, code review, merge queues, static analysis, evals, and observability.

## Thesis

Agentic development should stay Git-native:

1. Keep changes small.
2. Record machine-readable evidence.
3. Run deterministic checks.
4. Default-deny external side effects.
5. Review through GitHub pull requests.
6. Merge only after current checks pass.

The agent is optional. The evidence contract is the product.

## Prior Art Map

| Pattern | Example Sources | What Tabellio Borrows |
| --- | --- | --- |
| Provenance | [SLSA](https://slsa.dev/spec/v1.0/levels), [SLSA build provenance](https://slsa.dev/spec/draft/build-provenance) | Record where work came from, what inputs existed, and which process produced the artifact |
| Supply-chain steps | [in-toto](https://in-toto.io/), [in-toto docs](https://in-toto.io/docs/getting-started/) | Treat plan, edit, test, review, and merge as auditable steps |
| Merge safety | Merge queues and compare-and-swap refs | Validate the final merge state, not just stale local state |
| OSS repo structure | [Vercel AI SDK](https://github.com/vercel/ai), [Next.js](https://github.com/vercel/next.js), [Vercel CLI](https://github.com/vercel/vercel) | Keep the README short, link docs clearly, and surface contributing, security, and license files |
| Stacked review | [git-spice](https://abhinav.github.io/git-spice/), [git-spice JSON output](https://abhinav.github.io/git-spice/cli/json/) | Split large agent work into reviewable change requests while keeping stack state Git-native and machine-readable |
| Agentic Git substrate | [Git repository layout](https://git-scm.com/docs/gitrepository-layout), [Git worktree](https://git-scm.com/docs/git-worktree), [Git notes](https://git-scm.com/docs/git-notes) | Treat repositories, workspaces, commits, refs, and checkpoint context as machine-addressable product data using standard Git |
| Concurrent merge safety | [Git merge-tree](https://git-scm.com/docs/git-merge-tree), [Git update-ref](https://git-scm.com/docs/git-update-ref) | Preview merges without a checkout and update refs only when the expected old commit still matches |
| Agent session ledger | [Entire](https://entire.io/), [Entire glossary](https://docs.entire.io/glossary) | Attach checkpoint and session context to code changes without making the PR body the only audit record |
| Review-time analysis | [Google Tricorder](https://research.google.com/pubs/archive/43322.pdf), [Google SWE book: static analysis](https://abseil.io/resources/swe-book/html/ch20.html) | Put actionable automated checks in the review path |
| Agent evals | [Inspect AI](https://inspect.aisi.org.uk/), [OpenAI Evals](https://github.com/openai/evals) | Test agent behavior over repeated tasks, not one-off claims |
| Coding agents | [SWE-agent](https://github.com/swe-agent/swe-agent) | Support real repository workflows while staying agent-agnostic |
| Observability | [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/) | Make runs inspectable through structured traces, logs, and artifacts |

## Mapping To This Repo

| Repo Primitive | Grounded By | Purpose |
| --- | --- | --- |
| Evidence envelope | SLSA, in-toto | Structured audit packet for PRs |
| Native Git context | Git object IDs, worktrees, notes, merge-tree, update-ref | Bind agent work to immutable commits and reject stale ref updates |
| External action policy | Security review, deployment controls | Prevent hidden deploys, migrations, secret reads, provider reads, and destructive actions |
| Validation runner | Hermetic build workers, argv manifests | Run exact-commit checks on any trusted worker |
| Change-request template | Code review practice | Put evidence summary in front of reviewers |
| Control refs | Git refs, compare-and-swap updates | Share durable review and validation state without storing private workflow data in the public code repository |
| Tooling stack guide | GitHub, Standard Git, Entire, git-spice | Keep one GitHub code and review surface while separating private control state |

## Claims We Can Make

- Evidence-backed PR workflow for agentic development
- SLSA-inspired provenance for AI-assisted changes
- in-toto-inspired step records
- Agent-agnostic Git governance
- Default-deny external action policy
- Worker-validated evidence envelope
- GitHub-native context and evidence engine

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

Current unreleased design remains a structured context, evidence, and review workflow, not a formal supply-chain security implementation or remote Git hosting service.
