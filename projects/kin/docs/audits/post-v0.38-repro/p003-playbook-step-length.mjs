// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
// Throwaway repro: compare browser validators with the real Rust/WASM engine.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = KIN + "web/";
const { loadKinEngine } = await import(pathToFileURL(ROOT + "wasm/kin-engine.js").href);
const { validatePlaybook, validateReferenceRecord } = await import(pathToFileURL(ROOT + "household-validation.js").href);

const wasm = await readFile(ROOT + "wasm/kin_engine.wasm");
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (n) => new Uint8Array(16).fill(n);
const hex = (n) => n.toString(16).padStart(2, "0").repeat(16);

function scenario(label, fn) {
  const records = [];
  let n = 0;
  const run = (command) => {
    n += 1;
    const result = engine.executeCommand(command, {
      eventId: id(n), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
      timestamp: 1_791_475_200_000 + n, logicalTime: BigInt(n),
    }, records, 1_791_475_200_000, null, 20261009);
    records.push(result.encodedEvent);
    return result.state;
  };
  try { console.log(label, "->", fn(run)); }
  catch (error) { console.log(label, "-> ENGINE REJECTED:", error.code ?? "", error.message); }
}

// 1. Playbook entry: 81..256 bytes passes browser + Rust playbook rule, but
//    instantiation creates Steps bounded to 80 chars.
for (const entry of ["x".repeat(81), "🧺".repeat(64), "a".repeat(256)]) {
  const v = validatePlaybook("Weekly reset", [entry]);
  console.log(`\nentry chars=${[...entry].length} utf16=${entry.length} bytes=${Buffer.byteLength(entry)} browser valid=${v.valid}`);
  scenario("  save-playbook", (run) => run({ type: "save-playbook", id: id(0x42), title: "Weekly reset", entries: [entry] }).playbooks.length + " playbook(s) saved");
  scenario("  instantiate (add item + add-item-step)", (run) => {
    run({ type: "save-playbook", id: id(0x42), title: "Weekly reset", entries: ["ok step", entry] });
    run({ type: "add", id: hex(0x51), text: "Weekly reset", classification: "need" });
    run({ type: "add-item-step", itemId: hex(0x51), stepId: hex(0x52), text: "ok step" });
    run({ type: "add-item-step", itemId: hex(0x51), stepId: hex(0x53), text: entry });
    return "steps created";
  });
}

// 2. Reference record emoji/CJK at exact byte limit (expect agreement).
for (const title of ["界".repeat(42), "界".repeat(43), "🔑".repeat(32), "🔑".repeat(33)]) {
  const v = validateReferenceRecord(title, [{ label: "L", value: "v" }]);
  console.log(`\nreference title utf16=${title.length} bytes=${Buffer.byteLength(title)} browser valid=${v.valid}`);
  scenario("  save-reference-record", (run) => run({ type: "save-reference-record", id: id(7), title, fields: [{ id: id(8), label: "L", value: "v" }] }).referenceRecords?.length + " record(s)");
}

// 3. Trim divergence: JS String.prototype.trim vs Rust str::trim.
for (const [name, t] of [["U+FEFF prefix", "\uFEFFKitchen"], ["U+0085 suffix", "Kitchen\u0085"]]) {
  const v = validatePlaybook(t, ["step"]);
  console.log(`\n${name}: browser valid=${v.valid} browserTitle=${JSON.stringify(v.title)} err=${v.errors.title}`);
  scenario("  engine save-playbook raw", (run) => JSON.stringify(run({ type: "save-playbook", id: id(9), title: t, entries: ["step"] }).playbooks[0].title));
}
