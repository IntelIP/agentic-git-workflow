# Security Policy

## Supported Versions

Security reports should target the latest `main` branch until versioned maintenance branches exist.

## Reporting

Report security issues privately to the project maintainer before public disclosure.

Include:

- affected file or workflow
- reproduction steps
- expected impact
- whether the issue could allow unapproved external actions, secret disclosure, evidence tampering, or misleading PR status

Do not include live secrets, credentials, private keys, tokens, or account data in reports.

## Security Model

Tabellio assumes generated code and agent claims are untrusted until deterministic checks validate the evidence packet.

Default posture:

| Area | Policy |
| --- | --- |
| Evidence | Machine-readable and reviewable |
| External actions | Default-deny |
| Secret values | Must not be read or logged |
| Provider access | Credentialed reads require explicit approval |
| Dangerous operations | Deploy, migration, infra, DNS, billing, live-money, and destructive actions require explicit approval |
| CI | Evidence checks run before merge review decisions |

## Out Of Scope

v0.1.0 does not claim:

- SLSA compliance
- in-toto verification
- cryptographic evidence signing
- complete supply-chain protection
- autonomous production safety

Current claim: SLSA- and in-toto-inspired evidence for AI-assisted pull requests.

## Maintainer Checklist

Before release:

- run private-name scan
- run secret scan
- validate example evidence
- validate generated evidence
- verify unapproved attempted external actions fail
- verify Scorecard workflow passes
