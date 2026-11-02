// A member's journal page (#497, #501, #504; ADR 0019): dated entries only
// the member's own devices can read. A list newest first under date
// headings, an editor (date, optional title, plain-text body, photos), local
// search, a month jump and a quiet "On this day". No streaks, prompts,
// counts or reminders (PRODUCT-BOUNDARIES).
//
// The element only draws and collects; the journal controller
// (app/journal.js) does the work through `services`:
//   save(draft) -> { ok, entryId?, message? }
//   remove(entryId) / restore(entryId) -> { ok, message? }
//   addPhotos(files) -> { photos, message? }
//   thumbnail(photo) -> object URL or null (still on its way)
//   view(photo, opener)
//   discard(refs) (photos no longer wanted, once their Undo has passed)
//
// The draft lives in this element only, while Kin is unlocked: locking
// replaces the element, as it does every Kin draft (STORAGE.md). It is kept
// as it is typed, so leaving the page or closing the editor keeps it.
import { MAX_JOURNAL_PHOTOS, MAX_JOURNAL_TITLE_BYTES } from "../wasm/kin-private.js";
import { formatJournalDate, formatJournalMonth, groupByDate, journalMonths, onThisDay, photoRefs, searchJournal, todayCivilDate, yearsAgo } from "../private/journal-view.js";

const LOCK_GLYPH = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

const UNAVAILABLE = {
  account: "Your journal needs your Kin account on this device, so that only you can open it.",
  off: "Your household has turned off private storage for children and teens, so the journal isn't available.",
  guest: "The journal isn't available to guests.",
  unreachable: "Your journal can't open on this device right now. Kin will keep trying.",
};

let ids = 0;

class KinJournal extends HTMLElement {
  constructor() {
    super();
    this.services = null;
    this.status = "account";
    this.entries = [];
    this.today = todayCivilDate();
    this.query = "";
    this.draft = null;
    this.undo = null;
    this.opener = null;
    this.busy = false;
  }

  connectedCallback() {
    if (this.workspace) return;
    const id = (name) => `journal-${name}-${(ids += 1)}`;
    this.privacy = document.createElement("p");
    this.privacy.className = "journal-only-you";
    this.privacy.innerHTML = LOCK_GLYPH;
    const privacyText = document.createElement("span");
    privacyText.textContent = "Only you can see this.";
    this.privacy.append(privacyText);

    this.unavailable = document.createElement("div");
    this.unavailable.className = "journal-unavailable";
    this.unavailableText = document.createElement("p");
    this.accountLink = document.createElement("a");
    this.accountLink.href = "#household/people";
    this.accountLink.className = "journal-account-link";
    this.accountLink.textContent = "Set up your account";
    this.unavailable.append(this.unavailableText, this.accountLink);

    this.workspace = document.createElement("div");
    this.workspace.className = "journal-workspace";

    // Tools: a new entry, search, and a month jump.
    const tools = document.createElement("div");
    tools.className = "journal-tools";
    this.newButton = document.createElement("button");
    this.newButton.type = "button";
    this.newButton.className = "primary-action journal-new";
    this.newButton.textContent = "New entry";
    this.newButton.addEventListener("click", () => this.openEditor(null, this.newButton));
    const searchField = document.createElement("div");
    searchField.className = "journal-field journal-search";
    const searchLabel = document.createElement("label");
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.id = id("search");
    this.search.autocomplete = "off";
    searchLabel.htmlFor = this.search.id;
    searchLabel.textContent = "Search your journal";
    this.search.addEventListener("input", () => { this.query = this.search.value; this.renderList(); });
    searchField.append(searchLabel, this.search);
    const monthField = document.createElement("div");
    monthField.className = "journal-field journal-month";
    const monthLabel = document.createElement("label");
    this.month = document.createElement("select");
    this.month.id = id("month");
    monthLabel.htmlFor = this.month.id;
    monthLabel.textContent = "Jump to a month";
    this.month.addEventListener("change", () => this.jumpToMonth(this.month.value));
    monthField.append(monthLabel, this.month);
    tools.append(this.newButton, searchField, monthField);
    this.draftNote = document.createElement("p");
    this.draftNote.className = "section-hint journal-draft-note";
    this.draftNote.hidden = true;

    // Undo, after a delete or a photo removed: it stays until the next
    // action or until dismissed (never timed, WCAG 2.2.1).
    this.undoBar = document.createElement("div");
    this.undoBar.className = "journal-undo";
    this.undoBar.hidden = true;
    this.undoText = document.createElement("p");
    this.undoText.id = id("undo");
    this.undoButton = document.createElement("button");
    this.undoButton.type = "button";
    this.undoButton.textContent = "Undo";
    this.undoButton.setAttribute("aria-describedby", this.undoText.id);
    this.undoButton.addEventListener("click", () => void this.runUndo());
    const undoDismiss = document.createElement("button");
    undoDismiss.type = "button";
    undoDismiss.className = "journal-undo-dismiss";
    undoDismiss.setAttribute("aria-label", "Dismiss");
    undoDismiss.textContent = "×";
    undoDismiss.addEventListener("click", () => this.settleUndo({ focus: true }));
    this.undoBar.append(this.undoText, this.undoButton, undoDismiss);
    // Polite announcements: saved, deleted, search results.
    this.announcer = document.createElement("p");
    this.announcer.className = "visually-hidden";
    this.announcer.setAttribute("role", "status");
    this.announcer.setAttribute("aria-live", "polite");

    this.buildEditor(id);

    this.onThisDaySection = document.createElement("section");
    this.onThisDaySection.className = "journal-on-this-day";
    this.onThisDaySection.hidden = true;
    const onThisDayHeading = document.createElement("h2");
    onThisDayHeading.id = id("on-this-day");
    onThisDayHeading.textContent = "On this day";
    this.onThisDaySection.setAttribute("aria-labelledby", onThisDayHeading.id);
    this.onThisDayList = document.createElement("ul");
    this.onThisDaySection.append(onThisDayHeading, this.onThisDayList);

    this.empty = document.createElement("p");
    this.empty.className = "journal-empty";
    this.list = document.createElement("div");
    this.list.className = "journal-list";

    this.workspace.append(tools, this.draftNote, this.undoBar, this.editor, this.onThisDaySection, this.empty, this.list);
    this.append(this.privacy, this.unavailable, this.workspace, this.announcer);
    this.render();
  }

