# INTB-261-cross-repository-baseline

Observed: 2026-07-24T05:15:00.000Z
Window: 2026-07-01T00:00:00.000Z to 2026-07-24T05:14:59.000Z
Dataset digest: `ebfad995403d4cbd7af750f254dda6c73f9ad3da4ab1cb5d33d3d1866b40b103`

## Interpretation Boundary

Repository rows describe evidence coverage and delivery-system behavior. They do not rank developers, infer user value from commit volume, or compare incompatible missing denominators.

## Repository Baseline

| Repository | Head | Commits | Validations | Pass rate | Cost coverage | Entire checkpoints | Evidence coverage | Adoption | Dirty |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| IntelIP/Condere | `4ec36ff4ba24` | 121 | 75 | 93.3% | 97.3% | 2 | 42.9% | 66.7% | true |
| IntelIP/Probanda | `e354f0647f87` | 42 | unknown | unknown | unknown | unknown | 14.3% | 0.0% | false |
| IntelIP/Tabellio | `788962498fe0` | 48 | unknown | unknown | unknown | 25 | 85.7% | 66.7% | true |
| IntelIP/vaticor | `3ac0bc738f7d` | 84 | unknown | unknown | unknown | 61 | 28.6% | 33.3% | false |

## Delivery Change Trace

| Repository | Change | Link basis | Plane | PR | Head | Exact validation | Hosted CI | Merged | Released |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| IntelIP/Tabellio | tabellio-pr-27 | manual-reconciliation | INTB-260 | 27 | `99cee522758b` | unavailable | passed | 2026-07-23T17:56:24.000Z | 2026-07-23T18:15:21.000Z |

## Missing Evidence

### IntelIP/Condere

- tabellio-review: unavailable — Review evidence ref is absent.
- plane: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github-actions: unavailable — No sanitized provider snapshot supplied to the read-only collector.

### IntelIP/Probanda

- tabellio-validation: blocked — Schema-invalid JSON in control record.
- tabellio-review: unavailable — Review evidence ref is absent.
- entire: unavailable — Entire metadata checkpoint ref is absent.
- plane: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github-actions: unavailable — No sanitized provider snapshot supplied to the read-only collector.

### IntelIP/Tabellio

- tabellio-validation: blocked — Schema-invalid JSON in control record.

### IntelIP/vaticor

- tabellio-validation: blocked — Schema-invalid JSON in control record.
- tabellio-review: unavailable — Review evidence ref is absent.
- plane: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github-actions: unavailable — No sanitized provider snapshot supplied to the read-only collector.

## Metric Definitions

- `commitCount` (count): Commits reachable from HEAD whose commit time falls inside the observation window. Missing: Unavailable when local Git cannot be read.
- `validationAttemptCount` (count): Tabellio validation results completed inside the observation window. Missing: Unavailable when the validation ref is absent or unreadable.
- `validationPassRate` (ratio): Passed validation attempts divided by all terminal validation attempts in the window. Missing: Unavailable when there are no terminal attempts; never reported as zero.
- `costTelemetryCoverage` (ratio): Validation attempts with complete required cost telemetry divided by validation attempts. Missing: Unavailable when there are no validation attempts.
- `entireCheckpointCount` (count): Distinct metadata-only Entire checkpoint sessions visible in the checkpoint ref. Missing: Unavailable when the metadata ref is absent; transcript bodies are never read.
- `reviewFindingCount` (count): Review feedback records stored in Tabellio review cycles. Missing: Unavailable when the review ref is absent.
- `repairCount` (count): Review fix records stored in Tabellio review cycles. Missing: Unavailable when the review ref is absent.
- `worktreeDirty` (boolean): Whether Git reports tracked or untracked worktree changes at observation time. Missing: Unavailable when local Git cannot be read.
- `evidenceCompleteness` (ratio): Available evidence sources divided by the seven declared source systems. Missing: A missing source reduces completeness; it is not converted to zero-valued evidence.
- `deliveryChangeCount` (count): Delivery changes explicitly included in the sanitized provider snapshot. Missing: Unavailable when no provider snapshot is supplied.
- `taskToPrTraceability` (ratio): Delivery changes linked to both a Plane story and GitHub pull request divided by eligible delivery changes. Missing: Unavailable until compatible Plane and GitHub snapshots are supplied.
- `leadTimeHours` (hours): Elapsed time from work-item creation to merge for linked delivery changes. Missing: Unavailable until linked timestamps are supplied.
- `cycleTimeHours` (hours): Elapsed time from first implementation activity to merge for linked delivery changes. Missing: Unavailable until linked timestamps are supplied.
- `ciDisagreementRate` (ratio): Candidates where hosted CI and exact-candidate validation disagree divided by compared candidates. Missing: Unavailable until hosted-check evidence is supplied.
- `releaseLagHours` (hours): Elapsed time from merge to first containing release. Missing: Unavailable until merge and release evidence is supplied.
- `repositoryAdoption` (ratio): Available Tabellio-native evidence sources divided by validation, review, and Entire sources. Missing: Measured from source availability, not commit volume or developer ranking.

