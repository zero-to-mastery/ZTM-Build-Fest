// Visual forms for the Markdown blocks the Visual editor used to protect (callouts,
// tables, task lists, embeds, pieces) and the "Add something" dialog (ADR 0254).
//
// Everything here writes the Markdown those blocks already use. A block that is
// not edited is never touched, so a round trip stays byte-stable. The piece forms
// are built from the engine's own schema (`meta.pieces`, ADR 0253); the engine
// validates and writes a piece, so this file never invents piece Markdown.
//
// The pieces dialog and the form builder are reusable on purpose: the landing page
// workspace can show the same forms with `buildPieceForm` and `openPieceDialog`.

/** A small DOM builder. Nothing user-controlled is ever assigned through innerHTML. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (["value", "checked", "disabled", "selected"].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const trimEnd = (source) => String(source).replace(/\n+$/, "");
let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

// ----- callouts ------------------------------------------------------------------------

export const CALLOUT_KINDS = [
  ["NOTE", "Note"],
  ["TIP", "Tip"],
  ["IMPORTANT", "Important"],
  ["WARNING", "Warning"],
  ["CAUTION", "Caution"],
];

/** `> [!KIND]` then `> text` lines, as `{ kind, text }`; `null` when the block is anything else. */
export function parseCallout(source) {
  const lines = trimEnd(source).split("\n");
  const first = /^ {0,3}>\s*\[!([A-Za-z]+)\]\s*$/.exec(lines[0] || "");
  if (!first || !CALLOUT_KINDS.some(([kind]) => kind === first[1].toUpperCase())) return null;
  const body = [];
  for (const line of lines.slice(1)) {
    const match = /^ {0,3}>(?: ?)(.*)$/.exec(line);
    if (!match) return null;
    body.push(match[1]);
  }
  const callout = { kind: first[1].toUpperCase(), text: body.join("\n") };
  // Offer the form only when it would write exactly what is there now.
  return calloutMarkdown(callout) === trimEnd(source) ? callout : null;
}

export function calloutMarkdown({ kind, text }) {
  const body = String(text).replace(/\s+$/, "").split("\n").map((line) => (line ? `> ${line}` : ">"));
  return [`> [!${kind}]`, ...body].join("\n");
}

// ----- task lists ----------------------------------------------------------------------

/** `- [ ] item` lines as `[{ checked, text }]`; `null` for nesting, plain items or anything else. */
export function parseTaskList(source) {
  const items = [];
  for (const line of trimEnd(source).split("\n")) {
    const match = /^[-*+] \[([ xX])\] (.*)$/.exec(line);
    if (!match) return null;
    items.push({ checked: match[1] !== " ", text: match[2] });
  }
  // Offer the form only when it would write exactly what is there now.
  return items.length && taskListMarkdown(items) === trimEnd(source) ? items : null;
}

export function taskListMarkdown(items) {
  return items.map(({ checked, text }) => `- [${checked ? "x" : " "}] ${String(text).replace(/\s*\n\s*/g, " ").trim()}`).join("\n");
}

// ----- tables --------------------------------------------------------------------------

const splitRow = (line) => {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
};

