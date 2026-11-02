// <ob-concept-previews> shows a short preview of the Knowledge Atlas entry that
// each concept link of a post leads to (ADR 0174). The page is complete without
// it: every concept link is an ordinary link to the entry's own static page,
// and the preview only adds the entry's type, its approved summary, where it
// comes from and how firmly the relationships around it are held.
//
// The preview reads one file, the site's own atlas-query.json (ADR 0168,
// 0171), the public projection of the approved atlas, and shows only fields
// that file already publishes, as text. Nothing the page holds, and nothing
// private, is read; no wording is rebuilt here (kindLabel, assertedByText,
// confidenceText and the rest are the page's own wording); nothing is stored.
// The file is fetched once, from the site's own origin, at the first sign of
// interest in a link (focus, hover or a press), never on load or when the page
// is idle, so reading a post costs nothing extra (on a touch screen, which has
// no hover, a link scrolling into view is the interest, but only when the
// file is small: the page says its size in `data-bytes`, and at 256 KiB or
// more, or with no size, a touch screen waits for the first tap). The page names the file with
// its content hash, so a changed atlas is never read from a stale cache. If it
// cannot be fetched or read, nothing changes: the links stay links. A reader
// whose focus arrived before the file did hears one polite announcement of the
// entry's type and summary when it is ready, and the link is then described by
// the preview as usual.
//
// Keyboard, pointer and touch behave exactly as the citation previews do
// (ADR 0061). Focusing a link opens its preview and describes the link with it;
// Tab continues into the preview's link, which follows the concept link in
// the page; there is no focus trap; Escape closes it and returns focus to the
// link. Hovering opens it, leaving both closes it, a click follows the link.
// The first tap on a touch screen opens it (when the file has loaded) and a
// second follows the link; Enter and assistive technology always follow the
// link. Pressing or focusing anything else closes it. Opening a preview never
// scrolls the page.

export const SUPPORTED_FORMAT = "openblog-atlas-query";
export const SUPPORTED_VERSION = 1;
// The projection's own bound is 4 MiB; anything larger is not read at all.
export const MAX_QUERY_LENGTH = 5_000_000;
/** How many relationships a preview lists; the entry's page has them all. */
export const MAX_RELATIONSHIPS = 2;
/** How many evidence references one listed relationship shows. */
export const MAX_EVIDENCE = 2;
const OPEN_DELAY = 250;
const CLOSE_DELAY = 300;
// Kept clear of the viewport's edges, in CSS pixels.
const GUTTER = 8;
const GAP = 4;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isText = (value) => typeof value === "string";
const text = (value) => (isText(value) ? value : "");
const ownList = (value) => (Array.isArray(value) ? value : []);

