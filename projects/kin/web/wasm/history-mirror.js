// The canonical history an engine's WASM instance holds (rust/src/history.rs),
// kept equal to the history a caller asks it to replay while copying as few
// bytes as possible.
//
// The host's history is a view of its session arena (storage/event-arena.js):
// a prefix of an append-only buffer, valid for one arena epoch. While calls
// keep passing views of the same arena and epoch, the instance only receives
// the records added since the last call (or drops records from the end for a
// shorter view). Anything else (another arena, a new epoch, a plain array of
// records) resets the instance and sends that history whole.
//
// A source from historyWith(view, extras) replays the view plus records not
// yet stored. Those extras are appended for one replay; the function hold()
// returns rolls them back.

// Append batch layout (history.rs): u32 count, u32 length per record, bytes.
// A whole history is sent in batches of about this many bytes, so the host
// never builds one copy of it to pass in (a record larger than this goes
// alone).
export const APPEND_BATCH_BYTES = 4 * 1024 * 1024;

function batchFromView(view, from, to) {
  const count = to - from;
  let bytes = 0;
  for (let index = from; index < to; index += 1) bytes += view.recordLength(index);
  const batch = new Uint8Array(4 + count * 4 + bytes);
  const data = new DataView(batch.buffer);
  data.setUint32(0, count, true);
  for (let index = from; index < to; index += 1) data.setUint32(4 + (index - from) * 4, view.recordLength(index), true);
  view.copyRecordsTo(batch, 4 + count * 4, from, to);
  return batch;
}

function batchFromRecords(records) {
  const count = records.length;
  const bytes = records.reduce((total, record) => total + record.length, 0);
  const batch = new Uint8Array(4 + count * 4 + bytes);
  const data = new DataView(batch.buffer);
  data.setUint32(0, count, true);
  let offset = 4 + count * 4;
  records.forEach((record, index) => {
    data.setUint32(4 + index * 4, record.length, true);
    batch.set(record, offset);
    offset += record.length;
  });
  return batch;
}

const isView = (source) => typeof source?.copyRecordsTo === "function";

export class HistoryMirror {
  /**
   * @param exports the instance's WASM exports
   * @param append  (batch) => void, calls kin_history_append and throws a
   *                KinEngineError on failure (kin-engine.js callCore)
   * @param asBytes converts a stored record (Uint8Array or ArrayBuffer)
   * @param names   the reset and truncate exports of the log mirrored: the
   *                household history by default, or the chat log (#109)
   */
  constructor(exports, append, asBytes, { reset = "kin_history_reset", truncate = "kin_history_truncate" } = {}) {
    this.exports = exports;
    this.appendBatch = append;
    this.asBytes = asBytes;
    this.resetExport = reset;
    this.truncateExport = truncate;
    this.forget();
  }

  // The instance's contents are no longer known to match any arena view:
  // the next view resets it.
  forget() {
    this.arena = null;
    this.epoch = -1;
    this.length = 0;
  }

  /**
   * Makes the instance hold `source` (a HistoryView, a historyWith() result,
   * or an array of canonical records). Returns a function that removes any
   * extras appended for this replay; call it in a `finally`.
   */
  hold(source) {
    const base = source?.base ?? source;
    const extras = source?.extras ?? [];
    if (isView(base)) this.holdView(base);
    else this.holdRecords(base);
    if (!extras.length) return () => {};
    const length = this.length;
    this.appendBatch(batchFromRecords(extras));
    return () => this.truncate(length);
  }

  holdView(view) {
    const sameHistory = this.arena === view.arena && this.epoch === view.epoch;
    if (!sameHistory) {
      this.reset();
      this.appendView(view, 0);
    } else if (view.length < this.length) {
      if (!this.truncate(view.length)) this.appendView(view, 0);
    } else if (view.length > this.length) {
      this.appendView(view, this.length);
    }
    this.arena = view.arena;
    this.epoch = view.epoch;
    this.length = view.length;
  }

  // Appends records [from, view.length) in bounded batches. A failure after
  // some batches went in leaves the instance holding part of the view, so
  // the mirror forgets it and the next call resets.
  appendView(view, from) {
    try {
      while (from < view.length) {
        let to = from + 1;
        let bytes = view.recordLength(from);
        while (to < view.length && bytes + view.recordLength(to) <= APPEND_BATCH_BYTES) bytes += view.recordLength(to++);
        this.appendBatch(batchFromView(view, from, to));
        from = to;
      }
    } catch (error) {
      this.forget();
      throw error;
    }
  }

  // A plain array is not tracked: it is sent whole, and the next view resets.
  holdRecords(records) {
    this.reset();
    if (records.length) this.appendBatch(batchFromRecords(records.map(this.asBytes)));
    this.length = records.length;
  }

  reset() {
    this.forget();
    this.exports[this.resetExport]();
  }

  truncate(length) {
    if (this.exports[this.truncateExport](length) !== 0) {
      // Cannot happen while this mirror is accurate; forget the reset history.
      this.reset();
      return false;
    }
    this.length = length;
    return true;
  }
}
