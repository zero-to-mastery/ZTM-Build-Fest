# Cryptographic Posture

**Status:** Implemented through v0.10.3 for local incubation. Web Crypto supplies AES-GCM, ECDSA P-256/SHA-256, ECDH P-256 and HKDF-SHA-256 for local encryption, archives and existing encrypted sync. Recovery, a password, or a user-verified WebAuthn PRF output (checked by the service online, by the device offline since #551) authorizes local root unwrapping. No independent cryptographic audit or production certification is claimed.

## Non-negotiable rule

> Kin will use established cryptographic primitives exposed by standards-based implementations such as Web Crypto and appropriate server-side equivalents.

Do not hand-roll cryptographic primitives. Use standardized APIs and established modes. The implemented versioned envelopes, authenticated context and parameters below require review alongside their tests; using standard primitives does not certify their composition.

## Desired properties

The implemented encrypted sync design provides:

- Confidentiality and integrity/authenticity for household event payloads in transit and on relay storage
- Cryptographically secure random generation for keys and pairing secrets
- Explicit authorization of each receiving device
- Separation between member authentication credentials, device identity keys, and household content keys
- Versioned key envelopes and a deliberate key-rotation path
- No plaintext household content key available to the sync service
- Standard transport security in addition to payload encryption

IndexedDB is not inherently encrypted. v0.10 adds an explicit authenticated encryption layer for household content, protected metadata and private sync material. Browser/device security remains part of the [threat model](THREAT-MODEL.md).

## Conceptual household-key flow

```text
trusted authorized device
          |
          | obtains a household content key through reviewed enrollment
          v
household key held by authorized clients
          |
          | authenticated encryption using a reviewed standard protocol
          v
ciphertext event payload
          |
          v
sync relay stores and forwards ciphertext plus limited metadata
```

Keys come from the platform CSPRNG and reach sync devices through authenticated, recipient-bound provisioning. Sync epoch rotation and local root wrapping are separate protocols. v0.10.2 implements local-root replacement by re-encrypting the corpus and replacing recovery/credential wrappers, as specified below.

## Passkeys are not encryption keys

A passkey/WebAuthn credential authenticates a member to a relying party. It does not by itself provide a household encryption key, encrypt events, prove a device is the only holder of content, or define recovery. Do not derive household keys directly from a passkey assertion or treat a biometric/PIN as a key. Authentication, device keys, and household encryption are separate protocols.

## Enrollment, revocation, and rotation

Each authorized device needs an explicit, authenticated means to obtain access to the household key without exposing it to the relay. Pairing must verify the same session and recipient device before enrollment. On device/member revocation, the service rejects future access and remaining trusted devices must rotate the key for future events. Previously downloaded plaintext or key material cannot be recalled. Whether and how old history is re-encrypted for remaining members is a deliberate future decision; see [PAIRING](PAIRING.md).

## Browser execution risk

Browser-side encryption protects against some server/database exposure but not malicious JavaScript executing in an authorized browser. XSS or a compromised dependency could read plaintext and key material. Minimize external scripts/dependencies, render household text as text, avoid unsafe HTML and `eval`, review Content Security Policy, and keep key lifetimes narrow where practical. These defenses reduce risk; they do not make a compromised client trustworthy.

## v0.9.x implementation record (historical persistence)

- Household content uses one random 256-bit AES-GCM key per monotonically increasing epoch; each event has a 96-bit CSPRNG nonce and 128-bit tag. AAD binds protocol/envelope version, household, event, author device, device sequence, Lamport time and epoch. The relay bounds a household history at 100,000 events, below the documented 2^20 envelopes per-epoch nonce budget.
- Each trusted device has separate non-extractable P-256 ECDH and ECDSA private `CryptoKey`s. Public JWKs are fingerprinted and compared locally during pairing approval. The approver signs a certificate binding the claimant's household/member/device IDs and public keys; recipients validate certificate chains against locally pinned/comparison-approved roots before using directory keys. Device signatures bind opaque envelope metadata and ciphertext; receivers verify before decrypting.
- Provisioning uses ephemeral ECDH P-256, HKDF-SHA-256, and AES-GCM wrapping. Packages bind household, sender, recipient ID/fingerprint, epoch, grant and expiry, and are signed by the sender. The recipient proves possession by unwrapping. Grants are recipient-bound and expiring; exact retries are idempotent.
- Epoch keys are non-extractable at runtime. v0.9.3 IndexedDB stores both a usable AES CryptoKey and AES-GCM-sealed raw bytes, wrapped by a key derived from the persisted device ECDH key and fresh salt. Neither imposes a local authentication boundary. Raw bytes are transient during provisioning. Non-extractability is not protection against same-profile key invocation.

## v0.10 local key hierarchy

The [v0.10 contract](planning/V0.10.0.md) adds a random household storage root, HKDF-separated
local-storage/archive keys, and independent credential/recovery KEKs. Root wrappers
are AES-GCM authenticated and bind household/vault, wrapper ID, type and version.
Adding a wrapper never re-encrypts the event corpus. Removing a wrapper prevents
future normal use of that wrapper, but cannot invalidate a copied wrapper plus
secret; compromise requires root rotation and replacement of protected records.
Never permit deletion of the final verified unlock path. Each adult may wrap the
same root; local storage must not become an Alice-only encryption domain.

Every local record, wrapper and archive encryption derives a one-use AES-256 key
from the 256-bit root/credential secret using HKDF-SHA-256 and a fresh random
256-bit salt. Purpose strings are `kin/local-storage/v1`, `kin/local-wrapper/v1`
and `kin/archive/v1`; sync epoch keys remain independent. AES-GCM uses a fresh
96-bit nonce and 128-bit tag. Encoded string-array AAD binds purpose, version,
vault ID, store and record ID; archive metadata is authenticated as well. Retries
reuse committed ciphertext or generate fresh salt/nonce pairs. Decrypted routing
fields must match the public key-path/index fields.

Wrapper updates compare a durable `configRevision`; removal atomically advances
the lock epoch and invalidates previously unlocked capabilities. This prevents a
stale tab from resurrecting a removed wrapper. **The final unlock path**
cannot be removed. For a device set up with a backup key it is the recovery
wrapper, exactly as before; for a device set up with a password (#558) it
is the password wrapper (below). A passkey (PRF) wrapper doesn't count on
its own, with one exception (#572): a device that a member **with an
account backup code** signed in on with their passkey alone has only a
passkey wrapper, and its manifest records `accountRecovery: "backup-code"`.
Its final path is the account itself: if the passkey can't open it, the
member signs this browser in again with the backup code (replacing this
device) and the household comes back from sync; only what hadn't synced
yet is lost. No other device is set up that way, and no per-device backup
key is shown for it. One test, `hasFinalUnlockPath` (with
`hasVerifiedUnlockPath` for the wrapper part), enforces this in the vault
and in `EventStore`; see [RECOVERY](RECOVERY.md#members-who-signed-up-with-a-password-557-558). Lock drops references, clears engine buffers and closes
capabilities, without promising physical memory erasure.

PRF is an optional WebAuthn extension, not a universal passkey property. Use required
user verification, actual credential-associated extension output and domain-separated
HKDF. A normal WebAuthn signature or server session must never serve as a KEK.
Recovery is a deliberately user-held random 256-bit secret. The person
confirms they saved it before migration (since #163 by a checkbox, not by
retyping it). Kin never stores it or sends it to the server; the browser may
offer to save it in its password manager (THREAT-MODEL C5). An encrypted archive plus that
secret supports profile-loss recovery; a secret alone cannot restore absent data.

PRF enrollment verifies an assertion with the same-origin identity server and
needs a connection. Online, PRF unlock does too, exactly as before (V0.41.0):
the service issues the challenge, checks RP, origin, challenge, signature and
user verification, and refreshes the device's session. Recovery unlock works
offline.

### Offline passkey unlock (#551, contract change)

The deferred V0.41.0 follow-up is now the contract: when the browser says it
is offline, or the identity service can't be reached (no connection, or a 5xx
from a proxy in front of it), PRF unlock of an **existing** PRF wrapper runs
with a challenge made on the device (`authenticatePrfLocally`,
`web/security/passkey-unlock.js`):

```text
challenge = 32 random bytes (Web Crypto)
navigator.credentials.get({ challenge, rpId: this origin's host,
  allowCredentials: [the wrapper's credential], userVerification: "required",
  extensions: { prf: { eval: { first: the wrapper's PRF salt } } } })
checks: clientDataJSON type "webauthn.get", this challenge, this origin;
        authenticatorData rpIdHash = SHA-256(rpId); flags UP and UV set;
        the credential is the wrapper's
PRF output (32 bytes) --the v0.10 wrapper construction--> local root
```

What changed, and why it holds: the server assertion never protected the
local root; the PRF output does. Only the authenticator holding the passkey
can compute it for the wrapper's salt, after it verified the person, and only
that output unwraps the root (AES-GCM authenticates the attempt). The local
checks make sure the ceremony was this one, for this site, with the person
verified; the signature is not checked locally (the device has no copy of the
public key, and a forged assertion can't come with the PRF output). A service
that is reachable and refuses (401/403: this device isn't trusted there) is
not bypassed. Enrolling a new passkey still needs the service. An offline
unlock does not refresh the session; sync resumes when the device signs in
again. THREAT-MODEL ("Offline passkey unlock") records what this adds.
New registration requests opt into PRF, but existing credentials may not
support it. Actual 32-byte PRF output is required, is never sent to the server and
is discarded after wrapping/unwrapping. Multiple supported adult credentials may
independently wrap this installation's root. Each installation has its own local
root; device pairing provisions separate sync epoch keys.

Legacy nonextractable transport keys require the signed successor migration in
[V0.10.0](planning/V0.10.0.md), rather than pretending they can be exported/wrapped. New
transport private serializations and sync epoch secrets are protected by the local
root; no private decryption capability remains outside that protection. Do not
claim the new boundary until legacy epoch CryptoKeys, self-wrapped copies and
agreement keys are removed and migration verification completes.
- Existing canonical event bytes are encrypted directly. Historical placeholder identities remain byte-for-byte intact; a separate signed, encrypted identity-binding control record establishes the authenticated importing identity for v8 replay. No semantic JSON event replacement is used.
- Tests cover roundtrip, wrong keys, metadata substitution, ciphertext/signature/nonce mutation, unsupported/truncated envelopes, nonce variation, sealed-key restore, correct/wrong recipient, expiry, signature tampering, and actual two-trusted-device opaque relay exchange.

Key generation and authenticated encryption use platform Web Crypto. The implementation has no custom cipher, MAC, nonce counter, or password-derived content key. [ADR 0018](decisions/0018-account-key-vault.md) (accepted) allows a password-derived key, from Web Crypto PBKDF2-SHA-256, to wrap a member's vault key and a device's local root; it never encrypts content directly. The vault formats, key derivations and service storage below are implemented (#564), and so are password sign-in, the local password wrapper and creating the vault at first run (#557, #558), the no-cookie sign-in (#568), adding a passkey with "require password and passkey" (#560), the backup code (#571), moving existing households to accounts (#574) and the offline passkey (#551).

### Local password wrapper (#558)

A device set up at the first run with a password has one root wrapper of
type `password` (local manifest format 1, root version 1; no recovery
wrapper):

```text
password --PBKDF2-SHA-256 (member salt, >= 600,000) + HKDF--> passwordKey   (as for the vault, below)
KEK  = HKDF-SHA-256(passwordKey, empty salt, info "kin/local-password/v1")
root wrapper = the v0.10 wrapper construction (purpose kin/local-wrapper/v1)
  with wrapper context ["password", wrapperId, "pbkdf2-sha256", salt, "<iterations>"]
public fields: { version 1, id, type "password", kdf "pbkdf2-sha256",
                 salt (16 bytes, base64url), iterations, username? }
```

The KEK has its own HKDF purpose, so it is never the vault wrapper's key
(which is passwordKey itself) and never authKey. The salt and iterations are
bound into the wrapper's authenticated data; the username is only a hint for
password managers and the sign-in request, and is not bound. Unlocking runs
one PBKDF2 on the device, offline, and the same run gives the authKey that
signs the device in. The salt is the member's account salt, chosen at
sign-up, so the device and the service derive the same keys. A wrong
password fails AES-GCM authentication like any wrong wrapper key; Kin counts
nothing on the service (it never sees local attempts). Offline guessing
against a stolen device costs a full PBKDF2 per guess; the strength floor
(at least 10 characters, not one of about 200 very common passwords, not
the username) keeps out the first guesses.

A device set up the old way (a recovery wrapper, perhaps PRF wrappers) whose
member moves to an account (#575) gets the same password wrapper **beside**
its other wrappers (`LocalVault.addPasswordWrapper`): the root is unchanged,
so nothing is re-encrypted, and the backup key keeps opening it (#576).

A password changed on another device (#560 follow-up): this device's wrapper
still opens with the previous password, which only the device itself can
re-wrap. At each unlock with a connection, the device asks the service for
the account's current password parameters (`POST
/api/account/sign-in/parameters`); if they differ from its wrapper's, it
doesn't open the household until the new password signs in (the previous
password, or the new one typed first, opens the root once), then replaces
its wrapper under the new password (same wrapper ID). Offline, the previous
password keeps opening the device (THREAT-MODEL).

## Account key vault (ADR 0018)

Implemented in `web/security/account-vault.js` (formats and cryptography),
`web/security/account-vault-sync.js` (keeping it current),
`web/security/account-setup.js` (sign-up and the first vault) and
`server/account-vault-service.mjs` (storage and routes). All primitives are
Web Crypto in the browser and Node's built-in `crypto` on the service.

**Creating it (#558).** A member who signs up with a password gets a vault on
their first device as soon as the service knows them (after creating the
household, or after their invitation is approved): a fresh VK, the household
and chat epoch keys the device holds (none yet, at first), and a new
certification key (see "Certification key chain" below), sealed as version 1 with one password
wrapper (KEK = passwordKey; parameters `{ kdf, iterations, salt }`) and
uploaded compare-and-set from version 0. The device keeps VK in its bound
device record in the key database, sealed under the local root like its
device keys (so it is encrypted at rest, readable only while unlocked, and
carried through a root rotation), and runs the keeper below, so the first
household key joins the vault as soon as sync installs it.

**Vault key (VK).** 32 random bytes from `crypto.getRandomValues`, made once
per member on their first device. It never leaves a device unwrapped.

**Vault contents, format 1** (plaintext; exists only inside the sealed vault):

```text
u8  format (1)   u8 flags (0)
u16 N, then N entries sorted by (family, epoch), no repeats:
    u8 family (1 household, 2 chat)  u8 0  u16 epoch (1..128)  32-byte key
u16 L, then L bytes: certification key, ECDSA P-256 PKCS8 (L = 0: none)
u16 M, then M bytes: private-storage key (reserved, epic #480; M = 0 or 32)
```

Integers are big-endian; a decoder refuses unsorted, repeated or trailing
bytes. The certification key is generated (`generateCertificationKey`),
endorsed by a trusted device and used by new devices (#568, below).

**Vault contents, format 2** (ADR 0019, #487): format 1 with the reserved
slot replaced by the member's member-key epochs:

```text
u8  format (2)   u8 flags (0)
u16 N and N epoch entries, as format 1
u16 L and the certification key, as format 1
u16 K (1..128), then K entries sorted by epoch, no repeats:
    u16 epoch (1..128)  u16 0  u64 revokedThrough  32-byte member key
```

Format 1 is still read (a filled reserved slot reads as member-key epoch 1,
`revokedThrough` 0), and contents without a member key are still written as
format 1, byte for byte, so a vault becomes format 2 only once its member
uses private storage. The sealed container below is unchanged (format 1,
AAD "1"); an older release opening format 2 contents refuses them as
written by a newer Kin. Merging keeps member keys from either side; two
different keys for one epoch are refused (`vault_member_key_conflict`).

**Sealed vault, format 1** (what the service stores, at most 64 KiB):

```text
"KVLT"  u8 format (1)  32-byte HKDF salt  12-byte nonce  ciphertext || 16-byte tag
key  = HKDF-SHA-256(VK, salt, info "kin/vault/v1") -> AES-256-GCM
AAD  = JSON ["kin/vault/v1", "1", householdId, memberId, "<vault version>"]
```

Every version is sealed under a fresh salt and nonce, so the AES key is
single-use. The vault version is the service's version after the
compare-and-set; binding it means a service can't relabel an old vault as
the current one, or move a vault to another member or household. (It can
still serve an older version under its own number: a rollback the device
detects only against a version it has already seen.)

**Wrapped vault key, wrapper format 1** (61 bytes):

```text
u8 format (1)  12-byte nonce  AES-256-GCM(KEK, VK) || tag
AAD = JSON ["kin/vault-wrapper/v1", "1", householdId, memberId,
            "<type>", "<wrapperId>", "<wrapper version>"]
```

Types are `password`, `passkey`, `password-passkey` and `backup-code`; the
32-byte KEK is imported directly as a non-extractable AES-GCM key:

| Wrapper | KEK |
| --- | --- |
| password | `passwordKey` (below) |
| passkey | HKDF-SHA-256(PRF output, empty salt, info `kin/vault-passkey/v1`) |
| password-passkey | HKDF-SHA-256(PRF output ‖ passwordKey, empty salt, info `kin/vault-2f/v1`); neither secret alone derives it |
| backup-code | HKDF-SHA-256(32 code bytes, empty salt, info `kin/vault-backup/v1`) |

The PRF output and the backup code are uniformly random 256-bit values, so
HKDF needs no salt for them.

**Which wrappers may exist together (#561/#572).** The service checks the
set a change would leave, before storing anything
(`server/account-vault-service.mjs` `wrapperSetProblem`), and refuses it
with `vault_wrapper_rules`:

- at least one wrapper (as before);
- **no `password` wrapper beside a `passkey` or `password-passkey` one**
  (ADR 0018 D3): once a passkey is added, a copy of the service's database
  holds nothing a password guess opens;
- **no `passkey` wrapper beside a `password-passkey` one**: "require
  password and passkey" means a passkey alone opens nothing;
- each passkey (credential ID) opens the vault at most once, and there is
  at most one `backup-code` wrapper.

So the transitions are swaps, made in one request
(`POST /api/account/vault/wrappers` with `{ put, remove }`, applied in one
transaction after a fresh password check) by
`web/security/account-wrappers.js`:

```text
sign-up                  [password]
add a passkey            [passkey]              password removed in the same step
require password+passkey [password-passkey]     passkey-alone wrapper replaced
turn that off            [passkey]              combined wrapper replaced
make a backup code       [..., backup-code]     an older code's wrapper replaced
change the password      password / password-passkey wrappers re-wrapped (same ID, version + 1)
backup-code sign-in      password wrappers re-wrapped under the new password;
                         password-passkey wrappers removed (they need the passkey too)
remove a passkey         its passkey / password-passkey wrappers removed; when none
                         a password or passkey opens is left, a password wrapper
                         comes back (password-only stage again, never the code alone)
moving to an account     [passkey] when the member's passkey gave a PRF output in the
(#575)                   touch that set the password, else [password]
```

`POST /api/account/vault/wrappers` and `POST /api/account/passkeys/remove`
need the current password. The one-wrapper routes (`PUT` and `DELETE
/api/account/vault/wrappers/<id>`) need the same fresh confirmation: the
current password (`currentAuthKey`), or a fresh passkey assertion (`flow`
from `POST /api/account/confirm/options` and `credential`), so a session alone
(a browser left signed in) can't add or remove a way into the vault.

**Moving an existing member to an account (#575).** A member set up the old
way has a passkey and per-device backup keys, and no username, password or
vault. Accepting the invitation runs, on the device, with every step first
checking what is done (`web/security/account-migration.js`):

```text
1 password   POST /api/account/migrate/options -> one assertion of the member's passkey
             with PRF { first: a new random salt }; POST .../finish with the
             assertion, the username and authKey (the service checks the
             assertion, then keeps Argon2id(authKey)). Already done: the typed
             password signs this device in (POST /api/login/password) instead.
2 vault key  VK = 32 random bytes, kept in this device's bound record first
3 vault      contents = this device's household and chat epoch keys and a new
             certification key; sealed as version 1 with ONE wrapper: passkey
             (KEK = HKDF(PRF output, "kin/vault-passkey/v1")) when the touch gave
             a PRF output, else password (KEK = passwordKey). A vault already
             there is opened with this device's VK, else through its password
             wrapper or (one more touch) a passkey wrapper, and that VK is kept.
4 endorse    the certification key endorsed by this device (#570)
5 local      a local password wrapper beside the recovery and PRF wrappers
```

So a member whose passkey has PRF never has a password-only vault wrapper
(D3/D4), and their next device signs in with the passkey alone.

Each passkey wrapper gets its own random 32-byte PRF input. Adding a passkey
asks it for two PRF values in one touch (the extension's `first` and
`second` inputs): one for the vault wrapper, one for this device's local
passkey unlock wrapper, so those two keys are independent.

**Backup code (#572).** 32 random bytes, shown as 56 Crockford base32
characters in 8 groups of 7 (`web/security/backup-code.js`): the bytes and
a 3-byte check, the first three bytes of
SHA-256("kin/backup-code-check/v1" ‖ code). The check only catches typos
(a mistyped character slips through with probability 2^-24); it adds
nothing to the code's strength. From the code bytes:

```text
KEK      = HKDF-SHA-256(code, empty salt, "kin/vault-backup/v1")   -> the backup-code wrapper
codeAuth = HKDF-SHA-256(code, empty salt, "kin/backup-auth/v1")    -> sent at a backup-code sign-in
verifier = SHA-256(codeAuth)                                       -> kept by the service, never sent out
```

The service keeps the verifier in the backup-code wrapper's parameters
(`{ verifier }`), strips it from every download and summary, and compares
SHA-256 of a sign-in's `codeAuth` with it in constant time. No stretching:
the code is 256 random bits, so neither the verifier nor the wrapper can be
guessed. A new code's wrapper replaces the old one in one step, so the old
code stops opening the vault and signing in at that moment (exports made
under it keep its own wrapper; see PORTABILITY).

**Exports for a member with a backup code (#572).** The export's root gets
one more recovery-type wrapper whose 32-byte secret is
HKDF-SHA-256(VK, empty salt, JSON ["kin/export-backup-code/v1", vaultId]),
and that wrapper carries the code's vault wrapper (`backupCode: {
householdId, memberId, wrapperId, version, wrapped }`). Opening: code ->
KEK -> VK -> the secret -> the root, offline. The whole export manifest is
authenticated by the archive key, and the embedded wrapper by its own AAD,
so neither can be swapped.

**Password keys.** One stretch, split by HKDF:

```text
stretched   = PBKDF2-SHA-256(UTF-8(NFC(password)), memberSalt (16 random bytes),
                             600,000 iterations, 256 bits)
authKey     = HKDF-SHA-256(stretched, memberSalt, info "kin/auth/v1")           -> sent at sign-in
passwordKey = HKDF-SHA-256(stretched, memberSalt, info "kin/vault-password/v1") -> never sent
```

Why one PBKDF2 run and HKDF rather than two PBKDF2 runs with
domain-separated salts: a guesser pays the full 600,000 iterations per guess
either way, but two runs would double the honest device's cost (seconds on a
phone) without making any guess dearer. HKDF keyed by the stretched value is
a PRF, so `authKey` reveals nothing about `passwordKey`: the service, which
receives `authKey`, still can't open a password wrapper. A client refuses
wrapper parameters below 600,000 iterations, so a service can't get a cheaper
`authKey` by offering fewer. Iterations follow OWASP's 2023 PBKDF2-SHA-256
guidance (ADR 0018 D2); Argon2id replaces PBKDF2 once Web Crypto ships it.

**Password verifier (service).** The service stores only
Argon2id(`authKey`), from Node's `crypto.argon2` (`server/account-password.mjs`):
Argon2id v1.3, 19 MiB, 2 passes, parallelism 1, a 16-byte random salt and a
32-byte tag (OWASP's first recommended configuration), kept as a PHC string
so the parameters can rise later; a check uses the stored parameters within
fixed bounds and compares in constant time. It is written when a member
signs up with a password and checked at sign-in, activation and fresh
confirmations (#558; IDENTITY, "Username and password sign-in").

**Keeping it current (#567).** When a device installs a household or chat
epoch key it didn't hold, and it holds the member's VK, it merges the key
into the vault by (family, epoch), seals the next version and uploads it
compare-and-set. On a conflict it downloads, merges and retries once. A
merge only adds keys; the same epoch with different key bytes is refused.
A device keeps VK in its bound device record (above, "Creating it"); each
unlocked household panel runs the keeper once (for keys installed while it
was offline or locked) and then on every install. The device that commits a
household key rotation updates its own member's vault in the same request
as the commit (#791, [SYNC](SYNC.md#rotation-and-the-account-vault-791)), so
the new key is in the vault before any device installs it, unless the vault
change had to be left out (SYNC lists when). The keeper covers that case and
every other install.

**Service storage (server schema 21; usernames in 23).** `account_vaults` (member, household,
version, update time, sealed bytes), `account_vault_wrappers` (wrapper ID,
type, version, public parameters: PBKDF2 salt and iterations, or the
passkey's credential ID and PRF salt; and the 61 wrapped bytes) and
`account_passwords` (PBKDF2 salt and iterations, Argon2id verifier). Routes
serve only the session's own member on a trusted device; a vault is created
with its first wrapper and can never lose its last; downloads are limited
to 60 per member and 120 per address in 15 minutes (every download is already
behind a session or a new-device capability, so this bounds traffic, not guessing). A download for a device
without a cookie (#568) goes through a new-device capability (below) and
releases only the one wrapper that sign-in opens: the password wrapper for a
password sign-in, the asserted passkey's wrapper for a passkey sign-in, its
password-passkey wrapper when both were required, the backup-code wrapper
for a backup-code sign-in (#572; that one also lists the other wrappers'
IDs, types, versions and public parameters, without their keys, so the
new password can re-wrap them). The service never learns
whether a device's unlock attempt failed; devices count their own.

**Changing the password (#560).** One request
(`POST /api/account/password`, after the current password) carries the new
PBKDF2 salt and iterations, the new `authKey` and the re-wrapped wrappers;
the service stores the new Argon2id verifier and applies the wrapper change
in one transaction. The device then re-wraps its own local password wrapper
under the new password, keeping the wrapper's ID (no other tab is
revoked; the root is unchanged). Another device of the member keeps its
local password wrapper under the old password (it is that device's own)
until it next signs in to the service: its sign-in derives `authKey` from
the service's current salt and iterations, and once the new password
signs in, the device re-wraps its local wrapper under it (THREAT-MODEL).

## Certification key chain (ADR 0018 section 3, #568/#570)

Implemented in `web/security/device-certification.js` (browser) and
`server/account-certification.mjs` (the service's checks). ECDSA P-256 with
SHA-256 and raw (IEEE P1363) signatures over canonical JSON (keys sorted),
like device approval certificates.

```text
trusted device X of member M
   └─ endorsement (signed by X's device key AND by C):
        { version 1, purpose "kin.account.certification-key.v1",
          householdId, memberId, publicKey (C, {kty,crv,x,y}),
          fingerprint = SHA-256(canonical publicKey),
          issuerDeviceId X, issuerFingerprint (X's key),
          anchors [{ deviceId, fingerprint }]  (X and the devices X had pinned) }
member certification key C (private half only inside M's vault)
   └─ device certificate, version 2 (signed by C):
        { version 2, householdId, memberId, deviceId, publicKeys, fingerprint,
          certificationFingerprint, endorsement }
```

- **Endorsing (#570).** A trusted device that holds VK opens the vault,
  takes C, signs the endorsement with its own device key and with C, and
  sends it (`PUT /api/account/certification`). The service checks both
  signatures, that the signer is the session's own device with its current
  key, and keeps it on that device's record; a member has at most one, and a
  different C later is refused (`certification_key_conflict`). Devices do
  this right after creating the vault at first run, and, for a member whose
  vault predates this, whenever a device of theirs with VK opens the
  household panel.
- **A new device certifying itself.** After opening the vault it derives C's
  public key from the PKCS8 bytes and requires the service's endorsement to
  be exactly that key with a valid signature by C (`verifyOwnEndorsement`):
  the service can't hand it an endorsement of another key. It signs its own
  version 2 certificate with C. The service checks it against the stored
  endorsement and C before trusting the device, but couldn't make one: it
  never holds C.
- **Other household devices accept it** (`SyncCoordinator.loadDeviceDirectory`)
  when the endorsing device X verifies for them (pinned, or by its own
  approval chain, as before), X is the **same member's** device, X's
  signature on the endorsement verifies with X's key at `issuerFingerprint`
  (from X's verified key history), C's signature on the certificate
  verifies, and C matches the key they pinned for that member. The first
  time, they pin C per member (in the trusted-device store, under
  `<household>:certification:<member>`); a device certified by a different
  C for that member afterwards is refused, as a changed device key is.
- **The new device's own trust anchors.** It trusts the endorsement because
  C signed it, and C came from the vault the member's password (or passkey)
  opened. It pins the anchors the endorsement lists (X and the devices X had
  pinned, at the keys listed), then verifies the rest of the directory by
  the usual chains. So the new device starts from what the member's own
  device trusted, with no fingerprint comparison, and the service can't
  insert an anchor (it can't sign with C). A device X had trusted only by a
  later manual "Verify device" isn't an anchor; it must chain to one.

What this does **not** give: anyone who can open the member's vault (their
password before a passkey is added, D3) can certify devices the household
accepts as that member's; that is the accepted trade-off of ADR 0018. C
isn't rotated yet; a member whose vault leaks has no way to replace C short
of removal and re-invitation (deferred).

## Member key and private envelopes (ADR 0019)

Implemented in `web/private/member-key.js`, `web/private/private-envelope.js`
and `web/private/private-log.js`; every primitive is Web Crypto.

**Member key (MK).** 32 random bytes from `crypto.getRandomValues`
(`generateMemberKey`), an AES-256-GCM key, made on the member's first device
the first time they use something private, and sealed straight into their
account vault (contents format 2). It is never stored anywhere else: the
member's devices read it by opening the vault with VK, hold each epoch as a
non-extractable CryptoKey while unlocked, and drop them on lock. A device
may cache the **sealed** vault (ciphertext under VK) for offline unlocks.
No same-member key package exists: the vault is the only way MK reaches a
device, so private storage needs an account (ADR 0018). Where a device keeps
VK is story #557's; until it is wired the key ring's `vaultKey()` provider
resolves null and private storage stays off.

**Epochs.** Each MK epoch records `revokedThrough`, the latest revocation
time (service milliseconds) of the member's own devices it was made after.
A device that sees one of its member's devices revoked later than the newest
epoch's mark re-reads the vault and, unless another device already did,
creates epoch n+1 and uploads the vault compare-and-set; a device that loses
that race finds a different key for the same epoch when it merges and adopts
the winner's. New envelopes use the newest epoch, and pending ones are
resealed under it before sending; old epochs stay in the vault so old
envelopes stay readable. A revoked device keeps whatever it already had; an
envelope signed by a device under an epoch made after that device's
revocation is refused.

**Private envelope.** The sync envelope's fields and versions (protocol 1,
envelope 1), so it shares the binary transport and the service's opaque
checks, with its own key, AAD and signature domain:

```text
ciphertext = AES-256-GCM(MK[keyEpoch], 12-byte random nonce, canonical event, AAD)
AAD        = fields("kin.sync.private.aad.v1", "1", "1", "private", householdId,
                    memberId, eventId, deviceId, deviceSequence, logicalTime, keyEpoch)
signature  = ECDSA P-256 / SHA-256 (sending device's signing key) over
             fields("kin.sync.private.signature.v1", AAD, nonce, ciphertext)
```

`fields` is the sync envelope's length-prefixed encoding. The member ID is in
the AAD though not in the envelope: an envelope can't be moved to another
member's stream or read as a household, chat or board envelope. A receiving
device verifies the signature with the sender's verified key history and
requires the sender to be one of its own member's devices.

**A member's own export of their private things (#493, KPEX format 1,
`web/private/private-export.js`).** A separate file from the household
export, which never reads a private store:

```text
"KPEX" u8 1  u32 H  header (H bytes, UTF-8 JSON)  nonce (12)  ciphertext+tag
body   = AES-256-GCM(MK[keyEpoch] (the newest epoch), nonce, plaintext,
                     AAD = every byte before the nonce)
         plaintext: serializeProtectedValue({ envelopes, blobs }): the private
         envelopes as the device keeps them (each sealed under its own epoch,
         AAD-bound to the member) and journal photos as sealed blobs
header.backupCode (member with a backup code only):
         { wrapperId, version, wrapped }   the backup code's vault wrapper of VK
         keys = AES-256-GCM(HKDF-SHA-256(VK, 32-byte random salt,
                "kin/private-export-keys/v1"), nonce, vault contents format 2
                holding only the member-key epochs,
                AAD JSON ["kin/private-export-keys/v1", "1", householdId,
                memberId, exportedAt])
```

On one of the member's devices the file opens with the member key from the
vault, as always; without it, the backup code opens VK, VK the member keys,
and the newest epoch the body: the code alone is enough, offline. Changing
any header byte makes the body fail to open; the member keys are bound to
the member, household and export time. Restoring checks the header names this
member and household, opens every envelope under this member's key for its
epoch (an envelope bound to another member fails AES-GCM, and the whole file
is refused), adds what isn't there by event ID, and keeps photos whose SHA-256
matches their reference as pending uploads. Epochs the backup code opened that
the vault lacks are merged into the vault first (compare-and-set, as always).

## Claims boundary

### v0.10.2 local root lifecycle

[Root rotation contract v1](ROOT-ROTATION.md) establishes an independent random
256-bit root, monotonically advances rootVersion, and verifies a new random
256-bit recovery secret before publication. Confirmation is required in the UI;
the secret is never persisted or transmitted. Old recovery and PRF wrappers do
not survive commit. Passkey unlock must be added again with a verified ceremony.
Transport private keys and sync epoch keys are preserved exactly and only their
local outer protection changes.

Manifest format 2 and local-envelope v2 bind `root-version`, its decimal value,
store and record identity in both HKDF info and AES-GCM AAD. Purpose labels remain
the existing explicit local-storage/local-wrapper v1 strings; AAD's envelope
version advances to 2. Root 1 retains the exact published manifest/envelope v1
encoding. KARC framing remains v1; authenticated archive
metadata includes the source manifest/root version.

Package format 3 (refactor Slice 9) seals an archive as numbered segments
under one key per archive: HKDF-SHA-256 from the root with purpose
`kin/archive-stream/v1`, a fresh 256-bit salt and the authenticated archive
metadata in the info, so a changed manifest derives a different key. Segment
`i` uses AES-256-GCM with nonce `prefix:8 || i:u32` (a random prefix per
archive; the key is already unique) and additional data naming the purpose,
vault ID, `i` and whether it is the final segment. This is the STREAM
construction: the reader marks only the last segment it finds as final, so
truncation, reordering, repetition and splicing fail authentication. Package
format 2 archives (one `kin/archive/v1` payload) are still opened.

During staging, the candidate root may encrypt the source root for exact restart
recovery. The reverse bridge never exists. The source bridge and old wrappers are
removed from authority at event publication, and old key rows/stages are removed
before normal access resumes. A copied old wrapper plus secret cannot recover the
new root or decrypt newly protected local records. This cannot recall copied
plaintext, sync keys, old archives or keys captured from an unlocked browser.

Kin implements authenticated local storage, recovery-wrapped encrypted archives and a relay that stores/forwards opaque envelopes. This is not a zero-knowledge claim. The service sees identifiers, timing, counts, ciphertext sizes, membership, cursors, public keys and network metadata; it controls availability and can withhold history. An authorized compromised browser/runtime can read plaintext and invoke keys. The identity service and relay are memory-only. Archives recover local history, not server identity or trust. Do not claim independent security audit, production hardening, anonymity or protection from an unlocked compromised device.
