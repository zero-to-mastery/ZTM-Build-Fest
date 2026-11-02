import { MAX_SEARCH_RESULTS, searchHouseholdRecords } from "../search.js";
import "./kin-chat-search.js";

// Local search over the unlocked projection. Each result is a real control
// that opens the matching record by its canonical id (kin:open-search-result);
// matched text is built from text nodes and <mark> elements, never HTML.
// Query, filters and results live only in this element while unlocked; lock
// replaces the element.

const KIND_LABELS = { Item: "Item", "Checklist Step": "Checklist step", Handoff: "Handoff", Talk: "Talk topic", Note: "Note", "Reference Record": "Reference", Maintenance: "Maintenance" };

class KinSearch extends HTMLElement {
  constructor() {
    super();
    this.records = { items: [], handoffs: [], talks: [], notes: [], referenceRecords: [], maintenanceEvents: [], areas: [] };
    this.isDisabled = false;
    this.room = null;
  }

  connectedCallback() {
    if (this.queryInput) return;

    const section = document.createElement("section");
    section.className = "search-section";
    const heading = document.createElement("h2");
    heading.textContent = "Search household";
    heading.tabIndex = -1;
    const hint = document.createElement("p");
    hint.className = "search-hint";
    hint.textContent = "Searches stay on this device. Results open the matching item, step, handoff, topic, note, reference, or maintenance entry.";

    this.form = document.createElement("form");
    this.form.className = "search-form";
    this.form.autocomplete = "off";
    this.form.addEventListener("submit", (event) => event.preventDefault());
    const queryLabel = document.createElement("label");
    queryLabel.htmlFor = "household-search-query";
    queryLabel.textContent = "Search household text";
    this.queryInput = document.createElement("input");
    this.queryInput.id = "household-search-query";
    this.queryInput.type = "search";
    this.queryInput.autocomplete = "off";
    this.queryInput.spellcheck = false;
    this.queryInput.placeholder = "Try a word or phrase";
    this.queryInput.addEventListener("input", () => {
      this.renderResults();
      this.chatSearch.query = this.queryInput.value;
    });

    const filters = document.createElement("details");
    filters.className = "search-filters-disclosure";
    const filtersSummary = document.createElement("summary");
    filtersSummary.textContent = "Filter item results";
    filters.append(filtersSummary);
    const fieldset = document.createElement("fieldset");
    fieldset.className = "search-filters";
    const filtersHeading = document.createElement("legend");
    filtersHeading.className = "visually-hidden";
    filtersHeading.textContent = "Filter Item results";
    fieldset.append(filtersHeading);
    this.classificationSelect = this.createFilter(fieldset, "List", [
      ["", "All lists"],
      ["need", "To do"],
      ["today", "Today (legacy)"],
      ["shopping", "Shopping"],
      ["staple", "Staples"],
    ]);
    this.statusSelect = this.createFilter(fieldset, "Status", [
      ["", "Open or completed"],
      ["active", "Open"],
      ["completed", "Completed"],
    ]);
    this.areaSelect = this.createFilter(fieldset, "Area", [["", "Any area"]]);
    filters.append(fieldset);
    this.filters = filters;

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "search-clear-button";
    this.clearButton.textContent = "Clear search and filters";
    this.clearButton.addEventListener("click", () => {
      this.queryInput.value = "";
      this.classificationSelect.value = "";
      this.statusSelect.value = "";
      this.areaSelect.value = "";
      this.renderResults();
      this.chatSearch.query = "";
      this.queryInput.focus();
    });

    this.resultStatus = document.createElement("p");
    this.resultStatus.className = "search-result-status";
    this.resultStatus.setAttribute("role", "status");
    this.resultStatus.setAttribute("aria-live", "polite");
    this.resultStatus.setAttribute("aria-atomic", "true");
    this.resultsList = document.createElement("ol");
    this.resultsList.className = "search-results";
    this.resultsList.setAttribute("aria-label", "Search results");
    this.form.append(queryLabel, this.queryInput, filters, this.clearButton);
    // Chat messages that match, under the household results (#124).
    this.chatSearch = document.createElement("kin-chat-search");
    this.chatSearch.room = this.chatRoom ?? null;
    section.append(heading, hint, this.form, this.resultStatus, this.resultsList, this.chatSearch);
    this.replaceChildren(section);

    this.updateAreaOptions();
    this.renderResults();
    this.disabled = this.isDisabled;
  }

  set household(value) {
    const records = {
      items: Array.isArray(value?.items) ? value.items : [],
      handoffs: Array.isArray(value?.handoffs) ? value.handoffs : [],
      talks: Array.isArray(value?.talks) ? value.talks : [],
      notes: Array.isArray(value?.notes) ? value.notes : [],
      referenceRecords: Array.isArray(value?.referenceRecords) ? value.referenceRecords : [],
      maintenanceEvents: Array.isArray(value?.maintenanceEvents) ? value.maintenanceEvents : [],
      areas: Array.isArray(value?.areas) ? value.areas : [],
    };
    // Unchanged projection sections keep their arrays; nothing to redo.
    if (Object.keys(records).every((key) => records[key] === this.records[key])) return;
    this.records = records;
    this.updateAreaOptions();
    this.renderResults();
  }

