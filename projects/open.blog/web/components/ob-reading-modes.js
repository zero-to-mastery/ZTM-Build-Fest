// <ob-reading-modes> wraps a post that has author-written supplements
// (ADR 0142). The page is complete without it: every supplement is written out
// visible, labelled and in order, and no control exists until this runs.
//
//   default="guided"     - the mode the author opens the post in (standard if absent)
//   data-ob-base="/blog" - the site's base path, which names this site's saved choice
//
// It adds one radio group (Standard, Guided, Deep dive) and a reset button, and
// shows or hides each `.ob-supplement` by its `data-ob-level`. It never changes
// the article, its citations or its headings. A supplement that holds a warning
// or caution (`data-ob-always`) is never hidden. The reader's choice is kept in
// localStorage on this device, as a preference only: it is never sent anywhere
// and the page works when storage is blocked.
//
// Progressive rendering (ADR 0144). The static markup is the whole content; the
// stylesheet hides the layers the author's default mode hides until this runs,
// and only where script is on, so there is no flash of every layer and no loss
// without script. A hidden supplement is `hidden="until-found"` where the
// browser has it, so find in page and a link into it still reach the words and
// reveal them; elsewhere it is `hidden`. Changing the mode keeps the reader's
// place: the first thing in view stays where it was. Navigating to something
// inside a hidden supplement (a heading, a citation back-link, a link to the
// address already shown) shows that supplement.
//
// Fields are private (#name): a public field named like an HTMLElement property
// (`hidden`, `popover`, `title`) would silently shadow it.

import {
  LABELS,
  MODES,
  STORAGE_KEY,
  announcement,
  clearPreference,
  countsByMode,
  describe,
  localStore,
  pagePath,
  printNote,
  readPreference,
  resolveMode,
  shouldShow,
  storageKey,
  writePreference,
} from "./reading-modes.js";

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("aria-") || key.startsWith("data-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
};

const SUPPLEMENTS = ".ob-supplement[data-ob-supplement]";
// What the renderer makes of a warning or caution callout. A supplement that holds one is never hidden,
// whatever its markup says (the build writes `data-ob-always`; this is the reader's own second check).
const CAVEATS = ".ob-callout-warning, .ob-callout-caution";
// What the reader's place is kept against: blocks of the article, not the control.
const ANCHORS = "p, li, h1, h2, h3, h4, h5, h6, pre, figure, table, blockquote, details";
const NOTE =
  "The article is the same in every mode. Each supplement is a labelled box that ends with an “End of … supplement” line; everything outside those boxes is the article.";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// Browsers that can find text in, and navigate into, hidden="until-found" content.
const canFind = () => "onbeforematch" in document.documentElement;
let instances = 0;

class ObReadingModes extends HTMLElement {
  #lifetime = null;
  #built = false;
  #supplements = [];
  #radios = new Map();
  #helps = new Map();
  #status = null;
  #printNote = null;
  #reset = null;
  #storage = null;
  #key = STORAGE_KEY;
  #mode = "standard";

