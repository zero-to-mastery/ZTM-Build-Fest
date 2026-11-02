// KMNM v1 (#224) as the host decodes it; no WASM needed.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeMemberNames } from "./kin-engine.js";

function table(entries, { magic = "KMNM", version = 1, count = entries.length } = {}) {
  const encoder = new TextEncoder();
  const parts = entries.map(([id, name]) => {
    const bytes = encoder.encode(name);
    const part = new Uint8Array(18 + bytes.length);
    part.fill(id, 0, 16);
    new DataView(part.buffer).setUint16(16, bytes.length, true);
    part.set(bytes, 18);
    return part;
  });
  const out = new Uint8Array(12 + parts.reduce((sum, part) => sum + part.length, 0));
  out.set(encoder.encode(magic), 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, version, true);
  view.setUint32(8, count, true);
  let offset = 12;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

test("KMNM decodes members in order with their names", () => {
  assert.deepEqual(decodeMemberNames(table([[0x01, "Mikey"], [0x02, "Sam 🌱"]])), [
    { memberId: "01".repeat(16), name: "Mikey" },
    { memberId: "02".repeat(16), name: "Sam 🌱" },
  ]);
  assert.deepEqual(decodeMemberNames(table([])), []);
});

test("a malformed KMNM table is refused, never half-read", () => {
  const good = table([[0x01, "Mikey"]]);
  const bad = [
    table([[0x01, "Mikey"]], { magic: "KDEV" }),
    table([[0x01, "Mikey"]], { version: 2 }),
    table([[0x01, "Mikey"]], { count: 2 }),
    good.subarray(0, good.length - 1),
    Uint8Array.of(...good, 0),
    table([[0x01, ""]]),
  ];
  const invalidUtf8 = table([[0x01, "Mikey"]]);
  invalidUtf8[12 + 18] = 0xff; // the first byte of the name
  bad.push(invalidUtf8);
  for (const bytes of bad) assert.throws(() => decodeMemberNames(bytes), (error) => error.code === 6 || error instanceof TypeError);
});
