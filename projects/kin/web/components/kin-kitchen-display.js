// <kin-kitchen-display> (#670, #671, ADR 0022 §4): the kitchen display's
// shell. A header with the time and date, the panels in their regions (a
// grid display.css lays out for portrait and landscape tablets), and two
// layers above them: the night dimmer and the screensaver.
//
// It only draws; app/display.js decides. Give it:
// - place([{ panel, element }]): the panels (display/panels.js records)
//   with the element that draws each, in order; each goes into its
//   region, and empty regions collapse;
// - setClock(date), `offline`, `night` (dimmed), `screensaver` (an element
//   or null, shown full screen above everything).
// It dispatches, bubbling: `kin:display-leave` { opener } from "Leave
// display mode", and `kin:display-help` { opener } from Help.
import { REGIONS } from "../display/panels.js";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

class KinKitchenDisplay extends HTMLElement {
  constructor() {
    super();
    this.regions = new Map();
    this.screensaverElement = null;
  }

  connectedCallback() {
    if (this.grid) return;
    this.classList.add("kitchen-display");
    const header = document.createElement("header");
    header.className = "display-header";
    const when = document.createElement("div");
    when.className = "display-when";
    this.time = document.createElement("p");
    this.time.className = "display-time";
    this.date = document.createElement("h1");
    this.date.className = "display-date";
    this.date.id = "display-title";
    this.date.tabIndex = -1;
    when.append(this.time, this.date);
    this.notice = document.createElement("p");
    this.notice.className = "display-notice";
    this.notice.setAttribute("role", "status");
    this.notice.hidden = true;
    const tools = document.createElement("div");
    tools.className = "display-tools";
    const help = document.createElement("button");
    help.type = "button";
    help.className = "display-help secondary";
    help.textContent = "Help";
    help.addEventListener("click", () => this.emit("kin:display-help", { opener: help }));
    this.leaveButton = document.createElement("button");
    this.leaveButton.type = "button";
    this.leaveButton.className = "display-leave secondary";
    this.leaveButton.textContent = "Leave display mode";
    this.leaveButton.setAttribute("aria-haspopup", "dialog");
    this.leaveButton.addEventListener("click", () => this.emit("kin:display-leave", { opener: this.leaveButton }));
    tools.append(help, this.leaveButton);
    header.append(when, this.notice, tools);
    this.grid = document.createElement("div");
    this.grid.className = "display-grid";
    for (const region of REGIONS) {
      const node = document.createElement("div");
      node.className = "display-region";
      node.dataset.region = region;
      this.regions.set(region, node);
      this.grid.append(node);
    }
    this.dimmer = document.createElement("div");
    this.dimmer.className = "display-dimmer";
    this.dimmer.hidden = true;
    const dimText = document.createElement("p");
    dimText.textContent = "Good night. Touch the screen to wake it.";
    this.dimmer.append(dimText);
    this.saver = document.createElement("div");
    this.saver.className = "display-screensaver";
    this.saver.hidden = true;
    this.append(header, this.grid, this.dimmer, this.saver);
    this.setClock(new Date());
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }

  /** Puts each panel's element into its region, in order. */
  place(entries) {
    if (!this.grid) this.connectedCallback();
    const wanted = new Map(REGIONS.map((region) => [region, []]));
    for (const { panel, element } of entries) {
      if (!wanted.has(panel.region) || !element) continue;
      let section = element.closest?.(".display-panel");
      if (!section || section.dataset.panel !== panel.id) {
        section = document.createElement("section");
        section.className = "display-panel";
        section.dataset.panel = panel.id;
        section.setAttribute("aria-label", panel.label);
        section.append(element);
      }
      section.dataset.size = panel.size;
      if (panel.featureId) section.dataset.feature = panel.featureId;
      else delete section.dataset.feature;
      wanted.get(panel.region).push(section);
    }
    for (const [region, sections] of wanted) {
      const node = this.regions.get(region);
      const same = node.children.length === sections.length && sections.every((section, index) => node.children[index] === section);
      if (!same) node.replaceChildren(...sections);
      node.hidden = sections.length === 0;
    }
    this.grid.dataset.regions = REGIONS.filter((region) => wanted.get(region).length).join(" ");
  }

  setClock(now) {
    if (!this.time) return;
    this.time.textContent = timeFormat.format(now);
    this.time.setAttribute("aria-label", `The time is ${timeFormat.format(now)}`);
    this.date.textContent = dateFormat.format(now);
    const clock = this.saver?.querySelector(".display-clock");
    if (clock) {
      clock.querySelector(".display-clock-time").textContent = timeFormat.format(now);
      clock.querySelector(".display-clock-date").textContent = dateFormat.format(now);
    }
  }

  set offline(value) {
    if (!this.notice) return;
    this.notice.hidden = !value;
    this.notice.textContent = value ? "Offline. Showing what this display last knew." : "";
  }

  set night(value) {
    if (!this.dimmer) return;
    this.dimmer.hidden = !value;
    this.toggleAttribute("data-night", Boolean(value));
  }
  get night() { return Boolean(this.dimmer && !this.dimmer.hidden); }

  /** An element (the photo frame, or a clock) shown above everything, or
   * null to show the panels again. */
  set screensaver(element) {
    if (!this.saver) return;
    if (element === this.screensaverElement) return;
    this.screensaverElement = element ?? null;
    this.saver.replaceChildren(...(element ? [element] : []));
    this.saver.hidden = !element;
    this.toggleAttribute("data-screensaver", Boolean(element));
  }
  get screensaver() { return this.screensaverElement; }

  /** A calm clock and date for the screensaver when there are no photos. */
  static clock(now = new Date()) {
    const clock = document.createElement("div");
    clock.className = "display-clock";
    clock.setAttribute("role", "region");
    clock.setAttribute("aria-label", "Clock");
    clock.tabIndex = -1;
    const time = document.createElement("p");
    time.className = "display-clock-time";
    time.textContent = timeFormat.format(now);
    const date = document.createElement("p");
    date.className = "display-clock-date";
    date.textContent = dateFormat.format(now);
    const hint = document.createElement("p");
    hint.className = "display-clock-hint";
    hint.textContent = "Touch the screen to see today.";
    clock.append(time, date, hint);
    return clock;
  }
}

customElements.define("kin-kitchen-display", KinKitchenDisplay);
export { KinKitchenDisplay };
