# Changelog

All notable changes to Tabellio are recorded here.

## Unreleased

### Added

- Local agent-run CLI with start, checkpoint, finish, status, and safe promotion commands.
- Mutable `tabellio-run/v0.1` local state contract and end-to-end lifecycle artifacts.
- Provider-neutral `RepositoryStore` contract and standard Git provider.
- Bare-repository, contained-worktree, Git-note, merge-preview, and compare-and-swap primitives.
- Integrity-protected `tabellio-context/v0.1` packet and CLI capture/check commands.
- Optional evidence-to-context commit binding.
- Native Git race, conflict, containment, integrity, and compatibility tests.
- Immutable ref snapshots and merge-base change sets for concurrent agent branches.
- SHA-256 repository support for compare-and-swap ref creation.

### Fixed

- Evidence artifact self-integrity now has an explicit canonical hash scope.
- Handwritten policy validators now require approval booleans, unique action IDs, and non-empty forbidden side effects.
- Runtime context validation now matches schema property boundaries.
- Pull request CI now runs the Tabellio unit suite and records the source head commit.
- Merge preview uses structured output so diagnostic words in file paths remain intact.
- Context serialization rejects undefined fields and impossible object-ID lengths.
- Timed-out Git commands now fail instead of appearing successful.
- Required repository validation commands now appear in generated evidence.
- Windows local remote paths are hashed before entering context identity.

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
- Agentic tooling stack guide covering Code Storage, Entire, Graphite, GitHub, Codex, and Tabellio boundaries.

### Release Gates

- `npm run check`
- script syntax checks with `node --check`
- generated evidence validation
- external-action policy validation
- GitHub Actions evidence check
- OpenSSF Scorecard run on `main`