/** A GitHub table as `{ header, align, rows }`; `null` when a row has the wrong number of cells or holds code with a bar. */
export function parseTable(source) {
  const lines = trimEnd(source).split("\n");
  if (lines.length < 2 || !lines[0].includes("|")) return null;
  const header = splitRow(lines[0]);
  const divider = splitRow(lines[1]);
  if (divider.length !== header.length || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const rows = [];
  for (const line of lines.slice(2)) {
    if (!line.trim()) return null;
    // A bar inside inline code is a cell break to the parser but looks like text here: leave it protected.
    if (/`[^`]*(?<!\\)\|[^`]*`/.test(line)) return null;
    const cells = splitRow(line);
    if (cells.length !== header.length) return null;
    rows.push(cells);
  }
  if (/`[^`]*(?<!\\)\|[^`]*`/.test(lines[0])) return null;
  const align = divider.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
  const table = { header, align, rows };
  // Offer the form only when it would write exactly what is there now.
  return tableMarkdown(table) === trimEnd(source) ? table : null;
}

export function tableMarkdown({ header, align, rows }) {
  const cell = (text) => String(text).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
  const line = (cells) => `| ${cells.map(cell).join(" | ")} |`;
  const divider = header.map((_, index) => ({ center: ":---:", right: "---:", left: ":---" })[align[index]] || "---");
  return [line(header), `| ${divider.join(" | ")} |`, ...rows.map(line)].join("\n");
}

// ----- embeds --------------------------------------------------------------------------

export const EMBED_PROVIDERS = [
  ["youtube", "YouTube", /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^\s]*v=[\w-]{11}[^\s]*|youtu\.be\/[\w-]{11}[^\s]*|youtube\.com\/shorts\/[\w-]{11}[^\s]*)$/i, "https://www.youtube.com/watch?v=..."],
  ["codepen", "CodePen", /^https?:\/\/(?:www\.)?codepen\.io\/[\w-]+\/(?:pen|full|details|embed|debug)\/[\w-]+[^\s]*$/i, "https://codepen.io/name/pen/..."],
];

/** A line that is only an address the site embeds, as `{ provider, url }`. */
export function parseEmbed(source) {
  const url = trimEnd(source).trim();
  if (url.includes("\n")) return null;
  const found = EMBED_PROVIDERS.find(([, , pattern]) => pattern.test(url));
  return found ? { provider: found[0], url } : null;
}

export function embedProblem(provider, url) {
  const found = EMBED_PROVIDERS.find(([id]) => id === provider);
  const value = String(url).trim();
  if (!found) return "Choose where the embed comes from.";
  if (!value) return `Enter the ${found[1]} address.`;
  if (!found[2].test(value)) return `That is not a ${found[1]} address the site can embed. It looks like ${found[3]}`;
  return "";
}

// ----- pieces (the ```piece fence) -----------------------------------------------------

/** Read a `piece` fence, or a `compare` fence, into `{ kind, values }` for the form; the engine validates on save. */
export function parsePieceFence(source, schema = null) {
  const lines = trimEnd(source).split("\n");
  const open = /^ {0,3}(`{3,})(?:piece[ \t]+([a-z]+)|(compare))[ \t]*$/.exec(lines[0] || "");
  if (!open) return null;
  const close = lines[lines.length - 1];
  if (lines.length < 2 || !new RegExp(`^ {0,3}\`{${open[1].length},}[ \\t]*$`).test(close)) return null;
  const values = [];
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("  ")) {
      if (!values.length) return null;
      values[values.length - 1][1] += `\n${line.slice(2)}`;
    } else if (!line.trim()) {
      if (values.length) values[values.length - 1][1] += "\n";
    } else {
      const match = /^([a-z][a-z-]*): ?(.*)$/.exec(line);
      if (!match) return null;
      values.push([match[1], match[2]]);
    }
  }
  for (const pair of values) pair[1] = pair[1].replace(/\n+$/, "");
  // With the schema known, a field it does not have, or a repeat of a field that is not a list field,
  // is something the form would drop or merge: leave the block protected.
  if (schema) {
    const top = new Set(schema.fields.map((field) => field.name));
    const listNames = new Set((schema.list?.fields || []).map((field) => field.name));
    const seen = new Set();
    for (const [name] of values) {
      if (!top.has(name) && !listNames.has(name)) return null;
      if (top.has(name) && seen.has(name)) return null;
      seen.add(name);
    }
  }
  return { kind: open[2] || open[3], values };
}

