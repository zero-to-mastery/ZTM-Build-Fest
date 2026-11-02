// Members' encrypted key vaults on the service (ADR 0018, #564/#566).
//
// A vault is ciphertext the member's own device made (web/security/
// account-vault.js); the service never holds the vault key, a password, a
// passkey's PRF output or a backup code. It keeps, per member, the sealed
// vault with a version that only grows, and up to eight wrappers that each
// hold the vault key under one way of opening it. It enforces who may read
// and write them, their sizes, compare-and-set on versions, and that a vault
// always keeps at least one wrapper.
//
// Who may: only the member themselves, from a signed-in session on one of
// their trusted devices (the same authorization as sync; a removed member,
// a revoked device or no session is refused). Every route addresses the
// session's own member, so no request can name another member's vault.
// Downloads are also rate-limited per member and per client address: a
// sign-in without a trusted device (#568) also downloads, behind a
// new-device capability (downloadWithCapability), and a download is what an
// offline guesser wants, so it's bounded.
//
// Failed unlocks are never reported to the service (it can't see them); a
// device counts its own.
//
// Wrapper-set rules (ADR 0018 D3/D4, #561/#572), checked on the set a change
// would leave, before anything is stored (`wrapperSetProblem`):
// - at least one wrapper;
// - no password-only wrapper beside a passkey or password-and-passkey
//   wrapper: once a passkey is added, a copy of this database holds nothing a
//   password guess opens;
// - no passkey-alone wrapper beside a password-and-passkey wrapper: "require
//   password and passkey" means a passkey alone opens nothing;
// - each passkey opens the vault at most once, and there is at most one
//   backup code.
// Transitions that swap one kind for another (adding a passkey, turning
// "require password and passkey" on or off, a new backup code) go through
// `changeWrappers`, which removes and adds in one transaction.
import { DeviceWindow } from "./chat-limits.mjs";
import {
  ACCOUNT_VAULT_WRAPPED_KEY_BYTES,
  ACCOUNT_VAULT_WRAPPER_TYPES,
  DurableConflictError,
  MAX_ACCOUNT_VAULT_BYTES,
  MAX_ACCOUNT_VAULT_WRAPPERS,
  MAX_ACCOUNT_VAULT_WRAPPER_PARAMS_BYTES,
  MIN_ACCOUNT_PASSWORD_ITERATIONS,
  MIN_ACCOUNT_VAULT_BYTES,
} from "./durable-store.mjs";
import { PairingError } from "./pairing-service.mjs";

/** Vault downloads one member may make in a window. Every download is
 * behind a signed-in session or a new-device capability (which has its own
 * limits), so this bounds traffic, not guessing: a sign-up, a second device
 * signing in and both opening private storage use several (#520). */
export const VAULT_DOWNLOADS_PER_MEMBER = 60;
/** Vault downloads from one client address in a window, across members (a
 * household behind one router). */
export const VAULT_DOWNLOADS_PER_ADDRESS = 120;
/** Vault and wrapper writes one member may make in a window. A new epoch
 * writes once per trusted device that notices it; this stops a loop. */
export const VAULT_WRITES_PER_MEMBER = 60;
export const VAULT_WINDOW_MS = 15 * 60_000;

const VAULT_MAGIC = "KVLT";
const ID = /^[a-f0-9]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Storage when the service has no durable store (tests, in-memory mode),
 * with the same decisions as durable-store/account-vault.mjs. */
