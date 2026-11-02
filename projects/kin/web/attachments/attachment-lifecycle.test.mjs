import assert from "node:assert/strict";
import test from "node:test";
import { attachmentFileProblem, captureAttachment, reconcileAttachments, removeAttachment } from "./attachment-lifecycle.js";

function legacyStore() {
  const rows = new Map();
  return {
    rows,
    async getSyncState() { return null; },
    async sealAttachmentData(id, data) { return { id, encryptedFixture: true, size: data.bytes.length }; },
    async openAttachmentData() { throw new Error("not used"); },
    async saveAttachment(row) { rows.set(row.attachment_id, structuredClone(row)); },
    async loadAttachments() { return [...rows.values()]; },
    async updateAttachmentState(id, state) { const row = rows.get(id); if (row) rows.set(id, { ...row, state }); },
    async deleteAttachment(id) { rows.delete(id); },
  };
}

test("offline capture protects locally before committing the canonical binding", async () => {
  const store = legacyStore();
  const calls = [];
  const saved = await captureAttachment({
    file: new File([new Uint8Array([1, 2, 3])], "receipt.pdf", { type: "application/pdf" }),
    parentKind: "item", parentId: "11".repeat(16), identity: { householdId: "22".repeat(16) }, store,
    append: async (command) => { calls.push(command); assert.equal((await store.loadAttachments()).length, 1); },
  });
  assert.equal(saved.state, "queued");
  assert.equal(calls[0].type, "bind-attachment");
  assert.equal(store.rows.get(saved.attachmentId).ciphertext, null);
  assert.equal(store.rows.get(saved.attachmentId).state, "queued");
});

test("a failed canonical append leaves protected bytes for orphan reconciliation", async () => {
  const store = legacyStore();
  await assert.rejects(captureAttachment({
    file: new File([new Uint8Array([4])], "scan.png", { type: "image/png" }),
    parentKind: "item", parentId: "33".repeat(16), identity: { householdId: "44".repeat(16) }, store,
    append: async () => { throw new Error("offline"); },
  }), /offline/);
  assert.equal((await store.loadAttachments()).length, 1);
  assert.ok((await store.loadAttachments())[0].localSealed);
});

test("removal commits canonical history before marking local data for remote cleanup", async () => {
  const store = legacyStore();
  await store.saveAttachment({ attachment_id: "55".repeat(16), ciphertext: new Uint8Array([1]), localSealed: null, keyEpoch: 1, digest: "66".repeat(32), state: "synced" });
  let stateSeenDuringAppend;
  await removeAttachment({ attachmentId: "55".repeat(16), store, append: async () => { stateSeenDuringAppend = (await store.loadAttachments())[0].state; } });
  assert.equal(stateSeenDuringAppend, "synced");
  assert.equal((await store.loadAttachments())[0].state, "removed");
});

// v0.41.1: file-problem messages, failure stages, capture without a server identity, orphan grace.
const ID = (n) => n.toString(16).padStart(32, "0");