/** Which form edits a protected block, or "" when none does (it stays protected). */
export function editableBlockKind(label, source, pieces = []) {
  if (label === "Callout") return parseCallout(source) ? "callout" : "";
  if (label === "Table") return parseTable(source) ? "table" : "";
  if (label === "Task list") return parseTaskList(source) ? "tasklist" : "";
  if (label === "Embedded media") return parseEmbed(source) ? "embed" : "";
  if (label === "Piece" || label === "Before and after") {
    const parsed = parsePieceFence(source);
    if (!parsed) return "";
    if (!pieces.length) return "piece";
    const schema = pieces.find((piece) => piece.kind === parsed.kind);
    return schema && parsePieceFence(source, schema) ? "piece" : "";
  }
  return "";
}

// ----- shared form pieces --------------------------------------------------------------

const stop = (event) => event.stopPropagation();

/** A labelled field row: label, control, hint, all linked for screen readers. */
function fieldRow(label, control, hint = "") {
  const id = nextId("oba-bf");
  control.id = id;
  const describedBy = [];
  const hintNode = hint ? el("p", { class: "oba-small oba-bf-hint", id: `${id}-hint` }, hint) : null;
  if (hintNode) describedBy.push(hintNode.id);
  if (describedBy.length) control.setAttribute("aria-describedby", describedBy.join(" "));
  return el("div", { class: "oba-field oba-bf-field" }, el("label", { for: id }, label), control, hintNode);
}

function actionButton(label, onClick, extra = {}) {
  return el("button", { type: "button", class: "oba-btn oba-bf-button", onClick, ...extra }, label);
}

/** True when text has `<` then a letter, `/`, `!` or `?`: markup a post would render live. */
export function hasHtmlTag(value) {
  return /<[A-Za-z/!?]/.test(String(value));
}

/** The editors below all return `{ element, read(), focus() }`; `read` gives `{ markdown }` or `{ problem }`. */
export function calloutEditor(source) {
  const initial = parseCallout(source);
  const kind = el("select", {}, CALLOUT_KINDS.map(([value, label]) => el("option", { value, selected: value === initial.kind }, label)));
  const text = el("textarea", { rows: 5 });
  text.value = initial.text;
  return {
    element: el("div", { class: "oba-bf-body" }, fieldRow("Kind of callout", kind), fieldRow("Callout text", text, "Markdown. A blank line starts a new paragraph.")),
    read: () => {
      if (!text.value.trim()) return { problem: "Add some text to the callout." };
      if (hasHtmlTag(text.value)) return { problem: "HTML tags are not allowed in a callout." };
      return { markdown: calloutMarkdown({ kind: kind.value, text: text.value }) };
    },
    focus: () => kind.focus(),
  };
}

export function taskListEditor(source) {
  const items = parseTaskList(source);
  const list = el("ul", { class: "oba-bf-rows", "aria-label": "Task list items" });
  const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite" });
  const renumber = () => {
    [...list.children].forEach((row, index) => {
      row.querySelector("input[type=checkbox]").setAttribute("aria-label", `Item ${index + 1} done`);
      row.querySelector("input[type=text]").setAttribute("aria-label", `Item ${index + 1} text`);
      row.querySelector("button").setAttribute("aria-label", `Remove item ${index + 1}`);
    });
  };
  const addRow = (item, focus = false) => {
    const check = el("input", { type: "checkbox", checked: item.checked });
    const text = el("input", { type: "text", value: item.text, autocomplete: "off" });
    const row = el("li", { class: "oba-bf-row" }, check, text, actionButton("Remove", () => {
      const index = [...list.children].indexOf(row);
      row.remove();
      renumber();
      status.textContent = `Item ${index + 1} removed.`;
      (list.children[Math.min(index, list.children.length - 1)]?.querySelector("input[type=text]") || add).focus();
    }));
    list.append(row);
    renumber();
    if (focus) text.focus();
  };
  items.forEach((item) => addRow(item));
  const add = actionButton("Add item", () => {
    addRow({ checked: false, text: "" }, true);
    status.textContent = `Item ${list.children.length} added.`;
  });
  return {
    element: el("div", { class: "oba-bf-body" }, list, add, status),
    read: () => {
      const rows = [...list.children].map((row) => ({ checked: row.querySelector("input[type=checkbox]").checked, text: row.querySelector("input[type=text]").value }));
      if (!rows.length || rows.some((row) => !row.text.trim())) return { problem: "Every task needs some text. Fill in or remove the empty ones." };
      return { markdown: taskListMarkdown(rows) };
    },
    focus: () => (list.querySelector("input[type=text]") || add).focus(),
  };
}

