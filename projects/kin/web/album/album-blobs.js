// The family album's images (#673, ADR 0022 §5): adding a photo, opening
// one, and keeping this device and the service in step.
//
// A photo is a household attachment blob: the image (made screen-sized,
// album-image.js) is encrypted under the current household key exactly as an
// item's photo is (attachments/attachment-crypto.js, parent kind "album",
// parent ID the attachment's own ID), kept in this device's album store
// (album-store.js) and uploaded to the same encrypted attachment store.
// Album attachment IDs start with "a1b0", so the service keeps them within
// the album's own quota and lists them only to devices that ask (?album=1).
//
// Removing a photo (kind 76) doesn't delete its blob at once: for
// ALBUM_UNDO_GRACE_MS after the removal, every device keeps it, so Undo can
// put the same image back under a new photo ID. After that, the next sync
// pass on any device deletes it here and on the service.
import { decryptAttachment, encryptAttachment } from "../attachments/attachment-crypto.js";
import { currentEpoch, sha256 } from "../attachments/attachment-lifecycle.js";
import { isAlbumAttachmentId, newAlbumAttachmentId } from "../wasm/kin-album.js";
import { prepareAlbumImage } from "./album-image.js";

/** How long a removed photo's blob is kept for Undo. */
export const ALBUM_UNDO_GRACE_MS = 60 * 60_000;
const MAX_CIPHERTEXT = 4 * 1024 * 1024 + 4096;
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The album attachments every device keeps now: the live photos' and the
 * recently removed ones' still within the Undo grace. */
export function albumKeep(album, now = Date.now()) {
  const keep = new Set((album?.photos ?? []).map((photo) => photo.attachmentId));
  for (const removed of album?.removed ?? []) if (now - removed.removedAt < ALBUM_UNDO_GRACE_MS) keep.add(removed.attachmentId);
  return keep;
}

/** Whether Undo can still bring back a photo removed at `removedAt`. */
export function withinUndoGrace(album, attachmentId, now = Date.now()) {
  return albumKeep(album, now).has(attachmentId);
}

const fail = (message, stage) => Object.assign(new Error(message), { userMessage: message, stage });

/**
 * Adds `file` to the album: makes it screen-sized, protects it, keeps it on
 * this device, then appends kind 75. Resolves `{ photoId, attachmentId }`.
 * Failures carry `userMessage`; a failure after the image was kept but
 * before the event committed leaves a "local" row the next sync pass clears.
 */
export async function captureAlbumPhoto({ file, caption = "", identity, store, keyStore, albumStore, append, prepare = prepareAlbumImage }) {
  if (!albumStore || !store) throw fail("Unlock Kin before adding a photo.", "storage");
  const image = await prepare(file);
  const attachmentId = newAlbumAttachmentId();
  const photoId = randomId();
  try {
    if (!identity) throw new Error("no household identity");
    const { keyEpoch, householdKey } = await currentEpoch(identity, keyStore, store);
    const encrypted = await encryptAttachment(image, { householdId: identity.householdId, attachmentId, keyEpoch, householdKey, parentKind: "album", parentId: attachmentId });
    await albumStore.put({ attachmentId, ciphertext: encrypted.ciphertext, keyEpoch, digest: encrypted.digest, state: "local" });
  } catch (error) {
    if (error?.userMessage && error.stage === "storage") throw error;
    // No household key yet: sealed under this device's vault until one
    // arrives (reconcileAlbum re-encrypts it then).
    const bytes = new Uint8Array(await image.arrayBuffer());
    try {
      const sealed = await store.sealAttachmentData(attachmentId, { bytes, name: image.name.slice(0, 240), type: image.type, parentKind: "album", parentId: attachmentId });
      await albumStore.put({ attachmentId, sealed, state: "local" });
    } catch {
      throw fail("Kin couldn't save this photo on this device. Check free storage space and try again.", "storage");
    } finally { bytes.fill(0); }
  }
  await append({ type: "add-album-photo", photoId, attachmentId, caption });
  await albumStore.setState(attachmentId, "queued").catch(() => {});
  return { photoId, attachmentId };
}

/**
 * The image of `photo` as `{ blob, name, type }`: from this device, or
 * downloaded once (and kept) when another device added it. Throws an Error
 * with `userMessage` when it can't be shown.
 */
export async function openAlbumPhoto({ photo, identity, store, keyStore, albumStore, fetchImpl = (...args) => fetch(...args), signal }) {
  const attachmentId = photo?.attachmentId;
  if (!isAlbumAttachmentId(attachmentId) || !albumStore) throw fail("This photo isn't available.");
  let row = await albumStore.get(attachmentId);
  if (row?.sealed && !row.ciphertext) {
    const saved = await store.openAttachmentData(attachmentId, row.sealed);
    try {
      if (saved.parentKind !== "album" || saved.parentId !== attachmentId) throw fail("This photo isn't available.");
      return { blob: new Blob([saved.bytes], { type: saved.type }), name: saved.name, type: saved.type };
    } finally { saved.bytes?.fill?.(0); }
  }
  if (!row) {
    row = await downloadAlbumPhoto(attachmentId, { fetchImpl, signal });
    await albumStore.put({ ...row, state: "synced" }).catch(() => {});
  }
  if (!identity || !keyStore) throw fail("This photo isn't available on this device yet.");
  const epoch = await keyStore.getEpoch(identity.householdId, row.keyEpoch);
  if (!epoch) throw fail("This photo isn't available on this device yet.");
  let opened;
  try {
    opened = await decryptAttachment(row.ciphertext, { householdId: identity.householdId, attachmentId, keyEpoch: row.keyEpoch, householdKey: epoch.householdKey, digest: row.digest });
  } catch {
    throw fail("This photo couldn't be opened.");
  }
  if (opened.parentKind !== "album" || opened.parentId !== attachmentId) throw fail("This photo couldn't be opened.");
  return { blob: opened.blob, name: opened.name, type: opened.type };
}

