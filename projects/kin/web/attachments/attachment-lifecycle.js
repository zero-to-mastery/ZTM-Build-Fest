import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_PLAINTEXT_BYTES, decryptAttachment, encryptAttachment, validateAttachmentFile } from "./attachment-crypto.js";
import { SyncKeyStore } from "../sync/key-store.js";

const MAX_CIPHERTEXT = 4 * 1024 * 1024 + 4096;

// Explains why a chosen file cannot be attached, or returns null when it can.
// The wording names the actual problem so a person can pick a different file.
export function attachmentFileProblem(file) {
  if (!(file instanceof Blob)) return "Choose a photo or PDF to attach.";
  return attachmentMetaProblem(file);
}

/** The same rules from a file's type and size alone (a chat attachment that
 * hasn't been opened yet, #132). */
export function attachmentMetaProblem(file) {
  if (file.size < 1) return "That file is empty. Choose a photo or PDF that has content.";
  if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
    const kind = typeof file.type === "string" && file.type ? ` (${file.type})` : "";
    return `Kin can't attach this kind of file${kind}. Choose a JPEG, PNG or WebP photo, or a PDF.`;
  }
  if (file.size > MAX_ATTACHMENT_PLAINTEXT_BYTES)
    return `This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Photos and PDFs must be 4 MB or smaller.`;
  return null;
}

// Capture failures are tagged with the step that failed ("validation",
// "storage" or "binding") so the UI can say what actually happened: protected
// bytes that never got a binding are cleaned up by a later reconciliation.
export async function captureAttachment({ file, parentKind, parentId, identity, store, keyStore, append }) {
  const problem = attachmentFileProblem(file);
  if (problem) throw stage(new Error(problem), "validation");
  validateAttachmentFile(file);
  if (!store) throw stage(new Error("Unlock Kin before attaching a file."), "storage");
  const attachmentId = randomId();
  let record;
  try {
    if (!identity) throw new Error("no household identity");
    const { keyEpoch, householdKey } = await currentEpoch(identity, keyStore, store);
    const encrypted = await encryptAttachment(file, { householdId: identity.householdId, attachmentId, keyEpoch, householdKey, parentKind, parentId });
    record = { attachment_id: attachmentId, ciphertext: encrypted.ciphertext, localSealed: null, keyEpoch, digest: encrypted.digest, state: "local" };
  } catch {
    // No provisioned household key yet (or no household at all): keep the file
    // sealed under this device's vault root. Reconciliation re-encrypts it with
    // the household key once one is available.
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const localSealed = await store.sealAttachmentData(attachmentId, { bytes, name: file.name.slice(0, 240), type: file.type, parentKind, parentId });
      record = { attachment_id: attachmentId, ciphertext: null, localSealed, keyEpoch: null, digest: null, state: "local" };
    } catch (error) { throw stage(error, "storage"); }
    finally { bytes.fill(0); }
  }
  try { await store.saveAttachment(record); } catch (error) { throw stage(error, "storage"); }
  try {
    await append({ type: "bind-attachment", id: attachmentId, parentKind, parentId });
    await store.updateAttachmentState(attachmentId, "queued");
  } catch (error) {
    // Ciphertext stays protected locally. A later reconciliation sees no canonical binding and removes it.
    throw stage(error, "binding");
  }
  return { attachmentId, name: file.name, size: file.size, type: file.type, state: "queued" };
}

function stage(error, value) {
  if (error && typeof error === "object" && !error.stage) error.stage = value;
  return error;
}

export async function removeAttachment({ attachmentId, append, store }) {
  await append({ type: "remove-attachment", id: attachmentId });
  // Canonical removal is committed first; ciphertext remains until sync confirms remote cleanup.
  await store.updateAttachmentState(attachmentId, "removed");
}

