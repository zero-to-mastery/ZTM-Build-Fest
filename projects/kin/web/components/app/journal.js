// The member's journal (#496, ADR 0019): the private log the sync
// coordinator opens once this device holds the member's vault key, the
// journal over it, its photos, and the <kin-journal> page.
// State stays on the element (`this.app`); app/context.js explains the controllers.
//
// Nothing here touches household state: entries never reach the household
// projection, household search, Today, chat or household exports.
import { routeHash } from "../../routes.js";
import { Journal, JournalError } from "../../private/journal.js";
import { todayCivilDate } from "../../private/journal-view.js";
import { PrivateBlobs, PrivateBlobStore } from "../../private/private-blobs.js";

const READY = new Set(["ready", "no_member_key"]);
const ACCOUNT = new Set(["no_vault", "no_vault_key", "locked"]);

export class JournalController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.log = null;
    this.journal = null;
    this.blobs = null;
    this.generation = 0;
    this.thumbnails = new Map();
    this.pendingOpen = null;
  }

  /** The coordinator's private log, or null when it closed. */
  async setLog(log) {
    if (log === this.log) return;
    this.close();
    const generation = ++this.generation;
    this.log = log;
    if (!log) { this.render(); return; }
    try {
      const store = await PrivateBlobStore.open(log.identity.householdId, log.identity.memberId);
      if (generation !== this.generation) { store.close(); return; }
      this.blobs = new PrivateBlobs({ store, householdId: log.identity.householdId, memberId: log.identity.memberId });
    } catch {
      // Photos can't be kept here; entries still work.
      this.blobs = null;
    }
    this.journal = new Journal({ log, engine: this.app.engine, blobs: this.blobs });
    this.unhook = log.onPass(async () => {
      if (!this.blobs) return;
      await this.blobs.sync();
      try { await this.blobs.store.prune(this.keptRefs()); } catch { /* a later pass tries again */ }
    });
    this.unsubscribe = log.subscribe(() => this.render());
    this.render();
    if (this.pendingOpen) {
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      void this.openNewEntry(pending);
    }
  }

  /** What the page shows: "ready" or why it can't. */
  status() {
    const kind = this.app.householdStatus?.memberKind;
    if (kind === "temporary") return "guest";
    const reason = this.journal?.reason ?? null;
    if (!reason) return "account";
    if (READY.has(reason)) return "ready";
    if (reason === "off") return kind === "limited" ? "off" : "guest";
    if (ACCOUNT.has(reason)) return "account";
    return "unreachable";
  }

  entries() {
    try { return this.journal?.entries() ?? []; } catch { return []; }
  }

  render() {
    const page = this.app.journal;
    if (!page) return;
    page.services ??= this.services();
    page.update({ status: this.status(), entries: this.entries(), today: todayCivilDate() });
  }

  /** Every blob a live entry names, kept in this device's cache. */
  keptRefs() {
    return new Set(this.entries().flatMap((entry) => entry.photos.flatMap((photo) => [photo.ref, photo.thumbnail])));
  }

  services() {
    return {
      save: (draft) => this.save(draft),
      remove: (entryId) => this.run(() => this.journal.remove(entryId), "Kin couldn't delete that entry. Try again."),
      restore: (entryId) => this.run(() => this.journal.restore(entryId), "Kin couldn't put that entry back."),
      addPhotos: (files) => this.addPhotos(files),
      thumbnail: (photo) => this.thumbnail(photo),
      view: (photo, opener) => void this.view(photo, opener),
      discard: (refs) => void this.blobs?.discard(refs).then(() => this.log?.onLocalChange?.()).catch(() => {}),
    };
  }

  async run(work, fallback) {
    if (!this.journal) return { ok: false, message: "Your journal isn't open on this device." };
    try {
      await work();
      this.afterWrite();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: this.messageFor(error, fallback) };
    }
  }

  messageFor(error, fallback) {
    if (error instanceof JournalError) return error.message;
    if (error?.code === 4) return "That entry changed on another of your devices. Check it and try again.";
    if (error?.code === 5) return "Your journal is full. Delete some older entries to write more.";
    if (error?.code === "private_key_unavailable" || error?.code === "private_locked") return "Your journal needs your Kin account on this device.";
    return fallback;
  }

  afterWrite() {
    this.render();
    void this.app.syncCoordinator?.syncNow();
  }

  async save({ entryId, ...draft }) {
    if (!this.journal) return { ok: false, message: "Your journal isn't open on this device." };
    try {
      if (entryId) {
        const changed = await this.journal.edit(entryId, draft);
        if (changed) this.afterWrite();
        return { ok: true, entryId, changed };
      }
      const created = await this.journal.create(draft);
      this.afterWrite();
      return { ok: true, entryId: created };
    } catch (error) {
      return { ok: false, message: this.messageFor(error, "Kin couldn't save that entry. Your draft is kept; try again.") };
    }
  }

  async addPhotos(files) {
    if (!this.journal || !this.blobs) return { photos: [], message: "Photos can't be kept on this device." };
    const photos = [];
    for (const file of files) {
      try {
        photos.push(await this.journal.addPhoto(file));
      } catch (error) {
        return { photos, message: error instanceof JournalError ? error.message : "Kin couldn't add that photo." };
      }
    }
    return { photos };
  }

  /** A thumbnail's object URL (kept until lock), or null while the photo is
   * on its way from another of the member's devices. */
  async thumbnail(photo) {
    if (this.thumbnails.has(photo.thumbnail)) return this.thumbnails.get(photo.thumbnail);
    const blob = await this.journal?.photoBlob(photo, { thumbnail: true });
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.thumbnails.set(photo.thumbnail, url);
    return url;
  }

  async view(photo, opener) {
    try {
      const blob = await this.journal?.photoBlob(photo);
      if (!blob) { this.ctx.status.setStatus("That photo is still on its way from your other device."); return; }
      const extension = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
      this.ctx.attachments.viewBlob({ blob, name: `Journal photo.${extension}`, opener });
    } catch {
      this.ctx.status.showAlert("Kin couldn't open that photo.");
    }
  }

  /**
   * Opens a new entry, optionally with shared text and files (the share
   * sheet, #508) or from the home-screen shortcut (#509). Waits for the
   * journal to open if the private log isn't ready yet.
   */
  async openNewEntry({ text = "", files = [] } = {}) {
    this.ctx.navigation.navigate("#journal");
    if (this.status() !== "ready") {
      if (!this.journal) this.pendingOpen = { text, files };
      return { ok: false };
    }
    let photos = [];
    let message = null;
    if (files.length) ({ photos, message } = await this.addPhotos(files));
    setTimeout(() => {
      this.app.journal?.openEditor(null, null, { prefill: { body: text, photos } });
      if (message && this.app.journal?.message) this.app.journal.message.textContent = message;
    }, 0);
    return { ok: true };
  }

  /** The link the page's "unavailable" sentence offers. */
  get accountHash() {
    return routeHash("household", "people");
  }

  close() {
    this.unhook?.();
    this.unsubscribe?.();
    this.unhook = this.unsubscribe = null;
    this.journal?.close();
    this.journal = null;
    this.blobs?.close();
    this.blobs = null;
    for (const url of this.thumbnails.values()) URL.revokeObjectURL(url);
    this.thumbnails.clear();
  }

  /** Locking: nothing of the journal stays. */
  reset() {
    this.generation += 1;
    this.close();
    this.log = null;
    this.pendingOpen = null;
  }
}