export function tableEditor(source) {
  const model = parseTable(source);
  const grid = el("table", { class: "oba-bf-table" });
  const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite" });
  const say = (message) => {
    status.textContent = message;
  };
  const cellInput = (value) => el("input", { type: "text", value, autocomplete: "off" });
  const header = model.header.map((text) => text);
  const body = model.rows.map((row) => [...row]);
  const align = [...model.align];
  const draw = (focusAt = null) => {
    grid.replaceChildren(
      el("caption", { class: "oba-small" }, "Table. The first row is the header."),
      el(
        "tbody",
        {},
        [header, ...body].map((cells, rowIndex) =>
          el(
            "tr",
            {},
            cells.map((text, column) => {
              const input = cellInput(text);
              input.setAttribute("aria-label", rowIndex === 0 ? `Header, column ${column + 1}` : `Row ${rowIndex}, column ${column + 1}`);
              input.addEventListener("input", () => {
                (rowIndex === 0 ? header : body[rowIndex - 1])[column] = input.value;
              });
              return el("td", {}, input);
            }),
            rowIndex === 0
              ? null
              : el("td", {}, actionButton("Remove row", () => {
                  body.splice(rowIndex - 1, 1);
                  say(`Row ${rowIndex} removed.`);
                  draw({ row: Math.min(rowIndex, body.length), column: 0 });
                }, { "aria-label": `Remove row ${rowIndex}` })),
          ),
        ),
      ),
      el(
        "tfoot",
        {},
        el(
          "tr",
          {},
          header.map((_, column) =>
            el("td", {}, actionButton("Remove column", () => {
              header.splice(column, 1);
              body.forEach((row) => row.splice(column, 1));
              align.splice(column, 1);
              say(`Column ${column + 1} removed.`);
              draw({ row: 0, column: Math.min(column, header.length - 1) });
            }, { "aria-label": `Remove column ${column + 1}`, disabled: header.length < 2 })),
          ),
        ),
      ),
    );
    if (focusAt) grid.querySelectorAll("tbody tr")[focusAt.row]?.querySelectorAll("input")[focusAt.column]?.focus();
  };
  draw();
  const addRow = actionButton("Add row", () => {
    body.push(header.map(() => ""));
    say(`Row ${body.length} added.`);
    draw({ row: body.length, column: 0 });
  });
  const addColumn = actionButton("Add column", () => {
    header.push("");
    body.forEach((row) => row.push(""));
    align.push("");
    say(`Column ${header.length} added.`);
    draw({ row: 0, column: header.length - 1 });
  });
  return {
    element: el("div", { class: "oba-bf-body" }, el("div", { class: "oba-bf-scroll", tabindex: "-1" }, grid), el("div", { class: "oba-bf-actions" }, addRow, addColumn), status),
    read: () => (header.some((cell) => cell.trim()) ? { markdown: tableMarkdown({ header, align, rows: body }) } : { problem: "Give at least one column a header." }),
    focus: () => grid.querySelector("input")?.focus(),
  };
}

export function embedEditor(source) {
  const initial = parseEmbed(source);
  const provider = el("select", {}, EMBED_PROVIDERS.map(([id, label]) => el("option", { value: id, selected: id === initial.provider }, label)));
  const url = el("input", { type: "text", inputmode: "url", autocomplete: "off", value: initial.url });
  return {
    element: el("div", { class: "oba-bf-body" }, fieldRow("Embed from", provider), fieldRow("Address", url, "The address of the video or pen. It is shown as a frame with a plain link.")),
    read: () => {
      const problem = embedProblem(provider.value, url.value);
      return problem ? { problem } : { markdown: url.value.trim() };
    },
    focus: () => provider.focus(),
  };
}

