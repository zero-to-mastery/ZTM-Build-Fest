// "Start over on this browser" (#592 follow-up): for a device whose only
// way in is a passkey that no longer works (a device a member with a backup
// code set up with their passkey alone, #572), Kin removes everything it
// keeps in this browser, so the person can sign in again and replace this
// device, instead of being told to find "clear site data" in their browser's
// settings.
//
// What goes: every IndexedDB database Kin made here (the household's
// encrypted events, the device and epoch keys, chat, fridge and private
// logs, blob caches, the reload ticket), Kin's own localStorage and
// sessionStorage entries, and this browser's session (POST /api/logout).
// What stays: the household on the member's other devices and the
// service, and the offline shell (no household data). The device's
// `kin_device` cookie is HttpOnly; the service ends its session, and the
// device is replaced ("This replaces …") when the person signs in again.
//
// Nothing here asks: the lock screen shows a clear warning first.

const KNOWN_DATABASES = Object.freeze(["kin", "kin-crypto-keys", "kin-reload-resume"]);
const DELETE_WAIT_MS = 5_000;
/** sessionStorage key: the next start opens Sign in directly. */
export const START_OVER_SIGN_IN_KEY = "kin.start-over-sign-in";

/** Whether `name` is a database Kin made in this origin. */
export function isKinDatabase(name) {
  return typeof name === "string" && (name === "kin" || name.startsWith("kin-"));
}

function deleteDatabase(indexedDB, name, wait) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    // A connection another tab still holds closes on versionchange (every
    // Kin store does); until then the deletion waits ("blocked").
    const timer = setTimeout(() => done("pending"), wait);
    let request;
    try { request = indexedDB.deleteDatabase(name); } catch { done("failed"); return; }
    request.onsuccess = () => done("deleted");
    request.onerror = () => done("failed");
  });
}

function clearStorage(storage) {
  if (!storage) return 0;
  let removed = 0;
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && (key.startsWith("kin.") || key.startsWith("kin-"))) keys.push(key);
    }
    for (const key of keys) { storage.removeItem(key); removed += 1; }
  } catch { /* Blocked storage holds nothing of Kin's. */ }
  return removed;
}

/**
 * Removes Kin's data from this browser. Resolves to `{ databases, storage }`:
 * each database's outcome ("deleted", "failed", or "pending" when another
 * tab is still closing it) and how many storage entries went.
 */
export async function startOverOnThisBrowser({
  indexedDB = globalThis.indexedDB,
  localStorage = safeStorage("localStorage"),
  sessionStorage = safeStorage("sessionStorage"),
  fetchImpl = (...args) => globalThis.fetch(...args),
  wait = DELETE_WAIT_MS,
} = {}) {
  // The session ends first; offline, it simply expires.
  try { await fetchImpl("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store" }); }
  catch { /* nothing to sign out of here */ }
  let names = [...KNOWN_DATABASES];
  try {
    const listed = await indexedDB?.databases?.();
    if (Array.isArray(listed)) names = [...new Set([...names, ...listed.map((entry) => entry?.name).filter(isKinDatabase)])];
  } catch { /* The known names are deleted all the same. */ }
  const databases = {};
  if (indexedDB) for (const name of names) databases[name] = await deleteDatabase(indexedDB, name, wait);
  const storage = clearStorage(localStorage) + clearStorage(sessionStorage);
  try { sessionStorage?.setItem(START_OVER_SIGN_IN_KEY, "1"); } catch { /* the welcome screen offers Sign in too */ }
  return { databases, storage };
}

/** Whether this start follows "Start over" (and forgets it). */
export function takeStartOverSignIn(storage = safeStorage("sessionStorage")) {
  try {
    const value = storage?.getItem(START_OVER_SIGN_IN_KEY) === "1";
    storage?.removeItem(START_OVER_SIGN_IN_KEY);
    return value;
  } catch {
    return false;
  }
}

function safeStorage(name) {
  try { return globalThis[name] ?? null; } catch { return null; }
}