class MemoryAccountVaultStore {
  constructor() { this.vaults = new Map(); this.passwords = new Map(); }
  accountVault(householdId, memberId) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId) return null;
    return { version: row.version, ciphertext: row.ciphertext.slice(), updatedAt: row.updatedAt,
      wrappers: [...row.wrappers.values()].sort((a, b) => (a.wrapperId < b.wrapperId ? -1 : 1)).map((wrapper) => structuredClone(wrapper)) };
  }
  putAccountVault(householdId, memberId, { expectedVersion, ciphertext, wrappers = [], now }) {
    const row = this.vaults.get(memberId);
    if (row && row.householdId !== householdId) throw new DurableConflictError("vault_version_conflict", "The vault changed on another device meanwhile.");
    if ((row?.version ?? 0) !== expectedVersion) throw new DurableConflictError("vault_version_conflict", "The vault changed on another device meanwhile.");
    const next = row ?? { householdId, wrappers: new Map() };
    next.version = expectedVersion + 1;
    next.ciphertext = ciphertext.slice();
    next.updatedAt = now;
    for (const wrapper of wrappers) next.wrappers.set(wrapper.wrapperId, { ...structuredClone(wrapper), updatedAt: now });
    this.vaults.set(memberId, next);
    return next.version;
  }
  putAccountVaultWrapper(householdId, memberId, wrapper, now) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId) throw new DurableConflictError("vault_not_found", "There is no vault to add this to.");
    const existing = row.wrappers.get(wrapper.wrapperId);
    if (!existing) {
      if (row.wrappers.size >= MAX_ACCOUNT_VAULT_WRAPPERS) throw new DurableConflictError("vault_wrapper_limit", "This vault already has as many ways to open it as Kin allows.");
      if (wrapper.version !== 1) throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
    } else if (existing.type !== wrapper.type || wrapper.version !== existing.version + 1) {
      throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
    }
    row.wrappers.set(wrapper.wrapperId, { ...structuredClone(wrapper), updatedAt: now });
    return { version: wrapper.version, added: !existing };
  }
  changeAccountVaultWrappers(householdId, memberId, { put = [], remove = [] }, now, check = () => {}) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId) throw new DurableConflictError("vault_not_found", "There is no vault to add this to.");
    const saved = row.wrappers;
    row.wrappers = new Map([...saved].map(([key, value]) => [key, structuredClone(value)]));
    try {
      for (const wrapperId of remove) {
        if (!row.wrappers.delete(wrapperId)) throw new DurableConflictError("vault_wrapper_not_found", "That way of opening the vault was not found.");
      }
      for (const wrapper of put) {
        const existing = row.wrappers.get(wrapper.wrapperId);
        if (!existing) {
          if (row.wrappers.size >= MAX_ACCOUNT_VAULT_WRAPPERS) throw new DurableConflictError("vault_wrapper_limit", "This vault already has as many ways to open it as Kin allows.");
          if (wrapper.version !== 1) throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
        } else if (existing.type !== wrapper.type || wrapper.version !== existing.version + 1) {
          throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
        }
        row.wrappers.set(wrapper.wrapperId, { ...structuredClone(wrapper), updatedAt: now });
      }
      const wrappers = [...row.wrappers.values()].sort((a, b) => (a.wrapperId < b.wrapperId ? -1 : 1))
        .map(({ wrapperId, type, version, params }) => ({ wrapperId, type, version, params: structuredClone(params) }));
      if (!wrappers.length) throw new DurableConflictError("vault_last_wrapper", "Keep at least one way to open your vault.");
      check(wrappers);
      return wrappers;
    } catch (error) {
      row.wrappers = saved;
      throw error;
    }
  }
  removeAccountVaultWrapper(householdId, memberId, wrapperId) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId || !row.wrappers.has(wrapperId))
      throw new DurableConflictError("vault_wrapper_not_found", "That way of opening the vault was not found.");
    if (row.wrappers.size <= 1) throw new DurableConflictError("vault_last_wrapper", "Keep at least one way to open your vault.");
    row.wrappers.delete(wrapperId);
    return row.wrappers.size;
  }
  removeAccountKeys(householdId, memberId) {
    const vault = this.vaults.get(memberId);
    const password = this.passwords.get(memberId);
    let removed = false;
    if (vault?.householdId === householdId) { this.vaults.delete(memberId); removed = true; }
    if (password?.householdId === householdId) { this.passwords.delete(memberId); removed = true; }
    return removed;
  }
  accountPassword(householdId, memberId) {
    const row = this.passwords.get(memberId);
    return row && row.householdId === householdId ? structuredClone(row.value) : null;
  }
  putAccountPassword(householdId, memberId, { salt, iterations, verifier, now }) {
    const row = this.passwords.get(memberId);
    if (row && row.householdId !== householdId) return;
    this.passwords.set(memberId, { householdId, value: { salt: salt.slice(), iterations, verifier, updatedAt: now } });
  }
}

