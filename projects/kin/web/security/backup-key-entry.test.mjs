import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_KEY_ENTRY_KEY, backupKeyEntryName, dismissPasskeySuggestion, entryDeviceName, entryHint,
  legacyEntryName, passkeyOffer, passkeySuggestionDismissed, rememberedEntries, rememberEntry, unlockEntryName,
} from "./backup-key-entry.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
}

const brokenStorage = {
  getItem() { throw new DOMException("blocked", "SecurityError"); },
  setItem() { throw new DOMException("blocked", "SecurityError"); },
};

test("entry names carry the device and the key label", () => {
  assert.equal(backupKeyEntryName("K-7F3A", "Mikey's phone"), "Kin backup key — Mikey's phone (K-7F3A)");
  assert.equal(backupKeyEntryName("K-7F3A", "Chrome on Android"), "Kin backup key — Chrome on Android (K-7F3A)");
});

test("an unknown or anonymous device falls back to the label alone", () => {
  for (const name of [null, undefined, "", "   ", "This device", "Device"])
    assert.equal(backupKeyEntryName("K-7F3A", name), "Kin backup key (K-7F3A)");
  assert.equal(backupKeyEntryName(null, "Chrome on Android"), "Kin backup key — Chrome on Android");
  assert.equal(backupKeyEntryName(null, null), "Kin backup key");
});

test("device names are tidied and bounded", () => {
  assert.equal(entryDeviceName("  Mikey's\n\tphone  "), "Mikey's phone");
  const long = entryDeviceName("😀".repeat(80));
  assert.equal([...long].length, 48);
  assert.ok(long.endsWith("…"));
});

test("unlock asks for the remembered entry for the current label, else the older name", () => {
  const remembered = [{ label: "K-7F3A", name: "Kin backup key — Chrome on Android (K-7F3A)" }];
  assert.equal(unlockEntryName("K-7F3A", remembered), remembered[0].name);
  // A key saved before #579, or with storage cleared: the older entry name.
  assert.equal(unlockEntryName("K-11B0", remembered), "Kin recovery key K-11B0");
  assert.equal(unlockEntryName("K-7F3A", []), "Kin recovery key K-7F3A");
  assert.equal(unlockEntryName("K-7F3A"), "Kin recovery key K-7F3A");
  assert.equal(unlockEntryName(null, remembered), "Kin recovery key");
  assert.equal(legacyEntryName("K-7F3A"), "Kin recovery key K-7F3A");
});

test("an unfinished replacement doesn't lose the current key's entry", () => {
  const storage = memoryStorage();
  rememberEntry("K-7F3A", "Kin backup key — Chrome on Android (K-7F3A)", storage);
  // Replacement remembers its new entry when submitted, before it finishes.
  rememberEntry("K-11B0", "Kin backup key — Chrome on Android (K-11B0)", storage);
  const entries = rememberedEntries(storage);
  assert.equal(unlockEntryName("K-7F3A", entries), "Kin backup key — Chrome on Android (K-7F3A)");
  assert.equal(unlockEntryName("K-11B0", entries), "Kin backup key — Chrome on Android (K-11B0)");
  for (const label of ["K-0001", "K-0002", "K-0003"]) rememberEntry(label, `Kin backup key (${label})`, storage);
  assert.deepEqual(rememberedEntries(storage).map((entry) => entry.label), ["K-0003", "K-0002", "K-0001"], "only a few, newest first");
  rememberEntry("K-0001", "Kin backup key — Edge on Windows (K-0001)", storage);
  assert.deepEqual(rememberedEntries(storage).map((entry) => entry.label), ["K-0001", "K-0003", "K-0002"], "one entry per label");
});

test("the hint names the label both entry formats end with", () => {
  assert.equal(entryHint("K-7F3A"), "Use the saved entry ending K-7F3A.");
  assert.ok(backupKeyEntryName("K-7F3A", "Mikey's phone").endsWith("K-7F3A)"));
  assert.ok(legacyEntryName("K-7F3A").endsWith("K-7F3A"));
  assert.equal(entryHint(null), "");
});

test("the remembered entry round-trips and tolerates missing or broken storage", () => {
  const storage = memoryStorage();
  assert.deepEqual(rememberedEntries(storage), []);
  rememberEntry("K-7F3A", "Kin backup key — Chrome on Android (K-7F3A)", storage);
  assert.deepEqual(rememberedEntries(storage), [{ label: "K-7F3A", name: "Kin backup key — Chrome on Android (K-7F3A)" }]);
  assert.ok(!storage.values.get(BACKUP_KEY_ENTRY_KEY).match(/[a-f0-9]{64}/), "only a name is stored");
  rememberEntry(null, "x", storage);
  assert.equal(rememberedEntries(storage).length, 1, "no label, nothing remembered");
  storage.setItem(BACKUP_KEY_ENTRY_KEY, "{not json");
  assert.deepEqual(rememberedEntries(storage), []);
  storage.setItem(BACKUP_KEY_ENTRY_KEY, JSON.stringify([{ label: "K-7F3A", name: 5 }, { label: "K-11B0", name: "ok" }, "junk"]));
  assert.deepEqual(rememberedEntries(storage), [{ label: "K-11B0", name: "ok" }]);
  storage.setItem(BACKUP_KEY_ENTRY_KEY, JSON.stringify({ label: "K-7F3A", name: "not a list" }));
  assert.deepEqual(rememberedEntries(storage), []);
  assert.deepEqual(rememberedEntries(brokenStorage), []);
  assert.deepEqual(rememberedEntries(null), []);
  assert.doesNotThrow(() => rememberEntry("K-7F3A", "name", brokenStorage));
});

