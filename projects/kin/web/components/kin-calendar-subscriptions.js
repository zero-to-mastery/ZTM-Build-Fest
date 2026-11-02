// Household › Identity & appearance › Outside calendars (#668, ADR 0022 §3):
// the Google, Apple or Outlook calendars this member sees beside the
// family's, synced through the household's Kin server.
//
// An Adult pastes a calendar's private iCal link, chooses "Just me" or
// "Everyone in the household", reads what turning it on means (the
// ADR's words: the server downloads it about every 30 minutes and can read
// it while it does) and confirms. The list shows each calendar with who
// sees it, when it was last updated or why it couldn't be, and what comes
// next; whoever added a calendar, or a household admin, can turn it off for
// everyone. Limited and Temporary members see the shared calendars but
// can't add one. A household that doesn't sync with a Kin server can't sync
// outside calendars (importing a .ics file still works).
//
// `controller` is app/calendar-sync.js: add(url, audience), remove(id),
// refresh(); it calls update(view) with feed-refresh.js view() plus
// `state` "local" before a household syncs.
import { FEED_WARNING, FeedLinkError, normalizeFeedUrl } from "../calendar/feed-link.js";

let instances = 0;

const STATE_LINES = Object.freeze({
  local: "Outside calendars sync through your household's Kin server. Connect this household to a Kin server to use them; you can still import a calendar file.",
  unavailable: "Kin can't reach your household's calendars from this device right now.",
  offline: "You're offline. These are the calendars as this device last saw them.",
  loading: "Loading your calendars…",
});
const AUDIENCE_LABELS = Object.freeze({ me: "Just you", household: "Everyone in the household" });

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "just now", "12 minutes ago", or a time, from `at` (ms). */
export function updatedText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "Not updated yet";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? `Updated at ${timeFormat.format(date)}` : `Updated ${dayFormat.format(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))}`;
}

/** "Mon 2 Nov" for a civil date YYYYMMDD. */
export function civilDayText(date) {
  return dayFormat.format(Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100));
}

class KinCalendarSubscriptions extends HTMLElement {
  constructor() {
    super();
    this.controller = null;
    this.view = { state: "local", canAdd: false, subscriptions: [] };
    this.busy = false;
    this.confirmingRemove = null;
  }

  connectedCallback() {
    if (!this.list) this.build();
    this.render();
  }

