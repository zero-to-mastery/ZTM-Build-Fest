// Bulk complete/reopen with in-memory undo and retry sets.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { BULK_ACTIONS, describeBulkOutcome, planBulk, undoCommand, undoStatus } from "../../../bulk-actions.js";
import { BULK_UNDO_UNVERIFIED, BULK_UNDO_WINDOW_MS } from "../constants.js";

export class BulkCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  bulkListFrom(event) {
    const list = event.target?.closest?.("kin-today");
    return list && [this.app.needs, this.app.shopping].includes(list) && list.isBulkList ? list : null;
  }
  clearBulkOutcome() {
    clearTimeout(this.app.bulkUndoTimer);
    this.app.bulkUndoTimer = null;
    this.app.bulkUndo = null;
    this.app.bulkRetry = null;
  }
  // Undo is offered for ten minutes, until it runs, until the next bulk action
  // or Dismiss, or until lock, logout, or a household change ends the session.
  armBulkUndo(record) {
    clearTimeout(this.app.bulkUndoTimer);
    this.app.bulkUndo = record;
    this.app.bulkUndoTimer = setTimeout(() => {
      if (this.app.bulkUndo !== record) return;
      this.app.bulkUndo = null;
      if (record.list.isConnected && record.list.bulkResult) record.list.setBulkResult({ ...record.list.bulkResult, canUndo: false });
    }, BULK_UNDO_WINDOW_MS);
  }
  async handleBulkItemAction(event) {
    const list = this.bulkListFrom(event);
    const { action, itemIds } = event.detail ?? {};
    if (!list || !BULK_ACTIONS[action] || !Array.isArray(itemIds)) return;
    if (this.app.busy || this.app.bulkRunning || !this.app.store || !this.app.engine || !this.app.state) return;
    this.ctx.bulk.clearBulkOutcome();
    const plan = planBulk(action, itemIds, this.app.state.items);
    await this.runBulk({ list, action, targets: plan.targets, skipped: plan.skipped.length });
  }
  async handleBulkRetry(event) {
    const list = this.bulkListFrom(event);
    const record = this.app.bulkRetry;
    if (!list || !record || record.list !== list || record.generation !== this.app.securityGeneration) return;
    if (this.app.busy || this.app.bulkRunning || !this.app.store || !this.app.state) return;
    this.app.bulkRetry = null;
    const plan = planBulk(record.action, record.itemIds, this.app.state.items);
    // Earlier successes of the same action stay undoable alongside the retry.
    const carried = this.app.bulkUndo?.list === list && this.app.bulkUndo.action === record.action ? this.app.bulkUndo.changes : [];
    await this.runBulk({ list, action: record.action, targets: plan.targets, skipped: plan.skipped.length, carried });
  }
  async runBulk({ list, action, targets, skipped, carried = [] }) {
    const spec = BULK_ACTIONS[action];
    const session = this.ctx.session.captureSession();
    const succeeded = [];
    const failed = [];
    const started = performance.now();
    this.app.bulkRunning = true;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("");
    list.setBulkResult(null);
    try {
      for (const [index, itemId] of targets.entries()) {
        list.setBulkProgress(`${action === "complete" ? "Completing" : "Reopening"} ${index + 1} of ${targets.length}…`);
        try {
          await this.ctx.append.appendCommand({ type: spec.command, itemId });
          const record = this.app.state.items.find((item) => item.itemId === itemId);
          succeeded.push({ itemId, to: spec.to, changedAt: record?.lastChangedAt ?? null });
          if (action === "complete") void this.ctx.privatePrefs.endReminder(`item:${itemId}`, "done").catch(() => {});
        } catch (error) {
          // Changes committed before a lock stay committed; nothing from the
          // old session may touch the new interface.
          if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
          if (error.code === 4) this.app.pendingRefresh = true;
          failed.push(itemId);
        }
      }
    } finally {
      this.app.bulkRunning = false;
      if (this.ctx.session.isCurrentSession(session)) {
        this.app.lastBulkMetric = { action, count: targets.length, ms: performance.now() - started };
        list.setBulkProgress("");
        if (succeeded.length) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
        list.deselect(succeeded.map((change) => change.itemId));
        const changes = [...carried, ...succeeded];
        if (changes.length) this.armBulkUndo({ list, action, changes, generation: session.generation });
        if (failed.length) this.app.bulkRetry = { list, action, itemIds: failed, generation: session.generation };
        list.setBulkResult({
          message: describeBulkOutcome(action, { succeeded: succeeded.length, failed: failed.length, skipped }),
          error: failed.length > 0,
          canUndo: changes.length > 0,
          undoLabel: action === "complete" ? "Undo: reopen these" : "Undo: complete these",
          canRetry: failed.length > 0,
        });
        this.ctx.status.setBusy(false);
        list.focusBulkResult();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // Undo is a new, authorized compensating command per Item, never a rewrite
  // of history. Before each one the Item must still be in the status this
  // device left it in and carry the same Rust-derived lastChangedAt; Rust then
  // re-checks the status atomically inside the append. The remaining gap: a
  // change authored elsewhere that has not reached this device yet cannot be
  // seen, and is reconciled by normal sync ordering afterwards.
  async handleBulkUndo(event) {
    const list = this.bulkListFrom(event);
    const record = this.app.bulkUndo;
    if (!list || !record || record.list !== list || record.generation !== this.app.securityGeneration) return;
    if (this.app.busy || this.app.bulkRunning || !this.app.store || !this.app.engine) return;
    this.ctx.bulk.clearBulkOutcome();
    const session = this.ctx.session.captureSession();
    const undone = [];
    const conflicts = [];
    const failed = [];
    let unverified = false;
    this.app.bulkRunning = true;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    list.setBulkResult(null);
    try {
      let items;
      try {
        items = (await this.ctx.refresh.readAuthoritativeState(session)).items;
      } catch (error) {
        if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
        // Fail closed: the rendered projection may be stale, so checking
        // against it could overwrite a newer change. Nothing is undone and
        // the whole undo set stays available to try again.
        unverified = true;
        return;
      }
      for (const [index, change] of record.changes.entries()) {
        list.setBulkProgress(`Undoing ${index + 1} of ${record.changes.length}…`);
        if (undoStatus(change, items) !== "ready") { conflicts.push(change); continue; }
        try {
          await this.ctx.append.appendCommand({ type: undoCommand(change), itemId: change.itemId });
          items = this.app.state.items;
          undone.push(change);
        } catch (error) {
          if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
          // Rust rejected the status precondition: the Item changed in between.
          if (error.code === 4) { this.app.pendingRefresh = true; conflicts.push(change); }
          else failed.push(change);
        }
      }
    } finally {
      this.app.bulkRunning = false;
      if (this.ctx.session.isCurrentSession(session)) {
        list.setBulkProgress("");
        if (undone.length) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
        // Items failed for a local reason (not a conflict) can be undone again.
        const retryable = unverified ? record.changes : failed;
        if (retryable.length) this.armBulkUndo({ ...record, changes: retryable, generation: session.generation });
        list.setBulkResult({
          message: unverified
            ? BULK_UNDO_UNVERIFIED
            : describeBulkOutcome(record.action, { succeeded: undone.length, conflicts: conflicts.length, failed: failed.length, undo: true }),
          error: unverified || failed.length > 0 || conflicts.length > 0,
          canUndo: retryable.length > 0,
          undoLabel: "Try undo again",
          canRetry: false,
        });
        this.ctx.status.setBusy(false);
        list.focusBulkResult();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
