// "Bring a list into Kin" (#452, #453, #457): paste a list or choose a CSV or
// text file, preview the rows, untick any you don't want, and add them. The
// dialog only collects and previews; app/import.js saves the rows through the
// ordinary capture commands. Files are read here, on the device; nothing is
// uploaded.
import { csvRows, guessColumns, hasHeader, MAX_IMPORT_CHARS, parseCsv, parseListText } from "../import/list-import.js";

const LISTS = [["need", "To do"], ["shopping", "Shopping"]];
const FIELDS = [["text", "Text"], ["list", "List"], ["date", "Date"], ["done", "Done"]];
const civil = (value) => {
  const text = String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(+text.slice(0, 4), +text.slice(4, 6) - 1, +text.slice(6, 8)));
};

class KinImport extends HTMLElement {
  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "import-dialog quick-add-dialog";
    this.dialog.setAttribute("aria-labelledby", "import-title");
    const heading = document.createElement("h2");
    heading.id = "import-title";
    heading.textContent = "Bring a list into Kin";

    // Step 1: the source.
    this.source = document.createElement("div");
    this.source.className = "import-source";
    const pasteLabel = document.createElement("label");
    pasteLabel.htmlFor = "import-text";
    pasteLabel.textContent = "Paste a list, one thing per line";
    this.text = document.createElement("textarea");
    this.text.id = "import-text";
    this.text.rows = 6;
    this.text.setAttribute("aria-describedby", "import-text-hint");
    const hint = document.createElement("p");
    hint.id = "import-text-hint";
    hint.className = "quick-add-hint";
    hint.textContent = "Bullets, numbers and checkboxes are removed; ticked boxes come in as done.";
    // The app keeps one file input (attachments); this one exists only
    // while the picker is open, as Chat's does.
    this.fileButton = this.button("Or choose a CSV or text file…", "import-file-button", () => this.chooseFile());
    const listLabel = document.createElement("label");
    listLabel.htmlFor = "import-list";
    listLabel.textContent = "Add to";
    this.list = document.createElement("select");
    this.list.id = "import-list";
    for (const [value, label] of LISTS) this.list.append(new Option(label, value));
    this.previewButton = this.button("Preview", "primary-action", () => this.preview());
    this.source.append(pasteLabel, this.text, hint, this.fileButton, listLabel, this.list, this.previewButton);

    // Step 2: mapping (CSV) and preview.
    this.review = document.createElement("div");
    this.review.className = "import-review";
    this.review.hidden = true;
    this.mapping = document.createElement("fieldset");
    this.mapping.className = "import-mapping";
    const legend = document.createElement("legend");
    legend.textContent = "Columns";
    this.mapping.append(legend);
    this.selects = {};
    for (const [field, label] of FIELDS) {
      const wrap = document.createElement("label");
      wrap.textContent = `${label} `;
      const select = document.createElement("select");
      select.dataset.field = field;
      select.addEventListener("change", () => this.renderRows());
      this.selects[field] = select;
      wrap.append(select);
      this.mapping.append(wrap);
    }
    this.summary = document.createElement("p");
    this.summary.className = "import-summary";
    this.summary.setAttribute("role", "status");
    this.rowsList = document.createElement("ul");
    this.rowsList.className = "import-rows";
    this.rowsList.setAttribute("aria-label", "Rows to add");
    this.error = document.createElement("p");
    this.error.className = "compose-message";
    this.error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "quick-add-actions";
    this.addButton = this.button("Add", "primary-action", () => void this.submit());
    this.back = this.button("Back", "", () => this.showSource());
    actions.append(this.addButton, this.back);
    this.review.append(this.mapping, this.summary, this.rowsList, this.error, actions);

