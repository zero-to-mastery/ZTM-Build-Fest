import "./kin-attachments.js";
import { describePlanningDate, KIND_LABELS } from "../today-view.js";
import { assigneeLabel } from "./shared/assignee-label.js";

// One default list row. It shows the item text, a restrained complete
// control, a short context line, checklist progress only when steps exist, a
// compact attachment strip only when attachments exist, the row's own Add
// photo button, and Details. Opening and completing are separate controls;
// nothing in the row is nested inside another control, and clicking the text
// opens details rather than completing anything. Everything else lives in the
// shared <kin-item-detail>.

const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 12.5 4 4 8-9"/></svg>';

class KinItem extends HTMLElement {
  constructor() {
    super();
    this.record = null;
    this.isDisabled = false;
    this.isPinned = false;
    this.isSelected = false;
    this.attachmentRecords = [];
    this.previewProvider = null;
    this.civilDate = null;
    this.showKind = false;
    this.areas = [];
    this.isSelectable = false;
    this.isChecked = false;
  }

  set item(value) { this.record = value; this.render(); }
  set areaOptions(value) { this.areas = Array.isArray(value) ? value : []; this.render(); }
  set pinned(value) { this.isPinned = Boolean(value); this.render(); }
  /** The item's picture emoji (#347), shown small beside the text. */
  set emoji(value) { const next = value || null; if (next === this.emojiValue) return; this.emojiValue = next; this.render(); }
  set selected(value) { this.isSelected = Boolean(value); this.render(); }
  set attachments(value) { this.attachmentRecords = Array.isArray(value) ? value : []; this.render(); }
  set previews(provider) { this.previewProvider = typeof provider === "function" ? provider : null; this.render(); }
  set responsibilityContext(value) { this.responsibilities = value?.responsibilities ?? []; this.memberId = value?.memberId ?? null; this.memberIds = value?.memberIds ?? []; this.memberNames = value?.names ?? null; this.render(); }
  set today(value) { this.civilDate = Number.isSafeInteger(value) ? value : null; this.render(); }
  set kindVisible(value) { this.showKind = Boolean(value); this.render(); }
  // Selection mode swaps the completion control for a native checkbox.
  // Checking only updates the box in place, so a long list is not rebuilt.
  set selectable(value) { this.isSelectable = Boolean(value); this.render(); }
  set checked(value) {
    this.isChecked = Boolean(value);
    const box = this.querySelector(".select-control");
    if (box) box.checked = this.isChecked;
    else this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, select")) {
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
  }

