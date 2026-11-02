// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
// Throwaway repro 5: find the largest Reference Record the engine accepts, check browser validity
// and whether its encrypted envelope fits the server's 8 KiB bound.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const imp = (p) => import(pathToFileURL(KIN + p).href);
const { loadKinEngine } = await imp("web/wasm/kin-engine.js");
const { validateReferenceRecord } = await imp("web/household-validation.js");
const { encryptEvent, generateHouseholdKey, generateDeviceKeys } = await imp("web/sync/crypto.js");
const { isEventEnvelopeValid } = await imp("server/sync-contract.mjs");
const wasm = await readFile(KIN + "web/wasm/kin_engine.wasm");
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const hex = (n) => n.toString(16).padStart(2, "0").repeat(16);
const ctx = (n) => ({ eventId: hex(n), householdId: hex(1), actorId: hex(2), deviceId: hex(3), timestamp: 1_791_475_200_000 + n, logicalTime: BigInt(n) });
const householdKey = await generateHouseholdKey();
const { signingPrivateKey } = await generateDeviceKeys();

const fieldsFor = (total) => {
  const out = []; let left = total, i = 0;
  while (left > 0) { const s = Math.min(1024, left); out.push({ label: `F${i}`, value: "v".repeat(s) }); left -= s; i += 1; }
  return out;
};
const attempt = (total) => {
  const f = fieldsFor(total);
  try {
    const r = engine.executeCommand({ type: "save-reference-record", id: hex(20), recordId: hex(20), title: "Insurance", fields: f.map((x, i) => ({ fieldId: hex(40 + i), ...x })) }, ctx(9), [], 1_791_475_200_000, null, 20261009);
    return { ok: true, r, f };
  } catch (e) { return { ok: false, e, f }; }
};
let lo = 1, hi = 16 * 1024;
while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (attempt(mid).ok) lo = mid; else hi = mid - 1; }
const best = attempt(lo), over = attempt(lo + 1);
console.log(`engine max total field value bytes = ${lo}; at ${lo + 1}: ${over.e?.message} (code ${over.e?.code})`);
console.log(`browser validator at ${lo + 1}: valid=${validateReferenceRecord("Insurance", over.f).valid}`);
const ev = best.r.encodedEvent;
const bytes = ev.canonical_event ?? ev;
const envelope = await encryptEvent({ eventId: hex(9), householdId: hex(1), deviceId: hex(3), deviceSequence: 1, logicalTime: "9", keyEpoch: 1, plaintext: bytes, householdKey, signingKey: signingPrivateKey });
console.log(`largest engine-accepted record: canonical=${bytes.length}B envelope ciphertext=${envelope.ciphertext.length} chars, server accepts=${isEventEnvelopeValid(envelope)}`);