/** Errors whose meaning the client acts on, with their HTTP status. */
const CONFLICTS = {
  vault_version_conflict: 409,
  vault_not_found: 404,
  vault_wrapper_conflict: 409,
  vault_wrapper_limit: 409,
  vault_wrapper_not_found: 404,
  vault_last_wrapper: 409,
  vault_wrapper_rules: 409,
};

/**
 * Why a set of wrappers (`[{ type, params }]`) breaks the wrapper-set rules
 * above, in plain words, or null when it keeps them.
 */
export function wrapperSetProblem(wrappers) {
  const count = (type) => wrappers.filter((wrapper) => wrapper.type === type).length;
  if (!wrappers.length) return "Keep at least one way to open your vault.";
  if (count("password") && (count("passkey") || count("password-passkey")))
    return "Once you add a passkey, your password alone no longer opens your account.";
  if (count("passkey") && count("password-passkey"))
    return "Your account asks for your password and your passkey, so a passkey alone can't open it.";
  if (count("backup-code") > 1) return "Your account has one backup code. A new one replaces the old one.";
  const credentials = wrappers.filter((wrapper) => wrapper.type === "passkey" || wrapper.type === "password-passkey")
    .map((wrapper) => wrapper.params?.credentialId);
  if (new Set(credentials).size !== credentials.length) return "That passkey already opens your account.";
  return null;
}

function checkWrapperSet(wrappers) {
  const problem = wrapperSetProblem(wrappers);
  if (problem) throw new DurableConflictError("vault_wrapper_rules", problem);
}

export class AccountVaultService {
  constructor({ store = null, now = () => Date.now() } = {}) {
    this.storage = store ?? new MemoryAccountVaultStore();
    this.now = now;
    this.memberDownloads = new DeviceWindow({ limit: VAULT_DOWNLOADS_PER_MEMBER, windowMs: VAULT_WINDOW_MS, now });
    this.addressDownloads = new DeviceWindow({ limit: VAULT_DOWNLOADS_PER_ADDRESS, windowMs: VAULT_WINDOW_MS, now });
    this.memberWrites = new DeviceWindow({ limit: VAULT_WRITES_PER_MEMBER, windowMs: VAULT_WINDOW_MS, now });
  }

  /**
   * The signed-in member's vault and wrappers: `{ vault, wrappers }`, with
   * `vault` null when the member has none. `auth` comes from a trusted
   * session (PairingService.authorize); `clientKey` is the request's address
   * key (server/client-key.mjs).
   */
  download(auth, clientKey) {
    // Both windows are checked before either is charged, so a refused
    // address doesn't spend the member's allowance (or the reverse).
    if (!this.addressDownloads.allows(`address:${clientKey}`) || !this.memberDownloads.allows(auth.member.id))
      throw rateLimited();
    this.addressDownloads.spend(`address:${clientKey}`);
    this.memberDownloads.spend(auth.member.id);
    return present(this.storage.accountVault(auth.household.id, auth.member.id));
  }

  /**
   * Download for a sign-in on a device with no cookie (ADR 0018 section 4,
   * #568). `capability` is what PairingService.spendNewDeviceDownload
   * returns for a checked, unexpired new-device capability:
   * `{ householdId, memberId, method, credentialId }`. Only the wrappers that
   * sign-in method opens are released (a password sign-in gets the password
   * wrapper; a passkey sign-in the wrapper for the passkey it asserted; both,
   * the password-and-passkey wrapper for that passkey), so a sign-in never
   * hands out more offline-guessing material than it needs. The same member
   * and address limits as `download` apply.
   */
  downloadWithCapability(capability, clientKey) {
    const { householdId, memberId, method, credentialId } = capability ?? {};
    if (!householdId || !memberId || !["password", "passkey", "password-passkey", "backup-code"].includes(method))
      throw new PairingError("new_device_expired", "This sign-in expired or was already used. Sign in again.", 401);
    if (!this.addressDownloads.allows(`address:${clientKey}`) || !this.memberDownloads.allows(memberId))
      throw rateLimited();
    this.addressDownloads.spend(`address:${clientKey}`);
    this.memberDownloads.spend(memberId);
    const row = this.storage.accountVault(householdId, memberId);
    const opens = (wrapper) => wrapper.type === method && (["password", "backup-code"].includes(method) || wrapper.params.credentialId === credentialId);
    const wrappers = row?.wrappers.filter(opens) ?? [];
    if (!row || !wrappers.length)
      throw new PairingError("vault_not_found", "Kin couldn't find a way to open your vault with that sign-in.", 404);
    // A backup-code sign-in sets a new password next (#572), which re-wraps
    // or removes the wrappers that depend on the old one: it is told which
    // exist (IDs, types, versions and public parameters, no wrapped keys).
    // The code is 256 random bits and opens the vault on its own, so this
    // tells its holder nothing they couldn't already reach.
    const others = method === "backup-code" ? row.wrappers.filter((wrapper) => !opens(wrapper)).map(summarize) : undefined;
    return { ...present({ ...row, wrappers }), ...(others ? { others } : {}) };
  }

