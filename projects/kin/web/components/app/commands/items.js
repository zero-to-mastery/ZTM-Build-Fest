// Item capture and lifecycle commands, steps, planning dates, responsibility and pins.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { CLASSIFICATION_LABELS } from "../../kin-compose.js";
import { describePartialCapture, remainingCaptureSteps } from "../../../capture-plan.js";
import { describeRecurringCapture, isCadence, remainingRecurringSteps } from "../../../recurrence.js";
import { randomId } from "../../../wasm/kin-engine.js";
import { INLINE_SAVE_FAILED, SAVE_ERROR } from "../constants.js";
import { itemActionFeedback, pendingActionShare } from "../feedback.js";
import { itemAddedEntry, itemArchivedEntry, itemDateEntry, itemStatusEntry, pinEntry, routineCreatedEntry } from "../../../undo.js";

export class ItemCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async handleAddItem(event) {
    if (this.app.busy || !this.app.store || !this.app.engine) {
      return;
    }
    const session = this.ctx.session.captureSession();
    // Every capture carries a client-generated id (hex, like projection ids)
    // so a retry after a partial success resumes against the same record
    // instead of creating another.
    const composer = event.detail.composer?.isConnected ? event.detail.composer : this.app.compose;
    const incoming = {
      text: event.detail.text,
      classification: event.detail.classification,
      planningDate: Number.isSafeInteger(event.detail.planningDate) ? event.detail.planningDate : null,
      pinned: Boolean(event.detail.pinned),
      cadence: isCadence(event.detail.cadence) ? event.detail.cadence : null,
      revision: event.detail.revision ?? 0,
      ...(event.detail.sourceStapleId ? { sourceStapleId: event.detail.sourceStapleId } : {}),
    };
    let pending = this.app.pendingCapture;
    const matches = (draft) => draft && draft.text === incoming.text && draft.classification === incoming.classification &&
      draft.planningDate === incoming.planningDate && draft.pinned === incoming.pinned && draft.sourceStapleId === incoming.sourceStapleId && draft.cadence === incoming.cadence && draft.revision === incoming.revision;
    if (pending && pending.composer !== composer) pending = null;
    if (pending && !matches(pending.draft)) {
      composer.showPendingCapture?.({
        finish: pending.retry,
        startNew: () => { this.app.pendingCapture = null; composer.clearResult?.(); this.ctx.items.handleAddItem(event); },
      });
      this.ctx.status.setStatus("An earlier item is partly saved. Finish it or choose Start a new item.");
      return;
    }
    const submittedDraft = Object.freeze({
      ...incoming,
      id: pending?.draft.id ?? event.detail.id ?? crypto.randomUUID().replaceAll("-", ""),
      revision: incoming.revision,
    });
    const sourceList = submittedDraft.sourceStapleId ? this.app.staples : null;
    // The capture form that submitted owns clearing and focus; the Today form
    // is the default for retries that carry no composer.
    const destination = CLASSIFICATION_LABELS[submittedDraft.classification] ?? "your lists";
    const retry = () => this.ctx.items.handleAddItem({ detail: { ...submittedDraft, composer } });
    if (pending) pending.retry = retry;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    let restoreComposeFocus = false;
    let step = null;
    try {
      // A repeating task is a Routine: one create command, nothing partial.
      const steps = submittedDraft.cadence ? remainingRecurringSteps(this.app.state, submittedDraft) : remainingCaptureSteps(this.app.state, submittedDraft);
      for (step of steps) {
        await this.ctx.append.appendCommand(step);
        this.ctx.session.assertCurrentSession(session);
      }
      step = null;
      // A replenished staple's store section (#411) goes with it, when it
      // can: the item is saved either way.
      const stapleSection = submittedDraft.sourceStapleId ? this.app.shoppingSections?.itemSections.get(submittedDraft.sourceStapleId) : null;
      if (stapleSection && this.app.shoppingSections?.itemSections.get(submittedDraft.id) !== stapleSection) {
        try {
          await this.ctx.append.appendCommand({ type: "set-item-section", itemId: submittedDraft.id, sectionId: stapleSection });
          this.ctx.session.assertCurrentSession(session);
        } catch (error) {
          if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) throw error;
        }
      }
      this.ctx.render.renderState();
      if (!sourceList) composer.clearIfMatches(submittedDraft);
      const where = submittedDraft.planningDate === this.ctx.navigation.currentCivilDate() ? `${destination} and Today` : destination;
      const recurring = submittedDraft.cadence ? this.app.state.routines?.find((routine) => routine.routineId === submittedDraft.id) : null;
      this.ctx.status.setStatus(`${recurring ? describeRecurringCapture(recurring, this.ctx.navigation.currentCivilDate()) : `Added to ${where}.`}${this.ctx.sync.offlineSyncSuffix()}`);
      if (!sourceList) {
        // Saved locally is not shared: with sync on, the line waits for the
        // relay to accept the change before it says "sent" (#267).
        if (this.app.syncCoordinator) {
          composer.showResult?.("Saved here. Waiting to sync.", { kind: "pending-sync" });
          (this.app.pendingShares ??= new Set()).add(composer);
        } else {
          composer.showResult?.("Saved on this device.");
        }
      }
      // Undo (#315): only when this run created it, not a resumed retry's
      // date or pin.
      if (steps.some((entry) => entry.type === "add" || entry.type === "create-routine"))
        this.ctx.undo.record(submittedDraft.cadence ? routineCreatedEntry(submittedDraft.id, this.app.state) : itemAddedEntry(submittedDraft.id, this.app.state));
      if (this.app.pendingCapture?.draft.id === submittedDraft.id) this.app.pendingCapture = null;
      this.ctx.peers.broadcastEventChange();
      restoreComposeFocus = !sourceList;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.render.renderState();
      const partial = step && step.type !== "add" && step.type !== "create-routine";
      const inline = step ? describePartialCapture(step, destination) : INLINE_SAVE_FAILED;
      if (!sourceList) this.app.pendingCapture = { draft: submittedDraft, composer, retry };
      this.ctx.status.showAlert(partial ? inline : (error.userMessage ?? SAVE_ERROR), retry);
      if (!sourceList && composer.showResult) { composer.showResult(inline, { kind: "error", retry }); this.app.feedback.classList.add("app-feedback-inline"); }
      this.ctx.status.setStatus("");
      restoreComposeFocus = !sourceList;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (sourceList) {
          const focusTarget = sourceList.querySelector(
            `[data-item-id="${submittedDraft.sourceStapleId}"][data-item-action="replenish"]`,
          );
          (focusTarget ?? sourceList.querySelector(".today-section h2"))?.focus();
        } else if (restoreComposeFocus) {
          composer.focusInput();
        }
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async handleReplenishStaple(event) {
    const staple = this.app.state?.items.find(
      (item) =>
        item.itemId === event.detail.itemId &&
        item.classification === "staple" &&
        item.status === "active",
    );
    if (!staple) {
      this.app.pendingRefresh = true;
      this.ctx.peers.flushPeerRefresh();
      this.ctx.status.setStatus("That staple is no longer available. Updating the list.");
      return;
    }
    return this.ctx.items.handleAddItem({
      detail: {
        text: staple.text,
        classification: "shopping",
        sourceStapleId: staple.itemId,
      },
    });
  }
  async handleItemAction(type, itemId) {
    if (this.app.busy || !this.app.store || !this.app.engine) {
      return;
    }
    const session = this.ctx.session.captureSession();
    const submittedItemId = itemId;
    // Named before the action: an archived item leaves the projection.
    const itemText = this.app.state?.items?.find((item) => item.itemId === submittedItemId)?.text ?? "";
    const activeList = [this.app.today, this.app.needs, this.app.shopping, this.app.staples].find((list) =>
      list.contains(document.activeElement),
    );
    const detailFocused = this.app.detail?.contains(document.activeElement);
    const restoreListFocus = Boolean(activeList) || detailFocused;
    activeList?.rememberFocus();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    let restoreComposeFocus = false;
    const before = this.app.state;
    try {
      await this.ctx.append.appendCommand({ type, itemId: submittedItemId });
      this.ctx.session.assertCurrentSession(session);
      if (["complete", "archive"].includes(type))
        void this.ctx.privatePrefs.endReminder(`item:${submittedItemId}`, "done").catch(() => {});
      this.ctx.render.renderState();
      // Name the item and say how far the change has gone (#267); with sync,
      // "Sent to your household." follows once the relay accepts it.
      const syncing = Boolean(this.app.syncCoordinator);
      this.ctx.status.setStatus(itemActionFeedback({ type, text: itemText, syncing, offline: navigator.onLine === false }));
      if (syncing) (this.app.pendingShares ??= new Set()).add(pendingActionShare());
      if (type === "archive") this.ctx.undo.record(itemArchivedEntry(submittedItemId, before));
      else if (type === "complete" || type === "reopen") this.ctx.undo.record(itemStatusEntry(type, submittedItemId, this.app.state));
      this.ctx.peers.broadcastEventChange();
      restoreComposeFocus = true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) {
        this.app.pendingRefresh = true;
      }
      this.ctx.status.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.ctx.items.handleItemAction(type, submittedItemId),
        { type, itemId: submittedItemId },
      );
      this.ctx.status.setStatus("");
      restoreComposeFocus = true;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (detailFocused) {
          const next = this.app.detail.querySelector('[data-focus-id="primary"]') ?? this.app.detail.querySelector(".item-detail-close");
          next?.focus();
        } else if (restoreComposeFocus && !restoreListFocus) {
          this.app.compose.focusInput();
        }
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async handleItemStep(type, detail) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const list = [this.app.today, this.app.needs, this.app.shopping, this.app.staples].find((candidate) => candidate.contains(document.activeElement)) ?? null;
    if (list) list.rememberFocus();
    const stepFocus = this.app.detail?.contains(document.activeElement) ? (document.activeElement.dataset.focusId ?? "add-step") : null;
    const session = this.ctx.session.captureSession();
    const command = Object.freeze({
      type,
      itemId: detail.itemId,
      ...(type === "add-item-step"
        ? { stepId: detail.stepId ?? randomId(), text: detail.text }
        : { stepId: detail.stepId }),
    });
    const submittedStep = command.type === "add-item-step" ? command.text : null;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      if (submittedStep != null) this.app.detail.clearStepDraft(command.itemId, submittedStep);
      this.app.detail.clearFeedback(command.itemId);
      this.ctx.detail.feedDetail();
      this.ctx.status.setStatus(
        type === "add-item-step"
          ? "Step added."
          : type === "complete-item-step"
            ? "Step completed."
            : type === "reopen-item-step"
              ? "Step reopened."
              : "Step archived.",
      );
      this.ctx.peers.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.render.renderState();
      this.ctx.append.showDetailActionError(command.itemId, error.userMessage ?? SAVE_ERROR,
        () => this.handleItemStep(type, command), command);
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (stepFocus && !this.app.detail.contains(document.activeElement)) {
          const target = type === "add-item-step" ? this.app.detail.stepInput : [...this.app.detail.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === stepFocus);
          (target && !target.disabled ? target : this.app.detail.stepInput)?.focus();
        }
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async handleCompleteItem(event) {
    return this.ctx.items.handleItemAction("complete", event.detail.itemId);
  }
  async handleReopenItem(event) {
    return this.ctx.items.handleItemAction("reopen", event.detail.itemId);
  }
  async handleArchiveItem(event) {
    return this.ctx.items.handleItemAction("archive", event.detail.itemId);
  }
  async saveItemPlanningDate(detail, sourceList) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    const before = this.app.state;
    try {
      await this.ctx.append.appendCommand({
        type: "set-item-planning-date",
        itemId: detail.itemId,
        planningDate: detail.planningDate,
      });
      this.ctx.session.assertCurrentSession(session);
      void this.ctx.privatePrefs.endReminder(`item:${detail.itemId}`, "canceled").catch(() => {});
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      this.app.detail.clearFeedback(detail.itemId);
      this.ctx.detail.feedDetail();
      this.ctx.status.setStatus(detail.planningDate ? "Planned date saved." : "Planned date cleared.");
      this.ctx.undo.record(itemDateEntry(detail.itemId, before, this.app.state));
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.render.renderState();
      this.ctx.append.showDetailActionError(detail.itemId, error.userMessage ?? SAVE_ERROR,
        () => this.saveItemPlanningDate(detail, sourceList));
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        (sourceList ?? this.app.detail)?.querySelector?.(
          `.item-planning-date-input[data-item-id="${detail.itemId}"]`,
        )?.focus();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async handleChangeResponsibility(event) {
    if (this.app.busy || this.app.reconcilingResponsibility || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession(); this.ctx.status.setBusy(true); this.ctx.status.clearAlert();
    try {
      const { targetKind, targetId, memberId } = event.detail;
      await this.ctx.append.appendCommand({ type: "change-responsibility", targetKind, id: targetId, memberId });
      this.ctx.session.assertCurrentSession(session); this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR);
    } finally {
      if (this.ctx.session.isCurrentSession(session)) { this.ctx.status.setBusy(false); this.ctx.peers.flushPeerRefresh(); }
    }
  }
  async savePin(detail) {
    if (this.app.busy || !this.app.store || !this.app.engine || detail.targetKind !== "item") return;
    const session = this.ctx.session.captureSession();
    const command = { type: detail.pinned ? "pin" : "unpin", targetKind: "item", targetId: detail.targetId };
    const list = [this.app.today, this.app.needs, this.app.shopping, this.app.staples].find((candidate) => candidate.contains(document.activeElement));
    list?.rememberFocus();
    const detailFocused = this.app.detail?.contains(document.activeElement);
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      this.ctx.status.setStatus(detail.pinned ? "Pinned for quick access." : "Unpinned.");
      this.ctx.undo.record(pinEntry(detail.targetId, detail.pinned, this.app.state));
      this.ctx.peers.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () => this.savePin(detail), command);
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (detailFocused && !this.app.detail.contains(document.activeElement)) this.app.detail.querySelector(".pin-button")?.focus();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  openPinnedItem(itemId, opener = null) {
    const item = this.app.state?.items.find((record) => record.itemId === itemId && record.status !== "archived");
    if (!item) { this.ctx.status.setStatus("That item is no longer available."); return; }
    this.ctx.detail.openItemDetail(itemId, { opener });
  }
}
