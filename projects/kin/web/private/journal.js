// A member's journal on this device (#497, #501, ADR 0019): the entries the
// engine replays from the member's private log, and writing them.
//
// - Reading: the private log's KPRV projection (kin-private.js), journal
//   section, newest first. Nothing here is household state: it never
//   reaches the household projection, search, Today, chat or exports.
// - Writing: a journal command goes through the private log's `execute`
//   (private-log.js): the engine's `kin_private_execute` checks it against
//   the replayed log under the member's write lock, then the log seals and
//   stores the event. The
//   member key is made on the member's first write, if their vault has none
//   yet (ADR 0019).
// - Photos: drawn again (no EXIF, GPS or camera details), with a JPEG
//   thumbnail, each sealed under its own key and kept as a private blob
//   (private-blobs.js) that uploads on the next private pass. A photo's
//   keys travel only inside the entry's record.
import { attachmentMetaProblem } from "../attachments/attachment-lifecycle.js";
import { PHOTO_TYPES, preparePhoto, safeAttachmentName, sniffPhotoType } from "../chat/chat-attachments.js";
import { journalTextProblem, MAX_JOURNAL_PHOTO_BYTES, MAX_JOURNAL_PHOTOS, normalizeJournalBody, normalizeJournalTitle } from "../wasm/kin-private.js";
import { newPrivateId } from "./private-log.js";

export class JournalError extends Error {
  constructor(message, code = "journal_invalid") {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

/** Why a chosen file can't be a journal photo, or null: the household
 * attachment rules and wording for photos (JPEG, PNG, WebP, 4 MB). */
export function journalPhotoProblem(file) {
  if (!(file instanceof Blob)) return "Choose a photo to add.";
  if (!PHOTO_TYPES.has(file.type)) {
    const kind = typeof file.type === "string" && file.type ? ` (${file.type})` : "";
    return `Kin can't add this kind of file to your journal${kind}. Choose a JPEG, PNG or WebP photo.`;
  }
  return attachmentMetaProblem(file);
}

export class Journal {
  /**
   * `log` is the member's PrivateLog, `engine` the Kin engine, `blobs` the
   * member's PrivateBlobs. `preparePhoto` is injectable for tests.
   */
  constructor({ log, engine, blobs, now = () => Date.now(), prepare = preparePhoto }) {
    Object.assign(this, { log, engine, blobs, now, prepare });
    this.cache = null;
    this.unsubscribe = log.subscribe(() => { this.cache = null; });
  }

  /** "ready", "no_member_key" (ready: the first save makes the key), or why
   * the journal can't be used here (private-log.js `reason`). */
  get reason() {
    return this.log.reason;
  }

  get usable() {
    return this.reason === "ready" || this.reason === "no_member_key";
  }

  /** Live entries, newest first (kin-private.js `decodePrivate` journal). */
  entries() {
    if (this.reason === "no_member_key") return [];
    this.cache ??= this.log.projection().journal;
    return this.cache;
  }

  entry(entryId) {
    return this.entries().find((entry) => entry.id === entryId) ?? null;
  }

  /** Runs one journal command and stores its event: the private log's
   * `execute` validates it in the engine (`kin_private_execute`) under the
   * member's write lock, then seals and stores it. */
  async write(command) {
    if (this.reason === "no_member_key") {
      await this.log.enable();
      if (!this.log.active)
        throw new JournalError("Your journal needs your Kin account on this device.", "journal_unavailable");
    }
    await this.log.execute(command);
    this.cache = null;
  }

  /** The content a command carries, normalized, or a JournalError saying
   * what to fix. */
  content({ date, title = "", body = "", photos = [] }) {
    const clean = { date, title: normalizeJournalTitle(title), body: normalizeJournalBody(body), photos: [...photos] };
    const problem = journalTextProblem(clean);
    if (problem) throw new JournalError(problem);
    if (clean.photos.length > MAX_JOURNAL_PHOTOS) throw new JournalError(`An entry can have up to ${MAX_JOURNAL_PHOTOS} photos.`);
    return clean;
  }

  /** Saves a new entry; resolves with its ID. */
  async create(draft) {
    const entryId = newPrivateId();
    await this.write({ type: "create-journal-entry", entryId, ...this.content(draft) });
    return entryId;
  }

  /** Saves changes to an entry. Unchanged content writes nothing. */
  async edit(entryId, draft) {
    const content = this.content(draft);
    const current = this.entry(entryId);
    if (current && sameContent(current, content)) return false;
    await this.write({ type: "edit-journal-entry", entryId, ...content });
    return true;
  }

  remove(entryId) {
    return this.write({ type: "delete-journal-entry", entryId });
  }

  restore(entryId) {
    return this.write({ type: "restore-journal-entry", entryId });
  }

  /**
   * Prepares and seals one photo for an entry: { type, size, ref, key,
   * thumbnail, thumbnailKey }. Throws a JournalError with the household
   * attachment wording when the file can't be one.
   */
  async addPhoto(file) {
    const problem = journalPhotoProblem(file);
    if (problem) throw new JournalError(problem);
    // What the bytes are, not what the file says it is.
    const sniffed = await sniffPhotoType(file);
    if (sniffed !== file.type) throw new JournalError(`Kin couldn't read ${safeAttachmentName(file.name)}. Choose a valid JPEG, PNG or WebP photo.`);
    let prepared;
    try {
      prepared = await this.prepare(file);
    } catch (error) {
      throw new JournalError(error.message || `Kin couldn't read ${safeAttachmentName(file.name)}.`);
    }
    const full = new Uint8Array(await prepared.blob.arrayBuffer());
    const small = new Uint8Array(await prepared.thumbnail.arrayBuffer());
    try {
      if (full.length + 29 > MAX_JOURNAL_PHOTO_BYTES)
        throw new JournalError(`${safeAttachmentName(file.name)} is too large once prepared. Photos must be 4 MB or smaller; try a JPEG.`);
      const photo = await this.blobs.seal(full);
      const thumbnail = await this.blobs.seal(small);
      return { type: file.type, size: photo.size, ref: photo.ref, key: photo.key, thumbnail: thumbnail.ref, thumbnailKey: thumbnail.key };
    } finally {
      full.fill(0);
      small.fill(0);
    }
  }

  /** A photo (or its thumbnail) as a Blob, or null while it is still on its
   * way from the member's other device. */
  async photoBlob(photo, { thumbnail = false } = {}) {
    const opened = await this.blobs.open(thumbnail ? { ref: photo.thumbnail, key: photo.thumbnailKey } : { ref: photo.ref, key: photo.key });
    if (opened.pending) return null;
    try {
      return new Blob([opened.bytes], { type: thumbnail ? "image/jpeg" : photo.type });
    } finally {
      opened.bytes.fill(0);
    }
  }

  close() {
    this.unsubscribe?.();
    this.cache = null;
  }
}

function sameContent(entry, content) {
  return entry.date === content.date && entry.title === content.title && entry.body === content.body &&
    entry.photos.length === content.photos.length &&
    entry.photos.every((photo, index) => photo.ref === content.photos[index].ref && photo.key === content.photos[index].key &&
      photo.thumbnail === content.photos[index].thumbnail && photo.thumbnailKey === content.photos[index].thumbnailKey &&
      photo.type === content.photos[index].type && photo.size === content.photos[index].size);
}