export async function reconcileAttachments({ identity, store, keyStore, state, signal, suspectedOrphans = null }) {
  const bindings = Array.isArray(state?.attachments) ? state.attachments : [];
  const localRows = await store.loadAttachments();
  const local = new Map(localRows.map((row) => [row.attachment_id, row]));
  let remote;
  try { remote = (await attachmentJson("/api/sync/attachments", { signal })).attachments; }
  catch { return { available: false, rows: await describeLocal(bindings, local, identity, keyStore, store) }; }
  if (!Array.isArray(remote) || remote.length > 64) return { available: false, rows: await describeLocal(bindings, local, identity, keyStore, store) };
  const remoteById = new Map(remote.filter(validRemoteRecord).map((row) => [row.attachmentId, row]));
  const bindingById = new Map(bindings.map((row) => [row.attachmentId, row]));

  // Local orphans can result from a crash between ciphertext persistence and
  // event commit. A capture in progress looks the same for a moment: its bytes
  // are saved before its binding event commits. When the caller tracks
  // suspects across passes, an unbound "local" row is deleted only if it is
  // still unbound on the next pass, so a sync tick cannot discard a photo that
  // is being attached right now.
  for (const row of localRows) {
    if (bindingById.has(row.attachment_id)) { suspectedOrphans?.delete(row.attachment_id); continue; }
    if (row.state === "local" && suspectedOrphans && !suspectedOrphans.has(row.attachment_id)) { suspectedOrphans.add(row.attachment_id); continue; }
    suspectedOrphans?.delete(row.attachment_id);
    await store.deleteAttachment(row.attachment_id);
  }

  for (const binding of bindings) {
    let localRow = local.get(binding.attachmentId);
    const remoteRow = remoteById.get(binding.attachmentId);
    if (binding.removed) {
      if (remoteRow) {
        try { await attachmentRequest(`/api/sync/attachments/${binding.attachmentId}`, { method: "DELETE", signal }); }
        catch { if (localRow) await store.updateAttachmentState(binding.attachmentId, "removed"); continue; }
      }
      if (localRow) await store.deleteAttachment(binding.attachmentId);
      continue;
    }
    if (!localRow && !remoteRow) continue;
    if (localRow && !localRow.ciphertext && localRow.localSealed && remoteRow) {
      const saved = await store.openAttachmentData(binding.attachmentId, localRow.localSealed).catch(() => null);
      if (!saved || saved.parentKind !== binding.parentKind || saved.parentId !== binding.parentId) { await store.updateAttachmentState(binding.attachmentId, "failed"); continue; }
      try {
        const downloaded = await downloadCiphertext(binding.attachmentId, remoteRow, signal);
        const epoch = await keyStore.getEpoch(identity.householdId, remoteRow.keyEpoch);
        if (!epoch) throw new Error("epoch-unavailable");
        const opened = await decryptAttachment(downloaded, { householdId: identity.householdId, attachmentId: binding.attachmentId, keyEpoch: remoteRow.keyEpoch, householdKey: epoch.householdKey, digest: remoteRow.digest });
        if (opened.parentKind !== binding.parentKind || opened.parentId !== binding.parentId) throw new Error("parent-mismatch");
        await store.saveAttachment({ attachment_id: binding.attachmentId, ciphertext: downloaded, localSealed: null, keyEpoch: remoteRow.keyEpoch, digest: remoteRow.digest, state: "synced" });
      } catch { await store.updateAttachmentState(binding.attachmentId, "failed"); }
      continue;
    }
    if (localRow && !localRow.ciphertext && localRow.localSealed && !remoteRow) {
      try {
        const saved = await store.openAttachmentData(binding.attachmentId, localRow.localSealed);
        if (saved.parentKind !== binding.parentKind || saved.parentId !== binding.parentId || !(saved.bytes instanceof Uint8Array)) throw new Error("parent-mismatch");
        const { keyEpoch, householdKey } = await currentEpoch(identity, keyStore, store);
        const file = new File([saved.bytes], saved.name, { type: saved.type });
        const encrypted = await encryptAttachment(file, { householdId: identity.householdId, attachmentId: binding.attachmentId, keyEpoch, householdKey, parentKind: binding.parentKind, parentId: binding.parentId });
        saved.bytes.fill(0);
        await store.saveAttachment({ attachment_id: binding.attachmentId, ciphertext: encrypted.ciphertext, localSealed: null, keyEpoch, digest: encrypted.digest, state: "queued" });
        localRow = (await store.loadAttachments()).find((row) => row.attachment_id === binding.attachmentId);
      } catch { /* Keep the locally sealed file queued until a provisioned key is available. */ }
      if (!localRow?.ciphertext) continue;
    }
    if (localRow) {
      const digest = await sha256(localRow.ciphertext);
      if (digest !== localRow.digest) { await store.updateAttachmentState(binding.attachmentId, "failed"); continue; }
      const epoch = await keyStore.getEpoch(identity.householdId, localRow.keyEpoch);
      if (!epoch) { await store.updateAttachmentState(binding.attachmentId, "failed"); continue; }
      const opened = await decryptAttachment(localRow.ciphertext, { householdId: identity.householdId, attachmentId: binding.attachmentId, keyEpoch: localRow.keyEpoch, householdKey: epoch.householdKey, digest: localRow.digest }).catch(() => null);
      if (!opened || opened.parentKind !== binding.parentKind || opened.parentId !== binding.parentId) { await store.updateAttachmentState(binding.attachmentId, "failed"); continue; }
      if (remoteRow && (remoteRow.digest !== localRow.digest || remoteRow.keyEpoch !== localRow.keyEpoch)) { await store.updateAttachmentState(binding.attachmentId, "failed"); continue; }
      if (!remoteRow) {
        await store.updateAttachmentState(binding.attachmentId, "uploading");
        try {
          await attachmentRequest(`/api/sync/attachments/${binding.attachmentId}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Attachment-Key-Epoch": String(localRow.keyEpoch), "X-Attachment-SHA256": localRow.digest }, body: localRow.ciphertext, signal });
          await store.updateAttachmentState(binding.attachmentId, "synced");
        } catch { await store.updateAttachmentState(binding.attachmentId, "failed"); }
      } else if (localRow.state !== "synced") await store.updateAttachmentState(binding.attachmentId, "synced");
      continue;
    }
    if (remoteRow) {
      try {
        const downloaded = await downloadCiphertext(binding.attachmentId, remoteRow, signal);
        const epoch = await keyStore.getEpoch(identity.householdId, remoteRow.keyEpoch);
        if (!epoch) throw new Error("epoch-unavailable");
        const opened = await decryptAttachment(downloaded, { householdId: identity.householdId, attachmentId: binding.attachmentId, keyEpoch: remoteRow.keyEpoch, householdKey: epoch.householdKey, digest: remoteRow.digest });
        if (opened.parentKind !== binding.parentKind || opened.parentId !== binding.parentId) throw new Error("parent-mismatch");
        await store.saveAttachment({ attachment_id: binding.attachmentId, ciphertext: downloaded, localSealed: null, keyEpoch: remoteRow.keyEpoch, digest: remoteRow.digest, state: "synced" });
      } catch { /* Keep metadata visible as download-needed; never expose unverified bytes. */ }
    }
  }

  // Remote objects without canonical bindings are opaque orphans and are removed only by this trusted client.
  for (const row of remoteById.values()) if (!bindingById.has(row.attachmentId)) await attachmentRequest(`/api/sync/attachments/${row.attachmentId}`, { method: "DELETE", signal }).catch(() => {});
  const refreshed = new Map((await store.loadAttachments()).map((row) => [row.attachment_id, row]));
  return { available: true, rows: await describeLocal(bindings, refreshed, identity, keyStore, store, remoteById) };
}

export async function openAttachment({ attachmentId, binding, identity, store, keyStore, signal }) {
  const row = (await store.loadAttachments()).find((item) => item.attachment_id === attachmentId);
  if (row?.localSealed && !row.ciphertext) {
    const saved = await store.openAttachmentData(attachmentId, row.localSealed);
    if (saved.parentKind !== binding.parentKind || saved.parentId !== binding.parentId) throw new Error("This attachment is unavailable.");
    const blob = new Blob([saved.bytes], { type: saved.type }); const result = { blob, name: saved.name, type: saved.type, size: saved.bytes.length }; saved.bytes.fill(0); return result;
  }
  if (!row) throw new Error("This attachment needs to sync before it can be opened.");
  if (!keyStore || !identity) throw new Error("This attachment is unavailable on this device.");
  const epoch = await keyStore.getEpoch(identity.householdId, row.keyEpoch);
  if (!epoch) throw new Error("This attachment is unavailable on this device.");
  const opened = await decryptAttachment(row.ciphertext, { householdId: identity.householdId, attachmentId, keyEpoch: row.keyEpoch, householdKey: epoch.householdKey, digest: row.digest });
  if (opened.parentKind !== binding.parentKind || opened.parentId !== binding.parentId) throw new Error("This attachment is unavailable.");
  return opened;
}

export async function loadLocalAttachmentRows({ store, state }) {
  const syncState = await store.getSyncState();
  const identity = syncState ? { householdId: syncState.householdId, memberId: syncState.memberId, deviceId: syncState.deviceId } : null;
  let keyStore = null;
  try { if (identity) keyStore = await SyncKeyStore.open({ vault: store.vault }); } catch { /* Root-sealed local files remain available without sync setup. */ }
  try { return await describeLocal(state?.attachments ?? [], new Map((await store.loadAttachments()).map((row) => [row.attachment_id, row])), identity, keyStore, store); }
  finally { keyStore?.close(); }
}

async function describeLocal(bindings, local, identity, keyStore, store, remote = new Map()) {
  const rows = [];
  for (const binding of bindings.filter((item) => !item.removed)) {
    const row = local.get(binding.attachmentId);
    // Rows carry the validated MIME type so presentation can choose a thumbnail
    // or document tile without re-decrypting; the bytes themselves stay sealed.
    if (!row) { rows.push({ ...binding, name: "Attachment", size: null, type: null, state: remote.has(binding.attachmentId) ? "download-needed" : "failed" }); continue; }
    if (!row.ciphertext && row.localSealed) {
      const saved = await store.openAttachmentData(binding.attachmentId, row.localSealed).catch(() => null);
      const valid = saved && saved.parentKind === binding.parentKind && saved.parentId === binding.parentId;
      rows.push({ ...binding, name: valid ? saved.name : "Attachment", size: valid ? saved.bytes.length : null, type: valid ? saved.type ?? null : null, state: valid ? row.state : "failed" });
      saved?.bytes?.fill(0);
      continue;
    }
    const epoch = await keyStore?.getEpoch(identity?.householdId, row.keyEpoch);
    if (!epoch) { rows.push({ ...binding, name: "Attachment", size: null, type: null, state: "failed" }); continue; }
    const opened = await decryptAttachment(row.ciphertext, { householdId: identity.householdId, attachmentId: binding.attachmentId, keyEpoch: row.keyEpoch, householdKey: epoch.householdKey, digest: row.digest }).catch(() => null);
    rows.push({ ...binding, name: opened?.name ?? "Attachment", size: opened?.size ?? null, type: opened?.type ?? null, state: opened ? row.state : "failed" });
  }
  return rows;
}

export async function currentEpoch(identity, keyStore, store) {
  let currentEpoch;
  try {
    const status = await attachmentJson("/api/sync/status");
    if (!status.enabled || status.rotationPending || !Number.isSafeInteger(status.currentEpoch)) throw new Error("sync unavailable");
    currentEpoch = status.currentEpoch;
  } catch {
    currentEpoch = (await store.getSyncState())?.currentEpoch;
  }
  if (!Number.isSafeInteger(currentEpoch)) throw new Error("sync unavailable");
  const epoch = await keyStore?.getEpoch(identity.householdId, currentEpoch);
  if (!epoch) throw new Error("This device is still receiving its household key. Try again shortly.");
  return { keyEpoch: currentEpoch, householdKey: epoch.householdKey };
}

async function downloadCiphertext(id, metadata, signal) {
  const response = await fetch(`/api/sync/attachments/${id}`, { credentials: "same-origin", signal, headers: { Accept: "application/octet-stream" } });
  if (!response.ok) throw new Error("download-failed");
  const epoch = Number(response.headers.get("X-Attachment-Key-Epoch"));
  const digest = response.headers.get("X-Attachment-SHA256");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (epoch !== metadata.keyEpoch || digest !== metadata.digest || bytes.length !== metadata.size || bytes.length > MAX_CIPHERTEXT || await sha256(bytes) !== digest) throw new Error("download-corrupt");
  return bytes;
}

async function attachmentJson(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { Accept: "application/json", ...(options.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message ?? "Household sync is unavailable.");
  return value;
}
async function attachmentRequest(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { ...(options.headers ?? {}) } });
  if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.message ?? "Household sync is unavailable."); }
  return response.headers.get("content-type")?.includes("json") ? response.json() : response;
}
export async function sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function validRemoteRecord(row) { return row && /^[a-f0-9]{32}$/.test(row.attachmentId ?? "") && Number.isSafeInteger(row.keyEpoch) && row.keyEpoch > 0 && Number.isSafeInteger(row.size) && row.size >= 29 && row.size <= MAX_CIPHERTEXT && /^[a-f0-9]{64}$/.test(row.digest ?? ""); }
function randomId() { return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
