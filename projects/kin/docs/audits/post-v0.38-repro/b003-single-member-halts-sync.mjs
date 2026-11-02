// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const root = KIN + "web/wasm/";
const mod = await import(pathToFileURL(root + "kin-engine.js").href);
const { reconcileRemoteEvents } = await import(pathToFileURL(KIN + "web/storage/event-store.js").href);
const wasm = await readFile(root + "kin_engine.wasm");
const engine = await mod.loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const hex = (v) => [...v].map((b) => b.toString(16).padStart(2, "0")).join("");
const ctx = (dev, actor, seq, lt = BigInt(seq)) => ({ eventId: new Uint8Array(16).fill(dev * 16 + seq), householdId: new Uint8Array(16).fill(0xaa), actorId: new Uint8Array(16).fill(actor), deviceId: new Uint8Array(16).fill(dev), timestamp: 1_791_475_200_000 + seq, logicalTime: lt });
const asOf = 1_791_475_200_000, day = 20261009;
// Honest adult (device 1, actor 0xa1) history
const honestItem = new Uint8Array(16).fill(0x11);
const honest = [mod.encodeAddedRecord({ ...ctx(1, 0xa1, 1), itemId: honestItem, text: "Milk", classification: "need" })];
console.log("honest projection items:", engine.applyEvents(honest, asOf, null, day).items.length);

// Attacker = Limited member (device 2, actor 0xb2). Creates an item LOCALLY only, then a responsibility change on it.
const secret = new Uint8Array(16).fill(0x22);
const local = [mod.encodeAddedRecord({ ...ctx(2, 0xb2, 2), itemId: secret, text: "x", classification: "need" })];
const poison = engine.executeCommand({ type: "change-responsibility", targetKind: "item", targetId: hex(secret), memberId: hex(new Uint8Array(16).fill(0xee)) }, ctx(2, 0xb2, 3), local, asOf, null, day).encodedEvent;
// Publish ONLY the poison event (validly signed/encrypted by attacker's own trusted device in real sync).
// The receiving EventStore quarantines semantically invalid ciphertext before durable acceptance.
const future = mod.encodeAddedRecord({ ...ctx(1, 0xa1, 6, 2n), itemId: new Uint8Array(16).fill(0x33), text: "Buy milk", classification: "need" });
const quarantined = reconcileRemoteEvents({ rows: [], received: [{ encodedEvent: poison }, { encodedEvent: future }], engine, context: { last_looked_event_id: null }, asOf, civilDate: day });
console.log("A) invalid remote poison quarantined:", quarantined.quarantined);
console.log("A2) future valid event remains replayable:", engine.applyEvents(quarantined.candidateRows.map(row => row.encoded_event), asOf, null, day).items.length, "items OK");

// B) Responsibility to arbitrary/removed member id accepted by replay
const assignGhost = engine.executeCommand({ type: "change-responsibility", targetKind: "item", targetId: hex(honestItem), memberId: "ee".repeat(16) }, ctx(2, 0xb2, 4), honest, asOf, null, day);
console.log("B) responsibility to unknown member id accepted:", JSON.stringify(assignGhost.state.responsibilities));

// C) Logical time near u64::MAX
const MAX = (1n << 64n) - 1n;
try {
  const high = engine.executeCommand({ type: "set-household-mode", mode: "guests" }, { ...ctx(2, 0xb2, 5, MAX - 1n), entityId: new Uint8Array(16).fill(5) }, honest, asOf, null, day);
  const s = engine.applyEvents([...honest, high.encodedEvent], asOf, null, day);
  console.log("C) event with logicalTime=2^64-2 accepted by replay; mode =", s.mode);
  // Honest device's next event must be > MAX-1 i.e. == MAX, which event-store rejects (logicalTime >= MAX_LOGICAL_TIME)
  try {
    const next = engine.executeCommand({ type: "set-household-mode", mode: "normal" }, { ...ctx(1, 0xa1, 6, MAX - 1n), entityId: new Uint8Array(16).fill(6) }, [...honest, high.encodedEvent], asOf, null, day);
    const s2 = engine.applyEvents([...honest, high.encodedEvent, next.encodedEvent], asOf, null, day);
    console.log("C2) honest event at equal logical time; final mode =", s2.mode, "(tie broken by device id)");
  } catch (e) { console.log("C2) honest follow-up rejected:", e.code, e.message); }
} catch (e) { console.log("C) high logical time rejected:", e.code, e.message); }

// D) Relay contract: the server's real envelope-shape check (server/sync-contract.mjs) for the
// logical times used above. This exercises only the relay's opaque acceptance rule; it does not
// sign, encrypt, upload or pull an event (no real relay round trip is performed here).
const { isEventEnvelopeValid } = await import(pathToFileURL(KIN + "server/sync-contract.mjs").href);
const b64u = (n) => Buffer.alloc(n, 7).toString("base64url");
const envelope = (logicalTime) => ({ protocolVersion: 1, envelopeVersion: 1, eventId: "ab".repeat(16), householdId: "aa".repeat(16), deviceId: "02".repeat(16), deviceSequence: 1, logicalTime, keyEpoch: 1, nonce: b64u(12), ciphertext: b64u(64), signature: b64u(64) });
for (const lt of [String(MAX - 1n), String(MAX), "340282366920938463463374607431768211455"])
  console.log(`D) relay envelope contract accepts logicalTime=${lt}:`, isEventEnvelopeValid(envelope(lt)));
