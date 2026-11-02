// <ob-atlas-trail> enhances the relationship trail on a Knowledge Atlas entry
// page (ADR 0175). The page is complete without it: the static trail is an
// ordered list of steps grouped by how far they are from the entry, and each
// step is one published relationship in the direction it was stated, with its
// type, who asserts it, how firmly, its standing, its evidence and its stated
// uncertainty, and which way the walk crossed it. A step that arrives at an
// entry already on the trail says so, and the trail does not continue from it
// again, so a loop is a sentence and never a trap.
//
// The component adds one labelled group of native controls above the list:
// a relationship type, the direction the walk followed, how many steps out,
// and "only contested or uncertain relationships", with a status line that
// says what is shown and every filter in force. A filter shows or hides a
// whole step and never changes what a shown step says: its direction,
// evidence and uncertainty stay. Hidden steps stay in the page, so reading
// order, headings and links are unchanged, and print shows the whole trail
// and leaves the controls out.
//
// It reads only the page's own markup, writes only text, fetches nothing,
// stores nothing and needs no inline style. Nothing moves or animates, and
// no control traps focus.

const DIRECTIONS = Object.freeze([
  ["forward", "Along the direction stated"],
  ["backward", "Against the direction stated"],
]);
const DEPTH_WORDS = Object.freeze({ 1: "One step", 2: "Two steps", 3: "Three steps" });

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * One step as a filter sees it, from the data attributes the page writes and
 * the words of its "Type" entry. A step the page wrote wrongly still has a
 * description: unknown values simply match no specific filter.
 */
export function readStep(attributes, kindLabel = "") {
  const get = (name) => (typeof attributes[name] === "string" ? attributes[name] : "");
  const depth = Number.parseInt(get("data-depth"), 10);
  return {
    depth: Number.isInteger(depth) && depth > 0 ? depth : 0,
    kind: get("data-kind"),
    kindLabel: get("data-kind-label") || (typeof kindLabel === "string" ? kindLabel : ""),
    direction: get("data-direction"),
    contested: get("data-standing") === "contested",
    uncertain: get("data-uncertain") === "true",
    again: get("data-again") === "true",
  };
}

/**
 * Which steps a filter shows, in the steps' own order. A step is shown or
 * hidden whole. `filters` is `{ kind, direction, depth, doubtful }`: a kind
 * value or "" for every type, "forward" or "backward" or "" for either,
 * a largest depth or 0 for any, and whether only steps that are contested or
 * carry a stated uncertainty are wanted.
 */
export function filterSteps(steps, filters = {}) {
  const kind = typeof filters.kind === "string" ? filters.kind : "";
  const direction = typeof filters.direction === "string" ? filters.direction : "";
  const depth = Number.isInteger(filters.depth) && filters.depth > 0 ? filters.depth : 0;
  return steps.map((step) => {
    if (kind && step.kind !== kind) return false;
    // A relationship that reads the same both ways was followed in neither
    // direction: it is shown under either choice, and never described as
    // followed against the direction it was stated.
    if (direction) {
      const known = DIRECTIONS.some(([value]) => value === direction);
      if (step.direction !== direction && !(known && step.direction === "symmetric")) return false;
    }
    if (depth && !(step.depth > 0 && step.depth <= depth)) return false;
    if (filters.doubtful && !(step.contested || step.uncertain)) return false;
    return true;
  });
}

/** What the trail shows, in words, with every filter in force. */
export function statusText(steps, shown, filters = {}) {
  const visible = shown.filter(Boolean).length;
  const parts = [`Showing ${visible} of ${plural(steps.length, "relationship", "relationships")}`];
  if (filters.kind) {
    const named = steps.find((step) => step.kind === filters.kind);
    parts.push(`type: ${named?.kindLabel || filters.kind}`);
  }
  if (filters.direction) {
    const named = DIRECTIONS.find(([value]) => value === filters.direction);
    parts.push(named ? named[1].toLowerCase() : filters.direction);
    if (steps.some((step) => step.direction === "symmetric")) {
      parts.push("relationships that read the same both ways are shown under either choice");
    }
  }
  if (filters.depth) parts.push(`within ${DEPTH_WORDS[filters.depth]?.toLowerCase() || `${filters.depth} steps`}`);
  if (filters.doubtful) parts.push("only contested or uncertain relationships");
  let text = `${parts.join("; ")}.`;
  text += visible
    ? " Every relationship shown keeps its direction, evidence and uncertainty."
    : " Nothing matches; reset the filters to see the whole trail.";
  return text;
}

/** The type choices a trail offers: only types it has, in order of first appearance. */
export function kindChoices(steps) {
  const seen = new Map();
  for (const step of steps) {
    if (step.kind && !seen.has(step.kind)) seen.set(step.kind, step.kindLabel || step.kind);
  }
  return [...seen];
}

