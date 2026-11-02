// Raw-ABI helpers for tests (not shipped). The engine replays the history it
// holds, so a whole KINE request is replayed as: reset the history, append the
// request's records as one batch, then project the request's context (the
// same request with its records removed).

const EVENT_HEADER_BYTES = 88;
const BINDING_BYTES = 96;

/** { context, batch } for a protocol-24 KINE request. */
export function splitRequest(request) {
  const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
  const count = view.getUint32(8, true);
  let offset = 64 + view.getUint16(60, true) * BINDING_BYTES;
  const context = request.slice(0, offset);
  new DataView(context.buffer).setUint32(8, 0, true);
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const end = offset + EVENT_HEADER_BYTES + view.getUint32(offset + 84, true);
    records.push(request.subarray(offset, end));
    offset = end;
  }
  return { context, batch: appendBatch(records) };
}

/** A kin_history_append batch: count, one length per record, the records. */
export function appendBatch(records) {
  const bytes = records.reduce((total, record) => total + record.length, 0);
  const batch = new Uint8Array(4 + records.length * 4 + bytes);
  const view = new DataView(batch.buffer);
  view.setUint32(0, records.length, true);
  let offset = 4 + records.length * 4;
  records.forEach((record, index) => {
    view.setUint32(4 + index * 4, record.length, true);
    batch.set(record, offset);
    offset += record.length;
  });
  return batch;
}

/** Calls an (pointer, length) export on a copy of `input`; returns the status. */
export function callExport(abi, name, input) {
  const pointer = abi.kin_alloc(input.length);
  if (!pointer) throw new Error("kin_alloc failed");
  try {
    new Uint8Array(abi.memory.buffer, pointer, input.length).set(input);
    return abi[name](pointer, input.length);
  } finally {
    if (abi.kin_free(pointer, input.length) !== 0) throw new Error("kin_free failed");
  }
}

/** Replays a whole KINE request; returns the status of the failing step or of
 * kin_project. On success the result buffer holds the KINS projection. */
export function replayRequest(abi, request) {
  const { context, batch } = splitRequest(request);
  abi.kin_history_reset();
  const appended = callExport(abi, "kin_history_append", batch);
  if (appended !== 0) return appended;
  return callExport(abi, "kin_project", context);
}

/** Copies the current result buffer out of linear memory. */
export const resultBytes = (abi) =>
  new Uint8Array(abi.memory.buffer, abi.kin_result_ptr(), abi.kin_result_len()).slice();
