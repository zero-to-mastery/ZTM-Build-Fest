// The single item-detail view and where it is mounted.
// State stays on the element (`this.app`); app/context.js explains the controllers.

// Shared empty list, so a household without responsibilities keeps one identity.
const NONE = Object.freeze([]);

export class DetailController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  openItemDetail(itemId, { opener = null, stepId = null, origin = null } = {}) {
    // Simple view has no item details (#345).
    if (!this.app.state || !this.app.vault || this.app.vault.locked || this.app.simpleView || this.app.displayMode) return;
    const record = this.app.state.items.find((item) => item.itemId === itemId) ?? null;
    const page = this.app.route?.page ?? "today";
    const sameItem = this.app.selection?.itemId === itemId;
    this.app.selection = {
      itemId,
      page,
      opener: sameItem ? this.app.selection.opener : (opener?.isConnected ? opener : this.app.selection?.opener ?? null),
      origin: origin ?? (sameItem ? this.app.selection?.origin : null),
      // The inline presentation hides the list; remember where it was scrolled.
      scrollY: sameItem ? this.app.selection.scrollY : window.scrollY,
    };
    this.app.detail.itemId = itemId;
    this.app.detail.closeLabel = this.app.selection.origin === "search" ? "Back to search" : this.ctx.navigation.layoutMode() === "inline" ? "Back to list" : "Close";
    this.feedDetail(record);
    this.mountDetail();
    this.renderSelection();
    if (stepId) this.app.detail.revealStep(stepId);
    else if (!sameItem) this.app.detail.focusHeading();
  }
  feedDetail(record = null) {
    const detail = this.app.detail;
    if (!detail || !this.app.selection) return;
    const item = record ?? this.app.state?.items.find((candidate) => candidate.itemId === this.app.selection.itemId) ?? null;
    detail.update({
      today: this.ctx.navigation.currentCivilDate(),
      previews: this.app.previewProvider,
      areaOptions: this.app.state?.areas ?? [],
      pinned: (this.app.state?.pins ?? []).some((pin) => pin.targetKind === "item" && pin.targetId === this.app.selection.itemId),
      pinLimitReached: (this.app.state?.pins ?? []).length >= 10,
      attachments: this.app.attachmentRows,
      responsibilityContext: this.responsibilityContext(),
      reminder: this.ctx.privatePrefs.reminderView().get(`item:${this.app.selection.itemId}`) ?? null,
      // Item picture (#347): Adults set it; on a device without sync the
      // person is the household's only member.
      emoji: this.app.itemEmojis?.get(this.app.selection.itemId) ?? null,
      // Unknown kind on a synced device: not until the status says Adult.
      canSetPicture: (this.app.householdStatus?.memberKind ?? (this.app.hasLocalSyncBinding ? null : "adult")) === "adult",
      // Just for me (#517): something this member added, with private
      // storage working here.
      canMakePrivate: this.ctx.privateItems.canMakePrivate(item),
      item,
    });
  }
  // The same object while its inputs are unchanged, so components given it
  // can skip re-rendering by identity.
  responsibilityContext() {
    const memberId = this.app.syncCoordinator?.identity?.memberId ?? this.app.store?.actorId ?? null;
    const responsibilities = this.app.state?.responsibilities ?? NONE;
    const active = this.app.activeMemberIds ?? null;
    // Preferred names (#224) where the device syncs; labels fall back (#344).
    const names = this.app.memberNameMap ?? null;
    const cached = this.cachedResponsibility;
    if (cached?.responsibilities === responsibilities && cached.memberId === memberId && cached.active === active && cached.names === names) return cached.context;
    const context = { responsibilities, memberId, memberIds: active ?? (memberId ? [memberId] : []), names };
    this.cachedResponsibility = { responsibilities, memberId, active, names, context };
    return context;
  }
  // Lock drops every reference into the closed session's state.
  clearResponsibilityContext() {
    this.cachedResponsibility = null;
  }
  // Places the single detail element according to the current layout.
  mountDetail() {
    if (!this.app.detail || !this.app.detailPanel || !this.app.detailSheet) return;
    const open = Boolean(this.app.selection && this.app.vault && !this.app.vault.locked);
    const mode = open ? this.ctx.navigation.layoutMode() : null;
    const previousMode = this.app.detailMode;
    if (mode === previousMode && open && this.app.detail.parentElement) {
      this.updateDetailDisabledState();
      return;
    }
    this.app.rehomingDetail = true;
    try {
      if (previousMode === "sheet" && mode !== "sheet" && this.app.detailSheet.open) { this.app.sheetClosingProgrammatically = true; this.app.detailSheet.close(); }
      if (!open) {
        this.app.detail.remove();
        this.app.detailPanel.hidden = true;
        this.app.detailPanel.classList.remove("detail-panel-inline", "detail-panel-side");
        this.app.main?.classList.remove("has-detail-side", "has-detail-inline");
        this.app.detailMode = null;
        return;
      }
      // update() renders now: focus may move into the detail right after.
      this.app.detail.update({ mode });
      if (mode === "sheet") {
        this.app.detailPanel.hidden = true;
        this.app.detailPanel.classList.remove("detail-panel-inline", "detail-panel-side");
        this.app.main?.classList.remove("has-detail-side", "has-detail-inline");
        this.app.detailSheet.append(this.app.detail);
        if (!this.app.detailSheet.open) this.app.detailSheet.showModal();
      } else {
        this.app.detailPanel.append(this.app.detail);
        this.app.detailPanel.hidden = false;
        this.app.detailPanel.classList.toggle("detail-panel-inline", mode === "inline");
        this.app.detailPanel.classList.toggle("detail-panel-side", mode === "side");
        this.app.main?.classList.toggle("has-detail-side", mode === "side");
        this.app.main?.classList.toggle("has-detail-inline", mode === "inline");
      }
      this.app.detail.update({ closeLabel: this.app.selection.origin === "search" ? "Back to search" : mode === "inline" ? "Back to list" : "Close" });
      this.app.detailMode = mode;
      this.updateDetailDisabledState();
    } finally {
      this.app.rehomingDetail = false;
    }
  }
  // The phone sheet is outside the workspace fieldset; inline and side
  // details are already disabled natively by that fieldset.
  updateDetailDisabledState() {
    const inSheet = Boolean(this.app.detail?.closest(".detail-sheet"));
    if (this.app.detail) this.app.detail.disabled = inSheet ? this.app.busy || !this.app.store : false;
  }
  closeItemDetail({ restoreFocus = true, fromDialog = false } = {}) {
    const selection = this.app.selection;
    if (!selection) return;
    this.app.selection = null;
    this.app.detail.itemId = null;
    if (this.app.detailSheet?.open) { this.app.sheetClosingProgrammatically = true; this.app.detailSheet.close(); }
    this.mountDetail();
    this.renderSelection();
    // The list keeps the position it had when the item was opened; focus
    // returns to the originating row without scrolling it somewhere else.
    const keepScroll = Number.isFinite(selection.scrollY) && selection.page === this.app.route?.page;
    const restoreScroll = () => { if (keepScroll) window.scrollTo({ top: selection.scrollY, behavior: "auto" }); };
    restoreScroll();
    if (!restoreFocus) return;
    if (selection.origin === "search" && this.app.route?.page !== "search") {
      this.ctx.navigation.navigate("#search");
      requestAnimationFrame(() => {
        ([...this.app.search.querySelectorAll("[data-result-id]")].find((node) => node.dataset.resultId === selection.originId) ?? this.app.search.queryInput)?.focus();
      });
      return;
    }
    const restored = [this.app.today, this.app.needs, this.app.shopping, this.app.staples]
      .filter((list) => !list.closest("[hidden]"))
      .some((list) => list.focusItem(selection.itemId, { preventScroll: keepScroll }));
    if (!restored) {
      if (selection.opener?.isConnected && !selection.opener.closest("[hidden]")) selection.opener.focus({ preventScroll: keepScroll });
      else this.app.main.querySelector(".app-view:not([hidden]) h2, .app-view:not([hidden]) h1")?.focus({ preventScroll: keepScroll });
    }
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }
  renderSelection() {
    const selected = this.app.selection?.itemId ?? null;
    // update() renders now, so the caller can move focus to the rebuilt row.
    for (const list of [this.app.today, this.app.needs, this.app.shopping, this.app.staples]) list?.update({ selected });
  }
  // The mobile presentation of item details: a full-height modal sheet that
  // hosts the same <kin-item-detail> element the other layouts use.
  buildDetailSheet() {
    const dialog = document.createElement("dialog");
    dialog.className = "detail-sheet";
    dialog.setAttribute("aria-label", "Item details");
    dialog.addEventListener("close", () => {
      // close() delivers this event asynchronously, so a re-home or an app-
      // initiated close leaves a flag that outlives the synchronous call.
      if (this.app.sheetClosingProgrammatically) { this.app.sheetClosingProgrammatically = false; return; }
      this.ctx.detail.closeItemDetail({ restoreFocus: true, fromDialog: true });
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!this.app.rehomingDetail) this.ctx.detail.closeItemDetail({ restoreFocus: true }); });
    return dialog;
  }
}
