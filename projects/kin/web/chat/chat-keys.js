// The household's dedicated chat key (#123).
//
// Chat travels in the same signed envelopes as household sync, under the
// household key. Inside each envelope the event itself (whose per-message
// content keys let a device open the text and attachments) is sealed again
// under a chat key that only devices of members the admin's policy lets read
// are given. Changing a class to "No access" rotates that key, so its devices
// can't open anything sent afterwards. They keep what they already decrypted,
// the same honest limit as revoking a device. The envelope's outer fields
// (who sent it, when, how large) stay visible to anyone holding the household
// key; it is the message content that the chat key keeps from them.
//
// Sealed plaintext: "KCK1" | key epoch (u32 BE) | nonce (12) | AES-GCM
// ciphertext, bound to the household, the event ID and the epoch. Events
// from before a household had a chat key start with the engine's own "KINE"
// header instead and are read as they are.
//
// Keys travel as the household-key transfers do (web/sync/crypto.js: ECDH to
// the device, signed by the sender), labelled with the family "chat:<id>" in
// place of the household ID, so a chat key can't be passed off as a household
// key or the reverse. They are stored sealed in the device key store under
// that family, so root rotation keeps them. An Adult's device creates a new
// key when the service says the current one must change and wraps it for
// each device allowed to read; a device that holds a key shares it with a
// device that should have it and doesn't. The service only keeps the
// wrapped copies.
import {
  importDevicePublicKeys,
  provisionSealedEpochKey,
  unwrapEpochKey,
  wrapEpochKey,
} from "../sync/crypto.js";

const MAGIC = [0x4b, 0x43, 0x4b, 0x31];
const HEADER_BYTES = 4 + 4 + 12;
const GRANT_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();

export const chatKeyFamily = (householdId) => `chat:${householdId}`;

export class ChatKeyError extends Error {
  constructor(message, code = "chat_key_missing") {
    super(message);
    this.name = "ChatKeyError";
    this.code = code;
  }
}

