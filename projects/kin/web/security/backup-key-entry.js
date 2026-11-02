// The password-manager entry for this device's backup key, and when Kin
// suggests passkey unlock instead (#563, #577, #579).
//
// The backup key (internally still the "recovery" wrapper; formats are
// unchanged) belongs to one device: each device has its own vault root and its
// own key. A password manager that syncs across devices offers every saved key
// everywhere, so the entry is named for the device and the key's label:
// "Kin backup key — Chrome on Android (K-7F3A)". The unlock form asks for the
// same name, so autofill offers this device's entry.
//
// The device name is its automatic one ("Chrome on Android"), never a
// nickname: nicknames are encrypted household data, and the entry name is
// remembered in browser storage, which holds no household plaintext. The
// device remembers the entry name it saved, with the label it belongs to, so
// unlock asks for exactly that entry even if the automatic name later
// changes. Entries saved before this change are named "Kin recovery key
// K-7F3A"; when nothing is remembered for the current label, unlock asks for
// that older name.
//
// Only a name is remembered, never the key. Storage can be unavailable
// (private windows, blocked site data): every read and write tolerates that.

export const BACKUP_KEY_ENTRY_KEY = "kin.backup-key-entry";
export const PASSKEY_SUGGESTION_DISMISSED_KEY = "kin.passkey-suggestion-dismissed";

// The longest device name put in an entry ("Samsung Internet on Android" fits).
const MAX_DEVICE_NAME = 48;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** A device name fit for an entry, or null for none or an anonymous one. */
export function entryDeviceName(name) {
  if (typeof name !== "string") return null;
  // Control characters and runs of spaces would make the entry hard to read.
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean === "This device" || clean === "Device") return null;
  const characters = [...clean];
  return characters.length > MAX_DEVICE_NAME ? `${characters.slice(0, MAX_DEVICE_NAME - 1).join("")}…` : clean;
}

/** "Kin backup key — Chrome on Android (K-7F3A)", dropping whichever part is unknown. */
export function backupKeyEntryName(label, deviceName) {
  const device = entryDeviceName(deviceName);
  const base = device ? `Kin backup key — ${device}` : "Kin backup key";
  return label ? `${base} (${label})` : base;
}

/** The name entries had before #579: "Kin recovery key K-7F3A". */
export function legacyEntryName(label) {
  return label ? `Kin recovery key ${label}` : "Kin recovery key";
}

// A few recent entries, newest first: a replacement is remembered when it is
// submitted, and if it doesn't finish the current key's entry must still match.
const REMEMBERED_ENTRIES = 3;

/** [{ label, name }] remembered on this device, newest first. */
export function rememberedEntries(storage = defaultStorage()) {
  try {
    const value = JSON.parse(storage?.getItem(BACKUP_KEY_ENTRY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry) => typeof entry?.label === "string" && entry.label && typeof entry?.name === "string" && entry.name)
        .slice(0, REMEMBERED_ENTRIES).map(({ label, name }) => ({ label, name }))
      : [];
  } catch { return []; }
}

/** Remembers the entry name saved for `label` on this device. */
export function rememberEntry(label, name, storage = defaultStorage()) {
  if (!label || !name) return;
  const entries = [{ label, name }, ...rememberedEntries(storage).filter((entry) => entry.label !== label)].slice(0, REMEMBERED_ENTRIES);
  try { storage?.setItem(BACKUP_KEY_ENTRY_KEY, JSON.stringify(entries)); } catch { /* A convenience; unlock falls back. */ }
}

/** The entry the unlock form asks for: the remembered name for this label, else the older format. */
export function unlockEntryName(label, remembered = []) {
  return (label && remembered.find((entry) => entry.label === label)?.name) || legacyEntryName(label);
}

/** The line under the unlock field naming the entry to pick. Both formats end with the label. */
export function entryHint(label) {
  return label ? `Use the saved entry ending ${label}.` : "";
}

