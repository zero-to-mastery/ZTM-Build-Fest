# Member and Device Identity Acceptance

This contract covers the identity choice shared by onboarding, People & devices,
pairing and notification settings. It supplements [Identity](IDENTITY.md),
[Pairing](PAIRING.md), [Privacy](PRIVACY.md), and
[Push notifications](PUSH.md). The stable member ID remains authoritative for
membership, permissions, event authorship and notification filtering.
It defines acceptance for the linked identity stories; a matrix row is not a
claim that its preferred-name or presentation behavior has shipped.

## The choice shown to a member

Kin presents two separate actions before it shows a code, QR scanner or
approval ceremony:

- **Invite another person** — creates one new member ID. The person gets their own
  household member identity, access according to their role, and can receive
  notifications about other members' changes after opting in on each device.
- **Add my device** — keeps the same member ID. This is still you on another
  phone or computer. The installation gets its own device ID and keys under
  your member identity, and your same member's devices are not notified about
  your changes.

The selection persists through QR and manual-code variants. A member must
never have to infer the result from a generic “Pair” action. Back or Cancel
returns to this choice without creating membership, trusting a device or
provisioning keys.

Both sides of a pairing name the path in progress before anyone confirms it
(#223). The member who made the code sees **Adding your own device** or
**Inviting another person** (with the invited role) beside the code, and the
waiting status says who is expected to enter it. The device that entered the
code sees **Adding this device to your membership** or **Joining as a new
household member** while it waits for approval and again before activation.
The joining device is not told a role, because the claim response does not
carry one.

A code never silently switches paths. If someone chose **Add my device** and
then enters an invitation code, or chose to join and then enters a
same-member device code, Kin explains the difference and keeps **Activate
with passkey** disabled until they tick an explicit acknowledgement, in
addition to the fingerprint comparison. If the choice is unknown (for
example after a reload), only the path statement is shown. The service still
decides every code's real purpose; this is presentation and a confirmation
gate, not new authority.

A preferred name is presentation only; it may be changed without changing the
member ID. A device label or name is not proof of identity or authority. “You”
and “This device” are contextual labels, not stored roles. When encrypted name
events are unavailable, late or from a newer format, the UI falls back to the
existing member/device labels and stable IDs without blocking authorization,
revocation or offline use.

## Notification contract

Content-free push is for changes authored by other active members. The server
filters by stable author member ID, not preferred name, device label or current
device ID; all same member's devices are excluded from that member's own
changes. Subscription and mute are per-device opt-in controls. A member can
therefore enable notifications on one device and leave another off.

The two-member diagnostic is: Member A opts in on one device, Member B commits
a change, and Member A receives one generic notice. A change from Member A on
any of Member A's devices produces no notice for Member A. Diagnostics report
eligibility and local subscription state only. There is no direct-send action,
no read receipt and no presence signal.

## Security and privacy invariants

- Preferred names and member/device relationships must remain inside encrypted
  household events when implemented. The relay may retain the existing
  automatic technical device name required before provisioning, but must
  receive no typed nickname or preferred member name.
- Existing passkey checks, device-key fingerprints, member enrollment,
  provisioning, revocation and role authorization remain the authority.
- Notification filtering uses the authenticated stable member ID and preserves
  the content-free payload and existing subscription deletion rules.
- Existing memberships and named devices migrate without forced renaming or a
  new identity. Missing or out-of-order presentation events use fallbacks.
- Acceptance requires no regression to encryption, authorization or
  notification filtering. A friendly label can never grant access.

## Cross-platform acceptance matrix

“Automated” means a repository test can establish the invariant without
claiming physical-device, browser-vendor or assistive-technology coverage.
“Manual” names evidence that must be collected on a release candidate.

| Scenario | Expected result | Evidence |
|---|---|---|
| Two members | Invite another person creates a distinct member ID; each person is grouped with only their devices; “You” follows the signed-in member; the other member's change is eligible for a content-free push. | `server/pairing-service.test.mjs` invitation tests and `server/push.test.mjs` author-member filtering; manual end-to-end two-profile drill. |
| One member, multiple devices | Add my device keeps one member ID, creates a distinct device ID/key pair, marks only the active installation “This device”, and sends no self-authored push to either device. | `server/pairing-sync-keys.test.mjs` same-member enrollment, `web/sync/crypto.test.mjs` recipient-bound encryption and `server/push.test.mjs` all-author-device exclusion; manual grouped-device check. |
| QR invitation | The screen says Invite another person before scanning; the fragment remains local; scan alone grants nothing; both parties confirm the new-member outcome and compare fingerprints. | Automated QR/parser/pairing tests; physical-camera scan is manual. |
| Manual invitation | The same new-member explanation and authority checks apply when the short code is typed or copied. | Automated pairing service tests and manual copy entry. |
| QR same-member pairing | The screen says Add my device or Sign in with my phone; no member is created; the device generates its own keys and requires trusted-device approval. | Automated link-request, fingerprint and provisioning tests; physical-camera scan is manual. |
| Manual same-member pairing | Typed-code enrollment retains the member ID, creates a device identity, compares fingerprints and provisions retained epochs only after approval. | Automated pairing/provisioning tests and manual two-profile drill. |
| iOS installed PWA | The installed app reflows at narrow width, exposes both identity choices, explains that push requires Home Screen installation, and keeps notifications device-local. | Manual on physical iPhone/iPad; not certified by desktop emulation. |
| Android | Installed/browser paths expose both choices, camera denial leaves manual entry usable, and notification permission denial leaves Kin usable. | Manual on a physical Android device. |
| Desktop | Keyboard and pointer users can select either path, scan with a phone or type a code, identify “This device”, and manage this device's notification state. | Browser regression plus manual desktop passkey/link drill. |
| Offline | Existing names, groups and local controls render from encrypted local state; starting an invite or device link explains that a connection is required and grants nothing. | Automated local-state/offline regression where available; manual network-loss drill. |
| Rename propagation | A preferred member name or device nickname converges through encrypted events; delayed events use deterministic fallback; permissions and push filtering do not change. A device without a nickname shows its owner's name beside its automatic name, and a rename never overwrites a nickname. | `rust/src/member_name_tests.rs` (order-independent convergence, duplicates, own-name-only, canonical names, bindings), `web/wasm/kin-engine.test.mjs` real-engine names, `web/components/household/member-labels.test.mjs` and `web/components/kin-household.test.mjs` name editor and labels; manual multi-device display check. |
| Accessibility | Each choice has a persistent heading, outcome and native control; status is not color-only; focus is visible and logical; 320 px, 200% zoom, forced colors and reduced motion remain usable. | Browser accessibility regression plus keyboard and assistive-technology review. |
| Localization readiness | Choice labels, outcomes, errors and status are complete non-concatenated sentences; layout permits text expansion and wrapping; names are inserted without English possessive construction; no logic compares translated copy. | Documentation regression plus pseudolocale/translated-copy review when the UI ships. |
| Existing-member migration | Existing member IDs, roles, credentials, devices, automatic names and nicknames remain valid; absent preferred names get a fallback and no forced rename. | Frozen-format/migration suites; `MEMBER_NAMED` is additive (no stored format changes, absent names fall back in `kin-household.test.mjs`); a retained-profile upgrade drill. |

## What CI cannot verify

CI does not certify camera behavior or installation/push permission UX on
physical iOS, physical Android or other vendor devices. It cannot establish
delivery by Apple, Google, Mozilla or Microsoft push services; biometric/PIN
prompts; authenticator-specific passkey behavior; OS-level notification
display; real background suspension; or offline transitions imposed by a
mobile OS. Desktop emulation is not evidence for an installed iOS PWA.

CI also does not replace a manual VoiceOver, NVDA or TalkBack pass, household
comprehension testing, pseudolocale and translated-locale copy review, or a
physical two-person/two-device ceremony. Release evidence must name the tested
browser, OS, device, assistive technology and any unverified row instead of
marking the whole matrix complete.
