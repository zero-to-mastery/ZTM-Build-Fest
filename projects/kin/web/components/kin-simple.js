// Simple view's Today (#345, #346, ADR 0013): big cards for a Limited
// member's own things today, tonight's dinner, and one Done button per card
// that becomes Undo in the same place. Nothing is counted: no totals,
// streaks or celebrations.
//
// The element only renders and reports: `kin:simple-done` with { key, kind,
// id, occurrenceKey, undo } asks the app to mark a card done or undo it.
// Cards are list items keyed by `key`; a re-render keeps focus on the same
// card's button.
class KinSimple extends HTMLElement {
  constructor() {
    super();
    this.cardsValue = [];
    this.tonightValue = null;
    this.isDisabled = false;
    this.previewProvider = null;
    this.loaded = false;
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
    this.render();
  }

  /** Cards from simple-view.js buildCards. */
  set cards(value) {
    this.cardsValue = Array.isArray(value) ? value : [];
    this.loaded = true;
    this.render();
  }

  /** Tonight's dinner line ("Tacos · You're cooking") or null. */
  set tonight(value) {
    this.tonightValue = value || null;
    this.render();
  }

  set previews(provider) {
    this.previewProvider = typeof provider === "function" ? provider : null;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const button of this.querySelectorAll("button")) button.disabled = this.isDisabled;
    if (!this.isDisabled) this.settleDeferredFocus();
  }

  build() {
    this.className = "simple-today";
    this.tonightLine = document.createElement("p");
    this.tonightLine.className = "simple-tonight";
    this.tonightLine.hidden = true;
    this.list = document.createElement("ul");
    this.list.className = "simple-cards";
    this.list.setAttribute("aria-label", "My things today");
    this.empty = document.createElement("p");
    this.empty.className = "simple-empty";
    this.empty.textContent = "Nothing for you today.";
    this.empty.hidden = true;
    this.append(this.tonightLine, this.list, this.empty);
  }

  /** The focused card's key, if focus is on a card's button. */
  focusedKey() {
    const card = document.activeElement?.closest?.(".simple-card");
    return card && this.contains(card) ? card.dataset.key : null;
  }

  restoreFocus(key) {
    if (!key) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const button = [...this.list.querySelectorAll(".simple-card")].find((card) => card.dataset.key === key)?.querySelector("button");
    if (button && !button.disabled) button.focus();
  }

  deferFocusedControl() {
    this.deferredFocus = this.focusedKey() ?? this.deferredFocus ?? null;
  }

  settleDeferredFocus() {
    const key = this.deferredFocus;
    this.deferredFocus = null;
    this.restoreFocus(key);
  }

  render() {
    if (!this.firstElementChild) return;
    const focused = this.focusedKey();
    this.tonightLine.hidden = !this.tonightValue;
    this.tonightLine.textContent = this.tonightValue ? `Tonight: ${this.tonightValue}` : "";
    this.list.replaceChildren(...this.cardsValue.map((card) => this.cardElement(card)));
    this.empty.hidden = !this.loaded || this.cardsValue.length > 0;
    this.restoreFocus(focused);
  }

  cardElement(card) {
    const item = document.createElement("li");
    item.className = `simple-card${card.done ? " is-done" : ""}`;
    item.dataset.key = card.key;
    const picture = document.createElement("div");
    picture.className = "simple-picture";
    picture.setAttribute("aria-hidden", "true");
    if (card.picture?.emoji) {
      const emoji = document.createElement("span");
      emoji.className = "simple-emoji";
      emoji.textContent = card.picture.emoji;
      picture.append(emoji);
    } else if (card.picture?.attachment && this.previewProvider) {
      const img = document.createElement("img");
      img.alt = "";
      img.hidden = true;
      const apply = (preview) => {
        if (!preview?.url) return;
        img.src = preview.url;
        img.hidden = false;
      };
      const cached = this.previewProvider(card.picture.attachment, { peek: true });
      if (cached) apply(cached);
      else Promise.resolve(this.previewProvider(card.picture.attachment)).then(apply, () => {});
      picture.append(img);
    } else {
      picture.classList.add("is-empty");
    }
    const text = document.createElement("p");
    text.className = "simple-text";
    text.textContent = card.text;
    const button = document.createElement("button");
    button.type = "button";
    button.className = card.done ? "simple-undo" : "simple-done";
    button.textContent = card.done ? "Undo" : "Done";
    button.setAttribute("aria-label", `${card.done ? "Undo" : "Done"}: ${card.text}`);
    button.disabled = this.isDisabled;
    button.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:simple-done", {
      bubbles: true, composed: true,
      detail: { key: card.key, kind: card.kind, id: card.id, text: card.text, occurrenceKey: card.occurrenceKey ?? null, undo: card.done },
    })));
    item.append(picture, text, button);
    return item;
  }
}

customElements.define("kin-simple", KinSimple);