  buildEditor(id) {
    this.editor = document.createElement("section");
    this.editor.className = "journal-editor";
    this.editor.hidden = true;
    this.editorTitle = document.createElement("h2");
    this.editorTitle.id = id("editor");
    this.editorTitle.tabIndex = -1;
    this.editor.setAttribute("aria-labelledby", this.editorTitle.id);
    const field = (labelText, control, hint = null) => {
      const wrap = document.createElement("div");
      wrap.className = "journal-field";
      const label = document.createElement("label");
      control.id = id("field");
      label.htmlFor = control.id;
      label.textContent = labelText;
      wrap.append(label, control);
      if (hint) {
        const note = document.createElement("p");
        note.className = "section-hint";
        note.id = id("hint");
        note.textContent = hint;
        control.setAttribute("aria-describedby", note.id);
        wrap.append(note);
      }
      return wrap;
    };
    this.dateInput = document.createElement("input");
    this.dateInput.type = "date";
    this.dateInput.required = true;
    this.titleInput = document.createElement("input");
    this.titleInput.type = "text";
    this.titleInput.maxLength = MAX_JOURNAL_TITLE_BYTES;
    this.titleInput.autocomplete = "off";
    this.bodyInput = document.createElement("textarea");
    this.bodyInput.rows = 8;
    for (const control of [this.dateInput, this.titleInput, this.bodyInput])
      control.addEventListener("input", () => this.keepDraft());
    this.photoList = document.createElement("ul");
    this.photoList.className = "journal-editor-photos";
    this.photoList.setAttribute("aria-label", "Photos in this entry");
    this.photoButton = document.createElement("button");
    this.photoButton.type = "button";
    this.photoButton.className = "journal-add-photos";
    this.photoButton.textContent = "Add photos";
    this.photoButton.addEventListener("click", () => this.choosePhotos());
    this.photoStatus = document.createElement("p");
    this.photoStatus.className = "section-hint";
    this.photoStatus.setAttribute("role", "status");
    this.message = document.createElement("p");
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "journal-editor-actions";
    this.saveButton = document.createElement("button");
    this.saveButton.type = "button";
    this.saveButton.className = "primary-action";
    this.saveButton.textContent = "Save";
    this.saveButton.addEventListener("click", () => void this.save());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Close";
    cancel.addEventListener("click", () => this.closeEditor({ keep: true }));
    this.discardButton = document.createElement("button");
    this.discardButton.type = "button";
    this.discardButton.className = "journal-discard";
    this.discardButton.textContent = "Discard draft";
    this.discardButton.addEventListener("click", () => this.discardDraft());
    actions.append(this.saveButton, cancel, this.discardButton);
    this.editor.append(
      this.editorTitle,
      field("Date", this.dateInput),
      field("Title (optional)", this.titleInput),
      field("What happened", this.bodyInput, "Plain text. Line breaks are kept."),
      this.photoList, this.photoButton, this.photoStatus, this.message, actions,
    );
    // Escape closes the editor and keeps the draft.
    this.editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); this.closeEditor({ keep: true }); }
    });
  }

  /** `{ status, entries, today }`: status "ready", "account", "off",
   * "guest" or "unreachable". */
  update({ status, entries = [], today = todayCivilDate() }) {
    this.status = status;
    this.entries = entries;
    this.today = today;
    this.render();
  }

  render() {
    if (!this.workspace) return;
    const ready = this.status === "ready";
    this.unavailable.hidden = ready;
    this.workspace.hidden = !ready;
    if (!ready) {
      this.unavailableText.textContent = UNAVAILABLE[this.status] ?? UNAVAILABLE.unreachable;
      this.accountLink.hidden = this.status !== "account";
      return;
    }
    this.renderDraftNote();
    this.renderMonths();
    this.renderList();
  }

  renderDraftNote() {
    const waiting = this.draft && this.editor.hidden;
    this.newButton.textContent = waiting && !this.draft.entryId ? "Continue your draft" : "New entry";
    this.draftNote.hidden = !waiting;
    this.draftNote.textContent = waiting ? "Your draft is kept until you lock Kin." : "";
  }

  renderMonths() {
    const months = journalMonths(this.entries);
    const chosen = this.month.value;
    const placeholder = new Option("Choose a month", "");
    this.month.replaceChildren(placeholder, ...months.map(({ month }) => new Option(formatJournalMonth(month), month)));
    this.month.value = months.some(({ month }) => month === chosen) ? chosen : "";
    this.month.disabled = months.length === 0;
  }

  renderList() {
    if (!this.list) return;
    const searching = this.query.trim().length > 0;
    const shown = searchJournal(this.entries, this.query);
    // On this day: the journal page only, never a notification, and not
    // while searching.
    const memories = searching ? [] : onThisDay(this.entries, this.today);
    this.onThisDaySection.hidden = memories.length === 0;
    this.onThisDayList.replaceChildren(...memories.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "journal-memory";
      const when = document.createElement("span");
      when.className = "journal-memory-when";
      when.textContent = yearsAgo(entry.date, this.today);
      const what = document.createElement("span");
      what.className = "journal-memory-what";
      what.textContent = entry.title || firstLine(entry.body) || "Photos";
      button.append(when, what);
      button.addEventListener("click", () => this.focusEntry(entry.id));
      item.append(button);
      return item;
    }));
    if (!this.entries.length) {
      this.empty.textContent = "Nothing here yet. What you write is sealed so that only your own devices can read it.";
    } else if (!shown.length) {
      this.empty.textContent = `No entries match “${this.query.trim()}”.`;
    } else {
      this.empty.textContent = "";
    }
    this.empty.hidden = !this.empty.textContent;
    if (searching) this.announce(shown.length === 1 ? "1 entry matches." : `${shown.length} entries match.`);
    // A sync pass may redraw the list under the member: focus stays on the
    // same entry, heading, thumbnail or button.
    const active = this.list.contains(document.activeElement) ? document.activeElement : null;
    const key = active && (active.id || (active.dataset.photoRef ? `photo:${active.dataset.photoRef}` : null) ||
      (active.getAttribute("aria-label") ? `label:${active.getAttribute("aria-label")}` : null));
    this.list.replaceChildren(...groupByDate(shown).map((group) => this.renderDay(group)));
    if (key) {
      const next = [...this.list.querySelectorAll("[id], [data-photo-ref], [aria-label]")].find((node) =>
        node.id === key || `photo:${node.dataset.photoRef}` === key || `label:${node.getAttribute("aria-label")}` === key);
      next?.focus({ preventScroll: true });
    }
  }

  renderDay({ date, entries }) {
    const day = document.createElement("section");
    day.className = "journal-day";
    day.dataset.date = date;
    const heading = document.createElement("h2");
    heading.id = `journal-day-${date}`;
    heading.tabIndex = -1;
    heading.textContent = formatJournalDate(date);
    day.setAttribute("aria-labelledby", heading.id);
    day.append(heading, ...entries.map((entry) => this.renderEntry(entry)));
    return day;
  }

  renderEntry(entry) {
    const article = document.createElement("article");
    article.className = "journal-entry";
    article.dataset.entryId = entry.id;
    article.id = `journal-card-${entry.id}`;
    article.tabIndex = -1;
    const heading = document.createElement("h3");
    heading.id = `journal-entry-${entry.id}`;
    heading.textContent = entry.title || `Entry, ${formatJournalDate(entry.date)}`;
    if (!entry.title) heading.className = "visually-hidden";
    article.setAttribute("aria-labelledby", heading.id);
    article.append(heading);
    if (entry.body) {
      const body = document.createElement("p");
      body.className = "journal-entry-body";
      body.textContent = entry.body;
      article.append(body);
    }
    if (entry.photos.length) article.append(this.renderThumbnails(entry));
    const actions = document.createElement("div");
    actions.className = "journal-entry-actions";
    const name = entry.title || formatJournalDate(entry.date);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit entry: ${name}`);
    edit.addEventListener("click", () => this.openEditor(entry, edit));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "journal-delete";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete entry: ${name}`);
    remove.addEventListener("click", () => void this.deleteEntry(entry));
    actions.append(edit, remove);
    article.append(actions);
    return article;
  }

  renderThumbnails(entry) {
    const list = document.createElement("ul");
    list.className = "journal-photos";
    list.setAttribute("aria-label", "Photos");
    entry.photos.forEach((photo, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "journal-thumb";
      const label = `Photo ${index + 1} of ${entry.photos.length}`;
      button.setAttribute("aria-label", `Open ${label.toLowerCase()}`);
      button.dataset.photoRef = photo.ref;
      this.fillThumbnail(button, photo, label);
      button.addEventListener("click", () => this.services?.view(photo, button));
      item.append(button);
      list.append(item);
    });
    return list;
  }

  fillThumbnail(target, photo, label) {
    const placeholder = document.createElement("span");
    placeholder.className = "journal-thumb-waiting";
    placeholder.textContent = "Loading photo…";
    target.replaceChildren(placeholder);
    void Promise.resolve(this.services?.thumbnail(photo)).then((url) => {
      if (!target.isConnected && target.firstChild !== placeholder) return;
      if (!url) { placeholder.textContent = "Photo on its way"; return; }
      const image = document.createElement("img");
      image.src = url;
      image.alt = label;
      image.decoding = "async";
      target.replaceChildren(image);
    }).catch(() => { placeholder.textContent = "Photo can't be shown"; });
  }

  announce(text) {
    if (this.announcer.textContent === text) this.announcer.textContent = "";
    this.announcer.textContent = text;
  }

  focusEntry(entryId) {
    if (this.query) { this.query = ""; this.search.value = ""; this.renderList(); }
    const article = [...this.list.querySelectorAll(".journal-entry")].find((node) => node.dataset.entryId === entryId);
    if (!article) return false;
    article.scrollIntoView({ block: "start" });
    article.focus({ preventScroll: true });
    return true;
  }

  jumpToMonth(month) {
    if (!month) return;
    if (this.query) { this.query = ""; this.search.value = ""; this.renderList(); }
    const day = [...this.list.querySelectorAll(".journal-day")].find((node) => node.dataset.date.startsWith(month));
    const heading = day?.querySelector("h2");
    if (!heading) return;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }

  // --- The editor -------------------------------------------------------

  /** Opens the editor for a new entry (entry null) or an existing one,
   * keeping a draft already under way. `prefill` ({ body, photos }) starts a
   * new entry with something shared into Kin. */
  openEditor(entry, opener = null, { prefill = null } = {}) {
    if (this.status !== "ready") return false;
    this.settleUndo();
    const target = entry?.id ?? null;
    if (this.draft && this.draft.entryId !== target) {
      // One draft at a time: the one under way comes back first.
      this.showEditor(opener);
      this.message.textContent = "Save or discard this draft first.";
      return false;
    }
    if (!this.draft) {
      this.draft = entry
        ? { entryId: entry.id, date: entry.date, title: entry.title, body: entry.body, photos: [...entry.photos], original: entry, added: new Set(), removed: [] }
        : { entryId: null, date: this.today, title: "", body: "", photos: [], original: null, added: new Set(), removed: [] };
    }
    if (prefill) {
      if (prefill.body) this.draft.body = this.draft.body ? `${this.draft.body}\n\n${prefill.body}` : prefill.body;
      for (const photo of prefill.photos ?? []) {
        if (this.draft.photos.length >= MAX_JOURNAL_PHOTOS) break;
        this.draft.photos.push(photo);
        this.draft.added.add(photo.ref);
      }
    }
    this.showEditor(opener);
    return true;
  }

  showEditor(opener) {
    this.opener = opener ?? this.opener;
    const draft = this.draft;
    this.editorTitle.textContent = draft.entryId ? "Edit entry" : "New entry";
    this.dateInput.value = draft.date;
    this.titleInput.value = draft.title;
    this.bodyInput.value = draft.body;
    this.message.textContent = "";
    this.photoStatus.textContent = "";
    this.renderEditorPhotos();
    this.editor.hidden = false;
    this.renderDraftNote();
    this.editor.scrollIntoView({ block: "nearest" });
    this.bodyInput.focus();
  }

  keepDraft() {
    if (!this.draft) return;
    this.draft.date = this.dateInput.value;
    this.draft.title = this.titleInput.value;
    this.draft.body = this.bodyInput.value;
    this.message.textContent = "";
  }

  renderEditorPhotos() {
    const photos = this.draft?.photos ?? [];
    this.photoList.hidden = photos.length === 0;
    this.photoList.replaceChildren(...photos.map((photo, index) => {
      const item = document.createElement("li");
      const preview = document.createElement("span");
      preview.className = "journal-thumb";
      this.fillThumbnail(preview, photo, `Photo ${index + 1}`);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "journal-photo-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove photo ${index + 1}`);
      remove.dataset.photoRef = photo.ref;
      remove.addEventListener("click", () => this.removePhoto(photo));
      item.append(preview, remove);
      return item;
    }));
    this.photoButton.disabled = photos.length >= MAX_JOURNAL_PHOTOS;
  }

  /** Opens the photo picker. The app keeps one persistent file input (the
   * household attachments'); like Import and Chat, this one exists only
   * while the picker is open (kin-import.js `chooseFile`). */
  choosePhotos() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.multiple = true;
    input.hidden = true;
    const done = () => input.remove();
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      done();
      if (files.length) void this.addPhotos(files);
    });
    input.addEventListener("cancel", done);
    this.editor.append(input);
    input.click();
  }

  async addPhotos(files) {
    if (!this.draft || !this.services) return;
    const room = MAX_JOURNAL_PHOTOS - this.draft.photos.length;
    this.photoStatus.textContent = files.length > 1 ? "Preparing photos…" : "Preparing photo…";
    const draft = this.draft;
    const { photos = [], message = null } = await this.services.addPhotos(files.slice(0, Math.max(0, room)));
    if (this.draft !== draft) { this.services.discard(photos.flatMap((photo) => photoRefs([photo]))); return; }
    for (const photo of photos) { draft.photos.push(photo); draft.added.add(photo.ref); }
    this.renderEditorPhotos();
    const over = files.length > room ? `An entry can have up to ${MAX_JOURNAL_PHOTOS} photos.` : null;
    this.photoStatus.textContent = photos.length ? (photos.length === 1 ? "Photo added." : `${photos.length} photos added.`) : "";
    this.message.textContent = message ?? over ?? "";
  }

  removePhoto(photo) {
    const draft = this.draft;
    const index = draft.photos.findIndex((each) => each.ref === photo.ref);
    if (index < 0) return;
    draft.photos.splice(index, 1);
    draft.removed.push(photo);
    this.renderEditorPhotos();
    this.offerUndo("Photo removed.", {
      undo: () => {
        if (this.draft !== draft) return;
        draft.photos.splice(Math.min(index, draft.photos.length), 0, photo);
        draft.removed = draft.removed.filter((each) => each !== photo);
        this.renderEditorPhotos();
        this.photoList.querySelector(`[data-photo-ref="${photo.ref}"]`)?.focus();
        this.announce("Photo put back.");
      },
      // The draft decides: a removed photo is let go when the entry saves
      // without it, or when the draft is discarded.
      settle: () => {},
    });
  }

  async save() {
    if (!this.draft || this.busy || !this.services) return;
    this.keepDraft();
    const draft = this.draft;
    this.busy = true;
    this.saveButton.disabled = true;
    this.message.textContent = "";
    try {
      const result = await this.services.save({ entryId: draft.entryId, date: draft.date, title: draft.title, body: draft.body, photos: draft.photos });
      if (!result.ok) { this.message.textContent = result.message; return; }
      // Photos the saved entry no longer names go once nothing can bring
      // them back.
      const kept = new Set(photoRefs(draft.photos));
      const gone = [...photoRefs(draft.original?.photos), ...photoRefs(draft.removed)].filter((ref) => !kept.has(ref));
      if (gone.length) this.services.discard([...new Set(gone)]);
      this.draft = null;
      this.settleUndo();
      this.editor.hidden = true;
      this.renderDraftNote();
      this.announce(result.changed === false ? "Nothing changed." : "Saved to your journal.");
      const id = result.entryId ?? draft.entryId;
      // The list may redraw when the log notifies: focus after it settles.
      setTimeout(() => { if (!this.focusEntry(id)) this.newButton.focus(); }, 0);
    } finally {
      this.busy = false;
      this.saveButton.disabled = false;
    }
  }

  closeEditor({ keep = true } = {}) {
    if (this.editor.hidden) return;
    this.keepDraft();
    if (keep && this.draft && !this.dirty()) this.draft = null;
    this.editor.hidden = true;
    this.renderDraftNote();
    const opener = this.opener;
    this.opener = null;
    (opener?.isConnected ? opener : this.newButton).focus();
  }

  /** Whether the draft differs from what it started as. */
  dirty() {
    const draft = this.draft;
    if (!draft) return false;
    const original = draft.original;
    if (!original) return Boolean(draft.title.trim() || draft.body.trim() || draft.photos.length);
    return draft.date !== original.date || draft.title !== original.title || draft.body !== original.body ||
      draft.photos.length !== original.photos.length || draft.photos.some((photo, index) => photo.ref !== original.photos[index].ref);
  }

  discardDraft() {
    const draft = this.draft;
    if (!draft) return;
    // Photos added in this draft go; the saved entry's stay.
    const saved = new Set(photoRefs(draft.original?.photos));
    const added = [...draft.photos, ...draft.removed].filter((photo) => draft.added.has(photo.ref) && !saved.has(photo.ref));
    if (added.length) this.services?.discard(photoRefs(added));
    this.draft = null;
    this.settleUndo();
    this.editor.hidden = true;
    this.renderDraftNote();
    this.announce("Draft discarded.");
    const opener = this.opener;
    this.opener = null;
    (opener?.isConnected ? opener : this.newButton).focus();
  }

  // --- Delete and Undo --------------------------------------------------

  async deleteEntry(entry) {
    if (this.busy || !this.services) return;
    if (this.draft?.entryId === entry.id) {
      this.showEditor(null);
      this.message.textContent = "Save or discard this draft first.";
      return;
    }
    this.busy = true;
    try {
      const result = await this.services.remove(entry.id);
      if (!result.ok) { this.announce(result.message); return; }
      this.offerUndo("Entry deleted.", {
        undo: async () => {
          const restored = await this.services.restore(entry.id);
          if (!restored.ok) { this.announce(restored.message); return; }
          this.announce("Entry put back.");
          setTimeout(() => this.focusEntry(entry.id), 0);
        },
        // Once Undo has passed, its photos are let go.
        settle: () => { if (entry.photos.length) this.services.discard(photoRefs(entry.photos)); },
      });
    } finally {
      this.busy = false;
    }
  }

  offerUndo(text, { undo, settle }) {
    this.settleUndo();
    this.undo = { undo, settle };
    this.undoText.textContent = text;
    this.undoBar.hidden = false;
    this.undoBar.scrollIntoView({ block: "nearest" });
    this.undoButton.focus();
  }

  async runUndo() {
    const pending = this.undo;
    if (!pending) return;
    this.undo = null;
    this.undoBar.hidden = true;
    await pending.undo();
  }

  /** The Undo on offer passes: dismissed, or another action came. */
  settleUndo({ focus = false } = {}) {
    const pending = this.undo;
    this.undo = null;
    if (this.undoBar) this.undoBar.hidden = true;
    pending?.settle();
    if (focus) (this.editor.hidden ? this.newButton : this.bodyInput).focus();
  }
}

function firstLine(text) {
  const line = String(text ?? "").split("\n").find((each) => each.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

customElements.define("kin-journal", KinJournal);
