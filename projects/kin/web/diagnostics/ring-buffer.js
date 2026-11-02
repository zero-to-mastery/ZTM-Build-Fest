// The local diagnostic ring buffer (#631, ADR 0021 §3): the last 50 things
// that went wrong (or were slow) on this device, as codes and numbers only.
// A problem report shows them in its preview, where each can be removed
// before anything is sent; nothing reads them otherwise.
//
// Where it lives: in this page's memory and nowhere else. It is not written
// to localStorage, sessionStorage or IndexedDB, so it never outlives the tab,
// is never readable by another tab, and a reload or a closed tab empties it.
// A problem that ends in a reload is therefore not in the next page's buffer;
// that is the price of keeping nothing on disk, and the report's other
// diagnostics (version, sync state, storage use) still describe the device.
//
// Content-free by construction: append() takes a code from the registry
// (registry.js) and numeric or fixed-list fields, and nothing else. A string
// that isn't in a field's list becomes "other". Locking Kin doesn't clear it,
// because it holds nothing that belongs to the household.
import { normalizeFields } from "./registry.js";

export const RING_CAPACITY = 50;

export class DiagnosticRing {
  /** `now` returns milliseconds since 1970 (tests pass a fake clock). */
  constructor({ capacity = RING_CAPACITY, now = () => Date.now() } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("A diagnostic ring needs a positive capacity.");
    this.capacity = capacity;
    this.now = now;
    // A fixed array written in a circle: `next` is where the next entry
    // goes, `count` how many slots hold one.
    this.slots = new Array(capacity).fill(null);
    this.next = 0;
    this.count = 0;
    this.listeners = new Set();
  }

  /**
   * Records `code` with `fields`. Returns true when kept, false when the
   * code is not in the registry (nothing is recorded then).
   */
  append(code, fields = {}) {
    const normalized = normalizeFields(code, fields);
    if (!normalized) return false;
    const entry = Object.freeze({ t: Math.round(this.now()), code, fields: normalized });
    this.slots[this.next] = entry;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    for (const listener of this.listeners) {
      try { listener(entry); } catch { /* a listener's trouble isn't the buffer's */ }
    }
    return true;
  }

  /** The entries, oldest first, as frozen `{ t, code, fields }`. */
  snapshot() {
    const out = [];
    const start = (this.next - this.count + this.capacity) % this.capacity;
    for (let index = 0; index < this.count; index++) out.push(this.slots[(start + index) % this.capacity]);
    return out;
  }

  get size() { return this.count; }

  clear() {
    this.slots.fill(null);
    this.next = 0;
    this.count = 0;
  }

  /** Calls `listener(entry)` after each append; returns an unsubscribe. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** This page's buffer. */
export const diagnostics = new DiagnosticRing();

/** Records into this page's buffer; never throws. */
export function recordDiagnostic(code, fields) {
  try { return diagnostics.append(code, fields); } catch { return false; }
}
