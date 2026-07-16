# Product Design Memory

Tabellio can attest visual intent and regression evidence without becoming a design tool or screenshot database.

## Ownership

Product repositories own committed design memory:

```text
design/
  product.design.json
  baselines/manifest.json
  decisions/*.md
```

`tabellio-product-design/v0.1` records visual thesis, canonical token and component sources, reference lock, forbidden patterns, required themes, viewports, states, accessibility policy, and baseline manifest location. Source digests detect drift between the profile and the files it claims as authority.

`tabellio-visual-baselines/v0.1` records human-approved captures by surface, viewport, theme, and state. Each capture points to a durable artifact URI with SHA-256 digest. `file:` URIs are rejected because detached validation worktrees are removed after a run.

`policy.surfaces` declares the required route or component matrix. Approved manifests must cover every declared viewport, theme, and state combination.

`tabellio-ui-review/v0.1` records model judgment as typed evidence: exact commit and profile digests, reviewed capture digests, model identity, cost telemetry, structured findings, verdict, and blockers. It complements deterministic checks; it never approves or rewrites baselines.

New products may commit a `proposed` empty baseline manifest while capture work is pending. A capture run may replace it with a complete proposed manifest bound to the captured commit. Proposed manifests keep approval fields null and always block product readiness until a human promotes them to `approved`.

Git stores design history. Tabellio binds the profile, baselines, visual metrics, critique artifacts, and validation decision to the exact candidate commit.

## Validation

Check a product repository:

```bash
tabellio-design-memory \
  --repo . \
  --profile design/product.design.json
```

The checker verifies profile and baseline shape, repository-relative source paths, source digests, profile digest, product identity, viewport/state/theme references, and durable artifact URIs.

Finalize a product-owned PNG capture matrix into a proposed manifest:

```bash
tabellio-design-captures \
  --repo . \
  --profile design/product.design.json \
  --captures-dir .artifacts/tabellio/visual-captures \
  --artifact-base-uri "artifact+github://OWNER/REPO/actions/runs/RUN_ID/design-captures/" \
  --source-commit "$GITHUB_SHA" \
  --out .artifacts/tabellio/visual-baseline-candidate.json
```

Capture files use `<surface-id>--<viewport>--<theme>--<state>.png`. Finalization fails when any declared matrix cell is absent, a file is not PNG, the commit is not exact, or the artifact URI is ephemeral. Output creation is exclusive; existing evidence is never overwritten.

Use two visual validators when product readiness matters:

- `visual-contract`: deterministic capture completeness, token/profile checks, fonts, overflow, accessibility, and visual diff metrics.
- `visual-judgment`: structured model critique for hierarchy, signifiers, grouping, density, feedback, and reference fidelity.

Require model cost telemetry. Missing profile, baselines, artifacts, metrics, or required cost telemetry is `blocked`. Never update an approved baseline automatically.

## Rollout

Start with one product-specific design system and one unrelated product. Keep profile files small by referencing canonical sources instead of copying full tokens or component inventories. Add a cross-product read-only catalog only after profiles prove portable.
