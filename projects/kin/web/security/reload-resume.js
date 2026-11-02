// Reload resume (#351, ADR 0010): a refresh keeps Kin unlocked in the same tab.
//
// The browser can't tell a refresh from a close while the page unloads, so the
// unloading page leaves a one-use ticket and the next page load decides:
//
// - At unlock, `arm()` makes a non-extractable AES-GCM key for this tab, keeps
//   it in IndexedDB under a random ticket id, and seals the household root
//   with it in memory. The root bytes are never stored.
// - On `pagehide`, `write()` (synchronous) puts only the sealed root, the
//   ticket id and checks in sessionStorage, which is per tab and is gone when
//   the tab closes.
// - At startup, `take()` reads and deletes the ticket and its key at once. It
//   unseals only when the page load is a `reload`, inside the window, before
//   the auto-lock deadline, and when the vault, root version and durable lock
//   epoch still match. Anything else is an ordinary locked start.
// - Every real lock (Lock, auto-lock, another tab, logout, leaving) calls
//   `disarm()`, which deletes the key and any ticket.
//
// Neither half unlocks alone: the ticket is useless without the key, and the
// key can't be read out of the browser. The owner accepted that someone with
// access to the browser profile during the window could combine them.

export const RESUME_WINDOW_MS = 2 * 60_000;
export const TICKET_STORAGE_KEY = "kin.reload-resume";
export const PREFERENCE_KEY = "kin.reload-resume-enabled";
const DATABASE_NAME = "kin-reload-resume";
const STORE_NAME = "keys";
const LOCK_PREFIX = "kin-reload-resume:";
const ID_PATTERN = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();

/** Whether a refresh may keep Kin unlocked on this device (default on). */
export function readReloadResumePreference(storage = globalThis.localStorage) {
  try { return storage?.getItem(PREFERENCE_KEY) !== "off"; } catch { return true; }
}

export function writeReloadResumePreference(enabled, storage = globalThis.localStorage) {
  try {
    storage?.setItem(PREFERENCE_KEY, enabled ? "on" : "off");
  } catch { /* Preference only; the default stays on. */ }
}

/** How this document was loaded: "reload", "navigate", "back_forward" or null. */
export function currentNavigationType(performance = globalThis.performance) {
  try { return performance?.getEntriesByType?.("navigation")?.[0]?.type ?? null; } catch { return null; }
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function additionalData(id, vaultId, rootVersion) {
  return encoder.encode(`kin/reload-resume/v1|${id}|${vaultId}|${rootVersion}`);
}

/** Validates a parsed ticket; returns it or null. */
function validTicket(value) {
  if (!value || typeof value !== "object" || value.v !== 1) return null;
  const { id, vaultId, rootVersion, lockEpoch, iv, sealed, expiresAt, autoLockAt } = value;
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(vaultId)) return null;
  if (!Number.isSafeInteger(rootVersion) || rootVersion < 1) return null;
  if (!Number.isSafeInteger(lockEpoch) || lockEpoch < 0) return null;
  if (!Number.isFinite(expiresAt)) return null;
  if (autoLockAt !== null && !Number.isFinite(autoLockAt)) return null;
  if (typeof iv !== "string" || typeof sealed !== "string") return null;
  return value;
}

/** IndexedDB holding one CryptoKey per armed tab (structured clone keeps it
 * non-extractable). */
export function indexedDbKeyStore(indexedDB = globalThis.indexedDB) {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, action) => {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  };
  return {
    put: (id, key) => run("readwrite", (store) => store.put(key, id)),
    get: (id) => run("readonly", (store) => store.get(id)),
    delete: (id) => run("readwrite", (store) => store.delete(id)),
    ids: () => run("readonly", (store) => store.getAllKeys()),
  };
}

/** Web Locks mark which tabs are alive, so a sweep never deletes the key of a
 * tab that is still open. */
export function webLockLiveness(locks = globalThis.navigator?.locks) {
  return {
    hold(id) {
      if (!locks?.request) return () => {};
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      locks.request(LOCK_PREFIX + id, () => held).catch(() => {});
      return release;
    },
    async heldIds() {
      if (!locks?.query) return null;
      const { held = [] } = await locks.query();
      return new Set(held.map((lock) => lock.name).filter((name) => name?.startsWith(LOCK_PREFIX)).map((name) => name.slice(LOCK_PREFIX.length)));
    },
  };
}

export class ReloadResume {
  constructor({
    crypto = globalThis.crypto,
    keys = indexedDbKeyStore(),
    session = globalThis.sessionStorage,
    liveness = webLockLiveness(),
    now = () => Date.now(),
    enabled = () => readReloadResumePreference(),
  } = {}) {
    Object.assign(this, { crypto, keys, session, liveness, now, enabled });
    this.armed = null;
    this.generation = 0;
  }

