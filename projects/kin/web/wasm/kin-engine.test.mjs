import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  encodePulseSetRecord,
  encodePulseClearedRecord,
  encodeTalkAddedRecord,
  encodeTalkResolvedRecord,
  encodeTalkReopenedRecord,
  encodeTalkArchivedRecord,
  encodeAddedRecord,
  encodeHandoffAddedRecord,
  encodeHandoffAcknowledgedRecord,
  encodeHandoffArchivedRecord,
  loadKinEngine as loadCurrentEngine,
} from "./kin-engine.js";

// Existing scenarios use a fixed explicit civil context; raw legacy fixtures stay unchanged.
async function loadKinEngine(...args) {
  const engine = await loadCurrentEngine(...args);
  return {
    applyEvents: (
      records,
      asOf,
      cursor = null,
      civilDate = 20261002,
      syncIdentity = null,
    ) => engine.applyEvents(records, asOf, cursor, civilDate, syncIdentity),
  };
}

const initialWasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
await loadCurrentEngine(`data:application/wasm;base64,${initialWasm.toString("base64")}`);

const zeroId = new Uint8Array(16);

function encodeText(text) {
  return encodeAddedRecord({
    eventId: zeroId,
    householdId: zeroId,
    actorId: zeroId,
    deviceId: zeroId,
    timestamp: 1,
    logicalTime: 1,
    itemId: zeroId,
    text,
  });
}

test("leading BOM and Unicode are preserved in event text", () => {
  const text = "\uFEFFmilk 🥛";
  const record = encodeText(text);
  const textBytes = new TextEncoder().encode(text);

  assert.deepEqual(record.subarray(112), textBytes);
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(record.subarray(112)),
    text,
  );
  assert.equal(new DataView(record.buffer).getUint16(0, true), 2);
  assert.equal(record[104], 1);
});

test("unpaired surrogate input is rejected instead of silently replaced", () => {
  assert.throws(() => encodeText("\uD800"), /valid Unicode/);
});

test("item text is bounded by UTF-8 bytes rather than character count", () => {
  const maximum = "🥛".repeat(1024);
  const record = encodeText(maximum);

  assert.equal(record.length, 88 + 24 + 4096);
  assert.throws(() => encodeText(`${maximum}x`), /4096 UTF-8 bytes/);
});

test("invalid classification is rejected", () => {
  assert.throws(
    () =>
      encodeAddedRecord({
        eventId: zeroId,
        householdId: zeroId,
        actorId: zeroId,
        deviceId: zeroId,
        timestamp: 1,
        logicalTime: 1,
        itemId: zeroId,
        text: "Milk",
        classification: "later",
      }),
    /valid list/,
  );
});

// Independent v0.1 wire fixtures: do not use the current event writer to
// define the historical record layout that these compatibility tests protect.
function legacyRecord(kind, sequence) {
  const record = new Uint8Array(kind === 1 ? 112 : 104);
  const view = new DataView(record.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, kind, true);
  record.fill(sequence, 4, 20);
  record.fill(0xaa, 20, 36);
  record.fill(0xbb, 36, 52);
  record.fill(0xcc, 52, 68);
  view.setBigInt64(68, BigInt(sequence), true);
  view.setBigUint64(76, BigInt(sequence), true);
  view.setUint32(84, record.length - 88, true);
  record.fill(0x11, 88, 104);
  if (kind === 1) {
    view.setUint32(104, 4, true);
    record.set([77, 105, 108, 107], 108); // Milk
  }
  return record;
}

function expectedState(version, status = null, classification = 0) {
  const bytes = new Uint8Array(status === null ? 12 : 64);
  bytes.set([
    75,
    73,
    78,
    83,
    version,
    0,
    0,
    0,
    status === null ? 0 : 1,
    0,
    0,
    0,
  ]);
  if (status !== null) {
    bytes.fill(0x11, 12, 28);
    bytes.fill(0xbb, 28, 44);
    bytes[44] = 1; // created_at:i64 little endian
    bytes[52] = version === 1 ? status : classification;
    bytes[53] = version === 1 ? 0 : status;
    bytes[56] = 4; // text_length:u32 little endian
    bytes.set([77, 105, 108, 107], 60);
  }
  return bytes;
}

function emptyV7State() {
  return {
    items: [],
    handoffs: [],
    talks: [],
    pulses: [],
    routines: [],
    summary: { entries: [], totalCount: 0, throughEventId: null },
  };
}

test("protocol v8 resolves legacy identity bindings without rewriting records", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const first = legacyRecord(1, 1);
  const second = legacyRecord(1, 2);
  second.fill(0xdd, 20, 36);
  second.fill(0xee, 36, 52);
  second.fill(0xff, 52, 68);
  second.fill(0x22, 88, 104);
  new DataView(second.buffer).setBigUint64(76, 1n, true);
  new DataView(first.buffer).setBigUint64(76, 1n, true);
  const firstBytes = first.slice();
  const secondBytes = second.slice();
  const householdId = "99".repeat(16);
  const syncIdentity = {
    householdId,
    bindings: [
      {
        legacyHouseholdId: "aa".repeat(16),
        legacyActorId: "bb".repeat(16),
        legacyDeviceId: "cc".repeat(16),
        householdId,
        actorId: "22".repeat(16),
        deviceId: "02".repeat(16),
      },
      {
        legacyHouseholdId: "dd".repeat(16),
        legacyActorId: "ee".repeat(16),
        legacyDeviceId: "ff".repeat(16),
        householdId,
        actorId: "33".repeat(16),
        deviceId: "01".repeat(16),
      },
    ],
  };

  const state = engine.applyEvents(
    [first, second],
    0,
    null,
    20261002,
    syncIdentity,
  );
  assert.deepEqual(
    state.items.map((item) => item.createdBy),
    ["33".repeat(16), "22".repeat(16)],
  );
  assert.deepEqual(first, firstBytes);
  assert.deepEqual(second, secondBytes);
  assert.throws(
    () =>
      engine.applyEvents([first], 0, null, 20261002, {
        householdId,
        bindings: [],
      }),
    (error) => error.code === 4,
  );
});