// ----- the piece form (shared with the landing page workspace) --------------------------

function controlFor(field, value) {
  if (field.input === "choice") {
    const select = el("select", {}, field.options.map((option) => el("option", { value: option.value }, option.label)));
    select.value = field.options.some((option) => option.value === value) ? value : field.options[0].value;
    return select;
  }
  if (field.input === "textarea") {
    const area = el("textarea", { rows: 4, maxlength: field.max || null });
    area.value = value || "";
    return area;
  }
  const modes = { url: "url", email: "email", tel: "tel", number: "decimal", image: "url" };
  return el("input", { type: "text", inputmode: modes[field.input] || null, autocomplete: "off", maxlength: field.max || null, value: value || "" });
}

/**
 * A file picker under a picture's address field: the file is uploaded by the Admin's own upload and its
 * address is written into the field. `upload(file)` resolves to the address, or null when it failed.
 */
function pictureChooser(field, control, upload) {
  const picker = el("input", { type: "file", accept: "image/*", id: nextId("oba-bf-file"), "data-picture-for": field.name });
  const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite" });
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return;
    status.textContent = `Uploading ${file.name}…`;
    picker.disabled = true;
    try {
      const address = await upload(file);
      if (address) {
        control.value = address;
        status.textContent = `Added ${file.name}.`;
      } else {
        status.textContent = `${file.name} could not be uploaded. Type its address instead, or try again.`;
      }
    } catch {
      status.textContent = `${file.name} could not be uploaded. Type its address instead, or try again.`;
    } finally {
      picker.disabled = false;
      picker.value = "";
    }
  });
  return el(
    "div",
    { class: "oba-field oba-bf-field oba-bf-picture" },
    el("label", { for: picker.id }, `Or choose a file for the ${field.label.toLowerCase()}`),
    picker,
    status,
  );
}

/**
 * The form for one piece, built from the engine's schema entry. `values()` gives the
 * ordered `[field, value]` pairs the engine takes (empty optional fields left out).
 * `showProblems(list)` marks the form with what the engine refused.
 */
