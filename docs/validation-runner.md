# Exact-Commit Validation

Tabellio validation replaces the GitHub Actions runtime dependency with a small local contract. Any trusted worker that has Git, Node.js, the repository, and its declared tools can run the same manifest. Results live in standard Git objects on `refs/tabellio/validations`.

## Manifest

`tabellio.validation.json` is committed with the code being tested:

```json
{
  "schemaVersion": "tabellio-validation/v0.1",
  "id": "tabellio-default",
  "failFast": true,
  "requireEntireCheckpoint": true,
  "commands": [{
    "id": "repository-check",
    "argv": ["npm", "run", "check"],
    "cwd": ".",
    "timeoutMs": 1200000,
    "required": true
  }]
}
```

Commands are executable-plus-argument arrays. Tabellio never invokes a shell, interpolates command strings, or reads a newer working-tree manifest while validating an older commit.

Manifest v0.1 remains supported. Product-facing repositories can use `tabellio-validation/v0.2`, which adds an immutable acceptance contract and typed `static`, `schema`, `semantic`, `workflow`, `visual`, `operational`, and `security` validators. Every required validator type must have a required validator. Non-static validators must write a bounded `tabellio-validator-evidence/v0.1` report.

Validator policy can require numeric metric thresholds, cost telemetry, and a maximum validation cost. Missing or invalid evidence, missing required metrics, unavailable required cost telemetry, command errors, and timeouts produce `blocked`. Valid evidence that misses a product threshold or cost budget produces `failed`. Only complete required evidence inside every boundary produces `passed`.

See [Product validation](product-validation.md) and [the example manifest](../examples/tabellio-validation/product-manifest.json).

## Run

```bash
node scripts/tabellio-validate.mjs run \
  --repo . \
  --repo-id example/project \
  --base main \
  --commit HEAD \
  --manifest tabellio.validation.json \
  --runner-id worker-01
```

The runner:

1. Freezes base and head object IDs and computes the merge base.
2. Reads the manifest from the exact head commit.
3. Requires at least one Entire checkpoint in the change range when configured.
4. Creates a detached temporary worktree at the exact head commit.
5. Runs argv commands with an isolated `HOME`/`TMPDIR`, minimal environment, and per-command timeout.
6. Hashes all output while retaining only the newest 16 KiB of each stream.
7. Removes the worktree even after failure.
8. Writes an integrity-protected result to `refs/tabellio/validations` with compare-and-swap retries.

Command-manifest results use `tabellio-validation-result/v0.2`. Product-validation results use v0.3 and embed the acceptance digest, typed validator results, bounded evidence reports, total observed validation cost, and final policy decision. Both require `checkpointRevision` so checkpoint proof remains bound to the pull-request head when the validated revision is a later squash-merge commit. Runtime readers continue to accept legacy v0.1 and v0.2 results.

Read the newest result for a commit:

```bash
node scripts/tabellio-validate.mjs latest --repo . --commit HEAD
```

## CI Worker Shape

The runner is deliberately scheduler-agnostic. A GitHub webhook worker, systemd service, AWS Batch task, Kubernetes Job, Buildkite agent, or local Codex worker can invoke the same CLI. The scheduler supplies capacity; Tabellio supplies the immutable validation contract and result ledger.

Publishing `refs/tabellio/validations` to a remote is a separate approved Git write. Review sync consumes the latest result for the exact PR head and will not reuse a result from an older commit.

## Security Boundary

Detached worktrees and isolated home directories protect host source and common credential paths; they are not a hostile-code sandbox. Validation commands can execute arbitrary repository code and use the network. Run untrusted contributions in a disposable VM, container, or sandbox with scoped credentials and network policy. Never place secrets in manifest arguments or print them: argv and bounded output tails are retained as durable evidence.

Typed validation does not authorize live writes. Repository adapters should use fixtures, isolated namespaces, read-only credentials, and explicit cost caps. Artifact metadata must point to durable content-addressed storage when a reviewer needs the screenshot, trace, or report after the temporary worktree is removed.