test("protocol v8 replays 10,000 equal-time events through real WASM deterministically", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const id = (value) => value.toString(16).padStart(32, "0");
  const idBytes = (value) =>
    Uint8Array.from(
      Array.from({ length: 16 }, (_, index) =>
        Number.parseInt(id(value).slice(index * 2, index * 2 + 2), 16),
      ),
    );
  const records = Array.from({ length: 10_000 }, (_, index) =>
    encodeAddedRecord({
      eventId: idBytes(index + 1),
      householdId: new Uint8Array(16).fill(0xaa),
      actorId: new Uint8Array(16).fill(0xbb),
      deviceId: new Uint8Array(16).fill(0xcc),
      timestamp: 1,
      logicalTime: 7n,
      itemId: idBytes(index + 10_001),
      text: "x",
      classification: "need",
    }),
  );
  const householdId = "dd".repeat(16);
  const syncIdentity = {
    householdId,
    bindings: [
      {
        legacyHouseholdId: "aa".repeat(16),
        legacyActorId: "bb".repeat(16),
        legacyDeviceId: "cc".repeat(16),
        householdId,
        actorId: "ee".repeat(16),
        deviceId: "ff".repeat(16),
      },
    ],
  };
  const state = engine.applyEvents(records, 0, null, 20261002, syncIdentity);
  assert.equal(state.items.length, 10_000);
  assert.equal(state.items[0].createdBy, "ee".repeat(16));
  assert.equal(state.summary.totalCount, 10_000);
  assert.equal(state.summary.throughEventId, id(10_000));
  assert.equal(state.summary.entries.length, 8);
});

async function rawEngine() {
  const { instance } = await WebAssembly.instantiate(
    await readFile(new URL("./kin_engine.wasm", import.meta.url)),
    {},
  );
  const abi = instance.exports;
  return (version, records, expectedStatus = 0, asOf = 0) => {
    const headerSize = version === 6 ? 40 : version === 5 ? 20 : 12;
    const request = new Uint8Array(
      headerSize + records.reduce((size, row) => size + row.length, 0),
    );
    request.set([75, 73, 78, 69, version, 0, 0, 0]);
    new DataView(request.buffer).setUint32(8, records.length, true);
    if (version === 5 || version === 6)
      new DataView(request.buffer).setBigInt64(12, BigInt(asOf), true);
    let offset = headerSize;
    for (const record of records) {
      request.set(record, offset);
      offset += record.length;
    }
    const pointer = abi.kin_alloc(request.length);
    assert.notEqual(pointer, 0);
    try {
      new Uint8Array(abi.memory.buffer, pointer, request.length).set(request);
      assert.equal(
        abi.kin_apply_events(pointer, request.length),
        expectedStatus,
      );
      const success = expectedStatus === 0;
      assert.equal(success ? abi.kin_error_ptr() : abi.kin_result_ptr(), 0);
      assert.equal(success ? abi.kin_error_len() : abi.kin_result_len(), 0);
      const result = new Uint8Array(
        abi.memory.buffer,
        success ? abi.kin_result_ptr() : abi.kin_error_ptr(),
        success ? abi.kin_result_len() : abi.kin_error_len(),
      ).slice();
      if (!success) {
        assert.deepEqual(
          result.subarray(0, 8),
          new Uint8Array([75, 69, 82, 82, 1, 0, expectedStatus, 0]),
        );
        assert.equal(
          result.length,
          12 + new DataView(result.buffer).getUint32(8, true),
        );
      }
      return result;
    } finally {
      assert.equal(abi.kin_free(pointer, request.length), 0);
    }
  };
}

test("real WASM apply accepts only an exact live input allocation", async () => {
  const { instance } = await WebAssembly.instantiate(
    await readFile(new URL("./kin_engine.wasm", import.meta.url)),
    {},
  );
  const abi = instance.exports;
  const request = new Uint8Array(12);
  request.set([75, 73, 78, 69, 1, 0, 0, 0]);
  const pointer = abi.kin_alloc(request.length);
  assert.notEqual(pointer, 0);
  new Uint8Array(abi.memory.buffer, pointer, request.length).set(request);

  try {
    assert.equal(abi.kin_apply_events(pointer, request.length), 0);
    const resultPointer = abi.kin_result_ptr();
    const resultLength = abi.kin_result_len();
    assert.equal(abi.kin_apply_events(resultPointer, resultLength), 1);
    const errorPointer = abi.kin_error_ptr();
    const errorLength = abi.kin_error_len();
    assert.equal(abi.kin_apply_events(errorPointer, errorLength), 1);
    assert.equal(abi.kin_apply_events(pointer + 1, request.length - 1), 1);
    assert.equal(abi.kin_apply_events(pointer, request.length - 1), 1);
    assert.equal(abi.kin_apply_events(pointer, request.length + 1), 1);
    assert.equal(abi.kin_apply_events(1, request.length), 1);
    assert.equal(abi.kin_apply_events(0, 0), 2);

    // Rejected apply calls do not consume the legitimate input allocation.
    assert.equal(abi.kin_apply_events(pointer, request.length), 0);
  } finally {
    assert.equal(abi.kin_free(pointer, request.length), 0);
  }
});

