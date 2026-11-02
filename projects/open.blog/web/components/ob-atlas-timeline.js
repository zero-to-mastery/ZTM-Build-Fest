// <ob-atlas-timeline> enhances the Knowledge Atlas timeline (ADR 0100). The
// page is complete without it: the static timeline is an ordered list of
// periods, each holding dated aspects with every competing dating, who dates
// it, how firmly, the cited evidence and the note, then the aspects not placed
// in time and the relative chronology.
//
// The component adds one toolbar above that list: an aspect filter, "only
// aspects with competing datings", a way to go to a period, and a status line
// that says what is shown. A filter shows or hides a whole dated aspect, never
// one of its datings, and never the evidence, confidence or note of a dating
// that is shown. The relative chronology is always listed in full. Print shows
// the whole timeline and leaves the toolbar out.
//
// It reads only the page's own markup, writes only text, fetches nothing,
// stores nothing and needs no inline style. Nothing moves or animates: going
// to a period moves focus to its heading.

const ASPECTS = Object.freeze([
  ["span", "Span"],
  ["birth", "Birth"],
  ["death", "Death"],
  ["active", "Activity (floruit)"],
  ["composition", "Composition"],
  ["publication", "Publication"],
  ["emergence", "Emergence"],
]);
const ASPECT_NOUNS = Object.freeze({
  span: "span",
  birth: "birth",
  death: "death",
  active: "activity",
  composition: "composition",
  publication: "publication",
  emergence: "emergence",
});

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * Which dated aspects a filter shows. `rows` are `{ aspect, datings }`, one
 * per dated aspect; the result keeps their order. A row is shown or hidden
 * whole: a filter never takes one competing dating away from the others.
 */
export function filterRows(rows, filters = {}) {
  const aspect = typeof filters.aspect === "string" ? filters.aspect : "";
  return rows.map((row) => {
    if (aspect && row.aspect !== aspect) return false;
    if (filters.competing && !(row.datings > 1)) return false;
    return true;
  });
}

/** What the timeline shows, in words, with every filter in force. */
export function statusText(rows, shown, filters = {}) {
  const total = rows.reduce((sum, row) => sum + row.datings, 0);
  const visible = rows.filter((_, index) => shown[index]);
  const datings = visible.reduce((sum, row) => sum + row.datings, 0);
  const parts = [`Showing ${visible.length} of ${plural(rows.length, "dated aspect", "dated aspects")} (${datings} of ${plural(total, "dating", "datings")})`];
  if (filters.aspect) parts.push(`${ASPECT_NOUNS[filters.aspect] || filters.aspect} only`);
  if (filters.competing) parts.push("only aspects with competing datings");
  let text = `${parts.join("; ")}.`;
  text += visible.length
    ? " Every aspect shown keeps all its datings, their evidence and their notes."
    : " Nothing matches; choose every aspect to see the whole timeline.";
  return text;
}

/** The aspect choices a timeline offers: only aspects it lists, in a fixed order. */
export function aspectChoices(rows) {
  const present = new Set(rows.map((row) => row.aspect));
  return ASPECTS.filter(([value]) => present.has(value));
}

/**
 * Moves a period choice off an option a filter disabled: the selection goes to
 * the first enabled option. Returns false when none is enabled.
 */
export function settlePeriod(select) {
  const options = [...select.options];
  if (!options.length) return false;
  if (options[select.selectedIndex]?.disabled === false) return true;
  const open = options.find((option) => !option.disabled);
  if (!open) return false;
  select.value = open.value;
  return true;
}

const BaseElement = globalThis.HTMLElement ?? class {};

export class ObAtlasTimeline extends BaseElement {
  #controller = null;
  #tools = null;