  /** Seals `vault`'s root for a later refresh. Safe to call again; a lock
   * while this runs leaves nothing behind. */
  async arm(vault) {
    const generation = ++this.generation;
    await this.release();
    if (generation !== this.generation || !this.enabled()) return false;
    vault.assertUnlocked();
    const id = hex(this.crypto.getRandomValues(new Uint8Array(16)));
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const key = await this.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    if (generation !== this.generation || vault.locked) return false;
    const sealed = new Uint8Array(await this.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(id, vault.vaultId, vault.rootVersion) }, key, vault.root));
    if (generation !== this.generation || vault.locked) return false;
    const releaseLock = this.liveness.hold(id);
    try { await this.keys.put(id, key); }
    catch { releaseLock(); return false; }
    if (generation !== this.generation || vault.locked) {
      releaseLock();
      await this.keys.delete(id).catch(() => {});
      return false;
    }
    this.armed = { id, vault, iv: toBase64(iv), sealed: toBase64(sealed), releaseLock };
    return true;
  }

  /** Leaves the ticket for the next page load (synchronous: runs on pagehide). */
  write({ vault, autoLockAt = null } = {}) {
    const armed = this.armed;
    if (!armed || armed.vault !== vault || !vault || vault.locked || !this.enabled()) {
      this.removeTicket();
      return false;
    }
    const ticket = {
      v: 1, id: armed.id, vaultId: vault.vaultId, rootVersion: vault.rootVersion,
      lockEpoch: vault.securityEpoch ?? vault.manifest?.lockEpoch ?? 0,
      iv: armed.iv, sealed: armed.sealed,
      expiresAt: this.now() + RESUME_WINDOW_MS, autoLockAt,
    };
    try { this.session?.setItem(TICKET_STORAGE_KEY, JSON.stringify(ticket)); return true; }
    catch { return false; }
  }

  removeTicket() {
    try { this.session?.removeItem(TICKET_STORAGE_KEY); } catch { /* Nothing stored. */ }
  }

  /** Forgets this tab's armed key without touching a written ticket. */
  async release() {
    const armed = this.armed;
    this.armed = null;
    if (!armed) return;
    armed.releaseLock();
    await this.keys.delete(armed.id).catch(() => {});
  }

  /** A real lock: no refresh may resume after it. */
  async disarm() {
    this.generation++;
    this.removeTicket();
    await this.release();
  }

  /** Consumes any ticket. Returns { root, manifest, autoLockAt } only when a
   * refresh may resume; otherwise null. The caller owns and zeroes `root`. */
  async take({ navigationType, readManifest }) {
    let raw = null;
    try {
      raw = this.session?.getItem(TICKET_STORAGE_KEY) ?? null;
      this.session?.removeItem(TICKET_STORAGE_KEY);
    } catch { return null; }
    if (!raw) return null;
    let ticket = null;
    try { ticket = validTicket(JSON.parse(raw)); } catch { ticket = null; }
    if (!ticket) return null;
    let key = null;
    try { key = await this.keys.get(ticket.id); } catch { key = null; }
    await this.keys.delete(ticket.id).catch(() => {});
    const now = this.now();
    if (!key || navigationType !== "reload" || !this.enabled()) return null;
    if (now > ticket.expiresAt || (ticket.autoLockAt !== null && now >= ticket.autoLockAt)) return null;
    let manifest;
    try { manifest = await readManifest(); } catch { return null; }
    if (manifest?.phase !== "encrypted" || manifest.vaultId !== ticket.vaultId ||
        manifest.rootVersion !== ticket.rootVersion || (manifest.lockEpoch ?? 0) !== ticket.lockEpoch)
      return null;
    try {
      const root = new Uint8Array(await this.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(ticket.iv), additionalData: additionalData(ticket.id, ticket.vaultId, ticket.rootVersion) },
        key, fromBase64(ticket.sealed)));
      if (root.byteLength !== 32) { root.fill(0); return null; }
      return { root, manifest, autoLockAt: ticket.autoLockAt };
    } catch { return null; }
  }

  /** Deletes keys no live tab holds (closed tabs leave them behind). */
  async sweep() {
    try {
      const held = await this.liveness.heldIds();
      if (!held) return;
      for (const id of await this.keys.ids()) {
        if (id !== this.armed?.id && !held.has(id)) await this.keys.delete(id).catch(() => {});
      }
    } catch { /* Hygiene only: a stray key can't unlock without its ticket. */ }
  }
}
