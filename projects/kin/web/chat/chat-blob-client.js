// The service's chat blob routes (#110; server/chat-blob-service.mjs).
// Blobs are ciphertext: nothing here sees a key or any content.
import { ChatBlobError, isRef } from "./chat-blob-crypto.js";

/** Most references one retire request may name (the service's bound). */
export const MAX_RETIRE_REFS = 64;

async function failure(response, fallback) {
  const value = await response.json().catch(() => ({}));
  return new ChatBlobError(value.message || fallback, value.error || "chat_blob_unavailable");
}

async function call(fetchImpl, path, init) {
  try {
    return await fetchImpl(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch (cause) {
    const error = new ChatBlobError("Chat couldn't reach the household service.", "connection_unavailable");
    error.cause = cause;
    throw error;
  }
}

export class ChatBlobClient {
  constructor({ fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    this.fetch = fetchImpl;
  }

  /** Uploads a sealed blob; uploading it again is harmless. */
  async upload(ref, ciphertext) {
    if (!isRef(ref) || !(ciphertext instanceof Uint8Array)) throw new ChatBlobError("That message can't be sent.");
    const response = await call(this.fetch, `/api/chat/blobs/${ref}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext,
    });
    if (!response.ok) throw await failure(response, "Chat couldn't send that message.");
    return response.json();
  }

  /**
   * A sealed blob's bytes: { ciphertext }, or { deleted: true } when the
   * blob was deleted (shown as a deleted message, not an error), or
   * { missing: true } when the author's device hasn't uploaded it yet.
   */
  async download(ref) {
    if (!isRef(ref)) throw new ChatBlobError("This message couldn't be opened.");
    const response = await call(this.fetch, `/api/chat/blobs/${ref}`, { method: "GET" });
    if (response.status === 410) {
      const error = await failure(response, "This message was deleted.");
      if (error.code === "chat_blob_deleted") return { deleted: true };
      throw error;
    }
    if (response.status === 404) return { missing: true };
    if (!response.ok) throw await failure(response, "Chat couldn't load that message.");
    return { ciphertext: new Uint8Array(await response.arrayBuffer()) };
  }

  /** Asks the service to delete blobs this member uploaded (or, as an
   * admin, anyone's), in batches. Returns how many it deleted. */
  async retire(refs) {
    const unique = [...new Set(refs)];
    if (!unique.every(isRef)) throw new ChatBlobError("Chat couldn't delete that message.");
    let retired = 0;
    for (let index = 0; index < unique.length; index += MAX_RETIRE_REFS) {
      const response = await call(this.fetch, "/api/chat/blobs/retire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: unique.slice(index, index + MAX_RETIRE_REFS) }),
      });
      if (!response.ok) throw await failure(response, "Chat couldn't delete that message.");
      retired += (await response.json()).retired;
    }
    return retired;
  }
}
