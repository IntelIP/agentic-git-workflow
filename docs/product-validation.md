# Product Validation

Tabellio product validation answers a stronger question than “did tests exit zero?”: did the exact committed candidate satisfy its declared user outcomes while staying inside semantic, visual, operational, cost, and safety boundaries?

## Contracts

`tabellio-validation/v0.2` binds three layers in one committed manifest:

1. `acceptance` records the source request, risk, required outcomes, invariants, forbidden outcomes, and required validator types.
2. `validators` run shell-free argument arrays in the exact-head detached worktree.
3. `policy` applies metric thresholds and cost requirements to a bounded evidence report.

Validator types are `static`, `schema`, `semantic`, `workflow`, `visual`, `operational`, and `security`. Static validators can use command exit status alone. Every other type must emit `tabellio-validator-evidence/v0.1` at its declared relative path.

## Evidence

An evidence report contains:

- `status`: the adapter’s passed, failed, or blocked observation;
- numeric metrics with explicit units;
- cost telemetry state, USD cost, model calls, and tool calls;
- immutable artifact metadata for screenshots, traces, reports, or source snapshots.

The runner validates the evidence shape and validator identity, embeds the bounded report in the durable result, and evaluates policy itself. Adapter-reported `passed` cannot override a failed metric threshold or exceeded cost cap.

## Decision Semantics

| Decision | Meaning |
| --- | --- |
| `passed` | Every required validator completed with trustworthy evidence inside all thresholds. |
| `failed` | Trustworthy evidence proves a required product or budget threshold was missed. |
| `blocked` | Required proof is missing or untrustworthy because of invalid evidence, missing metrics or cost telemetry, command errors, or timeouts. |

Fail closed. Never translate `blocked` into `passed`, and never treat missing cost telemetry as zero.

## Repository Adapters

Keep product knowledge in each repository. The adapter runs the existing eval, browser, design, cost, or security harness and writes the common evidence contract.

Use `tabellio-validator` for simple adapters. Commit `.tabellio/validators.json` with `tabellio-adapter/v0.1` profiles containing shell-free command arrays, evidence metrics, cost telemetry, and a concise summary. Metrics may map command pass/fail to numeric values or extract a numeric capture group from bounded command output.

- AI systems: stable golden cases in pull requests; larger live suites on schedules or release gates.
- Web applications: critical journeys, desktop/mobile screenshot comparisons, loaded-font assertions, overflow, and accessibility metrics.
- Operational systems: projected and observed provider usage, worker counts, polling frequency, rate limits, latency, and spend.
- Structured outputs: strict schema validation plus semantic oracles that catch plausible but wrong values.

Use fixtures and isolated namespaces in pull requests. Live external mutation remains separately approval-gated.

## Review Integration

Review sync reads only the newest validation result stored under the exact pull-request head. `passed` becomes a successful local check; `failed` or `blocked` prevents merge readiness. A new head requires new validation.

Run contract checks with:

```bash
node scripts/check-tabellio-validation.mjs --manifest examples/tabellio-validation/product-manifest.json
node scripts/check-tabellio-validation.mjs --evidence examples/tabellio-validation/minimal-validator-evidence.json
```

Run the exact-head suite with:

```bash
node scripts/tabellio-validate.mjs run \
  --repo . \
  --repo-id example/project \
  --base main \
  --commit HEAD \
  --manifest tabellio.validation.json
```

Use the fail-closed command in CI:

```bash
tabellio-validate gate \
  --repo . \
  --repo-id example/project \
  --base main \
  --commit HEAD \
  --manifest tabellio.validation.json
```

`gate` still records the result. It exits non-zero when the decision is `failed` or `blocked`.

Artifact upload and path-based automatic validator selection remain scheduler or repository-policy responsibilities. The first contract keeps evaluation portable without creating a second CI or deployment authority.
