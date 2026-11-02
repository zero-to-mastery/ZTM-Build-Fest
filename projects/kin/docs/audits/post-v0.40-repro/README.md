# Post-v0.40 live verification reproductions

Standalone Node (>= 22.13) scripts for findings recorded in
[LIVE_HOUSEHOLD_VERIFICATION.md](../LIVE_HOUSEHOLD_VERIFICATION.md). Run each
from any directory with `node <file>`. They use synthetic identities and
in-memory services only. The `b` prefix marks release-blocking findings and `p`
marks polish findings, following the post-v0.38 convention. Each script prints
whether the defect still reproduces against the current tree.

| Script | Finding | State on this branch |
|---|---|---|
| `b001-lifecycle-route-500.mjs` | `GET /api/household/lifecycle` always answered 500. | Fixed; prints the corrected 200. |
| `b002-revoked-sender-rotation-strands-adult.mjs` | Revoking the device that committed the latest rotation discarded undelivered key packages, so no remaining device could rotate past the epoch it never received. | Fixed; prints `Fixed:` with the retained committed package. |
| `b004-invitation-omits-inviter-key.mjs` | Invitation responses omitted the inviter key fingerprint, so the inviting client rejected them and never showed the code. | Fixed; prints `fixed` for both invitation routes. |
| `p001-rotation-omits-own-provisioned-epoch.mjs` | Rotation never recorded the new epoch for the rotating device, so other clients kept trying to provision it. | Fixed; prints `fixed` with the rotating device's epochs. |

The live multi-profile drill itself is `scripts/household-authority-regression.mjs`.
