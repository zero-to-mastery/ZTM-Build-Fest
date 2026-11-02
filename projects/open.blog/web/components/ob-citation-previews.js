// <ob-citation-previews> shows a preview of the cited source next to each
// citation marker of a post that publishes citations (ADR 0061). The page is
// complete without it: every marker stays a link to its note, and the notes
// are the references.
//
// The preview shows only the page's own reference data, the
// <script type="application/json" id="ob-references"> element (ADR 0059), and
// only as text. Its one outside link is the data's `link`, checked again here
// to be a plain http(s) address. Nothing is fetched and nothing is stored.
//
// Keyboard: focusing a marker opens its preview and describes the marker with
// it; Tab continues into the preview's links, which follow the marker in the
// page; Escape closes it and returns focus to the marker. Pointer: hovering a
// marker opens it, leaving both closes it, a click still follows the link.
// Touch: the first tap opens the preview, which links to the note; a second
// tap on the marker follows it. Only a click ending a touch press on the
// marker is a tap, so Enter and assistive technology always follow the link.
// Pressing or focusing anything else closes it.

export const DATA_ELEMENT_ID = "ob-references";
export const SUPPORTED_VERSION = 1;
// Far beyond any post's data; anything larger is not read at all.
const MAX_DATA_LENGTH = 1_000_000;
const OPEN_DELAY = 250;
const CLOSE_DELAY = 300;
// Kept clear of the viewport's edges, in CSS pixels.
const GUTTER = 8;
const GAP = 4;

const isText = (value) => typeof value === "string";