/** The depth choices a trail offers: every distance from 1 to the furthest it reaches. */
export function depthChoices(steps) {
  const furthest = steps.reduce((most, step) => Math.max(most, step.depth), 0);
  return Array.from({ length: furthest }, (_, index) => index + 1);
}

const BaseElement = globalThis.HTMLElement ?? class {};

export class ObAtlasTrail extends BaseElement {
  #controller = null;
  #tools = null;

  connectedCallback() {
    if (this.#tools) return;
    const section = this.querySelector(".ob-atlas-trail-section");
    const items = [...this.querySelectorAll("li.ob-trail-step")];
    const list = this.querySelector(".ob-trail-depths");
    if (!section || !list || items.length < 2) return;
    const steps = items.map((item) => {
      const attributes = {};
      for (const name of ["data-depth", "data-kind", "data-kind-label", "data-direction", "data-standing", "data-uncertain", "data-again"]) {
        attributes[name] = item.getAttribute(name) ?? undefined;
      }
      const type = [...item.querySelectorAll("dt")].find((term) => term.textContent.trim() === "Type");
      return readStep(attributes, type?.nextElementSibling?.textContent.trim() ?? "");
    });
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;
    const filters = { kind: "", direction: "", depth: 0, doubtful: false };
    const make = (tag, props = {}, text = "") => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(props)) element.setAttribute(name, value);
      if (text) element.textContent = text;
      return element;
    };
    const field = (id, label, control) => {
      const wrapper = make("p", { class: "ob-trail-field" });
      wrapper.append(make("label", { for: id }, label), control);
      return wrapper;
    };

    const tools = make("div", { class: "ob-trail-tools", role: "group", "aria-label": "Trail filters" });
    const kind = make("select", { id: "ob-trail-kind" });
    kind.append(make("option", { value: "" }, "Every type"));
    for (const [value, label] of kindChoices(steps)) kind.append(make("option", { value }, label));
    const direction = make("select", { id: "ob-trail-direction" });
    direction.append(make("option", { value: "" }, "Either direction"));
    for (const [value, label] of DIRECTIONS) direction.append(make("option", { value }, label));
    const depth = make("select", { id: "ob-trail-depth" });
    depth.append(make("option", { value: "0" }, "Any distance"));
    for (const choice of depthChoices(steps)) {
      depth.append(make("option", { value: String(choice) }, `Within ${(DEPTH_WORDS[choice] || `${choice} steps`).toLowerCase()}`));
    }
    const doubtfulField = make("p", { class: "ob-trail-field" });
    const doubtful = make("input", { type: "checkbox", id: "ob-trail-doubtful" });
    doubtfulField.append(doubtful, make("label", { for: "ob-trail-doubtful" }, "Only contested or uncertain relationships"));
    const reset = make("button", { type: "button" }, "Reset filters");
    const status = make("p", { class: "ob-meta ob-trail-status", role: "status", "aria-live": "polite" });
    tools.append(
      field("ob-trail-kind", "Relationship type", kind),
      field("ob-trail-direction", "Direction followed", direction),
      field("ob-trail-depth", "How far", depth),
      doubtfulField,
      reset,
      status,
    );

    const update = () => {
      const shown = filterSteps(steps, filters);
      items.forEach((item, index) => {
        item.hidden = !shown[index];
      });
      // A distance with nothing left to show is hidden whole, with its heading.
      for (const group of this.querySelectorAll(".ob-trail-depth")) {
        group.hidden = ![...group.querySelectorAll("li.ob-trail-step")].some((item) => !item.hidden);
      }
      status.textContent = statusText(steps, shown, filters);
    };

    kind.addEventListener("change", () => {
      filters.kind = kind.value;
      update();
    }, { signal });
    direction.addEventListener("change", () => {
      filters.direction = direction.value;
      update();
    }, { signal });
    depth.addEventListener("change", () => {
      filters.depth = Number.parseInt(depth.value, 10) || 0;
      update();
    }, { signal });
    doubtful.addEventListener("change", () => {
      filters.doubtful = doubtful.checked;
      update();
    }, { signal });
    reset.addEventListener("click", () => {
      Object.assign(filters, { kind: "", direction: "", depth: 0, doubtful: false });
      kind.value = "";
      direction.value = "";
      depth.value = "0";
      doubtful.checked = false;
      update();
      // The control that was pressed stays where it is: nothing moves focus.
    }, { signal });

    section.insertBefore(tools, list);
    this.#tools = tools;
    update();
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
    this.#tools?.remove();
    this.#tools = null;
    for (const element of this.querySelectorAll(".ob-atlas-trail-section [hidden]")) element.hidden = false;
  }
}

if (globalThis.customElements && !customElements.get("ob-atlas-trail")) {
  customElements.define("ob-atlas-trail", ObAtlasTrail);
}
