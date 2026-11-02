export class MarkdownEditor extends HTMLElement {
  connectedCallback() {
    this.innerHTML =
      '<textarea aria-label="Markdown editor" spellcheck="false" placeholder="# Your next README starts here…"></textarea>';
    this.input = this.querySelector("textarea");
    this.input.addEventListener("input", () =>
      this.dispatchEvent(
        new CustomEvent("markdown-change", {
          detail: this.input.value,
          bubbles: true,
        }),
      ),
    );
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        this.input.setRangeText(
          "  ",
          this.input.selectionStart,
          this.input.selectionEnd,
          "end",
        );
        this.input.dispatchEvent(new Event("input"));
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        ["z", "y"].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        this.dispatchEvent(
          new CustomEvent(
            e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo",
            { bubbles: true },
          ),
        );
      }
    });
  }
  set value(value) {
    if (this.input.value !== value) this.input.value = value;
  }
  get value() {
    return this.input.value;
  }
}
customElements.define("markdown-editor", MarkdownEditor);