  connectedCallback() {
    // First, so the stylesheet's pre-paint hiding ends whatever happens next.
    this.classList.add("ob-reading-started");
    if (!this.#built) {
      this.#supplements = [...this.querySelectorAll(SUPPLEMENTS)];
      // Nothing to choose between: add nothing.
      if (!this.#supplements.length) return;
      this.#storage = localStore();
      this.#key = storageKey(this.getAttribute("data-ob-base") ?? "");
      this.#build();
      this.#built = true;
      this.dataset.ready = "true";
    }
    // Attached again (moved, or removed and put back): listen again, and show
    // what the saved choice says now, as it may have changed while away.
    this.#listen();
    this.#apply(this.#resolve(), false);
    if (location.hash) this.#revealHash();
  }

  disconnectedCallback() {
    this.#lifetime?.abort();
    this.#lifetime = null;
  }

  #resolve() {
    return resolveMode(readPreference(this.#storage, this.#key), this.getAttribute("default"));
  }

  #listen() {
    this.#lifetime?.abort();
    this.#lifetime = new AbortController();
    const { signal } = this.#lifetime;
    addEventListener("hashchange", () => this.#revealHash(), { signal });
    // Another tab of this site chose a mode: follow it. Only our own key
    // matters (or a clear of all storage), and nothing changes when the mode
    // is the one already shown, so a supplement the reader navigated into
    // stays shown and focus stays where it is.
    addEventListener(
      "storage",
      (event) => {
        if (event.key !== this.#key && event.key !== null) return;
        const next = this.#resolve();
        if (next !== this.#mode) this.#apply(next, false);
      },
      { signal },
    );
    // A link to the address already shown fires no hashchange, so a click on
    // an in-page link that points into a hidden supplement shows it here.
    document.addEventListener("click", (event) => this.#followLink(event), { signal });
    for (const node of this.#supplements) {
      // Find in page (or a fragment navigation) revealed a supplement itself.
      node.addEventListener(
        "beforematch",
        () => {
          node.setAttribute("data-ob-revealed", "");
          // The browser takes `hidden` off just after this event.
          setTimeout(() => this.#writePrintNote(), 0);
          this.#say(`Showed the ${this.#kind(node)} supplement that holds this match.`);
        },
        { signal },
      );
    }
  }

  /** Whether no mode may hide `node`: it is marked, holds a warning or caution, or sits inside one. */
  #always(node) {
    return node.hasAttribute("data-ob-always") || node.querySelector(CAVEATS) !== null || node.closest(CAVEATS) !== null;
  }

  #items() {
    return this.#supplements.map((node) => ({
      level: node.getAttribute("data-ob-level"),
      always: this.#always(node),
    }));
  }

  #kind(node) {
    return (node.querySelector(".ob-supplement-kind")?.textContent || "Supplement").toLowerCase();
  }