  /** The chat room whose messages the Chat group searches (none: no group). */
  set chatRoom(value) {
    this.room = value ?? null;
    if (this.chatSearch) this.chatSearch.room = this.room;
  }

  get chatRoom() {
    return this.room ?? null;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, select, button")) control.disabled = this.isDisabled;
  }

  focusInput() { this.queryInput?.focus(); }

  createFilter(fieldset, labelText, options) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const select = document.createElement("select");
    for (const [value, text] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.addEventListener("change", () => this.renderResults());
    label.append(select);
    fieldset.append(label);
    return select;
  }

  updateAreaOptions() {
    if (!this.areaSelect) return;
    const signature = this.records.areas.map((area) => `${area.areaId}\0${area.name}\0${area.archived}`).join("\u0001");
    if (signature === this.areaSignature) return;
    const selected = this.areaSelect.value;
    const focused = document.activeElement === this.areaSelect;
    this.areaSelect.replaceChildren();
    const anyArea = document.createElement("option");
    anyArea.value = "";
    anyArea.textContent = "Any area";
    this.areaSelect.append(anyArea);
    const unassigned = document.createElement("option");
    unassigned.value = "unassigned";
    unassigned.textContent = "No area";
    this.areaSelect.append(unassigned);
    for (const area of this.records.areas) {
      const option = document.createElement("option");
      option.value = area.areaId;
      option.textContent = `${area.name}${area.archived ? " (archived)" : ""}`;
      this.areaSelect.append(option);
    }
    this.areaSelect.value = [...this.areaSelect.options].some((option) => option.value === selected) ? selected : "";
    this.areaSignature = signature;
    if (focused) this.areaSelect.focus();
  }

  renderResults() {
    if (!this.resultStatus) return;
    const query = this.queryInput.value;
    const focusedResult = this.resultsList.contains(document.activeElement) ? document.activeElement.dataset.resultId : null;
    const { results, totalCount } = searchHouseholdRecords({
      ...this.records,
      query,
      classification: this.classificationSelect.value,
      status: this.statusSelect.value,
      areaId: this.areaSelect.value,
    });
    this.resultsList.replaceChildren();
    if (!query.trim()) {
      this.resultStatus.textContent = "Enter text above to search.";
      return;
    }
    if (totalCount === 0) {
      this.resultStatus.textContent = "No matching unarchived household text.";
      return;
    }
    this.resultStatus.textContent = totalCount > MAX_SEARCH_RESULTS
      ? `Showing the first ${MAX_SEARCH_RESULTS} of ${totalCount} matches. Refine your search to narrow the results.`
      : `${totalCount} ${totalCount === 1 ? "match" : "matches"}.`;
    const needle = query.trim().toLowerCase();
    for (const result of results) {
      const entry = document.createElement("li");
      entry.className = "search-result";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "search-result-open";
      open.dataset.resultId = result.id;
      open.dataset.resultKind = result.kind;
      open.disabled = this.isDisabled;
      open.setAttribute("aria-label", `Open ${KIND_LABELS[result.kind] ?? result.kind}: ${result.text}`);
      const kind = document.createElement("strong");
      kind.className = "search-result-kind";
      kind.textContent = result.kind;
      const text = document.createElement("span");
      text.className = "search-result-text";
      text.append(...highlight(result.text, needle));
      open.append(kind, text);
      if (result.detail) {
        const detail = document.createElement("span");
        detail.className = "search-result-detail";
        detail.append(...highlight(result.detail, needle));
        open.append(detail);
      }
      if (result.context) {
        const context = document.createElement("small");
        context.className = "search-result-context";
        context.textContent = result.context;
        open.append(context);
      }
      open.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:open-search-result", {
        detail: { ...describeTarget(result), opener: open }, bubbles: true, composed: true,
      })));
      entry.append(open);
      this.resultsList.append(entry);
    }
    if (focusedResult) [...this.resultsList.querySelectorAll("button")].find((node) => node.dataset.resultId === focusedResult)?.focus();
  }
}

// Canonical identifiers only; a target is never located by its title.
function describeTarget(result) {
  if (result.kind === "Checklist Step") {
    const [itemId, stepId] = result.id.split(":");
    return { kind: "step", itemId, stepId, id: result.id };
  }
  const kinds = { Item: "item", Handoff: "handoff", Talk: "talk", Note: "note", "Reference Record": "reference-record", Maintenance: "maintenance" };
  return { kind: kinds[result.kind] ?? "unknown", id: result.id };
}

// Splits text around case-insensitive matches; returns text nodes and <mark>
// elements only, so household text is never interpreted as markup.
function highlight(value, needle) {
  const text = typeof value === "string" ? value : "";
  if (!needle) return [document.createTextNode(text)];
  const nodes = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  let guard = 0;
  while (cursor <= text.length && guard++ < 50) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) break;
    if (index > cursor) nodes.push(document.createTextNode(text.slice(cursor, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + needle.length);
    nodes.push(mark);
    cursor = index + needle.length;
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
  if (!nodes.length) nodes.push(document.createTextNode(text));
  return nodes;
}

customElements.define("kin-search", KinSearch);