export const ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY = "kin.account-passkey-offer-dismissed";
export const BACKUP_CODE_OFFER_DISMISSED_KEY = "kin.backup-code-offer-dismissed";
/** The backup code is offered after the first week (ADR 0018 section 7). */
export const BACKUP_CODE_OFFER_AFTER_MS = 7 * 24 * 60 * 60_000;

export function offerDismissed(key, storage = defaultStorage()) {
  try { return storage?.getItem(key) === "1"; } catch { return false; }
}

export function dismissOffer(key, storage = defaultStorage()) {
  try { storage?.setItem(key, "1"); } catch { /* Shown again next time; harmless. */ }
}

/**
 * Which calm account card Today shows for a password account (#562/#573),
 * if any: "account-passkey" (add a passkey) once the household has a first
 * useful thing in it, or "backup-code" once the member has had Kin for a
 * week; never both, never at sign-up, never offline, and each one gone for
 * good on this device once dismissed. `state` is account-security.js
 * accountState(); `hasContent` whether the household has anything yet.
 */
export function accountOffer({ state, supported, online, hasContent, now = Date.now(), sessionDismissed = false, dismissed = { passkey: false, backupCode: false } }) {
  if (!state?.account || !online || sessionDismissed) return null;
  if (supported && hasContent && !state.passkey && !state.passkeyNeedsSetup && !dismissed.passkey) return "account-passkey";
  if (!state.backupCode && Number.isFinite(state.memberSince) && now - state.memberSince >= BACKUP_CODE_OFFER_AFTER_MS && !dismissed.backupCode) return "backup-code";
  return null;
}

export const ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY = "kin.account-migrate-offer-dismissed";
/** "Not now" on the move to an account (#575) holds for a week. */
export const MIGRATE_OFFER_AGAIN_AFTER_MS = 7 * 24 * 60 * 60_000;

/** When an offer was last dismissed on this device (milliseconds), or null. */
export function offerDismissedAt(key, storage = defaultStorage()) {
  try {
    const value = Number(storage?.getItem(key));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function dismissOfferAt(key, now = Date.now(), storage = defaultStorage()) {
  try { storage?.setItem(key, String(now)); } catch { /* Shown again next time; harmless. */ }
}

/**
 * Today's invitation to move to an account (#575), if due: "account-migrate"
 * for a member set up the old way (`migration` "invite",
 * account-migration.js), "account-finish" for a device of a member who
 * moved elsewhere ("finish"). Calm and optional: never offline, gone for
 * this unlock after "Not now", and back no sooner than a week later.
 */
export function migrationOffer({ migration, online, sessionDismissed = false, dismissedAt = null, now = Date.now() }) {
  if (!["invite", "finish"].includes(migration) || !online || sessionDismissed) return null;
  if (Number.isFinite(dismissedAt) && now - dismissedAt < MIGRATE_OFFER_AGAIN_AFTER_MS) return null;
  return migration === "invite" ? "account-migrate" : "account-finish";
}

export function passkeySuggestionDismissed(storage = defaultStorage()) {
  try { return storage?.getItem(PASSKEY_SUGGESTION_DISMISSED_KEY) === "1"; } catch { return false; }
}

export function dismissPasskeySuggestion(storage = defaultStorage()) {
  try { storage?.setItem(PASSKEY_SUGGESTION_DISMISSED_KEY, "1"); } catch { /* Shown again next time; harmless. */ }
}

/**
 * Which passkey prompt the unlocked shell shows, if any:
 * - "setup": right after this device's backup key was saved (#577);
 * - "suggestion": after a backup-key unlock, until dismissed on this device (#579);
 * - null: passkeys already unlock Kin, the browser can't use them, the device
 *   is offline or not signed in to a household (enrolment needs the identity
 *   service), or the person said Not now.
 */
export function passkeyOffer({ identity, passkeys, supported, online, justSetUp, sessionDismissed, suggestionDismissed }) {
  if (!identity || passkeys > 0 || !supported || !online || sessionDismissed) return null;
  if (justSetUp) return "setup";
  return suggestionDismissed ? null : "suggestion";
}
