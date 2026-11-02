// Household Notes: the form that creates or edits one Note (title, body,
// Area) and the list of active Notes with their files.
// Part of <kin-notes>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-notes.js lists them).

export class NotesSection {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  // The Notes form (create or edit one Note) and the list of active Notes,
  // appended to `section`. `id(name)` makes an element id unique per instance.
  renderNotes(section, id) {
    const form = document.createElement("form");
    const titleId = id("title");
    const titleLabel = document.createElement("label");
    titleLabel.htmlFor = titleId;
    titleLabel.textContent = "Title";
    const title = document.createElement("input");
    title.id = titleId;
    title.name = "title";
    title.required = true;
    title.value = this.host.editor.title;
    title.dataset.focusId = "title";
    const titleHelp = document.createElement("small");
    titleHelp.id = id("title-help");
    titleHelp.textContent = "A short title, up to 80 characters.";
    const titleError = this.host.makeError(id("title-error"));
    title.setAttribute("aria-describedby", `${titleHelp.id} ${titleError.id}`);

    const bodyId = id("body");
    const bodyLabel = document.createElement("label");
    bodyLabel.htmlFor = bodyId;
    bodyLabel.textContent = "Body";
    const body = document.createElement("textarea");
    body.id = bodyId;
    body.name = "body";
    body.value = this.host.editor.body;
    body.dataset.focusId = "body";
    const bodyHelp = document.createElement("small");
    bodyHelp.id = id("body-help");
    bodyHelp.textContent = "Plain text. Roughly 4,000 characters fit.";
    const bodyError = this.host.makeError(id("body-error"));
    body.setAttribute("aria-describedby", `${bodyHelp.id} ${bodyError.id}`);

    const areaId = id("area");
    const areaLabel = document.createElement("label");
    areaLabel.htmlFor = areaId;
    areaLabel.textContent = "Area (optional)";
    const area = document.createElement("select");
    area.id = areaId;
    area.name = "areaId";
    area.dataset.focusId = "area";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No area";
    area.append(none);
    for (const item of this.host.areaRecords.filter((candidate) => !candidate.archived)) {
      const option = document.createElement("option");
      option.value = item.areaId;
      option.textContent = item.name;
      area.append(option);
    }
    if (this.host.editor.areaId && ![...area.options].some((option) => option.value === this.host.editor.areaId)) {
      const oldArea = this.host.areaRecords.find((candidate) => candidate.areaId === this.host.editor.areaId);
      const option = document.createElement("option");
      option.value = this.host.editor.areaId;
      option.textContent = `${oldArea?.name ?? "Archived Area"} (archived)`;
      area.append(option);
    }
    area.value = this.host.editor.areaId;

    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = this.host.editor.noteId ? "Save changes" : "Save note";
    save.dataset.focusId = "save";
    for (const [control, key] of [[title, "title"], [body, "body"], [area, "areaId"]]) {
      const update = () => { this.host.editor[key] = control.value; };
      control.addEventListener("input", update);
      control.addEventListener("change", update);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.host.editor = { noteId: this.host.editor.noteId, title: title.value, body: body.value, areaId: area.value };
      const result = this.host.constructor.validateText(title.value, body.value);
      this.host.showFieldError(title, titleError, result.field === "title" ? result.error : "");
      this.host.showFieldError(body, bodyError, result.field === "body" ? result.error : "");
      if (result.error) {
        (result.field === "title" ? title : body).focus();
        return;
      }
      this.host.editor.title = result.title;
      this.host.pendingFocus = "title";
      this.host.dispatch(this.host.editor.noteId ? "update-note" : "create-note", {
        ...(this.host.editor.noteId ? { noteId: this.host.editor.noteId } : {}),
        title: result.title,
        body: result.body,
        areaId: area.value || null,
      });
    });
    form.append(titleLabel, title, titleHelp, titleError, bodyLabel, body, bodyHelp, bodyError, areaLabel, area, save);
    section.append(form);

    const activeNotes = this.host.records.filter((note) => !note.archived);
    if (!activeNotes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No notes yet. Keep a household detail handy here.";
      section.append(empty);
    }
    const groups = [];
    const unassigned = [];
    for (const note of activeNotes) {
      const key = note.areaId || "";
      if (!key) {
        unassigned.push(note);
        continue;
      }
      let group = groups.find((candidate) => candidate.key === key);
      if (!group) {
        group = { key, notes: [] };
        groups.push(group);
      }
      group.notes.push(note);
    }
    const appendGroup = (label, notes) => {
      const heading = document.createElement("h3");
      heading.className = "note-group";
      heading.textContent = label;
      const list = document.createElement("ul");
      for (const note of notes) list.append(this.noteRow(note, id, activeNotes));
      section.append(heading, list);
    };
    for (const group of groups) {
      const linkedArea = this.host.areaRecords.find((candidate) => candidate.areaId === group.key);
      appendGroup(
        linkedArea
          ? `${linkedArea.name}${linkedArea.archived ? " (archived Area)" : ""}`
          : "Archived Area",
        group.notes,
      );
    }
    if (unassigned.length) appendGroup("No area", unassigned);
  }

  noteRow(note, id, activeNotes) {
    const row = document.createElement("li");
    row.className = "note-row";
    row.dataset.noteId = note.noteId;
    row.tabIndex = -1;
    const name = document.createElement("h4");
    name.textContent = note.title;
    const text = document.createElement("p");
    text.className = "note-body";
    text.textContent = note.body;
    row.append(name, text);
    row.append(this.host.makeAttachmentControl("note", note.noteId, note.title));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.dataset.focusId = `edit-${note.noteId}`;
    edit.addEventListener("click", () => {
      this.host.editor = { noteId: note.noteId, title: note.title, body: note.body, areaId: note.areaId ?? "" };
      this.host.pendingFocus = "title";
      this.host.render();
      this.host.querySelector(`#${id("title")}`)?.focus();
    });
    const archive = document.createElement("button");
    archive.type = "button";
    archive.textContent = "Archive";
    archive.dataset.focusId = `archive-${note.noteId}`;
    archive.addEventListener("click", () => {
      this.host.pendingFocus = activeNotes.length > 1
        ? `edit-${activeNotes.find((item) => item.noteId !== note.noteId).noteId}`
        : "heading";
      this.host.dispatch("archive-note", { noteId: note.noteId });
    });
    row.append(edit, archive);
    return row;
  }
}