  connectedCallback() {
    if (this.#tools) return;
    const section = this.querySelector(".ob-atlas-timeline");
    const items = [...this.querySelectorAll("li.ob-atlas-aspect")];
    if (!section || !items.length) return;
    const rows = items.map((item) => ({
      item,
      aspect: item.getAttribute("data-aspect") || "",
      datings: Number.parseInt(item.getAttribute("data-datings") || "0", 10) || 0,
    }));
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;
    const filters = { aspect: "", competing: false };
    const make = (tag, props = {}, text = "") => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(props)) element.setAttribute(name, value);
      if (text) element.textContent = text;
      return element;
    };

    const tools = make("div", { class: "ob-atlas-timeline-tools", role: "group", "aria-label": "Timeline filters" });
    const aspectField = make("p", { class: "ob-atlas-timeline-field" });
    const aspectSelect = make("select", { id: "ob-atlas-timeline-aspect" });
    aspectSelect.append(make("option", { value: "" }, "Every aspect"));
    for (const [value, label] of aspectChoices(rows)) aspectSelect.append(make("option", { value }, label));
    aspectField.append(make("label", { for: "ob-atlas-timeline-aspect" }, "Show"), aspectSelect);

    const competingField = make("p", { class: "ob-atlas-timeline-field" });
    const competing = make("input", { type: "checkbox", id: "ob-atlas-timeline-competing" });
    competingField.append(competing, make("label", { for: "ob-atlas-timeline-competing" }, "Only aspects with competing datings"));

    const periodField = make("p", { class: "ob-atlas-timeline-field" });
    const periodSelect = make("select", { id: "ob-atlas-timeline-period" });
    const targets = [...section.querySelectorAll(".ob-atlas-period > h3[id], #atlas-timeline-unplaced, #atlas-timeline-relative")];
    for (const heading of targets) periodSelect.append(make("option", { value: heading.id }, heading.textContent.trim()));
    const go = make("button", { type: "button" }, "Go to period");
    periodField.append(make("label", { for: "ob-atlas-timeline-period" }, "Period"), periodSelect, go);

    const status = make("p", { class: "ob-meta ob-atlas-timeline-status", role: "status", "aria-live": "polite" });
    tools.append(aspectField, competingField);
    if (targets.length) tools.append(periodField);
    tools.append(status);

    const update = () => {
      const shown = filterRows(rows, filters);
      rows.forEach((row, index) => {
        row.item.hidden = !shown[index];
      });
      // A period, or the unplaced list, with nothing left to show is hidden too.
      for (const group of section.querySelectorAll(".ob-atlas-period, .ob-atlas-unplaced")) {
        group.hidden = ![...group.querySelectorAll("li.ob-atlas-aspect")].some((item) => !item.hidden);
      }
      for (const option of periodSelect.options) {
        const heading = section.querySelector(`#${CSS.escape(option.value)}`);
        const holder = heading?.closest(".ob-atlas-period, .ob-atlas-unplaced");
        option.disabled = Boolean(holder?.hidden);
      }
      const placed = settlePeriod(periodSelect);
      status.textContent = statusText(rows, shown, filters);
      if (!placed && periodSelect.options.length) status.textContent += " No period has anything to go to.";
    };

    aspectSelect.addEventListener("change", () => {
      filters.aspect = aspectSelect.value;
      update();
    }, { signal });
    competing.addEventListener("change", () => {
      filters.competing = competing.checked;
      update();
    }, { signal });
    go.addEventListener("click", () => {
      const heading = section.querySelector(`#${CSS.escape(periodSelect.value)}`);
      if (!heading || heading.closest("[hidden]")) {
        status.textContent = `${statusText(rows, filterRows(rows, filters), filters)} No period has anything to go to.`;
        return;
      }
      heading.focus();
    }, { signal });

    const list = section.querySelector(".ob-atlas-periods, .ob-atlas-unplaced");
    section.insertBefore(tools, list);
    this.#tools = tools;
    update();
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
    this.#tools?.remove();
    this.#tools = null;
    for (const element of this.querySelectorAll(".ob-atlas-timeline [hidden]")) element.hidden = false;
  }
}

if (globalThis.customElements && !customElements.get("ob-atlas-timeline")) {
  customElements.define("ob-atlas-timeline", ObAtlasTimeline);
}
