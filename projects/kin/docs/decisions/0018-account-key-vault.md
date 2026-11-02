# ADR 0018 — One account on every device: password, passkey as a second step, and an encrypted key vault

Status: **Implemented** (accepted with owner decisions D1–D5, 2026-10-20;
#547, epic #546). Every part is in: the vault (#564–#567), the first run
with a username and password (#557–#559), the no-cookie sign-in with the
certification key chain (#568–#570), adding a passkey with "require
password and passkey" (#560–#562), the backup code (#571–#573), the
migration of existing households (#574–#576) and the offline passkey
(#551–#553), with the hardening follow-ups of #592 (per-wrapper routes need
a fresh confirmation, removing a passkey, starting over on a browser, other
devices following a changed password). It changes four standing rules,
listed under "Rules this changes"; AGENTS.md, CRYPTOGRAPHY, IDENTITY,
RECOVERY, THREAT-MODEL, PRIVACY and PORTABILITY carry them.

## Context

Tester feedback (October 2026):

- People unlock with the 64-character recovery key every day. A password
  manager saves it as a login and offers it on the person's other devices,
  where it can't work, because **each installation has its own local root and
  its own recovery key** (CRYPTOGRAPHY, "v0.10 local key hierarchy").
- People expect a familiar sign-in: a name and a password, with a passkey as
  a second factor.
- A new phone or a wiped browser can only get the household's keys from
  another trusted device (PAIRING, RECOVERY). With no other device nearby,
  the person is stuck; with every device lost, the household is gone.
- The first run shows a long key and several security choices before anything
  useful. The owner's principle for this epic: **don't overwhelm people at the
  start.**

What Kin already has, which this builds on:

- Members are accounts on the identity service; every device is registered to
  its member and carries a `kin_device` cookie bound to its server record
  (IDENTITY, v0.8.6).
- Each device has non-extractable P-256 ECDH/ECDSA keys, certified by a
  trusted device's signature and pinned by the household's devices.
- Household content keys (one per epoch) reach devices only as signed,
  recipient-bound packages; the service never holds them in readable form.
- Each installation's local root is unwrapped by a recovery wrapper or a
  passkey PRF wrapper.

The missing piece is how a device that no other device vouches for gets the
member's keys. The tester's idea ("tie devices to the account; remember the
device with a cookie; when there's no cookie, ask which device this is or
make a new one") works for *identifying* a device, but a forgotten cookie
almost always means the browser's storage, and its keys, are gone too. So the
account has to carry the keys, in a form the service can't read.

## Decision (proposed)

### 1. A key vault per member, encrypted on the device

Each member has one **vault** on the service:

```text
vault key (VK): random 256-bit, generated on the member's first device
   |
   +-- vault contents, AES-256-GCM under a key from VK (HKDF, purpose
   |   "kin/vault/v1"), versioned:
   |     - every household epoch key the member is entitled to
   |     - the member's certification key (see 3)
   |     - later: the member's private-storage key (epic #480)
   |
   +-- vault wrappers: VK wrapped by each way the member can open it
         - password alone (only until a passkey is added; D3)
         - passkey alone (once a passkey is added; D4)
         - or, if the member turns on "require password and passkey",
           password + passkey instead of passkey alone
         - backup code
```

The service stores the encrypted contents, the wrappers and a version
number. It never receives VK, the password, PRF output or the backup code in
usable form. A trusted device updates the vault whenever the member's keys
change (a new epoch after a revocation, a new private-storage epoch); updates
are compare-and-set on the version, like local `configRevision`.

*As built (#791).* A device that commits a household key rotation sends its
vault, re-sealed with the new key, in the same request (POST
/api/sync/epochs `vaultChange`, `{ expectedVersion, ciphertext }`), and the
service stores both in one transaction or neither. The new key is never only
on a device that might be lost. Sealing the key into the vault before the
commit was rejected: a proposal that loses would leave a wrong key for that
epoch. On a vault conflict the device downloads, merges and retries the same
proposal (at most three requests carry the change). Without a vault key or
a vault, or when the vault change is refused for another reason, it commits
as before and the keeper adds the key afterwards. Each request with the
change counts as one vault write, and a member without a vault gets 404
`vault_not_found`.

### 2. Signing in: a password, with a passkey as the second step

- **Username and password.** The person picks a username (unique on the
  service) and a password. Kin has no email system, so email isn't required.
- **Two keys from one password, kept apart.** The browser derives from the
  password, with a per-member salt, two independent values:
  - `authKey` = KDF(password, salt, "kin/auth/v1"), sent to the service at
    sign-in; the service stores only Argon2id(authKey) using Node's built-in
    `crypto.argon2` (a standard implementation; nothing hand-written).
  - `passwordKey` = KDF(password, salt, "kin/vault-password/v1"), never sent.
  So the service can check the password without being able to open the vault.
- **Adding a passkey.** Once a member adds a passkey (offered later, never at
  sign-up), the passkey alone signs them in on a new device and opens the
  vault (D4): its wrapper's key is HKDF(PRF output, "kin/vault-passkey/v1").
  Adding it removes the password-only wrapper, so from then on a stolen copy
  of the service's database can't be cracked by guessing passwords (the PRF
  output is 256 random bits). The password keeps unlocking devices that are
  already set up.
- **Optional: require password and passkey.** A member who wants two factors
  turns this on in Security; the passkey-alone wrapper is replaced by one
  whose key is HKDF(PRF output ‖ passwordKey, "kin/vault-2f/v1"), so neither
  secret alone opens the vault.
- **The service releases a member's wrappers only after sign-in succeeds**
  (password check, then passkey assertion where one is registered), and
  rate-limits attempts per account and per address.

### 3. A new device certifies itself through the vault

Today a new device's certificate is signed by an approving trusted device,
and other devices refuse keys without a valid chain. With no approving device
present, the vault supplies the authority: each member gets a **certification
key** (ECDSA P-256), certified once by a trusted device of theirs and pinned
by the household like device keys. It lives only inside the vault. A device
that opens the vault signs its own device certificate with it, so the rest of
the household accepts it exactly as if the member had approved it on another
device. Admin-only actions keep needing a fresh passkey as today.

### 4. Signing in on a device with no cookie

```text
Sign in (username + password [+ passkey])
   |
   v
"Which device is this?"
   - Add this as a new device
   - This replaces <one of my devices>   (revokes it; clear warning)
   |
   v
open the vault on this device -> new local root -> device keys certified
-> household epochs installed -> sync
```

The cookie keeps doing what it does now: identifying a known device so it
skips the question. Pairing from an existing device remains available.

### 5. Daily unlock on a device that's set up

Unchanged in kind: the local root is unwrapped locally. A device may hold a
**password wrapper** of its local root (passwordKey, so it works offline), a
passkey PRF wrapper (offline once #551 lands), and its existing recovery
wrapper while the migration runs. Nobody types a long key day to day.

### 6. The backup code replaces per-device recovery keys

One backup code per member (256 bits, shown as groups of words or
characters, printable) wraps VK. It's offered after the first week or in
settings, never at sign-up. Once a member has a backup code and a vault,
per-device recovery keys are no longer asked for; existing ones keep working
for their exports (PORTABILITY, recovery key labels).

### 7. First run

Create a household or accept an invitation: display name, username,
password, then Today. At most three screens. No keys, no security choices.
Later, at calm moments: add a passkey (a dismissible card after the first
useful action), save the backup code (after a week), name this device.

## Owner decisions (2026-10-20)

| # | Question | Decision |
|---|---|---|
| D1 | Keep members' encrypted keys on the service (a vault), reversing "no server content-key escrow"? | **Yes.** It's what makes one account on every device possible. The service still can't read anything. |
| D2 | How the browser turns the password into keys. Web Crypto has PBKDF2 but not Argon2id; CRYPTOGRAPHY's non-negotiable rule forbids hand-written primitives. | **PBKDF2-SHA-256 via Web Crypto, 600,000 iterations** (OWASP 2023 guidance); move to Argon2id when browsers ship it in Web Crypto. No hand-written Argon2id (#554 closed). |
| D3 | Can the password alone open the vault before a passkey is added? | **Yes, with a strength floor** (so the first run stays simple), with the trade-off stated: until a passkey is added, someone holding a copy of the service's database could try to guess a weak password offline. Adding a passkey removes the password-only wrapper. |
| D4 | Allow a synced passkey alone (no password) to open the vault on a new device? | **Yes.** A passkey alone signs in on a new device. Password + passkey is an optional stricter setting. |
| D5 | Allow traditional username and password sign-in, reversing AGENTS.md "do not default to traditional email/password authentication"? | **Yes**, as the first-run sign-in, with a passkey offered later. |

## Rules this changes (if accepted)

1. AGENTS.md "Recovery must restore continuity … no server content-key escrow"
   → "… no server-*readable* content keys; members' keys may be held in a
   member-encrypted vault (ADR 0018)."
2. AGENTS.md "Do not default to traditional email/password authentication"
   → username and password with an optional passkey second step (ADR 0018).
3. CRYPTOGRAPHY "no … password-derived content key" → password-derived keys
   may wrap the vault key and a local root, using the KDF decided in D2.
4. RECOVERY "Honest failure boundary" → losing every device no longer loses
   the household if the member still has their password (and passkey) or
   backup code.

## Threats

| Threat | Before | With the vault |
|---|---|---|
| Stolen copy of the service's database | Ciphertext only; nothing to guess | Vault ciphertext and wrappers. With a passkey added: nothing to guess (256-bit PRF). Password-only wrapper (D3): weak passwords can be guessed offline at PBKDF2 cost; Argon2id(authKey) slows checking the password too. Old database backups keep old wrappers. |
| Stolen password | Nothing (no password exists) | Password-only stage: full access from any browser, subject to rate limits. With a passkey added: not enough on its own. |
| Stolen or phished passkey account (e.g. the platform account that syncs it) | Passkey signs in only on trusted devices | With passkey-alone sign-in (D4), whoever controls the synced passkey can open the vault on a new device. "Require password and passkey" closes this for members who want it; Settings says so. |
| Stolen phone, locked | Local root wrappers; recovery key is 256-bit | Adds the local password wrapper: offline guessing at PBKDF2 cost; strength floor applies. |
| Malicious or compromised service | Can withhold or delay; can't read | Same, plus: could serve old vault versions (rollback) or refuse sign-in. Can't read the vault. Can't create a device the household trusts without the certification key. A malicious *client build* served by a compromised service could capture the password; that's true of every web app and already in C-series limitations. |
| Malicious Adult | Can remove a member or approve a recovery that locks them out | Unchanged; still can't open another member's vault. |
| Member forgets password, has no passkey or backup code | Other devices still work; pairing still works | Same: devices already set up keep working; set a new password from a trusted device (re-wraps the vault). With no device, no password and no code: unrecoverable, as today. |
| Phishing site asks for the password | Not applicable | Passkeys can't be phished; the password stage can. Another reason to offer the passkey early (but calmly). |

Privacy: the service learns each member's username, when they sign in and
the size of their vault. It learns nothing new about household content.

## Migration

- Existing members see a calm invitation on the next unlock to "choose a
  username and password so you can sign in on other devices". Accepting
  creates VK, the vault and the certification key from what this device
  holds. (Implemented in #575: one passkey touch confirms the change and,
  with PRF, makes the vault's passkey wrapper, so such a member never has a
  password-only wrapper; without PRF, the password wrapper. Every step
  resumes; CRYPTOGRAPHY "Moving an existing member to an account".)
- Members who decline keep using Kin exactly as now.
- Recovery keys keep working until the member has a backup code.
- Older app versions ignore vaults; nothing in the household history or
  V1.0-COMPATIBILITY formats changes. New server tables and routes are
  additive (schema bump, documented in V1.0-COMPATIBILITY).

## Alternatives considered

- **Keep device-to-device pairing only** (today). Safe, but it's the friction
  testers hit, and losing every device loses everything.
- **Server-readable keys** (ordinary cloud accounts). Simplest, but ends
  end-to-end encryption. Rejected.
- **OPAQUE** (password sign-in where the service never sees anything derived
  from the password). Stronger against a stolen database in the password-only
  stage, but there's no standard browser API and it would mean writing
  protocol cryptography by hand. Deferred; revisit if D3's risk matters.
- **PIN-only unlock.** Too few possibilities to resist offline guessing on a
  stolen phone. Rejected.
- **Requiring password and passkey for everyone.** Strongest, but heavier
  for every sign-in; kept as an option instead (D4).

## Consequences

- New: vault and certification-key formats, server routes and tables,
  username/password sign-in, the no-cookie device question, backup code,
  migration. Order: ADR → vault → first run → new-device sign-in → passkey
  second step → backup code → migration → offline passkey (#551).
- Updated docs: CRYPTOGRAPHY, IDENTITY, PAIRING, RECOVERY, THREAT-MODEL,
  PRIVACY, PORTABILITY, AGENTS.md, V1.0-COMPATIBILITY.
- Epic #480 (member-private storage) uses the vault for its key instead of
  building a separate backup.
- #554 (Argon2id in Rust) is closed: D2 chose Web Crypto PBKDF2, which keeps
  the "no hand-rolled primitives" rule.
