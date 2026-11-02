// <kin-display-shopping> (#671): the shopping list on the kitchen display.
// Big rows to tick off and one big box to add to it; nothing smaller than
// 64 px, no details, no bulk selection. It only draws and reports:
// - `items`: the projection's items (the shopping ones are picked here);
// - `disabled` while Kin is saving.
// It dispatches, bubbling:
// - `kin:display-shopping-tick` { itemId, text } when a row is ticked;
// - `kin:display-shopping-add` { text, done(ok) } when something is added.
// Household text is only ever set as textContent.

const MAX_TEXT = 200;

class KinDisplayShopping extends HTMLElement {
  constructor() {
    super();
    this.itemsValue = [];
    this.isDisabled = false;
  }

  connectedCallback() {
    if (!this.list) this.build();
    this.render();
  }

  set items(value) {
    const next = Array.isArray(value) ? value : [];
    if (next === this.itemsValue) return;
    this.itemsValue = next;
    this.render();
  }
  get items() { return this.itemsValue; }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, button")) control.disabled = this.isDisabled;
  }

  /** The active shopping items, oldest first, as the list shows them. */
  get active() {
    return this.itemsValue.filter((item) => item.classification === "shopping" && item.status === "active");
  }

  build() {
    this.classList.add("display-shopping");
    const heading = document.createElement("h2");
    heading.className = "display-panel-title";
    heading.textContent = "Shopping";
    const form = document.createElement("form");
    form.className = "display-shopping-add";
    const label = document.createElement("label");
    label.className = "visually-hidden";
    label.htmlFor = `display-shopping-input-${Math.random().toString(36).slice(2, 8)}`;
    label.textContent = "Add to Shopping";
    this.input = document.createElement("input");
    this.input.id = label.htmlFor;
    this.input.type = "text";
    this.input.maxLength = MAX_TEXT;
    this.input.autocomplete = "off";
    this.input.placeholder = "Add to Shopping";
    this.input.enterKeyHint = "done";
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "primary-action";
    add.textContent = "Add";
    form.append(label, this.input, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text || this.isDisabled) return;
      this.dispatchEvent(new CustomEvent("kin:display-shopping-add", {
        bubbles: true, composed: true,
        detail: { text, done: (ok) => { if (ok) this.input.value = ""; } },
      }));
    });
    this.list = document.createElement("ul");
    this.list.className = "display-shopping-list";
    this.list.setAttribute("aria-label", "Shopping list");
    this.empty = document.createElement("p");
    this.empty.className = "display-empty";
    this.empty.textContent = "Nothing on the shopping list.";
    this.append(heading, form, this.list, this.empty);
  }

  render() {
    if (!this.list) return;
    const active = this.active;
    const rows = active.map((item) => {
      const row = document.createElement("li");
      row.className = "display-shopping-row";
      row.dataset.itemId = item.itemId;
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "display-check";
      box.disabled = this.isDisabled;
      box.addEventListener("change", () => {
        if (!box.checked) return;
        row.classList.add("is-done");
        this.dispatchEvent(new CustomEvent("kin:display-shopping-tick", { bubbles: true, composed: true, detail: { itemId: item.itemId, text: item.text } }));
      });
      const text = document.createElement("span");
      text.className = "display-shopping-text";
      text.textContent = item.text;
      label.append(box, text);
      row.append(label);
      return row;
    });
    this.list.replaceChildren(...rows);
    this.list.hidden = !rows.length;
    this.empty.hidden = rows.length > 0;
  }
}

customElements.define("kin-display-shopping", KinDisplayShopping);