test("the passkey suggestion dismissal is remembered per device", () => {
  const storage = memoryStorage();
  assert.equal(passkeySuggestionDismissed(storage), false);
  dismissPasskeySuggestion(storage);
  assert.equal(passkeySuggestionDismissed(storage), true);
  assert.equal(passkeySuggestionDismissed(brokenStorage), false);
  assert.doesNotThrow(() => dismissPasskeySuggestion(brokenStorage));
});

test("passkey offers: after setup, after a backup-key unlock, and never where they can't work", () => {
  const base = { identity: true, passkeys: 0, supported: true, online: true, justSetUp: false, sessionDismissed: false, suggestionDismissed: false };
  assert.equal(passkeyOffer({ ...base, justSetUp: true }), "setup");
  assert.equal(passkeyOffer({ ...base, justSetUp: true, suggestionDismissed: true }), "setup", "the setup step is its own question");
  assert.equal(passkeyOffer(base), "suggestion");
  assert.equal(passkeyOffer({ ...base, suggestionDismissed: true }), null, "a dismissed suggestion stays dismissed");
  assert.equal(passkeyOffer({ ...base, sessionDismissed: true, justSetUp: true }), null, "Not now goes on");
  assert.equal(passkeyOffer({ ...base, passkeys: 1, justSetUp: true }), null, "already on");
  assert.equal(passkeyOffer({ ...base, supported: false, justSetUp: true }), null, "unsupported");
  assert.equal(passkeyOffer({ ...base, online: false, justSetUp: true }), null, "offline");
  assert.equal(passkeyOffer({ ...base, identity: false, justSetUp: true }), null, "no household identity to enrol against");
});

test("a password account's calm offers (#562/#573): a passkey after the first useful thing, a backup code after a week, each dismissible", async () => {
  const { accountOffer, BACKUP_CODE_OFFER_AFTER_MS, dismissOffer, offerDismissed, ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY } = await import("./backup-key-entry.js");
  const now = 10 * BACKUP_CODE_OFFER_AFTER_MS;
  const fresh = { account: true, passkey: false, passkeyNeedsSetup: false, backupCode: false, memberSince: now - 1000 };
  const base = { state: fresh, supported: true, online: true, hasContent: true, now };
  assert.equal(accountOffer({ ...base, hasContent: false }), null, "never before the first useful thing, so never at sign-up");
  assert.equal(accountOffer(base), "account-passkey");
  assert.equal(accountOffer({ ...base, supported: false }), null, "no passkey offer where passkeys can't work; no code yet either");
  assert.equal(accountOffer({ ...base, online: false }), null, "offline");
  assert.equal(accountOffer({ ...base, sessionDismissed: true }), null);
  assert.equal(accountOffer({ ...base, dismissed: { passkey: true, backupCode: false } }), null, "dismissed, and the code isn't due yet");
  const weekOld = { ...fresh, memberSince: now - BACKUP_CODE_OFFER_AFTER_MS };
  assert.equal(accountOffer({ ...base, state: weekOld, dismissed: { passkey: true, backupCode: false } }), "backup-code", "after the first week");
  assert.equal(accountOffer({ ...base, state: { ...weekOld, passkey: true } }), "backup-code", "one card at a time: the passkey is done");
  assert.equal(accountOffer({ ...base, state: { ...weekOld, passkey: true, backupCode: true } }), null);
  assert.equal(accountOffer({ ...base, state: { ...weekOld, passkey: true }, dismissed: { passkey: false, backupCode: true } }), null);
  assert.equal(accountOffer({ ...base, state: { ...fresh, account: false } }), null, "members without an account keep the older passkey prompt");
  const storage = memoryStorage();
  assert.equal(offerDismissed(ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY, storage), false);
  dismissOffer(ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY, storage);
  assert.equal(offerDismissed(ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY, storage), true);
  assert.equal(offerDismissed(ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY, brokenStorage), false, "blocked storage is tolerated");
  dismissOffer(ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY, brokenStorage);
});

test("the move to an account (#575): a calm invitation, never offline, Not now for a week", async () => {
  const { migrationOffer, MIGRATE_OFFER_AGAIN_AFTER_MS, dismissOfferAt, offerDismissedAt, ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY } = await import("./backup-key-entry.js");
  const now = 100 * MIGRATE_OFFER_AGAIN_AFTER_MS;
  assert.equal(migrationOffer({ migration: "invite", online: true, now }), "account-migrate");
  assert.equal(migrationOffer({ migration: "finish", online: true, now }), "account-finish");
  assert.equal(migrationOffer({ migration: "done", online: true, now }), null);
  assert.equal(migrationOffer({ migration: null, online: true, now }), null, "guests and households without a summary");
  assert.equal(migrationOffer({ migration: "invite", online: false, now }), null, "never offline");
  assert.equal(migrationOffer({ migration: "invite", online: true, sessionDismissed: true, now }), null, "Not now holds for this unlock");
  assert.equal(migrationOffer({ migration: "invite", online: true, dismissedAt: now - 1000, now }), null, "and for a week");
  assert.equal(migrationOffer({ migration: "invite", online: true, dismissedAt: now - MIGRATE_OFFER_AGAIN_AFTER_MS, now }), "account-migrate", "then it comes back, once");
  const storage = memoryStorage();
  assert.equal(offerDismissedAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY, storage), null);
  dismissOfferAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY, 1234, storage);
  assert.equal(offerDismissedAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY, storage), 1234);
  assert.equal(offerDismissedAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY, brokenStorage), null);
  dismissOfferAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY, 1, brokenStorage);
});
