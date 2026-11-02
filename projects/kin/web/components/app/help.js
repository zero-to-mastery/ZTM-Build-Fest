// Help on every screen (#620, #621, #622, ADR 0021), and the first week's
// tips on Today. State stays on the element (`this.app`); app/context.js
// explains the controllers.
//
// - Every page's heading has a Help button (views.js, simple.js), and so do
//   Quick add, item details and Shopping mode; each sends `kin:open-help`.
//   open() shows <kin-help> with the topic for the page and tab on screen
//   (help/help-content.js), or the dialog's own.
// - "Show me" closes Help, scrolls to the control the step describes, moves
//   the focus to it and outlines it for a few seconds (`.help-highlight`).
// - "Still stuck?" offers "Message a household admin" — Chat with an
//   admin's name ready to send to, or Handoffs where Chat is off — and
//   "Report a problem", which asks the app with `kin:report-problem`. That
//   event is the report dialog's (#630, app/report.js): when that controller
//   is there the button shows. Otherwise Help asks with a probe
//   (`detail.probe: true`, which a listener answers with preventDefault()
//   and nothing else); with no listener the button isn't shown.
// - The first week's tips (help/tips.js): one at a time on Today, each put
//   away for good once dismissed or used, and at most one dealt with per
//   unlock so they never queue up.
import { EASY_MODE_KEY, prefersReducedMotion, readDisplayPref } from "../../appearance/display-prefs.js";
import { HELP_COPY, helpKey, helpTopic, screenText } from "../../help/help-content.js";
import { TIP_COPY, firstSeen, markTipDone, nextTip, readTipsDone } from "../../help/tips.js";
import { routeHash } from "../../routes.js";
import { helpButton } from "../shared/help-button.js";

export const REPORT_PROBLEM_EVENT = "kin:report-problem";
const HIGHLIGHT_MS = 8_000;
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
/** Where the household's own words are (records, notes, messages): never
 * read for Help's words. */
const RECORDS = "kin-item, [data-item-id], [data-record-id], .item-text, .note-body, .chat-row, .handoff-text, .help-dialog";

/** The text of `root` a person can see now, outside the household's records,
 * as one string per text node. */
export function visibleText(root) {
  const parts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest(RECORDS) || parent.closest("[hidden], template, script, style")) continue;
    if (!parent.getClientRects().length) continue;
    parts.push(text);
  }
  return parts;
}

