import assert from "node:assert/strict";
import test from "node:test";
import { decryptAttachment, encryptAttachment, MAX_ATTACHMENT_PLAINTEXT_BYTES } from "./attachment-crypto.js";

const id = (digit) => digit.repeat(32);
const key = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

test("attachment name, type, and parent metadata stay encrypted and roundtrip on the client", async () => {
  const householdKey = await key();
  const file = new File([new Uint8Array([1, 2, 3, 4])], "boiler manual.pdf", { type: "application/pdf" });
  const input = { householdId: id("a"), attachmentId: id("b"), keyEpoch: 2, householdKey, parentKind: "reference-record", parentId: id("c") };
  const encrypted = await encryptAttachment(file, input);
  assert.equal(encrypted.size, encrypted.ciphertext.length);
  assert.equal(new TextDecoder().decode(encrypted.ciphertext).includes("boiler manual.pdf"), false);
  const opened = await decryptAttachment(encrypted.ciphertext, { ...input, digest: encrypted.digest });
  assert.deepEqual({ name: opened.name, type: opened.type, size: opened.size, parentKind: opened.parentKind, parentId: opened.parentId }, { name: file.name, type: file.type, size: file.size, parentKind: "reference-record", parentId: id("c") });
  assert.deepEqual([...new Uint8Array(await opened.blob.arrayBuffer())], [1, 2, 3, 4]);
});

test("attachment encryption uses fresh nonces and rejects tampering, wrong keys, and routing context", async () => {
  const householdKey = await key();
  const input = { householdId: id("a"), attachmentId: id("b"), keyEpoch: 1, householdKey, parentKind: "item", parentId: id("c") };
  const file = new File(["private bytes"], "photo.webp", { type: "image/webp" });
  const first = await encryptAttachment(file, input), retry = await encryptAttachment(file, input);
  assert.notDeepEqual(first.ciphertext, retry.ciphertext);
  const corrupt = first.ciphertext.slice(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(decryptAttachment(corrupt, { ...input, digest: first.digest }), /couldn't be opened/);
  await assert.rejects(decryptAttachment(first.ciphertext, { ...input, attachmentId: id("d"), digest: first.digest }), /couldn't be opened/);
  await assert.rejects(decryptAttachment(first.ciphertext, { ...input, householdKey: await key(), digest: first.digest }), /couldn't be opened/);
});

test("only bounded images and PDFs are accepted", async () => {
  const input = { householdId: id("a"), attachmentId: id("b"), keyEpoch: 1, householdKey: await key(), parentKind: "note", parentId: id("c") };
  await assert.rejects(encryptAttachment(new File(["text"], "notes.txt", { type: "text/plain" }), input), /image or PDF/);
  await assert.rejects(encryptAttachment(new File([new Uint8Array(MAX_ATTACHMENT_PLAINTEXT_BYTES + 1)], "large.pdf", { type: "application/pdf" }), input), /image or PDF/);
});