test("bridge accepts KERR version 1 and rejects other or malformed versions", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutateError = () => {};
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 99, true);
            const status = abi.kin_apply_events(pointer, length);
            mutateError(
              new Uint8Array(
                abi.memory.buffer,
                abi.kin_error_ptr(),
                abi.kin_error_len(),
              ),
            );
            return status;
          },
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );

  for (const [label, mutation, expectedCode] of [
    ["version 1", () => {}, 3],
    ["version 2", (bytes) => (bytes[4] = 2), 6],
    ["version 7", (bytes) => (bytes[4] = 7), 6],
    [
      "malformed length",
      (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(8, 0, true),
      6,
    ],
  ]) {
    mutateError = mutation;
    assert.throws(
      () => engine.applyEvents([], 0),
      (error) => error.code === expectedCode,
      label,
    );
  }
});

test("real WASM ABI preserves exact v1 empty, active and completed results", async () => {
  const apply = await rawEngine();
  assert.deepEqual(apply(1, []), expectedState(1));
  assert.deepEqual(apply(1, [legacyRecord(1, 1)]), expectedState(1, 0));
  assert.deepEqual(
    apply(1, [legacyRecord(1, 1), legacyRecord(2, 2)]),
    expectedState(1, 1),
  );
});

test("real WASM ABI emits exact v2 classification and lifecycle layouts", async () => {
  const apply = await rawEngine();
  const legacy = legacyRecord(1, 1);
  const need = new Uint8Array(116);
  need.set(legacy.subarray(0, 104));
  const view = new DataView(need.buffer);
  view.setUint16(0, 2, true);
  view.setUint32(84, 28, true);
  need[104] = 1;
  view.setUint32(108, 4, true);
  need.set([77, 105, 108, 107], 112);
  assert.deepEqual(apply(2, []), expectedState(2));
  for (const [added, classification] of [
    [legacy, 0],
    [need, 1],
  ]) {
    assert.deepEqual(apply(2, [added]), expectedState(2, 0, classification));
    assert.deepEqual(
      apply(2, [added, legacyRecord(2, 2)]),
      expectedState(2, 1, classification),
    );
    assert.deepEqual(
      apply(2, [added, legacyRecord(4, 2)]),
      expectedState(2, 2, classification),
    );
  }
  apply(1, [need], 3);
  apply(1, [legacy, legacyRecord(4, 2)], 3);
});

test("real WASM ABI clears stale result and error buffers across versions", async () => {
  const apply = await rawEngine();
  for (let iteration = 0; iteration < 8; iteration++) {
    assert.deepEqual(
      apply(1, [legacyRecord(1, 1), legacyRecord(2, 2)]),
      expectedState(1, 1),
    );
    apply(99, [], 3);
    assert.deepEqual(apply(2, []), expectedState(2));
    apply(1, [legacyRecord(4, 2)], 3);
    assert.deepEqual(apply(1, []), expectedState(1));
    assert.deepEqual(apply(2, [legacyRecord(1, 1)]), expectedState(2, 0));
  }
});

test("bridge decodes real v1 and v2 completed results as Today, not Need", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let requestedVersion = 1;
  // The browser writes v7 only. A test transport shim requests v1 from the
  // real encoder so the bridge's historical decoder is exercised as well.
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(
              pointer + 4,
              requestedVersion,
              true,
            );
            return applyLegacy(abi, pointer, length);
          },
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  for (requestedVersion of [1, 2]) {
    assert.deepEqual(engine.applyEvents([], 0), {
      items: [],
      handoffs: [],
      talks: [],
      pulses: [],
    });
    for (const completed of [false, true]) {
      const records = [legacyRecord(1, 1)];
      if (completed) records.push(legacyRecord(2, 2));
      assert.deepEqual(engine.applyEvents(records, 0).items, [
        {
          itemId: "11".repeat(16),
          createdBy: "bb".repeat(16),
          createdAt: 1,
          classification: "today",
          status: completed ? "completed" : "active",
          text: "Milk",
        },
      ]);
    }
  }
});

function handoff(sequence, kind = 5, text = "Dishwasher running") {
  const identity = {
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: sequence,
    logicalTime: sequence,
    handoffId: new Uint8Array(16).fill(0x22),
    text,
  };
  return (
    kind === 5
      ? encodeHandoffAddedRecord
      : kind === 6
        ? encodeHandoffAcknowledgedRecord
        : encodeHandoffArchivedRecord
  )(identity);
}

test("protocol v3 mixed replay preserves legacy bytes and Handoff lifecycle", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const legacy = legacyRecord(1, 1);
  const snapshot = legacy.slice();
  const records = [legacy, handoff(2)];
  const state = engine.applyEvents(records, 0);
  assert.equal(state.items[0].classification, "today");
  assert.equal(state.handoffs[0].status, "unacknowledged");
  assert.equal(state.handoffs[0].createdBy, "bb".repeat(16));
  assert.equal(state.handoffs[0].createdAt, 2);
  records.push(handoff(3, 6));
  assert.equal(
    engine.applyEvents(records, 0).handoffs[0].status,
    "acknowledged",
  );
  records.push(handoff(4, 7));
  assert.equal(engine.applyEvents(records, 0).handoffs[0].status, "archived");
  assert.throws(
    () => engine.applyEvents([...records, handoff(5, 6)], 0),
    (error) => error.code === 4,
  );
  assert.deepEqual(legacy, snapshot);
  const apply = await rawEngine();
  for (const version of [1, 2]) apply(version, [handoff(1)], 3);
  assert.deepEqual(
    apply(3, []),
    new Uint8Array([75, 73, 78, 83, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
});

test("Handoff text encoder preserves Unicode and enforces byte bounds", () => {
  const text = "\uFEFF" + "🥛".repeat(1023) + "x";
  const record = handoff(1, 5, text);
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(record.subarray(108)),
    text,
  );
  assert.equal(record.length, 108 + 4096);
  assert.throws(() => handoff(1, 5, text + "x"), /4096/);
  assert.throws(() => handoff(1, 5, "\uD800"), /valid Unicode/);
});

test("bridge rejects malformed Handoff result fields and recovers", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutate = () => {};
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 3, true);
            const status = applyLegacy(abi, pointer, length);
            if (status === 0)
              mutate(
                new Uint8Array(
                  abi.memory.buffer,
                  abi.kin_result_ptr(),
                  abi.kin_result_len(),
                ),
              );
            return status;
          },
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  for (const mutation of [
    (bytes) => (bytes[56] = 3),
    ...[57, 58, 59].map((offset) => (bytes) => (bytes[offset] = 1)),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(60, 0, true),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(
        60,
        0xffffffff,
        true,
      ),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(12, 10001, true),
    (bytes) => (bytes[64] = 255),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(
        48,
        1n << 62n,
        true,
      ),
  ]) {
    mutate = mutation;
    assert.throws(
      () => engine.applyEvents([handoff(1)], 0),
      (error) => error.code === 6,
    );
    mutate = () => {};
    assert.equal(
      engine.applyEvents([handoff(1)], 0).handoffs[0].text,
      "Dishwasher running",
    );
  }
});

