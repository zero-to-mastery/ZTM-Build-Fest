// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const root = KIN + "web/wasm/";
const mod = await import(pathToFileURL(root + "kin-engine.js").href);
const wasm = await readFile(root + "kin_engine.wasm");
const engine = await mod.loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const hex = (v) => [...v].map((b) => b.toString(16).padStart(2, "0")).join("");
const ctx = (dev, seq, lt) => ({ eventId: new Uint8Array(16).fill(dev * 16 + seq), householdId: new Uint8Array(16).fill(0xaa), actorId: new Uint8Array(16).fill(0xa0 + dev), deviceId: new Uint8Array(16).fill(dev), timestamp: 1_791_475_200_000 + seq, logicalTime: BigInt(lt), entityId: new Uint8Array(16).fill(0x70 + seq) });
const asOf = 1_791_475_200_000, day = 20261009;
const item = new Uint8Array(16).fill(0x11);
const base = [mod.encodeAddedRecord({ ...ctx(1, 1, 1), itemId: item, text: "Bins", classification: "need" })];
const archive = engine.executeCommand({ type: "archive", id: hex(item) }, ctx(1, 2, 2), base, asOf, null, day).encodedEvent;
for (const cmd of [{ type: "complete", id: hex(item) }, { type: "pin", targetKind: "item", targetId: hex(item) }]) {
  try {
    const ev = engine.executeCommand(cmd, ctx(2, 3, 3), base, asOf, null, day).encodedEvent;
    try { engine.applyEvents([...base, archive, ev], asOf, null, day); console.log(cmd.type, "after concurrent archive: OK"); }
    catch (e) { console.log(cmd.type, "after concurrent archive: FAILS", e.code); }
  } catch (e) { console.log(cmd.type, "command error", e.message); }
}
for (const cmd of [{ type: "complete", id: hex(item) }, { type: "change-responsibility", targetKind: "item", targetId: hex(item), memberId: "a2".repeat(16) }, { type: "change-responsibility", targetKind: "item", targetId: hex(item), memberId: null }]) {
  const ev = engine.executeCommand(cmd, ctx(2, 5, 2), base, asOf, null, day).encodedEvent; // equal logical time 2 = truly concurrent
  try { engine.applyEvents([...base, archive, ev], asOf, null, day); console.log("EQUAL-LT", cmd.type, cmd.memberId === null ? "(clear)" : "", ": OK"); }
  catch (e) { console.log("EQUAL-LT", cmd.type, cmd.memberId === null ? "(clear)" : "", ": FAILS", e.code); }
}
