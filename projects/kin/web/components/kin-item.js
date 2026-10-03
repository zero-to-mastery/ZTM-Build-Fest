class KinItem extends HTMLElement {
  constructor() {
    super();
    this.record = null;
    this.isDisabled = false;
  }

  set item(value) {
    this.record = value;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button")) {
      control.disabled = this.isDisabled;
    }
  }

  render() {
    if (!this.record) {
      return;
    }
    const row = document.createElement("div");
    row.className = `item-row item-${this.record.status}`;
    const text = document.createElement("p");
    text.className = "item-text";
    text.textContent = this.record.text;
    const action = document.createElement("div");
    action.className = "item-action";

    if (this.record.status === "active") {
      action.append(
        this.createAction("Complete", "complete", "complete-button"),
      );
    } else {
      const completed = document.createElement("span");
      completed.className = "completed-label";
      completed.textContent = "Completed";
      action.append(completed);
      action.append(this.createAction("Reopen", "reopen", "reopen-button"));
    }
    action.append(this.createAction("Archive", "archive", "archive-button"));

    row.append(text, action);
    this.replaceChildren(row);
  }

  createAction(label, action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${this.record.text}`);
    button.disabled = this.isDisabled;
    button.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent(`kin:${action}-item`, {
          detail: { itemId: this.record.itemId },
          bubbles: true,
          composed: true,
          cancelable: false,
        }),
      );
    });
    return button;
  }
}

customElements.define("kin-item", KinItem);