async function downloadAlbumPhoto(attachmentId, { fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(`/api/sync/attachments/${attachmentId}`, { credentials: "same-origin", signal, headers: { Accept: "application/octet-stream" } });
  } catch {
    throw fail("This photo will show once this device is online.");
  }
  if (!response.ok) throw fail(response.status === 404 ? "This photo is no longer available." : "This photo couldn't be downloaded. Kin will try again.");
  const keyEpoch = Number(response.headers.get("X-Attachment-Key-Epoch"));
  const digest = response.headers.get("X-Attachment-SHA256");
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 1 || !/^[a-f0-9]{64}$/.test(digest ?? "") || ciphertext.length < 29 || ciphertext.length > MAX_CIPHERTEXT || await sha256(ciphertext) !== digest)
    throw fail("This photo couldn't be downloaded. Kin will try again.");
  return { attachmentId, ciphertext, keyEpoch, digest };
}

/**
 * One sync pass for the album (sync-coordinator.js, after the household's
 * events and attachments): uploads this device's queued photos, re-encrypts
 * photos kept before a household key arrived, and deletes blobs no live
 * photo needs any more (after the Undo grace), here and on the service.
 * Blobs that look unneeded are deleted only when a second pass still finds
 * them so (`suspected`): a photo being added right now, or one another
 * device has just uploaded, is never taken for an orphan.
 */
export async function reconcileAlbum({ album, identity, store, keyStore, albumStore, suspected = new Set(), signal, now = Date.now(), fetchImpl = (...args) => fetch(...args) }) {
  if (!album || !albumStore) return { available: false };
  const keep = albumKeep(album, now);
  const live = new Set(album.photos.map((photo) => photo.attachmentId));
  const request = async (path, options = {}) => {
    const response = await fetchImpl(path, { ...options, credentials: "same-origin", signal });
    if (!response.ok) throw new Error("album-request-failed");
    return response;
  };
  let remote = null;
  try {
    const listed = await (await request("/api/sync/attachments?album=1", { headers: { Accept: "application/json" } })).json();
    if (Array.isArray(listed?.attachments)) remote = new Map(listed.attachments.filter((row) => isAlbumAttachmentId(row?.attachmentId)).map((row) => [row.attachmentId, row]));
  } catch { /* Offline: this device's own rows are still tidied. */ }

  // True on the second pass in a row that finds `key` unneeded.
  const unneeded = (key, attachmentId) => {
    if (keep.has(attachmentId)) { suspected.delete(key); return false; }
    if (!suspected.has(key)) { suspected.add(key); return false; }
    suspected.delete(key);
    return true;
  };
  const local = await albumStore.inventory();
  for (const row of local) if (unneeded(`local:${row.attachmentId}`, row.attachmentId)) await albumStore.delete(row.attachmentId);
  for (const attachmentId of remote?.keys() ?? []) {
    if (!unneeded(`remote:${attachmentId}`, attachmentId)) continue;
    // Only whoever uploaded it or an Adult may delete it; anyone else's
    // refusal is fine, an Adult's device will.
    await request(`/api/sync/attachments/${attachmentId}`, { method: "DELETE" }).catch(() => {});
  }

  // A live photo's row is uploaded unless it already is; one still marked
  // "local" is live, so its event committed and it may go too.
  for (const { attachmentId, state, sealed } of local) {
    if (!live.has(attachmentId) || state === "synced") continue;
    let row = await albumStore.get(attachmentId);
    if (!row) continue;
    if (sealed) {
      try {
        const saved = await store.openAttachmentData(attachmentId, row.sealed);
        const { keyEpoch, householdKey } = await currentEpoch(identity, keyStore, store);
        const file = new File([saved.bytes], saved.name, { type: saved.type });
        saved.bytes.fill(0);
        const encrypted = await encryptAttachment(file, { householdId: identity.householdId, attachmentId, keyEpoch, householdKey, parentKind: "album", parentId: attachmentId });
        await albumStore.put({ attachmentId, ciphertext: encrypted.ciphertext, keyEpoch, digest: encrypted.digest, state: "queued" });
        row = await albumStore.get(attachmentId);
      } catch { continue; /* Kept sealed until a household key is here. */ }
    }
    if (!remote || !row?.ciphertext) continue;
    const there = remote.get(attachmentId);
    if (there) {
      await albumStore.setState(attachmentId, there.digest === row.digest && there.keyEpoch === row.keyEpoch ? "synced" : "failed");
      continue;
    }
    if (await sha256(row.ciphertext) !== row.digest) { await albumStore.setState(attachmentId, "failed"); continue; }
    try {
      await request(`/api/sync/attachments/${attachmentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Attachment-Key-Epoch": String(row.keyEpoch), "X-Attachment-SHA256": row.digest },
        body: row.ciphertext,
      });
      await albumStore.setState(attachmentId, "synced");
    } catch {
      // Left queued: the next pass tries again.
    }
  }
  return { available: Boolean(remote) };
}
