import test from "node:test";
import assert from "node:assert/strict";
import { LocalVault, fromBase64Url, toBase64Url } from "../security/local-vault.js";
import { protectRecord, unprotectRecord } from "./encrypted-idb.js";

test("protected routing, envelope corruption and tag changes fail closed for both root formats", async () => {
  const source = await LocalVault.create();
  const replacement = await LocalVault.createRotation(source.vault);
  const definition = { keyPath: "local_sequence", indexes: { event_id: "event_id" } };
  const value = { local_sequence: 1, event_id: new Uint8Array(16).fill(7), encoded_event: new Uint8Array([3, 9, 12]) };
  try {
    for (const vault of [source.vault, replacement.vault]) {
      const row = await protectRecord(vault, "events", definition, value);
      assert.deepEqual(await unprotectRecord(vault, "events", definition, row), value);
      const rejectRow = (candidate) => assert.rejects(unprotectRecord(vault, "events", definition, candidate));
      await rejectRow({ ...row, local_sequence: 2 });
      await rejectRow({ ...row, event_id: new Uint8Array(16).fill(8) });
      await rejectRow({ ...row, protected_version: 99 });
      await rejectRow({ ...row, plaintext: "unexpected field" });
      await rejectRow({ ...row, protected_value: null });
      const ciphertext = fromBase64Url(row.protected_value.ciphertext);
      for (const end of [0, 15, ciphertext.length - 1])
        await rejectRow({ ...row, protected_value: { ...row.protected_value, ciphertext: toBase64Url(ciphertext.subarray(0, end)) } });
      const alteredTag = ciphertext.slice();
      alteredTag[alteredTag.length - 1] ^= 1;
      await rejectRow({ ...row, protected_value: { ...row.protected_value, ciphertext: toBase64Url(alteredTag) } });
      await assert.rejects(unprotectRecord(vault, "sync_outbox", definition, row));
      const mismatchedValue = { ...value, event_id: new Uint8Array(16).fill(9) };
      await rejectRow({ ...row, protected_value: await vault.seal(mismatchedValue, { store: "events", id: "n:1" }) });
    }
  } finally { source.vault.lock(); replacement.vault.lock(); }
});
