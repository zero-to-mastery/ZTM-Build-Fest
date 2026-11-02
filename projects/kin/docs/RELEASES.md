# Release Process

**Status:** Current release: v1.6.0 — Kin for Everyone,
released 2026-10-21 as `kin-v1.6.0`. The release before it was v1.5.0 —
One Account and Private Spaces (`kin-v1.5.0`). Neither is production certification or an
independent audit.

Before any v1.x release, check it against the
[v1.0 compatibility commitment](V1.0-COMPATIBILITY.md): a release may add
formats but must keep reading every v1.0 format, and CI fails if a frozen
version changes without that document.

## Release sequence

The completed progression is `kin-v0.9.3` → `kin-v0.10.0` (Portable Core + Local
Data Security) → `kin-v0.10.1` (Security Lifecycle & Sync Recovery Correctness) →
`kin-v0.10.2` (Local Root Rotation & Recovery Lifecycle) →
`kin-v0.10.3` (Bounded Storage/Archive Hardening & Architecture Closure). The
v0.11.7 review baseline includes the v0.11.0 through v0.11.5 Durable
Service & Deployment gates, the v0.11.6 documentation/comment patch, and the
v0.11.7 October Roadmap & Startup Diagnostics patch. The tagged v0.12.3 review
candidate implements lifecycle capability, correctness, stale-device hardening
and UX/docs; the tag does not indicate publication.
The [roadmap](ROADMAP.md) records the candidate progression from v0.11 through
v0.47.0. The v0.21.0–v0.47.0 candidates were never tagged; together with the
tagged v0.11.x–v0.20.x review lines they shipped in v1.0.0, per the
[review-gate decisions](audits/V1.0_REVIEW_GATES.md).
v1.0 requires the readiness properties of every preceding line, not
only architecture/security and UX/UI. Use the release-specific planning contracts
and [V0.10.0](planning/V0.10.0.md); do not manufacture patch releases or knowingly defer a
necessary correctness fix. Create tags only after completed validation and
requested approval, never at development start. A specifically authorized
review-candidate tag does not represent a published release.

v1.1.0 adds device names, household home-screen identity, opt-in content-free
push notifications, a sandboxed Node service, and QR pairing/phone-approved
computer sign-in. It preserves the v1.0 formats and reads v1.0 data under the
[compatibility commitment](V1.0-COMPATIBILITY.md); server schemas 10 and 11
are forward migrations, so keep a pre-upgrade backup if rollback matters.

