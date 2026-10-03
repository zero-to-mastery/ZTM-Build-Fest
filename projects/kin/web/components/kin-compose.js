const MAX_ITEM_TEXT_BYTES = 4096;
const textEncoder = new TextEncoder();

class KinCompose extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = false;
    this.initialized = false;
  }

  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.form = document.createElement("form");
    this.form.className = "compose-form";
    this.label = document.createElement("label");
    this.label.htmlFor = "item-text";
    this.label.textContent = "What should we remember?";
    this.input = document.createElement("input");
    this.input.id = "item-text";
    this.input.name = "item";
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.maxLength = MAX_ITEM_TEXT_BYTES;
    this.input.required = true;
    this.input.setAttribute("aria-describedby", "compose-message");
    this.classificationLabel = document.createElement("label");
    this.classificationLabel.htmlFor = "item-classification";
    this.classificationLabel.textContent = "Add to";
    this.classification = document.createElement("select");
    this.classification.id = "item-classification";
    this.classification.name = "classification";
    for (const [value, text] of [
      ["need", "Needs"],
      ["today", "Today"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.classification.append(option);
    }
    this.classificationField = document.createElement("div");
    this.classificationField.className = "classification-field";
    this.classificationField.append(
      this.classificationLabel,
      this.classification,
    );
    this.button = document.createElement("button");
    this.button.className = "add-button";
    this.button.type = "submit";
    this.button.textContent = "Add";
    this.message = document.createElement("p");
    this.message.id = "compose-message";
    this.message.className = "compose-message";
    this.message.setAttribute("aria-live", "polite");
    this.restoreDraft();
    this.input.addEventListener("input", () => this.saveDraft());
    this.form.append(
      this.label,
      this.input,
      this.classificationField,
      this.button,
      this.message,
    );
    this.replaceChildren(this.form);
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.classification.addEventListener("change", () => this.saveDraft());
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    this.input.disabled = this.isDisabled;
    this.classification.disabled = this.isDisabled;
    this.button.disabled = this.isDisabled;
  }

  clearIfMatches(submittedDraft) {
    // Completion belongs to the submitted draft, not a newer edit.
    if (
      this.input.value !== submittedDraft.text ||
      this.classification.value !== submittedDraft.classification
    ) {
      return;
    }
    this.input.value = "";
    this.classification.value = "need";
    this.message.textContent = "";
  }

  focusInput() {
    this.input.focus();
  }

  restoreDraft() {
    this.input.value = "";
    this.classification.value = "need";
  }

  saveDraft() {
    // Drafts remain in the unlocked input only; lock replaces the component.
  }

  submit(event) {
    event.preventDefault();
    if (this.isDisabled) {
      return;
    }
    const text = this.input.value;
    const classification = this.classification.value;
    const textLength = textEncoder.encode(text).length;
    if (!text.trim()) {
      this.message.textContent = "Add a few words first.";
      this.input.focus();
      return;
    }
    if (textLength > MAX_ITEM_TEXT_BYTES) {
      this.message.textContent = "Keep the item under 4096 UTF-8 bytes.";
      this.input.focus();
      return;
    }
    this.message.textContent = "";
    this.dispatchEvent(
      new CustomEvent("kin:add-item", {
        detail: { text, classification },
        bubbles: true,
        composed: true,
        cancelable: false,
      }),
    );
  }
}

customElements.define("kin-compose", KinCompose);