test("file problems are explained specifically: empty, unsupported type, oversized", () => {
  assert.match(attachmentFileProblem(null), /Choose a photo or PDF/);
  assert.match(attachmentFileProblem(new File([], "empty.png", { type: "image/png" })), /empty/);
  assert.match(attachmentFileProblem(new File(["x"], "scan.heic", { type: "image/heic" })), /can't attach this kind of file \(image\/heic\).*JPEG, PNG or WebP photo, or a PDF/);
  assert.match(attachmentFileProblem(new File(["x"], "notes.txt", { type: "text/plain" })), /text\/plain/);
  assert.match(attachmentFileProblem(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" })), /4\.0 MB.*4 MB or smaller/);
  assert.equal(attachmentFileProblem(new File(["x"], "ok.jpg", { type: "image/jpeg" })), null);
  assert.equal(attachmentFileProblem(new File(["%PDF"], "ok.pdf", { type: "application/pdf" })), null);
});

function fakeStore({ saveFails = false, syncState = null } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows, log,
    async getSyncState() { return syncState; },
    async sealAttachmentData(id, data) { log.push(["seal", id]); return { sealed: true, name: data.name, type: data.type, parentKind: data.parentKind, parentId: data.parentId, bytes: data.bytes.length }; },
    async openAttachmentData(_id, sealed) { return { ...sealed, bytes: new Uint8Array(sealed.bytes) }; },
    async saveAttachment(record) { if (saveFails) throw new Error("QuotaExceeded"); rows.set(record.attachment_id, { ...record }); log.push(["save", record.attachment_id]); return record.attachment_id; },
    async updateAttachmentState(id, state) { const row = rows.get(id); if (row) row.state = state; log.push(["state", id, state]); return Boolean(row); },
    async deleteAttachment(id) { log.push(["delete", id]); return rows.delete(id); },
    async loadAttachments() { return [...rows.values()].map((row) => ({ ...row })); },
  };
}

test("capture without a household identity seals the file locally and binds it", async () => {
  const store = fakeStore();
  const appended = [];
  const file = new File([new Uint8Array([1, 2, 3])], "fridge.jpg", { type: "image/jpeg" });
  const saved = await captureAttachment({ file, parentKind: "item", parentId: ID(1), identity: null, store, keyStore: null, append: async (command) => { appended.push(command); } });
  assert.equal(saved.name, "fridge.jpg");
  assert.equal(saved.state, "queued");
  assert.deepEqual(appended, [{ type: "bind-attachment", id: saved.attachmentId, parentKind: "item", parentId: ID(1) }]);
  const row = store.rows.get(saved.attachmentId);
  assert.equal(row.ciphertext, null);
  assert.equal(row.localSealed.sealed, true);
  assert.equal(row.state, "queued");
});

test("capture failures name the step that failed", async () => {
  const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  await assert.rejects(
    captureAttachment({ file: new File(["x"], "a.txt", { type: "text/plain" }), parentKind: "item", parentId: ID(1), identity: null, store: fakeStore(), append: async () => {} }),
    (error) => error.stage === "validation" && /text\/plain/.test(error.message),
  );
  await assert.rejects(
    captureAttachment({ file, parentKind: "item", parentId: ID(1), identity: null, store: null, append: async () => {} }),
    (error) => error.stage === "storage" && /Unlock Kin/.test(error.message),
  );
  await assert.rejects(
    captureAttachment({ file, parentKind: "item", parentId: ID(1), identity: null, store: fakeStore({ saveFails: true }), append: async () => {} }),
    (error) => error.stage === "storage" && error.message === "QuotaExceeded",
  );
  const store = fakeStore();
  await assert.rejects(
    captureAttachment({ file, parentKind: "item", parentId: ID(1), identity: null, store, append: async () => { throw Object.assign(new Error("event limit"), { userMessage: "Household history is full." }); } }),
    (error) => error.stage === "binding" && error.userMessage === "Household history is full.",
  );
  assert.equal([...store.rows.values()][0].state, "local", "protected bytes stay for reconciliation to clean up");
});

test("reconciliation gives an unbound local row one pass before deleting it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/sync/attachments")) return new Response(JSON.stringify({ attachments: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 404 });
  };
  try {
    const store = fakeStore();
    store.rows.set(ID(7), { attachment_id: ID(7), ciphertext: null, localSealed: { sealed: true, name: "mid-capture.jpg", type: "image/jpeg", parentKind: "item", parentId: ID(1), bytes: 3 }, keyEpoch: null, digest: null, state: "local" });
    store.rows.set(ID(8), { attachment_id: ID(8), ciphertext: null, localSealed: { sealed: true, name: "crashed.jpg", type: "image/jpeg", parentKind: "item", parentId: ID(1), bytes: 3 }, keyEpoch: null, digest: null, state: "queued" });
    const suspects = new Set();
    const identity = { householdId: ID(9), memberId: ID(10), deviceId: ID(11) };
    const keyStore = { async getEpoch() { return null; } };
    await reconcileAttachments({ identity, store, keyStore, state: { attachments: [] }, suspectedOrphans: suspects });
    assert.deepEqual(store.log.filter(([op]) => op === "delete"), [["delete", ID(8)]], "a queued row with no binding is a crash leftover and goes immediately");
    assert.ok(store.rows.has(ID(7)) && suspects.has(ID(7)), "a local row with no binding yet is only suspected");

    // The binding commits between passes: the suspect is cleared, nothing is deleted.
    await reconcileAttachments({ identity, store, keyStore, state: { attachments: [{ attachmentId: ID(7), parentKind: "item", parentId: ID(1), removed: false }] }, suspectedOrphans: suspects });
    assert.ok(store.rows.has(ID(7)) && !suspects.has(ID(7)), "a row whose binding arrived is no longer suspected");

    // Still unbound on a later pass: now it really is an orphan.
    store.rows.set(ID(12), { attachment_id: ID(12), ciphertext: null, localSealed: { sealed: true, name: "never-bound.jpg", type: "image/jpeg", parentKind: "item", parentId: ID(1), bytes: 3 }, keyEpoch: null, digest: null, state: "local" });
    await reconcileAttachments({ identity, store, keyStore, state: { attachments: [{ attachmentId: ID(7), parentKind: "item", parentId: ID(1), removed: false }] }, suspectedOrphans: suspects });
    assert.ok(store.rows.has(ID(12)), "first sighting is tolerated");
    await reconcileAttachments({ identity, store, keyStore, state: { attachments: [{ attachmentId: ID(7), parentKind: "item", parentId: ID(1), removed: false }] }, suspectedOrphans: suspects });
    assert.ok(!store.rows.has(ID(12)) && !suspects.has(ID(12)), "second sighting deletes the orphan");

    // Without a suspect set (legacy callers) the sweep is immediate, as before.
    store.rows.set(ID(13), { attachment_id: ID(13), ciphertext: null, localSealed: { sealed: true, name: "x.jpg", type: "image/jpeg", parentKind: "item", parentId: ID(1), bytes: 3 }, keyEpoch: null, digest: null, state: "local" });
    await reconcileAttachments({ identity, store, keyStore, state: { attachments: [] } });
    assert.ok(!store.rows.has(ID(13)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