test("bridge fails closed at every truncated Handoff result boundary", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let resultLength;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 3, true);
            return applyLegacy(abi, pointer, length);
          },
          kin_result_len: () => resultLength ?? abi.kin_result_len(),
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  // Generate canonical input before fault injection alters the result-buffer ABI.
  const canonicalInput = handoff(1);
  for (resultLength = 0; resultLength < 16 + 48 + 18; resultLength++) {
    assert.throws(
      () => engine.applyEvents([canonicalInput], 0),
      (error) => error.code === 6,
    );
  }
  resultLength = 16 + 48 + 18 + 1;
  assert.throws(
    () => engine.applyEvents([canonicalInput], 0),
    (error) => error.code === 6,
  );
  resultLength = undefined;
  assert.equal(engine.applyEvents([canonicalInput], 0).handoffs.length, 1);
});

test("large Handoff replay grows WASM memory and preserves independent repeated results", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const initial = memory.buffer.byteLength;
  const id = (number) => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, number, true);
    return bytes;
  };
  const records = Array.from({ length: 10000 }, (_, index) =>
    encodeHandoffAddedRecord({
      eventId: id(index + 1),
      handoffId: id(index + 1),
      householdId: zeroId,
      actorId: zeroId,
      deviceId: zeroId,
      timestamp: index,
      logicalTime: index + 1,
      text: index < 1000 ? "x".repeat(4096) : "x",
    }),
  );
  const state = engine.applyEvents(records, 0);
  assert.ok(memory.buffer.byteLength > initial, "real memory growth occurred");
  assert.equal(state.handoffs.length, 10000);
  assert.equal(state.handoffs[999].text.length, 4096);
  for (let iteration = 0; iteration < 4; iteration++) {
    const bad = handoff(1);
    new DataView(bad.buffer).setUint16(2, 99, true);
    assert.throws(
      () => engine.applyEvents([bad], 0),
      (error) => error.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 0), state);
  }
  assert.equal(
    state.handoffs[0].text.length,
    4096,
    "host-owned result survives later calls",
  );
  assert.throws(
    () => engine.applyEvents([...records, records[0]], 0),
    (error) => error.code === 5,
  );
});

function talk(sequence, kind = 8, text = "Weekend plans") {
  const values = {
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: sequence,
    logicalTime: sequence,
    talkId: new Uint8Array(16).fill(0x33),
    text,
  };
  return {
    8: encodeTalkAddedRecord,
    9: encodeTalkResolvedRecord,
    10: encodeTalkReopenedRecord,
    11: encodeTalkArchivedRecord,
  }[kind](values);
}

