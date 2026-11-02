# Pre-v0.39 Stabilization

This working matrix follows [`POST_V0.38_TRUST_AUDIT.md`](POST_V0.38_TRUST_AUDIT.md).
No blocker is resolved until its original reproduction is rerun successfully.

## Remediation matrix

| Blocker | Root cause | Fix milestone | Regression test | Status | Commit |
|---|---|---|---|---|---|
| B-001 | Replay treats a greater Lamport time as proof an offline device observed an archive. | v0.38.2 | Original offline archive conflict; Rust distributed replay order permutations; future valid event after stale completion. | RESOLVED | ef4c807 |
| B-002 | Responsibility replay rejects any assignment/clear after an archived target; automatic reconciliation emits the clear. | v0.38.2 | Original concurrent Responsibility/archive repro; deterministic cross-device no-op regression. | RESOLVED | ef4c807 |
| B-003 | Relay accepts unbounded decimal logical times, and remote batch replay aborts atomically on one invalid event. | v0.38.2 | Original poison/time repro; shared ceiling/advance checks; invalid remote event quarantine followed by valid replay. | RESOLVED | ef4c807 |
| B-004 | Last-Adult checks count active Adult records without checking a usable passkey and trusted device. | v0.38.3 | Original HTTP sequence; no-device/revoked-device safety; two usable Adults. | RESOLVED | 5d805bc |
| B-005 | Device revocation is a session-only DELETE with no target-specific confirmation, accessible name, or fresh passkey. | v0.38.3 | Session-only denial; wrong-member and valid fresh-auth flows; named-control UI regression. | RESOLVED | 5d805bc |
| B-006 | Sync enable authorizes participation but does not require Adult trust authority. | v0.38.3 | Original HTTP repro; Limited/Temporary denial; Adult enable and member participation. | RESOLVED | ef4c807, 5d805bc |
| B-007 | Service-worker cache name is frozen at v0.34 and install writes into the active cache. | v0.38.4 | Version consistency, separate staging, failed staging retention, activation cleanup, offline shell. | RESOLVED | ef4c807, v0.38.4 milestone |
| B-008 | Protected archive serialization has a 64 MiB ceiling although encrypted attachment storage allows 50 MiB. | v0.38.4 | Original 11/12/13 attachment repro; single/multiple/aggregate/archive bound and digest checks. | RESOLVED | v0.38.4 milestone |

## Original repro baseline

Run with Node 22.21.1 unless otherwise noted:

| Blocker | Baseline result |
|---|---|
| B-001 | REPRODUCED: merged offline completion fails replay with code 4. |
| B-002 | REPRODUCED: equal-time Responsibility change and clear fail with code 4. |
| B-003 | REPRODUCED: invalid responsibility poisons replay; 2^64-scale times pass the relay contract and exhaust subsequent writes. |
| B-004 | REPRODUCED: Adult A revokes B's only device and leaves; no usable Adult path remains. |
| B-005 | REPRODUCED by audit code-path inspection: generic “Revoke device” button and session-only DELETE. |
| B-006 | REPRODUCED: Temporary enables sync and Adult sees it enabled. |
| B-007 | REPRODUCED by audit code-path inspection: static worker cache is v0.34.0. |
| B-008 | REPRODUCED: 12 valid attachments (48.05 MiB) fail serialization at the old 64 MiB protected-value cap. |

The initial default Node runtime was 22.12.0, below Kin's declared 22.13 floor; B-004 and B-006 were rerun on the installed 22.21.1 runtime.

## Closure

| Blocker | Status | Fix commit | Original repro result |
|---|---|---|---|
| B-001 | RESOLVED | ef4c807 | Original script: merged replay succeeds. |
| B-002 | RESOLVED | ef4c807 | Original script: completion and equal-time Responsibility set/clear all replay. |
| B-003 | RESOLVED | ef4c807 | Original script: poison quarantined, following valid event replays, large times rejected. |
| B-004 | RESOLVED | 5d805bc | Original HTTP script: generic DELETE gets 401; self-leave gets `last_adult`; usable Adult device remains. |
| B-005 | RESOLVED | 5d805bc | Original session-only DELETE gets `fresh_auth_required`; fresh target-bound passkey path is covered by HTTP tests. |
| B-006 | RESOLVED | ef4c807, 5d805bc | Original script: Limited/Temporary receive `adult_required`; Adult enable and authorized participation succeed. |
| B-007 | RESOLVED | ef4c807, v0.38.4 milestone | Version check and service-worker tests: release-derived cache stages fully, retains old cache on failure, cleans on activation, and serves offline shell. |
| B-008 | RESOLVED | v0.38.4 milestone | Original script: 0/1/11/12/13 attachments export, including exactly 50 MiB aggregate; browser and relay bounds pass. |

The original repro scripts for B-001, B-002, B-003, B-004, B-006, and B-008
were rerun with Node 22.21.1 after the corrective code was in place. B-005 and
B-007 were code-path findings without standalone scripts; their original
session-only DELETE and static cache failures were checked against the new HTTP
and service-worker regressions. Real installed-browser update remains
UNVERIFIED — ENVIRONMENT.

## Readiness

PRE-v0.39 STABILIZATION READY FOR HUMAN REVIEW.
