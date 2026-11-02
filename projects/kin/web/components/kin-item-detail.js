import "./kin-attachments.js";
import "./kin-reminder.js";
import "./kin-responsibility.js";
import "./kin-emoji-picker.js";
import { describePlanningDate, KIND_LABELS } from "../today-view.js";
import { button } from "./shared/dom.js";
import { asArray, asFunction, defineProps, scheduleRender } from "./shared/props.js";
import { ItemDetailSections } from "./item-detail/sections.js";
import { helpButton } from "./shared/help-button.js";

// The one shared detail view for an item. <kin-app> owns a single instance
// and re-homes it between the mobile sheet, the inline column and the side
// column, so there is never a second copy of these editors. It renders from
// the canonical record it is given and re-applies in-progress drafts (an
// unsent step, reminder inputs) across background refreshes.

// The detail element's parts (./item-detail/), built once per element with one
// shared context { host, ...parts }; each part reaches the element as `this.host`.
const PARTS = {
  sections: ItemDetailSections,
};

class KinItemDetail extends HTMLElement {
  constructor() {
    super();
    this.ctx = { host: this };
    for (const [key, Part] of Object.entries(PARTS)) this.ctx[key] = new Part(this.ctx);
    this.record = null;
    this.requestedId = null;
    this.isDisabled = false;
    this.isPinned = false;
    this.pinLimit = false;
    this.ownerContext = NO_CONTEXT;
    this.attachmentRecords = [];
    this.previewProvider = null;
    this.areas = [];
    this.civilDate = null;
    this.reminderRecord = null;
    this.presentation = "side";
    this.backLabel = "Close";
    this.stepDraft = "";
    this.stepDrafts = new Map();
    this.reminderDrafts = new Map();
    this.detailFeedbacks = new Map();
    this.highlightStepId = null;
    this.addEventListener("kin:reminder-draft-cleared", (event) => {
      const itemId = event.detail?.id?.startsWith("item:") ? event.detail.id.slice(5) : null;
      if (itemId) this.reminderDrafts.delete(itemId);
    });
  }

  set itemId(value) {
    const previousId = this.record?.itemId ?? this.requestedId;
    if (previousId && this.stepInput) this.stepDrafts.set(previousId, this.stepInput.value);
    if (previousId && this.reminderControl?.editing) this.reminderDrafts.set(previousId, this.reminderControl.getDraftState());
    this.requestedId = value ?? null;
    if (value == null) {
      this.record = null; this.requestedId = null; this.highlightStepId = null;
      this.stepInput = null; this.reminderControl = null;
    } else if (value !== previousId) {
      this.record = null;
      this.stepInput = null;
      this.reminderControl = null;
    }
    if (value != null) this.stepDraft = this.stepDrafts.get(value) ?? "";
  }

  // Assigns several inputs and renders at most once, now (the props are the
  // properties defined with defineProps below the class, plus itemId and
  // reminder). Identical inputs render nothing, which keeps drafts and focus
  // in place across a refresh that did not change this Item.
  update(props) {
    for (const [key, value] of Object.entries(props)) this[key] = value;
    this.flushRender();
  }

  get itemId() { return this.record?.itemId ?? this.requestedId; }