/** An address on the site's own origin, as a path: a single leading slash, else null. */
export function sitePath(value) {
  if (!isText(value) || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let url;
  try {
    url = new URL(value, "https://site.invalid");
  } catch {
    return null;
  }
  return url.origin === "https://site.invalid" ? url.pathname : null;
}

/**
 * The query file's text as the maps a preview needs, or null when it cannot
 * be read or is a format or a version this component does not know. Each
 * entry, relationship and source is checked on its own, so a malformed one
 * loses only itself.
 */
export function readQuery(body) {
  if (!isText(body) || body.length > MAX_QUERY_LENGTH) return null;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (data.format !== SUPPORTED_FORMAT || data.formatVersion !== SUPPORTED_VERSION) return null;
  const entries = new Map();
  for (const entry of ownList(data.entries)) {
    if (!entry || !isText(entry.id) || !ID.test(entry.id) || entries.has(entry.id)) continue;
    if (!isText(entry.label) || !entry.label || !isText(entry.kindLabel) || !sitePath(entry.url)) continue;
    entries.set(entry.id, entry);
  }
  const edges = new Map();
  for (const edge of ownList(data.edges)) {
    if (!edge || !isText(edge.id) || edges.has(edge.id)) continue;
    if (!isText(edge.from) || !isText(edge.to) || !isText(edge.label) || !isText(edge.inverseLabel)) continue;
    edges.set(edge.id, edge);
  }
  const sources = new Map();
  for (const source of ownList(data.sources)) {
    if (source && isText(source.id) && isText(source.text) && !sources.has(source.id)) sources.set(source.id, source.text);
  }
  return { entries, edges, sources };
}

/**
 * What one entry's preview says, or null when the entry is not in the file.
 * Every value is the query file's own wording: nothing is reworded.
 */
export function previewModel(query, id) {
  const entry = query?.entries?.get(id);
  if (!entry) return null;
  const listed = [...ownList(entry.out), ...ownList(entry.in)].filter(isText);
  const relationships = [];
  let known = 0;
  for (const edgeId of listed) {
    const edge = query.edges.get(edgeId);
    if (!edge) continue;
    const outgoing = edge.from === entry.id;
    if (!outgoing && edge.to !== entry.id) continue;
    const other = query.entries.get(outgoing ? edge.to : edge.from);
    if (!other) continue;
    known += 1;
    if (relationships.length >= MAX_RELATIONSHIPS) continue;
    relationships.push({
      text: `${entry.label} ${outgoing ? edge.label : edge.inverseLabel} ${other.label}`,
      assertedBy: text(edge.assertedByText),
      confidence: text(edge.confidenceText),
      standing: text(edge.standingText),
      uncertainty: text(edge.uncertainty),
      uncertaintyClipped: edge.uncertaintyClipped === true,
      evidence: ownList(edge.evidence)
        .map((item) => text(item?.text))
        .filter(Boolean)
        .slice(0, MAX_EVIDENCE),
    });
  }
  // What the file lists beyond the ones shown, and what it says it left out.
  const more =
    known - relationships.length +
    (Number.isInteger(entry.moreOut) && entry.moreOut > 0 ? entry.moreOut : 0) +
    (Number.isInteger(entry.moreIn) && entry.moreIn > 0 ? entry.moreIn : 0);
  return {
    id: entry.id,
    url: sitePath(entry.url),
    label: entry.label,
    kindLabel: entry.kindLabel,
    summary: isText(entry.preview) && entry.preview ? entry.preview : null,
    clipped: entry.previewClipped === true,
    source: isText(entry.source) && query.sources.has(entry.source) ? query.sources.get(entry.source) : null,
    relationships,
    more,
  };
}

/** Whether the link still goes to the entry's own page, on this site: only such a link is enhanced. */
export function leadsToEntry(link, model, base = globalThis.location?.href) {
  const href = link.getAttribute?.("href");
  if (!model || !isText(href) || !base) return false;
  try {
    const target = new URL(href, base);
    return target.origin === new URL(base).origin && target.pathname === model.url;
  } catch {
    return false;
  }
}

/** The words around the data. The page may translate them with attributes of the same names. */
const WORDS = {
  "provenance-label": "From the author's approved Knowledge Atlas",
  "summary-missing-label": "No summary is published; the entry's page has what there is.",
  "summary-clipped-label": "The entry's page has the rest.",
  "source-label": "Source",
  "relationships-label": "Relationships",
  "uncertainty-label": "Uncertainty",
  "evidence-label": "Evidence",
  "more-label": "more on the entry's page",
  "page-label": "Read the full entry",
};

/** On a touch screen the file is read ahead of a tap only below this many bytes (256 KiB). */
export const PREFETCH_LIMIT = 256 * 1024;

let instances = 0;

export class ObConceptPreviews extends HTMLElement {
  connectedCallback() {
    if (this.controller) return;
    const queryUrl = this.queryAddress();
    const candidates = [...document.querySelectorAll("a.ob-concept[data-atlas-entry]")];
    if (!queryUrl || !candidates.length) return;
    const controller = new AbortController();
    const { signal } = controller;
    this.controller = controller;
    this.queryUrl = queryUrl;
    this.entries = new Map();
    this.state = "idle";
    this.setAttribute("data-state", this.state);
    for (const link of candidates) {
      const interest = () => this.interest(link);
      link.addEventListener("focus", () => {
        interest();
        if (!this.returning) this.want(link);
      }, { signal });
      link.addEventListener("pointerenter", (event) => {
        interest();
        this.hover(link, event);
      }, { signal });
      link.addEventListener("pointerleave", (event) => this.leave(event), { signal });
      link.addEventListener("pointerdown", (event) => {
        interest();
        this.press(link, event);
      }, { signal });
      // A press that the browser takes back, or focus that moves away, ends it.
      link.addEventListener("pointercancel", () => (this.pressed = null), { signal });
      link.addEventListener("blur", () => {
        this.pressed = null;
        if (this.wanted === link) this.wanted = null;
      }, { signal });
      link.addEventListener("click", (event) => this.activate(link, event), { signal });
    }
    instances += 1;
    this.card = this.build(`ob-concept-preview-${instances}`, signal);
    document.addEventListener("keydown", (event) => this.keydown(event), { signal });
    document.addEventListener("pointerdown", (event) => this.outside(event), { signal });
    document.addEventListener("focusin", (event) => this.outside(event), { signal });
    window.addEventListener("resize", () => this.place(), { signal });
    // Nothing is fetched yet: the first interest in a link does it. A touch
    // screen has no hover to show interest before the tap that must already
    // find the file, so there (and only there, never for a reader who asked
    // to save data, and only for a file the page says is under 256 KiB) a
    // concept link scrolling into view counts as interest. A larger file, or
    // one of unknown size, waits for the first tap.
    if (
      this.smallEnoughToPrefetch() &&
      !globalThis.navigator?.connection?.saveData &&
      globalThis.matchMedia?.("(pointer: coarse)").matches &&
      "IntersectionObserver" in globalThis
    ) {
      const watcher = new IntersectionObserver((records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        watcher.disconnect();
        this.interest();
      });
      for (const link of candidates) watcher.observe(link);
      signal.addEventListener("abort", () => watcher.disconnect());
    }
  }

  disconnectedCallback() {
    this.close();
    this.controller?.abort();
    this.controller = null;
    this.card?.remove();
    this.status?.remove();
    this.card = null;
    this.status = null;
    this.entries = null;
    this.pressed = null;
    this.wanted = null;
  }

  /** Whether the page says the query file is under {@link PREFETCH_LIMIT} bytes. */
  smallEnoughToPrefetch() {
    const bytes = Number(this.getAttribute("data-bytes"));
    return Number.isFinite(bytes) && bytes > 0 && bytes < PREFETCH_LIMIT;
  }

  /** The query file's address on this site's own origin, from `src`, or null. */
  queryAddress() {
    const value = this.getAttribute("src");
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      return url.origin === location.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  /** Fetch and read the query file once. The links stay links if anything fails. */
  load() {
    if (this.loading || !this.controller) return this.loading;
    const { signal } = this.controller;
    this.state = "loading";
    this.setAttribute("data-state", this.state);
    this.loading = (async () => {
      try {
        const response = await fetch(this.queryUrl, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal,
        });
        if (!response.ok) throw new Error("unavailable");
        const query = readQuery(await response.text());
        if (!query) throw new Error("unreadable");
        for (const link of document.querySelectorAll("a.ob-concept[data-atlas-entry]")) {
          const model = previewModel(query, link.getAttribute("data-atlas-entry"));
          if (model && leadsToEntry(link, model)) this.entries?.set(link, model);
        }
        this.state = "ready";
      } catch {
        this.state = "failed";
      }
      this.setAttribute("data-state", this.state);
    })();
    return this.loading;
  }

  /** The first sign of interest in a link: make sure the file is on its way. */
  interest() {
    if (this.state === "idle") this.load();
  }

  /** Open this link's preview as soon as the file is ready, if interest remains. */
  want(link) {
    this.wanted = link;
    if (this.state === "ready") return this.open(link);
    // Focus arrived before the file: once it has, open the preview and say so once.
    const focused = document.activeElement === link;
    this.loading?.then(() => {
      if (this.wanted !== link || this.state !== "ready") return;
      this.open(link);
      if (focused && document.activeElement === link) this.announce(link);
    });
  }

  /** Say, once and politely, what the preview now describing the link holds. */
  announce(link) {
    const model = this.entries?.get(link);
    if (!model || !this.status) return;
    this.status.textContent = "";
    // A change after a frame is announced; the same words set at once may not be.
    requestAnimationFrame(() => {
      if (this.status && this.entries?.get(link) === model) {
        this.status.textContent = `${model.label}: ${model.kindLabel}. ${model.summary ?? this.word("summary-missing-label")}`;
      }
    });
  }

  /**
   * The one preview element, moved next to whichever link it describes. It is
   * kept as `card`: `popover` is HTMLElement's own attribute and would turn
   * the element into a string.
   */
  build(id, signal) {
    const card = document.createElement("span");
    card.className = "ob-concept-preview";
    card.id = id;
    card.setAttribute("role", "group");
    card.hidden = true;
    const details = document.createElement("span");
    details.className = "ob-concept-preview-details";
    details.id = `${id}-details`;
    card.append(details);
    this.details = details;
    this.anchors = document.createElement("span");
    this.anchors.className = "ob-concept-preview-links";
    card.append(this.anchors);
    // One polite announcement, for a reader whose focus arrived before the file.
    this.status = document.createElement("span");
    this.status.className = "ob-visually-hidden";
    this.status.setAttribute("role", "status");
    // Beside the element: the element itself is not rendered.
    this.after(this.status);
    card.addEventListener("pointerenter", () => clearTimeout(this.closeTimer), { signal });
    card.addEventListener("pointerleave", (event) => this.leave(event), { signal });
    return card;
  }

  word(name) {
    return this.getAttribute(name) || WORDS[name];
  }

  isOpen(link) {
    return Boolean(this.card && !this.card.hidden && this.current === link);
  }

  /** Whether keyboard focus is on the open preview's link or inside the preview. */
  focused() {
    const active = document.activeElement;
    return Boolean(active && (active === this.current || this.card?.contains(active)));
  }

  open(link) {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    const model = this.entries?.get(link);
    if (!model || this.isOpen(link)) return;
    this.close();
    this.fill(link, model);
    // Beside the link, but never inside a heading: the preview is not part of
    // the heading's text, its name or the page outline.
    const heading = link.closest("h1, h2, h3, h4, h5, h6");
    (heading ?? link).after(this.card);
    // Focus moving to the heading's own anchor, on the way to the preview, is not leaving it.
    this.scope = heading;
    this.card.hidden = false;
    this.current = link;
    const described = (link.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!described.includes(this.details.id)) described.push(this.details.id);
    link.setAttribute("aria-describedby", described.join(" "));
    this.place();
  }

  close() {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    const link = this.current;
    if (!link) return;
    this.current = null;
    if (this.card) this.card.hidden = true;
    const described = (link.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((token) => token && token !== this.details?.id);
    if (described.length) link.setAttribute("aria-describedby", described.join(" "));
    else link.removeAttribute("aria-describedby");
  }

  /** A line of the preview: a block of text, every value assigned as text. */
  line(className, words) {
    const line = document.createElement("span");
    line.className = `ob-concept-preview-${className}`;
    line.textContent = words;
    return line;
  }

  /** The preview's text and its one link, from the entry's public fields only. */
  fill(link, model) {
    this.card.setAttribute("aria-label", `${model.label}: ${model.kindLabel}`);
    const parts = [this.line("kind", model.kindLabel), this.line("provenance", this.word("provenance-label"))];
    if (model.summary) {
      const summary = this.line("summary", model.summary);
      parts.push(summary);
      if (model.clipped) parts.push(this.line("clipped", this.word("summary-clipped-label")));
    } else {
      parts.push(this.line("summary", this.word("summary-missing-label")));
    }
    if (model.source) parts.push(this.line("source", `${this.word("source-label")}: ${model.source}`));
    if (model.relationships.length || model.more) {
      const group = document.createElement("span");
      group.className = "ob-concept-preview-relationships";
      group.append(this.line("heading", this.word("relationships-label")));
      for (const relationship of model.relationships) {
        const item = document.createElement("span");
        item.className = "ob-concept-preview-relationship";
        item.append(this.line("statement", relationship.text));
        const how = [relationship.assertedBy, relationship.confidence, relationship.standing].filter(Boolean);
        if (how.length) item.append(this.line("how", how.join(". ")));
        if (relationship.uncertainty) {
          item.append(
            this.line(
              "uncertainty",
              `${this.word("uncertainty-label")}: ${relationship.uncertainty}${relationship.uncertaintyClipped ? " …" : ""}`,
            ),
          );
        }
        for (const evidence of relationship.evidence) {
          item.append(this.line("evidence", `${this.word("evidence-label")}: ${evidence}`));
        }
        group.append(item);
      }
      if (model.more) group.append(this.line("more", `${model.more} ${this.word("more-label")}`));
      parts.push(group);
    }
    this.details.replaceChildren(...parts);
    const page = document.createElement("a");
    page.className = "ob-concept-preview-page";
    page.href = link.getAttribute("href");
    page.textContent = `${this.word("page-label")}: ${model.label}`;
    this.anchors.replaceChildren(page);
  }

  /**
   * Below the link, or above it when only that fits, and inside the
   * viewport's width, which also bounds its own width. The width and offsets
   * are custom properties set through the CSS object model, which the page's
   * style policy allows. Placement never scrolls the page.
   */
  place() {
    if (!this.current || !this.card || this.card.hidden) return;
    const style = this.card.style;
    const view = document.documentElement;
    // The layout viewport without a classic scrollbar, unlike `100vw`.
    const width = view.clientWidth;
    const height = view.clientHeight;
    style.setProperty("--ob-concept-preview-max-inline-size", `${Math.max(0, width - 2 * GUTTER)}px`);
    style.setProperty("--ob-concept-preview-x", "0px");
    style.setProperty("--ob-concept-preview-y", "0px");
    const box = this.card.getBoundingClientRect();
    // A link that wraps has several boxes; the preview goes by the one it was reached at.
    const rects = [...this.current.getClientRects()];
    const mark = (rects.length ? rects[rects.length - 1] : this.current.getBoundingClientRect());
    let left = Math.min(mark.left, width - GUTTER - box.width);
    left = Math.max(left, GUTTER);
    let top = mark.bottom + GAP;
    let side = "below";
    if (top + box.height > height - GUTTER && mark.top - GAP - box.height >= GUTTER) {
      top = mark.top - GAP - box.height;
      side = "above";
    }
    this.card.dataset.side = side;
    style.setProperty("--ob-concept-preview-x", `${Math.round(left - box.left)}px`);
    style.setProperty("--ob-concept-preview-y", `${Math.round(top - box.top)}px`);
  }

  hover(link, event) {
    if (event.pointerType === "touch") return;
    clearTimeout(this.closeTimer);
    if (this.isOpen(link)) return;
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => this.want(link), OPEN_DELAY);
  }

  leave(event) {
    if (event.pointerType === "touch") return;
    clearTimeout(this.openTimer);
    if (!this.current) {
      // Interest ends with the pointer unless the link also has keyboard focus.
      if (this.wanted && document.activeElement !== this.wanted) this.wanted = null;
      return;
    }
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (!this.focused()) this.close();
    }, CLOSE_DELAY);
  }

  /**
   * Remembers a primary touch press on a link, and whether its preview was
   * already open, for the click that follows it. Any other press forgets it.
   */
  press(link, event) {
    this.pressed =
      event.pointerType === "touch" && event.isPrimary !== false
        ? { link, wasOpen: this.isOpen(link) }
        : null;
  }

  /**
   * A first tap opens the preview; any other activation follows the link. A
   * first tap is only a click that ends a touch press on the same link whose
   * preview was closed and could be opened now. A click with `detail` 0
   * (Enter, a script, or assistive technology activating the link), or with no
   * touch press before it, or before the file has loaded, always follows the
   * link.
   */
  activate(link, event) {
    const pressed = this.pressed;
    this.pressed = null;
    const firstTap =
      Boolean(pressed) &&
      pressed.link === link &&
      !pressed.wasOpen &&
      event.detail !== 0 &&
      this.entries?.has(link);
    if (firstTap) {
      event.preventDefault();
      this.open(link);
    } else {
      this.close();
    }
  }

  keydown(event) {
    if (event.key !== "Escape" || !this.current) return;
    const link = this.current;
    const inside = this.card.contains(document.activeElement);
    this.close();
    if (!inside) return;
    // Focus goes back to the link without opening the preview again.
    this.returning = true;
    try {
      link.focus();
    } finally {
      this.returning = false;
    }
  }

  /** Pressing or focusing anything but the open preview and its link closes it. */
  outside(event) {
    const target = event.target;
    if (this.pressed && event.type === "pointerdown" && !this.pressed.link.contains?.(target)) {
      this.pressed = null;
    }
    if (!this.current) return;
    if (target === this.current || this.current.contains?.(target) || this.card.contains(target)) return;
    if (event.type === "focusin" && this.scope?.contains?.(target)) return;
    this.close();
  }
}

if (!customElements.get("ob-concept-previews")) {
  customElements.define("ob-concept-previews", ObConceptPreviews);
}