test("Talk real WASM mixed replay, lifecycle and legacy compatibility", async () => {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const records = [legacyRecord(1, 1), handoff(2), talk(3)];
  const originals = records.map((row) => row.slice());
  assert.equal(engine.applyEvents(records, 0).talks[0].status, "open");
  for (const [kind, status] of [
    [9, "resolved"],
    [10, "open"],
    [11, "archived"],
  ]) {
    records.push(talk(records.length + 1, kind));
    const state = engine.applyEvents(records, 0);
    assert.equal(state.talks[0].status, status);
    assert.equal(state.items.length, 1);
    assert.equal(state.handoffs.length, 1);
  }
  assert.deepEqual(records.slice(0, 3), originals);
  assert.throws(
    () => engine.applyEvents([...records, talk(7, 10)], 0),
    (error) => error.code === 4,
  );
  const apply = await rawEngine();
  for (const version of [1, 2, 3])
    for (const kind of [8, 9, 10, 11]) apply(version, [talk(1, kind)], 3);
  assert.deepEqual(
    apply(4, []),
    new Uint8Array([
      75, 73, 78, 83, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
  );
});

test("Talk payload codes, schemas, Unicode and byte limits", () => {
  const text = "\uFEFF" + "\u{1f95b}".repeat(1023) + "x";
  for (const kind of [8, 9, 10, 11]) {
    const row = talk(1, kind, text),
      view = new DataView(row.buffer);
    assert.equal(view.getUint16(0, true), 1);
    assert.equal(view.getUint16(2, true), kind);
    assert.equal(row.length, kind === 8 ? 108 + 4096 : 104);
  }
  assert.throws(() => talk(1, 8, text + "x"), /4096/);
  assert.throws(() => talk(1, 8, "\uD800"), /valid Unicode/);
});

test("v4 rejects malformed Talk records, headers and combined counts", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutate = () => {};
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 4, true);
            const status = applyLegacy(abi, pointer, length);
            if (status === 0)
              mutate(
                new Uint8Array(
                  abi.memory.buffer,
                  abi.kin_result_ptr(),
                  abi.kin_result_len(),
                ),
              );
            return status;
          },
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const mutations = [
    (bytes) => (bytes[0] = 0),
    (bytes) => (bytes[4] = 99),
    (bytes) => (bytes[6] = 1),
    (bytes) => (bytes[7] = 1),
    (bytes) => (bytes[60] = 3),
    ...[61, 62, 63].map((offset) => (bytes) => (bytes[offset] = 1)),
    (bytes) => (bytes[68] = 255),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(
        52,
        2n ** 60n,
        true,
      ),
    ...[0, 4097, 0xffffffff].map(
      (length) => (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(
          64,
          length,
          true,
        ),
    ),
    ...[8, 12, 16].map(
      (offset) => (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(
          offset,
          0xffffffff,
          true,
        ),
    ),
    (bytes) => {
      const v = new DataView(bytes.buffer, bytes.byteOffset);
      v.setUint32(8, 3333, true);
      v.setUint32(12, 3333, true);
      v.setUint32(16, 3335, true);
    },
  ];
  for (mutate of mutations)
    assert.throws(
      () => engine.applyEvents([talk(1)], 0),
      (error) => error.code === 6,
    );
  mutate = () => {};
  assert.equal(engine.applyEvents([talk(1)], 0).talks[0].text, "Weekend plans");
});

test("exact pre-Talk event writer bytes and v3 result remain unchanged", async () => {
  const old = legacyRecord(1, 1);
  const identity = {
    eventId: new Uint8Array(16).fill(1),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(0xbb),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: 1,
    logicalTime: 1,
  };
  const expected = new Uint8Array(116);
  expected.set(old.subarray(0, 88));
  expected[0] = 2;
  expected[84] = 28;
  expected.fill(0x11, 88, 104);
  expected[104] = 1;
  expected[108] = 4;
  expected.set([77, 105, 108, 107], 112);
  assert.deepEqual(
    encodeAddedRecord({
      ...identity,
      itemId: new Uint8Array(16).fill(0x11),
      text: "Milk",
    }),
    expected,
  );
  for (const kind of [5, 6, 7]) {
    const fixture = legacyRecord(kind === 5 ? 1 : 2, 1);
    fixture[2] = kind;
    fixture.fill(0x22, 88, 104);
    assert.deepEqual(handoff(1, kind, "Milk"), fixture);
  }
  const apply = await rawEngine();
  const expectedV3 = new Uint8Array(68);
  expectedV3.set([75, 73, 78, 83, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  expectedV3.fill(0x22, 16, 32);
  expectedV3.fill(0xbb, 32, 48);
  expectedV3[48] = 1;
  expectedV3[60] = 4;
  expectedV3.set([77, 105, 108, 107], 64);
  assert.deepEqual(apply(3, [handoff(1, 5, "Milk")]), expectedV3);
});

test("bridge fails closed at every truncated Talk result boundary", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let resultLength;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args);
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 4, true);
            return applyLegacy(abi, pointer, length);
          },
          kin_result_len: () => resultLength ?? abi.kin_result_len(),
        },
      },
    };
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  // Generate canonical input before fault injection alters the result-buffer ABI.
  const canonicalInput = talk(1);
  for (resultLength = 0; resultLength < 20 + 48 + 13; resultLength++) {
    assert.throws(
      () => engine.applyEvents([canonicalInput], 0),
      (error) => error.code === 6,
    );
  }
  resultLength = 20 + 48 + 13 + 1;
  assert.throws(
    () => engine.applyEvents([canonicalInput], 0),
    (error) => error.code === 6,
  );
  resultLength = undefined;
  assert.equal(engine.applyEvents([canonicalInput], 0).talks.length, 1);
});

test("large Talk replay grows WASM memory and preserves independent repeated results", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const engine = await loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const initial = memory.buffer.byteLength;
  const id = (number) => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, number, true);
    return bytes;
  };
  const records = Array.from({ length: 10000 }, (_, index) =>
    encodeTalkAddedRecord({
      eventId: id(index + 1),
      talkId: id(index + 1),
      householdId: zeroId,
      actorId: zeroId,
      deviceId: zeroId,
      timestamp: index,
      logicalTime: index + 1,
      text: index < 1000 ? "x".repeat(4096) : "x",
    }),
  );
  const state = engine.applyEvents(records, 0);
  assert.ok(memory.buffer.byteLength > initial, "real memory growth occurred");
  assert.equal(state.talks.length, 10000);
  assert.equal(state.talks[999].text.length, 4096);
  for (let iteration = 0; iteration < 4; iteration++) {
    const bad = talk(1);
    new DataView(bad.buffer).setUint16(2, 99, true);
    assert.throws(
      () => engine.applyEvents([bad], 0),
      (error) => error.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 0), state);
  }
  assert.equal(
    state.talks[0].text.length,
    4096,
    "host-owned result survives later calls",
  );
  assert.throws(
    () => engine.applyEvents([...records, records[0]], 0),
    (error) => error.code === 5,
  );
});

// Adapt the current request header to an exact-size historical input allocation.
function applyLegacy(abi, pointer, length) {
  const bytes = new Uint8Array(abi.memory.buffer, pointer, length);
  const version = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(4, true);
  const headerLength = version === 6 ? 40 : version >= 5 ? 20 : 12;
  bytes.copyWithin(headerLength, 44);
  const legacyLength = length - (44 - headerLength);
  const legacyRequest = bytes.slice(0, legacyLength);
  const legacyPointer = abi.kin_alloc(legacyLength);
  assert.notEqual(legacyPointer, 0);
  new Uint8Array(abi.memory.buffer, legacyPointer, legacyLength).set(
    legacyRequest,
  );
  try {
    return abi.kin_apply_events(legacyPointer, legacyLength);
  } finally {
    assert.equal(abi.kin_free(legacyPointer, legacyLength), 0);
  }
}