  set reminder(value) { this.reminderRecord = value?.at ? { at: value.at, scope: value.scope, where: value.where } : null; if (this.reminderControl) this.reminderControl.reminder = this.reminderRecord; }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, select")) {
      if (control.closest("kin-reminder")) continue;
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
    if (this.reminderControl) this.reminderControl.disabled = this.isDisabled;
    // A control that could not take focus while the app was busy takes it now.
    if (!this.isDisabled) this.settleDeferredFocus();
  }

  settleDeferredFocus() {
    if (this.deferredFocusId) {
      const target = [...this.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === this.deferredFocusId);
      this.deferredFocusId = null;
      const active = document.activeElement;
      const focusWasLost = !active || active === document.body || active.isConnected === false;
      if (target && !target.matches(":disabled") && focusWasLost) target.focus();
    }
  }

  get hasDraft() {
    return [...this.stepDrafts.values()].some((value) => value.trim()) || this.reminderDrafts.size > 0 || this.detailFeedbacks.size > 0 || Boolean(this.reminderControl?.hasDraft);
  }

  connectedCallback() { this.render(); }

  focusHeading() { this.querySelector(".item-detail-title")?.focus(); }

  focusClose() { this.querySelector(".item-detail-close")?.focus(); }

  deferFocusedControl() {
    if (this.contains(document.activeElement))
      this.deferredFocusId = document.activeElement.dataset.focusId ?? "close";
  }

  // Search results for a checklist step open the parent with that step exposed.
  revealStep(stepId) {
    this.highlightStepId = stepId;
    this.render();
    const checkbox = this.querySelector(`[data-step-id="${stepId}"][type="checkbox"]`);
    checkbox?.scrollIntoView?.({ block: "center" });
    checkbox?.focus();
  }

  captureDrafts() {
    this.captureStepDraft();
    return { step: this.stepDrafts.get(this.itemId) ?? "", focusId: this.contains(document.activeElement) ? document.activeElement.dataset.focusId ?? null : null };
  }

  captureStepDraft() {
    const id = this.record?.itemId ?? this.requestedId;
    if (id && this.stepInput) this.stepDrafts.set(id, this.stepInput.value);
  }

  clearStepDraft(itemId, submitted) {
    if (this.stepDrafts.get(itemId) === submitted) this.stepDrafts.delete(itemId);
    if (this.itemId === itemId && this.stepInput?.value === submitted) {
      this.stepInput.value = "";
      this.stepDraft = "";
    }
  }

  // Feedback changes what the detail shows, so each schedules a render; the
  // next update() (renderState) flushes it even when no input changed.
  setFeedback(itemId, feedback) { this.detailFeedbacks.set(itemId, feedback); scheduleRender(this); }

  clearFeedback(itemId) { this.detailFeedbacks.delete(itemId); scheduleRender(this); }

  render() {
    const hadFocus = this.contains(document.activeElement);
    const drafts = this.captureDrafts();
    this.stepDraft = drafts.step;
    const section = document.createElement("section");
    section.className = `item-detail item-detail-${this.presentation}`;
    section.setAttribute("aria-labelledby", "item-detail-title");
    const header = document.createElement("div");
    header.className = "item-detail-bar";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "item-detail-close";
    close.textContent = this.backLabel;
    close.dataset.focusId = "close";
    close.setAttribute("aria-label", this.backLabel === "Close" ? "Close details" : this.backLabel);
    close.addEventListener("click", () => this.dispatch("close-item-detail", {}));
    // Help for details (#621).
    header.append(close, helpButton("dialog:item-detail"));
    section.append(header);

    const title = document.createElement("h2");
    title.id = "item-detail-title";
    title.className = "item-detail-title";
    title.tabIndex = -1;
    const record = this.record;
    if (!record || record.status === "archived") {
      title.textContent = record ? record.text : "This item isn't available";
      const explain = document.createElement("p");
      explain.className = "item-detail-note";
      explain.textContent = record
        ? "This item was archived. Its history stays in the household record, and nothing else here can be changed."
        : "It may have been archived or removed on another device, or it is no longer in this household's records.";
      section.append(title, explain);
      if (record?.lastChangedAt) section.append(this.ctx.sections.lastChanged(record));
      this.replaceChildren(section);
      this.stepInput = null;
      this.reminderControl = null;
      if (hadFocus) {
        if (close.matches(":disabled")) this.deferredFocusId = "close";
        else close.focus();
      }
      return;
    }

    title.textContent = record.text;
    const kind = document.createElement("p");
    kind.className = "item-detail-kind";
    const planned = this.civilDate != null ? describePlanningDate(record.planningDate, this.civilDate) : null;
    kind.textContent = [KIND_LABELS[record.classification] ?? "Item", record.status === "completed" ? "Completed" : "Open", planned].filter(Boolean).join(" · ");
    section.append(title, kind);
    const detailFeedback = this.detailFeedbacks.get(record.itemId);
    if (detailFeedback) {
      const feedback = document.createElement("div");
      feedback.className = "item-detail-feedback";
      const message = document.createElement("p");
      message.className = "error-message";
      message.setAttribute("role", "alert");
      message.textContent = detailFeedback.message;
      feedback.append(message);
      if (typeof detailFeedback.retry === "function") {
        const retry = this.button("Try again", detailFeedback.retry, "retry-button");
        retry.dataset.detailRetry = "true";
        feedback.append(retry);
      }
      section.append(feedback);
    }

    const primary = document.createElement("div");
    primary.className = "item-detail-primary";
    if (record.classification === "staple") {
      const replenish = this.button("Add to Shopping", () => this.dispatch("replenish-staple", { itemId: record.itemId }), "primary-action replenish-button");
      replenish.setAttribute("aria-label", `Add ${record.text} to Shopping`);
      replenish.dataset.itemAction = "replenish";
      replenish.dataset.focusId = "primary";
      primary.append(replenish);
    } else {
      const completed = record.status === "completed";
      const action = this.button(completed ? "Reopen" : "Mark complete", () => this.dispatch(`${completed ? "reopen" : "complete"}-item`, { itemId: record.itemId }), completed ? "reopen-button" : "primary-action complete-button");
      action.setAttribute("aria-label", `${completed ? "Reopen" : "Complete"} ${record.text}`);
      action.dataset.itemAction = completed ? "reopen" : "complete";
      action.dataset.focusId = "primary";
      primary.append(action);
    }
    section.append(primary);

    if (record.classification !== "staple") section.append(this.ctx.sections.createChecklist(record, drafts));
    section.append(this.ctx.sections.createAttachments(record));
    section.append(this.ctx.sections.createPlanning(record));
    section.append(this.ctx.sections.createResponsibility(record));
    if (this.pictureAllowed && record.status !== "archived") section.append(this.ctx.sections.createPicture(record));
    section.append(this.ctx.sections.createArea(record));
    section.append(this.ctx.sections.createReminder(record));
    section.append(this.ctx.sections.createQuickAccess(record));
    section.append(this.ctx.sections.createArchive(record));
    this.replaceChildren(section);
    this.disabled = this.isDisabled;
    if (drafts.focusId) {
      const target = [...this.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === drafts.focusId);
      if (target && !target.matches(":disabled")) target.focus();
      else if (target) this.deferredFocusId = drafts.focusId;
    }
  }

  button(label, action, className = "") { return button(label, action, { className, disabled: this.isDisabled }); }

  dispatchPlanningDate(planningDate) {
    if (this.record.planningDate === planningDate) return;
    this.dispatch("set-item-planning-date", { itemId: this.record.itemId, planningDate });
  }

  dispatch(action, detail) {
    this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
}