/** A safe outside link: an absolute http(s) address with a host and no credentials, else null. */
export function safeLink(value) {
  if (!isText(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.href;
}

/**
 * The page's reference data as one preview per marker id, or null when there
 * is none, it cannot be read, or its version is newer than this component
 * knows. Each citation is checked on its own, so a malformed entry loses only
 * its own preview.
 */
export function readReferences(text) {
  if (!isText(text) || text.length > MAX_DATA_LENGTH) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.version !== SUPPORTED_VERSION) return null;
  if (!Array.isArray(data.references) || !Array.isArray(data.citations)) return null;
  const references = new Map();
  for (const reference of data.references) {
    if (!reference || !isText(reference.id) || !isText(reference.formatted)) continue;
    if (references.has(reference.id)) continue;
    references.set(reference.id, { text: reference.formatted, link: safeLink(reference.link) });
  }
  const previews = new Map();
  for (const citation of data.citations) {
    if (!citation || !isText(citation.marker) || !isText(citation.note)) continue;
    if (!citation.marker || !citation.note || previews.has(citation.marker)) continue;
    const reference = references.get(citation.reference);
    if (!reference) continue;
    previews.set(citation.marker, {
      note: citation.note,
      text: reference.text,
      locators: isText(citation.formatted) ? citation.formatted : "",
      link: reference.link,
    });
  }
  return previews;
}

let instances = 0;

export class ObCitationPreviews extends HTMLElement {
  connectedCallback() {
    if (this.controller) return;
    const previews = readReferences(document.getElementById(DATA_ELEMENT_ID)?.textContent);
    if (!previews) return;
    const controller = new AbortController();
    const { signal } = controller;
    this.markers = new Map();
    for (const [id, preview] of previews) {
      const marker = document.getElementById(id);
      // Only a marker that is still a link to its own note is enhanced.
      if (!marker || marker.localName !== "a" || marker.getAttribute("href") !== `#${preview.note}`) continue;
      this.markers.set(marker, preview);
      marker.addEventListener("focus", () => {
        if (!this.returning) this.open(marker);
      }, { signal });
      marker.addEventListener("pointerenter", (event) => this.hover(marker, event), { signal });
      marker.addEventListener("pointerleave", (event) => this.leave(event), { signal });
      marker.addEventListener("pointerdown", (event) => this.press(marker, event), { signal });
      // A press that the browser takes back, or focus that moves away, ends it.
      marker.addEventListener("pointercancel", () => (this.pressed = null), { signal });
      marker.addEventListener("blur", () => (this.pressed = null), { signal });
      marker.addEventListener("click", (event) => this.activate(marker, event), { signal });
    }
    if (!this.markers.size) {
      this.markers = null;
      return;
    }
    this.controller = controller;
    instances += 1;
    this.panel = this.build(`ob-citation-preview-${instances}`, signal);
    document.addEventListener("keydown", (event) => this.keydown(event), { signal });
    document.addEventListener("pointerdown", (event) => this.outside(event), { signal });
    document.addEventListener("focusin", (event) => this.outside(event), { signal });
    window.addEventListener("resize", () => this.place(), { signal });
  }

  disconnectedCallback() {
    this.close();
    this.controller?.abort();
    this.controller = null;
    this.panel?.remove();
    this.panel = null;
    this.markers = null;
    this.pressed = null;
  }

  /**
   * The one preview element, moved next to whichever marker it describes. It
   * is kept as `panel`: `popover` is HTMLElement's own attribute and would
   * turn the element into a string.
   */
  build(id, signal) {
    const panel = document.createElement("span");
    panel.className = "ob-citation-preview";
    panel.id = id;
    panel.setAttribute("role", "group");
    panel.hidden = true;
    const details = document.createElement("span");
    details.className = "ob-citation-preview-details";
    details.id = `${id}-details`;
    this.reference = document.createElement("span");
    this.reference.className = "ob-citation-preview-reference";
    this.locators = document.createElement("span");
    this.locators.className = "ob-citation-preview-locators";
    details.append(this.reference, this.locators);
    this.links = document.createElement("span");
    this.links.className = "ob-citation-preview-links";
    panel.append(details, this.links);
    this.details = details;
    panel.addEventListener("pointerenter", () => clearTimeout(this.closeTimer), { signal });
    panel.addEventListener("pointerleave", (event) => this.leave(event), { signal });
    return panel;
  }

  isOpen(marker) {
    return Boolean(this.panel && !this.panel.hidden && this.current === marker);
  }

  /** Whether keyboard focus is on the open preview's marker or inside the preview. */
  focused() {
    const active = document.activeElement;
    return Boolean(active && (active === this.current || this.panel?.contains(active)));
  }

  open(marker) {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    const preview = this.markers?.get(marker);
    if (!preview || this.isOpen(marker)) return;
    this.close();
    this.fill(marker, preview);
    const sup = marker.parentElement;
    (sup && sup.localName === "sup" ? sup : marker).after(this.panel);
    this.panel.hidden = false;
    this.current = marker;
    const described = (marker.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!described.includes(this.details.id)) described.push(this.details.id);
    marker.setAttribute("aria-describedby", described.join(" "));
    this.place();
  }

  close() {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    const marker = this.current;
    if (!marker) return;
    this.current = null;
    if (this.panel) this.panel.hidden = true;
    const described = (marker.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((token) => token && token !== this.details?.id);
    if (described.length) marker.setAttribute("aria-describedby", described.join(" "));
    else marker.removeAttribute("aria-describedby");
  }

  /** The preview's text, every value assigned as text, and its links. */
  fill(marker, preview) {
    this.panel.setAttribute("aria-labelledby", marker.id);
    this.reference.textContent = preview.text;
    this.locators.textContent = preview.locators;
    this.locators.hidden = !preview.locators;
    const links = [];
    if (preview.link) {
      const source = document.createElement("a");
      source.className = "ob-citation-preview-source";
      source.href = preview.link;
      source.rel = "noreferrer";
      source.textContent = preview.link;
      links.push(source);
    }
    const words = this.getAttribute("note-label");
    if (words) {
      const note = document.createElement("a");
      note.className = "ob-citation-preview-note";
      note.href = `#${preview.note}`;
      note.textContent = words;
      links.push(note);
    }
    this.links.replaceChildren(...links);
    this.links.hidden = !links.length;
  }

  /**
   * Below the marker, or above it when only that fits, and inside the
   * viewport's width, which also bounds its own width. The width and offsets
   * are custom properties set through the CSS object model, which the page's
   * style policy allows.
   */
  place() {
    if (!this.current || !this.panel || this.panel.hidden) return;
    const style = this.panel.style;
    const view = document.documentElement;
    // The layout viewport without a classic scrollbar, unlike `100vw`.
    const width = view.clientWidth;
    const height = view.clientHeight;
    style.setProperty("--ob-citation-preview-max-inline-size", `${Math.max(0, width - 2 * GUTTER)}px`);
    style.setProperty("--ob-citation-preview-x", "0px");
    style.setProperty("--ob-citation-preview-y", "0px");
    const box = this.panel.getBoundingClientRect();
    const mark = this.current.getBoundingClientRect();
    let left = Math.min(mark.left, width - GUTTER - box.width);
    left = Math.max(left, GUTTER);
    let top = mark.bottom + GAP;
    let side = "below";
    if (top + box.height > height - GUTTER && mark.top - GAP - box.height >= GUTTER) {
      top = mark.top - GAP - box.height;
      side = "above";
    }
    this.panel.dataset.side = side;
    style.setProperty("--ob-citation-preview-x", `${Math.round(left - box.left)}px`);
    style.setProperty("--ob-citation-preview-y", `${Math.round(top - box.top)}px`);
  }

  hover(marker, event) {
    if (event.pointerType === "touch") return;
    clearTimeout(this.closeTimer);
    if (this.isOpen(marker)) return;
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => this.open(marker), OPEN_DELAY);
  }

  leave(event) {
    if (event.pointerType === "touch") return;
    clearTimeout(this.openTimer);
    if (!this.current) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (!this.focused()) this.close();
    }, CLOSE_DELAY);
  }

  /**
   * Remembers a primary touch press on a marker, and whether its preview was
   * already open, for the click that follows it. Any other press forgets it.
   */
  press(marker, event) {
    this.pressed =
      event.pointerType === "touch" && event.isPrimary !== false
        ? { marker, wasOpen: this.isOpen(marker) }
        : null;
  }

  /**
   * A first tap opens the preview; any other activation follows the link. A
   * first tap is only a click that ends a touch press on the same marker
   * whose preview was closed. A click with `detail` 0 (Enter, a script, or
   * assistive technology activating the link) or with no touch press before
   * it always follows the link.
   */
  activate(marker, event) {
    const pressed = this.pressed;
    this.pressed = null;
    const firstTap = Boolean(pressed) && pressed.marker === marker && !pressed.wasOpen && event.detail !== 0;
    if (firstTap) {
      event.preventDefault();
      this.open(marker);
    } else {
      this.close();
    }
  }

  keydown(event) {
    if (event.key !== "Escape" || !this.current) return;
    const marker = this.current;
    const inside = this.panel.contains(document.activeElement);
    this.close();
    if (!inside) return;
    // Focus goes back to the marker without opening the preview again.
    this.returning = true;
    try {
      marker.focus();
    } finally {
      this.returning = false;
    }
  }

  /** Pressing or focusing anything but the open preview and its marker closes it. */
  outside(event) {
    const target = event.target;
    if (this.pressed && event.type === "pointerdown" && !this.pressed.marker.contains?.(target)) {
      this.pressed = null;
    }
    if (!this.current) return;
    if (target === this.current || this.current.contains?.(target) || this.panel.contains(target)) return;
    this.close();
  }
}

if (!customElements.get("ob-citation-previews")) {
  customElements.define("ob-citation-previews", ObCitationPreviews);
}