  #say(text) {
    this.#status.textContent = "";
    this.#status.textContent = text;
  }

  #build() {
    // A copy of a built element carries the old control: replace it.
    this.querySelectorAll(":scope > .ob-reading-controls, :scope > [role=status], :scope > .ob-reading-print-note").forEach((node) => node.remove());
    const id = ++instances;
    const counts = countsByMode(this.#items());
    const total = this.#supplements.length;
    const group = el("fieldset", { class: "ob-reading-controls" }, el("legend", {}, "Reading mode"));
    // Says which words are the article's, so the choice below never has to be guessed at.
    const note = el("p", { class: "ob-reading-note", id: `ob-reading-mode-${id}-note` }, NOTE);
    group.setAttribute("aria-describedby", note.id);
    const options = el("div", { class: "ob-reading-options" });
    for (const mode of MODES) {
      const input = el("input", {
        type: "radio",
        name: `ob-reading-mode-${id}`,
        id: `ob-reading-mode-${id}-${mode}`,
        value: mode,
      });
      const help = el("span", { class: "ob-reading-help", id: `ob-reading-mode-${id}-${mode}-help` }, describe(mode, counts[mode], total));
      input.setAttribute("aria-describedby", help.id);
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const saved = writePreference(this.#storage, mode, this.#key);
        this.#apply(mode, true, saved ? "" : " This choice could not be saved on this device, so it applies to this page only.");
      });
      this.#radios.set(mode, input);
      this.#helps.set(mode, help);
      options.append(
        el("div", { class: "ob-reading-option" }, input, el("label", { htmlFor: input.id }, LABELS[mode]), help),
      );
    }
    // aria-disabled, not disabled: a button that disables itself while it has
    // focus drops the keyboard reader's place to the page.
    this.#reset = el("button", { class: "ob-reading-reset", type: "button", "aria-disabled": "true" }, "Use the author’s default");
    this.#reset.addEventListener("click", () => {
      if (this.#reset.getAttribute("aria-disabled") === "true") return;
      const cleared = clearPreference(this.#storage, this.#key);
      this.#apply(
        resolveMode(null, this.getAttribute("default")),
        true,
        cleared ? " Your saved choice was cleared." : " Your saved choice could not be cleared.",
      );
    });
    this.#status = el("p", { class: "ob-visually-hidden", role: "status", "aria-live": "polite" });
    group.append(note, options, this.#reset);
    this.#addSkipLinks(id);
    // Seen only on paper, where the control is not: says which layers the printed page leaves out.
    this.#printNote = el("p", { class: "ob-reading-print-note" });
    this.prepend(group, this.#status, this.#printNote);
  }

  /**
   * A way past each supplement for a keyboard or screen-reader reader: a link,
   * seen only when it has focus, to the supplement's end line. It sits after the
   * label, so it is never part of the supplement's name.
   */
  #addSkipLinks(id) {
    this.querySelectorAll(".ob-supplement-skip").forEach((node) => node.remove());
    this.#supplements.forEach((node, index) => {
      const end = node.querySelector(":scope > .ob-supplement-end");
      const label = node.querySelector(":scope > .ob-supplement-label");
      if (!end || !label) return;
      end.id ||= `${node.id || `ob-supplement-${id}-${index + 1}`}-end`;
      const skip = el("a", { class: "ob-supplement-skip", href: `#${end.id}` }, `Skip this ${this.#kind(node)} supplement`);
      skip.addEventListener("click", (event) => {
        event.preventDefault();
        end.tabIndex = -1;
        end.scrollIntoView({ block: "nearest" });
        end.focus({ preventScroll: true });
      });
      label.after(skip);
    });
  }

  /** The first block of the article in view, which stays where it is when layers appear or go. */
  #anchor(changing) {
    const inChanging = (node) => {
      for (let held = node.closest(".ob-supplement"); held; held = held.parentElement?.closest(".ob-supplement")) {
        if (changing.has(held)) return true;
      }
      return false;
    };
    for (const node of this.querySelectorAll(ANCHORS)) {
      if (node.closest(".ob-reading-controls, [role=status]") || inChanging(node)) continue;
      const box = node.getBoundingClientRect();
      if (box.height === 0 || box.bottom <= 0) continue;
      // Everything after this is below the screen: nothing in view to keep.
      return box.top >= innerHeight ? null : { node, top: box.top };
    }
    return null;
  }

  #hide(node) {
    node.setAttribute("hidden", canFind() ? "until-found" : "");
  }

  /** Shows what `mode` shows. With `announce`, says so, followed by `note`. */
  #apply(mode, announce, note = "") {
    this.#mode = mode;
    this.#radios.get(mode).checked = true;
    const active = document.activeElement;
    // Decide first, so the reader's place can be kept across the change.
    const plan = this.#supplements.map((node) => {
      let visible = true;
      try {
        visible = shouldShow(mode, node.getAttribute("data-ob-level"), this.#always(node));
      } catch {
        // One supplement that cannot be read stays shown; the others go on.
      }
      // Never take away the supplement the reader is working in.
      const holdsFocus = !visible && active && active !== document.body && node.contains(active);
      // A change the reader did not just make (another tab, the element put
      // back) never hides a supplement they navigated into.
      const kept = !visible && !announce && node.hasAttribute("data-ob-revealed");
      return { node, visible: visible || holdsFocus || kept, holdsFocus: holdsFocus || kept, was: !node.hasAttribute("hidden") };
    });
    const changing = new Set(plan.filter((item) => item.visible !== item.was).map((item) => item.node));
    const place = changing.size && (scrollY > 0 || announce) ? this.#anchor(changing) : null;
    let shown = 0;
    for (const { node, visible, holdsFocus, was } of plan) {
      try {
        if (visible) {
          node.removeAttribute("hidden");
          node.classList.remove("ob-just-shown");
          // A supplement that appears because the reader chose a mode fades in.
          if (!was && announce) node.classList.add("ob-just-shown");
        } else {
          this.#hide(node);
          node.classList.remove("ob-just-shown");
        }
        if (holdsFocus) node.setAttribute("data-ob-revealed", "");
        else node.removeAttribute("data-ob-revealed");
      } catch {
        // Scoped to this supplement.
      }
      if (visible) shown += 1;
    }
    if (place && place.node.isConnected) {
      const moved = place.node.getBoundingClientRect().top - place.top;
      if (Math.abs(moved) >= 1) scrollBy({ top: moved, behavior: "instant" });
    }
    this.#writePrintNote();
    this.#reset.setAttribute("aria-disabled", String(readPreference(this.#storage, this.#key) === null));
    this.#status.textContent = "";
    if (announce) {
      // A fresh text node each time, so a repeated choice is announced again.
      this.#status.textContent = `${announcement(mode, shown, this.#supplements.length)}${note}`;
    }
  }

  /** What paper says about the layers left out, from what is hidden right now. */
  #writePrintNote() {
    if (!this.#printNote) return;
    const hidden = this.#supplements.filter((node) => node.hasAttribute("hidden")).length;
    this.#printNote.textContent = printNote(this.#mode, hidden);
  }

  /** The id a link or address names, or "". */
  #idOf(fragment) {
    try {
      return decodeURIComponent(fragment);
    } catch {
      return "";
    }
  }

  /** A click on an in-page link whose target is in a hidden supplement shows it first. */
  #followLink(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    // A link to this page written in full (https://site/post/#id) counts as
    // much as `#id`: same origin, path (`/post/` and `/post/index.html` are one page) and query, with a
    // fragment.
    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin || pagePath(url.pathname) !== pagePath(location.pathname) || url.search !== location.search) return;
    const id = this.#idOf(url.hash.slice(1));
    const target = this.#reveal(id);
    // The browser follows the link and scrolls; the focus follows it there.
    if (target) setTimeout(() => this.#land(target, false), 0);
  }

  /**
   * Shows the supplement that holds the element `id` names (or that a note
   * cited only inside supplements names), if it is hidden. Returns the
   * element when something was shown, else null.
   */
  #reveal(id) {
    const target = id ? document.getElementById(id) : null;
    if (!target || !this.contains(target)) return null;
    // A note cited only inside supplements names them; the target itself may
    // be a hidden supplement or sit inside one.
    let holder = target.closest(".ob-supplement[hidden]");
    if (!holder) {
      const named = (target.getAttribute("data-ob-supplement") || "").split(/\s+/).find(Boolean);
      const candidate = named ? document.getElementById(named) : null;
      if (candidate && this.contains(candidate) && candidate.matches(SUPPLEMENTS)) holder = candidate;
    }
    if (!holder) return null;
    let revealed = null;
    for (let node = holder; node; node = node.parentElement?.closest(SUPPLEMENTS)) {
      if (node.hasAttribute("hidden")) {
        node.removeAttribute("hidden");
        node.setAttribute("data-ob-revealed", "");
        revealed ??= node;
      }
    }
    if (!revealed) return null;
    this.#writePrintNote();
    this.#say(`Showed the ${this.#kind(revealed)} supplement that holds this link.`);
    return target;
  }

  /** Puts the reader on `target`: in view (when `scroll`) and focused. */
  #land(target, scroll) {
    if (!target.isConnected) return;
    if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) target.tabIndex = -1;
    if (scroll) target.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
  }

  /** Shows the supplement that holds the address's target, if it is hidden. */
  #revealHash() {
    const target = this.#reveal(this.#idOf(location.hash.slice(1)));
    if (target) this.#land(target, true);
  }
}

if (!customElements.get("ob-reading-modes")) {
  customElements.define("ob-reading-modes", ObReadingModes);
}