v1.6.0 makes Kin easier for someone who rarely uses apps (ADR 0021, epic #603): easy mode, Help on every screen, household features an admin can switch off, reporting a problem or suggesting a feature (optionally forwarded to GitHub issues) and setting Kin up for someone else. It also adds the Android app for Google Play, the public privacy policy and the Play release runbook (ADR 0020, epic #527); the app is built in CI but not yet published. Server schemas 25–27 are forward migrations, so keep a pre-upgrade backup if rollback matters; an older device ignores switched-off features except that Chat and the Fridge stop working for it while they are off.

v1.5.0 adds accounts (ADR 0018: username and password, an optional passkey, a backup code, signing in on a new device, and moving an existing household to accounts) and each member's private space (ADR 0019: a private log and relay stream, the journal, Just for me, and reminders and settings that follow the member, with a private export). Server schemas 21–24 are forward migrations, so keep a pre-upgrade backup if rollback matters; a device set up with a password must not be downgraded below v1.5.0, and once a member has endorsed their certification key the server must not be rolled back.

v1.4.0 adds the family fridge (its own board log and relay stream), Meals, Simple view for Limited members, item pictures, Talk later in Chat, undo and redo, share into Kin, shopping mode with store sections, list import, This week, the sitter page and taking turns on routines. The new kinds are additive (replay protocol still 24) and server schemas 18–20 are forward migrations, so keep a pre-upgrade backup if rollback matters; an older device that receives a new household kind pauses sync until it updates.

v1.3.0 adds members' own preferred display names (an additive household event, kind 51) with friendly device labels, makes inviting another person explicitly different from adding your own device, and ships the first #261 onboarding and feedback slices. It changes no v1.0 format and no server schema; an older device that receives a name pauses sync until it updates.

v1.2.0 adds one household chat room, as decided in ADR 0008. It has its own event log, relay stream, content blobs and admin access policy, and it adds server schemas 12–17 as forward migrations. It changes no v1.0 format.

v1.1.2 shows the private household name and icon in the unlocked shell and keeps
that identity synchronized across session transitions. Locked and unassociated
surfaces retain generic Kin branding. It introduces no persistent-format or
protocol version changes.

v1.1.1 clarifies member/device identity, pairing choices and device trust, and push
recipients and diagnostics. It introduces no persistent-format or protocol
version changes.

```text
scope complete
      |
      v
validation and documentation updated
      |
      v
inspect git status and diff (Kin paths plus explicitly authorized integration files)
      |
      v
release commit
      |
      v
verify clean working tree
      |
      v
annotated kin-vX.Y.Z tag on that commit
      |
      v
push commit/tag when explicitly authorized
```

A tag is created only for a completed, validated milestone. Use a descriptive annotated tag such as `kin-v0.0.8` or `kin-v0.1.0`. Never use generic tags such as `v0.1.0`; the repository contains multiple independent projects. Published tags are immutable: do not move, force-update, or reuse them. Correct a released mistake with a new patch version.

Before a new version starts, verify that the previous completed Kin version has its matching tag. Inspect the entire worktree and stage/commit only paths under `projects/kin/`. Do not include another contributor's changes.

The v0.10.1 patch starts from the completed v0.10.0 commit `2dc94f8`.
At the user's publication request, the missing annotated `kin-v0.10.0` tag was
restored on that commit and pushed to `origin`. The existing published annotated
`kin-v0.10.1` tag remains on `e65db23`. The branch
`kin-v0.10.1-security-correctness` is pushed for PR review into `kin-development`;
kin-main/kin-development merges remain separate actions.

## Changelog

Maintain the project-scoped [changelog](../CHANGELOG.md) for each completed release. Add an entry from the validated changes before committing and tagging; summarize what actually changed, not planned or deferred behavior. Keep prior release entries intact. Planning releases should be identified as documentation/planning work rather than implemented product features.

Every version has one level-two heading, `## vX.Y.Z — Release Title`, newest
first. A version that never received a tag says so in an italic line under
its heading (`_Not tagged: …_`).

## Semantic version intent

Semantic versioning describes Kin's product release; persistent event, ABI, storage, and export versions remain independent contracts, as described in [VERSIONING](VERSIONING.md).

- **Patch (`0.1.x`):** bug fixes, security hardening, documentation corrections, or compatible implementation improvements.
- **Minor (`0.x.0`):** a planned new product capability that preserves the supported contracts where reasonably possible.
- **Major (`x.0.0`):** a substantial product or compatibility break once Kin has a mature enough public compatibility promise to warrant it.

For each approved minor capability, use these initial stabilization patches when meaningful work exists:

```text
v0.N.0 — new product capability
v0.N.1 — correctness
v0.N.2 — resilience and accessibility
v0.N.3 — hardening and polish
```

After `.3`, stop and ask the user whether the line is satisfactory before beginning another feature. Additional fixes remain normal patches (`.4`, `.5`, and onward); do not use four-part versions or manufacture unnecessary patch releases. A new minor version requires both a genuinely new product capability and explicit user approval. Each completed version gets its own annotated, namespaced tag on the validated release commit.

Before maturity, do not overpromise strict public API stability. Still document compatibility effects and provide migration/recovery expectations before changing persistent contracts.

## Release checks

For documentation milestones, validate required documents, internal links, scope, and absence of application code. For coded releases, use the release gate defined in [V0.1.0](planning/V0.1.0.md) and any later release-specific criteria. Report the release commit, exact tag, and whether each was actually pushed. When publication is not authorized, provide the exact `git push origin kin-vX.Y.Z` command and do not claim the release is published.

## v0.4.0 Talk

Use kin-v0.4.0-development; create dedicated commits and annotated kin-v0.4.0 through kin-v0.4.3 tags only after each full validation gate. Stop after v0.4.3; no automatic push or kin-main merge. See [V0.4.0](planning/V0.4.0.md).

## v0.5.x Pulse

Dedicated validated commits and annotated kin-v0.5.0 through kin-v0.5.3 tags. Stop after v0.5.3. See [V0.5.0](planning/V0.5.0.md).

## v0.6.x Since You Last Looked

Create dedicated validated commits and annotated `kin-v0.6.0` through `kin-v0.6.3` tags. Preserve protocol v1–v5, schema-1 event bytes, and IndexedDB schema 1. Do not push or merge automatically. Stop after v0.6.3 and hand control back for release-line evaluation. See [V0.6.0](planning/V0.6.0.md).

## v0.7.x Routines

Follow [V0.7.0](planning/V0.7.0.md) for capability, correctness, resilience/accessibility and hardening gates. Release protocol v7 and new schema-1 kinds 14–17 without altering older contracts. Keep IndexedDB schema 1. Each completed milestone gets its own validated commit and annotated tag.

## v0.8.0 Household Pairing

The v0.7.x line completed at `kin-v0.7.4`, validated commit `a8ded079be6fdbedba8738a64a5f0fb753e7fdd6`, pushed to the fork. The v0.8 record is [V0.8.0](planning/V0.8.0.md); `kin-v0.8.8` corrected active-member slots. The v0.9 record is [V0.9.0](planning/V0.9.0.md). The merged v0.9.3 base and completed v0.10 implementation line are recorded in [V0.10.0](planning/V0.10.0.md). v1.0 remains gated by local security, durable service, lifecycle/deletion, recovery/continuity and UX/UI readiness. Later implementation candidates do not change the last-published v0.10.3 status.

For v1.0.0 and later releases, see the [changelog](../CHANGELOG.md), the
[versioning matrix](VERSIONING.md) and the
[v1.0 compatibility commitment](V1.0-COMPATIBILITY.md). The root verification
workflow is release evidence, not a publication or tag.

## Release candidates

A release candidate is an annotated `kin-vX.Y.Z-rc.N` tag (for example
`kin-v1.0.0-rc.1`) on the commit that would become `vX.Y.Z`. The version in
`package.json`, `Cargo.toml` and the app is already `X.Y.Z`: the service
worker and the version check accept only plain `X.Y.Z`. Deploy the candidate,
run the acceptance smoke on it, and if it holds with no new P0/P1 findings,
put `kin-vX.Y.Z` on the same commit. If it needs a fix, the fix gets a new
commit and `rc.N+1`.

## Publishing on GitHub

From v1.0.0 on, a release is published when it has a GitHub Release on its
`kin-vX.Y.Z` tag, with notes taken from its [changelog](../CHANGELOG.md)
entry, including known limitations and the compatibility commitment. Release
candidates are published as pre-releases. Before v1.0, "published" meant a
pushed release tag (v0.10.3 was the last); none of those tags has a GitHub
Release. Whether to add Releases for them is item G8 in
[V1.0_REVIEW_GATES](audits/V1.0_REVIEW_GATES.md); the recommendation is not
to.

## Home-server releases

Home servers update themselves from the GitHub Release of each
`kin-vX.Y.Z` tag ([HOME-SERVER](HOME-SERVER.md#updates), ADR 0025 §10,
#722). Only full releases count: a pre-release is never offered.

**Once: the release key.** On an offline computer that will keep it:

```sh
node scripts/release-key.mjs /secure/kin-release-key.pem
```

It writes the Ed25519 private key (mode 0600, never overwriting one) and
prints the public key. Put that in `server/home/release-key.mjs` and release
as usual; home servers check for updates from that release on. Keep a second
copy of the private key somewhere as safe. It never goes online, into the
repository or into CI: whoever holds it can publish an update every home
server installs. To change keys, put the new public key in a release and
sign that release with the old key; later releases are signed with the new
one.

**Each release.** Build the executables (`node scripts/build-sea.mjs`), copy
the build folder to the offline computer, and sign it there:

```sh
node scripts/sign-release.mjs target/sea/dist --key /secure/kin-release-key.pem
```

It checks every executable against `SHA256SUMS`, writes
`kin-home-manifest.json` (by default only the same major version's
`x.0.0` and later may update to it; `--minimum` changes that) and its
signature `kin-home-manifest.json.sig`, and checks the signature. Attach
both files, the executables, `SHA256SUMS` and the Windows service host to
the GitHub Release.

## Google Play

Kin's Play app (epic #527) is a thin wrapper that opens the production site,
so a Kin release normally reaches it with no Play release. When the wrapper
itself changes, or the service starts collecting something new, follow
[PLAY-RELEASE](PLAY-RELEASE.md): the one-time Play setup, the closed test,
production submission, web release versus Play release, version codes,
staged rollout, the asset-links fingerprints on the server, and rollback. The
listing text, graphics and Data safety answers are in
[PLAY-LISTING](PLAY-LISTING.md).
