// Family photos (#673, ADR 0022 §5): reads the album from Rust while
// Household › Family photos or the slideshow is showing, adds photos (from
// the page, the share sheet or a chat photo), removes them with Undo, and
// opens their images for the grid, the viewer and the photo frame.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { AttachmentPreviewCache } from "../../attachments/attachment-preview.js";
import { albumKeep, captureAlbumPhoto, openAlbumPhoto } from "../../album/album-blobs.js";
import { openAlbumStore } from "../../album/album-session.js";
import { MAX_ALBUM_PHOTOS, canRemoveAlbumPhoto } from "../../wasm/kin-album.js";
import { albumRemovedEntry } from "../../undo.js";
import { assigneeLabel } from "../shared/assignee-label.js";
import { SAVE_ERROR } from "./constants.js";

const NONE = Object.freeze({ photos: Object.freeze([]), removed: Object.freeze([]) });

export class AlbumController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
    this.storeOpening = null;
  }

  showing() {
    const route = this.app.route;
    return (route?.page === "household" && route.segment === "photos") || Boolean(this.app.albumView?.frameOpen);
  }

  /** The album as last read: { photos, removed }, newest first. */
  get album() {
    return this.app.album ?? NONE;
  }

  /** This member's ID, whether they're an admin, and whether this household
   * syncs at all (a household that doesn't is its own admin). */
  who() {
    return {
      memberId: this.app.syncCoordinator?.identity?.memberId ?? null,
      admin: this.app.householdAdmin === true,
      local: !this.app.hasLocalSyncBinding,
    };
  }

  canRemove(photo) {
    return canRemoveAlbumPhoto(photo, this.who());
  }

  /** "You", a preferred name, or "Household member N". */
  addedBy(photo) {
    return assigneeLabel(photo?.addedBy ?? null, this.ctx.detail.responsibilityContext());
  }

  /** What the page shows. */
  view() {
    const photos = this.album.photos.map((photo) => ({ ...photo, addedByLabel: this.addedBy(photo), canRemove: this.canRemove(photo) }));
    return { photos, max: MAX_ALBUM_PHOTOS, canAdd: photos.length < MAX_ALBUM_PHOTOS, disabled: Boolean(this.app.busy) };
  }

  refresh({ force = false } = {}) {
    if ((!force && !this.showing()) || !this.app.store) return null;
    if (this.reading) { this.again = true; return this.reading; }
    const session = this.ctx.session.captureSession();
    this.reading = (async () => {
      try {
        const album = await session.store.album();
        if (!this.ctx.session.isCurrentSession(session)) return;
        this.app.album = album;
        this.app.albumView?.update(this.view());
      } catch {
        // The page keeps what it showed; the next render tries again.
      } finally {
        this.reading = null;
        if (this.again) { this.again = false; void this.refresh({ force }); }
      }
    })();
    return this.reading;
  }

  /** The state Undo checks album entries against (app/undo.js). */
  async undoState() {
    const album = await this.app.store.album();
    this.app.album = album;
    return { album, albumKeep: albumKeep(album) };
  }

  async albumStore(session = this.ctx.session.captureSession()) {
    if (this.app.albumStore) return this.app.albumStore;
    this.storeOpening ??= openAlbumStore(session.store).finally(() => { this.storeOpening = null; });
    const opened = await this.storeOpening;
    if (!this.ctx.session.isCurrentSession(session)) { opened?.close(); return null; }
    this.app.albumStore ??= opened;
    return this.app.albumStore;
  }

  /** The image of `photo`: { blob, name, type }. */
  async load(photo, { signal } = {}) {
    const session = this.ctx.session.captureSession();
    const albumStore = await this.albumStore(session);
    if (!albumStore) throw Object.assign(new Error("unavailable"), { userMessage: "Family photos aren't available on this device." });
    const opened = await openAlbumPhoto({
      photo, store: session.store, albumStore, signal,
      identity: this.app.syncCoordinator?.identity ?? null, keyStore: this.app.syncCoordinator?.keyStore ?? null,
    });
    this.ctx.session.assertCurrentSession(session);
    return opened;
  }

  /** A thumbnail ({ url } or null) for the grid; cached for the session. */
  thumbnail(photo) {
    this.app.albumPreviews ??= new AttachmentPreviewCache(async (record) => (await this.load(record)).blob);
    // A photo that couldn't load before (not downloaded yet) is tried again.
    const cache = this.app.albumPreviews;
    if (cache.entries.has(photo.attachmentId) && cache.entries.get(photo.attachmentId) === null) cache.forget(photo.attachmentId);
    // The cache knows records by attachment ID and type; album photos are
    // always images.
    return cache.get({ attachmentId: photo.attachmentId, type: "image/jpeg" });
  }

  /**
   * Adds photos: `entries` is [{ file, caption }]. They go one at a time, in
   * order; `onProgress(done, total)` follows along. Resolves `{ ok, added,
   * message }`.
   */
  async add(entries, { onProgress = () => {} } = {}) {
    if (!this.app.store || !this.app.engine || !this.app.vault || this.app.vault.locked)
      return { ok: false, added: 0, message: "Unlock Kin before adding photos." };
    if (!(await this.ctx.refresh.untilIdle()))
      return { ok: false, added: 0, message: "Kin is still saving another change. Try again in a moment." };
    const session = this.ctx.session.captureSession();
    const room = MAX_ALBUM_PHOTOS - this.album.photos.length;
    if (room < 1) return { ok: false, added: 0, message: `The family photos are full (${MAX_ALBUM_PHOTOS}). Remove some to add more.` };
    const chosen = entries.slice(0, room);
    let added = 0;
    let problem = null;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      const albumStore = await this.albumStore(session);
      for (const { file, caption } of chosen) {
        onProgress(added, chosen.length);
        try {
          await captureAlbumPhoto({
            file, caption, store: session.store, albumStore,
            identity: this.app.syncCoordinator?.identity ?? this.app.household?.identity ?? null,
            keyStore: this.app.syncCoordinator?.keyStore ?? null,
            append: (command) => this.ctx.append.appendCommand(command),
          });
          added += 1;
        } catch (error) {
          if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false, added, message: "Kin locked before the photos were saved." };
          problem = error.code === 4
            ? `The family photos are full (${MAX_ALBUM_PHOTOS}).`
            : error.userMessage ?? SAVE_ERROR;
          if (error.code === 4) break;
        }
      }
      onProgress(added, chosen.length);
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      await this.refresh({ force: true });
      void this.app.syncCoordinator?.syncNow();
      const skipped = entries.length - chosen.length;
      const saved = added === 1 ? "1 photo added." : `${added} photos added.`;
      const message = [
        added ? saved : "",
        problem ? `${added ? "Some couldn't be added: " : ""}${problem}` : "",
        skipped ? `${skipped} more didn't fit: the family photos hold ${MAX_ALBUM_PHOTOS}.` : "",
      ].filter(Boolean).join(" ");
      if (added) this.ctx.status.setStatus(message);
      return { ok: added > 0 && !problem && !skipped, added, message };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** Removes `photo`, offering Undo. Resolves `{ ok, message }`. */
  async remove(photo) {
    if (this.app.busy || !this.app.store || !this.app.engine) return { ok: false, message: "Kin is still saving another change. Try again in a moment." };
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      await this.ctx.append.appendCommand({ type: "remove-album-photo", photoId: photo.photoId });
      this.ctx.session.assertCurrentSession(session);
      this.app.albumPreviews?.forget(photo.attachmentId);
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      await this.refresh({ force: true });
      this.ctx.status.setStatus("Photo removed.");
      this.ctx.undo.record(albumRemovedEntry(photo));
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false, message: "Kin locked." };
      if (error.code === "forbidden") return { ok: false, message: error.userMessage };
      if (error.code === 4) {
        this.app.pendingRefresh = true;
        return { ok: false, message: "That photo was already removed, maybe on another device." };
      }
      return { ok: false, message: error.userMessage ?? SAVE_ERROR };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** Opens Family photos with the add dialog showing `files` (the share
   * sheet, a chat photo). `files` are Files or { name, type, load() }. */
  async offer(files, { opener = null } = {}) {
    if (!this.ctx.features.isOn("photos")) return;
    this.ctx.navigation.navigate("#household/photos");
    const loaded = [];
    for (const file of files) {
      try {
        const value = file instanceof Blob ? file : await file.load();
        if (value instanceof Blob && /^image\/(jpeg|png|webp)$/.test(value.type)) loaded.push(value instanceof File ? value : new File([value], file.name || "Photo", { type: value.type }));
      } catch { /* a file that can't be read is left out */ }
    }
    if (!loaded.length) { this.ctx.status.setStatus("There was no photo to add to the family photos."); return; }
    await this.refresh({ force: true });
    this.app.albumView?.openAdd(loaded, { opener });
  }

  /** Lock or household exit: nothing decrypted stays reachable. */
  clear() {
    this.app.albumView?.closeAll();
    this.app.albumPreviews?.clear();
    this.app.albumPreviews = null;
    this.app.albumStore?.close();
    this.app.albumStore = null;
    this.app.album = null;
  }
}
