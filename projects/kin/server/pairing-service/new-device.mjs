// PairingService, signing in on a new device (ADR 0018 section 4, #568).
//
// A browser with no trusted-device cookie signs in with a username and
// password, or a passkey, and gets a **new-device capability**, never a
// session: the browser isn't trusted yet. The capability is a random token in
// an HttpOnly cookie (`kin_new_device`), kept here only as its hash, that:
//
// - is bound to one member and to the device ID the new device will get;
// - expires after NEW_DEVICE_TTL_MS (ten minutes) and is held in memory only
//   (a restart cancels it, like pairings and sessions);
// - lets the browser download that member's vault and only the wrapper its
//   sign-in method opens (account-vault-service.mjs downloadWithCapability),
//   a few times;
// - is spent by exactly one device registration, which also checks the
//   device certificate the vault's certification key signed.
//
// Which sign-in opens the vault follows the member's wrappers (ADR 0018
// D3/D4): a password alone while the vault has a password wrapper and no
// passkey wrapper; a passkey alone once it has a passkey wrapper; and both,
// when the member chose "require password and passkey" (a password-passkey
// wrapper). The service decides from the wrapper types it stores, so a
// password can't be used where the member's vault says a passkey is needed.
//
// A third way in (#572): the username and the member's backup code. The
// browser sends HKDF(code, "kin/backup-auth/v1"); the service compares its
// SHA-256 with the check value kept beside the backup-code wrapper, in
// constant time. That capability opens the vault with the backup code, and
// registering the device with it must set a new password in the same step
// (the person most likely lost theirs): `registerNewDevice` refuses it
// without one.
//
// Limits: every failed check is charged to the member and the client address
// (the password limits, passwords.mjs), whichever of the three ways it was;
// capabilities issued per member are limited per window; at most
// NEW_DEVICE_OUTSTANDING_PER_MEMBER are live per member and
// MAX_NEW_DEVICE_CAPABILITIES in all.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { validateMemberCertifiedCertificate, validateCertificationEndorsement } from "../account-certification.mjs";
import { MAX_TRUSTED_DEVICES } from "../identity-limits.mjs";
import { MAX_KEY_EPOCHS } from "../sync-contract.mjs";
import { normalizeUsername, usernameProblem } from "../../web/security/account-credentials.js";
import { validateSyncPublicKeys } from "./devices.mjs";
import { decodeAuthKey, PASSWORD_ITERATIONS_MIN, PASSWORD_WINDOW_MS, SIGN_IN_FAILED } from "./passwords.mjs";
import { canParticipate, cleanLabel, hash, id, PairingError, token } from "./shared.mjs";

export const NEW_DEVICE_TTL_MS = 10 * 60_000;
/** Capabilities one member may be issued in a window (each is a full
 * sign-in; a few devices with retries). */
export const NEW_DEVICE_SIGN_INS_PER_MEMBER = 6;
/** Live capabilities per member; issuing another ends the oldest. */
export const NEW_DEVICE_OUTSTANDING_PER_MEMBER = 2;
export const MAX_NEW_DEVICE_CAPABILITIES = 256;
/** Vault downloads one capability allows (a retry or two). */
export const NEW_DEVICE_DOWNLOADS = 3;
/** Registrations one capability may attempt before it is spent anyway. */
export const NEW_DEVICE_REGISTRATION_ATTEMPTS = 3;
/** Sign-in parameter lookups per client address in a window. */
export const SIGN_IN_LOOKUPS = 30;

const signInFailed = () => new PairingError("sign_in_failed", SIGN_IN_FAILED, 401);
const backupCodeFailed = () => new PairingError("sign_in_failed", "That username and backup code didn't match. Check them and try again.", 401);
const tooMany = () => new PairingError("password_rate_limited", "Too many tries. Wait a few minutes and try again.", 429);
const expired = () => new PairingError("new_device_expired", "This sign-in expired or was already used. Sign in again.", 401);

/** A sliding-window counter like passwords.mjs's, for issuance and lookups. */
class Window {
  constructor(limit, windowMs, now) { Object.assign(this, { limit, windowMs, now, entries: new Map() }); }
  recent(key) {
    const cutoff = this.now() - this.windowMs;
    const times = (this.entries.get(key) ?? []).filter((time) => time > cutoff);
    if (times.length) this.entries.set(key, times); else this.entries.delete(key);
    return times;
  }
  allows(key) { return this.recent(key).length < this.limit; }
  spend(key) {
    const times = this.recent(key);
    if (!this.entries.has(key) && this.entries.size >= 4096) this.entries.delete(this.entries.keys().next().value);
    times.push(this.now());
    this.entries.set(key, times);
  }
}

export const newDeviceMethods = {
  newDeviceState() {
    this.newDeviceCapabilities ??= new Map();
    this.newDeviceIssued ??= new Window(NEW_DEVICE_SIGN_INS_PER_MEMBER, PASSWORD_WINDOW_MS, this.now);
    this.signInLookups ??= new Window(SIGN_IN_LOOKUPS, PASSWORD_WINDOW_MS, this.now);
    return this.newDeviceCapabilities;
  },

  /** The active member holding `username` (normalized), or null. */
  activeMemberByUsername(username) {
    if (!username) return null;
    for (const member of this.members.values())
      if (member.username === username && member.active && canParticipate(member, this.now()) && member.password) return member;
    return null;
  },

  /**
   * What a browser needs to derive authKey for `username`: its PBKDF2 salt
   * and iterations. An unknown username gets a stable made-up salt (an HMAC
   * of the name under the service secret), so the answer doesn't say whether
   * an account exists. Rate-limited per client address.
   */
  signInParameters(username, rateKey = "unknown") {
    this.newDeviceState();
    if (!this.signInLookups.allows(`address:${rateKey}`)) throw tooMany();
    this.signInLookups.spend(`address:${rateKey}`);
    const normalized = normalizeUsername(username);
    if (!normalized) throw new PairingError("username_invalid", usernameProblem(username), 400);
    const member = this.activeMemberByUsername(normalized);
    if (member) return { ...this.passwordParameters(member), username: normalized };
    const salt = createHmac("sha256", this.secret).update(`kin/sign-in-decoy-salt/v1:${normalized}`).digest().subarray(0, 16);
    return { username: normalized, salt: salt.toString("base64url"), iterations: PASSWORD_ITERATIONS_MIN };
  },

  /**
   * Signs in on a new device with a username and authKey (#569). Success is
   * a capability, not a session: `{ token, view }`. `vaultWrapperTypes(member)`
   * returns the member's vault wrapper types, or null without a vault.
   * One generic error for a wrong username or password.
   */
  async signInNewDeviceWithPassword({ username, authKey, rateKey = "unknown", vaultWrapperTypes }) {
    this.newDeviceState();
    const normalized = normalizeUsername(username);
    const member = this.activeMemberByUsername(normalized);
    // An unknown name is charged under the name, so guessing names is
    // limited too, and the Argon2id work runs either way (checkPassword).
    const keys = [member ? `member:${member.id}` : `username:${normalized ?? "-"}`, `address:${rateKey}`];
    const matched = await this.checkPassword(member, authKey, keys);
    if (!matched || !member || this.activeMemberByUsername(normalized) !== member) {
      if (matched) for (const key of keys) this.passwordLimits().spend(key);
      this.audit("new_device_sign_in_failed", member ? { householdId: member.householdId, memberId: member.id } : {});
      throw signInFailed();
    }
    this.assertNewDeviceHousehold(member);
    const types = vaultWrapperTypes(member);
    if (!types?.length)
      throw new PairingError("new_device_unavailable", "Your account has no key vault yet, so this device can't open it. Add this device from one of your devices instead.", 409);
    const passkeyAdded = types.includes("passkey") || types.includes("password-passkey");
    if (types.includes("password") && !passkeyAdded) return this.issueNewDeviceCapability(member, { method: "password" });
    if (types.includes("password-passkey")) return this.issueNewDeviceCapability(member, { method: "password-passkey", needsPasskey: true });
    if (types.includes("passkey"))
      throw new PairingError("passkey_required", "This account signs in on new devices with its passkey. Choose Sign in with a passkey.", 409);
    // Only a backup code is left (its passkey must be set up again, #572).
    throw new PairingError("backup_code_required", "This account signs in on new devices with its backup code for now. Choose Use my backup code.", 409);
  },

  /**
   * Signs in on a new device with a username and the backup code's authKey
   * (#572). `backupCodeVerifier(member)` is the member's check value
   * (account-vault-service.mjs), or null without a backup code. Charged
   * like a password attempt (per member, or per name when there's no such
   * member, and per address); one generic error for every mismatch.
   * Success is a capability whose registration must set a new password.
   */
  signInNewDeviceWithBackupCode({ username, codeAuth, rateKey = "unknown", backupCodeVerifier }) {
    this.newDeviceState();
    const normalized = normalizeUsername(username);
    const member = this.activeMemberByUsername(normalized);
    const keys = [member ? `member:${member.id}` : `username:${normalized ?? "-"}`, `address:${rateKey}`];
    const limits = this.passwordLimits();
    if (keys.some((key) => !limits.allows(key))) throw tooMany();
    const authKey = decodeAuthKey(codeAuth);
    const stored = member ? backupCodeVerifier(member) : null;
    const expected = stored ? Buffer.from(stored, "base64url") : Buffer.alloc(32);
    const actual = createHash("sha256").update(authKey ?? new Uint8Array(32)).digest();
    const matched = Boolean(stored && authKey) && expected.length === 32 && timingSafeEqual(expected, actual);
    authKey?.fill(0);
    if (!matched) {
      for (const key of keys) limits.spend(key);
      this.audit("new_device_sign_in_failed", member ? { householdId: member.householdId, memberId: member.id, method: "backup-code" } : {});
      throw backupCodeFailed();
    }
    this.assertNewDeviceHousehold(member);
    return this.issueNewDeviceCapability(member, { method: "backup-code" });
  },

  /**
   * The passkeys that may finish a sign-in for `username`, as
   * `{ memberId, credentials: [{ id, prfSalt }] }`, from the vault's passkey
   * wrappers (`vaultWrappers(member)`). `pending` is the capability record of
   * a password step that still needs its passkey; then only password-passkey
   * wrappers count. An unknown username or a member without such a wrapper
   * gets one made-up credential, stable per name, so the answer has the
   * same shape either way.
   */
  newDevicePasskeyCredentials({ username, pending = null, rateKey = "unknown", vaultWrappers }) {
    this.newDeviceState();
    if (!this.signInLookups.allows(`address:${rateKey}`)) throw tooMany();
    this.signInLookups.spend(`address:${rateKey}`);
    const member = pending ? this.members.get(pending.memberId) : this.activeMemberByUsername(normalizeUsername(username));
    const type = pending ? "password-passkey" : "passkey";
    const credentials = member ? (vaultWrappers(member) ?? [])
      .filter((wrapper) => wrapper.type === type && member.credentials.has(wrapper.params.credentialId))
      .map((wrapper) => ({ id: wrapper.params.credentialId, prfSalt: wrapper.params.prfSalt })) : [];
    if (credentials.length) return { memberId: member.id, credentials };
    const name = pending ? `pending:${pending.memberId}` : String(normalizeUsername(username) ?? "-");
    const decoy = (purpose) => createHmac("sha256", this.secret).update(`kin/sign-in-decoy-${purpose}/v1:${name}`).digest().toString("base64url");
    return { memberId: null, credentials: [{ id: decoy("credential"), prfSalt: decoy("prf-salt") }] };
  },

  /**
   * Finishes a passkey sign-in once the route verified the assertion of
   * `credentialId` for `memberId`: completes a pending password step
   * (require-both) or, with a passkey wrapper for that credential, issues a
   * passkey capability.
   */
  completeNewDevicePasskey({ memberId, credentialId, pendingToken = null, vaultWrappers }) {
    this.newDeviceState();
    const member = this.members.get(memberId);
    if (!member?.active || !canParticipate(member, this.now()) || !member.credentials.has(credentialId)) throw signInFailed();
    this.assertNewDeviceHousehold(member);
    const wrappers = vaultWrappers(member) ?? [];
    const pending = pendingToken ? this.newDeviceCapabilities.get(hash(String(pendingToken))) : null;
    if (pending?.needsPasskey && pending.memberId === member.id && pending.expiresAt > this.now()) {
      if (!wrappers.some((wrapper) => wrapper.type === "password-passkey" && wrapper.params.credentialId === credentialId)) throw signInFailed();
      pending.needsPasskey = false;
      pending.credentialId = credentialId;
      this.audit("new_device_sign_in", { householdId: member.householdId, memberId: member.id, method: "password-passkey" });
      return { token: null, view: this.newDeviceView(pending) };
    }
    if (!wrappers.some((wrapper) => wrapper.type === "passkey" && wrapper.params.credentialId === credentialId)) {
      if (wrappers.some((wrapper) => wrapper.type === "password-passkey"))
        throw new PairingError("password_required", "This account needs your password and your passkey. Enter your password first.", 409);
      throw signInFailed();
    }
    return this.issueNewDeviceCapability(member, { method: "passkey", credentialId });
  },

  /** Charges a failed passkey sign-in to the member (when known) and address. */
  newDevicePasskeyFailed(memberId, rateKey = "unknown") {
    const limits = this.passwordLimits();
    for (const key of [memberId ? `member:${memberId}` : null, `address:${rateKey}`].filter(Boolean)) limits.spend(key);
    this.audit("new_device_sign_in_failed", memberId ? { householdId: this.members.get(memberId)?.householdId, memberId } : {});
  },

  /** Refuses a passkey attempt before any work once the member or address
   * is over the sign-in limit. */
  assertNewDevicePasskeyAllowed(memberId, rateKey = "unknown") {
    const limits = this.passwordLimits();
    if ([memberId ? `member:${memberId}` : null, `address:${rateKey}`].filter(Boolean).some((key) => !limits.allows(key))) throw tooMany();
  },

  assertNewDeviceHousehold(member) {
    const household = this.households.get(member.householdId);
    if (household?.lifecycleState === "deleted")
      throw new PairingError("household_deleted", "This household was deleted and can no longer sync.", 410);
    if (household?.lifecycleState === "deletion_pending")
      throw new PairingError("household_deletion_pending", "This household is pending deletion and can no longer sync.", 410);
  },

  issueNewDeviceCapability(member, { method, credentialId = null, needsPasskey = false }) {
    const capabilities = this.newDeviceState();
    this.pruneNewDeviceCapabilities();
    if (!this.newDeviceIssued.allows(member.id)) throw tooMany();
    // The oldest of this member's live capabilities ends first.
    const live = [...capabilities].filter(([, record]) => record.memberId === member.id).sort((a, b) => a[1].issuedAt - b[1].issuedAt);
    while (live.length >= NEW_DEVICE_OUTSTANDING_PER_MEMBER) capabilities.delete(live.shift()[0]);
    if (capabilities.size >= MAX_NEW_DEVICE_CAPABILITIES)
      throw new PairingError("new_device_busy", "Kin is busy with other sign-ins. Wait a minute and try again.", 503);
    this.newDeviceIssued.spend(member.id);
    const value = token();
    const record = {
      memberId: member.id, householdId: member.householdId, deviceId: id(), method, credentialId, needsPasskey,
      issuedAt: this.now(), expiresAt: this.now() + NEW_DEVICE_TTL_MS, downloads: 0, attempts: 0,
    };
    capabilities.set(hash(value), record);
    if (!needsPasskey) this.audit("new_device_sign_in", { householdId: member.householdId, memberId: member.id, method });
    return { token: value, view: this.newDeviceView(record) };
  },

  /** Ends a capability (the person went back, or signed in again). */
  cancelNewDeviceCapability(value) {
    this.newDeviceState().delete(hash(String(value ?? "")));
  },

  pruneNewDeviceCapabilities(now = this.now()) {
    for (const [key, record] of this.newDeviceState())
      if (record.expiresAt <= now) this.newDeviceCapabilities.delete(key);
  },

  /**
   * The live capability for `value`, checked: unexpired, its member still
   * active, its household not being deleted and, unless `allowPending`, no
   * passkey step outstanding. Throws `new_device_expired` otherwise.
   */
  newDeviceCapability(value, { allowPending = false } = {}) {
    this.store?.assertAvailable();
    this.pruneNewDeviceCapabilities();
    const key = hash(String(value ?? ""));
    const record = this.newDeviceState().get(key);
    const member = record && this.members.get(record.memberId);
    if (!record || !member?.active || !canParticipate(member, this.now()) || member.householdId !== record.householdId) {
      if (record) this.newDeviceCapabilities.delete(key);
      throw expired();
    }
    this.assertNewDeviceHousehold(member);
    if (record.needsPasskey && !allowPending)
      throw new PairingError("passkey_required", "Confirm with your passkey to finish signing in.", 409);
    return { key, record, member };
  },

  /** What the browser shows after signing in: who, how, until when, and
   * the member's trusted devices to choose from ("Which device is this?"),
   * each saying whether it was carried over from the old address (#780), as
   * People & devices already shows the member. While the passkey step of
   * a password-and-passkey account is still to come, the list stays empty:
   * the password alone doesn't show the member's devices. */
  newDeviceView(record) {
    const member = this.members.get(record.memberId);
    const household = this.households.get(record.householdId);
    const devices = record.needsPasskey ? [] : [...this.devices.values()]
      .filter((device) => device.memberId === record.memberId && device.householdId === record.householdId && !device.revokedAt)
      .sort((left, right) => left.trustedAt - right.trustedAt)
      .map((device) => ({ deviceId: device.id, label: device.label, trustedAt: device.trustedAt, carriedOver: device.carriedOver === true }));
    return {
      method: record.method,
      needsPasskey: record.needsPasskey,
      expiresAt: record.expiresAt,
      username: member?.username ?? null,
      householdId: record.householdId,
      memberId: record.memberId,
      deviceId: record.deviceId,
      devices,
      deviceLimit: { maximum: MAX_TRUSTED_DEVICES, active: household ? this.activeTrustedDeviceCount(household) : 0 },
    };
  },

  /** Counts one vault download against the capability (NEW_DEVICE_DOWNLOADS). */
  spendNewDeviceDownload(value) {
    const { record } = this.newDeviceCapability(value);
    if (record.downloads >= NEW_DEVICE_DOWNLOADS)
      throw new PairingError("vault_rate_limited", "Too many vault requests for this sign-in. Sign in again.", 429);
    record.downloads += 1;
    return { householdId: record.householdId, memberId: record.memberId, method: record.method, credentialId: record.credentialId };
  },

  /** The member's endorsed certification key, kept on the device that
   * endorsed it, or null. A member has at most one. */
  certificationEndorsement(memberId) {
    for (const device of this.devices.values())
      if (device.memberId === memberId && device.certificationEndorsement) return device.certificationEndorsement;
    return null;
  },

  /**
   * Records the member's certification key, endorsed by this session's own
   * device (#570): the step that lets a later new device certify itself.
   * Idempotent for the same key; a different key for the same member is
   * refused (`certification_key_conflict`), so a member's certification key
   * never silently changes.
   */
  putCertificationEndorsement(sessionToken, endorsement) {
    const { member, household, device } = this.authorize(sessionToken);
    const checked = validateCertificationEndorsement(endorsement, { householdId: household.id, memberId: member.id, issuerDevice: device });
    const existing = this.certificationEndorsement(member.id);
    if (existing) {
      if (existing.fingerprint !== checked.fingerprint)
        throw new PairingError("certification_key_conflict", "This account already has a different certification key.", 409);
      return { endorsement: structuredClone(existing), stored: false };
    }
    device.certificationEndorsement = checked;
    this.audit("certification_key_endorsed", { householdId: household.id, memberId: member.id, deviceId: device.id });
    this.persistHousehold(household.id);
    return { endorsement: structuredClone(checked), stored: true };
  },

  /**
   * Registers the new device with the capability (#570), spending it: the
   * device's public keys, its certificate signed by the member's
   * certification key, and optionally the member's device it replaces
   * (revoked in the same step). `vaultEpochs` are the household epochs the
   * device took from the vault (recorded as provisioned, at most
   * `currentEpoch`). Returns the identity with a session and device token.
   * The trusted-device limit is checked after the replaced device is
   * revoked (RECOVERY), so a full household can still replace a device.
   * A backup-code sign-in (#572) must bring `newPassword` (a record from
   * preparePasswordChange): it replaces the member's password in the same
   * step, so the old password stops signing in.
   */
  registerNewDevice({ capability, syncPublicKeys, certificate, replaceDeviceId = null, deviceLabel = "Device", vaultEpochs = [], currentEpoch = 1, newPassword = null }) {
    const { key, record, member } = this.newDeviceCapability(capability);
    if (record.method === "backup-code" && !newPassword)
      throw new PairingError("new_password_required", "Choose a new password to finish signing in with your backup code.", 400);
    if (record.method !== "backup-code" && newPassword)
      throw new PairingError("invalid_request", "Kin could not understand that request.", 400);
    record.attempts += 1;
    if (record.attempts > NEW_DEVICE_REGISTRATION_ATTEMPTS) {
      this.newDeviceCapabilities.delete(key);
      throw expired();
    }
    const household = this.households.get(member.householdId);
    if (this.devices.has(record.deviceId)) {
      this.newDeviceCapabilities.delete(key);
      throw expired();
    }
    const keyRecord = validateSyncPublicKeys(syncPublicKeys);
    const endorsement = this.certificationEndorsement(member.id);
    if (!endorsement)
      throw new PairingError("certification_missing", "Your account's certification key isn't set up yet. Open Kin on one of your devices, then try again.", 409);
    const checked = validateMemberCertifiedCertificate(certificate, {
      householdId: household.id, memberId: member.id, deviceId: record.deviceId,
      publicKeys: keyRecord.syncPublicKeys, fingerprint: keyRecord.syncKeyFingerprint, endorsement,
    });
    let replaced = null;
    if (replaceDeviceId !== null && replaceDeviceId !== undefined) {
      replaced = this.devices.get(String(replaceDeviceId));
      if (!replaced || replaced.householdId !== household.id || replaced.memberId !== member.id || replaced.revokedAt)
        throw new PairingError("replacement_stale", "That device can't be replaced. Choose again.", 409);
    }
    if (this.activeTrustedDeviceCount(household) - (replaced ? 1 : 0) + 1 > MAX_TRUSTED_DEVICES)
      throw new PairingError("device_limit", "This household reached its trusted-device limit. Choose a device this one replaces.", 409);
    if (!Array.isArray(vaultEpochs) || vaultEpochs.length > MAX_KEY_EPOCHS) throw new PairingError("invalid_request", "Kin could not understand that request.", 400);
    const epochs = [...new Set(vaultEpochs)].filter((epoch) => Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= currentEpoch).sort((a, b) => a - b);

    // Everything is checked; the capability is spent before anything changes.
    this.newDeviceCapabilities.delete(key);
    const now = this.now();
    if (replaced) {
      replaced.revokedAt = now;
      if (replaced.tokenHash) this.deviceTokens.delete(replaced.tokenHash);
      for (const [sessionHash, session] of this.sessions)
        if (session.deviceId === replaced.id) this.sessions.delete(sessionHash);
      this.audit("device_revoked", { householdId: household.id, memberId: member.id, deviceId: replaced.id, reason: "replacement" });
    }
    const device = {
      id: record.deviceId, memberId: member.id, householdId: household.id, label: cleanLabel(deviceLabel),
      trustedAt: now, revokedAt: null, tokenHash: null, ...keyRecord, deviceAuthorizationCertificate: checked,
      ...(epochs.length ? { syncProvisionedEpochs: epochs } : {}),
    };
    this.devices.set(device.id, device);
    const deviceToken = this.issueDeviceToken(device);
    household.version += 1;
    if (newPassword) {
      member.password = { ...newPassword, username: member.username };
      this.audit("password_reset", { householdId: household.id, memberId: member.id, deviceId: device.id, method: "backup-code" });
    }
    this.audit("device_trusted", { householdId: household.id, memberId: member.id, deviceId: device.id, reason: "account_sign_in", method: record.method });
    if (replaced)
      this.audit("device_replacement_completed", { householdId: household.id, memberId: member.id, lostDeviceId: replaced.id, deviceId: device.id });
    this.persistHousehold(household.id);
    return {
      ...this.issueSession(member.id, device.id),
      deviceToken,
      householdId: household.id,
      memberId: member.id,
      deviceId: device.id,
      replacedDeviceId: replaced?.id ?? null,
    };
  },
};