  build() {
    const id = `calendar-subscriptions-${++instances}`;
    this.className = "calendar-subscriptions";
    this.setAttribute("role", "group");
    const heading = document.createElement("h2");
    heading.id = `${id}-heading`;
    heading.textContent = "Outside calendars";
    this.setAttribute("aria-labelledby", heading.id);
    const lead = document.createElement("p");
    lead.className = "section-hint";
    lead.textContent = "Show a Google, Apple or Outlook calendar beside your family's. Its events appear read-only, marked with where they came from, and stay out of your household's history.";
    this.stateLine = document.createElement("p");
    this.stateLine.className = "section-hint calendar-sync-state";

    this.list = document.createElement("ul");
    this.list.className = "calendar-subscription-list";
    this.list.setAttribute("aria-label", "Synced calendars");
    this.empty = document.createElement("p");
    this.empty.className = "section-hint calendar-subscription-empty";
    this.empty.textContent = "No outside calendars yet.";

    // Adding: the link and who sees it, then the warning and a confirmation.
    this.form = document.createElement("form");
    this.form.className = "calendar-subscription-form";
    this.form.noValidate = true;
    const formHeading = document.createElement("h3");
    formHeading.textContent = "Add a calendar";
    const urlLabel = document.createElement("label");
    urlLabel.htmlFor = `${id}-url`;
    urlLabel.textContent = "Private calendar link";
    this.urlInput = document.createElement("input");
    this.urlInput.type = "url";
    this.urlInput.id = `${id}-url`;
    this.urlInput.name = "url";
    this.urlInput.autocomplete = "off";
    this.urlInput.spellcheck = false;
    this.urlInput.inputMode = "url";
    this.urlInput.placeholder = "https:// or webcal://";
    const urlHint = document.createElement("p");
    urlHint.id = `${id}-url-hint`;
    urlHint.className = "section-hint";
    urlHint.textContent = "Copy the calendar's private iCal (.ics) link. Google Calendar: Settings, your calendar, “Secret address in iCal format”. Apple iCloud: Share Calendar, Public Calendar. Outlook: Settings, Shared calendars, Publish a calendar, ICS.";
    this.urlError = document.createElement("p");
    this.urlError.id = `${id}-url-error`;
    this.urlError.className = "field-error calendar-subscription-error";
    this.urlError.hidden = true;
    this.urlInput.setAttribute("aria-describedby", `${urlHint.id} ${this.urlError.id}`);
    this.urlInput.addEventListener("input", () => this.clearError());

    const audience = document.createElement("fieldset");
    audience.className = "calendar-subscription-audience";
    const legend = document.createElement("legend");
    legend.textContent = "Who sees it";
    audience.append(legend);
    this.audienceInputs = new Map();
    for (const [value, label] of [["me", "Just me"], ["household", "Everyone in the household"]]) {
      const wrapper = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${id}-audience`;
      input.value = value;
      input.checked = value === "me";
      wrapper.append(input, label);
      audience.append(wrapper);
      this.audienceInputs.set(value, input);
    }
    this.continueButton = document.createElement("button");
    this.continueButton.type = "submit";
    this.continueButton.className = "primary-action calendar-subscription-continue";
    this.continueButton.textContent = "Continue";

    // The warning, shown before anything is sent.
    this.confirm = document.createElement("div");
    this.confirm.className = "calendar-subscription-confirm";
    this.confirm.setAttribute("role", "group");
    this.confirm.hidden = true;
    const confirmHeading = document.createElement("h4");
    confirmHeading.id = `${id}-confirm-heading`;
    confirmHeading.tabIndex = -1;
    confirmHeading.textContent = "Before you turn it on";
    this.confirm.setAttribute("aria-labelledby", confirmHeading.id);
    this.confirmHeading = confirmHeading;
    const warning = document.createElement("p");
    warning.className = "calendar-subscription-warning";
    warning.textContent = FEED_WARNING;
    this.confirmAudience = document.createElement("p");
    this.confirmAudience.className = "section-hint";
    const keepSecret = document.createElement("p");
    keepSecret.className = "section-hint";
    keepSecret.textContent = "The server keeps the link so it can fetch the calendar. Anyone who has the link can read that calendar, so share it with nobody else. You can turn it off here at any time.";
    const actions = document.createElement("div");
    actions.className = "calendar-subscription-actions";
    this.turnOn = document.createElement("button");
    this.turnOn.type = "button";
    this.turnOn.className = "primary-action calendar-subscription-turn-on";
    this.turnOn.textContent = "Turn on sync";
    this.turnOn.addEventListener("click", () => void this.submit());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary calendar-subscription-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeConfirm(true));
    actions.append(this.turnOn, cancel);
    this.confirm.append(confirmHeading, warning, this.confirmAudience, keepSecret, actions);

    this.form.append(formHeading, urlLabel, this.urlInput, urlHint, this.urlError, audience, this.continueButton, this.confirm);
    this.form.addEventListener("submit", (event) => { event.preventDefault(); this.review(); });
    this.adultsOnly = document.createElement("p");
    this.adultsOnly.className = "section-hint calendar-subscription-adults";
    this.adultsOnly.textContent = "Adults in your household can add their calendars here.";

    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback calendar-subscription-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.append(heading, lead, this.stateLine, this.list, this.empty, this.form, this.adultsOnly, this.feedback);
  }

  /** Shows `view` from the controller. */
  update(view) {
    this.view = view ?? this.view;
    if (this.list) this.render();
  }

  get audience() {
    return [...this.audienceInputs].find(([, input]) => input.checked)?.[0] ?? "me";
  }

  showError(message) {
    this.urlError.textContent = message;
    this.urlError.hidden = false;
    this.urlInput.setAttribute("aria-invalid", "true");
  }

  clearError() {
    this.urlError.hidden = true;
    this.urlError.textContent = "";
    this.urlInput.removeAttribute("aria-invalid");
  }

  /** Continue: checks the link here, then shows the warning. */
  review() {
    if (this.busy) return;
    try {
      this.pendingUrl = normalizeFeedUrl(this.urlInput.value);
    } catch (error) {
      this.showError(error instanceof FeedLinkError ? error.message : "That doesn't look like a calendar link.");
      this.urlInput.focus();
      return;
    }
    this.clearError();
    this.confirmAudience.textContent = this.audience === "household"
      ? "Everyone in your household will see this calendar's events, read-only."
      : "Only you will see this calendar's events, on your devices.";
    this.confirm.hidden = false;
    this.continueButton.hidden = true;
    this.confirmHeading.focus();
  }

  closeConfirm(restoreFocus = false) {
    this.confirm.hidden = true;
    this.continueButton.hidden = false;
    if (restoreFocus) this.continueButton.focus();
  }

  async submit() {
    if (this.busy || !this.controller) return;
    this.setBusy(true);
    this.feedback.textContent = "Checking the calendar…";
    try {
      const added = await this.controller.add(this.urlInput.value, this.audience);
      this.urlInput.value = "";
      this.closeConfirm();
      this.feedback.textContent = `${added?.source ?? "The"} calendar is on. Its events appear in your calendar, read-only.`;
      this.urlInput.focus();
    } catch (error) {
      this.closeConfirm();
      this.feedback.textContent = "";
      this.showError(error?.message || "Kin couldn't add that calendar.");
      this.urlInput.focus();
    } finally {
      this.setBusy(false);
    }
  }

  async removeCalendar(subscription, button) {
    if (this.busy || !this.controller) return;
    this.setBusy(true);
    try {
      await this.controller.remove(subscription.id);
      this.confirmingRemove = null;
      this.feedback.textContent = `${this.nameOf(subscription)} is off. Its events are gone from Kin for everyone who saw them.`;
      this.render();
      this.urlInput.focus();
    } catch (error) {
      this.feedback.textContent = error?.message || "Kin couldn't turn that calendar off. Try again.";
      button?.focus();
    } finally {
      this.setBusy(false);
    }
  }

  setBusy(busy) {
    this.busy = busy;
    this.toggleAttribute("aria-busy", busy);
    for (const control of this.querySelectorAll("button, input")) control.disabled = busy;
  }

  nameOf(subscription) {
    return subscription.name ? `${subscription.name} (${subscription.source})` : `${subscription.source} calendar`;
  }

  render() {
    const view = this.view;
    const state = view.state ?? "local";
    this.stateLine.textContent = STATE_LINES[state] ?? "";
    this.stateLine.hidden = !STATE_LINES[state];
    const subscriptions = state === "local" ? [] : view.subscriptions ?? [];
    this.list.replaceChildren(...subscriptions.map((subscription) => this.item(subscription)));
    this.list.hidden = subscriptions.length === 0;
    this.empty.hidden = subscriptions.length > 0 || !["ready", "offline"].includes(state);
    this.form.hidden = !(view.canAdd && state === "ready");
    this.adultsOnly.hidden = view.canAdd || state !== "ready";
  }

  item(subscription) {
    const item = document.createElement("li");
    item.className = "calendar-subscription";
    item.dataset.subscriptionId = subscription.id;
    const name = document.createElement("p");
    name.className = "calendar-subscription-name";
    name.textContent = this.nameOf(subscription);
    const who = document.createElement("p");
    who.className = "calendar-subscription-who";
    const owner = subscription.mine === true ? "Added by you" : subscription.mine === false ? "Shared with you" : "";
    who.textContent = [AUDIENCE_LABELS[subscription.audience], owner].filter(Boolean).join(" · ");
    const status = document.createElement("p");
    status.className = "calendar-subscription-status";
    const error = subscription.deviceError ?? (subscription.status === "error" ? { message: subscription.message } : null);
    const updated = updatedText(subscription.localFetchedAt ?? subscription.fetchedAt ?? NaN);
    if (error) {
      status.dataset.state = "error";
      status.textContent = `${error.message || "Kin couldn't update this calendar."} ${subscription.localFetchedAt ? `${updated}.` : ""}`.trim();
    } else {
      status.dataset.state = "ok";
      const next = subscription.summary?.next;
      status.textContent = next ? `${updated}. Next: ${next.title}, ${civilDayText(next.start.date)}.` : `${updated}.`;
    }
    item.append(name, who, status);
    if (subscription.canRemove) {
      if (this.confirmingRemove === subscription.id) {
        const ask = document.createElement("p");
        ask.className = "calendar-subscription-remove-ask";
        ask.id = `remove-${subscription.id}`;
        ask.textContent = subscription.audience === "household"
          ? "Turn this calendar off? Its events disappear from Kin for everyone in the household."
          : "Turn this calendar off? Its events disappear from Kin on your devices.";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "danger calendar-subscription-remove-confirm";
        yes.textContent = "Turn off";
        yes.setAttribute("aria-describedby", ask.id);
        yes.addEventListener("click", () => void this.removeCalendar(subscription, yes));
        const keep = document.createElement("button");
        keep.type = "button";
        keep.className = "secondary calendar-subscription-keep";
        keep.textContent = "Keep it";
        keep.addEventListener("click", () => {
          this.confirmingRemove = null;
          this.render();
          this.list.querySelector(`[data-subscription-id="${subscription.id}"] .calendar-subscription-remove`)?.focus();
        });
        const actions = document.createElement("div");
        actions.className = "calendar-subscription-actions";
        actions.append(yes, keep);
        item.append(ask, actions);
        queueMicrotask(() => yes.focus());
      } else {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary calendar-subscription-remove";
        remove.textContent = "Turn off";
        remove.setAttribute("aria-label", `Turn off ${this.nameOf(subscription)}`);
        remove.addEventListener("click", () => { this.confirmingRemove = subscription.id; this.render(); });
        item.append(remove);
      }
    }
    return item;
  }
}

customElements.define("kin-calendar-subscriptions", KinCalendarSubscriptions);
