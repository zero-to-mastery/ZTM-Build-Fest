// Attachment capture, viewing, previews and the single app-owned file input.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { attachmentFileProblem, captureAttachment, loadLocalAttachmentRows, openAttachment, removeAttachment } from "../../attachments/attachment-lifecycle.js";
import { clearAttachmentProgress, setAttachmentProgress } from "../../attachments/attachment-progress.js";
import { isImageAttachment } from "../../attachments/attachment-preview.js";
import { ObjectUrlRegistry } from "../../attachments/object-urls.js";
import { ATTACHMENT_REMOVE_FORBIDDEN, canRemoveAttachments } from "../../attachments/attachment-permissions.js";
import { ATTACHMENT_OPEN_ERROR, SAVE_ERROR } from "./constants.js";

export class AttachmentController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  buildAttachmentInput() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp,application/pdf";
    input.className = "attachment-input";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.hidden = true;
    input.addEventListener("change", () => this.handleAttachmentChosen());
    input.addEventListener("cancel", () => { this.app.attachmentTarget = null; });
    return input;
  }
  // Runs synchronously inside the tap on an Add photo button, which is what
  // lets the browser open its native picker.
  handlePickAttachment(event) {
    const { parentKind, parentId, label } = event.detail ?? {};
    if (!parentKind || !parentId || !this.app.attachmentInput) return;
    if (!this.app.vault || this.app.vault.locked || !this.app.store) { this.ctx.status.showAlert("Unlock Kin before attaching a file."); return; }
    this.ctx.status.clearAlert();
    this.app.attachmentTarget = { parentKind, parentId, label: label ?? "" };
    this.app.attachmentInput.value = "";
    this.app.attachmentInput.click();
  }
  handleAttachmentChosen() {
    const target = this.app.attachmentTarget;
    this.app.attachmentTarget = null;
    const file = this.app.attachmentInput?.files?.[0] ?? null;
    if (this.app.attachmentInput) this.app.attachmentInput.value = "";
    if (!target || !file) return;
    void this.saveChosenAttachment(file, target);
  }
  // Programmatic entry (tests, future callers) that goes through the same
  // feedback and persistence path as a file chosen in the picker.
  handleAddAttachment(event) {
    const { file, parentKind, parentId } = event.detail ?? {};
    if (!file || !parentKind || !parentId) return;
    return this.saveChosenAttachment(file, { parentKind, parentId });
  }
  reportAttachmentProgress(target, phase, message) {
    const key = `${target.parentKind}:${target.parentId}`;
    clearTimeout(this.app.attachmentProgressTimers.get(key));
    this.app.attachmentProgressTimers.delete(key);
    setAttachmentProgress(target.parentKind, target.parentId, { phase, message });
    if (phase === "saved") {
      // Success text stays long enough to read; the tile itself carries the state.
      this.app.attachmentProgressTimers.set(key, setTimeout(() => {
        this.app.attachmentProgressTimers.delete(key);
        clearAttachmentProgress(target.parentKind, target.parentId);
      }, 8_000));
    }
  }
  async saveChosenAttachment(file, target) {
    const kind = isImageAttachment({ type: file?.type, name: file?.name }) ? "photo" : "file";
    const problem = attachmentFileProblem(file);
    if (problem) { this.reportAttachmentProgress(target, "error", problem); this.ctx.status.showAlert(problem); return { ok: false, message: problem }; }
    const lockedMessage = `Unlock Kin before attaching a ${kind}.`;
    if (!this.app.vault || this.app.vault.locked || !this.app.store || !this.app.engine) {
      this.reportAttachmentProgress(target, "error", lockedMessage); this.ctx.status.showAlert(lockedMessage); return { ok: false, message: lockedMessage };
    }
    this.reportAttachmentProgress(target, "preparing", `Preparing ${kind}…`);
    if (!(await this.ctx.refresh.untilIdle())) {
      const message = `Kin is still saving another change. Try adding the ${kind} again in a moment.`;
      this.reportAttachmentProgress(target, "error", message); this.ctx.status.showAlert(message); return { ok: false, message };
    }
    if (!this.app.vault || this.app.vault.locked || !this.app.store || !this.app.engine) {
      this.reportAttachmentProgress(target, "error", lockedMessage); return { ok: false, message: lockedMessage };
    }
    const session = this.ctx.session.captureSession();
    const { parentKind, parentId } = target;
    this.ctx.status.setBusy(true); this.ctx.status.clearAlert();
    this.reportAttachmentProgress(target, "saving", "Saving securely…");
    try {
      const saved = await captureAttachment({ file, parentKind, parentId, identity: this.app.syncCoordinator?.identity ?? this.app.household?.identity, store: session.store, keyStore: this.app.syncCoordinator?.keyStore, append: (command) => this.ctx.append.appendCommand(command) });
      this.ctx.session.assertCurrentSession(session);
      this.app.attachmentRows = [...this.app.attachmentRows.filter((row) => row.attachmentId !== saved.attachmentId), { ...saved, parentKind, parentId }];
      this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange();
      this.reportAttachmentProgress(target, "saved", this.app.syncCoordinator
        ? `${saved.name} is saved on this device and waiting to sync to your household.`
        : `${saved.name} is saved on this device.`);
      void this.app.syncCoordinator?.syncNow();
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) {
        clearAttachmentProgress(parentKind, parentId);
        return { ok: false, message: "Kin locked before the file was saved." };
      }
      const message = error.stage === "binding"
        ? `The ${kind} was protected but couldn't be linked to this record. Nothing else was changed; try again.`
        : error.stage === "validation"
        ? error.message
        : error.userMessage ?? (error.stage === "storage"
          ? `Kin couldn't save this ${kind} on this device. Check free storage space and try again.`
          : error.message || `Kin couldn't save this ${kind} on this device.`);
      this.reportAttachmentProgress(target, "error", message);
      this.ctx.status.showAlert(message);
      return { ok: false, message };
    } finally { if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setBusy(false); }
  }
  async handleOpenAttachment(event) {
    if (!this.app.store) { this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const session = this.ctx.session.captureSession();
    const detail = event.detail;
    const binding = this.app.state?.attachments?.find((item) => item.attachmentId === detail.attachmentId && !item.removed);
    if (!binding || binding.parentKind !== detail.parentKind || binding.parentId !== detail.parentId) { this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const tab = detail.download ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const opened = await this.loadAttachmentForView(detail, session);
      // Revoked after a minute, or at once if Kin locks first.
      const url = this.openedUrls.create(opened.blob);
      if (detail.download) { const link = document.createElement("a"); link.href = url; link.download = opened.name; link.hidden = true; document.body.append(link); link.click(); link.remove(); }
      else if (tab) tab.location.href = url;
      else { const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener"; link.click(); }
    } catch (error) { tab?.close(); if (error.code !== "locked") this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); }
  }
  async handleRemoveAttachment(event) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    if (!canRemoveAttachments(this.app.householdStatus?.memberKind)) {
      this.ctx.status.showAlert(ATTACHMENT_REMOVE_FORBIDDEN);
      return;
    }
    const session = this.ctx.session.captureSession(); this.ctx.status.setBusy(true); this.ctx.status.clearAlert();
    try {
      await removeAttachment({ attachmentId: event.detail.attachmentId, append: (command) => this.ctx.append.appendCommand(command), store: session.store });
      this.ctx.session.assertCurrentSession(session);
      this.app.attachmentPreviews?.forget(event.detail.attachmentId);
      if (this.app.viewerDetail?.attachmentId === event.detail.attachmentId) this.closeViewer();
      this.app.attachmentRows = this.app.attachmentRows.filter((row) => row.attachmentId !== event.detail.attachmentId);
      this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); void this.app.syncCoordinator?.syncNow();
    } catch (error) { if (error.code !== "locked" && this.ctx.session.isCurrentSession(session)) this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR); }
    finally { if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setBusy(false); }
  }
  // A sync pass describes attachments from the projection it started with. A
  // photo attached while that pass ran is missing from its rows, and one
  // removed meanwhile is still present; neither may override the newer local
  // state, so rows are reconciled against the current bindings.
  mergeAttachmentRows(incoming) {
    const bindings = this.app.state?.attachments ?? [];
    const bound = new Map(bindings.map((binding) => [binding.attachmentId, binding]));
    const rows = incoming.filter((row) => !bound.get(row.attachmentId)?.removed);
    const seen = new Set(rows.map((row) => row.attachmentId));
    for (const row of this.app.attachmentRows) {
      const binding = bound.get(row.attachmentId);
      if (!seen.has(row.attachmentId) && binding && !binding.removed) rows.push(row);
    }
    return rows;
  }
  async refreshAttachmentRows() {
    if (!this.app.store || !this.app.state || !this.app.vault || this.app.vault.locked) return;
    const session = this.ctx.session.captureSession();
    try {
      const rows = await loadLocalAttachmentRows({ store: session.store, state: this.app.state });
      if (!this.ctx.session.isCurrentSession(session)) return;
      this.app.attachmentRows = rows; this.ctx.render.renderState();
    } catch { /* A later sync retries attachment indexing. */ }
  }
  // Synchronous on purpose: a peek must return the cached entry itself, not a
  // promise, so tiles can paint immediately after a re-render.
  provideAttachmentPreview(record, { peek = false } = {}) {
    if (!this.app.attachmentPreviews || !isImageAttachment(record)) return null;
    if (peek) return this.app.attachmentPreviews.peek(record.attachmentId);
    return this.app.attachmentPreviews.get(record);
  }
  async loadAttachmentForView(detail, session) {
    const binding = this.app.state?.attachments?.find((item) => item.attachmentId === detail.attachmentId && !item.removed);
    if (!binding || binding.parentKind !== detail.parentKind || binding.parentId !== detail.parentId) throw new Error(ATTACHMENT_OPEN_ERROR);
    const syncState = await session.store.getSyncState();
    const opened = await openAttachment({ attachmentId: detail.attachmentId, binding, identity: this.app.syncCoordinator?.identity ?? (syncState ? { householdId: syncState.householdId } : null), store: session.store, keyStore: this.app.syncCoordinator?.keyStore });
    this.ctx.session.assertCurrentSession(session);
    return opened;
  }
  async handleViewAttachment(event) {
    if (!this.app.store || !this.app.viewer) { this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const session = this.ctx.session.captureSession();
    const detail = event.detail;
    try {
      const opened = await this.loadAttachmentForView(detail, session);
      if (!isImageAttachment({ type: opened.type, name: opened.name })) {
        return this.handleOpenAttachment({ detail });
      }
      this.closeViewer();
      this.app.viewerUrl = URL.createObjectURL(opened.blob);
      this.app.viewerDetail = { attachmentId: detail.attachmentId, parentKind: detail.parentKind, parentId: detail.parentId };
      this.app.viewerOpener = detail.opener ?? (this.app.contains(document.activeElement) ? document.activeElement : null);
      this.app.viewer.viewerTitle.textContent = opened.name;
      this.app.viewer.viewerImage.alt = opened.name;
      this.app.viewer.viewerImage.src = this.app.viewerUrl;
      this.app.viewer.showModal();
      this.app.viewer.querySelector(".attachment-viewer-close")?.focus();
    } catch (error) {
      if (error.code !== "locked" && this.ctx.session.isCurrentSession(session)) this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR);
    }
  }
  /** Shows an image the caller already decrypted (a journal photo, #503)
   * in the same viewer; Save file saves that blob. */
  viewBlob({ blob, name, opener = null }) {
    if (!this.app.viewer) return;
    this.closeViewer();
    this.app.viewerUrl = URL.createObjectURL(blob);
    this.app.viewerDetail = { blob, name };
    this.app.viewerOpener = opener ?? (this.app.contains(document.activeElement) ? document.activeElement : null);
    this.app.viewer.viewerTitle.textContent = name;
    this.app.viewer.viewerImage.alt = name;
    this.app.viewer.viewerImage.src = this.app.viewerUrl;
    this.app.viewer.showModal();
    this.app.viewer.querySelector(".attachment-viewer-close")?.focus();
  }
  async loadPreviewBlob(record) {
    const session = this.ctx.session.captureSession();
    this.ctx.session.assertCurrentSession(session);
    const opened = await this.loadAttachmentForView(record, session);
    return opened.blob;
  }
  buildAttachmentViewer() {
    const dialog = document.createElement("dialog");
    dialog.className = "attachment-viewer";
    dialog.setAttribute("aria-labelledby", "attachment-viewer-title");
    const bar = document.createElement("div");
    bar.className = "attachment-viewer-bar";
    const title = document.createElement("h2");
    title.id = "attachment-viewer-title";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "attachment-viewer-close";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    bar.append(title, close);
    const figure = document.createElement("div");
    figure.className = "attachment-viewer-figure";
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    figure.append(image);
    const actions = document.createElement("div");
    actions.className = "attachment-viewer-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save file";
    save.addEventListener("click", () => {
      if (!this.app.viewerDetail) return;
      if (this.app.viewerDetail.blob) {
        const link = document.createElement("a");
        link.href = this.openedUrls.create(this.app.viewerDetail.blob);
        link.download = this.app.viewerDetail.name;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        return;
      }
      void this.handleOpenAttachment({ detail: { ...this.app.viewerDetail, download: true } });
    });
    actions.append(save);
    dialog.append(bar, figure, actions);
    dialog.addEventListener("close", () => this.releaseViewer());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.viewerTitle = title;
    dialog.viewerImage = image;
    return dialog;
  }
  get openedUrls() {
    this.app.openedAttachmentUrls ??= new ObjectUrlRegistry();
    return this.app.openedAttachmentUrls;
  }
  /** Lock and household exit: no opened attachment stays reachable by URL. */
  revokeOpenedAttachments() {
    this.app.openedAttachmentUrls?.revokeAll();
  }
  releaseViewer() {
    if (this.app.viewerUrl) URL.revokeObjectURL(this.app.viewerUrl);
    this.app.viewerUrl = null;
    this.app.viewerDetail = null;
    if (this.app.viewer) {
      this.app.viewer.viewerImage.removeAttribute("src");
      this.app.viewer.viewerTitle.textContent = "";
    }
    const opener = this.app.viewerOpener;
    this.app.viewerOpener = null;
    if (opener?.isConnected) { opener.focus(); return; }
    // The row that opened the viewer may have been rebuilt meanwhile (a sync
    // tick, a progress update); return focus to the equivalent control.
    const { attachmentId, action, photoRef } = opener?.dataset ?? {};
    // A journal thumbnail (#503), redrawn by a private sync pass meanwhile.
    if (photoRef) {
      [...this.app.querySelectorAll(".journal-thumb[data-photo-ref]")].find((node) => node.dataset.photoRef === photoRef)?.focus();
      return;
    }
    if (!attachmentId) return;
    const matches = (root) => [...(root?.querySelectorAll?.("[data-attachment-id]") ?? [])]
      .find((node) => node.dataset.attachmentId === attachmentId && node.dataset.action === action &&
        !node.closest("[hidden]") && node.getClientRects().length > 0);
    const next = matches(this.app.detail) ?? matches(this.app);
    next?.focus();
  }
  closeViewer() {
    if (this.app.viewer?.open) this.app.viewer.close();
    else this.releaseViewer();
  }
}
