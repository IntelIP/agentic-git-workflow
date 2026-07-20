# Changelog

All notable changes to Tabellio are recorded here.

## Unreleased

## 0.5.0 - 2026-07-20

This is the first publication candidate after v0.2.0. Versions 0.3.0 and 0.4.0 were development milestones and were not tagged, released on GitHub, or published to npm.

### Added

- Product-validity and cost-aware validation from the unpublished v0.4.0 milestone.
- Deterministic release planning and resumable publication from the unpublished v0.3.0 milestone.

### Changed

- Post-merge exact-head validation now compares landed push commits with `HEAD^` while pull-request validation continues to compare with `origin/main`.
- Validation worktrees, isolated homes, caches, and generated output now use private external temporary sessions.
- Preflight reads Codex hook-trust state directly and no longer invokes the repair-oriented `entire doctor` command.

### Fixed

- Validation fails closed when workspace containment or Git worktree cleanup cannot be proven.
- Partial Git worktree registrations are removed after checkout failure.

### Release Gates

- `tabellio-preflight --profile release`
- `npm run check`
- Fallow whole-repository and changed-code scans
- `npm pack --dry-run --json`
- Exact merged-head Tabellio validation

## 0.4.0 - 2026-07-16 (unpublished development milestone)

### Added

- Product-validity manifests that bind acceptance outcomes, invariants, forbidden outcomes, risk, and required validator types to an exact candidate commit.
- Typed schema, semantic, workflow, visual, operational, and security evidence with bounded metrics, artifact digests, and cost telemetry.
- Fail-closed `passed`, `failed`, and `blocked` decisions with threshold and cost-budget enforcement.
- `tabellio-validate gate` for CI enforcement without external JSON parsing.
- `tabellio-validator` for repository-declared shell-free adapter commands, metric extraction, and common evidence emission.

### Changed

- Product-changing work now requires evidence beyond command exit status when the manifest declares typed validators.
- Missing required evidence, missing metrics, command errors, timeouts, and unknown required cost telemetry block readiness.
- Existing v0.1 manifests and v0.1/v0.2 result readers remain supported during migration.

### Release Gates

- `tabellio-preflight --profile release`
- `npm run check`
- Fallow whole-repository and changed-code scans
- `npm pack --dry-run --json`
- Exact merged-head Tabellio validation

## 0.3.0 - 2026-07-15 (unpublished development milestone)

### Added

- Deterministic `tabellio-preflight` checks for Node, GitHub remotes, GitHub CLI authentication, platform configuration, Entire version and enablement, required Codex hooks, hook trust, and release-main cleanliness.
- Exact `/hooks` recovery guidance when Entire integration exists but Codex has not trusted the repository hook commands.
- Integrity-bound `tabellio-release-operation/v0.1` plans and short-lived release approvals.
- Resumable, idempotent post-merge release execution for private control-ref publication, annotated tag publication, and GitHub release creation.
- Isolated consumer-repository dogfood covering release planning, exact validation, terminal review sync, control transport, tag publication, failure recovery, and GitHub release invocation.

### Changed

- Release planning now runs exact merged-head validation and terminal review synchronization before requesting remote-write approval.
- Pull-request merge remains an explicit operator gate; release execution begins only after the resulting commit and all publishable control OIDs are known.

### Release Gates

- `tabellio-preflight --profile release`
- `npm run check`
- Fallow whole-repository dead-code and stale-suppression scan
- Fallow changed-code audit against `origin/main`
- `npm pack --dry-run --json`
- Exact merged-head Tabellio validation

## 0.2.0 - 2026-07-15

### Added

- GitHub-bound exact-commit validation runner with committed argv manifests and no shell execution.
- Bounded SHA-256 output evidence, detached worktree cleanup, and durable results on `refs/tabellio/validations`.
- Local validation results integrated into durable review readiness.
- Git-native JSON ledger on compare-and-swap refs for durable control-plane state.
- Durable review cycles covering GitHub feedback, agent findings, triage, checks, fixes, and readiness.
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

- Removed 15 unused public exports and consolidated provider subprocess handling.
- Classified all 34 reported interface and injected class methods against runtime and test call sites, then added narrow stale-checked Fallow suppressions; unresolved dead-code findings are zero.
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

### Removed

- Retired the completed one-time legacy review-cycle migration command, decoder, remap helpers, documentation, and fixtures. Recovery code remains available in Git history.

### Release Gates

- `npm run check`
- Fallow whole-repository dead-code and stale-suppression scan
- Fallow changed-code audit against `origin/main`
- `npm pack --dry-run --json`
- Exact-head Tabellio validation

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