export class HelpController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.highlighted = null;
    this.highlightTimer = null;
    this.tipDealtWith = false;
    this.onPointerDown = () => this.clearHighlight();
  }

  /** A Help button for a page heading or a dialog (`topic` "dialog:…"). */
  button(topic = null) {
    return helpButton(topic);
  }

  /** The panel, made once per element (shell.js appends it). */
  buildPanel() {
    const panel = document.createElement("kin-help");
    panel.onShowMe = (action) => this.showMe(action);
    panel.onMessageAdmin = () => this.messageAdmin();
    panel.onReport = () => this.report();
    this.app.helpPanel = panel;
    return panel;
  }

  /** The topic key for the screen: a dialog's own, or the page and tab. */
  key(topic = null) {
    return topic ?? helpKey(this.app.route ?? { page: "today" });
  }

  /** Whether household feature `id` is on (ADR 0021 §2; web/features.js
   * through app/features.js). Without that controller, everything is. */
  featureOn(id) {
    return !id || this.ctx.features?.isOn?.(id) !== false;
  }

  open({ topic = null, opener = null } = {}) {
    const panel = this.app.helpPanel;
    if (!panel) return;
    this.clearHighlight();
    const key = this.key(topic);
    this.lastKey = key;
    // "Words on this page" covers the words the page shows right now as
    // well as its fixed ones (#639), so no harder word goes unexplained.
    const found = helpTopic(key, [...screenText(key), ...(topic ? [] : this.pageWords())]);
    // A switched-off feature's steps aren't offered.
    const shown = { ...found, actions: found.actions.filter((entry) => this.featureOn(entry.feature)) };
    panel.show(shown, {
      opener,
      available: (selector) => Boolean(this.findTarget(selector)),
      admin: this.canMessageAdmin(),
      report: this.reportAvailable(),
      easy: this.ctx.easy?.on ?? false,
    });
  }

  /** The text the page on screen shows, apart from the household's own
   * records, for finding its harder words. Only glossary entries are ever
   * shown from it (help/glossary.js jargonIn), never the text itself. */
  pageWords() {
    const section = this.app.pages?.get(this.app.route?.page);
    if (!section) return [];
    return visibleText(section);
  }

  /** The first control on screen that matches `selector`, if any. */
  findTarget(selector) {
    let nodes;
    try { nodes = this.app.querySelectorAll(selector); } catch { return null; }
    for (const node of nodes) {
      if (node.closest(".help-dialog, [hidden]") || !node.getClientRects().length) continue;
      // Not behind a modal dialog other than the one it is in.
      const dialog = node.closest("dialog");
      const open = [...this.app.querySelectorAll("dialog[open]")].filter((entry) => !entry.classList.contains("help-dialog"));
      if (open.length && (!dialog || !dialog.open)) continue;
      return node;
    }
    return null;
  }

  showMe(action) {
    const target = this.findTarget(action.show);
    if (!target) { this.ctx.status.setStatus(HELP_COPY.notOnScreen); return; }
    this.highlight(target);
    this.ctx.status.setStatus(`${HELP_COPY.showMe}: ${action.text}`);
  }

  /** Outlines `target`, scrolls to it and gives it the focus. */
  highlight(target) {
    this.clearHighlight();
    // Inside a closed disclosure, it opens first.
    for (let node = target.parentElement; node && node !== this.app; node = node.parentElement)
      if (node.tagName === "DETAILS" && !node.open && target.tagName !== "SUMMARY") node.open = true;
    target.classList.add("help-highlight");
    this.highlighted = target;
    target.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    if (!target.matches(FOCUSABLE)) {
      target.tabIndex = -1;
      target.dataset.helpTabindex = "";
    }
    target.focus({ preventScroll: true });
    this.highlightTimer = setTimeout(() => this.clearHighlight(), HIGHLIGHT_MS);
    document.addEventListener("pointerdown", this.onPointerDown, { capture: true, once: true });
  }

  clearHighlight() {
    clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    document.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    const target = this.highlighted;
    this.highlighted = null;
    if (!target) return;
    target.classList.remove("help-highlight");
    if (target.dataset.helpTabindex !== undefined) {
      delete target.dataset.helpTabindex;
      target.removeAttribute("tabindex");
    }
  }

  /** Whether Chat is where an admin can be messaged from here. */
  chatOn() {
    if (!this.featureOn("chat")) return false;
    if (this.app.simpleView) return Boolean(this.ctx.simple?.access?.().chat);
    return this.app.chatAccess !== "none" && Boolean(this.app.chat?.room);
  }

  /** Simple view has no Handoffs, so there it needs Chat. */
  canMessageAdmin() {
    // The kitchen display (#670) has no Chat to write in or Handoffs.
    if (this.app.displayMode) return false;
    return Boolean(this.app.state) && (this.chatOn() || !this.app.simpleView);
  }

  /** The name to mention: a household admin other than this member who can
   * read Chat, if one is known. */
  adminName() {
    const room = this.app.chat?.room;
    const admins = new Set(room?.admins ?? []);
    let people = [];
    try { people = room?.mentionable?.() ?? []; } catch { people = []; }
    return people.find((person) => admins.has(person.id))?.label ?? null;
  }

  messageAdmin() {
    for (const dialog of this.app.querySelectorAll("dialog[open]")) if (!dialog.classList.contains("help-dialog")) dialog.close();
    if (this.chatOn()) {
      const name = this.adminName();
      this.ctx.navigation.navigate(routeHash("updates", "chat"));
      requestAnimationFrame(() => {
        const input = this.app.chat?.input;
        if (!input) return;
        if (name && !input.value.trim()) {
          input.value = `@${name} `;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.focus();
      });
      this.ctx.status.setStatus(name ? `Write your question to ${name}, then press Send.` : "Write your question, then press Send. A household admin will see it.");
      return;
    }
    this.ctx.navigation.navigate(routeHash("updates", "handoffs"));
    requestAnimationFrame(() => this.app.handoffs?.input?.focus());
    this.ctx.status.setStatus("Write your question for a household admin, then press Add handoff.");
  }

  /** Whether something in Kin takes problem reports (see the top). */
  reportAvailable() {
    if (this.app.displayMode) return false;
    // Kin's own report dialog (#630, app/report.js) takes them.
    if (typeof this.ctx.report?.open === "function") return true;
    const probe = new CustomEvent(REPORT_PROBLEM_EVENT, { bubbles: true, composed: true, cancelable: true, detail: { probe: true } });
    return !this.app.dispatchEvent(probe);
  }

  report() {
    const detail = { probe: false, route: this.lastKey ?? this.key(), opener: null };
    this.app.dispatchEvent(new CustomEvent(REPORT_PROBLEM_EVENT, { bubbles: true, composed: true, cancelable: true, detail }));
  }

  routeShown(route) {
    if (this.highlighted && !this.highlighted.isConnected) this.clearHighlight();
    if (route?.page === "today") this.renderTip();
  }

  /** Today's tip, if one is due (help/tips.js). */
  renderTip() {
    const host = this.app.todayTip;
    if (!host) return;
    const unlocked = Boolean(this.app.vault && !this.app.vault.locked);
    const id = unlocked && !this.tipDealtWith ? nextTip({
      firstSeen: firstSeen(Date.now()),
      now: Date.now(),
      done: readTipsDone(),
      easyMode: readDisplayPref(EASY_MODE_KEY) === "on",
      simpleView: this.app.simpleView === true,
    }) : null;
    if (!id) { host.hidden = true; host.replaceChildren(); delete host.dataset.tip; return; }
    if (host.dataset.tip === id && !host.hidden) return;
    const copy = TIP_COPY[id];
    host.dataset.tip = id;
    const heading = document.createElement("h2");
    heading.id = "today-tip-heading";
    heading.textContent = copy.heading;
    const text = document.createElement("p");
    text.textContent = copy.text;
    const act = document.createElement("button");
    act.type = "button";
    act.className = "primary-action today-tip-action";
    act.textContent = copy.action;
    act.addEventListener("click", () => this.tipAction(id));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "today-tip-dismiss";
    dismiss.textContent = copy.dismiss;
    dismiss.addEventListener("click", () => this.tipDone(id, { focus: true }));
    const actions = document.createElement("div");
    actions.className = "today-tip-actions";
    actions.append(act, dismiss);
    host.setAttribute("aria-labelledby", heading.id);
    host.replaceChildren(heading, text, actions);
    host.hidden = false;
  }

  tipAction(id) {
    if (id === "easy-mode") {
      this.tipDone(id, { focus: true });
      void this.ctx.easy.set(true);
      this.ctx.status.setStatus(`${HELP_COPY.easyOn} You can change it under Household, Identity & appearance.`);
      return;
    }
    this.tipDone(id);
    const button = this.findTarget("#today .page-intro .help-button");
    if (button) this.highlight(button);
  }

  /** Puts tip `id` away for good; focus goes to Today's heading. */
  tipDone(id, { focus = false } = {}) {
    markTipDone(id);
    this.tipDealtWith = true;
    this.renderTip();
    if (focus) this.app.pages?.get("today")?.querySelector("h1")?.focus();
  }

  /** Locking starts the next unlock afresh. */
  reset() {
    this.clearHighlight();
    this.tipDealtWith = false;
    this.app.helpPanel?.close();
  }
}
