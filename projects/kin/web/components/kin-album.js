// <kin-album>: Household › Family photos (#673, ADR 0022 §5). A grid of the
// household's photos, newest first; Add photos (several at once, each with
// an optional caption); a viewer with Previous, Next and Remove; and
// Slideshow, which shows the album in <kin-photo-frame>.
//
// Its `controller` (components/app/album.js) does the work: `add(entries,
// { onProgress })`, `remove(photo)`, `load(photo)` and `thumbnail(photo)`.
// The host calls `update(view)` with { photos, max, canAdd, disabled }, each
// photo carrying `addedByLabel` and `canRemove`.
//
// Pickers are temporary file inputs, made for each tap and removed after:
// the app keeps a single persistent file input for attachments.
import "./kin-photo-frame.js";
import { MAX_ALBUM_CAPTION_BYTES } from "../wasm/kin-album.js";

const encoder = new TextEncoder();
const NO_PHOTOS = Object.freeze([]);
const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });

const button = (text, className, onClick) => {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  if (className) element.className = className;
  element.addEventListener("click", onClick);
  return element;
};

/** How a photo is named to assistive technology and in the viewer. */
export function photoLabel(photo) {
  const what = photo.caption ? `“${photo.caption}”` : "Photo";
  return photo.addedByLabel ? `${what}, added by ${photo.addedByLabel}` : what;
}

class KinAlbum extends HTMLElement {
  constructor() {
    super();
    this.controller = null;
    this.view = { photos: NO_PHOTOS, max: 500, canAdd: true, disabled: false };
    this.tiles = new Map();
    this.adding = [];
    this.viewerIndex = -1;
    this.viewerUrl = null;
    this.viewerLoad = 0;
  }

