// Secondary navigation inside a primary destination (To do · Shopping ·
// Staples, Handoffs · Talk, the Household destinations). Plain links with
// hashes so Back/Forward and refresh land on the same segment; the current
// link carries aria-current="true" and the selected segment is exposed on the
// host as data-current. Easy mode (#617) names the tabs it tucks away
// (`easyHidden`); they carry data-easy-hidden, which app.css hides only in
// easy mode. The current tab is never tucked away.

class KinSegmentNav extends HTMLElement {
  constructor() {
    super();
    this.entries = [];
    this.currentId = null;
    this.navLabel = "Sections";
    this.hiddenIds = new Set();
  }

  set easyHidden(ids) {
    this.hiddenIds = new Set(ids ?? []);
    this.markHidden();
  }

  markHidden() {
    for (const link of this.querySelectorAll(".segment-link")) {
      const hide = this.hiddenIds.has(link.dataset.segment) && link.dataset.segment !== this.currentId;
      link.parentElement?.toggleAttribute("data-easy-hidden", hide);
    }
  }

  static get observedAttributes() { return ["label"]; }
  attributeChangedCallback(name, _old, value) { if (name === "label" && value) { this.navLabel = value; this.render(); } }

  set segments(value) {
    const entries = Array.isArray(value) ? value : [];
    const signature = JSON.stringify(entries);
    if (signature === this.signature && this.querySelector(".segment-nav")) return;
    this.signature = signature;
    this.entries = entries;
    this.render();
  }
  // Only the aria-current marks change, so the link elements stay stable for
  // focus and for anyone holding a reference to them.
  set current(value) {
    this.currentId = value ?? null;
    if (!this.querySelector(".segment-nav")) { this.render(); return; }
    for (const link of this.querySelectorAll(".segment-link")) {
      if (link.dataset.segment === this.currentId) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    this.dataset.current = this.currentId ?? "";
    this.markHidden();
  }
  get current() { return this.currentId; }

  connectedCallback() { this.render(); }

  render() {
    const nav = document.createElement("nav");
    nav.className = "segment-nav";
    nav.setAttribute("aria-label", this.navLabel);
    const list = document.createElement("ul");
    for (const entry of this.entries) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "segment-link";
      link.href = entry.hash;
      link.dataset.segment = entry.id;
      link.textContent = entry.label;
      if (entry.id === this.currentId) link.setAttribute("aria-current", "true");
      if (entry.count) {
        const count = document.createElement("span");
        count.className = "segment-count";
        count.textContent = entry.countText ?? String(entry.count);
        count.setAttribute("aria-label", entry.countAria ?? `${entry.countText ?? entry.count} ${entry.countLabel ?? "open"}`);
        link.append(" ", count);
      }
      item.append(link);
      list.append(item);
    }
    nav.append(list);
    // A count changing rebuilds the links; keyboard focus stays on its link.
    const focused = this.contains(document.activeElement) ? document.activeElement.dataset?.segment : null;
    this.dataset.current = this.currentId ?? "";
    this.replaceChildren(nav);
    this.markHidden();
    if (focused) nav.querySelector(`[data-segment="${CSS.escape(focused)}"]`)?.focus();
  }

  focusCurrent() { this.querySelector('[aria-current="true"]')?.focus(); }
}

customElements.define("kin-segment-nav", KinSegmentNav);
