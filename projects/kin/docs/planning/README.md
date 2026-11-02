# Planning archive

Everything in this folder is **historical**. These documents planned, froze
or recorded Kin's releases from the first implementation (v0.1.0) through the
October 2026 push to v1.0.0. They are kept because later documents and the
changelog cite them as evidence, and because they explain *why* Kin is shaped
the way it is. They do not describe the current product boundary: for that,
read the [documentation map](../README.md), the [changelog](../../CHANGELOG.md)
and the current contracts it links.

Nothing here is a to-do list. Do not implement a feature because a plan in
this folder mentions it.

## Release contracts, v0.1 to v0.14

One document per early release line: the frozen capability contract, its
acceptance criteria and the validation evidence recorded when it shipped.

| Document | Release line |
| --- | --- |
| [V0.1.0.md](V0.1.0.md) | Household Heartbeat: the first implementation |
| [V0.2.0.md](V0.2.0.md) | Today + Needs |
| [V0.3.0.md](V0.3.0.md) | Handoff |
| [V0.4.0.md](V0.4.0.md) | Talk |
| [V0.5.0.md](V0.5.0.md) | Pulse |
| [V0.6.0.md](V0.6.0.md) | Since You Last Looked |
| [V0.7.0.md](V0.7.0.md) | Routines |
| [V0.8.0.md](V0.8.0.md) | Household Pairing |
| [V0.9.0.md](V0.9.0.md) | Encrypted Event Sync |
| [V0.10.0.md](V0.10.0.md) | Portable Core + Local Security (recovery, migration, measurements) |
| [V0.11.0.md](V0.11.0.md) | Durable Service & Deployment (the SQLite service, backups, operational boundaries) |
| [V0.12.0.md](V0.12.0.md) | Data Lifecycle, Retention & Deletion |
| [V0.13.0.md](V0.13.0.md) | Recovery & Household Continuity |
| [V0.14.0.md](V0.14.0.md) | UX/UI Consolidation, with its [design note](V0.14.3-DESIGN-NOTE.md) |

## October 2026 plan (v0.15 to v1.0)

The daily-release plan that took Kin from v0.15 to v0.47 and then to v1.0.0.
Most of these lines were never tagged on their own; they shipped together in
v1.0.0 under the owner's [review-gate decisions](../audits/V1.0_REVIEW_GATES.md).

- [releases/](releases/): one planned contract per line, V0.15.0 through
  V0.45.0, plus the [backup safety drills proposal](releases/BACKUP-SAFETY-DRILLS-PROPOSAL.md).
- [BUILD-FEST-CADENCE.md](BUILD-FEST-CADENCE.md): the one-minor-a-day cadence.
- [RELEASE-LINE-PROTOCOL.md](RELEASE-LINE-PROTOCOL.md): the `.0/.1/.2/.3`
  stabilisation pattern each line followed.
- [PRODUCT-BOUNDARIES.md](PRODUCT-BOUNDARIES.md): what the plan deliberately
  kept out.
- [BRIDGE-0.11-0.16.md](BRIDGE-0.11-0.16.md): how the platform lines led into
  the October sequence.
- [V0.41.0-MOBILE-EXPERIENCE-PLAN.md](V0.41.0-MOBILE-EXPERIENCE-PLAN.md): the
  mobile experience plan written before its code.
- [AGENT-HANDOFF-OCTOBER-2026.md](AGENT-HANDOFF-OCTOBER-2026.md),
  [REPLACEMENT-MAP.md](REPLACEMENT-MAP.md) and [MANIFEST.json](MANIFEST.json):
  the instructions and file manifest that drove the agent-assisted daily
  builds. They are kept as a record of how the project was run, not as
  instructions for anyone now; [AGENTS.md](../../AGENTS.md) is current.

## Pre-implementation preflight

Written before any code, to freeze what v0.1.0 had to deliver.

- [PREFLIGHT.md](PREFLIGHT.md): the specification audit that froze the v0.1.0
  handoff.
- [TRACEABILITY.md](TRACEABILITY.md): requirement-to-document traceability for
  the early contracts.

The canonical test vectors that the preflight defined are still live and are
kept with the current contracts: [TEST-VECTORS](../TEST-VECTORS.md).