export function buildPieceForm(schema, initialValues = [], { upload = null } = {}) {
  const problems = el("div", { class: "oba-error oba-bf-problems", role: "alert", hidden: true });
  const root = el("div", { class: "oba-bf-body" });
  const top = new Map();
  const firstFor = (name) => initialValues.find(([n]) => n === name)?.[1] || "";
  const required = (field) => (field.required ? " (required)" : "");
  for (const field of schema.fields) {
    const control = controlFor(field, firstFor(field.name));
    if (field.required) control.setAttribute("aria-required", "true");
    top.set(field.name, control);
    root.append(fieldRow(`${field.label}${required(field)}`, control, field.hint));
    if (field.input === "image" && upload) root.append(pictureChooser(field, control, upload));
  }
  let rows = null;
  let listStatus = null;
  const makeItem = (values = {}) => ({ controls: schema.list.fields.map((field) => [field, controlFor(field, values[field.name] || "")]) });
  const itemEntries = [];
  if (schema.list) {
    const list = schema.list;
    rows = el("ol", { class: "oba-bf-items", "aria-label": list.label });
    listStatus = el("p", { class: "oba-small", role: "status", "aria-live": "polite" });
    const label = (entry, index) => {
      entry.element.setAttribute("aria-label", `${list.label.replace(/s$/, "")} ${index + 1}`);
      entry.remove.setAttribute("aria-label", `Remove ${list.label.toLowerCase().replace(/s$/, "")} ${index + 1}`);
    };
    const relabel = () => itemEntries.forEach((entry, index) => label(entry, index));
    const addItem = (values = {}, focus = false) => {
      const item = makeItem(values);
      const remove = actionButton("Remove", () => {
        const index = itemEntries.indexOf(entry);
        itemEntries.splice(index, 1);
        entry.element.remove();
        relabel();
        listStatus.textContent = `${list.label.replace(/s$/, "")} ${index + 1} removed.`;
        (itemEntries[Math.min(index, itemEntries.length - 1)]?.item.controls[0][1] || addButton).focus();
        addButton.disabled = itemEntries.length >= list.max;
      });
      const element = el("li", { class: "oba-bf-item", role: "group" }, item.controls.map(([field, control]) => {
        if (field.required) control.setAttribute("aria-required", "true");
        return fieldRow(`${field.label}${required(field)}`, control, field.hint);
      }), remove);
      const entry = { item, element, remove };
      itemEntries.push(entry);
      rows.append(element);
      relabel();
      addButton.disabled = itemEntries.length >= list.max;
      if (focus) item.controls[0][1].focus();
    };
    const addButton = actionButton(`Add ${list.label.toLowerCase().replace(/s$/, "")}`, () => {
      addItem({}, true);
      listStatus.textContent = `${list.label.replace(/s$/, "")} ${itemEntries.length} added.`;
    });
    // Existing items: a new item starts at each repeat of the list's first field.
    const names = list.fields.map((field) => field.name);
    let current = null;
    for (const [name, value] of initialValues) {
      if (!names.includes(name)) continue;
      if (name === names[0] || !current) {
        current = {};
        addItem(current);
      }
      current[name] = value;
      const entry = itemEntries[itemEntries.length - 1];
      const control = entry.item.controls.find(([field]) => field.name === name)?.[1];
      if (control) control.value = value;
    }
    if (!itemEntries.length) addItem({});
    root.append(rows, addButton, listStatus);
  }
  root.append(problems);
  return {
    element: root,
    values() {
      const out = [];
      for (const [name, control] of top) if (control.value.trim()) out.push([name, control.value.trim()]);
      for (const entry of itemEntries) {
        for (const [field, control] of entry.item.controls) {
          // A required field is always sent, so the engine can say it is missing.
          if (control.value.trim() || field.required) out.push([field.name, control.value.trim()]);
        }
      }
      return out;
    },
    showProblems(list) {
      problems.replaceChildren(el("p", {}, "Check these details:"), el("ul", {}, list.map((text) => el("li", {}, text))));
      problems.hidden = !list.length;
    },
    clearProblems() {
      problems.hidden = true;
    },
    focus: () => (top.values().next().value || itemEntries[0]?.item.controls[0][1])?.focus(),
  };
}

// ----- the Add something dialog --------------------------------------------------------

const PIECE_BLURB = { callout: "A highlighted note, tip or warning." };

/**
 * A modal dialog that lists the pieces in plain words, asks for one piece's details and
 * hands the checked Markdown to `onInsert(markdown, schema)`, which returns "" when it was
 * inserted or a sentence saying why not (the dialog then stays open and keeps the details).
 *
 *   pieces   the engine's schema list (`meta.pieces`)
 *   build    async (kind, values) => ({ markdown } | { problems: [..] }); the engine checks and writes
 *   onInsert called with the Markdown; may be async
 *   onClose  called after the dialog has closed, to put focus back in the editor
 *
 * The landing page workspace can call this too: pass its own `onInsert` and `build`.
 */