function pulseRecord(
  sequence,
  value = "drained",
  expiresAt = 2000,
  actor = 0xbb,
) {
  const identity = {
    eventId: new Uint8Array(16).fill(sequence),
    householdId: new Uint8Array(16).fill(0xaa),
    actorId: new Uint8Array(16).fill(actor),
    deviceId: new Uint8Array(16).fill(0xcc),
    timestamp: 1000,
    logicalTime: sequence,
  };
  return value === null
    ? encodePulseClearedRecord(identity)
    : encodePulseSetRecord({ ...identity, value, expiresAt });
}

async function pulseEngine() {
  const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  return loadKinEngine(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
}

test("Pulse real WASM explicit-time boundary, replacement, actors and clear", async () => {
  const engine = await pulseEngine();
  const records = [pulseRecord(1)];
  for (const time of [1999, 2000, 2001, 1000]) {
    assert.equal(
      engine.applyEvents(records, time).pulses[0].status,
      time < 2000 ? "active" : "expired",
    );
  }
  records.push(
    pulseRecord(2, "good", 3000, 0xaa),
    pulseRecord(3, "need-quiet", 4000),
  );
  assert.deepEqual(
    engine.applyEvents(records, 2000).pulses.map((p) => p.value),
    ["good", "need-quiet"],
  );
  records.push(pulseRecord(4, null), pulseRecord(5, null));
  assert.equal(engine.applyEvents(records, 2000).pulses.length, 1);
  records.push(pulseRecord(6, "okay", 5000));
  assert.equal(engine.applyEvents(records, 2000).pulses[1].value, "okay");
  assert.throws(
    () => engine.applyEvents(records),
    (error) => error.code === 2,
  );
  for (const time of [NaN, Infinity, 0.5, 8640000000000001])
    assert.throws(
      () => engine.applyEvents(records, time),
      (error) => error.code === 2,
    );
});

test("Pulse encoding is fixed and legacy protocols reject both kinds", async () => {
  const set = pulseRecord(1, "need-quiet");
  assert.equal(set.length, 104);
  assert.deepEqual([...set.subarray(88, 96)], [4, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(new DataView(set.buffer).getBigInt64(96, true), 2000n);
  const clear = pulseRecord(2, null);
  assert.equal(clear.length, 88);
  assert.equal(clear[2], 13);
  const apply = await rawEngine();
  for (const version of [1, 2, 3, 4])
    for (const row of [set, clear]) apply(version, [row], 3);
  assert.throws(
    () => pulseRecord(1, "custom"),
    (error) => error.code === 2,
  );
});

test("v5 exact request/result time fields and immutable v4 Talk bytes", async () => {
  const apply = await rawEngine();
  const expected = new Uint8Array(64);
  expected.set([75, 73, 78, 83, 5, 0, 0, 0]);
  expected[20] = 1;
  expected.fill(0xbb, 24, 40);
  const view = new DataView(expected.buffer);
  view.setBigInt64(40, 1000n, true);
  view.setBigInt64(48, 2000n, true);
  expected[56] = 2;
  assert.deepEqual(apply(5, [pulseRecord(1)], 0, 1999), expected);
  expected[57] = 1;
  assert.deepEqual(apply(5, [pulseRecord(1)], 0, 2000), expected);
  const v4 = apply(4, [talk(1)]),
    v5 = apply(5, [talk(1)], 0, 2000);
  assert.deepEqual(v5.subarray(24), v4.subarray(20));
  for (const time of [-(2n ** 63n), 8640000000000001n, 2n ** 63n - 1n])
    apply(5, [], 2, time);
});

test("v6 bridge rejects malformed Pulse fields and combined counts then recovers", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutate = () => {};
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args),
      abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 6, true);
            const status = applyLegacy(abi, pointer, length);
            if (status === 0)
              mutate(
                new Uint8Array(
                  abi.memory.buffer,
                  abi.kin_result_ptr(),
                  abi.kin_result_len(),
                ),
              );
            return status;
          },
        },
      },
    };
  });
  const engine = await pulseEngine();
  const mutations = [
    (bytes) => (bytes[0] = 0),
    (bytes) => (bytes[4] = 7),
    (bytes) => (bytes[6] = 1),
    (bytes) => (bytes[7] = 1),
    (bytes) => (bytes[84] = 5),
    (bytes) => (bytes[85] = 2),
    ...[86, 87, 88, 89, 90, 91].map((i) => (bytes) => (bytes[i] = 1)),
    ...[68, 76].map(
      (i) => (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(
          i,
          8640000000000001n,
          true,
        ),
    ),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(76, 0n, true),
    ...[8, 12, 16, 20].map(
      (i) => (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(
          i,
          0xffffffff,
          true,
        ),
    ),
    (bytes) => {
      const v = new DataView(bytes.buffer, bytes.byteOffset);
      for (const i of [8, 12, 16, 20]) v.setUint32(i, 2501, true);
    },
  ];
  for (mutate of mutations)
    assert.throws(
      () => engine.applyEvents([pulseRecord(1)], 0),
      (e) => e.code === 6,
    );
  mutate = () => {};
  assert.equal(
    engine.applyEvents([pulseRecord(1)], 0).pulses[0].value,
    "drained",
  );
});