/** The relay sequence a pull cursor (8 bytes, big-endian, base64url) names. */
export function cursorSequence(cursor) {
  const text = String(cursor).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(text.padEnd(Math.ceil(text.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
  return bytes.length === 8 ? Number(new DataView(bytes.buffer).getBigUint64(0)) : 0;
}

const randomIdHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const isSealed = (bytes) => bytes.length >= HEADER_BYTES && MAGIC.every((value, index) => bytes[index] === value);
const aadFor = (householdId, eventId, keyEpoch) => encoder.encode(`kin.chat.content.v1|${householdId}|${eventId}|${keyEpoch}`);

export class ChatKeys {
  constructor({ identity, keyStore, request, locks = globalThis.navigator?.locks, now = () => Date.now() }) {
    this.identity = identity;
    this.keyStore = keyStore;
    this.request = request;
    this.locks = locks;
    this.now = now;
    this.family = chatKeyFamily(identity.householdId);
    /** The service's chat key epoch at the last check; 0 means no chat key. */
    this.epoch = 0;
    /** The service wants the key replaced before anything more is sent. */
    this.pending = false;
    /** The relay position from which events must be sealed (0: none yet), and
     * the epochs no device that may read still holds. */
    this.since = 0;
    this.lost = new Set();
    this.keys = new Map();
    this.fetched = 0;
  }

  close() { this.keys.clear(); }

  /** The epoch this device seals new events under: the service's, or the
   * newest it holds when it hasn't asked yet (an offline first message). */
  async sendingEpoch() {
    if (this.epoch > 0) return this.epoch;
    const held = await this.keyStore.listEpochs(this.family);
    return held.length ? Math.max(...held.map((entry) => entry.keyEpoch)) : 0;
  }

  async key(keyEpoch) {
    if (this.keys.has(keyEpoch)) return this.keys.get(keyEpoch);
    const record = await this.keyStore.getEpoch(this.family, keyEpoch);
    if (!record) throw new ChatKeyError(`This device doesn't have chat key ${keyEpoch} yet; chat is paused until a trusted device shares it.`);
    this.keys.set(keyEpoch, record.householdKey);
    return record.householdKey;
  }

  /** Seals an encoded event for the chat key. Returns it unchanged while the
   * household has no chat key. */
  async seal(plaintext, eventId) {
    const keyEpoch = await this.sendingEpoch();
    if (keyEpoch === 0) return { bytes: plaintext, keyEpoch: 0 };
    const key = await this.key(keyEpoch);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aadFor(this.identity.householdId, eventId, keyEpoch), tagLength: 128 }, key, plaintext));
    const bytes = new Uint8Array(HEADER_BYTES + ciphertext.length);
    bytes.set(MAGIC, 0);
    new DataView(bytes.buffer).setUint32(4, keyEpoch);
    bytes.set(nonce, 8);
    bytes.set(ciphertext, HEADER_BYTES);
    return { bytes, keyEpoch };
  }

  /** The encoded event inside decrypted envelope bytes, and the chat key
   * epoch it was sealed under (0 for an event from before the chat key).
   * `sequence` is the event's relay position when it is being checked as it
   * arrives: from the position the first chat key began, an event must be
   * sealed, or anyone holding only the household key could have written (and
   * could read) it. The input is wiped when a new array is returned. */
  async open(bytes, eventId, { sequence = null } = {}) {
    if (!isSealed(bytes)) {
      if (sequence !== null && this.since > 0 && sequence >= this.since)
        throw new ChatKeyError("A chat message wasn't sealed under the chat key.", "chat_event_refused");
      return { plaintext: bytes, keyEpoch: 0 };
    }
    const keyEpoch = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
    if (keyEpoch < 1) throw new ChatKeyError("A chat message names an invalid chat key.", "chat_event_refused");
    // A key epoch the household hasn't reached is wrong, or newer than this
    // device's last look (the next pass tells which); one no device that may
    // read still holds can never be opened.
    if (sequence !== null && this.epoch > 0 && keyEpoch > this.epoch)
      throw new ChatKeyError("A chat message names a chat key that doesn't exist yet.", "chat_key_future");
    if (this.lost.has(keyEpoch) && !this.keys.has(keyEpoch) && !(await this.keyStore.getEpoch(this.family, keyEpoch)))
      throw new ChatKeyError("A chat message was sealed under a chat key no device has any more.", "chat_key_lost");
    const key = await this.key(keyEpoch);
    let plaintext;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(8, 20), additionalData: aadFor(this.identity.householdId, eventId, keyEpoch), tagLength: 128 },
        key, bytes.subarray(HEADER_BYTES)));
    } catch {
      throw new ChatKeyError("A chat message could not be opened with its chat key.", "chat_event_refused");
    }
    bytes.fill(0);
    return { plaintext, keyEpoch };
  }

  /**
   * Keeps this device's chat keys current after each household pass: fetches
   * the keys addressed to it, and, when the service asks, replaces the key
   * (an Adult's device) or shares it with a device that should have it.
   */
  async sync({ status, devices, deviceKeys }) {
    const summary = status.chat?.key ?? { epoch: 0, pending: false, action: null, held: 0 };
    this.epoch = summary.epoch;
    this.pending = summary.pending === true;
    this.since = Number.isSafeInteger(summary.since) ? summary.since : 0;
    this.lost = new Set(Array.isArray(summary.lost) ? summary.lost : []);
    if (!deviceKeys?.keys || (summary.epoch === 0 && !summary.action)) return;
    const behind = summary.epoch > 0 &&
      ((summary.held ?? 0) > this.fetched || !(await this.keyStore.getEpoch(this.family, summary.epoch)));
    if (!behind && !summary.action) return;
    const act = async () => {
      let data = await this.request("/api/chat/keys");
      await this.receive(data.packages, devices, deviceKeys);
      if (data.plan?.action === "rotate") {
        await this.rotate(data, devices, deviceKeys);
        data = await this.request("/api/chat/keys");
        await this.receive(data.packages, devices, deviceKeys);
      } else if (data.plan?.action === "grant") await this.grant(data, devices, deviceKeys);
      this.epoch = data.epoch;
      this.pending = data.pending === true && data.plan?.action !== "rotate";
    };
    try {
      if (typeof this.locks?.request === "function")
        await this.locks.request(`kin-chat-keys:${this.identity.householdId}`, { ifAvailable: true }, (lock) => lock ? act() : undefined);
      else await act();
    } catch (error) {
      // Another device got there first; the next pass looks again.
      if (error?.code !== "chat_keys_stale") throw error;
    }
  }

  /** Stores the packages this device doesn't have yet, after checking each
   * names this device and was signed by the trusted device it names. */
  async receive(packages, devices, deviceKeys) {
    const held = new Set((await this.keyStore.listEpochs(this.family)).map((entry) => entry.keyEpoch));
    for (const row of packages ?? []) {
      const keyPackage = row?.package;
      if (!Number.isSafeInteger(row?.keyEpoch) || held.has(row.keyEpoch)) continue;
      if (keyPackage?.keyEpoch !== row.keyEpoch || keyPackage?.householdId !== this.family ||
          keyPackage?.senderDeviceId !== row.senderDeviceId || keyPackage?.recipientDeviceId !== this.identity.deviceId) continue;
      const sender = devices.find((device) => device.deviceId === row.senderDeviceId);
      if (!sender?.publicKeys) continue;
      let received, broken = false;
      try {
        for (const entry of [...(sender.verifiedKeyHistory ?? [{ publicKeys: sender.publicKeys }])].reverse()) {
          const signer = await importDevicePublicKeys(entry.publicKeys);
          try {
            received = await unwrapEpochKey({
              package: keyPackage, deviceKeys: deviceKeys.keys, householdId: this.family, deviceId: this.identity.deviceId,
              deviceFingerprint: deviceKeys.fingerprint, senderSigningKey: signer.signing,
              // The service only stores packages it accepted; an old one is still good.
              allowExpiredCommittedRotation: true,
            });
            break;
          } catch (error) { if (error.code !== "provisioning_signature_invalid") throw error; }
        }
        broken = !received;
      } catch (error) {
        // A package this device can't open (made for an older key of this
        // device, or damaged): leave it, carry on with the others.
        if (!String(error?.code ?? "").startsWith("provisioning_")) throw error;
        broken = true;
      }
      if (broken) {
        // Dropped, so a device that holds the key shares it again.
        try { await this.request("/api/chat/keys/reject", { method: "POST", body: JSON.stringify({ keyEpoch: row.keyEpoch }) }); } catch { /* the next pass tries again */ }
        continue;
      }
      await this.keyStore.saveEpoch({ householdId: this.family, keyEpoch: row.keyEpoch, ...received });
      held.add(row.keyEpoch);
    }
    this.fetched = held.size;
  }

  /** Makes a new chat key and wraps it for every device that may read. */
  async rotate(data, devices, deviceKeys) {
    const keyEpoch = data.epoch + 1;
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const packages = [];
      for (const recipient of data.plan.recipients) {
        const device = devices.find((entry) => entry.deviceId === recipient.deviceId);
        if (!device?.publicKeys || device.fingerprint !== recipient.fingerprint || device.revokedAt)
          throw new ChatKeyError("A trusted device isn't ready to receive the chat key yet.", "chat_keys_waiting");
        packages.push({
          deviceId: device.deviceId, keyEpoch,
          package: await wrapEpochKey({
            rawKey, householdId: this.family, senderDeviceId: this.identity.deviceId, recipientDeviceId: device.deviceId,
            recipientPublicKeys: device.publicKeys, recipientFingerprint: device.fingerprint, keyEpoch,
            grantId: randomIdHex(), expiresAt: this.now() + GRANT_TTL_MS, signingKey: deviceKeys.keys.signingPrivateKey,
          }),
        });
      }
      await this.request("/api/chat/keys", { method: "POST", body: JSON.stringify({ expectedEpoch: data.epoch, epoch: keyEpoch, packages }) });
    } finally {
      rawKey.fill(0);
    }
  }

  /** Shares the keys this device holds with devices that should have them. */
  async grant(data, devices, deviceKeys) {
    const packages = [];
    for (const recipient of data.plan.recipients) {
      const device = devices.find((entry) => entry.deviceId === recipient.deviceId);
      if (!device?.publicKeys || device.fingerprint !== recipient.fingerprint || device.revokedAt) continue;
      for (const keyEpoch of recipient.keyEpochs) {
        const record = await this.keyStore.getEpoch(this.family, keyEpoch);
        if (!record) continue;
        packages.push({
          deviceId: device.deviceId, keyEpoch,
          package: await provisionSealedEpochKey({
            sealed: record.sealed, deviceKeys: deviceKeys.keys,
            grant: {
              householdId: this.family, senderDeviceId: this.identity.deviceId, recipientDeviceId: device.deviceId,
              recipientPublicKeys: device.publicKeys, recipientFingerprint: device.fingerprint, keyEpoch,
              grantId: randomIdHex(), expiresAt: this.now() + GRANT_TTL_MS, signingKey: deviceKeys.keys.signingPrivateKey,
            },
          }),
        });
      }
    }
    if (!packages.length) return;
    await this.request("/api/chat/keys", { method: "POST", body: JSON.stringify({ expectedEpoch: data.epoch, epoch: data.epoch, packages: packages.slice(0, 128) }) });
  }
}