// The detail's inputs. Each assignment stores the coerced value and schedules
// one microtask render; an identical value does nothing (shared/props.js).
// update() assigns several and renders at once.
const NO_CONTEXT = Object.freeze({});
defineProps(KinItemDetail, {
  item: { field: "record", coerce: (value) => value ?? null },
  areaOptions: { field: "areas", coerce: asArray },
  pinned: { field: "isPinned", coerce: Boolean },
  pinLimitReached: { field: "pinLimit", coerce: Boolean },
  attachments: { field: "attachmentRecords", coerce: asArray },
  previews: { field: "previewProvider", coerce: asFunction },
  responsibilityContext: { field: "ownerContext", coerce: (value) => value ?? NO_CONTEXT },
  today: { field: "civilDate", coerce: (value) => (Number.isSafeInteger(value) ? value : null) },
  mode: { field: "presentation" },
  closeLabel: { field: "backLabel", coerce: (value) => value || "Close" },
  // Item picture (#347): the item's emoji, and whether this member sets one.
  emoji: { field: "emojiValue", coerce: (value) => value || null },
  canSetPicture: { field: "pictureAllowed", coerce: Boolean },
  // Just for me (#517): whether this member may make the item private.
  canMakePrivate: { field: "makePrivateAllowed", coerce: Boolean },
});

customElements.define("kin-item-detail", KinItemDetail);
