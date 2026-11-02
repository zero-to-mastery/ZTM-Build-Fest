// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
// Honest two-device scenario: A archives X online; B, offline (last saw lt=1), adds Y then completes X.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const root = KIN + "web/wasm/";
const mod = await import(pathToFileURL(root + "kin-engine.js").href);
const engine = await mod.loadKinEngine(`data:application/wasm;base64,${(await readFile(root + "kin_engine.wasm")).toString("base64")}`);
const hex = (v) => [...v].map((b) => b.toString(16).padStart(2, "0")).join("");
const id = (b) => new Uint8Array(16).fill(b);
const ctx = (dev, n, lt) => ({ eventId: id(dev * 16 + n), householdId: id(0xaa), actorId: id(0xa0 + dev), deviceId: id(dev), timestamp: 1_791_475_200_000 + n, logicalTime: BigInt(lt), entityId: id(0x70 + n) });
const asOf = 1_791_475_200_000, day = 20261009, X = id(0x11);
const base = [mod.encodeAddedRecord({ ...ctx(1, 1, 1), itemId: X, text: "Take out bins", classification: "need" })];
const archiveX = engine.executeCommand({ type: "archive", id: hex(X) }, ctx(1, 2, 2), base, asOf, null, day).encodedEvent;
const addY = mod.encodeAddedRecord({ ...ctx(2, 3, 2), itemId: id(0x12), text: "Buy milk", classification: "need" });
const completeX = engine.executeCommand({ type: "complete", id: hex(X) }, ctx(2, 4, 3), [...base, addY], asOf, null, day).encodedEvent;
console.log("B local replay (offline):", engine.applyEvents([...base, addY, completeX], asOf, null, day).items.length, "items OK");
try { engine.applyEvents([...base, archiveX, addY, completeX], asOf, null, day); console.log("merged replay: OK"); }
catch (e) { console.log("merged replay on every device FAILS:", e.code, e.message); }