    const cancel = this.button("Cancel", "import-cancel", () => this.close());
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    this.dialog.append(heading, this.source, this.review, cancel);
    this.append(this.dialog);
  }

  button(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  get isOpen() {
    return Boolean(this.dialog?.open);
  }

  /** Opens the dialog; `text` (a pasted list) and `classification` prefill
   * it. `submit(rows)` saves and resolves `{ ok, message }`. */
  open({ text = "", classification = "need", submit, opener = null, existing = [] } = {}) {
    if (!this.dialog) this.connectedCallback();
    if (this.dialog.open || typeof submit !== "function") return false;
    this.submitRows = submit;
    this.opener = opener;
    this.existing = new Set(existing.map((value) => value.toLocaleLowerCase()));
    this.csv = null;
    this.text.value = text;
    this.list.value = classification === "shopping" ? "shopping" : "need";
    this.error.textContent = "";
    this.dialog.showModal();
    if (text) this.preview();
    else this.showSource();
    return true;
  }

  close() {
    if (this.dialog?.open) this.dialog.close();
    this.rows = [];
    this.csv = null;
    this.text.value = "";
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus();
  }

  showSource() {
    this.source.hidden = false;
    this.review.hidden = true;
    this.text.focus();
  }

  chooseFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.txt,text/csv,text/plain";
    input.hidden = true;
    const done = () => input.remove();
    input.addEventListener("change", () => { const file = input.files?.[0]; done(); if (file) void this.readFile(file); });
    input.addEventListener("cancel", done);
    this.dialog.append(input);
    input.click();
  }

  async readFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_CHARS * 4) {
      this.error.textContent = "That file is too large to import. Split it into smaller lists.";
      return;
    }
    const content = await file.text();
    if (/\.csv$/i.test(file.name) || file.type === "text/csv") {
      this.csv = parseCsv(content);
      this.text.value = "";
    } else {
      this.csv = null;
      this.text.value = content;
    }
    this.preview();
  }

  preview() {
    this.error.textContent = "";
    if (this.csv) {
      const header = hasHeader(this.csv[0]);
      this.csvHeader = header;
      const columns = this.csv[0] ?? [];
      const guess = header ? guessColumns(columns) : { text: 0, list: -1, date: -1, done: -1 };
      for (const [field] of FIELDS) {
        const select = this.selects[field];
        select.replaceChildren(new Option(field === "text" ? "Choose a column" : "None", "-1"));
        columns.forEach((name, index) => select.append(new Option(header ? String(name) || `Column ${index + 1}` : `Column ${index + 1}`, String(index))));
        select.value = String(guess[field]);
      }
      this.mapping.hidden = false;
    } else {
      this.mapping.hidden = true;
    }
    this.renderRows();
    this.source.hidden = true;
    this.review.hidden = false;
    (this.rowsList.querySelector("input") ?? this.addButton).focus();
  }

  /** The rows as previewed: `{ text, classification, planningDate, done,
   * duplicate, include }`. */
  computeRows() {
    const fallback = this.list.value;
    if (this.csv) {
      const mapping = Object.fromEntries(FIELDS.map(([field]) => [field, Number(this.selects[field].value)]));
      return csvRows(this.csv, mapping, { header: this.csvHeader, fallback }).rows;
    }
    return parseListText(this.text.value).rows.map((row) => ({ ...row, classification: fallback, planningDate: null }));
  }

  renderRows() {
    this.rows = this.computeRows().map((row) => {
      const already = this.existing.has(row.text.toLocaleLowerCase());
      return { ...row, already, include: !row.duplicate && !already };
    });
    this.rowsList.replaceChildren(...this.rows.map((row, index) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = row.include;
      box.addEventListener("change", () => { row.include = box.checked; this.renderSummary(); });
      const text = document.createElement("span");
      text.className = "import-row-text";
      text.textContent = row.text;
      const meta = document.createElement("span");
      meta.className = "import-row-meta";
      meta.textContent = [
        row.classification === "shopping" ? "Shopping" : "To do",
        row.planningDate ? civil(row.planningDate) : null,
        row.done ? "done" : null,
        row.duplicate ? "repeated in this list" : row.already ? "already in Kin" : null,
      ].filter(Boolean).join(" · ");
      label.append(box, text, " ", meta);
      label.dataset.index = String(index);
      item.append(label);
      return item;
    }));
    this.renderSummary();
  }

  renderSummary() {
    const chosen = this.rows.filter((row) => row.include).length;
    const left = this.rows.length - chosen;
    this.summary.textContent = this.rows.length
      ? `${chosen === 1 ? "1 thing" : `${chosen} things`} to add${left ? ` · ${left} left out` : ""}`
      : "Nothing to add. Check the text or the columns.";
    this.addButton.textContent = chosen === 1 ? "Add 1 item" : `Add ${chosen} items`;
    this.addButton.disabled = chosen === 0;
  }

  async submit() {
    const rows = this.rows.filter((row) => row.include).map(({ text, classification, planningDate, done }) => ({ text, classification, planningDate, done }));
    if (!rows.length) return;
    this.addButton.disabled = true;
    this.error.textContent = "";
    const outcome = await this.submitRows(rows);
    if (outcome?.ok) this.close();
    else {
      this.error.textContent = outcome?.message ?? "Kin couldn't add those. Try again.";
      this.addButton.disabled = false;
    }
  }
}

if (!customElements.get("kin-import")) customElements.define("kin-import", KinImport);