  connectedCallback() {
    if (this.grid) return;
    const section = document.createElement("section");
    section.className = "today-section album-section";
    section.setAttribute("aria-labelledby", "album-heading");
    const heading = document.createElement("h2");
    heading.id = "album-heading";
    heading.textContent = "Family photos";
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Photos for everyone in your household to enjoy, and for the slideshow. They are encrypted on your devices like everything else in Kin.";
    this.count = document.createElement("p");
    this.count.className = "album-count";
    const actions = document.createElement("div");
    actions.className = "album-actions";
    this.addButton = button("Add photos", "primary-action album-add", () => this.choose());
    this.slideshowButton = button("Slideshow", "album-slideshow-button", () => this.openSlideshow());
    actions.append(this.addButton, this.slideshowButton);
    this.feedback = document.createElement("p");
    this.feedback.className = "album-feedback";
    this.feedback.setAttribute("role", "status");
    this.empty = document.createElement("p");
    this.empty.className = "album-empty";
    this.empty.textContent = "No family photos yet. Add some from this phone or computer, share photos into Kin from another app, or add one from Chat.";
    this.grid = document.createElement("ul");
    this.grid.className = "album-grid";
    this.grid.setAttribute("aria-labelledby", "album-heading");
    section.append(heading, hint, this.count, actions, this.feedback, this.empty, this.grid);
    this.append(section, this.buildAddDialog(), this.buildViewer(), this.buildSlideshow());
    this.observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) { this.observer.unobserve(entry.target); this.loadThumb(entry.target); }
      }, { rootMargin: "200px" })
      : null;
    this.render();
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.closeAll();
  }

  /** Whether the slideshow is on screen (the controller keeps reading). */
  get frameOpen() {
    return Boolean(this.slideshow?.open);
  }

  update(view) {
    this.view = { ...this.view, ...view };
    if (this.grid) this.render();
  }

  render() {
    const { photos, max, canAdd, disabled } = this.view;
    this.count.textContent = photos.length === 1 ? `1 photo (up to ${max})` : `${photos.length} photos (up to ${max})`;
    this.addButton.disabled = disabled || !canAdd;
    this.addButton.title = canAdd ? "" : `The family photos are full (${max}). Remove some to add more.`;
    this.slideshowButton.disabled = photos.length === 0;
    this.empty.hidden = photos.length > 0;
    const keep = new Set();
    let cursor = this.grid.firstElementChild;
    for (const photo of photos) {
      keep.add(photo.photoId);
      let tile = this.tiles.get(photo.photoId);
      if (!tile) {
        tile = this.tile(photo);
        this.tiles.set(photo.photoId, tile);
      } else this.label(tile, photo);
      if (tile !== cursor) this.grid.insertBefore(tile, cursor);
      else cursor = cursor.nextElementSibling;
    }
    for (const [photoId, tile] of this.tiles) {
      if (keep.has(photoId)) continue;
      this.observer?.unobserve(tile);
      tile.remove();
      this.tiles.delete(photoId);
    }
    if (this.viewer?.open) this.showViewer(this.viewerPhoto ? photos.findIndex((photo) => photo.photoId === this.viewerPhoto.photoId) : -1, { keepFocus: true });
  }

  tile(photo) {
    const item = document.createElement("li");
    item.className = "album-tile";
    item.dataset.photoId = photo.photoId;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "album-thumb";
    open.dataset.photoId = photo.photoId;
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.hidden = true;
    const placeholder = document.createElement("span");
    placeholder.className = "album-thumb-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = "🖼";
    open.append(placeholder, image);
    open.addEventListener("click", () => this.showViewer(this.view.photos.findIndex((entry) => entry.photoId === item.dataset.photoId), { opener: open }));
    const caption = document.createElement("p");
    caption.className = "album-tile-caption";
    caption.setAttribute("aria-hidden", "true");
    item.append(open, caption);
    item.open = open;
    item.image = image;
    item.placeholder = placeholder;
    item.caption = caption;
    item.photo = photo;
    this.label(item, photo);
    if (this.observer) this.observer.observe(item);
    else this.loadThumb(item);
    return item;
  }

  label(tile, photo) {
    tile.photo = photo;
    tile.open.setAttribute("aria-label", `Open ${photoLabel(photo)}`);
    tile.caption.textContent = photo.caption ?? "";
    tile.caption.hidden = !photo.caption;
  }

  async loadThumb(tile) {
    let preview = null;
    try { preview = await this.controller?.thumbnail(tile.photo); } catch { /* the placeholder stays */ }
    if (!preview?.url || !tile.isConnected) return;
    tile.image.src = preview.url;
    tile.image.hidden = false;
    tile.placeholder.hidden = true;
  }

  // ---- Adding ------------------------------------------------------------

  /** Opens the system picker with a temporary input (several photos). */
  choose() {
    if (this.addButton.disabled) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.multiple = true;
    input.hidden = true;
    input.className = "album-picker";
    const done = () => input.remove();
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      done();
      if (files.length) this.openAdd(files, { opener: this.addButton });
    });
    input.addEventListener("cancel", done);
    this.append(input);
    input.click();
  }

  buildAddDialog() {
    this.addDialog = document.createElement("dialog");
    this.addDialog.className = "album-add-dialog quick-add-dialog";
    this.addDialog.setAttribute("aria-labelledby", "album-add-title");
    const title = document.createElement("h2");
    title.id = "album-add-title";
    title.textContent = "Add to family photos";
    const hint = document.createElement("p");
    hint.className = "quick-add-hint";
    hint.textContent = "Everyone in your household will see these. A caption is optional.";
    this.addList = document.createElement("ul");
    this.addList.className = "album-add-list";
    this.addMessage = document.createElement("p");
    this.addMessage.className = "compose-message";
    this.addMessage.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "album-add-actions";
    this.addSubmit = button("Add", "primary-action album-add-submit", () => void this.submitAdd());
    this.addCancel = button("Cancel", "album-add-cancel", () => this.closeAdd());
    actions.append(this.addSubmit, this.addCancel);
    this.addDialog.append(title, hint, this.addList, this.addMessage, actions);
    // Closing releases the photos at once, never later from the close
    // event: a dialog opened again meanwhile (a chat photo right after a
    // shared one) keeps its own.
    this.addDialog.addEventListener("cancel", (event) => { event.preventDefault(); this.closeAdd(); });
    return this.addDialog;
  }

  /** Shows the add dialog for `files` (from the picker, the share sheet or a
   * chat photo). */
  openAdd(files, { opener = null } = {}) {
    if (!this.addDialog) this.connectedCallback();
    this.closeAdd({ restoreFocus: false });
    this.addOpener = opener ?? (this.contains(document.activeElement) ? document.activeElement : this.addButton);
    this.adding = files.slice(0, 50).map((file, index) => ({ file, url: URL.createObjectURL(file), index }));
    this.addList.replaceChildren(...this.adding.map((entry) => {
      const item = document.createElement("li");
      item.className = "album-add-row";
      const image = document.createElement("img");
      image.src = entry.url;
      image.alt = "";
      const label = document.createElement("label");
      const id = `album-caption-${entry.index}`;
      label.htmlFor = id;
      label.textContent = this.adding.length === 1 ? "Caption (optional)" : `Caption for photo ${entry.index + 1} (optional)`;
      const input = document.createElement("input");
      input.id = id;
      input.type = "text";
      input.maxLength = MAX_ALBUM_CAPTION_BYTES;
      input.autocomplete = "off";
      input.className = "album-caption-input";
      input.placeholder = "Grandma's 80th";
      entry.input = input;
      const fields = document.createElement("div");
      fields.className = "album-add-fields";
      fields.append(label, input);
      item.append(image, fields);
      return item;
    }));
    const skipped = files.length - this.adding.length;
    this.addMessage.textContent = skipped ? `${skipped} more weren't included: add up to 50 at a time.` : "";
    this.addSubmit.textContent = this.adding.length === 1 ? "Add 1 photo" : `Add ${this.adding.length} photos`;
    this.addSubmit.disabled = false;
    this.addDialog.showModal();
    this.adding[0]?.input.focus();
  }

  async submitAdd() {
    if (!this.controller || !this.adding.length || this.addSubmit.disabled) return;
    for (const entry of this.adding) {
      if (encoder.encode(entry.input.value.trim()).length > MAX_ALBUM_CAPTION_BYTES) {
        this.addMessage.textContent = "A caption can be up to 200 characters.";
        entry.input.focus();
        return;
      }
    }
    const entries = this.adding.map((entry) => ({ file: entry.file, caption: entry.input.value }));
    this.addSubmit.disabled = true;
    this.addMessage.textContent = entries.length === 1 ? "Adding the photo…" : `Adding ${entries.length} photos…`;
    const result = await this.controller.add(entries, {
      onProgress: (done, total) => { if (total > 1 && done < total) this.addMessage.textContent = `Adding photo ${done + 1} of ${total}…`; },
    });
    if (result.added > 0 && result.ok) {
      this.closeAdd();
      this.feedback.textContent = result.message;
      return;
    }
    this.addMessage.textContent = result.message;
    if (result.added > 0) {
      this.feedback.textContent = result.message;
      this.addSubmit.textContent = "Done";
      this.addSubmit.disabled = false;
      this.adding = [];
      this.addSubmit.onclick = () => this.closeAdd();
      return;
    }
    this.addSubmit.disabled = false;
  }

  /** Closes the add dialog and lets go of its photos; focus goes back to
   * whatever opened it. */
  closeAdd({ restoreFocus = true } = {}) {
    if (this.addDialog.open) this.addDialog.close();
    for (const entry of this.adding) URL.revokeObjectURL(entry.url);
    this.adding = [];
    this.addList.replaceChildren();
    this.addSubmit.onclick = null;
    const opener = this.addOpener;
    this.addOpener = null;
    if (restoreFocus && opener?.isConnected) opener.focus();
  }

  // ---- Viewer ------------------------------------------------------------

  buildViewer() {
    this.viewer = document.createElement("dialog");
    this.viewer.className = "album-viewer attachment-viewer";
    this.viewer.setAttribute("aria-labelledby", "album-viewer-title");
    const bar = document.createElement("div");
    bar.className = "attachment-viewer-bar";
    this.viewerTitle = document.createElement("h2");
    this.viewerTitle.id = "album-viewer-title";
    const close = button("Close", "attachment-viewer-close album-viewer-close", () => this.viewer.close());
    bar.append(this.viewerTitle, close);
    const figure = document.createElement("div");
    figure.className = "attachment-viewer-figure";
    this.viewerImage = document.createElement("img");
    this.viewerImage.alt = "";
    this.viewerImage.decoding = "async";
    this.viewerStatus = document.createElement("p");
    this.viewerStatus.className = "album-viewer-status";
    this.viewerStatus.setAttribute("role", "status");
    figure.append(this.viewerImage, this.viewerStatus);
    this.viewerMeta = document.createElement("p");
    this.viewerMeta.className = "album-viewer-meta";
    const actions = document.createElement("div");
    actions.className = "attachment-viewer-actions album-viewer-actions";
    this.previousButton = button("Previous", "album-previous", () => this.showViewer(this.viewerIndex - 1, { keepFocus: true }));
    this.nextButton = button("Next", "album-next", () => this.showViewer(this.viewerIndex + 1, { keepFocus: true }));
    this.removeButton = button("Remove", "album-remove destructive", () => void this.removeShown());
    actions.append(this.previousButton, this.nextButton, this.removeButton);
    this.viewer.append(bar, figure, this.viewerMeta, actions);
    this.viewer.addEventListener("keydown", (event) => {
      if (event.target.closest?.("input, textarea")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); this.previousButton.click(); }
      if (event.key === "ArrowRight") { event.preventDefault(); this.nextButton.click(); }
    });
    this.viewer.addEventListener("close", () => this.releaseViewer());
    this.viewer.addEventListener("click", (event) => { if (event.target === this.viewer) this.viewer.close(); });
    return this.viewer;
  }

  /** Shows photo `index` in the viewer (closing it when there is none). */
  showViewer(index, { opener = null, keepFocus = false } = {}) {
    const photos = this.view.photos;
    if (!photos.length || index < 0) { if (this.viewer.open) this.viewer.close(); return; }
    index = Math.min(index, photos.length - 1);
    const photo = photos[index];
    const changed = this.viewerPhoto?.photoId !== photo.photoId;
    this.viewerIndex = index;
    this.viewerPhoto = photo;
    this.viewerTitle.textContent = photo.caption || "Family photo";
    const when = Number.isSafeInteger(photo.addedAt) ? dateFormat.format(new Date(photo.addedAt)) : "";
    this.viewerMeta.textContent = [photo.addedByLabel ? `Added by ${photo.addedByLabel}` : "", when].filter(Boolean).join(" · ");
    this.previousButton.disabled = index === 0;
    this.nextButton.disabled = index === photos.length - 1;
    this.removeButton.hidden = !photo.canRemove;
    this.removeButton.disabled = Boolean(this.view.disabled);
    this.removeButton.setAttribute("aria-label", `Remove ${photoLabel(photo)}`);
    if (!this.viewer.open) {
      this.viewerOpener = opener ?? (this.contains(document.activeElement) ? document.activeElement : null);
      this.viewer.showModal();
      if (!keepFocus) this.viewer.querySelector(".album-viewer-close")?.focus();
    }
    if (!changed && this.viewerImage.src) return;
    const load = ++this.viewerLoad;
    this.viewerImage.removeAttribute("src");
    this.viewerImage.alt = photoLabel(photo);
    this.viewerStatus.textContent = "Opening the photo…";
    void this.controller?.load(photo).then(({ blob }) => {
      if (load !== this.viewerLoad || !this.viewer.open) return;
      if (this.viewerUrl) URL.revokeObjectURL(this.viewerUrl);
      this.viewerUrl = URL.createObjectURL(blob);
      this.viewerImage.src = this.viewerUrl;
      this.viewerStatus.textContent = "";
    }, (error) => {
      if (load !== this.viewerLoad) return;
      this.viewerStatus.textContent = error?.userMessage ?? "This photo couldn't be opened.";
    });
  }

  async removeShown() {
    const photo = this.viewerPhoto;
    if (!photo || !this.controller) return;
    this.removeButton.disabled = true;
    const index = this.viewerIndex;
    const result = await this.controller.remove(photo);
    if (!result.ok) {
      this.viewerStatus.textContent = result.message;
      this.removeButton.disabled = false;
      return;
    }
    // Focus goes to the photo now in its place in the grid, or Add photos.
    this.viewerOpener = null;
    this.viewer.close();
    const photos = this.view.photos;
    const next = photos[Math.min(index, photos.length - 1)];
    (next ? this.tiles.get(next.photoId)?.open : this.addButton)?.focus();
  }

  releaseViewer() {
    this.viewerLoad += 1;
    if (this.viewerUrl) URL.revokeObjectURL(this.viewerUrl);
    this.viewerUrl = null;
    this.viewerImage.removeAttribute("src");
    this.viewerPhoto = null;
    this.viewerIndex = -1;
    const opener = this.viewerOpener;
    this.viewerOpener = null;
    if (opener?.isConnected) opener.focus();
  }

  // ---- Slideshow ---------------------------------------------------------

  buildSlideshow() {
    this.slideshow = document.createElement("dialog");
    this.slideshow.className = "album-slideshow";
    this.slideshow.setAttribute("aria-label", "Slideshow of family photos");
    this.frame = document.createElement("kin-photo-frame");
    this.frame.setAttribute("controls", "");
    // The close event comes a moment later; focus goes back at once.
    this.frame.addEventListener("kin:photo-frame-exit", () => {
      this.slideshow.close();
      this.frame.stop();
      if (this.slideshowButton.isConnected) this.slideshowButton.focus();
    });
    this.slideshow.append(this.frame);
    this.slideshow.addEventListener("close", () => {
      this.frame.stop();
      if (this.slideshowButton.isConnected) this.slideshowButton.focus();
    });
    return this.slideshow;
  }

  openSlideshow() {
    if (!this.view.photos.length || !this.controller) return;
    this.frame.source = { photos: this.view.photos, load: async (photo, { signal } = {}) => (await this.controller.load(photo, { signal })).blob };
    this.slideshow.showModal();
    this.frame.start();
    this.frame.querySelector(".photo-frame-pause")?.focus();
  }

  /** Lock or leaving: every dialog closes and its images go. */
  closeAll() {
    if (this.addDialog) this.closeAdd({ restoreFocus: false });
    for (const dialog of [this.viewer, this.slideshow]) if (dialog?.open) dialog.close();
    this.frame?.stop();
    for (const tile of this.tiles.values()) { tile.image.removeAttribute("src"); tile.image.hidden = true; tile.placeholder.hidden = false; }
    this.tiles.clear();
    this.grid?.replaceChildren();
    this.view = { ...this.view, photos: NO_PHOTOS };
  }
}

if (!customElements.get("kin-album")) customElements.define("kin-album", KinAlbum);
