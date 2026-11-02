// Routine, schedule-change and Playbook commands.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { describeNextOccurrence, describeRecurringCapture, describeScheduleChanged, planScheduleChange, SCHEDULE_MESSAGES } from "../../../recurrence.js";
import { SAVE_ERROR } from "../constants.js";
import { routineArchivedEntry, routineCreatedEntry, routineOccurrenceEntry } from "../../../undo.js";

export class RoutineCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async saveRoutine(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    const todayFocused = this.app.today.contains(document.activeElement);
    if (todayFocused) this.app.today.rememberFocus();
    const focus = this.app.routines.captureFocus();
    let committed = false;
    const before = this.app.state;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(submitted);
      this.ctx.session.assertCurrentSession(session);
      committed = true;
      if (["complete-routine-occurrence", "archive-routine"].includes(submitted.type))
        void this.ctx.privatePrefs.endReminder(`routine:${submitted.routineId}`, "done").catch(() => {});
      this.ctx.peers.broadcastEventChange();
      this.ctx.render.renderState();
      if (submitted.type === "create-routine")
        this.app.routines.clearIfMatches(submitted);
      if (submitted.type === "archive-routine") this.app.routines.closeSchedule(submitted.routineId);
      // Feedback reads the Rust projection after the save, never a guess.
      const saved = submitted.routineId
        ? this.app.state.routines?.find((routine) => routine.routineId === submitted.routineId)
        : this.app.state.routines?.at(-1);
      const next = describeNextOccurrence(saved?.nextOn ?? null, this.ctx.navigation.currentCivilDate());
      this.ctx.status.setStatus(
        submitted.type === "create-routine"
          ? describeRecurringCapture(saved, this.ctx.navigation.currentCivilDate())
          : submitted.type === "archive-routine"
            ? "Routine deleted. Past completions are kept."
            : submitted.type === "complete-routine-occurrence"
              ? `Done for this period.${next ? ` ${next}.` : ""}`
              : "Reopened for this period.",
      );
      // Undo (#314, #315). Deleting has no confirmation: Undo is the way back.
      this.ctx.undo.record(
        submitted.type === "archive-routine" ? routineArchivedEntry(submitted.routineId, before)
          : submitted.type === "create-routine" ? routineCreatedEntry(submitted.routineId ?? saved?.routineId, this.app.state)
            : routineOccurrenceEntry(submitted.type, submitted.routineId, this.app.state),
      );
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.routineId) this.app.pendingRefresh = true;
      this.ctx.status.showAlert(
        committed
          ? "Your routine was saved. Try again to refresh the view."
          : (error.userMessage ?? SAVE_ERROR),
        committed ? this.app.retryRefresh : () => this.ctx.routines.saveRoutine(submitted),
        committed || !submitted.routineId ? null : submitted,
      );
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (todayFocused) { /* kin-today restored its own focus on render */ }
        else if (
          submitted.type === "create-routine" ||
          submitted.type === "archive-routine"
        )
          this.app.routines.focusInput();
        else this.app.routines.restoreFocus(focus);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // From Today: show the task's schedule editor on the Routines page.
  openRoutineSchedule(routineId) {
    if (!this.ctx.navigation.workspaceReady()) return;
    this.ctx.navigation.navigate("#routines");
    if (!this.app.routines.openSchedule(routineId)) this.ctx.status.setStatus(SCHEDULE_MESSAGES.gone);
  }
  // A schedule change is a new Routine starting today plus stopping the old
  // one, each an ordinary Rust-validated command (see planScheduleChange).
  // The replacement id is kept until the change finishes, so a retry after a
  // partial save resumes instead of creating a second repeating task.
  async changeRoutineSchedule(detail) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const vaultId = this.app.vault?.vaultId ?? null;
    const pending = this.app.pendingScheduleChange?.vaultId === vaultId ? this.app.pendingScheduleChange : null;
    const resume = pending?.routineId === detail.routineId && pending.cadence === detail.cadence;
    const change = Object.freeze({
      vaultId,
      routineId: detail.routineId,
      cadence: detail.cadence,
      replacementId: resume ? pending.replacementId : crypto.randomUUID().replaceAll("-", ""),
    });
    const plan = planScheduleChange(this.app.state, change, pending);
    if (plan.status !== "ready") {
      if (resume) this.app.pendingScheduleChange = null;
      this.ctx.status.setStatus(SCHEDULE_MESSAGES[plan.status]);
      return;
    }
    this.app.pendingScheduleChange = change;
    let step = null;
    let appended = 0;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      for (step of plan.steps) {
        await this.ctx.append.appendCommand(step);
        this.ctx.session.assertCurrentSession(session);
        appended++;
      }
      step = null;
      this.app.pendingScheduleChange = null;
      void this.ctx.privatePrefs.endReminder(`routine:${change.routineId}`, "canceled").catch(() => {});
      this.app.routines.closeSchedule(change.routineId);
      this.ctx.peers.broadcastEventChange();
      this.ctx.render.renderState();
      this.ctx.status.setStatus(describeScheduleChanged(change.cadence));
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      if (appended) this.ctx.peers.broadcastEventChange();
      this.ctx.render.renderState();
      this.ctx.status.showAlert(
        step && step.type !== "create-routine" ? SCHEDULE_MESSAGES.partial : (error.userMessage ?? SAVE_ERROR),
        () => this.ctx.routines.changeRoutineSchedule(change),
      );
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (!this.app.pendingScheduleChange) this.app.routines.focusRoutine(change.replacementId);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async handlePlaybookIntent(event) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const action = event.type.slice(4);
    const detail = event.detail;
    if (action === "instantiate-playbook") {
      const playbook = this.app.state?.playbooks?.find(record => record.playbookId === detail.playbookId && !record.archived);
      if (!playbook) return;
      const batch = { itemId: crypto.randomUUID().replaceAll("-", ""), title: playbook.title, steps: playbook.entries.map(text => ({ stepId: crypto.randomUUID().replaceAll("-", ""), text })) };
      return this.ctx.routines.instantiatePlaybook(batch);
    }
    const session = this.ctx.session.captureSession();
    const command = action === "save-playbook"
      ? { type: action, id: detail.playbookId ?? crypto.randomUUID().replaceAll("-", ""), title: detail.title, entries: detail.entries }
      : { type: action, playbookId: detail.playbookId };
    if (action === "save-playbook") detail.playbookId = command.id;
    this.ctx.status.setBusy(true); this.ctx.status.clearAlert(); this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(command); this.ctx.session.assertCurrentSession(session); this.app.routines.clearPlaybookEditor(); this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange();
      this.ctx.status.setStatus(action === "save-playbook" ? "Reusable checklist saved." : "Reusable checklist archived.");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () => this.handlePlaybookIntent(event), command); this.ctx.status.setStatus("");
    } finally { if (this.ctx.session.isCurrentSession(session)) { this.ctx.status.setBusy(false); this.ctx.peers.flushPeerRefresh(); } }
  }
  async instantiatePlaybook(batch) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession(); this.ctx.status.setBusy(true); this.ctx.status.clearAlert(); this.ctx.status.setStatus("Creating checklist…");
    let committed = 0;
    try {
      let item = this.app.state?.items.find(record => record.itemId === batch.itemId);
      if (!item) { await this.ctx.append.appendCommand({ type: "add", id: batch.itemId, text: batch.title, classification: "need" }); committed++; item = this.app.state?.items.find(record => record.itemId === batch.itemId); }
      for (const step of batch.steps) {
        if (item?.steps?.some(record => record.stepId === step.stepId)) continue;
        await this.ctx.append.appendCommand({ type: "add-item-step", itemId: batch.itemId, stepId: step.stepId, text: step.text });
        committed++;
        item = this.app.state?.items.find(record => record.itemId === batch.itemId);
      }
      this.ctx.session.assertCurrentSession(session); this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); this.ctx.status.setStatus("Checklist created under To do. It is now an ordinary household item.");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (committed) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
      this.ctx.status.showAlert(committed ? "Checklist partly created. Retry to add the remaining steps." : (error.userMessage ?? SAVE_ERROR), () => this.ctx.routines.instantiatePlaybook(batch)); this.ctx.status.setStatus("");
    } finally { if (this.ctx.session.isCurrentSession(session)) { this.ctx.status.setBusy(false); this.ctx.peers.flushPeerRefresh(); } }
  }
}
