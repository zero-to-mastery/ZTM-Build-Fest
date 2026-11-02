export const MAX_ATTACHMENT_PLAINTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PARENT = 5;
export const MAX_HOUSEHOLD_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_HOUSEHOLD_ATTACHMENTS = 64;
export const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

// The records an attachment's metadata may name as its parent. "album" is a
// family-album photo (#673): its parent ID is the attachment's own ID, so the
// same image can come back under a new photo with Undo (web/album).
const PARENT_KINDS = new Set(["note", "reference-record", "maintenance", "item", "album"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function encryptAttachment(file, { householdId, attachmentId, keyEpoch, householdKey, parentKind, parentId }) {
  validateContext({ householdId, attachmentId, keyEpoch, householdKey });
  validateAttachmentFile(file);
  if (!PARENT_KINDS.has(parentKind) || !isId(parentId))
    throw new Error("Kin could not attach this file to that household record.");
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = encoder.encode(JSON.stringify({ version: 1, name: typeof file.name === "string" ? file.name.slice(0, 240) : "Attachment", type: file.type, size: fileBytes.length, parentKind, parentId }));
  if (metadata.length > 1024) { fileBytes.fill(0); throw new Error("Attachment details are too long."); }
  const plaintext = new Uint8Array(5 + metadata.length + fileBytes.length);
  const view = new DataView(plaintext.buffer);
  plaintext[0] = 1; view.setUint32(1, metadata.length, true);
  plaintext.set(metadata, 5); plaintext.set(fileBytes, 5 + metadata.length);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(householdId, attachmentId, keyEpoch), tagLength: 128 }, householdKey, plaintext));
    const ciphertext = new Uint8Array(nonce.length + sealed.length); ciphertext.set(nonce); ciphertext.set(sealed, nonce.length);
    const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));
    return { ciphertext, digest, size: ciphertext.length };
  } finally {
    fileBytes.fill(0);
    plaintext.fill(0);
  }
}

export function validateAttachmentFile(file) {
  if (!(file instanceof Blob) || file.size < 1 || file.size > MAX_ATTACHMENT_PLAINTEXT_BYTES || !ALLOWED_ATTACHMENT_TYPES.has(file.type))
    throw new Error("Choose an image or PDF up to 4 MiB.");
  return true;
}

export async function decryptAttachment(ciphertext, { householdId, attachmentId, keyEpoch, householdKey, digest }) {
  validateContext({ householdId, attachmentId, keyEpoch, householdKey });
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 29 || ciphertext.length > MAX_ATTACHMENT_PLAINTEXT_BYTES + 4096)
    throw new Error("This attachment couldn't be opened.");
  const actualDigest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));
  if (digest !== actualDigest) throw new Error("This attachment couldn't be opened.");
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ciphertext.subarray(0, 12), additionalData: aad(householdId, attachmentId, keyEpoch), tagLength: 128 }, householdKey, ciphertext.subarray(12)));
    if (plaintext.length < 6 || plaintext[0] !== 1) throw new Error();
    const metadataLength = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(1, true);
    const bodyOffset = 5 + metadataLength;
    if (metadataLength < 2 || metadataLength > 1024 || bodyOffset > plaintext.length) throw new Error();
    const metadata = JSON.parse(decoder.decode(plaintext.subarray(5, bodyOffset)));
    if (metadata.version !== 1 || !ALLOWED_ATTACHMENT_TYPES.has(metadata.type) || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_ATTACHMENT_PLAINTEXT_BYTES || plaintext.length - bodyOffset !== metadata.size || !isId(metadata.parentId) || !PARENT_KINDS.has(metadata.parentKind) || typeof metadata.name !== "string" || metadata.name.length > 240) throw new Error();
    const blob = new Blob([plaintext.subarray(bodyOffset)], { type: metadata.type });
    return { blob, name: metadata.name, type: metadata.type, size: metadata.size, parentKind: metadata.parentKind, parentId: metadata.parentId };
  } catch {
    throw new Error("This attachment couldn't be opened.");
  } finally {
    plaintext?.fill(0);
  }
}

function validateContext({ householdId, attachmentId, keyEpoch, householdKey }) {
  if (!isId(householdId) || !isId(attachmentId) || !Number.isSafeInteger(keyEpoch) || keyEpoch < 1 || keyEpoch > 128 || householdKey?.algorithm?.name !== "AES-GCM")
    throw new Error("Kin could not prepare this attachment safely.");
}

function aad(householdId, attachmentId, keyEpoch) {
  return encoder.encode(`kin/attachment/v1\0${householdId}\0${attachmentId}\0${keyEpoch}`);
}

function isId(value) { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
function hex(bytes) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
