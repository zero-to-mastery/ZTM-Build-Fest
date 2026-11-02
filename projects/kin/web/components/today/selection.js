// Bulk selection in To do and Shopping: selection mode, select all, clear,
// the row checkboxes, and the <kin-bulk-bar> that shows the selection and
// the last bulk outcome. Commands go to <kin-app> as kin:bulk-* events.
// Part of <kin-today>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-today.js lists them).
import { isBulkEligible } from "../../bulk-actions.js";

export class TodaySelection {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  selectedWithStatus(status) {
    return this.host.listRecords().filter((record) => record.status === status && this.host.selectedIds.has(record.itemId)).map((record) => record.itemId);
  }

  setSelectionMode(on) {
    this.host.selectionMode = Boolean(on) && this.host.isBulkList;
    if (!this.host.selectionMode) this.host.selectedIds.clear();
    this.host.render();
  }

  // Select all applies to eligible rows a person can see: open items, plus
  // completed ones only while the Completed disclosure is open.
  selectAllVisible() {
    const visible = this.host.listRecords().filter((record) => isBulkEligible(record) && (record.status === "active" || this.host.completedOpen));
    for (const record of visible) this.host.selectedIds.add(record.itemId);
    this.syncChecks();
    this.updateBulkBar();
  }

  clearSelection() {
    this.host.selectedIds.clear();
    this.syncChecks();
    this.updateBulkBar();
  }

  deselect(itemIds) {
    for (const itemId of itemIds) this.host.selectedIds.delete(itemId);
    this.syncChecks();
    this.updateBulkBar();
  }

  syncChecks() {
    for (const row of this.host.querySelectorAll("kin-item")) row.checked = this.host.selectedIds.has(row.record?.itemId);
  }

  // Outcome of the last bulk action or undo, from <kin-app>. The message is a
  // polite status; Undo and Retry are ordinary buttons outside the live text.
  setBulkResult(result) {
    this.host.bulkResult = result ?? null;
    this.updateBulkBar();
  }

  setBulkProgress(text) {
    this.host.bulkBar?.setProgress(text);
  }

  focusBulkResult() {
    this.host.bulkBar?.focusResult(this.host.selectionMode);
  }

  bulkAction(type, detail = {}) {
    this.host.dispatchEvent(new CustomEvent(`kin:${type}`, { detail, bubbles: true, composed: true }));
  }

  // The bar (<kin-bulk-bar>) is created once and re-appended on every render,
  // so its focus and outcome survive re-renders.
  ensureBulkBar() {
    if (this.host.bulkBar) return this.host.bulkBar;
    const bar = document.createElement("kin-bulk-bar");
    bar.setup(this.host.display, this.host.listTitle);
    bar.addEventListener("bulk-bar-action", (event) => this.handleBulkBarAction(event.detail.action));
    bar.disabled = this.host.isDisabled;
    this.host.bulkBar = bar;
    return bar;
  }

  // One button of the bar: selection changes stay here; commands go to
  // <kin-app> as kin:bulk-* events from this list.
  handleBulkBarAction(action) {
    switch (action) {
      case "select-mode":
        this.host.setSelectionMode(!this.host.selectionMode);
        this.host.bulkBar.selectMode.focus();
        break;
      case "select-all": this.selectAllVisible(); break;
      case "complete": this.host.bulkAction("bulk-item-action", { action: "complete", itemIds: this.selectedWithStatus("active") }); break;
      case "reopen": this.host.bulkAction("bulk-item-action", { action: "reopen", itemIds: this.selectedWithStatus("completed") }); break;
      case "clear": this.host.clearSelection(); break;
      case "undo": this.host.bulkAction("bulk-undo"); break;
      case "retry": this.host.bulkAction("bulk-retry"); break;
      case "dismiss":
        this.host.setBulkResult(null);
        this.host.bulkAction("bulk-dismiss");
        this.host.bulkBar.selectMode.focus();
        break;
    }
  }

  updateBulkBar() {
    this.host.bulkBar?.update({
      records: this.host.listRecords(),
      selectedIds: this.host.selectedIds,
      selectionMode: this.host.selectionMode,
      completedOpen: this.host.completedOpen,
      result: this.host.bulkResult,
    });
  }
}