test("Pulse real WASM rejects malformed schema, payload, reserved and duration", async () => {
  const apply = await rawEngine();
  for (const original of [pulseRecord(1), pulseRecord(1, null)]) {
    for (let length = 0; length <= 20; length++) {
      if (length === original.length - 88) continue;
      const bad = new Uint8Array(88 + length);
      bad.set(original.subarray(0, bad.length));
      new DataView(bad.buffer).setUint32(84, length, true);
      apply(5, [bad], 2);
    }
    for (const version of [0, 2, 65535]) {
      const bad = original.slice();
      new DataView(bad.buffer).setUint16(0, version, true);
      apply(5, [bad], 3);
    }
  }
  for (let offset = 89; offset < 96; offset++) {
    const bad = pulseRecord(1);
    bad[offset] = 1;
    apply(5, [bad], 2);
  }
  for (const expiry of [999, 1000])
    apply(5, [pulseRecord(1, "good", expiry)], 4);
});

test("v6 bridge rejects every truncated header and Pulse record boundary", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let resultLength;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args),
      abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_result_len: () => resultLength ?? abi.kin_result_len(),
        },
      },
    };
  });
  const engine = await pulseEngine();
  // Generate canonical input before fault injection alters the result-buffer ABI.
  const canonicalInput = pulseRecord(1);
  for (resultLength = 0; resultLength < 92; resultLength++)
    assert.throws(
      () => engine.applyEvents([canonicalInput], 0),
      (e) => e.code === 6,
    );
  resultLength = 93;
  assert.throws(
    () => engine.applyEvents([canonicalInput], 0),
    (e) => e.code === 6,
  );
  resultLength = undefined;
  assert.equal(engine.applyEvents([canonicalInput], 0).pulses.length, 1);
});

test("v6 rejects malformed metadata in a two-Pulse result", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let reverse = false;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args),
      abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 6, true);
            const status = applyLegacy(abi, pointer, length);
            if (status === 0) {
              const bytes = new Uint8Array(
                abi.memory.buffer,
                abi.kin_result_ptr(),
                abi.kin_result_len(),
              );
              bytes.copyWithin(92, 52, 68);
              if (reverse) bytes.fill(0xff, 52, 68);
            }
            return status;
          },
        },
      },
    };
  });
  const engine = await pulseEngine();
  for (reverse of [false, true])
    assert.throws(
      () =>
        engine.applyEvents(
          [pulseRecord(1, "good", 2000, 1), pulseRecord(2, "okay", 2000, 2)],
          0,
        ),
      (e) => e.code === 6,
    );
});

test("10,000 mixed events through v7 grow memory and retain copied results across success error empty", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const engine = await pulseEngine();
  const initialBytes = memory.buffer.byteLength;
  const records = [];
  for (let n = 1; n <= 10000; n++) {
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(0, n, true);
    const identity = {
      eventId: id,
      householdId: zeroId,
      actorId: id,
      deviceId: zeroId,
      timestamp: 1000,
      logicalTime: n,
    };
    const text = n <= 1000 ? "x".repeat(4096) : "x";
    records.push(
      n % 4 === 0
        ? encodePulseSetRecord({
            ...identity,
            value: "need-quiet",
            expiresAt: 2000,
          })
        : n % 4 === 1
          ? encodeAddedRecord({ ...identity, itemId: id, text })
          : n % 4 === 2
            ? encodeHandoffAddedRecord({ ...identity, handoffId: id, text })
            : encodeTalkAddedRecord({ ...identity, talkId: id, text }),
    );
  }
  const state = engine.applyEvents(records, 1999),
    snapshot = structuredClone(state);
  assert.deepEqual(
    [
      state.items.length,
      state.handoffs.length,
      state.talks.length,
      state.pulses.length,
    ],
    [2500, 2500, 2500, 2500],
  );
  assert.ok(
    memory.buffer.byteLength > initialBytes,
    "real memory growth observed",
  );
  const expired = engine.applyEvents(records, 2000);
  assert.ok(expired.pulses.every((p) => p.status === "expired"));
  assert.deepEqual(state, snapshot, "old host-owned state survives next call");
  for (let n = 0; n < 8; n++) {
    const bad = pulseRecord(1);
    bad[2] = 99;
    assert.throws(
      () => engine.applyEvents([bad], 0),
      (e) => e.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 1999), snapshot);
  }
  assert.throws(
    () => engine.applyEvents([...records, records[0]], 0),
    (e) => e.code === 5,
  );
  assert.deepEqual(state, snapshot);
});

test("v6 copied result bytes outlive subsequent success error and empty calls", async () => {
  const apply = await rawEngine(),
    copy = apply(6, [legacyRecord(1, 1), pulseRecord(2)], 0, 1999),
    snapshot = copy.slice();
  const header = new DataView(copy.buffer);
  assert.equal(header.getUint16(4, true), 6);
  assert.equal(
    header.getUint32(24, true),
    1,
    "copied v6 result has a summary record",
  );
  assert.equal(header.getUint32(28, true), 1);
  assert.equal(new TextDecoder().decode(copy.subarray(-4)), "Milk");
  for (let n = 0; n < 8; n++) {
    apply(6, [pulseRecord(1)], 0, 2000);
    apply(6, [pulseRecord(1, "good", 1000)], 4);
    assert.equal(apply(6, []).length, 52);
    assert.deepEqual(copy, snapshot);
  }
});

