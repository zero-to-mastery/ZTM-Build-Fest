// "Report a problem", "Suggest something" and "What I've sent" (#632, #633,
// #628, #629, ADR 0021 §3): one native modal dialog in light DOM.
//
// A report is: what happened and what was expected (both optional), the
// device's diagnostics (each shown and removable), and, only if the person
// turns it on, a cropped picture of the screen. A suggestion (household
// admins only) is what they'd like and why, with the Kin version. Both go
// through a preview that shows exactly what will be sent and where it goes;
// nothing is sent until Send. Sent reports wait in the outbox when the
// device is offline, and every one gets a reference number.
//
// The host (app/report.js) hands this element `services`:
//   context()      → { signedIn, memberId, admin }
//   collect()      → the diagnostics (feedback/collect.js)
//   channel()      → where reports go (feedback/channel.js), or null
//   capture()      → a canvas of the page (feedback/screenshot.js)
//   outbox         → the FeedbackOutbox
//   fetchMine()    → the member's sent items with status
// Typed text is shown with textContent only. A lock calls dismiss(), which
// drops the draft and the screenshot.
import { button, field, text } from "./shared/dom.js";
import { newReference, normalizeReport, reportTitle, STATUS_LABELS, TEXT_FIELDS, MAX_TEXT_CHARS, FeedbackFormatError } from "../feedback/format.js";
import { previewRows, withoutRemoved } from "../feedback/collect.js";
import { destinationText } from "../feedback/channel.js";
import { clampCrop, cropFromTrim, encodeWithinLimit, screenshotPayload, ScreenshotError } from "../feedback/screenshot.js";
import { OutboxFullError } from "../feedback/outbox.js";

const TITLES = Object.freeze({ problem: "Report a problem", suggestion: "Suggest something", sent: "What I've sent" });
const KIND_LABELS = Object.freeze({ problem: "Problem report", suggestion: "Suggestion" });
const TRIMS = Object.freeze([["left", "Trim from the left"], ["top", "Trim from the top"], ["right", "Trim from the right"], ["bottom", "Trim from the bottom"]]);

const emptyDraft = () => ({ happened: "", expected: "", wish: "", why: "" });

class KinReport extends HTMLElement {
  constructor() {
    super();
    this.services = null;
    this.mode = null;
    this.step = "form";
    this.draft = emptyDraft();
    this.diagnostics = null;
    this.removed = new Set();
    this.shot = null;
    this.includeShot = false;
    this.result = null;
    this.opener = null;
    this.channelInfo = undefined;
    this.generation = 0;
  }

  connectedCallback() {
    if (this.dialog) return;
    this.setAttribute("data-kin-screenshot-exclude", "");
    this.dialog = document.createElement("dialog");
    this.dialog.className = "report-dialog";
    this.dialog.setAttribute("aria-labelledby", "report-dialog-title");
    this.dialog.addEventListener("close", () => this.closed());
    this.dialog.addEventListener("cancel", () => { this.generation += 1; });
    this.append(this.dialog);
  }

  disconnectedCallback() { this.dismiss(); }

  get isOpen() { return Boolean(this.dialog?.open); }

  /** Opens `mode` ("problem", "suggestion" or "sent"). A draft of the same
   * kind, closed without Cancel, comes back. */
  open(mode, { opener = null } = {}) {
    if (!this.dialog || !TITLES[mode]) return false;
    if (this.mode !== mode) this.reset();
    this.mode = mode;
    this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (mode === "sent") this.step = "list";
    else if (this.step === "done" || this.step === "list") this.step = "form";
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusHeading();
    if (mode === "problem" && !this.diagnostics) void this.loadDiagnostics();
    if (mode !== "sent" && this.channelInfo === undefined) void this.loadChannel();
    return true;
  }

  /** Closes and forgets everything (a lock, Cancel, or after sending). */
  dismiss() {
    this.reset();
    this.mode = null;
    if (this.dialog?.open) this.dialog.close();
  }

  reset() {
    this.generation += 1;
    this.step = "form";
    this.draft = emptyDraft();
    this.diagnostics = null;
    this.removed = new Set();
    this.dropShot();
    this.includeShot = false;
    this.result = null;
  }

  dropShot() {
    if (this.shot?.previewUrl) URL.revokeObjectURL(this.shot.previewUrl);
    if (this.shot?.source) { this.shot.source.width = 0; this.shot.source.height = 0; }
    this.shot = null;
  }

