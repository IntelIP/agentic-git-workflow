# INTB-261-cross-repository-baseline

Observed: 2026-07-23T22:44:48.000Z
Window: 2026-07-01T00:00:00.000Z to 2026-07-23T22:44:47.000Z
Dataset digest: `f3498c212abffbb79bbdc64deab430bdde3fdefffcf5b35a15196652ba1da937`

## Interpretation Boundary

Repository rows describe evidence coverage and delivery-system behavior. They do not rank developers, infer user value from commit volume, or compare incompatible missing denominators.

## Repository Baseline

| Repository | Head | Commits | Validations | Pass rate | Cost coverage | Entire checkpoints | Evidence coverage | Adoption | Dirty |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| IntelIP/Condere | `4ec36ff4ba24` | 121 | 75 | 93.3% | 97.3% | 2 | 42.9% | 66.7% | true |
| IntelIP/Probanda | `e354f0647f87` | 42 | 103 | 65.0% | 80.6% | unknown | 28.6% | 33.3% | false |
| IntelIP/Tabellio | `c9759d7c0e4d` | 31 | 71 | 90.1% | 80.3% | 10 | 100.0% | 100.0% | true |
| IntelIP/vaticor | `bdb25c6232e3` | 68 | 6 | 66.7% | 0.0% | 55 | 42.9% | 66.7% | true |

## Delivery Change Trace

| Repository | Change | Link basis | Plane | PR | Head | Exact validation | Hosted CI | Merged | Released |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| IntelIP/Tabellio | tabellio-pr-27 | manual-reconciliation | INTB-260 | 27 | `99cee522758b` | passed | passed | 2026-07-23T17:56:24.000Z | 2026-07-23T18:15:21.000Z |

## Missing Evidence

### IntelIP/Condere

- tabellio-review: unavailable — refs/tabellio/reviews is absent.
- plane: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github-actions: unavailable — No sanitized provider snapshot supplied to the read-only collector.

### IntelIP/Probanda

- tabellio-review: unavailable — refs/tabellio/reviews is absent.
- entire: unavailable — Entire metadata checkpoint ref is absent.
- plane: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github: unavailable — No sanitized provider snapshot supplied to the read-only collector.
- github-actions: unavailable — No sanitized provider snapshot supplied to the read-only collector.

### IntelIP/Tabellio

None.

### IntelIP/vaticor

- tabellio-review: unavailable — refs/tabellio/reviews is absent.
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
- git: available; version 4ec36ff4ba24cfd4a92c525b77a0027a001033e9; digest 83cbe98b25d5dc15ae801bbd3c0ecd1430d709d17f28e7ce55762ba96db36d5a
- tabellio-validation: available; version 658453d2eec9971f2c14284548f5f278c69432d6; digest 3876ee7b79c55db3698f09bfa9dc8fcd28d92d0185d3219ddcd06397fda04cb9
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version 9c380bcf43daf42442078dadfec1f1f1a124962e; digest 6ea9aa02fe49e49696461f7dd17c6acd308fde5a324ecfb0f6e1153b9c50e481
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable

### IntelIP/Probanda

- HEAD: `e354f0647f879637dd1ccf9d63d38b735177fbdd` at 2026-07-23T11:04:11-07:00
- git: available; version e354f0647f879637dd1ccf9d63d38b735177fbdd; digest 9b8fff7904f4e265befec14907299d14f8047f114cb083bb44f0fa6a61f969ac
- tabellio-validation: available; version 970412e7d10ff0a233ed32d42104616de3df1ac0; digest f5ec26e3b758b5686d3c1c243f20c7c34b927ca5270e8714b8e7f47de0db0c46
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: unavailable; version unknown; digest unavailable
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable

### IntelIP/Tabellio

- HEAD: `c9759d7c0e4d15aba8545e73d49b182ed64fc6bc` at 2026-07-23T10:56:23-07:00
- git: available; version c9759d7c0e4d15aba8545e73d49b182ed64fc6bc; digest bd517c288f1064112afde9e905ca0dcbfcba6bbfb2e71b66a6158c299d6a724b
- tabellio-validation: available; version 8eeca837596310bfb54fc92cb53d18409e2e43ac; digest 1971ff1fe32f537b7687ca08da92752c4e6a3f04e38f90c8a232b5ec1d26175d
- tabellio-review: available; version 7ed540ff39639ed4290c617cc2c933405651adbf; digest 1f4b64fe85b53a9181ddd7496608c19dba0a1da5a74990d820580b5c2e3bacb2
- entire: available; version 984fc31d3fec43eab3e699a4d13622174eeed1b2; digest 9051af958506f8fc12f935bd6b64738a6a7d1fb02a3ea7630a9bb845fdb35309
- plane: available; version 2026-07-21T17:35:56.770229Z; digest b706bd8b6e4bc6857435789aa5d377b36f515282e31d3a0e77cacd58cdf3dd36
- github: available; version 2026-07-23T18:15:21Z; digest e117b6bb87717d56aaa376684da231e621b7ee1aac2621fe617897408f4a8a84
- github-actions: available; version 2026-07-23T17:16:42Z; digest 3304f3ccb10050d343760b5a90641aab6394536f83631e03d729bbcefe6f3448

### IntelIP/vaticor

- HEAD: `bdb25c6232e383325f59938896d319fef74fa4d0` at 2026-07-23T10:38:31-07:00
- git: available; version bdb25c6232e383325f59938896d319fef74fa4d0; digest 8c72996cf87d8181482114fe0f0dcd40fb14d629c2b7b606137d198985225856
- tabellio-validation: available; version 5bf60611ac2a87f856cea0c5a04261d2fbb7789d; digest 3dccf1b059d95ea073b65f2f89162d3e272661f9045a88c72cd28f919c08608d
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version 4aae87d98727857ae69208db234c6fbf4c71adf1; digest 88c2465c35957ec8c74d6301c3500f6662cb2dacc028be2f0f87aaab78459f5d
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable

