# Agent Run Lifecycle

Tabellio can run a complete local agent workflow without a GitHub API or proprietary code-storage service. State lives under a local run root; Git remains the code substrate.

## State Machine

```text
start -> active -> checkpoint (zero or more) -> finish
                                               |-> validation_failed -> finish retry
                                               |-> completed -> promote -> promoted
```

`promote` is separate from `finish`. Validation never mutates the target branch. Promotion confirms the validated run head has not changed and permits only a fast-forward. Ref-only targets use compare-and-swap. Checked-out targets hold a compare-and-swap ref transaction while Git updates the worktree and index, preventing a concurrent ref move from being accepted.

## Local Layout

```text
.tabellio/
  runs/<run-id>.json
  workspaces/<run-id>/
  artifacts/<run-id>/tabellio-context.json
  artifacts/<run-id>/tabellio-evidence.json
```

The run manifest is mutable local control state. Context and evidence are immutable-commit artifacts with integrity hashes. Exported artifacts contain repository identity, not local repository or workspace paths. By default, `.tabellio/` is anchored to the repository passed with `--repo`, independent of the caller's current directory. `--run-root` can override that location.

Add `.tabellio/` to the consumer repository's ignore rules when using the default run root.

## Commands

Start from a frozen target branch commit:

```bash
node scripts/tabellio-run.mjs start \
  --run-id run-42 \
  --repo . \
  --base main \
  --task-summary "Add deterministic import validation"
```

The JSON result includes the isolated workspace path. Make changes there and commit them before checkpointing.

```bash
node scripts/tabellio-run.mjs checkpoint \
  --run-id run-42 \
  --repo . \
  --summary "Importer and tests committed"
```

Finish executes a command directly, without a shell. Everything after `--` is the executable and its argument array.

```bash
node scripts/tabellio-run.mjs finish \
  --run-id run-42 \
  --repo . \
  -- npm test
```

The validation command is caller-authorized local execution. Use a known repository check; lifecycle evidence does not make an arbitrary command safe or bypass external-action approval policy.

Failed validation still produces context and evidence, records `validation_failed`, exits nonzero, and blocks promotion. Fix and commit the branch, then run `finish` again.

Inspect state:

```bash
node scripts/tabellio-run.mjs status --run-id run-42 --repo .
```

Promote the exact validated commit:

```bash
node scripts/tabellio-run.mjs promote --run-id run-42 --repo .
```

Promotion fails if the target branch moved, the run branch changed after validation, the run is not descended from its frozen base, or merge preview reports conflicts.

## Safety Boundary

- No GitHub API, remote authentication, hosting, deployment, or provider action.
- No shell command construction.
- Checkpoints require a clean committed workspace and use Git notes.
- Checkpoint and finish require the run branch to remain checked out; validation must leave both that checkout and the run branch HEAD unchanged.
- Promotion requires passed validation and an exact expected-old-commit compare-and-swap, including checked-out targets.
- Worktree or branch cleanup remains explicit and is not performed by lifecycle commands.
