// Undo and redo (#315): the session's history, the toast that offers it, and
// running a reversal through the ordinary append path.
// State stays on the element (`this.app`); app/context.js explains the controllers.
//
// Handlers record a change after it saved (`ctx.undo.record(entry)`, with an
// entry from web/undo.js). The toast then offers Undo; after an undo it
// offers Redo. It stays until the next action or until it is dismissed: it
// never times out (WCAG 2.2.1). Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or Ctrl+Y)
// do the same outside text fields (navigation.js). Nothing is persisted or
// synced; locking clears it.
import {
  calendarInverse, calendarReversalStatus, describeReversal, inverseEntry, isOptionalStep, nextReversalStep, reversalStatus, UndoHistory,
} from "../../undo.js";
import { SAVE_ERROR } from "./constants.js";

// A reversal is a handful of commands; this only stops a runaway loop.
const MAX_STEPS = 64;

export class UndoController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.history = new UndoHistory();
    this.running = false;
  }

  /** Builds the toast into the feedback area (shell.js). */
  buildToast(feedback) {
    const toast = document.createElement("div");
    toast.className = "undo-toast";
    toast.hidden = true;
    const text = document.createElement("p");
    text.className = "undo-toast-text";
    text.id = "undo-toast-text";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "undo-toast-action";
    action.setAttribute("aria-describedby", text.id);
    action.addEventListener("click", () => void this.run(action.dataset.direction === "redo" ? "redo" : "undo"));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "undo-toast-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => this.hideToast());
    toast.append(text, action, dismiss);
    feedback.prepend(toast);
    this.toast = toast;
    this.toastText = text;
    this.toastAction = action;
  }

  /** A change saved: it can be undone. The toast shows the status line's
   * confirmation beside Undo; the status line still announces it (politely)
   * and steps out of sight while the toast repeats it. */
  record(entry) {
    if (!entry) return;
    this.history.record(entry);
    this.showToast(this.app.status?.textContent || `${entry.label.charAt(0).toUpperCase()}${entry.label.slice(1)}.`, "undo");
  }

  showToast(message, direction) {
    if (!this.toast) return;
    this.toastText.textContent = message;
    this.toastAction.textContent = direction === "redo" ? "Redo" : "Undo";
    this.toastAction.dataset.direction = direction;
    this.toast.hidden = false;
    this.syncStatus();
  }

  /** The status line hides only while the toast says the same thing. */
  syncStatus() {
    const status = this.app.status;
    if (!status) return;
    status.classList.toggle("status-in-toast", Boolean(this.toast && !this.toast.hidden && status.textContent && status.textContent === this.toastText.textContent));
  }

  /** Hides the toast. Focus inside it never drops to the page: it goes to
   * the view's heading. */
  hideToast() {
    if (!this.toast || this.toast.hidden) return;
    const hadFocus = this.toast.contains(document.activeElement);
    this.toast.hidden = true;
    this.toastText.textContent = "";
    this.syncStatus();
    if (hadFocus) this.app.main?.querySelector(".app-view:not([hidden]) h1")?.focus();
  }

  /** A change the member makes replaces the toast; background refreshes
   * and sync don't (called from the append path). */
  beforeChange() {
    if (!this.running) this.hideToast();
  }

  /** Locking, or leaving the household: nothing survives. */
  clear() {
    this.history.clear();
    this.hideToast();
  }

  async run(direction) {
    if (this.running || this.app.busy || !this.app.store || !this.app.engine) return;
    const entry = this.history.take(direction);
    if (!entry) {
      this.ctx.status.setStatus(describeReversal(null, direction, "empty"));
      return;
    }
    // A child's reward on the kitchen display (#705): undoing or redoing it
    // changes the reward again, so the adult whose device it is confirms
    // first, as for saving one. Cancelled or refused, nothing is written
    // and the entry stays, so Undo (or Redo) can be pressed again. The
    // entry goes back, and this run lets go, synchronously as the dialog
    // closes: a press straight after a cancel is a new Undo, not one
    // ignored while this run's promise chain unwinds.
    if (entry.kind === "chore-reward" && this.app.displayMode === true) {
      this.running = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.history.restore(direction, entry);
        this.running = false;
        this.ctx.status.setStatus(`Not ${direction === "redo" ? "redone" : "undone"}: the reward wasn't changed.`);
      };
      let confirmed = false;
      try {
        confirmed = await this.ctx.chores.confirmOnDisplay({ onSettle: (value) => { if (value !== true) release(); } });
      } catch { /* refused below */ }
      if (!confirmed || released) { release(); return; }
      // Confirmed: the run below takes over the guard.
      this.running = false;
    }
    // Calendar changes (#660) carry their own steps (web/undo.js).
    if (entry.kind === "calendar") return this.runCalendar(entry, direction);
    // Family-album entries (#673) also need the album, which isn't part of
    // the projection; it is read again after each step.
    const album = typeof entry.kind === "string" && entry.kind.startsWith("album-");
    // Chore rewards (#699) are worked out by Rust's chart query, also
    // outside the projection: the chart is read again the same way.
    const rewards = entry.kind === "chore-reward";
    const read = async () => (album ? { ...this.app.state, ...(await this.ctx.album.undoState()) }
      : rewards ? { ...this.app.state, choreRewards: await this.ctx.chores.rewards() } : this.app.state);
    let current = this.app.state;
    if (album || rewards) {
      // Held while the album is read, so a second press waits its turn.
      this.running = true;
      try { current = await read(); } catch { /* the album check below refuses */ } finally { this.running = false; }
    }
    const outcome = reversalStatus(entry, current);
    if (outcome !== "ready") {
      // Refused, so it is dropped: trying again would meet the same change.
      this.hideToast();
      this.ctx.status.setStatus(describeReversal(entry, direction, outcome));
      return;
    }
    const session = this.ctx.session.captureSession();
    const before = current;
    const memberIds = this.ctx.detail.responsibilityContext?.()?.memberIds ?? null;
    let appended = 0;
    // Pin, owner and area are restored when they can be; a refusal there
    // (ten pins already, say) skips that step rather than the whole undo.
    const skip = new Set();
    this.running = true;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus(direction === "redo" ? "Redoing…" : "Undoing…");
    try {
      for (let command, steps = 0; steps < MAX_STEPS && (command = nextReversalStep(entry, await read(), { memberIds, skip })); steps++) {
        try {
          await this.ctx.append.appendCommand(command);
          appended++;
        } catch (error) {
          if (error.code !== 4 || !isOptionalStep(entry, command)) throw error;
          skip.add(command.type);
        }
        this.ctx.session.assertCurrentSession(session);
      }
      // Undoing "Make private" (#517): the household item is back, so the
      // private copy goes. It has no Redo (its inverse is null).
      if (entry.kind === "item-made-private") await this.ctx.privateItems.removeCopy(entry.privateItemId);
      // Undoing an add archives it: its reminder goes too, as on Archive.
      if (entry.kind === "item-added") void this.ctx.privatePrefs?.endReminder(`item:${entry.itemId}`, "canceled").catch(() => {});
      if (entry.kind === "routine-created") void this.ctx.privatePrefs?.endReminder(`routine:${entry.routineId}`, "canceled").catch(() => {});
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      const inverse = inverseEntry(entry, before, await read());
      if (album) void this.ctx.album.refresh();
      if (inverse) this.history.settle(direction, inverse);
      const message = `${describeReversal(entry, direction, "done")}${this.ctx.sync.offlineSyncSuffix?.() ?? ""}`;
      this.ctx.status.setStatus(message);
      if (inverse) this.showToast(message, direction === "redo" ? "undo" : "redo");
      else this.hideToast();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (appended) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
      this.hideToast();
      if (error.code === 4) {
        // The household refused it: something changed. Dropped, and said so;
        // trying again would meet the same refusal.
        this.app.pendingRefresh = true;
        this.ctx.status.setStatus(appended
          ? `Only partly ${direction === "redo" ? "redone" : "undone"}: the rest changed since, maybe on another device.`
          : describeReversal(entry, direction, "conflict"));
        return;
      }
      // Back on its stack (storage or a lost connection): the steps resume
      // where they stopped.
      this.history.restore(direction, entry);
      this.ctx.status.showAlert(
        appended ? `Only partly ${direction === "redo" ? "redone" : "undone"}. Try again to finish.` : (error.userMessage ?? SAVE_ERROR),
        () => this.run(direction),
      );
      this.ctx.status.setStatus("");
    } finally {
      this.running = false;
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** Undo or redo of a calendar change (#660): its steps run in order
   * against the calendar's current marks (app/calendar.js). */
  async runCalendar(entry, direction) {
    const session = this.ctx.session.captureSession();
    const calendar = this.ctx.calendar;
    let marks;
    try {
      marks = await calendar.marks();
      this.ctx.session.assertCurrentSession(session);
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.history.restore(direction, entry);
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () => this.run(direction));
      return;
    }
    const outcome = calendarReversalStatus(entry, marks);
    if (outcome !== "ready") {
      this.hideToast();
      this.ctx.status.setStatus(describeReversal(entry, direction, outcome));
      return;
    }
    let appended = 0;
    this.running = true;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus(direction === "redo" ? "Redoing…" : "Undoing…");
    try {
      for (; entry.next < entry.steps.length; entry.next++) {
        const { command, optional } = entry.steps[entry.next];
        try {
          await this.ctx.append.appendCommand(command);
          appended++;
        } catch (error) {
          if (error.code !== 4 || !optional) throw error;
        }
        this.ctx.session.assertCurrentSession(session);
      }
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      const after = await calendar.marks();
      this.ctx.session.assertCurrentSession(session);
      this.history.settle(direction, calendarInverse(entry, after));
      void calendar.refresh();
      const message = `${describeReversal(entry, direction, "done")}${this.ctx.sync.offlineSyncSuffix?.() ?? ""}`;
      this.ctx.status.setStatus(message);
      this.showToast(message, direction === "redo" ? "undo" : "redo");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (appended) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); void calendar.refresh(); }
      this.hideToast();
      if (error.code === 4) {
        this.app.pendingRefresh = true;
        this.ctx.status.setStatus(appended
          ? `Only partly ${direction === "redo" ? "redone" : "undone"}: the rest changed since, maybe on another device.`
          : describeReversal(entry, direction, "conflict"));
        return;
      }
      this.history.restore(direction, entry);
      this.ctx.status.showAlert(
        appended ? `Only partly ${direction === "redo" ? "redone" : "undone"}. Try again to finish.` : (error.userMessage ?? SAVE_ERROR),
        () => this.run(direction),
      );
      this.ctx.status.setStatus("");
    } finally {
      this.running = false;
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