  closed() {
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus?.();
  }

  focusHeading() {
    const heading = this.dialog.querySelector("h2");
    heading?.focus();
  }

  context() {
    return this.services?.context?.() ?? { signedIn: false, memberId: null, admin: false };
  }

  async loadDiagnostics() {
    const generation = this.generation;
    let values = {};
    try { values = (await this.services?.collect?.()) ?? {}; } catch { values = {}; }
    if (generation !== this.generation) return;
    this.diagnostics = values;
    if (this.step === "preview") this.render({ keepFocus: true });
  }

  async loadChannel() {
    this.channelInfo = null;
    try { this.channelInfo = (await this.services?.channel?.()) ?? null; } catch { this.channelInfo = null; }
    const where = this.dialog.querySelector(".report-destination");
    if (where) where.textContent = destinationText(this.channelInfo);
  }

  // ---- Rendering -----------------------------------------------------------

  render({ keepFocus = false } = {}) {
    const focused = keepFocus ? document.activeElement?.dataset?.reportFocus : null;
    this.dialog.replaceChildren();
    this.dialog.dataset.mode = this.mode;
    this.dialog.dataset.step = this.step;
    const bar = document.createElement("div");
    bar.className = "report-dialog-bar";
    const heading = document.createElement("h2");
    heading.id = "report-dialog-title";
    heading.tabIndex = -1;
    heading.textContent = this.step === "preview" ? "Check what will be sent" : this.step === "done" ? this.result?.title ?? "Sent" : TITLES[this.mode];
    bar.append(heading, button("Close", () => this.dialog.close(), { className: "report-close" }));
    this.dialog.append(bar);
    this.live = document.createElement("p");
    this.live.className = "report-status";
    this.live.setAttribute("role", "status");
    this.alert = document.createElement("p");
    this.alert.className = "error-message report-alert";
    this.alert.setAttribute("role", "alert");
    if (this.step === "list") this.renderSent();
    else if (this.step === "preview") this.renderPreview();
    else if (this.step === "done") this.renderDone();
    else if (this.mode === "suggestion") this.renderSuggestionForm();
    else this.renderProblemForm();
    this.dialog.append(this.live, this.alert);
    if (focused) this.dialog.querySelector(`[data-report-focus="${focused}"]`)?.focus();
  }

  textArea(name, caption, { hint = "", required = false } = {}) {
    const area = document.createElement("textarea");
    area.name = name;
    area.rows = 4;
    area.maxLength = MAX_TEXT_CHARS;
    area.value = this.draft[name];
    area.required = required;
    area.dataset.reportFocus = name;
    area.addEventListener("input", () => { this.draft[name] = area.value; });
    return field(caption, area, { hint, className: "report-field", parent: this.dialog });
  }

  actions(...buttons) {
    const row = document.createElement("div");
    row.className = "dialog-actions report-actions";
    row.append(...buttons);
    this.dialog.append(row);
    return row;
  }

  renderProblemForm() {
    text("Tell the Kin team what went wrong. You'll see everything before it's sent, and nothing is sent until you press Send.", { parent: this.dialog, className: "report-lead" });
    this.textArea("happened", "What happened (optional)");
    this.textArea("expected", "What you expected (optional)");
    const shot = document.createElement("fieldset");
    shot.className = "report-shot";
    const legend = document.createElement("legend");
    legend.textContent = "Picture of the screen";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "report-include-shot";
    box.checked = this.includeShot;
    box.dataset.reportFocus = "shot";
    const label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent = "Include a picture of this screen";
    const row = document.createElement("div");
    row.className = "report-check";
    row.append(box, label);
    shot.append(legend, row);
    text("Off unless you turn it on. It's only of Kin, never other apps.", { parent: shot, className: "section-hint" });
    box.addEventListener("change", () => void this.toggleShot(box.checked));
    if (this.includeShot) this.renderShotEditor(shot);
    this.dialog.append(shot);
    this.actions(
      button("Review what will be sent", () => void this.review(), { className: "primary-action" }),
      button("Cancel", () => this.dismiss(), { className: "secondary" }),
    );
  }

