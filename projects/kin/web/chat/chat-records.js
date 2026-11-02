// The decrypted chat log held in memory while Kin is unlocked (#111): the
// canonical bytes of every chat event, back to back in one growing buffer,
// in the order the chat log store keeps them.
//
// view() returns what the engine's history mirror (wasm/history-mirror.js)
// tracks, like a household HistoryView: while the log only grows, each call
// sends the engine just the new records instead of the whole chat log. An
// append-only log never shrinks, so the epoch changes only on clear().

const INITIAL_BYTES = 64 * 1024;

class ChatRecordsView {
  constructor(records, length, epoch) {
    this.arena = records;
    this.length = length;
    this.epoch = epoch;
  }

  #live() {
    if (this.arena.epoch !== this.epoch) throw new Error("The chat log changed; read it again.");
    return this.arena;
  }

  recordLength(index) {
    if (index < 0 || index >= this.length) throw new RangeError("Chat event index out of range.");
    return this.#live().spans[index * 2 + 1];
  }

  record(index) {
    const records = this.#live();
    if (index < 0 || index >= this.length) throw new RangeError("Chat event index out of range.");
    const offset = records.spans[index * 2];
    return records.bytes.subarray(offset, offset + records.spans[index * 2 + 1]);
  }

  /** Copies records [from, to), which are contiguous, in one operation. */
  copyRecordsTo(target, offset, from, to) {
    const records = this.#live();
    if (from < 0 || to > this.length || from > to) throw new RangeError("Chat event range out of bounds.");
    if (from === to) return;
    const start = records.spans[from * 2];
    const end = records.spans[(to - 1) * 2] + records.spans[(to - 1) * 2 + 1];
    target.set(records.bytes.subarray(start, end), offset);
  }
}

export class ChatRecords {
  constructor() {
    this.epoch = 0;
    this.clear();
  }

  get length() {
    return this.count;
  }

  /** Appends one canonical chat event. */
  append(record) {
    const needed = this.used + record.length;
    if (needed > this.bytes.length) {
      // Grow by half again, so appending one event at a time copies the
      // buffer only now and then.
      const grown = new Uint8Array(Math.max(needed, Math.ceil(this.bytes.length * 1.5)));
      grown.set(this.bytes.subarray(0, this.used));
      this.bytes.fill(0);
      this.bytes = grown;
    }
    if (this.count * 2 + 2 > this.spans.length) {
      const spans = new Uint32Array(Math.max(64, this.spans.length * 2));
      spans.set(this.spans);
      this.spans = spans;
    }
    this.bytes.set(record, this.used);
    this.spans[this.count * 2] = this.used;
    this.spans[this.count * 2 + 1] = record.length;
    this.used = needed;
    this.count += 1;
  }

  view() {
    return new ChatRecordsView(this, this.count, this.epoch);
  }

  /** Zeroes and drops everything held (on lock, or losing chat access). */
  clear() {
    this.bytes?.fill(0);
    this.bytes = new Uint8Array(INITIAL_BYTES);
    this.spans = new Uint32Array(64);
    this.used = 0;
    this.count = 0;
    this.epoch += 1;
  }
}
