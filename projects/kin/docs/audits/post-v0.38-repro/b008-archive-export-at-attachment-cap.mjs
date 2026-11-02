// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
import { pathToFileURL } from "node:url";
const { serializeProtectedValue } = await import(pathToFileURL(KIN + "web/security/local-vault.js").href);
const B = 4 * 1024 * 1024 + 4096;
for (const count of [0, 1]) {
  const attachments = Array.from({ length: count }, (_, i) => ({ attachment_id: (i + 1).toString(16).padStart(32, "0"), ciphertext: new Uint8Array(B), localSealed: null, keyEpoch: 1, digest: "0".repeat(64), state: "synced" }));
  const bytes = serializeProtectedValue({ formatVersion: 2, events: [], local_context: [], attachments });
  console.log(`${count} attachments: serialized ${(bytes.length / 2 ** 20).toFixed(2)} MiB OK`);
}
for (const count of [11, 12]) {
  const attachments = Array.from({ length: count }, (_, i) => ({ attachment_id: i.toString(16).padStart(32, "0"), ciphertext: new Uint8Array(B), localSealed: null, keyEpoch: 1, digest: "0".repeat(64), state: "synced" }));
  const total = count * B;
  try { const bytes = serializeProtectedValue({ formatVersion: 2, events: [], local_context: [], attachments }); console.log(`${count} attachments (${(total/2**20).toFixed(2)} MiB, under 50 MiB local cap=${total <= 50*2**20}): serialized ${(bytes.length/2**20).toFixed(2)} MiB OK`); }
  catch (e) { console.log(`${count} attachments (${(total/2**20).toFixed(2)} MiB, under 50 MiB local cap=${total <= 50*2**20}): ${e.name} "${e.message}" userMessage=${JSON.stringify(e.userMessage)}`); }
}
const cap = 50 * 2 ** 20;
const exactSizes = [...Array(12).fill(B), cap - 12 * B];
const exact = exactSizes.map((size, i) => ({ attachment_id: (i + 1).toString(16).padStart(32, "0"), ciphertext: new Uint8Array(size), localSealed: null, keyEpoch: 1, digest: "0".repeat(64), state: "synced" }));
const bytes = serializeProtectedValue({ formatVersion: 2, events: [], local_context: [], attachments: exact });
console.log(`exact 50 MiB aggregate (${exact.length} valid attachments): serialized ${(bytes.length / 2 ** 20).toFixed(2)} MiB OK`);