export function openPieceDialog({ pieces, build, onInsert, onClose, upload = null, heading = "Add something" }) {
  const dialog = el("dialog", { class: "oba-dialog oba-piece-dialog", "aria-labelledby": "oba-piece-title" });
  const body = el("div", { class: "oba-piece-dialog-body" });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose?.();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // Keys typed in the dialog are the dialog's, never the editor's behind it.
  dialog.addEventListener("keydown", stop);
  const title = el("h2", { id: "oba-piece-title" }, heading);
  const step = el("h3", { class: "oba-piece-step" });
  const showList = () => {
    step.textContent = "What would you like to add?";
    const buttons = pieces.map((piece) =>
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: "oba-piece-choice", "data-piece": piece.kind, onClick: () => showForm(piece) },
          el("strong", {}, piece.label),
          el("span", { class: "oba-small" }, PIECE_BLURB[piece.kind] || piece.summary),
        ),
      ),
    );
    body.replaceChildren(
      el("p", { class: "oba-help" }, "Choose what to add. It goes in at the caret, and you can change its details later."),
      el("ul", { class: "oba-piece-choices" }, buttons),
      el("div", { class: "oba-dialog-actions" }, el("span", { class: "oba-spacer" }), actionButton("Cancel", close)),
    );
    body.querySelector("button")?.focus();
  };
  const showForm = (piece) => {
    step.textContent = piece.label;
    const form = buildPieceForm(piece, [], { upload });
    const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite" });
    let busy = false;
    const insert = actionButton("Insert", async () => {
      if (busy) return;
      busy = true;
      insert.disabled = true;
      status.textContent = "Checking…";
      form.clearProblems();
      try {
        const result = await build(piece.kind, form.values());
        if (result.problems?.length) {
          form.showProblems(result.problems);
          status.textContent = "";
          return;
        }
        const refusal = await onInsert(result.markdown, piece);
        if (refusal) {
          form.showProblems([refusal]);
          status.textContent = "";
          return;
        }
        close();
      } catch (error) {
        form.showProblems([`This could not be added: ${error.message}. Your draft is unchanged.`]);
        status.textContent = "";
      } finally {
        busy = false;
        insert.disabled = false;
      }
    }, { class: "oba-btn oba-btn-primary oba-bf-button" });
    const back = actionButton("Back", showList);
    body.replaceChildren(
      el("p", { class: "oba-help" }, piece.summary),
      form.element,
      el("div", { class: "oba-dialog-actions" }, back, el("span", { class: "oba-spacer" }), actionButton("Cancel", close), insert),
      status,
    );
    form.focus();
  };
  dialog.append(title, step, body);
  document.body.append(dialog);
  dialog.showModal();
  showList();
  return { dialog, close };
}

// ----- editing a protected block in place ----------------------------------------------

/**
 * The form that edits a protected block, for the editor to place inside the block's card.
 * `kind` is `editableBlockKind(...)`; `source` is the block's Markdown. For a piece, `pieces`
 * is the engine's schema list and `build` checks and writes the piece.
 * Returns `{ element, read(), focus() }` where `read()` resolves to `{ markdown }` or `{ problem }`.
 */
export function blockEditor(kind, source, { pieces = [], build, upload = null } = {}) {
  if (kind === "callout") return wrapRead(calloutEditor(source));
  if (kind === "tasklist") return wrapRead(taskListEditor(source));
  if (kind === "table") return wrapRead(tableEditor(source));
  if (kind === "embed") return wrapRead(embedEditor(source));
  const kindOnly = parsePieceFence(source);
  const schema = pieces.find((piece) => piece.kind === kindOnly?.kind);
  const parsed = schema ? parsePieceFence(source, schema) : null;
  if (!parsed || !schema) return null;
  const form = buildPieceForm(schema, parsed.values, { upload });
  const snapshot = JSON.stringify(form.values());
  return {
    element: form.element,
    focus: form.focus,
    async read() {
      form.clearProblems();
      // Nothing changed: hand back the block exactly as it was, however it was written.
      if (JSON.stringify(form.values()) === snapshot) return { markdown: source };
      const result = await build(schema.kind, form.values());
      if (result.problems?.length) {
        form.showProblems(result.problems);
        return { problem: "Some details need attention." };
      }
      return { markdown: trimEnd(result.markdown) };
    },
  };
}

const wrapRead = (editor) => ({ ...editor, read: async () => editor.read() });