  /** The member's backup-code check value (#572), or null without a code. */
  backupCodeVerifier(householdId, memberId) {
    const row = this.storage.accountVault(householdId, memberId);
    return row?.wrappers.find((wrapper) => wrapper.type === "backup-code")?.params.verifier ?? null;
  }

  /** The member's wrappers without their wrapped keys (`type`, `params`),
   * or null without a vault: what decides how they may sign in on a new
   * device (pairing-service/new-device.mjs). */
  wrapperSummary(householdId, memberId) {
    const row = this.storage.accountVault(householdId, memberId);
    return row ? row.wrappers.map(({ wrapperId, type, params }) => ({ wrapperId, type, params: structuredClone(params) })) : null;
  }

  /** The signed-in member's wrappers for the security settings: IDs, types,
   * versions, public parameters and update times, no wrapped keys and no
   * backup-code check value; null without a vault. Not a download: nothing
   * here helps a guesser, so it isn't counted against the download limits. */
  summary(auth) {
    const row = this.storage.accountVault(auth.household.id, auth.member.id);
    return row ? row.wrappers.map((wrapper) => ({ ...summarize(wrapper), updatedAt: wrapper.updatedAt })) : null;
  }

  /**
   * Stores a new vault version compare-and-set. `body`:
   * `{ expectedVersion, ciphertext, wrappers? }`; `expectedVersion` 0 creates
   * the vault and then needs `wrappers` (1 to 8, each version 1). Returns
   * `{ version }`; 409 `vault_version_conflict` when another device wrote
   * first.
   */
  upload(auth, body) {
    this.spendWrite(auth);
    const { expectedVersion, ciphertext } = parseSealed(body, 0);
    let wrappers = [];
    if (expectedVersion === 0) {
      if (!Array.isArray(body.wrappers) || body.wrappers.length < 1 || body.wrappers.length > MAX_ACCOUNT_VAULT_WRAPPERS) throw invalid();
      wrappers = body.wrappers.map((wrapper) => parseWrapper(wrapper));
      if (new Set(wrappers.map((wrapper) => wrapper.wrapperId)).size !== wrappers.length || wrappers.some((wrapper) => wrapper.version !== 1))
        throw invalid();
      this.guard(() => checkWrapperSet(wrappers));
    } else if (body.wrappers !== undefined) {
      throw invalid();
    }
    const version = this.guard(() => this.storage.putAccountVault(auth.household.id, auth.member.id,
      { expectedVersion, ciphertext, wrappers, now: this.now() }));
    return { version };
  }