## Provenance

### IntelIP/Condere

- HEAD: `4ec36ff4ba24cfd4a92c525b77a0027a001033e9` at 2026-07-21T10:35:01-07:00
- git: available; version 4ec36ff4ba24cfd4a92c525b77a0027a001033e9; digest aabd63f6c16224fca46661f4bec6f607d83b2fd0c96043c54288f8ae6dca2b66
- tabellio-validation: available; version 658453d2eec9971f2c14284548f5f278c69432d6; digest 3876ee7b79c55db3698f09bfa9dc8fcd28d92d0185d3219ddcd06397fda04cb9
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version 9c380bcf43daf42442078dadfec1f1f1a124962e; digest 6ea9aa02fe49e49696461f7dd17c6acd308fde5a324ecfb0f6e1153b9c50e481
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable

### IntelIP/Probanda

- HEAD: `e354f0647f879637dd1ccf9d63d38b735177fbdd` at 2026-07-23T11:04:11-07:00
- git: available; version e354f0647f879637dd1ccf9d63d38b735177fbdd; digest 55cca2876c5292f3d124cab61d25f025c49dff059792c2f3e8f05107a78d2c27
- tabellio-validation: blocked; version a2c6d1c2e854a54b57d7a13b4b93276169db05d1; digest unavailable
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: unavailable; version unknown; digest unavailable
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable

### IntelIP/Tabellio

- HEAD: `788962498fe0a692a5f4eb6f9c63c4a3b2933fb8` at 2026-07-23T21:46:10-07:00
- git: available; version 788962498fe0a692a5f4eb6f9c63c4a3b2933fb8; digest 685f27242bce050aebdfa7de1e5abfcd7ffa3a97b20976cf26ef2c94b6972bf1
- tabellio-validation: blocked; version 503c79493720e9d9195febb00f45b267883f2515; digest unavailable
- tabellio-review: available; version 405ce913edb0382d7289242e180506ca680711d9; digest 07d09b21ae1e8f0aadb62df0cf30d9a8b198a53472414c8d704894cea4faa8de
- entire: available; version 6599b1708772ab3ac96c90ff97ede46ccf137051; digest b68184fb792b79624bed15a5cb37e7150c3658722d3d492cc55559f409a43ad9
- plane: available; version 2026-07-21T17:35:56.770229Z; digest 5eaf5e9b18072e180a0a4d673978921f61b86e2d74f0142cdb288609bc77e6f4
- github: available; version 2026-07-23T18:15:21Z; digest a4951e4e2c300b1d0cee95636e3ccbd92c38fc1da3da6a13060bb6ffc7112031
- github-actions: available; version 2026-07-23T17:16:42Z; digest 1660d0a3096a84cb9eb8a137df63b291db6c482101280cb34ebc13ac5c41b6aa

### IntelIP/vaticor

- HEAD: `3ac0bc738f7da0896ec23606e59bc8001a28bf10` at 2026-07-23T21:48:38-07:00
- git: available; version 3ac0bc738f7da0896ec23606e59bc8001a28bf10; digest bedb83a7416ceafdc197a284c397139a27f4f607f2668d1fa2d8378830032d08
- tabellio-validation: blocked; version 5bf60611ac2a87f856cea0c5a04261d2fbb7789d; digest unavailable
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version a162aa6361c46a479dd180bcab687d0a4fff55c7; digest 3114a1a82870e7b7dc47c9467361ec9edaf5ee163b68a7d1241364d05be5f960
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable
