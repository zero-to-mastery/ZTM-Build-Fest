// Session plaintext arena: the decrypted canonical event history of one
// unlocked EventStore, held as contiguous bytes so commands and refreshes stop
// re-reading and re-decrypting the full IndexedDB log, and so a replay
// request is one bulk copy instead of one copy per event. (The measurements
// behind both are in docs/audits/REFACTOR-BASELINE.md.)
//
// Layout (all growable by manual doubling; growth zero-fills the old buffers):
//   bytes      one Uint8Array of concatenated `encoded_event` records
//   spans      Uint32Array [offset, length] per record
//   sequences  Float64Array IndexedDB `local_sequence` per record (ascending;
//              IndexedDB keys are JS numbers, so Float64 holds any of them)
//   logical    BigUint64Array logical time per record
//   stamps     Float64Array event timestamp per record
//   ids        Uint8Array 64 bytes per record: event, household, actor, device
//   kinds      Uint8Array index into a small table of kind names
//   versions   Uint16Array event schema version
//   lookup     Int32Array open-addressed event-ID hash table (record index + 1;
//              0 marks an empty slot)
//
// Invariants:
// - The arena is derived and discardable. IndexedDB stays the only source of
//   truth; any doubt (generation or count mismatch) rebuilds from storage.
// - Records are in ascending `local_sequence`, exactly the order getAll()
//   returns, which is the input order the engine uses for catch-up boundaries.
// - `generation` is the persisted store generation the contents belong to.
//   Non-append changes (restore, migration, root rotation) bump it in the same
//   transaction, so a stale arena is detected before it is used.
// - `generation` and `epoch` are different counters. `generation` comes from
//   storage and says which corpus the arena holds. `epoch` is local to this
//   object: it increases on every reset or wipe, and a HistoryView remembers
//   the epoch it was made in, so it throws instead of reading new contents.
// - `wipe()` zero-fills every buffer and drops the references. It runs on lock,
//   close and session change. Garbage collection still gives no guarantee of
//   physical memory erasure (THREAT-MODEL.md).
const ID_BYTES = 64;
// Record capacity must stay a power of two: `lookup` has twice as many slots
// and is indexed with `& mask`. Doubling keeps that, and keeps the table at
// most half full, so a probe always reaches an empty slot.
const INITIAL_RECORDS = 64;
const INITIAL_BYTES = 16 * 1024;

export const EVENT_GENERATION_KEY = "event_generation";

/**
 * Advances the persisted event generation inside the caller's write
 * transaction, so every session arena rebuilds on its next read. Every change
 * to the events store other than an append (restore, migration, root
 * rotation) must call this in the same transaction; otherwise an arena would
 * keep serving the old plaintext. `abort(error)` aborts that transaction.
 */
export function bumpEventGeneration(security, abort) {
  const request = security.get(EVENT_GENERATION_KEY);
  request.onsuccess = () => {
    const current = request.result?.generation ?? 0;
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) abort(null);
    else security.put({ key: EVENT_GENERATION_KEY, generation: current + 1 });
  };
  request.onerror = () => abort(request.error);
}

export class StaleHistoryError extends Error {
  constructor() {
    super("Kin's in-memory household history changed. Try again.");
    this.name = "StaleHistoryError";
  }
}

export class EventArena {
  constructor() {
    this.epoch = 0;
    this.generation = null;
    this.#allocate(INITIAL_RECORDS, INITIAL_BYTES);
  }

  #allocate(records, bytes) {
    this.bytes = new Uint8Array(bytes);
    this.spans = new Uint32Array(records * 2);
    this.sequences = new Float64Array(records);
    this.logical = new BigUint64Array(records);
    this.stamps = new Float64Array(records);
    this.ids = new Uint8Array(records * ID_BYTES);
    this.kinds = new Uint8Array(records);
    this.versions = new Uint16Array(records);
    this.kindNames = [];
    this.lookup = new Int32Array(records * 2);
    this.count = 0;
    this.used = 0;
  }

  get length() { return this.count; }
  get byteLength() { return this.used; }
  // The newest record's local sequence. Sequences start at 1 (append rejects
  // anything else), so 0 safely means "empty".
  get tail() { return this.count ? this.sequences[this.count - 1] : 0; }

  /** Starts an empty arena for `generation`. Outstanding views become stale. */
  reset(generation) {
    this.#zero();
    this.#allocate(INITIAL_RECORDS, INITIAL_BYTES);
    this.generation = generation;
    this.epoch += 1;
  }

  /** Zero-fills and drops all plaintext. The arena must be reset before use. */
  wipe() {
    this.#zero();
    this.#allocate(0, 0);
    this.generation = null;
    this.epoch += 1;
  }

  #zero() {
    for (const buffer of [this.bytes, this.spans, this.sequences, this.stamps, this.ids,
      this.kinds, this.versions, this.lookup]) buffer?.fill(0);
    this.logical?.fill(0n);
  }

  /**
   * Appends one validated record. `metadata` is the Rust-derived KMET shape
   * ({ eventId, householdId, actorId, deviceId, timestamp, logicalTime, kind,
   * eventVersion }). Returns false, without changing anything, when
   * `localSequence` is not after the current tail (already present).
   */
  append(localSequence, encoded, metadata) {
    if (!Number.isSafeInteger(localSequence) || localSequence <= 0) throw new Error("Invalid local sequence.");
    if (localSequence <= this.tail) return false;
    const record = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
    this.#reserve(this.count + 1, this.used + record.length);
    const index = this.count;
    this.bytes.set(record, this.used);
    this.spans[index * 2] = this.used;
    this.spans[index * 2 + 1] = record.length;
    this.sequences[index] = localSequence;
    this.logical[index] = BigInt(metadata.logicalTime);
    this.stamps[index] = metadata.timestamp;
    const base = index * ID_BYTES;
    this.ids.set(metadata.eventId, base);
    this.ids.set(metadata.householdId, base + 16);
    this.ids.set(metadata.actorId, base + 32);
    this.ids.set(metadata.deviceId, base + 48);
    let kind = this.kindNames.indexOf(metadata.kind);
    if (kind < 0) kind = this.kindNames.push(metadata.kind) - 1;
    this.kinds[index] = kind;
    this.versions[index] = metadata.eventVersion;
    this.used += record.length;
    this.count += 1;
    this.#index(index);
    return true;
  }

  /**
   * Capacity for `records` records and exactly `bytes` record bytes, ahead
   * of appends whose size is known (an archive's history), so the byte
   * buffer is allocated once instead of doubling past what it needs. Record
   * tables still grow to a power of two (the event ID table needs one).
   */
  reserve(records, bytes) {
    this.#reserve(records, bytes, true);
  }

  #reserve(records, bytes, exact = false) {
    const recordCapacity = this.sequences.length;
    if (bytes > this.bytes.length) {
      let size = Math.max(this.bytes.length, INITIAL_BYTES);
      if (exact) size = bytes;
      while (size < bytes) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.bytes.subarray(0, this.used));
      this.bytes.fill(0);
      this.bytes = next;
    }
    if (records <= recordCapacity) return;
    let size = Math.max(recordCapacity, INITIAL_RECORDS);
    while (size < records) size *= 2;
    const grow = (Type, from, width = 1) => {
      const next = new Type(size * width);
      next.set(from.subarray(0, this.count * width));
      from.fill(Type === BigUint64Array ? 0n : 0);
      return next;
    };
    this.spans = grow(Uint32Array, this.spans, 2);
    this.sequences = grow(Float64Array, this.sequences);
    this.logical = grow(BigUint64Array, this.logical);
    this.stamps = grow(Float64Array, this.stamps);
    this.ids = grow(Uint8Array, this.ids, ID_BYTES);
    this.kinds = grow(Uint8Array, this.kinds);
    this.versions = grow(Uint16Array, this.versions);
    this.lookup = new Int32Array(size * 2);
    for (let index = 0; index < this.count; index += 1) this.#index(index);
  }

  // Event IDs come from randomId() (kin-engine.js), so their first four bytes
  // are a usable hash. A non-random ID would only cause longer probes.
  #slot(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  #index(index) {
    const mask = this.lookup.length - 1;
    let slot = this.#slot(this.ids, index * ID_BYTES) & mask;
    while (this.lookup[slot] !== 0) slot = (slot + 1) & mask;
    this.lookup[slot] = index + 1;
  }

  /** Record index of `eventId` within the first `limit` records, or -1. */
  indexOfEventId(eventId, limit = this.count) {
    if (!this.lookup.length) return -1;
    const mask = this.lookup.length - 1;
    let slot = this.#slot(eventId, 0) & mask;
    for (let probe = 0; probe < this.lookup.length; probe += 1) {
      const entry = this.lookup[slot];
      if (entry === 0) return -1;
      const index = entry - 1;
      if (index < limit && this.#idEquals(index, 0, eventId)) return index;
      slot = (slot + 1) & mask;
    }
    return -1;
  }

  #idEquals(index, field, bytes) {
    const base = index * ID_BYTES + field;
    for (let offset = 0; offset < 16; offset += 1) if (this.ids[base + offset] !== bytes[offset]) return false;
    return true;
  }

  /** Index of the record with `localSequence` within `limit`, or -1. */
  indexOfSequence(localSequence, limit = this.count) {
    let low = 0, high = limit - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.sequences[middle];
      if (value === localSequence) return middle;
      if (value < localSequence) low = middle + 1; else high = middle - 1;
    }
    return -1;
  }

  /** A stable read-only prefix view of the current records. */
  view(limit = this.count) {
    if (limit > this.count) throw new StaleHistoryError();
    return new HistoryView(this, limit, this.epoch);
  }
}

const FIELDS = { event_id: 0, household_id: 16, actor_id: 32, device_id: 48 };

/**
 * The first `length` records of an arena, as one transaction observed them.
 * Records beyond the prefix may be appended later without affecting it; a
 * rebuild or wipe makes the view stale and every access throws.
 *
 * `record()`, `records()` and `id()` return subarrays of the arena's own
 * buffers, not copies. They are valid only until the next append: an append
 * that grows the arena moves its bytes and zero-fills the old buffer, so a
 * subarray kept across an `await` may silently read zeros. Use them
 * synchronously, or `slice()` what must outlive the current task.
 */
export class HistoryView {
  constructor(arena, length, epoch) {
    this.arena = arena;
    this.length = length;
    this.epoch = epoch;
  }

  #live() {
    if (this.arena.epoch !== this.epoch) throw new StaleHistoryError();
    return this.arena;
  }

  get byteLength() {
    const arena = this.#live();
    if (!this.length) return 0;
    const last = (this.length - 1) * 2;
    return arena.spans[last] + arena.spans[last + 1];
  }

  /** The canonical bytes of record `index`, as a subarray view (no copy). */
  record(index) {
    const arena = this.#live();
    if (index < 0 || index >= this.length) throw new RangeError("Event index out of range.");
    const offset = arena.spans[index * 2];
    return arena.bytes.subarray(offset, offset + arena.spans[index * 2 + 1]);
  }

  /** Subarray views of every record, in local order. */
  records() {
    const result = new Array(this.length);
    for (let index = 0; index < this.length; index += 1) result[index] = this.record(index);
    return result;
  }

  /** Copies the contiguous canonical bytes of the prefix in one operation. */
  copyTo(target, offset) {
    const arena = this.#live();
    target.set(arena.bytes.subarray(0, this.byteLength), offset);
  }

  /** Byte length of record `index`. */
  recordLength(index) {
    if (index < 0 || index >= this.length) throw new RangeError("Event index out of range.");
    return this.#live().spans[index * 2 + 1];
  }

  /** Copies the bytes of records [from, to), which are contiguous, in one
   * operation (the engine appends new records to its own history this way). */
  copyRecordsTo(target, offset, from, to) {
    const arena = this.#live();
    if (from < 0 || to > this.length || from > to) throw new RangeError("Event range out of bounds.");
    if (from === to) return;
    const start = arena.spans[from * 2];
    const end = arena.spans[(to - 1) * 2] + arena.spans[(to - 1) * 2 + 1];
    target.set(arena.bytes.subarray(start, end), offset);
  }

  localSequence(index) { return this.#live().sequences[index]; }
  logicalTime(index) { return this.#live().logical[index]; }

  /** A 16-byte subarray view of one identifier of record `index`. */
  id(index, field) {
    const arena = this.#live();
    const base = index * ID_BYTES + FIELDS[field];
    return arena.ids.subarray(base, base + 16);
  }

  get tail() { return this.length ? this.localSequence(this.length - 1) : 0; }

  indexOfSequence(localSequence) { return this.#live().indexOfSequence(localSequence, this.length); }
  indexOfEventId(eventId) { return this.#live().indexOfEventId(eventId, this.length); }

  maxLogicalTime() {
    const arena = this.#live();
    let maximum = 0n;
    for (let index = 0; index < this.length; index += 1)
      if (arena.logical[index] > maximum) maximum = arena.logical[index];
    return maximum;
  }

  /** Detached row objects with copied bytes, for infrequent callers that need
   * the historical `events` row shape (sync bootstrap, tests, archives). */
  row(index) {
    const arena = this.#live();
    return {
      local_sequence: arena.sequences[index],
      event_id: this.id(index, "event_id").slice(),
      household_id: this.id(index, "household_id").slice(),
      actor_id: this.id(index, "actor_id").slice(),
      device_id: this.id(index, "device_id").slice(),
      timestamp: arena.stamps[index],
      logical_time: arena.logical[index],
      kind: arena.kindNames[arena.kinds[index]],
      event_version: arena.versions[index],
      encoded_event: this.record(index).slice(),
    };
  }

  rows() {
    const result = new Array(this.length);
    for (let index = 0; index < this.length; index += 1) result[index] = this.row(index);
    return result;
  }

  at(position) {
    const index = position < 0 ? this.length + position : position;
    return index >= 0 && index < this.length ? this.row(index) : undefined;
  }
}

/** A replay source of a history view followed by extra canonical records,
 * without materializing a combined array. EventStore uses it to replay the
 * stored history plus events not yet stored (remote additions being
 * reconciled, or a candidate event being checked). */
export function historyWith(view, extras) {
  const sources = extras.map((record) => (record instanceof Uint8Array ? record : new Uint8Array(record)));
  return {
    // The engine recognizes these: it brings its own history up to `base` and
    // appends `extras` for one replay only (kin-engine.js syncHistory).
    base: view,
    extras: sources,
    length: view.length + sources.length,
    byteLength: view.byteLength + sources.reduce((total, record) => total + record.length, 0),
    copyTo(target, offset) {
      view.copyTo(target, offset);
      let cursor = offset + view.byteLength;
      for (const record of sources) { target.set(record, cursor); cursor += record.length; }
    },
  };
}