  /**
   * Checks the vault change a key rotation carries (POST /api/sync/epochs,
   * #791): exactly `{ expectedVersion, ciphertext }`, a version of at least 1
   * (creating a vault needs wrappers and goes through `upload`) and a sealed
   * vault in bounds. Returns `{ expectedVersion, ciphertext }` with the bytes
   * decoded; 400 `vault_invalid` otherwise. Nothing is stored.
   */
  parseVaultChange(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).sort().join() !== "ciphertext,expectedVersion") throw invalid();
    return parseSealed(body, 1);
  }

  /**
   * Stores a parsed vault change for `auth`'s member compare-and-set, as one
   * vault write (the rotation's transaction makes it all or nothing with the
   * epoch commit, #791). Returns the new version. 404 `vault_not_found`
   * without a vault, 429 `vault_rate_limited`, 409 `vault_version_conflict`
   * when another device wrote first.
   */
  applyVaultChange(auth, { expectedVersion, ciphertext }) {
    if (!this.storage.accountVault(auth.household.id, auth.member.id))
      throw new PairingError("vault_not_found", "There is no vault to add this to.", 404);
    this.spendWrite(auth);
    return this.guard(() => this.storage.putAccountVault(auth.household.id, auth.member.id,
      { expectedVersion, ciphertext, wrappers: [], now: this.now() }));
  }

  /** Adds (version 1) or replaces (its version plus one) one wrapper, if
   * the set it leaves keeps the wrapper-set rules. */
  putWrapper(auth, wrapperId, body) {
    this.spendWrite(auth);
    const wrapper = parseWrapper({ ...body, wrapperId });
    this.applyChange(auth, { put: [wrapper], remove: [] });
    return { wrapperId, version: wrapper.version, added: wrapper.version === 1 };
  }

  /** Removes one wrapper; the last one can't be removed. */
  removeWrapper(auth, wrapperId) {
    this.spendWrite(auth);
    if (!ID.test(wrapperId ?? "")) throw invalid();
    return { remaining: this.applyChange(auth, { put: [], remove: [wrapperId] }).length };
  }

  /**
   * Removes and adds wrappers in one step (#561/#572): `body` is
   * `{ put: [wrapper], remove: [wrapperId] }`, at most eight of each, no ID
   * twice. The resulting set must keep the wrapper-set rules
   * (`vault_wrapper_rules`, 409); nothing changes otherwise. Returns the
   * resulting wrappers (as `summary`, without update times).
   */
  changeWrappers(auth, body) {
    this.spendWrite(auth);
    return { wrappers: this.applyChange(auth, parseChange(body)).map(summarize) };
  }

  /** Checks a change body as `changeWrappers` would, without applying it
   * (a backup-code sign-in, #572, sends one with its device registration). */
  parseChange(body) {
    return parseChange(body);
  }

  /** Applies a parsed change for `auth`'s member (`{ household: { id },
   * member: { id } }`), keeping the wrapper-set rules; no write is charged. */
  applyChange(auth, change) {
    return this.guard(() => this.storage.changeAccountVaultWrappers(auth.household.id, auth.member.id, change, this.now(), checkWrapperSet));
  }

  /** A removed member's vault, wrappers and password verifier go (the
   * pairing service calls this through onAccountRemoved). */
  removeMember(householdId, memberId) {
    return this.storage.removeAccountKeys(householdId, memberId);
  }

  spendWrite(auth) {
    if (!this.memberWrites.spend(auth.member.id)) throw rateLimited();
  }

  guard(operation) {
    try {
      return operation();
    } catch (error) {
      if (error instanceof DurableConflictError && CONFLICTS[error.code])
        throw new PairingError(error.code, error.message, CONFLICTS[error.code]);
      throw error;
    }
  }
}

function present(row) {
  if (!row) return { vault: null, wrappers: [] };
  return {
    vault: { version: row.version, ciphertext: Buffer.from(row.ciphertext).toString("base64url"), updatedAt: row.updatedAt },
    wrappers: row.wrappers.map((wrapper) => ({
      ...summarize(wrapper), wrapped: Buffer.from(wrapper.wrapped).toString("base64url"), updatedAt: wrapper.updatedAt,
    })),
  };
}

/** A wrapper without its wrapped key or the backup-code check value: only
 * what a device needs to rebuild its KEK. */
function summarize({ wrapperId, type, version, params }) {
  const { verifier: _verifier, ...shown } = params ?? {};
  return { wrapperId, type, version, params: structuredClone(shown) };
}

function parseChange(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const { put = [], remove = [] } = body;
  if (!Array.isArray(put) || !Array.isArray(remove) || put.length > MAX_ACCOUNT_VAULT_WRAPPERS ||
      remove.length > MAX_ACCOUNT_VAULT_WRAPPERS || put.length + remove.length === 0) throw invalid();
  const parsed = put.map((wrapper) => parseWrapper(wrapper));
  if (remove.some((wrapperId) => !ID.test(wrapperId ?? "")) ||
      new Set([...parsed.map((wrapper) => wrapper.wrapperId), ...remove]).size !== parsed.length + remove.length) throw invalid();
  return { put: parsed, remove: [...remove] };
}

