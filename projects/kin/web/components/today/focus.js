// Keeping focus in place while the list re-renders: describing the focused
// control, finding its replacement (a completed row's Reopen, the row that
// took its place), and focusing a given Item.
// Part of <kin-today>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-today.js lists them).
import { captureFocus, isVisible, revealWithin } from "../shared/focus.js";

export class TodayFocus {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  captureFocus() {
    return captureFocus(this.host, {
      fallback: this.host.deferredFocus,
      describe: (control) => {
        const row = control.closest("kin-item");
        const section = control.closest("[data-section]");
        return {
          itemId: control.dataset.itemId ?? control.dataset.routineId,
          action: control.dataset.itemAction ?? control.dataset.action,
          summary: control.dataset.summary,
          // A private item's checkbox (#514), found again by its key.
          privateKey: control.closest(".private-row") ? control.dataset.focusKey ?? null : null,
          index: row ? [...this.host.querySelectorAll("kin-item")].indexOf(row) : -1,
          section: section?.dataset.section ?? null,
          sectionIndex: row && section ? [...section.querySelectorAll("kin-item")].indexOf(row) : -1,
        };
      },
    });
  }

  // When a row leaves its Today section (an earlier or later plan that was
  // completed), keep the person where they were: the row that took its place,
  // else the previous one, else the section heading.
  sectionFallback(focus) {
    if (!focus.section || focus.sectionIndex < 0) return null;
    const section = this.host.querySelector(`[data-section="${focus.section}"]`);
    if (!section) return this.host.querySelector('[data-section="today"] h2');
    const rows = [...section.querySelectorAll("kin-item")];
    const row = rows[Math.min(focus.sectionIndex, rows.length - 1)];
    return row?.querySelector(".complete-control, .item-open") ?? section.querySelector("h2");
  }

  // Three focus mechanisms work together here:
  // - render() snapshots focus before rebuilding rows and restores it after
  //   (captureFocus / restoreFocus below).
  // - `pendingFocus`: a command remembers focus before it starts
  //   (rememberFocus(), from app/commands), because busy will disable the
  //   focused control; the next render, or settleFocus(), applies it.
  // - `deferredFocus`: when the control to focus is disabled (busy), it is
  //   kept here and focused as soon as `disabled` turns false (the setter
  //   above). It also serves as captureFocus's fallback while focus is lost.
  rememberFocus() { this.host.pendingFocus = this.host.captureFocus(); }

  // Applies a remembered focus when an update rendered nothing.
  settleFocus() {
    const focus = this.host.pendingFocus;
    this.host.pendingFocus = null;
    this.host.restoreFocus(focus);
  }

  restoreFocus(focus) {
    if (!focus) return;
    if (isVisible(focus.control)) {
      revealWithin(focus.control, this.host);
      focus.control.focus();
      return;
    }
    if (focus.privateKey) {
      // Done moves it to Completed; elsewhere, its section's heading.
      const same = [...this.host.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focus.privateKey);
      if (isVisible(same)) { revealWithin(same, this.host); same.focus(); }
      else (this.host.querySelector(`[data-section="${focus.section ?? "today"}"] h2`) ?? this.host.querySelector('[data-section="today"] h2'))?.focus();
      return;
    }
    if (focus.summary) {
      const summary = this.host.querySelector(`[data-summary="${focus.summary}"]`);
      if (summary?.matches(":disabled")) this.host.deferredFocus = summary;
      else (summary ?? this.host.querySelector('[data-section="today"] h2'))?.focus();
      return;
    }
    const controls = [...this.host.querySelectorAll("[data-item-id], [data-routine-id]")].filter((control) => !control.closest("[hidden]") && control.matches("button, input, select"));
    const sameItem = controls.filter((control) => (control.dataset.itemId ?? control.dataset.routineId) === focus.itemId);
    const replacementAction = {
      complete: "reopen",
      reopen: "complete",
      "complete-routine-occurrence": "reopen-routine-occurrence",
      "reopen-routine-occurrence": "complete-routine-occurrence",
      pin: "unpin",
      unpin: "pin",
    }[focus.action];
    // Fallbacks, most specific first: the same action on the same row; its
    // counterpart (Complete becomes Reopen once the row flips); the row's
    // Details button; any control of the row; the row that took its place in
    // the section; the control at the same position in the list.
    const target = sameItem.find((control) => (control.dataset.itemAction ?? control.dataset.action) === focus.action)
      ?? (replacementAction ? sameItem.find((control) => (control.dataset.itemAction ?? control.dataset.action) === replacementAction) : null)
      ?? sameItem.find((control) => control.dataset.itemAction === "details")
      ?? sameItem[0]
      ?? this.sectionFallback(focus)
      ?? controls[Math.min(Math.max(0, focus.index), controls.length - 1)];
    const next = target ?? this.host.querySelector("h2");
    if (!next) return;
    revealWithin(next, this.host);
    if (next.matches(":disabled")) this.host.deferredFocus = next;
    else next.focus();
  }

  // Focus a row's Details control by canonical id (used when details close).
  focusItem(itemId, { preventScroll = false } = {}) {
    const target = [...this.host.querySelectorAll(".item-details-button")].find((node) => node.dataset.itemId === itemId)
      ?? [...this.host.querySelectorAll(".item-open")].find((node) => node.dataset.itemId === itemId);
    if (!target) return false;
    revealWithin(target, this.host);
    if (!preventScroll) target.scrollIntoView?.({ block: "nearest" });
    target.focus({ preventScroll });
    return true;
  }
}
