// <kin-photo-frame>: the family photo frame (#673, ADR 0022 §5). A
// slideshow of the household's album, one photo at a time, each with its
// caption and who added it. Built to be reused: Family photos shows it from
// its Slideshow button, and the kitchen display will host it as its
// screensaver after a quiet period.
//
// Give it `source = { photos, load }`:
// - `photos`: [{ photoId, caption, addedByLabel }] in the order to show;
// - `load(photo, { signal })`: resolves the photo's image as a Blob.
// Then call `start()`. It shows each photo for `interval` seconds (the
// attribute; 8 by default), loading the next one before it fades in over the
// last. With reduced motion there is no fade: the photo changes in place.
//
// - It pauses while the page is hidden (another tab, the screen off) and
//   picks up where it was when it shows again, and stops when removed.
// - Any tap, click or key (Escape too) asks to leave: it dispatches
//   "kin:photo-frame-exit" (bubbling) and the host closes it. That is how a
//   screensaver returns on touch. With the `controls` attribute it also
//   shows Pause and Close buttons, which keep their own presses (WCAG 2.2.2).
// - Object URLs are its own: at most the two photos on screen hold one, and
//   all are revoked when it stops.
//
// Only one image is announced at a time, as a region with a label; while it
// plays, its changes aren't announced (aria-live "off"), and while paused
// they are ("polite"), as in the WAI carousel pattern.

const DEFAULT_INTERVAL = 8;
const FADE_MS = 1200;

class KinPhotoFrame extends HTMLElement {
  static get observedAttributes() { return ["interval", "controls"]; }

  constructor() {
    super();
    this.source = null;
    this.index = -1;
    this.timer = 0;
    this.running = false;
    this.paused = false;
    this.layers = [];
    this.front = 0;
    this.urls = [null, null];
    this.loading = null;
    this.failures = 0;
    this.onVisibility = () => this.visibilityChanged();
  }

  connectedCallback() {
    if (!this.stage) this.build();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stop();
  }

  attributeChangedCallback(name) {
    if (name === "controls" && this.controlsBar) this.controlsBar.hidden = !this.hasAttribute("controls");
  }

  get interval() {
    const value = Number(this.getAttribute("interval"));
    return Number.isFinite(value) && value >= 3 ? value : DEFAULT_INTERVAL;
  }