/** `{ expectedVersion, ciphertext }` from a body: a safe integer of at
 * least `minimum` and a sealed vault, decoded. */
function parseSealed(body, minimum) {
  const expectedVersion = body?.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < minimum) throw invalid();
  return { expectedVersion, ciphertext: decodeVault(body.ciphertext) };
}

/** A sealed vault: canonical base64url of "KVLT" format-1 bytes in bounds.
 * The rest is ciphertext the service can't check. */
function decodeVault(value) {
  const bytes = decodeBase64Url(value, MAX_ACCOUNT_VAULT_BYTES);
  if (!bytes || bytes.length < MIN_ACCOUNT_VAULT_BYTES || bytes.subarray(0, 4).toString("latin1") !== VAULT_MAGIC || bytes[4] !== 1)
    throw invalid();
  return new Uint8Array(bytes);
}

function parseWrapper(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { wrapperId, type, version, params, wrapped } = value;
  if (!ID.test(wrapperId ?? "") || !ACCOUNT_VAULT_WRAPPER_TYPES.includes(type) || !Number.isSafeInteger(version) || version < 1)
    throw invalid();
  const bytes = decodeBase64Url(wrapped, ACCOUNT_VAULT_WRAPPED_KEY_BYTES);
  if (!bytes || bytes.length !== ACCOUNT_VAULT_WRAPPED_KEY_BYTES || bytes[0] !== 1) throw invalid();
  const checked = parseParams(type, params);
  if (JSON.stringify(checked).length > MAX_ACCOUNT_VAULT_WRAPPER_PARAMS_BYTES) throw invalid();
  return { wrapperId, type, version, params: checked, wrapped: new Uint8Array(bytes) };
}

/**
 * The public parameters a device needs to rebuild a wrapper's KEK, by type:
 * a password wrapper's PBKDF2 salt and iterations; a passkey wrapper's
 * credential ID and PRF salt; both for password-and-passkey. A backup code
 * has no KEK parameters; it carries the service's check value for a
 * backup-code sign-in (#572), SHA-256 of the code's authKey, which the
 * service never hands out. Only these exact fields are kept.
 */
function parseParams(type, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw invalid();
  const result = {};
  const expected = [];
  if (type === "password" || type === "password-passkey") {
    if (params.kdf !== "pbkdf2-sha256" || !Number.isSafeInteger(params.iterations) ||
        params.iterations < MIN_ACCOUNT_PASSWORD_ITERATIONS || params.iterations > 10_000_000 ||
        decodeBase64Url(params.salt, 16)?.length !== 16)
      throw invalid();
    Object.assign(result, { kdf: params.kdf, iterations: params.iterations, salt: params.salt });
    expected.push("kdf", "iterations", "salt");
  }
  if (type === "passkey" || type === "password-passkey") {
    const credential = decodeBase64Url(params.credentialId, 1023);
    if (!credential || credential.length < 16 || decodeBase64Url(params.prfSalt, 32)?.length !== 32) throw invalid();
    Object.assign(result, { credentialId: params.credentialId, prfSalt: params.prfSalt });
    expected.push("credentialId", "prfSalt");
  }
  if (type === "backup-code") {
    if (decodeBase64Url(params.verifier, 32)?.length !== 32) throw invalid();
    result.verifier = params.verifier;
    expected.push("verifier");
  }
  if (Object.keys(params).some((key) => !expected.includes(key))) throw invalid();
  return result;
}

/** Canonical unpadded base64url of at most `maximum` bytes, or null. */
function decodeBase64Url(value, maximum) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) || !BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value && bytes.length <= maximum ? bytes : null;
}

const invalid = () => new PairingError("vault_invalid", "That vault change is invalid.", 400);
const rateLimited = () => new PairingError("vault_rate_limited", "Too many vault requests. Wait a few minutes and try again.", 429);
