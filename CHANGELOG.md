# Changelog

All notable changes to Tabellio are recorded here.

## Unreleased

### Added

- GitHub-bound exact-commit validation runner with committed argv manifests and no shell execution.
- Bounded SHA-256 output evidence, detached worktree cleanup, and durable results on `refs/tabellio/validations`.
- Local validation results integrated into durable review readiness.
- Git-native JSON ledger on compare-and-swap refs for durable control-plane state.
- Durable review cycles covering GitHub feedback, agent findings, triage, checks, fixes, and readiness.
- Dry-run-first, atomic review-cycle migration from legacy v0.1 identities and PR numbers to GitHub-only v0.2 state.
- Entire-checkpoint-bound fix records with commit remapping across git-spice restacks.
- Approval-gated git-spice submit, update, sync, restack, and merge operations.
- Integrity-bound operation intents, short-lived approvals, one-use receipts, and branch-set race checks.
- File-backed GitHub API and Git HTTPS authentication without credentials in remote URLs or command arguments.
- Read-only GitHub provider for repository, pull request, review, comment, commit-status, and check-run reads.
- Mandatory-by-default Entire ledger provider with metadata-only checkpoint export and context binding.
- GitHub workflow `tabellio-ledger/v0.1` schema, CLI, validator, example, and tests.
- Read-only git-spice stack adapter with GitHub workflow `tabellio-stack/v0.1` snapshots.
- Stack snapshot schema, validator, CLI, example, and adapter tests.
- Local agent-run CLI with start, checkpoint, finish, status, and safe promotion commands.
- Mutable `tabellio-run/v0.1` local state contract and end-to-end lifecycle artifacts.
- `RepositoryStore` contract and standard Git implementation for the GitHub workflow.
- Bare-repository, contained-worktree, Git-note, merge-preview, and compare-and-swap primitives.
- Integrity-protected `tabellio-context/v0.1` packet and CLI capture/check commands.
- Optional evidence-to-context commit binding.
- Native Git race, conflict, containment, integrity, and compatibility tests.
- Immutable ref snapshots and merge-base change sets for concurrent agent branches.
- SHA-256 repository support for compare-and-swap ref creation.

### Fixed

- Removed 15 unused public exports and consolidated provider subprocess handling; inherited Fallow dead-code findings dropped from 49 to 34 without deleting runtime interface methods.
- Evidence artifact self-integrity now has an explicit canonical hash scope.
- Handwritten policy validators now require approval booleans, unique action IDs, and non-empty forbidden side effects.
- Runtime context validation now matches schema property boundaries.
- Review sync ignores exact-commit validations belonging to a different repository identity.
- Pull request CI now runs the Tabellio unit suite and records the source head commit.
- Merge preview uses structured output so diagnostic words in file paths remain intact.
- Context serialization rejects undefined fields and impossible object-ID lengths.
- Timed-out Git commands now fail instead of appearing successful.
- Required repository validation commands now appear in generated evidence.
- Windows local remote paths are hashed before entering context identity.

### Changed

- Standardized stacked GitHub pull requests on git-spice.
- Made GitHub `origin` the canonical code store and thin pull-request shell while keeping agent control state external.
- Rejected publication or fetching of review, validation, and Entire control refs through the code-storage remote.

## 0.1.0 - 2026-07-08

Initial public release.

### Added

- Evidence envelope contract with `tabellio-evidence/v0.1` schema version.
- Dependency-free Node.js writer and validators.
- Default-deny external action policy for protected side effects.
- Reusable GitHub Actions workflow for PR evidence checks.
- Pull request evidence template.
- Minimal valid evidence fixture.
- OpenSSF Scorecard workflow.
- Research grounding, schema reference, and workflow model docs.
- Agentic tooling stack guide covering Entire, GitHub, Codex, and Tabellio boundaries.

### Release Gates

- `npm run check`
- script syntax checks with `node --check`
- generated evidence validation
- external-action policy validation
- GitHub Actions evidence check
- OpenSSF Scorecard run on `main`