  render() {
    if (!this.record) return;
    const record = this.record;
    const isStaple = record.classification === "staple";
    const row = document.createElement("div");
    row.className = `item-row item-${record.status}${this.isSelected ? " item-selected" : ""}`;
    row.dataset.itemId = record.itemId;

    // Completion: a restrained check control, never a large call to action.
    const control = document.createElement("div");
    control.className = "item-control";
    if (this.isSelectable && !isStaple && record.status !== "archived") {
      const target = document.createElement("label");
      target.className = "select-target";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "select-control";
      box.checked = this.isChecked;
      box.dataset.itemId = record.itemId;
      box.dataset.itemAction = "select";
      box.disabled = this.isDisabled;
      box.addEventListener("change", () => {
        this.isChecked = box.checked;
        this.dispatch("item-selection", { itemId: record.itemId, checked: box.checked });
      });
      const name = document.createElement("span");
      name.className = "visually-hidden";
      name.textContent = `Select ${record.text}${record.status === "completed" ? " (completed)" : ""}`;
      target.append(box, name);
      control.append(target);
    } else if (isStaple) {
      const replenish = document.createElement("button");
      replenish.type = "button";
      replenish.className = "replenish-button";
      replenish.textContent = "Add to Shopping";
      replenish.setAttribute("aria-label", `Add ${record.text} to Shopping`);
      replenish.dataset.itemId = record.itemId;
      replenish.dataset.itemAction = "replenish";
      replenish.dataset.domainDisabled = String(record.status !== "active");
      replenish.disabled = this.isDisabled || record.status !== "active";
      replenish.addEventListener("click", () => this.dispatch("replenish-staple", { itemId: record.itemId }));
      control.append(replenish);
    } else if (record.status !== "archived") {
      const completed = record.status === "completed";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `complete-control ${completed ? "reopen-button" : "complete-button"}`;
      toggle.innerHTML = CHECK_ICON;
      // Easy mode (#617) shows the word beside the tick; the name already
      // starts with it.
      const word = document.createElement("span");
      word.className = "control-word";
      word.setAttribute("aria-hidden", "true");
      word.textContent = completed ? "Reopen" : "Complete";
      toggle.append(word);
      toggle.setAttribute("aria-label", `${completed ? "Reopen" : "Complete"} ${record.text}`);
      toggle.setAttribute("aria-pressed", String(completed));
      toggle.dataset.itemId = record.itemId;
      toggle.dataset.itemAction = completed ? "reopen" : "complete";
      toggle.disabled = this.isDisabled;
      toggle.addEventListener("click", () => this.dispatch(`${completed ? "reopen" : "complete"}-item`, { itemId: record.itemId }));
      control.append(toggle);
    }

    const body = document.createElement("div");
    body.className = "item-body";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "item-open";
    open.setAttribute("aria-label", `Open details for ${record.text}`);
    open.dataset.itemId = record.itemId;
    open.dataset.itemAction = "open";
    open.disabled = this.isDisabled;
    open.addEventListener("click", () => this.dispatch("open-item", { itemId: record.itemId, opener: open }));
    const text = document.createElement("span");
    text.className = "item-text";
    text.textContent = record.text;
    text.dataset.itemId = record.itemId;
    if (this.emojiValue) {
      // Beside the text, never instead of it; the text stays the name.
      const emoji = document.createElement("span");
      emoji.className = "item-emoji";
      emoji.setAttribute("aria-hidden", "true");
      emoji.textContent = this.emojiValue;
      open.append(emoji);
    }
    open.append(text);
    body.append(open);
    const meta = this.createMetaLine();
    if (meta) body.append(meta);
    const tiles = document.createElement("kin-attachments");
    tiles.mode = "compact";
    tiles.previews = this.previewProvider;
    tiles.parentRecord = { kind: "item", id: record.itemId, label: record.text, readonly: record.status === "archived" };
    tiles.attachments = this.attachmentRecords;
    body.append(tiles);

    const actions = document.createElement("div");
    actions.className = "item-row-actions";
    const steps = Array.isArray(record.steps) ? record.steps.filter((step) => !step.archived) : [];
    if (steps.length) {
      const summary = document.createElement("span");
      summary.className = "step-summary";
      const done = steps.filter((step) => step.completed).length;
      summary.textContent = `${done} of ${steps.length} steps`;
      actions.append(summary);
    }
    if (record.status !== "archived") {
      // Attaching is a common phone task, so it lives on the row rather than
      // behind Details. <kin-app> owns the file input and opens it from this tap.
      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "item-attach-button";
      attach.textContent = "Add photo";
      attach.setAttribute("aria-label", `Add a photo or file to ${record.text}`);
      attach.dataset.itemId = record.itemId;
      attach.dataset.itemAction = "attach";
      attach.disabled = this.isDisabled;
      attach.addEventListener("click", () => this.dispatch("pick-attachment", { parentKind: "item", parentId: record.itemId, label: record.text, opener: attach }));
      actions.append(attach);
    }
    const details = document.createElement("button");
    details.type = "button";
    details.className = "item-details-button";
    details.textContent = "Details";
    details.setAttribute("aria-label", `Details for ${record.text}`);
    details.setAttribute("aria-expanded", String(this.isSelected));
    details.dataset.itemId = record.itemId;
    details.dataset.itemAction = "details";
    details.disabled = this.isDisabled;
    details.addEventListener("click", () => this.dispatch("open-item", { itemId: record.itemId, opener: details }));
    actions.append(details);

    row.append(control, body, actions);
    this.replaceChildren(row);
  }

  createMetaLine() {
    const record = this.record;
    const parts = [];
    if (this.showKind) parts.push(KIND_LABELS[record.classification] ?? "Item");
    const planned = this.civilDate != null ? describePlanningDate(record.planningDate, this.civilDate) : null;
    if (planned) parts.push(planned);
    const owner = this.responsibilities?.find((entry) => entry.targetKind === "item" && entry.targetId === record.itemId)?.memberId ?? null;
    if (owner) {
      parts.push(assigneeLabel(owner, { memberId: this.memberId, memberIds: this.memberIds ?? [], names: this.memberNames }));
    }
    const area = this.areas.find((candidate) => candidate.areaId === record.areaId);
    if (area) parts.push(`${area.name}${area.archived ? " (archived)" : ""}`);
    if (this.isPinned) parts.push("Pinned");
    if (!parts.length) return null;
    const line = document.createElement("p");
    line.className = "item-meta";
    line.textContent = parts.join(" · ");
    return line;
  }

  dispatch(action, detail) {
    this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
}

customElements.define("kin-item", KinItem);
