// Shopping mode (#403, #404, #408): the Shopping list for use in the shop.
// A full-screen modal dialog with one large native checkbox per item.
// Ticking an item completes it with the ordinary command (kin:complete-item,
// so Undo applies); it then moves to "In the basket", where unticking reopens
// it. The screen stays on while the mode is open, where the browser allows.
// It works offline like the rest of Kin; changes sync later.
import { ScreenWake } from "../wake-lock.js";
import { helpButton } from "./shared/help-button.js";

const WAKE_PREFERENCE = "kin.shopping.keepScreenOn";

function readPreference() {
  try { return globalThis.localStorage?.getItem(WAKE_PREFERENCE) !== "off"; } catch { return true; }
}
function writePreference(on) {
  try { globalThis.localStorage?.setItem(WAKE_PREFERENCE, on ? "on" : "off"); } catch { /* not kept */ }
}

class KinShoppingMode extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    // Store sections (#411, ADR 0015): `{ sections, itemSections }` from Rust.
    this.sectionData = { sections: [], itemSections: new Map() };
    this.basket = new Set();
    this.isDisabled = false;
    this.wake = new ScreenWake();
  }

  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "shopping-mode";
    this.dialog.setAttribute("aria-labelledby", "shopping-mode-title");
    const top = document.createElement("div");
    top.className = "shopping-mode-top";
    const heading = document.createElement("h2");
    heading.id = "shopping-mode-title";
    heading.textContent = "Shopping";
    this.count = document.createElement("p");
    this.count.className = "shopping-mode-count";
    this.count.setAttribute("role", "status");
    this.done = document.createElement("button");
    this.done.type = "button";
    this.done.className = "shopping-mode-done primary-action";
    this.done.textContent = "Done shopping";
    this.done.addEventListener("click", () => this.close());
    const titles = document.createElement("div");
    titles.append(heading, this.count);
    this.sectionsToggle = document.createElement("button");
    this.sectionsToggle.type = "button";
    this.sectionsToggle.className = "shopping-mode-sections-toggle";
    // Store sections (#625): their editor leaves with the feature.
    this.sectionsToggle.dataset.feature = "sections";
    this.sectionsToggle.textContent = "Sections";
    this.sectionsToggle.setAttribute("aria-expanded", "false");
    this.sectionsToggle.setAttribute("aria-controls", "shopping-sections-editor");
    this.sectionsToggle.addEventListener("click", () => this.toggleEditor());
    const buttons = document.createElement("div");
    buttons.className = "shopping-mode-buttons";
    // Help for Shopping mode (#621).
    buttons.append(helpButton("dialog:shopping-mode"), this.sectionsToggle, this.done);
    top.append(titles, buttons);
    this.editor = this.buildEditor();
    this.list = document.createElement("ul");
    this.list.className = "shopping-mode-list";
    this.list.setAttribute("aria-label", "To buy");
    this.empty = document.createElement("p");
    this.empty.className = "empty-state shopping-mode-empty";
    this.basketDetails = document.createElement("details");
    this.basketDetails.className = "shopping-mode-basket";
    this.basketSummary = document.createElement("summary");
    this.basketList = document.createElement("ul");
    this.basketList.className = "shopping-mode-list";
    this.basketList.setAttribute("aria-label", "In the basket");
    this.basketDetails.append(this.basketSummary, this.basketList);
    const wakeLabel = document.createElement("label");
    wakeLabel.className = "shopping-mode-wake";
    this.wakeSwitch = document.createElement("input");
    this.wakeSwitch.type = "checkbox";
    this.wakeSwitch.addEventListener("change", () => {
      writePreference(this.wakeSwitch.checked);
      if (this.wakeSwitch.checked) void this.wake.keepOn();
      else void this.wake.release();
    });
    wakeLabel.append(this.wakeSwitch, " Keep the screen on while shopping");
    wakeLabel.hidden = !this.wake.supported;
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener("close", () => void this.wake.release());
    // Ticking disables the boxes while Kin saves; this brings focus back.
    this.dialog.addEventListener("focusin", (event) => { if (event.target.dataset?.itemId) this.lastFocus = event.target.dataset.itemId; });
    this.dialog.append(top, this.editor, this.list, this.empty, this.basketDetails, wakeLabel);
    this.append(this.dialog);
  }

  disconnectedCallback() {
    void this.wake.release();
  }

  /** Every Item (the projection's array); only Shopping ones show. */
  set items(value) {
    const next = Array.isArray(value) ? value : [];
    if (next === this.records) return;
    this.records = next;
    if (this.isOpen) this.render();
  }

  /** `{ sections: [{ sectionId, name }], itemSections: Map }`. */
  set sections(value) {
    this.sectionData = value ?? { sections: [], itemSections: new Map() };
    if (this.isOpen) {
      this.render();
      if (!this.editor.hidden && !this.editor.contains(document.activeElement)) this.renderEditor();
    }
  }

  /** Where the household's sections are named and put in order: rows of
   * name fields with Move up, Move down and Remove, an Add field, and Save,
   * which saves the whole list (`kin:save-shopping-sections`). */
  buildEditor() {
    const editor = document.createElement("section");
    editor.id = "shopping-sections-editor";
    editor.className = "shopping-sections-editor";
    editor.dataset.feature = "sections";
    editor.hidden = true;
    editor.setAttribute("aria-labelledby", "shopping-sections-title");
    const heading = document.createElement("h3");
    heading.id = "shopping-sections-title";
    heading.textContent = "Store sections";
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Name the parts of the shop in the order you walk it. Items without a section go under Other, at the end.";
    this.editorList = document.createElement("ol");
    this.editorList.className = "shopping-sections-list";
    const addRow = document.createElement("div");
    addRow.className = "shopping-sections-add";
    const addLabel = document.createElement("label");
    addLabel.htmlFor = "shopping-section-new";
    addLabel.textContent = "New section";
    this.newSection = document.createElement("input");
    this.newSection.id = "shopping-section-new";
    this.newSection.maxLength = 40;
    this.newSection.placeholder = "Produce, Bakery, Dairy…";
    this.newSection.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); this.addDraft(); } });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add";
    add.addEventListener("click", () => this.addDraft());
    addRow.append(addLabel, this.newSection, add);
    this.editorMessage = document.createElement("p");
    this.editorMessage.className = "compose-message";
    this.editorMessage.setAttribute("role", "alert");
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-action";
    save.textContent = "Save sections";
    save.addEventListener("click", () => {
      const sections = this.drafts.map(({ sectionId, name }) => ({ sectionId, name: name.trim() })).filter((section) => section.name);
      this.dispatchEvent(new CustomEvent("kin:save-shopping-sections", { bubbles: true, composed: true, detail: { sections, done: (outcome) => this.editorSaved(outcome) } }));
    });
    editor.append(heading, hint, this.editorList, addRow, this.editorMessage, save);
    return editor;
  }

  toggleEditor(open = this.editor.hidden) {
    this.editor.hidden = !open;
    this.sectionsToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      this.drafts = this.sectionData.sections.map((section) => ({ ...section }));
      this.editorMessage.textContent = "";
      this.renderEditor();
      this.newSection.focus();
    } else {
      this.sectionsToggle.focus();
    }
  }

  addDraft() {
    const name = this.newSection.value.trim();
    if (!name) return;
    if (this.drafts.some((draft) => draft.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      this.editorMessage.textContent = `There's already a section called ${name}.`;
      return;
    }
    this.drafts.push({ sectionId: null, name });
    this.newSection.value = "";
    this.editorMessage.textContent = "";
    this.renderEditor();
    this.newSection.focus();
  }

  renderEditor() {
    this.drafts ??= [];
    this.editorList.replaceChildren(...this.drafts.map((draft, index) => {
      const row = document.createElement("li");
      const field = document.createElement("input");
      field.value = draft.name;
      field.maxLength = 40;
      field.setAttribute("aria-label", `Section ${index + 1} name`);
      field.addEventListener("input", () => { draft.name = field.value; });
      const move = (label, by, aria) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.setAttribute("aria-label", `${aria} ${draft.name || "this section"}`);
        button.disabled = index + by < 0 || index + by >= this.drafts.length;
        button.addEventListener("click", () => {
          const [moved] = this.drafts.splice(index, 1);
          this.drafts.splice(index + by, 0, moved);
          this.renderEditor();
          this.editorList.children[index + by]?.querySelectorAll("button")[by < 0 ? 0 : 1]?.focus();
        });
        return button;
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${draft.name || "this section"}`);
      remove.addEventListener("click", () => {
        this.drafts.splice(index, 1);
        this.renderEditor();
        (this.editorList.children[index] ?? this.editorList.children[index - 1])?.querySelector("input")?.focus() ?? this.newSection.focus();
      });
      row.append(field, move("↑", -1, "Move up"), move("↓", 1, "Move down"), remove);
      return row;
    }));
  }

  editorSaved(outcome) {
    if (outcome?.ok) this.toggleEditor(false);
    else this.editorMessage.textContent = outcome?.message ?? "Kin couldn't save the sections. Try again.";
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const box of this.querySelectorAll(".shopping-mode-list input, .shopping-mode-section")) box.disabled = this.isDisabled;
    if (!this.isDisabled && this.isOpen) {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        (this.querySelector(`.shopping-mode-list input[data-item-id="${this.lastFocus}"]`) ?? this.list.querySelector("input") ?? this.done)?.focus({ preventScroll: true });
    }
  }

  get isOpen() {
    return Boolean(this.dialog?.open);
  }

  open({ opener = null } = {}) {
    if (!this.dialog) this.connectedCallback();
    if (this.dialog.open) return;
    this.opener = opener;
    this.basket = new Set();
    this.basketDetails.open = false;
    this.render();
    this.dialog.showModal();
    this.wakeSwitch.checked = readPreference();
    if (this.wake.supported && this.wakeSwitch.checked) void this.wake.keepOn();
    (this.list.querySelector("input") ?? this.done).focus();
  }

  close() {
    void this.wake.release();
    if (this.dialog?.open) this.dialog.close();
    this.basket = new Set();
    const opener = this.opener;
    this.opener = null;
    // The list redraws while you shop, replacing its Start shopping button:
    // focus goes to the one there now.
    const target = opener?.isConnected ? opener : opener?.classList?.contains("start-shopping") ? document.querySelector("kin-today .start-shopping") : null;
    target?.focus();
  }

  render() {
    const shopping = this.records.filter((record) => record.classification === "shopping");
    const toBuy = shopping.filter((record) => record.status === "active");
    // The basket: what was ticked in this trip and is still completed.
    for (const id of [...this.basket]) if (!shopping.some((record) => record.itemId === id && record.status === "completed")) this.basket.delete(id);
    const inBasket = shopping.filter((record) => this.basket.has(record.itemId));
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    const focusedSection = this.contains(active) ? active.dataset.sectionFor : null;
    const focused = this.contains(active) ? active.dataset.itemId : lost ? this.lastFocus : null;
    // Grouped by store section in the household's order, Other last (#411).
    const { sections, itemSections } = this.sectionData;
    if (sections.length) {
      const groups = [...sections.map((section) => ({ ...section, items: [] })), { sectionId: null, name: "Other", items: [] }];
      for (const record of toBuy) (groups.find((group) => group.sectionId === itemSections.get(record.itemId)) ?? groups.at(-1)).items.push(record);
      this.list.replaceChildren(...groups.filter((group) => group.items.length).flatMap((group) => {
        const heading = document.createElement("li");
        heading.className = "shopping-mode-group";
        heading.setAttribute("role", "presentation");
        const title = document.createElement("h3");
        title.textContent = group.name;
        heading.append(title);
        return [heading, ...group.items.map((record) => this.row(record, false))];
      }));
    } else {
      this.list.replaceChildren(...toBuy.map((record) => this.row(record, false)));
    }
    this.basketList.replaceChildren(...inBasket.map((record) => this.row(record, true)));
    this.count.textContent = toBuy.length === 0 ? "Nothing left to buy" : toBuy.length === 1 ? "1 thing to buy" : `${toBuy.length} things to buy`;
    this.empty.hidden = toBuy.length > 0;
    this.empty.textContent = inBasket.length ? "That's everything. Done shopping when you're ready." : "Nothing on the Shopping list.";
    this.basketDetails.hidden = inBasket.length === 0;
    this.basketSummary.textContent = inBasket.length === 1 ? "In the basket: 1" : `In the basket: ${inBasket.length}`;
    if (focusedSection) {
      this.querySelector(`.shopping-mode-section[data-section-for="${focusedSection}"]`)?.focus({ preventScroll: true });
    } else if (focused) {
      const same = this.querySelector(`.shopping-mode-list input[data-item-id="${focused}"]`);
      (same ?? this.list.querySelector("input") ?? this.done).focus({ preventScroll: true });
    }
  }

  row(record, checked) {
    const item = document.createElement("li");
    item.className = "shopping-mode-item";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.disabled = this.isDisabled;
    box.dataset.itemId = record.itemId;
    box.addEventListener("change", () => {
      if (box.checked) this.basket.add(record.itemId);
      else this.basket.delete(record.itemId);
      this.dispatchEvent(new CustomEvent(box.checked ? "kin:complete-item" : "kin:reopen-item", {
        bubbles: true, composed: true, detail: { itemId: record.itemId },
      }));
    });
    const text = document.createElement("span");
    text.className = "shopping-mode-text";
    text.textContent = record.text;
    label.append(box, text);
    item.append(label);
    // The item's section, changed in place (#411).
    if (!checked && this.sectionData.sections.length) {
      const select = document.createElement("select");
      select.className = "shopping-mode-section";
      select.dataset.sectionFor = record.itemId;
      select.disabled = this.isDisabled;
      select.setAttribute("aria-label", `Section for ${record.text}`);
      for (const section of this.sectionData.sections) select.append(new Option(section.name, section.sectionId));
      select.append(new Option("Other", ""));
      select.value = this.sectionData.itemSections.get(record.itemId) ?? "";
      select.addEventListener("change", () => this.dispatchEvent(new CustomEvent("kin:set-item-section", {
        bubbles: true, composed: true, detail: { itemId: record.itemId, sectionId: select.value || null },
      })));
      item.append(select);
    }
    return item;
  }
}

if (!customElements.get("kin-shopping-mode")) customElements.define("kin-shopping-mode", KinShoppingMode);
