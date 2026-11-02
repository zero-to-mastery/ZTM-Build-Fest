import { isBulkEligible } from "../bulk-actions.js";

// The bulk-selection bar of a To do or Shopping list: Select / Done selecting,
// the selected count with Select all, Complete, Reopen and Clear selection,
// progress text, and the outcome of the last bulk action with Undo, Retry
// and Dismiss.
//
// Presentation only. The list (<kin-today>) owns the selection and sends the
// commands; the bar reports each button press as a non-bubbling
// "bulk-bar-action" event on itself ({ detail: { action } }), and the list
// calls update() whenever the selection or the last outcome changes.
//
// The controls are public fields (`bar.undo`, `bar.toolbar`, ...), which the
// regression scripts use.

class KinBulkBar extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = false;
    // A control that should take focus while the bar is disabled (busy);
    // the `disabled` setter focuses it once the bar is enabled again.
    this.deferredFocus = null;
  }

  // Builds the controls once. An element may not add children in its
  // constructor, so the list calls this right after creating the bar.
  // `display` ("need", "shopping") keeps element ids unique per list.
  setup(display, label) {
    const button = (text, dataAction, action) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.dataset.action = dataAction;
      element.addEventListener("click", () => this.dispatchEvent(new CustomEvent("bulk-bar-action", { detail: { action } })));
      return element;
    };
    this.className = "bulk-area";
    this.selectMode = button("Select", "select-mode", "select-mode");
    this.selectMode.className = "bulk-select-mode";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "bulk-toolbar";
    this.toolbar.setAttribute("role", "group");
    this.toolbar.setAttribute("aria-label", `Selected ${label} items`);
    this.count = document.createElement("p");
    this.count.className = "bulk-count";
    this.count.id = `bulk-count-${display}`;
    this.count.setAttribute("role", "status");
    this.count.setAttribute("aria-live", "polite");
    const actions = document.createElement("div");
    actions.className = "bulk-actions";
    this.selectAll = button("Select all", "select-all", "select-all");
    // Each action submits only the selected items it applies to as shown;
    // <kin-app> re-plans against the projection before writing anything.
    this.complete = button("Complete", "bulk-complete", "complete");
    this.reopen = button("Reopen", "bulk-reopen", "reopen");
    this.clear = button("Clear selection", "clear-selection", "clear");
    for (const control of [this.complete, this.reopen]) control.setAttribute("aria-describedby", this.count.id);
    actions.append(this.selectAll, this.complete, this.reopen, this.clear);
    this.progress = document.createElement("p");
    this.progress.className = "bulk-progress";
    this.progress.hidden = true;
    this.toolbar.append(this.count, actions, this.progress);
    this.result = document.createElement("div");
    this.result.className = "bulk-result";
    this.message = document.createElement("p");
    this.message.className = "bulk-result-message";
    this.message.id = `bulk-result-${display}`;
    this.message.setAttribute("role", "status");
    this.message.setAttribute("aria-live", "polite");
    const resultActions = document.createElement("div");
    resultActions.className = "bulk-actions";
    this.undo = button("Undo", "bulk-undo", "undo");
    this.retry = button("Try failed items again", "bulk-retry", "retry");
    this.dismiss = button("Dismiss", "bulk-dismiss", "dismiss");
    // Focus moves to Undo or Retry as the outcome arrives, which can cut off
    // the polite announcement; the focused button then reads it instead.
    for (const control of [this.undo, this.retry, this.dismiss]) control.setAttribute("aria-describedby", this.message.id);
    resultActions.append(this.undo, this.retry, this.dismiss);
    this.result.append(this.message, resultActions);
    this.append(this.selectMode, this.toolbar, this.result);
  }

  get controls() {
    return [this.selectMode, this.selectAll, this.complete, this.reopen, this.clear, this.undo, this.retry, this.dismiss];
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.controls) control.disabled = this.isDisabled;
    if (!this.isDisabled) this.settleDeferredFocus();
  }

  settleDeferredFocus() {
    const target = this.deferredFocus;
    this.deferredFocus = null;
    const active = document.activeElement;
    const focusWasLost = !active || active === document.body || active.isConnected === false;
    if (target?.isConnected && !target.matches(":disabled") && focusWasLost) target.focus();
  }

  /**
   * Updates the bar's text and visibility; the list's rows are untouched.
   * @param records       the list's records (not archived)
   * @param selectedIds   Set of selected item IDs
   * @param selectionMode whether selection is on
   * @param completedOpen whether the Completed disclosure is open (completed
   *                      items count as visible only then)
   * @param result        the last bulk outcome from <kin-app>, or null
   */
  update({ records, selectedIds, selectionMode, completedOpen, result }) {
    // Read focus before any control hides: the browser drops focus from a
    // control the moment it is hidden.
    const controls = this.controls;
    const focused = controls.find((control) => control === document.activeElement || control === this.deferredFocus);
    const selected = records.filter((record) => selectedIds.has(record.itemId));
    const open = selected.filter((record) => record.status === "active").length;
    const done = selected.filter((record) => record.status === "completed").length;
    const visible = records.filter((record) => isBulkEligible(record) && (record.status === "active" || completedOpen)).length;
    this.selectMode.hidden = !records.length && !selectionMode;
    this.selectMode.textContent = selectionMode ? "Done selecting" : "Select";
    this.selectMode.setAttribute("aria-pressed", String(selectionMode));
    this.toolbar.hidden = !selectionMode;
    const n = selected.length;
    this.count.textContent = n ? `${n} ${n === 1 ? "item" : "items"} selected` : "No items selected";
    this.selectAll.hidden = !visible;
    this.selectAll.setAttribute("aria-label", `Select all ${visible} visible ${visible === 1 ? "item" : "items"}`);
    this.complete.hidden = !open;
    this.complete.textContent = `Complete ${open}`;
    this.complete.setAttribute("aria-label", `Complete ${open} selected ${open === 1 ? "item" : "items"}`);
    this.reopen.hidden = !done;
    this.reopen.textContent = `Reopen ${done}`;
    this.reopen.setAttribute("aria-label", `Reopen ${done} selected ${done === 1 ? "item" : "items"}`);
    this.clear.hidden = !n;
    this.result.hidden = !result;
    this.result.classList.toggle("bulk-result-error", Boolean(result?.error));
    this.message.textContent = result?.message ?? "";
    this.undo.hidden = !result?.canUndo;
    this.undo.textContent = result?.undoLabel ?? "Undo";
    this.retry.hidden = !result?.canRetry;
    for (const control of controls) control.disabled = this.isDisabled;
    // A focused control that just hid (Clear selection after clearing, Undo
    // after it ran) hands focus to the nearest control that is still shown.
    if (focused && (focused.hidden || focused.closest("[hidden]"))) {
      const fallback = [this.selectAll, this.selectMode].find((control) => !control.hidden && !control.closest("[hidden]"));
      this.focusControl(fallback);
    }
  }

  setProgress(text) {
    this.progress.textContent = text ?? "";
    this.progress.hidden = !text;
  }

  // After a bulk outcome: Undo, Retry or Dismiss, else the Select toggle
  // while selecting.
  focusResult(selectionMode) {
    const target = [this.undo, this.retry, this.dismiss].find((button) => !button.hidden && button.isConnected) ??
      (selectionMode ? this.selectMode : null);
    this.focusControl(target);
  }

  // Focuses `control` now, or once the bar is enabled if it is disabled.
  focusControl(control) {
    if (!control) return;
    if (control.matches(":disabled")) this.deferredFocus = control;
    else control.focus();
  }
}

customElements.define("kin-bulk-bar", KinBulkBar);
