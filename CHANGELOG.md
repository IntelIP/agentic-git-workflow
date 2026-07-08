# Changelog

All notable changes to Evident are recorded here.

## 0.1.0 - Pending Release

Initial public release.

### Added

- Evidence envelope contract with `evident-evidence/v0.1` schema version.
- Dependency-free Node.js writer and validators.
- Default-deny external action policy for protected side effects.
- Reusable GitHub Actions workflow for PR evidence checks.
- Pull request evidence template.
- Minimal valid evidence fixture.
- OpenSSF Scorecard workflow.
- Research grounding, schema reference, and workflow model docs.
- Agentic tooling stack guide covering Code Storage, Entire, Graphite, GitHub, Codex, and Evident boundaries.

### Release Gates

- `npm run check`
- script syntax checks with `node --check`
- generated evidence validation
- external-action policy validation
- GitHub Actions evidence check
- OpenSSF Scorecard run on `main`
