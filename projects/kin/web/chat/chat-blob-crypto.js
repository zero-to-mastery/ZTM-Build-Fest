// Chat content blobs (#110): sealing one message's content under its own key.
//
// Each message's text (and later each attachment, #114) is encrypted with a
// fresh random 32-byte AES-GCM key. The key travels only inside the
// encrypted chat event; the blob travels and is stored apart from the log,
// addressed by the SHA-256 of its sealed bytes (its "ref"). Deleting the
// blob deletes the content: the event that remains holds a key to nothing.
//
// Blob format 1: version byte 1, a 12-byte random nonce, then the AES-GCM
// ciphertext with its 16-byte tag. The additional data binds the format
// ("kin-chat-blob" and the version) so a blob can't be replayed as anything
// else sealed under the same key. A key seals exactly one blob, so a random
// nonce is never reused under a key.
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_CHAT_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
export const MAX_CHAT_BLOB_BYTES = 4 * 1024 * 1024 + 4096;
const ADDITIONAL_DATA = new TextEncoder().encode(`kin-chat-blob\0${VERSION}`);
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export class ChatBlobError extends Error {
  constructor(message, code = "chat_blob_invalid") {
    super(message);
    this.name = "ChatBlobError";
    this.code = code;
  }
}

const unopenable = () => new ChatBlobError("This message couldn't be opened.");

export function refHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export const isRef = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** The hex SHA-256 of a sealed blob: its reference. */
export async function blobRef(ciphertext) {
  return refHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));
}

async function importKey(raw, usage) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32 || raw.every((byte) => byte === 0)) throw unopenable();
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/**
 * Seals `plaintext` (bytes) under a new key. Returns { ref, key, ciphertext };
 * the caller puts `ref` and `key` in the chat event and uploads `ciphertext`.
 * The plaintext buffer is not modified; the caller owns and may wipe it.
 */
export async function sealChatBlob(plaintext) {
  if (!(plaintext instanceof Uint8Array) || plaintext.length < 1 || plaintext.length > MAX_CHAT_BLOB_BYTES - MIN_CHAT_BLOB_BYTES)
    throw new ChatBlobError("That message is too large to send.");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: ADDITIONAL_DATA, tagLength: TAG_BYTES * 8 },
    await importKey(key, "encrypt"),
    plaintext,
  ));
  const ciphertext = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  ciphertext[0] = VERSION;
  ciphertext.set(nonce, 1);
  ciphertext.set(sealed, 1 + NONCE_BYTES);
  return { ref: await blobRef(ciphertext), key, ciphertext };
}

/** Opens a sealed blob after checking it is the one `ref` names. */
export async function openChatBlob(ciphertext, { ref, key }) {
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < MIN_CHAT_BLOB_BYTES ||
    ciphertext.length > MAX_CHAT_BLOB_BYTES || ciphertext[0] !== VERSION || !isRef(ref))
    throw unopenable();
  if (await blobRef(ciphertext) !== ref) throw unopenable();
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ciphertext.subarray(1, 1 + NONCE_BYTES), additionalData: ADDITIONAL_DATA, tagLength: TAG_BYTES * 8 },
      await importKey(key, "decrypt"),
      ciphertext.subarray(1 + NONCE_BYTES),
    ));
  } catch {
    throw unopenable();
  }
}

/** A text message's blob: the text as UTF-8 (Rust checks the text rules). */
export async function sealChatText(text) {
  if (typeof text !== "string" || !text.isWellFormed()) throw new ChatBlobError("That message can't be sent.");
  const bytes = new TextEncoder().encode(text);
  try {
    return await sealChatBlob(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function openChatText(ciphertext, { ref, key }) {
  const bytes = await openChatBlob(ciphertext, { ref, key });
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw unopenable();
  } finally {
    bytes.fill(0);
  }
}