  /** Whether motion is reduced: no fade, the photo changes in place. */
  get reducedMotion() {
    return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  build() {
    this.classList.add("photo-frame");
    this.setAttribute("role", "region");
    this.setAttribute("aria-roledescription", "slideshow");
    if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", "Family photos");
    // A host (the kitchen display's screensaver) can focus it, so a key
    // returns to Kin.
    if (!this.hasAttribute("tabindex")) this.tabIndex = -1;
    this.stage = document.createElement("div");
    this.stage.className = "photo-frame-stage";
    this.stage.setAttribute("aria-live", "off");
    for (let index = 0; index < 2; index += 1) {
      const figure = document.createElement("figure");
      figure.className = "photo-frame-slide";
      figure.setAttribute("aria-hidden", "true");
      const image = document.createElement("img");
      image.alt = "";
      image.decoding = "async";
      const caption = document.createElement("figcaption");
      caption.className = "photo-frame-caption";
      const text = document.createElement("span");
      text.className = "photo-frame-caption-text";
      const by = document.createElement("span");
      by.className = "photo-frame-added-by";
      caption.append(text, by);
      figure.append(image, caption);
      figure.image = image;
      figure.text = text;
      figure.by = by;
      this.layers.push(figure);
      this.stage.append(figure);
    }
    this.empty = document.createElement("p");
    this.empty.className = "photo-frame-empty";
    this.empty.hidden = true;
    this.controlsBar = document.createElement("div");
    this.controlsBar.className = "photo-frame-controls";
    this.controlsBar.hidden = !this.hasAttribute("controls");
    this.pauseButton = document.createElement("button");
    this.pauseButton.type = "button";
    this.pauseButton.className = "photo-frame-pause";
    this.pauseButton.textContent = "Pause";
    this.pauseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.paused) this.resume(); else this.pause();
    });
    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "photo-frame-close";
    this.closeButton.textContent = "Close";
    this.closeButton.addEventListener("click", (event) => { event.stopPropagation(); this.exit("close"); });
    this.controlsBar.append(this.pauseButton, this.closeButton);
    this.append(this.stage, this.empty, this.controlsBar);
    // Touch, a click or a key anywhere but the buttons: back to Kin.
    this.addEventListener("click", (event) => {
      if (event.target.closest?.(".photo-frame-controls")) return;
      this.exit("touch");
    });
    this.addEventListener("keydown", (event) => {
      if (event.target.closest?.(".photo-frame-controls") && event.key !== "Escape") return;
      if (["Tab", "Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      event.preventDefault();
      this.exit(event.key === "Escape" ? "escape" : "key");
    });
  }

  /** Starts (or restarts) the slideshow from the first photo. */
  start() {
    if (!this.stage) this.build();
    this.stop();
    this.running = true;
    this.paused = false;
    this.failures = 0;
    this.index = -1;
    this.updatePause();
    const photos = this.source?.photos ?? [];
    this.empty.hidden = photos.length > 0;
    this.empty.textContent = photos.length ? "" : "No family photos yet.";
    if (!photos.length) return;
    void this.advance();
  }

  /** Stops and lets go of every image. */
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = 0;
    this.loading?.abort();
    this.loading = null;
    for (let index = 0; index < this.urls.length; index += 1) this.release(index);
    for (const layer of this.layers) layer.classList.remove("is-showing");
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = 0;
    this.updatePause();
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.updatePause();
    this.schedule();
  }

  updatePause() {
    if (!this.pauseButton) return;
    this.pauseButton.textContent = this.paused ? "Play" : "Pause";
    this.pauseButton.setAttribute("aria-pressed", String(this.paused));
    this.stage.setAttribute("aria-live", this.paused ? "polite" : "off");
  }

  visibilityChanged() {
    if (!this.running) return;
    if (document.hidden) {
      clearTimeout(this.timer);
      this.timer = 0;
      this.loading?.abort();
    } else if (!this.paused) {
      this.schedule();
    }
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.running || this.paused || document.hidden) return;
    this.timer = setTimeout(() => void this.advance(), this.interval * 1000);
  }

  release(index) {
    if (this.urls[index]) URL.revokeObjectURL(this.urls[index]);
    this.urls[index] = null;
  }

  /** Loads the next photo into the hidden layer, then brings it forward. */
  async advance() {
    const photos = this.source?.photos ?? [];
    if (!this.running || !photos.length || document.hidden) return;
    const next = (this.index + 1) % photos.length;
    const photo = photos[next];
    const controller = new AbortController();
    this.loading?.abort();
    this.loading = controller;
    let blob;
    try {
      blob = await this.source.load(photo, { signal: controller.signal });
    } catch {
      blob = null;
    }
    if (controller.signal.aborted || !this.running) return;
    this.loading = null;
    this.index = next;
    if (!(blob instanceof Blob)) {
      // Skip what can't be shown; stop trying once none can.
      this.failures += 1;
      if (this.failures >= photos.length) {
        this.empty.hidden = false;
        this.empty.textContent = "These photos will show once this device has them.";
        return;
      }
      void this.advance();
      return;
    }
    this.failures = 0;
    const back = 1 - this.front;
    const layer = this.layers[back];
    this.release(back);
    this.urls[back] = URL.createObjectURL(blob);
    layer.image.src = this.urls[back];
    const label = photo.caption || "A family photo";
    layer.image.alt = `${label}${photo.addedByLabel ? `, added by ${photo.addedByLabel}` : ""}`;
    layer.text.textContent = photo.caption ?? "";
    layer.text.hidden = !photo.caption;
    layer.by.textContent = photo.addedByLabel ? `Added by ${photo.addedByLabel}` : "";
    try { await layer.image.decode?.(); } catch { /* shown as it loads */ }
    if (!this.running) return;
    const old = this.layers[this.front];
    layer.classList.add("is-showing");
    layer.removeAttribute("aria-hidden");
    old.classList.remove("is-showing");
    old.setAttribute("aria-hidden", "true");
    const previous = this.front;
    this.front = back;
    this.empty.hidden = true;
    // The old photo's URL goes once it has faded out (at once without motion).
    setTimeout(() => { if (this.front !== previous) this.release(previous); }, this.reducedMotion ? 0 : FADE_MS + 100);
    this.schedule();
  }

  exit(reason) {
    this.dispatchEvent(new CustomEvent("kin:photo-frame-exit", { bubbles: true, detail: { reason } }));
  }
}

if (!customElements.get("kin-photo-frame")) customElements.define("kin-photo-frame", KinPhotoFrame);
