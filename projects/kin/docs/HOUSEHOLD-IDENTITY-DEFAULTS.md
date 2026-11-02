# Household Identity & Shared Appearance

**Shipped in:** v1.0.0 (developed as the v0.47.0 candidate on `feat/kin-household-owner-settings`)
**Base:** Personal Appearance v0.46.0 candidate at `158160ad4bc84a12b7346a4dfd5facf82f8cccca`

## Authority

The member created by household bootstrap is recorded as `owner_member_id` (the founder) and is the household's first **household admin**. Admin status is a server-recorded flag (`members.household_admin`) that only an active Adult can hold. The service derives it from the authenticated session's durable member and device records; request fields such as `ownerId`, `isOwner`, `admin`, `householdAdmin`, role, or display name are ignored.

An admin can make another active Adult an admin or remove admin status, using the same fresh-passkey ceremony as member removal (`POST /api/household/admins/options` and `/finish`). Children/Limited members and babysitters/guests (Temporary members) can never be admins. Kin refuses to demote, remove, or let leave the last admin who still has a passkey and a usable trusted device, so a household with a recorded admin always keeps one. Demoting an admin revokes any member invitations and member recoveries they had pending. Recovering an admin's identity is checked again when the recovery is approved, against the approver's and target's roles at that moment, not only when it was started. Grants and revocations are audited as `household_admin_granted` / `household_admin_revoked`.

| Action | Household with an admin | Legacy household with no admin |
|---|---|---|
| Invite or approve a new member (Adult, Child/Limited, Babysitter/Guest) | Admin | Any Adult |
| Remove another member, revoke another member's device | Admin | Any Adult |
| Request or cancel household deletion | Admin | Any Adult |
| Recover an admin's identity | Admin | n/a |
| Recover a non-admin member, manage own devices, key provisioning and rotation | Any Adult | Any Adult |
| Change shared household settings | Admin | Nobody (fails closed) |
| Grant or remove admin status | Admin | Nobody (fails closed) |
| Publish or withdraw the home-screen install identity | Admin | Nobody (fails closed) |
| Remove an attachment in the app | Any Adult | Any Adult |
| Delete an attachment's encrypted copy from the relay | Its uploader or any Adult | Its uploader or any Adult |

Settings reads require an active household member on a trusted device. Writes require that same authorization plus admin status. Removal, expiry, device revocation, deletion state, and session expiry therefore fail before the admin check.

Schema migration 9 records which member uploaded each attachment's encrypted bytes to the relay: the first device to upload them, which is normally the device that attached the file, but can be another member's device that re-uploads a cached copy after the relay lost it. Attachments stored before it have no recorded uploader, so only an Adult can delete them. The relay audits each deletion as `attachment_deleted` (attachment, member and device IDs; no content).

Schema migration 8 makes each recorded founder-owner an admin. It deliberately leaves ownerless legacy households without one. Kin does not infer an admin from member ordering, activity, device possession, or adult status. Those households keep the earlier Adult-level management so they remain usable, but shared-setting writes and admin grants fail closed. Claiming admin status in a legacy household is deferred for explicit security review.

The Identity & defaults management panel is absent from the rendered and accessibility trees unless the authenticated settings response identifies the current member as an admin. The Household access screen shows admin, invitation, and removal controls only when the server's household view reports `canManageMembers`. The server enforces every one of these rules independently. Other members keep their personal appearance controls.

## Protected contract

`household_settings` stores one household-scoped opaque ciphertext, its key epoch, SHA-256 integrity digest, monotonic revision, authenticated writer IDs, and update time. The client payload is version 1 and contains the normalized household name, its private in-app icon choice, plus appearance mode, color source/seed, manual color metadata, and the processed optional image. The icon is either a generated first grapheme or a metadata-free, bounded 512-pixel PNG produced by the existing install-icon pipeline. The service cannot read the name, private icon, or appearance image. A write supplies the last observed revision; stale writes receive a conflict and never overwrite a newer value. The service accepts a write only at the authoritative active epoch, while rotation is not pending, and only from a device provisioned for that epoch. The encrypted record survives restart and is removed with household data.

Names are trimmed and NFC-normalized, must be nonempty, contain at most 80 Unicode code points and 240 UTF-8 bytes, and may not contain control, formatting, or surrogate characters. UI rendering must use text nodes/textContent. The unlocked header uses the private household name and icon; an uploaded icon is shown only after it decodes, with the generated initial as its fallback. Locked and signed-out shells retain the neutral `Kin` title and built-in K. The manifest and installed-app identity are Kin unless an admin publishes an install identity (below); publishing copies the chosen icon to the plaintext install record but does not make that record the source of truth for unlocked UI.

## Published install identity