  renderShotEditor(parent) {
    const warning = text("A picture of the screen can show private things, like your lists, messages or names. Crop it to just the problem, or turn it off.", { parent, className: "report-warning" });
    warning.id = "report-shot-warning";
    if (!this.shot) {
      text(this.shotError ?? "Taking the picture…", { parent, className: this.shotError ? "error-message" : "section-hint" });
      return;
    }
    const figure = document.createElement("figure");
    figure.className = "report-shot-preview";
    const image = document.createElement("img");
    image.alt = "The picture of the screen, as it will be sent";
    image.src = this.shot.previewUrl ?? "";
    image.setAttribute("aria-describedby", warning.id);
    const caption = document.createElement("figcaption");
    caption.textContent = `${this.shot.width} × ${this.shot.height} pixels, ${Math.max(1, Math.round(this.shot.blob.size / 1024))} KB`;
    figure.append(image, caption);
    parent.append(figure);
    const crop = document.createElement("fieldset");
    crop.className = "report-crop";
    const legend = document.createElement("legend");
    legend.textContent = "Crop";
    crop.append(legend);
    for (const [side, caption] of TRIMS) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "90";
      slider.step = "5";
      slider.value = String(this.shot.trim[side]);
      slider.dataset.reportFocus = `trim-${side}`;
      slider.setAttribute("aria-valuetext", `${slider.value} percent`);
      slider.addEventListener("change", () => void this.recrop({ ...this.shot.trim, [side]: Number(slider.value) }));
      field(caption, slider, { className: "report-trim", parent: crop });
    }
    crop.append(button("Show the whole screen", () => void this.recrop({ left: 0, top: 0, right: 0, bottom: 0 }), { className: "secondary" }));
    parent.append(crop);
  }

  async toggleShot(on) {
    this.includeShot = on;
    this.shotError = null;
    if (!on) { this.dropShot(); this.render({ keepFocus: true }); return; }
    this.render({ keepFocus: true });
    const generation = this.generation;
    // The dialog is left out of the picture; it stays open meanwhile.
    try {
      const source = await this.services.capture();
      if (generation !== this.generation || !this.includeShot) { source.width = 0; return; }
      this.shot = { source, trim: { left: 0, top: 0, right: 0, bottom: 0 } };
      await this.encodeShot();
      if (generation !== this.generation) return;
      this.live.textContent = "The picture is ready. Check it below, and crop it if you like.";
    } catch (error) {
      if (generation !== this.generation) return;
      this.dropShot();
      this.shotError = error instanceof ScreenshotError ? error.message : "Kin couldn't take a picture of the screen. Send the report without one.";
      // Which step failed (a fixed code), for the regression and debugging.
      this.shotErrorCode = error instanceof ScreenshotError ? (error.attempts?.join(",") ?? error.code) : "other";
    }
    this.render({ keepFocus: true });
  }

  async encodeShot() {
    const shot = this.shot;
    const bounds = { width: shot.source.width, height: shot.source.height };
    shot.crop = clampCrop(cropFromTrim(shot.trim, bounds), bounds);
    const encoded = await encodeWithinLimit({ source: shot.source, crop: shot.crop });
    if (shot.previewUrl) URL.revokeObjectURL(shot.previewUrl);
    Object.assign(shot, encoded, { previewUrl: URL.createObjectURL(encoded.blob) });
  }

  async recrop(trim) {
    if (!this.shot) return;
    const generation = this.generation;
    this.shot.trim = trim;
    try { await this.encodeShot(); } catch (error) {
      if (generation !== this.generation) return;
      this.alert.textContent = error.message;
      return;
    }
    if (generation !== this.generation) return;
    this.render({ keepFocus: true });
    this.live.textContent = "Crop updated.";
  }

  renderSuggestionForm() {
    if (!this.context().admin) {
      text("Only a household admin can suggest features from Kin. Ask your household's admin, or report a problem instead.", { parent: this.dialog });
      this.actions(button("Report a problem", () => this.open("problem"), { className: "primary-action" }), button("Close", () => this.dismiss(), { className: "secondary" }));
      return;
    }
    text("Tell the Kin team about something you'd like Kin to do. You'll see it before it's sent.", { parent: this.dialog, className: "report-lead" });
    const [wish, why] = TEXT_FIELDS.suggestion;
    this.textArea(wish.name, wish.label, { required: true });
    this.textArea(why.name, `${why.label} (optional)`);
    this.actions(
      button("Review what will be sent", () => void this.review(), { className: "primary-action" }),
      button("Cancel", () => this.dismiss(), { className: "secondary" }),
    );
  }

  /** The report as it would be sent now, checked by the shared rules. */
  buildReport(reference) {
    const typed = Object.fromEntries(TEXT_FIELDS[this.mode].map((entry) => [entry.name, this.draft[entry.name]]));
    const values = withoutRemoved(this.diagnostics ?? {}, this.removed);
    return normalizeReport({ kind: this.mode, reference, text: typed, diagnostics: this.mode === "suggestion" ? withoutRemoved({ version: (this.diagnostics ?? {}).version }, this.removed) : values });
  }

  async review() {
    this.alert.textContent = "";
    if (this.mode === "suggestion" && !this.draft.wish.trim()) {
      this.alert.textContent = "Write what you'd like first.";
      this.dialog.querySelector('textarea[name="wish"]')?.focus();
      return;
    }
    if (this.mode === "suggestion" && !this.diagnostics) {
      const values = await this.services?.collect?.().catch(() => ({}));
      this.diagnostics = { version: values?.version };
    }
    try { this.buildReport(newReference(this.mode)); } catch (error) {
      this.alert.textContent = error instanceof FeedbackFormatError ? error.message : "Kin couldn't prepare that report.";
      return;
    }
    this.step = "preview";
    this.render();
    this.focusHeading();
  }

  renderPreview() {
    const where = text(destinationText(this.channelInfo ?? null), { parent: this.dialog, className: "report-destination" });
    where.id = "report-destination";
    // What they typed, exactly as it will go.
    const typedHeading = text("What you wrote", { parent: this.dialog, tag: "h3" });
    typedHeading.className = "report-subheading";
    const typed = document.createElement("dl");
    typed.className = "report-typed";
    let any = false;
    for (const entry of TEXT_FIELDS[this.mode]) {
      const value = this.draft[entry.name].trim();
      if (!value) continue;
      any = true;
      const term = document.createElement("dt");
      term.textContent = entry.label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      typed.append(term, detail);
    }
    if (any) this.dialog.append(typed);
    else text("Nothing typed. The details below can still help.", { parent: this.dialog, className: "section-hint" });
    // The details, each removable.
    const detailsHeading = text(this.mode === "problem" ? "Details about this device" : "Details", { parent: this.dialog, tag: "h3" });
    detailsHeading.className = "report-subheading";
    text("They help the team find the problem. None of them is anything you've written in Kin. Remove any you'd rather not send.", { parent: this.dialog, className: "section-hint" });
    const values = this.mode === "suggestion" ? { version: this.diagnostics?.version } : (this.diagnostics ?? {});
    const rows = previewRows(withoutRemoved(values, this.removed));
    if (!this.diagnostics && this.mode === "problem") text("Gathering details…", { parent: this.dialog, className: "section-hint" });
    const list = document.createElement("ul");
    list.className = "report-details";
    for (const row of rows) {
      const item = document.createElement("li");
      item.dataset.key = row.key;
      const label = document.createElement("span");
      label.className = "report-detail-label";
      label.textContent = row.label;
      const value = document.createElement("span");
      value.className = "report-detail-value";
      value.textContent = row.value;
      const remove = button("Remove", () => this.removeDetail(row.key), { className: "secondary report-remove" });
      remove.setAttribute("aria-label", `Remove ${row.label}`);
      remove.dataset.reportFocus = `remove-${row.key}`;
      item.append(label, value, remove);
      if (row.lines) {
        const more = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Show them";
        const lines = document.createElement("ul");
        lines.className = "report-recent";
        for (const line of row.lines) text(line, { parent: lines, tag: "li" });
        more.append(summary, lines);
        item.append(more);
      }
      list.append(item);
    }
    if (rows.length) this.dialog.append(list);
    else if (this.diagnostics || this.mode === "suggestion") text("No details will be sent.", { parent: this.dialog, className: "section-hint" });
    if (this.removed.size) this.dialog.append(button("Put back removed details", () => { this.removed.clear(); this.render(); this.focusHeading(); }, { className: "secondary" }));
    if (this.mode === "problem" && this.shot?.previewUrl) {
      const heading = text("Picture of the screen", { parent: this.dialog, tag: "h3" });
      heading.className = "report-subheading";
      const image = document.createElement("img");
      image.className = "report-shot-thumb";
      image.alt = "The picture of the screen that will be sent";
      image.src = this.shot.previewUrl;
      this.dialog.append(image);
      text("Kept on the Kin service for the team only. It is never posted to the issue tracker.", { parent: this.dialog, className: "section-hint" });
      const remove = button("Remove the picture", () => { this.includeShot = false; this.dropShot(); this.render(); this.focusHeading(); }, { className: "secondary" });
      remove.dataset.reportFocus = "remove-shot";
      this.dialog.append(remove);
    }
    this.actions(
      button("Send", () => void this.send(), { className: "primary-action report-send" }),
      button("Back", () => { this.step = "form"; this.render(); this.focusHeading(); }, { className: "secondary" }),
      button("Cancel", () => this.dismiss(), { className: "secondary" }),
    );
  }

  removeDetail(key) {
    this.removed.add(key);
    const label = previewRows(this.mode === "suggestion" ? { version: this.diagnostics?.version } : this.diagnostics ?? {}).find((row) => row.key === key)?.label ?? "Detail";
    this.render();
    // Focus stays in the list: the next row's Remove, or the heading.
    const next = this.dialog.querySelector(".report-remove") ?? this.dialog.querySelector("h2");
    next?.focus();
    this.live.textContent = `${label} removed. It won't be sent.`;
  }

  async send() {
    const sendButton = this.dialog.querySelector(".report-send");
    if (sendButton?.disabled) return;
    for (const control of this.dialog.querySelectorAll("button")) control.disabled = true;
    this.alert.textContent = "";
    this.live.textContent = "Sending…";
    const generation = this.generation;
    const { signedIn, memberId } = this.context();
    try {
      const reference = newReference(this.mode);
      const report = this.buildReport(reference);
      const body = { ...report };
      if (this.mode === "problem" && this.includeShot && this.shot?.blob) body.screenshot = await screenshotPayload(this.shot.blob);
      const outbox = this.services.outbox;
      await outbox.add({ reference, kind: this.mode, signed: signedIn, memberId: signedIn ? memberId : null, body, title: reportTitle(report) });
      const results = await outbox.flush({ identity: signedIn ? { memberId } : null });
      if (generation !== this.generation) return;
      const outcome = results.find((entry) => entry.reference === reference)?.outcome ?? "waiting";
      if (outcome === "refused") {
        const item = (await outbox.list()).find((entry) => entry.reference === reference);
        await outbox.remove(reference);
        this.render();
        this.alert.textContent = item?.lastMessage ?? "Kin's service didn't accept this report. Change it and try again.";
        return;
      }
      const sent = outcome === "sent";
      const kindWord = this.mode === "problem" ? "report" : "suggestion";
      this.result = {
        reference, sent, signedIn,
        title: sent ? "Sent" : "Saved to send",
        message: sent
          ? `Thank you. The Kin team has your ${kindWord}.`
          : `You seem to be offline, or Kin's service is busy. Your ${kindWord} is saved on this device and will be sent when Kin can reach the service.`,
      };
      this.draft = emptyDraft();
      this.removed = new Set();
      this.includeShot = false;
      this.dropShot();
      this.step = "done";
      this.render();
      this.focusHeading();
    } catch (error) {
      if (generation !== this.generation) return;
      this.render();
      this.alert.textContent = error instanceof OutboxFullError || error instanceof FeedbackFormatError || error instanceof ScreenshotError
        ? error.message
        : "Kin couldn't save this report on this device. Try again.";
    }
  }

  renderDone() {
    text(this.result.message, { parent: this.dialog, className: "report-lead" });
    const reference = document.createElement("p");
    reference.className = "report-reference";
    reference.append("Your reference number is ");
    const strong = document.createElement("strong");
    strong.textContent = this.result.reference;
    strong.className = "report-reference-number";
    reference.append(strong, ". Quote it if you contact the Kin team.");
    this.dialog.append(reference);
    const buttons = [button("Done", () => this.dismiss(), { className: "primary-action" })];
    buttons.push(button("What I've sent", () => this.open("sent"), { className: "secondary" }));
    this.actions(...buttons);
  }

  // ---- What I've sent --------------------------------------------------------

  renderSent() {
    const { signedIn } = this.context();
    const waiting = document.createElement("section");
    waiting.className = "report-waiting";
    waiting.setAttribute("aria-labelledby", "report-waiting-heading");
    const waitingHeading = text("Waiting to send", { parent: waiting, tag: "h3" });
    waitingHeading.id = "report-waiting-heading";
    waitingHeading.className = "report-subheading";
    const waitingList = document.createElement("ul");
    waitingList.className = "report-sent-list";
    waiting.append(waitingList);
    waiting.hidden = true;
    const sent = document.createElement("section");
    sent.className = "report-sent";
    sent.setAttribute("aria-labelledby", "report-sent-heading");
    const sentHeading = text("Sent", { parent: sent, tag: "h3" });
    sentHeading.id = "report-sent-heading";
    sentHeading.className = "report-subheading";
    const sentList = document.createElement("ul");
    sentList.className = "report-sent-list";
    const note = text(signedIn ? "Loading…" : "Sign in to see what you've sent and what the team did with it. Reports sent without signing in aren't listed.", { parent: sent, className: "section-hint" });
    sent.append(sentList);
    this.dialog.append(waiting, sent);
    this.actions(button("Close", () => this.dialog.close(), { className: "secondary" }));
    void this.fillSent({ waiting, waitingList, sentList, note, signedIn });
  }

  async fillSent({ waiting, waitingList, sentList, note, signedIn }) {
    const generation = this.generation;
    const outbox = this.services?.outbox;
    if (outbox) {
      // Anything that can go now goes first, so the lists agree.
      await outbox.flush({ identity: signedIn ? { memberId: this.context().memberId } : null }).catch(() => {});
      const items = await outbox.list().catch(() => []);
      if (generation !== this.generation) return;
      waiting.hidden = !items.length;
      waitingList.replaceChildren(...items.map((item) => this.waitingRow(item)));
    }
    if (!signedIn) return;
    let mine;
    try { mine = await this.services.fetchMine(); } catch (error) {
      if (generation === this.generation) note.textContent = error.message;
      return;
    }
    if (generation !== this.generation) return;
    note.textContent = mine.length ? "" : "Nothing yet. Reports and suggestions you send show here with what the team did.";
    note.hidden = Boolean(mine.length);
    sentList.replaceChildren(...mine.map((item) => this.sentRow(item)));
  }

  rowBase(kind, title) {
    const row = document.createElement("li");
    row.className = "report-sent-row";
    const what = document.createElement("span");
    what.className = "report-sent-kind";
    what.textContent = KIND_LABELS[kind] ?? "Report";
    const name = document.createElement("span");
    name.className = "report-sent-title";
    name.textContent = title;
    row.append(what, name);
    return row;
  }

  waitingRow(item) {
    const row = this.rowBase(item.kind, item.title);
    row.dataset.reference = item.reference;
    const detail = document.createElement("span");
    detail.className = "report-sent-detail";
    detail.textContent = `${item.reference} · ${item.lastStatus && ![401, 429].includes(item.lastStatus) ? `Not accepted: ${item.lastMessage ?? "the service refused it"}` : "Waiting to send"}`;
    row.append(detail);
    const sendNow = button("Send now", async () => {
      await this.services.outbox.flush({ identity: this.context().signedIn ? { memberId: this.context().memberId } : null }).catch(() => {});
      if (this.mode === "sent") { this.render(); this.focusHeading(); }
    }, { className: "secondary" });
    sendNow.setAttribute("aria-label", `Send ${item.reference} now`);
    const remove = button("Remove", async () => {
      await this.services.outbox.remove(item.reference).catch(() => {});
      if (this.mode === "sent") { this.render(); this.focusHeading(); this.live.textContent = `${item.reference} removed. It won't be sent.`; }
    }, { className: "secondary" });
    remove.setAttribute("aria-label", `Remove ${item.reference} without sending`);
    row.append(sendNow, remove);
    return row;
  }

  sentRow(item) {
    const row = this.rowBase(item.kind, item.title);
    row.dataset.reference = item.reference;
    const status = document.createElement("span");
    status.className = "report-sent-status";
    status.dataset.status = item.status;
    status.textContent = STATUS_LABELS[item.status] ?? "Received";
    const detail = document.createElement("span");
    detail.className = "report-sent-detail";
    detail.textContent = `${item.reference} · ${new Date(item.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
    row.append(status, detail);
    return row;
  }
}

customElements.define("kin-report", KinReport);
