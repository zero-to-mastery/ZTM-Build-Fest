import { ROUTINE_PERIOD_LABELS } from "../today-view.js";
import { describeNextOccurrence } from "../recurrence.js";
import "./kin-playbook-editor.js";
import "./kin-reminder.js";
import "./kin-responsibility.js";
import "./kin-rotation.js";
import "./kin-routine-schedule.js";
import { captureFocus, restoreFocus } from "./shared/focus.js";

// Routines page. Existing routines are the main content; creation sits behind
// an Add routine control. Reusable checklists (canonically "playbooks":
// save-playbook / archive-playbook / instantiate-playbook) have their own
// view with a separate editor. Reminders use the in-app <kin-reminder>.

const MODE_LABELS = { normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" };
const CADENCE_LABELS = { daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", biweekly: "Every two weeks", monthly: "Monthly" };

class KinRoutines extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.playbookRecords = [];
    this.reminderMap = new Map();
    this.isDisabled = false;
    this.mode = "normal";
    this.currentView = "all";
    this.createOpen = false;
    this.editorOpen = false;
    this.instanceId = `routines-${++KinRoutines.instances}`;
    this.reminderControls = new Map();
    // Taking turns (#433): one element per routine keeps an open editor.
    this.rotationControls = new Map();
    this.rotationMap = new Map();
    // Chore chart points per routine (#676): { points: Map(routineId ->
    // 0–10) } for an Adult, or null (nothing shown).
    this.choreSettingsValue = null;
    this.civilDate = null;
    // Which row's schedule editor is open, and its unsaved choice, survive
    // the re-render a background refresh causes.
    this.scheduleOpenId = null;
    this.scheduleDrafts = new Map();
  }

  disconnectedCallback() {
    this.compactQuery?.removeEventListener?.("change", this.onCompactChange);
  }

  connectedCallback() {
    this.compactQuery ??= globalThis.matchMedia?.("(max-width: 719px)") ?? null;
    // Removed on disconnect: a lock replaces this element, and a listener
    // left on the media query would keep the old one and its records alive.
    this.onCompactChange ??= () => this.render();
    this.compactQuery?.addEventListener?.("change", this.onCompactChange);
    if (this.input) return;
    // --- Routines view ---
    const routinesView = document.createElement("section");
    routinesView.className = "routines-view";
    routinesView.dataset.view = "all";
    const heading = document.createElement("h2");
    heading.textContent = "Routines";
    heading.tabIndex = -1;
    this.heading = heading;
    this.hint = document.createElement("p");
    this.hint.className = "section-hint";
    const toolbar = document.createElement("div");
    toolbar.className = "view-toolbar";
    this.addButton = document.createElement("button");
    this.addButton.type = "button";
    this.addButton.className = "primary-action";
    this.addButton.textContent = "Add routine";
    this.addButton.setAttribute("aria-expanded", "false");
    this.addButton.setAttribute("aria-controls", `${this.instanceId}-create`);
    this.addButton.addEventListener("click", () => { if (this.createOpen) this.closeCreate(); else this.openCreate(); });
    toolbar.append(this.addButton);

    const form = document.createElement("form");
    form.className = "compose-form routine-form";
    form.id = `${this.instanceId}-create`;
    form.hidden = true;
    form.noValidate = true;
    this.form = form;
    const label = document.createElement("label");
    label.htmlFor = "routine-text";
    label.textContent = "What needs doing regularly?";
    this.input = document.createElement("input");
    this.input.id = "routine-text";
    this.input.required = true;
    this.input.maxLength = 4096;
    this.input.autocomplete = "off";
    const cadenceLabel = document.createElement("label");
    cadenceLabel.htmlFor = "routine-cadence";
    cadenceLabel.textContent = "Repeat";
    this.cadence = document.createElement("select");
    this.cadence.id = "routine-cadence";
    for (const [value, text] of Object.entries(CADENCE_LABELS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.cadence.append(option);
    }
    const cadenceHint = document.createElement("p");
    cadenceHint.className = "section-hint";
    cadenceHint.textContent = "Weekdays skips Saturday and Sunday. Weekly starts on Monday. Every two weeks counts from the day you add it. Monthly follows the calendar month, so one added on the 31st still repeats in shorter months.";
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "add-button";
    this.button.textContent = "Save routine";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { this.closeCreate(); this.addButton.focus(); });
    this.message = document.createElement("p");
    this.message.id = "routine-message";
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    this.input.setAttribute("aria-describedby", this.message.id);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.isDisabled) return;
      const text = this.input.value;
      if (!text.trim()) { this.message.textContent = "Add a few words first."; this.focusInput(); return; }
      if (new TextEncoder().encode(text).length > 4096) { this.message.textContent = "That's too long for one routine. Shorten it to roughly 4,000 characters or fewer."; this.focusInput(); return; }
      this.message.textContent = "";
      this.dispatch("create-routine", { text, cadence: this.cadence.value });
    });
    const actions = document.createElement("div");
    actions.className = "form-actions";
    actions.append(this.button, cancel);
    form.append(label, this.input, cadenceLabel, this.cadence, cadenceHint, actions, this.message);

    this.list = document.createElement("ul");
    this.list.className = "item-list routine-list";
    this.empty = document.createElement("p");
    this.empty.className = "empty-state";
    this.empty.textContent = "No routines yet. Add a small household rhythm when one would help.";
    routinesView.append(heading, this.hint, toolbar, form, this.empty, this.list);

    // --- Reusable checklists view ---
    const checklistsView = document.createElement("section");
    checklistsView.className = "playbook-section";
    checklistsView.dataset.view = "checklists";
    const playbookHeading = document.createElement("h2");
    playbookHeading.textContent = "Reusable checklists";
    playbookHeading.tabIndex = -1;
    this.playbookHeading = playbookHeading;
    const playbookHint = document.createElement("p");
    playbookHint.className = "section-hint";
    playbookHint.textContent = "Save a checklist you use again and again. Using one creates an ordinary To do item with its steps, which you can edit independently.";
    const playbookToolbar = document.createElement("div");
    playbookToolbar.className = "view-toolbar";
    this.newPlaybookButton = document.createElement("button");
    this.newPlaybookButton.type = "button";
    this.newPlaybookButton.className = "primary-action";
    this.newPlaybookButton.textContent = "New reusable checklist";
    this.newPlaybookButton.setAttribute("aria-expanded", "false");
    this.newPlaybookButton.setAttribute("aria-controls", `${this.instanceId}-playbook-editor`);
    this.newPlaybookButton.addEventListener("click", () => { if (this.editorOpen && !this.editingPlaybookId) this.closePlaybookEditor(); else { this.clearPlaybookEditor(); this.openPlaybookEditor(); } });
    playbookToolbar.append(this.newPlaybookButton);
    // The checklist form is its own element; its controls keep their older
    // names here because the regression scripts use them.
    const editor = document.createElement("kin-playbook-editor");
    editor.setup(this.instanceId);
    editor.addEventListener("playbook-editor-cancel", () => { this.clearPlaybookEditor(); this.newPlaybookButton.focus(); });
    this.playbookEditor = editor;
    Object.assign(this, {
      playbookForm: editor.form, playbookTitle: editor.titleInput, playbookTitleError: editor.titleError,
      playbookEntries: editor.entriesInput, playbookCountError: editor.countError,
      playbookEntryErrors: editor.entryErrors, playbookSave: editor.save,
    });
    this.playbookList = document.createElement("ul"); this.playbookList.className = "item-list playbook-list";
    this.playbookEmpty = document.createElement("p"); this.playbookEmpty.className = "empty-state"; this.playbookEmpty.textContent = "No reusable checklists yet.";
    checklistsView.append(playbookHeading, playbookHint, playbookToolbar, editor, this.playbookEmpty, this.playbookList);

    this.routinesView = routinesView;
    this.checklistsView = checklistsView;
    this.append(routinesView, checklistsView);
    this.render();
    this.disabled = this.isDisabled;
    this.applyView();
  }

  // Each input renders only when it differs from the current one; the
  // projection reuses unchanged sections, so a refresh often changes none.
  set routines(value) {
    const records = Array.isArray(value) ? value : [];
    if (records === this.records) return;
    this.records = records;
    this.render();
  }
  set today(value) {
    const civilDate = Number.isSafeInteger(value) ? value : null;
    if (civilDate === this.civilDate) return;
    this.civilDate = civilDate;
    this.render();
  }
  set responsibilityContext(value) {
    if (value === this.ownerContext) return;
    this.ownerContext = value;
    this.responsibilities = value?.responsibilities ?? []; this.memberId = value?.memberId ?? null; this.memberIds = value?.memberIds ?? []; this.memberNames = value?.names ?? null;
    this.render();
  }
  /** routineId -> { memberIds, current, next } (app/rotations.js). */
  set rotations(value) {
    const map = value instanceof Map ? value : new Map();
    if (map === this.rotationMap) return;
    this.rotationMap = map;
    this.render();
  }
  /** Chore chart points (#676): { points: Map(routineId -> points) } shows
   * a points choice on each routine; null hides it. */
  set choreSettings(value) {
    const next = value?.points instanceof Map ? value : null;
    const same = next === this.choreSettingsValue || (next && this.choreSettingsValue &&
      next.points.size === this.choreSettingsValue.points.size && [...next.points].every(([id, points]) => this.choreSettingsValue.points.get(id) === points));
    if (same) return;
    this.choreSettingsValue = next;
    // Patched in place: the points arrive after Routines has drawn, and a
    // full redraw would move focus out of an open schedule editor.
    for (const row of this.list?.children ?? []) {
      const record = this.records.find((entry) => entry.routineId === row.dataset.routineId);
      const existing = row.querySelector(".routine-chore-points");
      if (!next || !record) { existing?.remove(); continue; }
      if (existing) existing.querySelector("select").value = String(next.points.get(record.routineId) ?? 1);
      else row.querySelector("kin-rotation")?.after(this.chorePointsControl(record));
    }
  }
  set playbooks(value) {
    const records = value ?? [];
    if (records === this.playbookRecords) return;
    this.playbookRecords = records;
    this.renderPlaybooks();
  }
  set householdMode(value) {
    if (value === this.mode) return;
    this.mode = value;
    this.render();
  }
  set reminders(value) {
    this.reminderMap = value instanceof Map ? value : new Map();
    for (const [id, control] of this.reminderControls) control.reminder = this.reminderMap.get(id) ?? null;
  }
  set view(value) { this.currentView = value === "checklists" ? "checklists" : "all"; this.applyView(); }
  get view() { return this.currentView; }
  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, textarea, select, button")) {
      if (control.closest("kin-reminder, kin-playbook-editor, kin-routine-schedule")) continue;
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
    for (const control of this.reminderControls.values()) control.disabled = this.isDisabled;
    for (const control of this.rotationControls.values()) control.disabled = this.isDisabled;
    // These keep their own state (a schedule's Change button also depends on
    // whether the choice differs), so they are told rather than overwritten.
    if (this.playbookEditor) this.playbookEditor.disabled = this.isDisabled;
    for (const schedule of this.querySelectorAll("kin-routine-schedule")) schedule.disabled = this.isDisabled;
  }
  get hasDraft() {
    return Boolean(this.input?.value.trim() || this.playbookEditor?.hasDraft) || this.scheduleDrafts.size > 0 ||
      [...this.reminderControls.values()].some((control) => control.hasDraft);
  }

  applyView() {
    if (!this.routinesView) return;
    this.routinesView.hidden = this.currentView !== "all";
    this.checklistsView.hidden = this.currentView !== "checklists";
  }

  openCreate() {
    this.createOpen = true;
    this.form.hidden = false;
    this.addButton.setAttribute("aria-expanded", "true");
    this.addButton.textContent = "Close";
    this.input.focus();
  }
  closeCreate() {
    this.createOpen = false;
    this.form.hidden = true;
    this.message.textContent = "";
    this.addButton.setAttribute("aria-expanded", "false");
    this.addButton.textContent = "Add routine";
  }
  // After a save the form stays open for another routine; otherwise the Add
  // control is the sensible focus target.
  focusInput() { if (this.createOpen) this.input.focus(); else this.addButton.focus(); }
  // Opens one row's schedule editor (from Today's Schedule button) and moves
  // focus into it. Returns false when the task is gone or stopped.
  openSchedule(routineId) {
    if (!this.records.some((record) => record.routineId === routineId && record.status !== "archived")) return false;
    this.scheduleOpenId = routineId;
    this.render();
    const row = this.rowFor(routineId);
    row?.scrollIntoView?.({ block: "nearest" });
    row?.querySelector(".routine-schedule select")?.focus();
    return true;
  }
  closeSchedule(routineId) {
    if (this.scheduleOpenId === routineId) this.scheduleOpenId = null;
    this.scheduleDrafts.delete(routineId);
  }
  rowFor(routineId) { return [...(this.list?.children ?? [])].find((row) => row.dataset.routineId === routineId) ?? null; }
  focusRoutine(routineId) {
    const row = this.rowFor(routineId);
    (row?.querySelector("button[data-routine-id], summary") ?? (this.createOpen ? this.input : this.addButton)).focus();
  }
  focusHeading() { (this.currentView === "checklists" ? this.playbookHeading : this.heading)?.focus(); }
  saveDraft() { /* Drafts stay only in the unlocked inputs. */ }
  clearIfMatches({ text, cadence }) {
    if (this.input.value !== text || this.cadence.value !== cadence) return;
    this.input.value = "";
  }
  openPlaybookEditor() {
    this.editorOpen = true;
    this.playbookForm.hidden = false;
    this.newPlaybookButton.setAttribute("aria-expanded", "true");
    this.playbookTitle.focus();
  }
  closePlaybookEditor() {
    this.editorOpen = false;
    this.playbookForm.hidden = true;
    this.newPlaybookButton.setAttribute("aria-expanded", "false");
  }
  clearPlaybookEditor() {
    this.playbookEditor.clear();
    if (this.editorOpen) this.closePlaybookEditor();
  }
  // The checklist being edited, or null for a new one.
  get editingPlaybookId() { return this.playbookEditor?.editingId ?? null; }
  dispatch(action, detail) {
    if (!this.isDisabled) this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
  captureFocus() {
    return captureFocus(this, {
      describe: (control) => ({ id: control.dataset.routineId ?? control.closest("[data-routine-id]")?.dataset.routineId, action: control.dataset.action }),
    });
  }
  restoreFocus(focus) {
    // A completed row swaps Complete for Reopen (and back); buttons inside a
    // closed Schedule editor cannot take focus.
    restoreFocus(focus, {
      find: ({ id, action }) => {
        // A routine's chore chart points (#676) keep focus on their own select.
        if (action === "set-chore-points") {
          const select = [...this.querySelectorAll('select[data-action="set-chore-points"]')].find((node) => node.dataset.routineId === id);
          if (select) return select;
        }
        const counterpart = { "complete-routine-occurrence": "reopen-routine-occurrence", "reopen-routine-occurrence": "complete-routine-occurrence" }[action];
        const sameRow = [...this.querySelectorAll("button[data-routine-id]")].filter((button) => button.dataset.routineId === id && !button.closest("details:not([open])"));
        return sameRow.find((button) => button.dataset.action === action) ?? sameRow.find((button) => button.dataset.action === counterpart) ?? sameRow[0] ?? (this.createOpen ? this.input : this.addButton);
      },
    });
  }
  render() {
    if (!this.list) return;
    const focus = this.captureFocus();
    // Taking turns controls are reused, so focus goes back to the same one.
    const turnFocus = this.list.contains(document.activeElement) ? document.activeElement.closest("kin-rotation") : null;
    const turnKey = turnFocus ? document.activeElement.dataset.key : null;
    this.list.replaceChildren();
    this.hint.textContent = this.mode === "normal"
      ? "Repeating tasks, without streaks or pressure. Complete the current one when it's done; skipping one is fine. Add one here or with Repeat in Quick add."
      : `Routine occurrences are paused during ${MODE_LABELS[this.mode] ?? "this"} mode. Definitions stay unchanged. Change the mode under Household › Areas & status.`;
    const visible = this.records.filter((record) => record.status !== "archived");
    this.empty.hidden = visible.length !== 0;
    if (this.scheduleOpenId && !visible.some((record) => record.routineId === this.scheduleOpenId)) this.scheduleOpenId = null;
    for (const id of [...this.scheduleDrafts.keys()]) if (!visible.some((record) => record.routineId === id)) this.scheduleDrafts.delete(id);
    const keep = new Set();
    for (const record of visible) {
      const row = document.createElement("li");
      row.className = "item-row routine-row";
      row.dataset.routineId = record.routineId;
      const content = document.createElement("div");
      content.className = "item-body";
      const text = document.createElement("p");
      text.className = "item-text";
      text.textContent = record.text;
      const status = document.createElement("p");
      status.className = "routine-status item-meta";
      const period = ROUTINE_PERIOD_LABELS[record.cadence] ?? "this period";
      const next = this.mode === "normal" ? describeNextOccurrence(record.nextOn, this.civilDate) : null;
      status.textContent = [CADENCE_LABELS[record.cadence] ?? record.cadence, this.mode !== "normal"
        ? `Paused during ${MODE_LABELS[this.mode] ?? "this mode"}`
        : record.occurrenceStatus === "unavailable"
          ? record.cadence === "weekdays" ? "Nothing due at the weekend" : "Not available for the current date"
          : record.occurrenceStatus === "completed" ? `Done ${period.toLowerCase()}` : `Open ${period.toLowerCase()}`, next].filter(Boolean).join(" · ");
      content.append(text, status);
      // While a routine rotates its owner is whoever's turn it is (#437).
      const rotation = this.rotationMap.get(record.routineId) ?? null;
      if (!rotation) {
        const responsibility = document.createElement("kin-responsibility");
        responsibility.record = { targetKind: "routine", targetId: record.routineId, text: record.text, ownerId: this.responsibilities?.find((entry) => entry.targetKind === "routine" && entry.targetId === record.routineId)?.memberId ?? null, memberId: this.memberId, memberIds: this.memberIds, names: this.memberNames };
        content.append(responsibility);
      }
      const turns = this.rotationControls.get(record.routineId) ?? document.createElement("kin-rotation");
      turns.className = "routine-rotation";
      turns.dataset.feature = "turns";
      this.rotationControls.set(record.routineId, turns);
      content.append(turns);
      turns.disabled = this.isDisabled;
      turns.record = { routineId: record.routineId, text: record.text, rotation, memberId: this.memberId, memberIds: this.memberIds, names: this.memberNames };
      if (this.choreSettingsValue) content.append(this.chorePointsControl(record));
      const reminderId = `routine:${record.routineId}`;
      const reminder = this.reminderControls.get(reminderId) ?? document.createElement("kin-reminder");
      reminder.target = { id: reminderId, title: record.text };
      reminder.reminder = this.reminderMap.get(reminderId) ?? null;
      reminder.disabled = this.isDisabled;
      this.reminderControls.set(reminderId, reminder);
      keep.add(reminderId);
      content.append(reminder);
      const actions = document.createElement("div");
      actions.className = "item-action";
      const addAction = (label, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = action === "archive-routine" ? "archive-button" : "complete-button";
        button.setAttribute("aria-label", `${label} ${record.text}${action === "archive-routine" ? "" : ` ${period.toLowerCase()}`}`);
        button.dataset.routineId = record.routineId;
        button.dataset.action = action;
        button.disabled = this.isDisabled;
        button.addEventListener("click", () => this.dispatch(action, { routineId: record.routineId, ...(action === "archive-routine" ? {} : { occurrenceKey: record.occurrenceKey }) }));
        actions.append(button);
      };
      if (this.mode === "normal" && record.occurrenceStatus !== "unavailable") addAction(record.occurrenceStatus === "completed" ? "Reopen" : "Complete", record.occurrenceStatus === "completed" ? "reopen-routine-occurrence" : "complete-routine-occurrence");
      // Delete routine (#314): archives it everywhere; past completions stay
      // in history, and Undo on the toast brings it back. On a phone it
      // lives in the row's ⋯ menu rather than beside Complete.
      if (this.compactQuery?.matches) {
        const more = document.createElement("details");
        more.className = "row-more";
        const summary = document.createElement("summary");
        summary.className = "row-more-toggle";
        summary.setAttribute("aria-label", `More for ${record.text}`);
        summary.textContent = "⋯";
        more.append(summary);
        actions.append(more);
        const before = actions.lastChild;
        addAction("Delete routine", "archive-routine");
        if (actions.lastChild !== before) more.append(actions.lastChild);
      } else {
        addAction("Delete routine", "archive-routine");
      }
      content.append(this.createScheduleEditor(record));
      row.append(content, actions);
      this.list.append(row);
    }
    for (const id of [...this.reminderControls.keys()]) if (!keep.has(id)) this.reminderControls.delete(id);
    for (const id of [...this.rotationControls.keys()]) if (!visible.some((record) => record.routineId === id)) this.rotationControls.delete(id);
    this.restoreFocus(focus);
    if (turnFocus?.isConnected) {
      const controls = [...turnFocus.querySelectorAll("[data-key]")].filter((node) => !node.disabled);
      (controls.find((node) => node.dataset.key === turnKey) ?? controls[0])?.focus({ preventScroll: true });
    }
    this.renderPlaybooks();
  }
  // A routine's points on the chore chart (#676): 0–10, 1 by default.
  chorePointsControl(record) {
    const label = document.createElement("label");
    label.className = "routine-chore-points";
    label.dataset.feature = "chores";
    const name = document.createElement("span");
    name.textContent = "Chore chart points";
    const select = document.createElement("select");
    select.dataset.routineId = record.routineId;
    select.dataset.action = "set-chore-points";
    select.setAttribute("aria-label", `Chore chart points for ${record.text}`);
    for (let points = 0; points <= 10; points += 1) select.append(new Option(String(points), String(points)));
    select.value = String(this.choreSettingsValue.points.get(record.routineId) ?? 1);
    select.disabled = this.isDisabled;
    select.addEventListener("change", () => this.dispatch("set-chore-points", { routineId: record.routineId, points: Number(select.value) }));
    label.append(name, select);
    return label;
  }
  // One row's schedule editor (kin-routine-schedule.js). Which editor is open
  // and its unsaved choice live here, so a re-render keeps them.
  createScheduleEditor(record) {
    const schedule = document.createElement("kin-routine-schedule");
    schedule.setup(record, {
      idPrefix: `${this.instanceId}-schedule-${record.routineId}`,
      civilDate: this.civilDate,
      mode: this.mode,
      open: this.scheduleOpenId === record.routineId,
      draft: this.scheduleDrafts.get(record.routineId) ?? null,
      disabled: this.isDisabled,
    });
    schedule.addEventListener("schedule-toggle", (event) => {
      if (event.detail.open) this.scheduleOpenId = record.routineId;
      else if (this.scheduleOpenId === record.routineId) this.scheduleOpenId = null;
    });
    schedule.addEventListener("schedule-draft", (event) => {
      if (event.detail.cadence === null) this.scheduleDrafts.delete(record.routineId);
      else this.scheduleDrafts.set(record.routineId, event.detail.cadence);
    });
    return schedule;
  }
  renderPlaybooks() {
    if (!this.playbookList) return;
    this.playbookList.replaceChildren();
    const visible = this.playbookRecords.filter((value) => !value.archived);
    this.playbookEmpty.hidden = visible.length !== 0;
    for (const record of visible) {
      const row = document.createElement("li"); row.className = "item-row playbook-row"; row.dataset.playbookId = record.playbookId;
      const content = document.createElement("div"); content.className = "item-body";
      const title = document.createElement("p"); title.className = "item-text"; title.textContent = record.title;
      const entries = document.createElement("ol"); entries.className = "playbook-steps"; for (const text of record.entries) { const item = document.createElement("li"); item.textContent = text; entries.append(item); }
      content.append(title, entries);
      const actions = document.createElement("div"); actions.className = "item-action";
      const add = (label, action, callback) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("aria-label", `${label}: ${record.title}`); button.disabled = this.isDisabled; button.dataset.playbookId = record.playbookId; button.dataset.action = action; button.addEventListener("click", callback); actions.append(button); };
      add("Use checklist", "instantiate", () => this.dispatch("instantiate-playbook", { playbookId: record.playbookId }));
      add("Edit", "edit", () => { this.playbookEditor.edit(record); this.openPlaybookEditor(); });
      add("Archive", "archive", () => this.dispatch("archive-playbook", { playbookId: record.playbookId }));
      row.append(content, actions); this.playbookList.append(row);
    }
  }
}
KinRoutines.instances = 0;
customElements.define("kin-routines", KinRoutines);