test("protocol v6 summarizes after a stable cursor and reports the full snapshot boundary", async () => {
  const engine = await pulseEngine();
  const records = [legacyRecord(1, 1), legacyRecord(2, 2), pulseRecord(3)];
  const summary = engine.applyEvents(records, 1000, "01".repeat(16)).summary;

  assert.deepEqual(summary, {
    entries: [
      {
        eventId: "02".repeat(16),
        kind: "item-completed",
        entityKind: "item",
        text: "Milk",
        classification: null,
      },
    ],
    totalCount: 1,
    throughEventId: "03".repeat(16),
  });
  assert.deepEqual(Object.keys(summary.entries[0]), [
    "eventId",
    "kind",
    "entityKind",
    "text",
    "classification",
  ]);
  assert.throws(
    () => engine.applyEvents(records, 1000, "ff".repeat(16)),
    (error) => error.code === 4,
  );
  assert.deepEqual(
    engine
      .applyEvents(records, 1000)
      .summary.entries.map((entry) => entry.kind),
    ["item-added", "item-completed"],
  );
});

test("v6 rejects every truncated summary boundary and malformed summary field", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let mutate = () => {};
  let reportedResultLength;
  let validResultLength = 0;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    if (result instanceof WebAssembly.Instance) return result;
    const { instance } = result;
    const abi = instance.exports;
    return {
      instance: {
        exports: {
          ...abi,
          kin_apply_events(pointer, length) {
            new DataView(abi.memory.buffer).setUint16(pointer + 4, 6, true);
            const status = applyLegacy(abi, pointer, length);
            if (status === 0) {
              validResultLength = abi.kin_result_len();
              mutate(
                new Uint8Array(
                  abi.memory.buffer,
                  abi.kin_result_ptr(),
                  validResultLength,
                ),
              );
            }
            return status;
          },
          kin_result_len: () => reportedResultLength ?? abi.kin_result_len(),
        },
      },
    };
  });
  const engine = await pulseEngine();
  const records = [legacyRecord(1, 1), legacyRecord(2, 2)];
  const valid = engine.applyEvents(records, 0);
  assert.equal(valid.summary.entries.length, 2);

  const firstSummaryOffset = 52 + 52;
  const secondSummaryOffset = firstSummaryOffset + 28;
  const mutations = [
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(24, 9, true),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(28, 1, true),
    (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(28, 10001, true),
    (bytes) => (bytes[32] = 2),
    (bytes) => (bytes[32] = 0),
    (bytes) => (bytes[33] = 1),
    (bytes) => (bytes[firstSummaryOffset + 16] = 12),
    (bytes) => (bytes[firstSummaryOffset + 17] = 2),
    (bytes) => (bytes[firstSummaryOffset + 18] = 255),
    (bytes) => (bytes[firstSummaryOffset + 19] = 1),
    (bytes) => (bytes[firstSummaryOffset + 24] = 255),
    ...[0, 4097, 0xffffffff].map(
      (length) => (bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(
          firstSummaryOffset + 20,
          length,
          true,
        ),
    ),
    (bytes) => {
      bytes[secondSummaryOffset + 16] = 2;
      bytes[secondSummaryOffset + 18] = 0;
    },
  ];
  for (const [index, mutation] of mutations.entries()) {
    mutate = mutation;
    assert.throws(
      () => engine.applyEvents(records, 0),
      (error) => error.code === 6,
      `malformed v6 summary mutation ${index}`,
    );
  }
  mutate = () => {};
  assert.deepEqual(engine.applyEvents(records, 0), valid);

  for (
    reportedResultLength = 0;
    reportedResultLength < validResultLength;
    reportedResultLength += 1
  ) {
    assert.throws(
      () => engine.applyEvents(records, 0),
      (error) => error.code === 6,
    );
  }
  reportedResultLength = validResultLength + 1;
  assert.throws(
    () => engine.applyEvents(records, 0),
    (error) => error.code === 6,
  );
  reportedResultLength = undefined;
  assert.deepEqual(engine.applyEvents(records, 0), valid);
});

test("v7 10,000-event history permits bounded summary records and copied results", async (context) => {
  const instantiate = WebAssembly.instantiate;
  let memory;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args);
    memory = result.instance.exports.memory;
    return result;
  });
  const engine = await pulseEngine();
  const initialMemoryBytes = memory.buffer.byteLength;
  const makeId = (number) => {
    const value = new Uint8Array(16);
    new DataView(value.buffer).setUint32(0, number, true);
    return value;
  };
  const records = Array.from({ length: 10_000 }, (_, index) => {
    const eventNumber = index + 1;
    return encodeAddedRecord({
      eventId: makeId(eventNumber),
      householdId: zeroId,
      actorId: zeroId,
      deviceId: zeroId,
      timestamp: 1_760_000_000_000 + eventNumber,
      logicalTime: eventNumber,
      itemId: makeId(eventNumber + 10_000),
      text: "x",
    });
  });
  const state = engine.applyEvents(records, 1_760_000_020_000);
  const snapshot = structuredClone(state);
  const toHex = (bytes) =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.ok(
    memory.buffer.byteLength > initialMemoryBytes,
    "real WASM memory growth occurred",
  );
  assert.equal(state.items.length, 10_000);
  assert.equal(state.summary.entries.length, 8);
  assert.equal(state.summary.totalCount, 10_000);
  assert.equal(state.items.length + state.summary.entries.length, 10_008);
  assert.equal(state.summary.entries[0].eventId, toHex(makeId(9_993)));
  assert.equal(state.summary.throughEventId, toHex(makeId(10_000)));

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const invalid = records[0].slice();
    new DataView(invalid.buffer).setUint16(2, 99, true);
    assert.throws(
      () => engine.applyEvents([invalid], 0),
      (error) => error.code === 3,
    );
    assert.deepEqual(engine.applyEvents([], 0), emptyV7State());
    assert.deepEqual(engine.applyEvents(records, 1_760_000_020_000), snapshot);
  }
  assert.deepEqual(state, snapshot, "host-owned summary survives later calls");
});
