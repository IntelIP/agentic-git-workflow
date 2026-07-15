# GitHub Code-Storage Boundary

GitHub has one narrow job in the Tabellio platform: store code and expose a thin pull-request shell. It is not the agent workflow database.

## Data Placement

| Data | Destination | Reason |
| --- | --- | --- |
| `refs/heads/*` code branches | GitHub `origin` | Shared source history and pull-request heads |
| `refs/tags/*` release tags | GitHub `origin` | Shared code release markers |
| Pull-request title, description, checks summary, and review decision | GitHub | Minimum human accountability surface |
| Entire transcript and checkpoint state | Private GitHub control repository | Private agent context stays outside the public code repository |
| `refs/tabellio/reviews` | Private GitHub control repository | Full machine review ledger may contain internal context |
| `refs/tabellio/validations` | Private GitHub control repository | Full validation evidence and logs remain independently governed |
| `refs/heads/entire/checkpoints/v1` | Private GitHub control repository | Agent-session checkpoints do not become ordinary code branches |

## Enforced Contract

`tabellio.platform.json` declares GitHub `origin` as code storage, a private GitHub repository under the `control` remote for external control state, and `publishControlRefsToCodeStorage` as `false`. The JSON Schema and runtime validator reject drift from those values.

The control-ref transport also rejects `origin` before reading or writing remote state. Callers must name a separate private GitHub repository remote for review, validation, and Entire refs. This makes a mistaken private-state push fail closed instead of relying on operator memory.

## Pull-Request Boundary

The pull request remains useful but thin. It carries the code diff, a concise change explanation, required check summaries, and the final review decision. Detailed agent transcripts, internal reasoning, full validation logs, and durable review events stay external. A reference or digest can bind the thin pull request to external evidence without copying that evidence into GitHub.

## Migration State

Legacy self-hosted collaboration code and local lab infrastructure have been removed. GitHub is the only supported hosted Git and review service: public code uses `origin`, while private control state uses a separately configured private GitHub repository.