Since v1.1 (#78) an admin can choose, in Identity & defaults → **Home screen**,
to show the household's name and icon when Kin is installed, instead of "Kin".
This is opt-in and off by default. It is a **separate, plaintext copy** of the
private household identity, and the service still can't read the encrypted
source. Withdrawing this copy changes only installed-app presentation; the
unlocked header continues to use the encrypted name and icon.

- **What is published.** The household name (the saved name, by the rules
  above), a short name for under the icon (at most 12 characters), an optional
  description (at most 200 characters) and four PNG icons of at most 512 KB
  each: 192 and 512 pixels, a 512-pixel maskable icon whose content stays
  inside the safe zone (a centred circle of 40% radius) for launchers that crop
  to a shape, and a 180-pixel icon for iPhone and iPad. (The issue proposed
  256 KB; a 512-pixel photo saved as PNG often exceeds that, so the cap is
  512 KB.) The icon is the first character of the
  household name on the household's accent colour, or an uploaded image that
  is centre-cropped and redrawn in the browser (no metadata survives). The
  service checks each PNG's header and size only; it never decodes an image.
- **Before the first publish** the panel says: "Your household name and icon
  will be stored by the Kin service without encryption so devices can show
  them on the home screen. Everything else stays encrypted." The admin must
  confirm before saving.
- **Storage.** Server schema 10 keeps one row per publishing household in
  `household_install_identity` with a revision that only grows (a second table
  remembers the last revision after a withdrawal). A write supplies the
  revision it last saw; a stale write gets a conflict. Each row also stores a
  hash of its content, which names the icon URLs and the manifest ETag, so
  they change whenever the content does, even if a backup restore repeats a
  revision.
  Writes are audited as `install_identity_published` / `install_identity_withdrawn`.
- **Who sees it.** `GET /manifest.webmanifest` and `/install-icon/*` resolve
  the household from the browser's `kin_device` cookie. Only a trusted,
  unrevoked device of an active member of an active household gets the
  published copy; every other request gets Kin's built-in manifest and icon.
  There is no public URL. The manifest's `id`, `start_url`, `scope` and
  `display` never change, so installed apps update in place. The manifest is
  `private, no-cache` with an ETag of the household, the published content and
  Kin's own manifest (whose colours and shortcuts it carries over; each
  shortcut keeps Kin's own PNG icon for what it does, #473). The icon
  URLs in the manifest carry the content hash and are immutable. The
  `apple-touch-icon` link in the app shell is unversioned and revalidated,
  because the shell is the same for everyone; with nothing published it
  returns 404, so iOS keeps its own behaviour (Kin's own PNG icons, #473,
  have no 180 px size). The
  service worker caches neither. A browser still running the previous
  service worker can serve its cached Kin manifest until the v1.1 worker takes
  over, once every Kin tab has closed or the update is accepted.
- **Withdrawing** ("Stop showing") deletes the published copy; the manifest
  goes back to Kin. Household deletion removes it with the household's data.
  A renamed household keeps the old published name until an admin saves the
  home screen again; the panel says so.

| Platform | Picks up a change |
| --- | --- |
| Chrome and Edge on a computer | On a later launch, roughly daily. A name or icon change asks the user to accept it. |
| Android (Chrome) | At the next installed-app update check, which can take a day or more. Chrome may check without the device cookie, and then keeps the earlier name and icon. |
| iPhone and iPad | Never on its own. Remove Kin from the Home Screen and add it again. |

## Appearance precedence

Each property resolves independently: an explicit device-local personal value, then the saved household value, then Kin's built-in value. `undefined` means follow household; a Kin-default color is an explicit color source; and `image: null` is an explicit no-background choice. “Use household appearance” clears all local overrides. Saving household settings never rewrites the personal appearance record, including the owner's.

Shared images use the Personal Appearance validation, bounded resize, metadata-stripping re-encode, dominant-color extraction, and palette generation. The normalized image is included inside the authenticated encrypted settings payload, never exposed by a public URL, and any decrypted object URL is session-scoped and revoked on lock. A revision is applied only after the complete payload validates; image decode failure falls back to its readable seed palette.

## Offline, rotation, and lifecycle

Shared writes require a current online authenticated session and authoritative revision. No offline mutation is queued. After the service accepts a write, Kin stores that exact accepted envelope in the root-protected `kin-crypto-keys` IndexedDB database before reporting success. After transport decryption, digest verification, AEAD authentication, and content validation succeed, server reads update the same cache, scoped by household ID. A hard refresh or fresh offline unlock reopens that protected cache and decrypts it again with the recorded household epoch key; missing keys, routing mismatches, malformed records, and tampering fail closed. A lower server or cached revision cannot replace a newer validated cache, while a newer valid server revision replaces it after reconnection. The owner-editing capability is never restored from cache.

The decrypted header identity is session-scoped. Lock, logout, household switch, revocation, and deletion synchronously replace it with generic Kin branding and revoke its temporary icon URL before the locked shell is exposed. Uploaded-icon decode failure also uses the generic mark; a later verified settings refresh retries the current private revision.

The ciphertext records its epoch and is readable only by devices entitled to that epoch. Rotation pauses settings writes; after commit, a later save must use the new active epoch. Key rotation does not weaken historic read entitlement. Revoked/removed devices cannot read or write through the API, and queued forged writes have no special path. Household deletion removes the server record; archive restore alone does not restore server authority.

## Known limitations

- Claiming admin status in a legacy household is deferred.
- A published install identity is plaintext on the service and in its backups until it is withdrawn or the household is deleted. Installed apps already showing it keep it until their platform checks again (table above).
- The relay accepts and serves the encrypted revision; recipient receipt is not implied by write acceptance.
- An unavailable admin does not cause automatic promotion. If the only admin loses every device, other Adults cannot recover them, and admin actions stay unavailable. Households should keep a second admin. Authorized members retain read-only use of the last settings.
- "Child" is presented as the existing Limited member class and "babysitter" as the existing Temporary class. Kin adds no separate child or babysitter permission tier. Simple view ([ADR 0013](decisions/0013-simple-view.md)) is a calmer layout a household admin can turn on for a Limited member, not a permission tier: the service enforces only who changes it and Chat and Fridge access; everything else is hidden by the app, not prevented.
