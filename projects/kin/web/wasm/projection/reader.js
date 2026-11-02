// A bounded cursor over one projection section. Reads past the section end
// fail closed (KinEngineError code 6) instead of running into the next one.
import { KinEngineError } from "../wire.js";

export const invalid = (message) => new KinEngineError(6, message);

export class SectionReader {
  constructor(bytes, view, start, end) {
    this.bytes = bytes;
    this.view = view;
    this.offset = start;
    this.end = end;
  }

  /** Throws `message` unless `length` more bytes remain in the section. */
  need(length, message) {
    if (this.offset + length > this.end) throw invalid(message);
  }

  /** A section must be consumed exactly. */
  finish() {
    if (this.offset !== this.end)
      throw invalid("Kin received trailing bytes from its household engine.");
  }
}
