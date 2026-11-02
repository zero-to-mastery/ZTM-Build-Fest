// The Help panel (#621, #622, ADR 0021): a short, modal dialog for the
// screen the person is on. It says what the screen is for, the two or three
// things they can do there (each with "Show me" when that control is on
// screen), who sees it, the harder words it uses, and "Still stuck?" with a
// way to message a household admin and, when something in Kin can take it,
// to report a problem. The words come from help/help-content.js; the app
// (app/help.js) decides what is available and does what the buttons ask
// through the callbacks:
//
//   panel.onShowMe(action)   panel.onMessageAdmin()   panel.onReport()
//
// Only fixed, source-controlled words are shown; nothing here renders
// household text.
import { HELP_COPY } from "../help/help-content.js";

class KinHelp extends HTMLElement {
  constructor() {
    super();
    this.onShowMe = null;
    this.onMessageAdmin = null;
    this.onReport = null;
    this.opener = null;
    this.keepFocus = false;
  }

  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "help-dialog";
    this.dialog.setAttribute("aria-labelledby", "help-title");
    this.heading = document.createElement("h2");
    this.heading.id = "help-title";
    this.heading.tabIndex = -1;
    this.body = document.createElement("div");
    this.body.className = "help-body";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "help-close";
    close.textContent = HELP_COPY.close;
    close.addEventListener("click", () => this.close());
    this.closeButton = close;
    this.dialog.append(this.heading, this.body, close);
    this.dialog.addEventListener("close", () => {
      const target = this.opener;
      this.opener = null;
      if (this.keepFocus) { this.keepFocus = false; return; }
      if (target?.isConnected) target.focus();
    });
    this.append(this.dialog);
  }

  get open() {
    return Boolean(this.dialog?.open);
  }

  /**
   * Opens the panel for `topic` (help-content.js helpTopic). `available`
   * says which "Show me" controls are on screen (a function of the
   * selector), and whether to offer messaging an admin and reporting.
   */
  show(topic, { opener = null, available = () => false, admin = false, report = false, easy = false } = {}) {
    if (!this.dialog) this.connectedCallback();
    this.opener = opener;
    this.keepFocus = false;
    this.dataset.topic = topic.key ?? "";
    this.heading.textContent = HELP_COPY.heading(topic.title);
    const parts = [];
    const about = document.createElement("p");
    about.className = "help-about";
    about.textContent = topic.about;
    parts.push(about);

    parts.push(this.subheading(HELP_COPY.doHeading));
    const list = document.createElement("ul");
    list.className = "help-actions";
    for (const action of topic.actions) {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.className = "help-action-text";
      text.textContent = action.text;
      item.append(text);
      if (action.show && available(action.show)) {
        const show = document.createElement("button");
        show.type = "button";
        show.className = "help-show-me";
        show.textContent = HELP_COPY.showMe;
        show.dataset.show = action.show;
        // "Show me" names the step it shows, and still starts with its words.
        show.setAttribute("aria-label", `${HELP_COPY.showMe}: ${action.text}`);
        show.addEventListener("click", () => {
          this.keepFocus = true;
          this.dialog.close();
          this.onShowMe?.(action);
        });
        item.append(show);
      }
      list.append(item);
    }
    parts.push(list);

    parts.push(this.subheading(HELP_COPY.whoHeading));
    const who = document.createElement("p");
    who.className = "help-who";
    who.textContent = topic.who;
    parts.push(who);

    if (topic.words?.length) {
      parts.push(this.subheading(HELP_COPY.wordsHeading));
      const words = document.createElement("dl");
      words.className = "help-words";
      for (const { term, text } of topic.words) {
        const name = document.createElement("dt");
        name.textContent = term.charAt(0).toUpperCase() + term.slice(1);
        const meaning = document.createElement("dd");
        meaning.textContent = text;
        words.append(name, meaning);
      }
      parts.push(words);
    }

    if (admin || report) {
      const stuck = document.createElement("section");
      stuck.className = "help-stuck";
      stuck.setAttribute("aria-labelledby", "help-stuck-heading");
      const heading = this.subheading(HELP_COPY.stuckHeading);
      heading.id = "help-stuck-heading";
      const buttons = document.createElement("div");
      buttons.className = "help-stuck-actions";
      if (admin) buttons.append(this.stuckButton(HELP_COPY.messageAdmin, "help-message-admin", () => this.onMessageAdmin?.()));
      if (report) buttons.append(this.stuckButton(HELP_COPY.report, "help-report", () => this.onReport?.()));
      stuck.append(heading, buttons);
      parts.push(stuck);
    }
    if (easy) {
      const note = document.createElement("p");
      note.className = "section-hint help-easy-note";
      note.textContent = HELP_COPY.easyOn;
      parts.push(note);
    }
    this.body.replaceChildren(...parts);
    if (!this.dialog.open) this.dialog.showModal();
    this.heading.focus();
  }

  subheading(text) {
    const heading = document.createElement("h3");
    heading.textContent = text;
    return heading;
  }

  stuckButton(label, className, run) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", () => {
      // What it opens takes the focus.
      this.keepFocus = true;
      this.dialog.close();
      run();
    });
    return button;
  }

  close() {
    if (this.dialog?.open) this.dialog.close();
  }
}

customElements.define("kin-help", KinHelp);
