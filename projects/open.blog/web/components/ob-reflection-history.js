// <ob-reflection-history> lets a reader keep private snapshots of how they read this post and compare an
// earlier one with a later one, entirely in their own browser (ADR 0244, docs/specs/reader-annotations.md).
// The page is complete without it: the region's static text says what it needs. Nothing is sent anywhere,
// nothing is scored or summarised, and nothing is stored until the reader saves a reading.
//
// Every snapshot is a list item, in the order the reader made them, so a keyboard or screen reader reads the
// history as a plain sequence. Choosing two of them shows them side by side where there is room and one after
// the other where there is not (the same markup, laid out by CSS). Whether the article has changed since a
// snapshot was written is told beside it; the snapshot itself is never rewritten. Every reader-facing string
// is set as text, never as markup.

import { workKey, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "./reader-annotations.js";
import { DATA_ELEMENT_ID, readPassages } from "./passage-selection.js";
import { CHANGED_EVENT, DISABLED_KEY, STORAGE_KEY, isDisabled, readStore, writeStore } from "./reader-annotations-store.js";
import {
  addReflection,
  assessReflections,
  deleteReflection,
  deleteWorkReflections,
  markSubmitted,
  prepareSubmissionCopy,
  relabelReflection,
  reflectionHistories,
  reflectionsOf,
  reviseReflection,
} from "./reader-reflections.js";
import { MAX_READER_NAME_CHARS, RESPONSE_CATEGORIES, thirdPerspectiveCopyText } from "./third-perspective.js";
import { isReceipt, receiptPanel } from "./feedback-receipt.js";

const SEND_TIMEOUT = 15000;

/** The site's own hosted function, named by its Third Perspective region: an https address without credentials. */
function hostedEndpoint() {
  const region = document.querySelector("ob-third-perspective[receipts][endpoint]");
  if (!region) return null;
  try {
    const url = new URL(region.getAttribute("endpoint"));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The post's Third Perspective region, if the post takes them: the gate every submission path follows. */
function thirdPerspectiveRegion() {
  return document.querySelector("ob-third-perspective[endpoint]");
}

/** The region's contact link, only as plain mailto: or https: (the same rule ob-third-perspective applies). */
function regionContact(region) {
  const value = region?.getAttribute("contact");
  if (!value) return null;
  if (/^mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const STATE_WORDS = Object.freeze({
  current: "The part of the post it was about is where it was.",
  reanchored: "The part of the post it was about has moved, and the same words were found again.",
  stale: "The part of the post it was about can no longer be found.",
});
const ARTICLE_WORDS = Object.freeze({
  true: "The post has changed since you wrote this.",
  false: "The post is as you read it.",
  null: "This post's text could not be read, so it cannot be compared with what you read.",
});
const STORAGE_NOTES = Object.freeze({
  blocked: "This browser does not allow saving here, so readings are kept only until you leave this page.",
  full: "This browser has no room to save more, so your latest changes are kept only until you leave this page. Delete something to make room.",
  unreadable: "Readings saved earlier in this browser could not be read. They have been left untouched, and anything you add now is kept only until you leave this page.",
  off: "Highlights, notes and readings are turned off in this browser. Nothing new is saved. Anything saved earlier is kept until you erase it; you can turn this back on in the reading trails panel below.",
});
const PROBLEM_WORDS = Object.freeze({
  tooMany: "There is no room for another reading. Delete one first.",
  tooLarge: "This is too large to keep. Delete something first.",
  emptyText: "Write your reading first.",
  textTooLong: `A reading can hold at most ${MAX_NOTE_CHARS.toLocaleString("en-US")} characters.`,
  forbiddenCharacter: "A reading cannot hold control or text-direction characters.",
  titleTooLong: `A label can hold at most ${MAX_TITLE_CHARS} characters.`,
  alreadyRevised: "A later reading already follows that one.",
  missing: "That reading is no longer saved.",
});

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const storage = () => window.localStorage;
let instances = 0;

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export class ObReflectionHistory extends HTMLElement {
  #passages = null;
  #work = null;
  #document = null;
  #persistence = "saved";
  #listeners = null;
  #ui = null;
  #labelling = null;
  #focusAfter = null;
  #compare = { earlier: "", later: "" };
  // Which reading is being deleted ("all" for every reading of this post), and which one a copy is being prepared for.
  #deleting = null;
  #sendFor = null;
  #draft = null;
  #sent = null;
  #sending = null;

  connectedCallback() {
    if (this.#listeners) return;
    const passages = readPassages(document.getElementById(DATA_ELEMENT_ID)?.textContent);
    // Without the page's passage text the static text stays, as without JavaScript.
    if (!passages) return;
    this.#passages = passages;
    this.#work = { site: location.origin, path: passages.work };
    if (!this.#ui) {
      instances += 1;
      this.#ui = this.#build(`ob-reflection-history-${instances}`);
      this.querySelector(".ob-reflection-history-static")?.remove();
      this.append(this.#ui.status, this.#ui.notice, this.#ui.make, this.#ui.body);
    }
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === STORAGE_KEY || event.key === DISABLED_KEY) this.#reload();
    }, { signal });
    window.addEventListener(CHANGED_EVENT, (event) => {
      if (event.detail?.from !== this) this.#reload();
    }, { signal });
    this.#reload();
  }

  disconnectedCallback() {
    this.#sending?.abort();
    this.#listeners?.abort();
    this.#listeners = null;
  }

  #reload() {
    const read = readStore(storage);
    if (this.#persistence === "full" && (read.status === "ok" || read.status === "empty")) {
      this.#render();
      return;
    }
    if (read.status === "unreadable") this.#persistence = "unreadable";
    else if (read.status === "blocked") this.#persistence = "blocked";
    else this.#persistence = "saved";
    if (!this.#document || read.status === "ok" || read.status === "empty") this.#document = read.document;
    this.#render();
  }

  #build(id) {
    const status = el("p", "ob-reflection-history-status");
    status.setAttribute("role", "status");
    const notice = el("p", "ob-reflection-history-notice");
    notice.hidden = true;

    const make = el("form", "ob-reflection-history-make");
    make.noValidate = true;
    const lead = el("p", "ob-reflection-history-lead", "Write how you read this post now. Each reading is saved as it is, in this browser only, and is never sent anywhere or judged. Later you can put an earlier reading beside a later one.");

    const where = el("fieldset", "ob-reflection-history-where");
    where.append(el("legend", undefined, "My reading is about"));
    const radio = (value, label, checked) => {
      const input = el("input");
      input.type = "radio";
      input.name = `${id}-where`;
      input.value = value;
      input.id = `${id}-where-${value}`;
      input.checked = Boolean(checked);
      const wrapper = el("div", "ob-reflection-history-choice");
      const text = el("label", undefined, label);
      text.htmlFor = input.id;
      wrapper.append(input, text);
      return { input, wrapper };
    };
    const work = radio("work", "The whole post", true);
    const section = radio("section", "A section");
    const sectionSelect = el("select");
    sectionSelect.id = `${id}-section-select`;
    sectionSelect.setAttribute("aria-label", "Section for the reading");
    for (const item of this.#passages.sections) {
      const option = el("option", undefined, item.title || (item.anchor === undefined ? "The opening, before the first heading" : `#${item.anchor}`));
      option.value = String(item.index);
      sectionSelect.append(option);
    }
    if (this.#passages.sections.length === 0) {
      section.input.disabled = true;
      sectionSelect.disabled = true;
    }
    where.append(work.wrapper, section.wrapper, sectionSelect);

    const labelField = el("div", "ob-reflection-history-field");
    const labelInput = el("input");
    labelInput.type = "text";
    labelInput.id = `${id}-label`;
    labelInput.maxLength = MAX_TITLE_CHARS;
    const labelLabel = el("label", undefined, "Label (optional, for you)");
    labelLabel.htmlFor = labelInput.id;
    labelField.append(labelLabel, labelInput);

    const follows = el("div", "ob-reflection-history-field");
    const followsSelect = el("select");
    followsSelect.id = `${id}-follows`;
    const followsLabel = el("label", undefined, "This reading follows");
    followsLabel.htmlFor = followsSelect.id;
    follows.append(followsLabel, followsSelect);

    const field = el("div", "ob-reflection-history-field");
    const text = el("textarea");
    text.id = `${id}-text`;
    text.rows = 5;
    text.maxLength = MAX_NOTE_CHARS;
    text.setAttribute("dir", "auto");
    const textLabel = el("label", undefined, "Your reading (private)");
    textLabel.htmlFor = text.id;
    const error = el("p", "ob-reflection-history-error");
    error.id = `${id}-error`;
    error.hidden = true;
    field.append(textLabel, text, error);

    const save = el("button", undefined, "Save this reading");
    save.type = "submit";
    make.append(lead, where, labelField, follows, field, save);

    const body = el("div", "ob-reflection-history-body");
    make.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#addReading();
    });
    sectionSelect.addEventListener("focus", () => (section.input.checked = true));
    sectionSelect.addEventListener("change", () => (section.input.checked = true));
    return { id, status, notice, make, body, work, section, sectionSelect, labelInput, followsSelect, text, error };
  }

  #say(message) {
    const { status } = this.#ui;
    status.textContent = "";
    setTimeout(() => {
      status.textContent = message;
    }, 30);
  }

  #commit(change) {
    let base = this.#document;
    if (this.#persistence === "saved") {
      const read = readStore(storage);
      if (read.status === "ok" || read.status === "empty") base = read.document;
      else if (read.status === "unreadable") this.#persistence = "unreadable";
      else if (read.status === "blocked") this.#persistence = "blocked";
    }
    const result = change(base);
    if (!result.ok) return result;
    this.#document = result.document;
    if (this.#persistence === "saved" || this.#persistence === "full") {
      const written = writeStore(storage, result.document);
      this.#persistence = written.ok ? "saved" : written.reason;
      if (written.ok) window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { from: this } }));
    }
    return result;
  }

  #savedWords() {
    return this.#persistence === "saved" ? "Saved in this browser." : "Kept until you leave this page.";
  }

  #addReading() {
    const ui = this.#ui;
    ui.error.hidden = true;
    ui.text.removeAttribute("aria-invalid");
    ui.text.removeAttribute("aria-describedby");
    const refuse = (message) => {
      ui.error.textContent = message;
      ui.error.hidden = false;
      ui.text.setAttribute("aria-invalid", "true");
      ui.text.setAttribute("aria-describedby", ui.error.id);
      ui.text.focus();
    };
    const text = ui.text.value;
    if (text.trim() === "") return refuse("Write your reading first.");
    let target = { version: 1, kind: "work" };
    if (ui.section.input.checked) {
      const section = this.#passages.sections[Number(ui.sectionSelect.value)];
      if (!section) return refuse("Choose a section.");
      target = { version: 1, kind: "section", digest: section.digest };
      if (section.anchor !== undefined) target = { version: 1, kind: "section", section: section.anchor, digest: section.digest };
    }
    const label = ui.labelInput.value.trim();
    const common = { revision: this.#passages.revision, target, text };
    if (label !== "") common.label = label;
    const earlier = ui.followsSelect.value;
    const result = this.#commit((document) =>
      earlier === ""
        ? addReflection(document, { work: this.#work, ...common })
        : reviseReflection(document, earlier, common));
    if (!result.ok) return refuse(PROBLEM_WORDS[result.problem.code] ?? "That reading could not be saved.");
    ui.text.value = "";
    ui.labelInput.value = "";
    this.#compare = { earlier: "", later: "" };
    this.#focusAfter = { id: result.id, control: "item" };
    this.#render();
    this.#say(`Reading saved. ${this.#savedWords()}`);
  }

  #relabel(id, value, input, error) {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
    const label = value.trim();
    const result = this.#commit((document) => relabelReflection(document, id, label === "" ? undefined : label));
    if (!result.ok) {
      error.textContent = PROBLEM_WORDS[result.problem.code] ?? "That label could not be saved.";
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", error.id);
      input.focus();
      return;
    }
    this.#labelling = null;
    this.#focusAfter = { id, control: "label" };
    this.#render();
    this.#say(`Label saved. ${this.#savedWords()}`);
  }

  #title(record, number) {
    return record.label ? record.label : `Reading ${number}`;
  }

  #scope(target) {
    if (target.kind === "work") return "About the whole post";
    if (target.kind === "section") {
      const section = this.#passages.sections.find((each) => each.anchor === target.section) ?? this.#passages.sections.find((each) => each.digest === target.digest);
      return section?.title ? `About the section ${section.title}` : target.section ? `About the section #${target.section}` : "About the opening of the post";
    }
    return "About some words in the post";
  }

  #render() {
    const ui = this.#ui;
    if (isDisabled(storage)) {
      ui.notice.textContent = STORAGE_NOTES.off;
      ui.notice.hidden = false;
      ui.make.hidden = true;
      ui.body.hidden = true;
      ui.body.replaceChildren();
      return;
    }
    ui.make.hidden = false;
    ui.body.hidden = false;
    const note = STORAGE_NOTES[this.#persistence];
    ui.notice.textContent = note ?? "";
    ui.notice.hidden = !note;

    const mine = reflectionsOf(this.#document, this.#work);
    const works = { [workKey(this.#work)]: { revision: this.#passages.revision, sections: this.#passages.sections } };
    const assessed = new Map(assessReflections({ ...this.#document, reflections: mine }, works).map((each, index) => [mine[index].id, each]));
    const numbers = new Map(mine.map((record, index) => [record.id, index + 1]));

    // The reading a new one may follow: only the end of a line, since a reading is followed at most once.
    const ends = mine.filter((record) => !mine.some((each) => each.revises === record.id));
    const chosen = ui.followsSelect.value;
    ui.followsSelect.replaceChildren();
    const none = el("option", undefined, "Nothing: a new line of thought");
    none.value = "";
    ui.followsSelect.append(none);
    for (const record of ends) {
      const option = el("option", undefined, this.#title(record, numbers.get(record.id)));
      option.value = record.id;
      ui.followsSelect.append(option);
    }
    ui.followsSelect.value = ends.some((record) => record.id === chosen) ? chosen : ends.length > 0 ? ends.at(-1).id : "";

    ui.body.replaceChildren();
    if (mine.length === 0) {
      ui.body.append(el("p", "ob-reflection-history-empty", "No readings saved for this post yet."));
      this.#restoreFocus();
      return;
    }

    const histories = reflectionHistories(this.#document, this.#work);
    ui.body.append(el("h3", "ob-reflection-history-heading", "Your readings of this post"));
    histories.forEach((line, lineIndex) => {
      const group = el("div", "ob-reflection-history-line");
      if (histories.length > 1) group.append(el("h4", undefined, `Line of thought ${lineIndex + 1}`));
      const list = el("ol", "ob-reflection-history-list");
      list.setAttribute("aria-label", histories.length > 1 ? `Line of thought ${lineIndex + 1}, earliest first` : "Your readings, earliest first");
      for (const record of line) list.append(this.#item(record, assessed.get(record.id), numbers.get(record.id)));
      group.append(list);
      ui.body.append(group);
    });
    ui.body.append(this.#comparison(mine, numbers, assessed));
    ui.body.append(this.#removeAll(mine.length));
    this.#restoreFocus();
  }

  #item(record, state, number) {
    const ui = this.#ui;
    const item = el("li", "ob-reflection-history-item");
    item.dataset.reflection = record.id;
    item.tabIndex = -1;
    item.append(this.#summary(record, state, number, "h4"));
    const actions = el("div", "ob-reflection-history-actions");
    if (this.#labelling === record.id) {
      const input = el("input");
      input.type = "text";
      input.id = `${ui.id}-label-${record.id}`;
      input.maxLength = MAX_TITLE_CHARS;
      input.value = record.label ?? "";
      input.dataset.control = "label-input";
      const label = el("label", undefined, `Label for ${this.#title(record, number)}`);
      label.htmlFor = input.id;
      const error = el("p", "ob-reflection-history-error");
      error.id = `${input.id}-error`;
      error.hidden = true;
      const save = el("button", undefined, "Save label");
      save.type = "button";
      const cancel = el("button", undefined, "Cancel");
      cancel.type = "button";
      save.addEventListener("click", () => this.#relabel(record.id, input.value, input, error));
      cancel.addEventListener("click", () => {
        this.#labelling = null;
        this.#focusAfter = { id: record.id, control: "label" };
        this.#render();
        this.#say("Editing cancelled. Nothing changed.");
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.#relabel(record.id, input.value, input, error);
        } else if (event.key === "Escape") cancel.click();
      });
      actions.append(label, input, error, save, cancel);
    } else {
      const edit = el("button", undefined, record.label ? "Change label" : "Add a label");
      edit.type = "button";
      edit.dataset.control = "label";
      edit.setAttribute("aria-label", `${record.label ? "Change the label of" : "Add a label to"}: ${this.#title(record, number)}`);
      edit.addEventListener("click", () => {
        this.#labelling = record.id;
        this.#focusAfter = { id: record.id, control: "label-input" };
        this.#render();
      });
      actions.append(edit);
    }
    this.#controls(record, number, actions);
    item.append(actions);
    const sent = this.#sentList(record);
    if (sent) item.append(sent);
    if (this.#deleting === record.id) item.append(this.#deletePanel(record, number));
    if (this.#sendFor === record.id) item.append(this.#sendPanel(record, number));
    else if (this.#sent?.id === record.id) item.append(this.#sentPanel());
    return item;
  }

  /** The delete and send controls of one reading. */
  #controls(record, number, actions) {
    const name = this.#title(record, number);
    if (!thirdPerspectiveRegion()) {
      const remove = this.#deleteButton(record, name);
      actions.append(el("span", "ob-reflection-history-hint", "This post does not take Third Perspectives, so a copy cannot be sent from here."), remove);
      return;
    }
    const send = el("button", undefined, "Send a copy for review");
    send.type = "button";
    send.dataset.control = "send";
    send.setAttribute("aria-label", `Send a copy for review: ${name}`);
    send.setAttribute("aria-expanded", String(this.#sendFor === record.id));
    send.addEventListener("click", () => {
      this.#sendFor = this.#sendFor === record.id ? null : record.id;
      this.#deleting = null;
      this.#sent = null;
      this.#draft = { category: "", name: "", publishName: false, publish: false, clarification: false, prepared: null };
      this.#focusAfter = { id: record.id, control: this.#sendFor ? "send-first" : "send" };
      this.#render();
    });
    const remove = this.#deleteButton(record, name);
    actions.append(send, remove);
  }

  #deleteButton(record, name) {
    const remove = el("button", undefined, "Delete this reading");
    remove.type = "button";
    remove.dataset.control = "delete";
    remove.setAttribute("aria-label", `Delete this reading: ${name}`);
    remove.addEventListener("click", () => {
      this.#deleting = record.id;
      this.#sendFor = null;
      this.#focusAfter = { id: record.id, control: "delete-no" };
      this.#render();
    });
    return remove;
  }

  /** What has been sent from this reading. The copy has its own life: nothing here changes it. */
  #sentList(record) {
    if (!record.submissions || record.submissions.length === 0) return null;
    const box = el("div", "ob-reflection-history-sent");
    box.append(el("p", "ob-reflection-history-meta", `${plural(record.submissions.length, "copy")} of this reading ${record.submissions.length === 1 ? "was" : "were"} sent. Each copy is separate: changing or deleting this reading does not change it. To take a hosted copy back, use the receipt you were given.`));
    const list = el("ul");
    for (const each of record.submissions) {
      list.append(el("li", undefined, `${when(each.at)}, ${each.channel === "hosted" ? "sent for review through this site" : "copied and sent by you"}`));
    }
    box.append(list);
    return box;
  }

  #deletePanel(record, number) {
    const box = el("div", "ob-reflection-history-confirm");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Delete ${this.#title(record, number)}?`);
    box.append(el("p", undefined, "Delete this reading from this browser? Its words are removed here and cannot be brought back, unless you exported them. Copies already sent are not affected."));
    const yes = el("button", undefined, "Yes, delete it");
    yes.type = "button";
    const no = el("button", undefined, "Keep it");
    no.type = "button";
    no.dataset.control = "delete-no";
    yes.addEventListener("click", () => this.#delete(record.id));
    no.addEventListener("click", () => {
      this.#deleting = null;
      this.#focusAfter = { id: record.id, control: "delete" };
      this.#render();
      this.#say("Nothing was deleted.");
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") no.click();
    });
    box.append(yes, no);
    return box;
  }

  /** Deletion is checked: the saved document is read again and must no longer hold what was deleted. */
  #verified(ids) {
    if (this.#persistence !== "saved") return "It is removed for this visit only, because this browser is not saving.";
    const fresh = readStore(storage);
    if (fresh.status !== "ok" && fresh.status !== "empty") return "";
    const gone = fresh.document.reflections.every((each) => !ids.includes(each.id));
    return gone ? "Checked: it is no longer saved in this browser." : "It could not be confirmed as removed from this browser.";
  }

  #delete(id) {
    const ids = id === "all" ? reflectionsOf(this.#document, this.#work).map((each) => each.id) : [id];
    const result = this.#commit((document) => (id === "all" ? deleteWorkReflections(document, this.#work) : deleteReflection(document, id)));
    this.#deleting = null;
    if (!result.ok) {
      this.#render();
      this.#say(PROBLEM_WORDS[result.problem.code] ?? "That could not be deleted.");
      return;
    }
    const left = reflectionsOf(this.#document, this.#work).length;
    this.#compare = { earlier: "", later: "" };
    if (this.#sendFor && ids.includes(this.#sendFor)) this.#sendFor = null;
    this.#render();
    this.#say(`${id === "all" ? `Deleted ${plural(ids.length, "reading")}.` : "Deleted the reading."} ${plural(left, "reading")} left for this post. ${this.#verified(ids)}`);
    this.#ui.text.focus();
  }

  #sendPanel(record, number) {
    const draft = this.#draft;
    const prefix = `${this.#ui.id}-send-${record.id}`;
    const box = el("section", "ob-reflection-history-send");
    box.setAttribute("aria-labelledby", `${prefix}-title`);
    const title = el("h5", undefined, `Send a copy of ${this.#title(record, number)} for review`);
    title.id = `${prefix}-title`;
    box.append(
      title,
      el("p", "ob-reflection-history-hint", "This sends a separate copy of this reading's words and where it was written, offered as a Third Perspective. It is not published unless you agree below and a moderator approves that exact text. Your reading here stays private and unchanged, and editing or deleting it later does not change the copy. Your label, history and other readings are never included."),
    );
    const field = (labelText, control, key) => {
      const wrapper = el("div", "ob-reflection-history-field");
      control.id = `${prefix}-${key}`;
      const label = el("label", undefined, labelText);
      label.htmlFor = control.id;
      wrapper.append(label, control);
      return wrapper;
    };
    const checkbox = (labelText, key, checked) => {
      const wrapper = el("div", "ob-reflection-history-choice");
      const input = el("input");
      input.type = "checkbox";
      input.id = `${prefix}-${key}`;
      input.checked = checked;
      const label = el("label", undefined, labelText);
      label.htmlFor = input.id;
      wrapper.append(input, label);
      return { wrapper, input };
    };
    const category = el("select");
    category.dataset.control = "send-first";
    const none = el("option", undefined, "No prompt");
    none.value = "";
    category.append(none);
    for (const each of RESPONSE_CATEGORIES) {
      const option = el("option", undefined, each.label);
      option.value = each.id;
      category.append(option);
    }
    category.value = draft.category;
    const name = el("input");
    name.type = "text";
    name.maxLength = MAX_READER_NAME_CHARS;
    name.value = draft.name;
    const showName = checkbox("Show my name if it is published", "show-name", draft.publishName);
    const publish = checkbox("I agree this reading may be published once a moderator approves it", "publish", draft.publish);
    const clarify = checkbox("A moderator may ask me to make it clearer, through my private receipt", "clarify", draft.clarification);
    const error = el("p", "ob-reflection-history-error");
    error.id = `${prefix}-error`;
    error.hidden = true;
    const preview = el("div", "ob-reflection-history-preview");
    const actions = el("div", "ob-reflection-history-actions");

    const showError = (message, control) => {
      error.textContent = message;
      error.hidden = false;
      control?.setAttribute("aria-invalid", "true");
      control?.setAttribute("aria-describedby", error.id);
      control?.focus();
    };
    const clearError = () => {
      error.hidden = true;
      for (const input of [name, publish.input]) {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    };
    const read = () => {
      draft.category = category.value;
      draft.name = name.value;
      draft.publishName = showName.input.checked;
      draft.publish = publish.input.checked;
      draft.clarification = clarify.input.checked;
    };

    const previewButton = el("button", undefined, "Preview the copy");
    previewButton.type = "button";
    previewButton.dataset.control = "preview";
    const close = el("button", undefined, "Cancel");
    close.type = "button";

    const drawPreview = () => {
      preview.replaceChildren();
      actions.replaceChildren();
      const prepared = draft.prepared;
      if (!prepared) {
        actions.append(previewButton, close);
        return;
      }
      const area = el("textarea");
      area.readOnly = true;
      area.rows = 8;
      area.value = prepared.text;
      area.id = `${prefix}-preview`;
      area.spellcheck = false;
      const label = el("label", undefined, "Exactly what would be sent");
      label.htmlFor = area.id;
      preview.append(label, area);
      const endpoint = hostedEndpoint();
      if (endpoint) {
        const sendButton = el("button", undefined, "Send for review");
        sendButton.type = "button";
        sendButton.dataset.control = "send-now";
        sendButton.addEventListener("click", () => this.#post(record, endpoint, sendButton));
        actions.append(sendButton);
      } else {
        preview.append(el("p", "ob-reflection-history-hint", "This site does not take reflections through a form. Copy the text and send it to the author yourself, then say you did."));
      }
      const contact = regionContact(thirdPerspectiveRegion());
      if (contact) {
        const link = el("a", undefined, contact.startsWith("mailto:") ? "Write to the author" : "Open the author's contact page");
        link.href = contact;
        preview.append(link);
      }
      const copy = el("button", undefined, "Copy to send myself");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        const text = thirdPerspectiveCopyText(prepared.submission, thirdPerspectiveRegion()?.getAttribute("page") || "");
        try {
          await globalThis.navigator.clipboard.writeText(text);
          this.#say("The copy was copied. When you have sent it, choose I sent it myself.");
        } catch {
          const fallback = el("textarea");
          fallback.readOnly = true;
          fallback.rows = 8;
          fallback.value = text;
          fallback.setAttribute("aria-label", "The copy to send");
          preview.append(fallback);
          fallback.focus();
          fallback.select();
          this.#say("The copy is selected: press Control+C (or Command+C) to copy it.");
        }
      });
      const sentMyself = el("button", undefined, "I sent it myself");
      sentMyself.type = "button";
      sentMyself.dataset.control = "sent-myself";
      sentMyself.addEventListener("click", () => this.#recorded(record.id, "copy-and-send", null));
      actions.append(copy, sentMyself, close);
    };

    // Changing anything takes the preview away: only a copy the reader has seen can be sent.
    const stale = () => {
      read();
      draft.prepared = null;
      clearError();
      drawPreview();
    };

    previewButton.addEventListener("click", () => {
      read();
      clearError();
      const trimmed = draft.name.trim();
      const result = prepareSubmissionCopy(this.#document, record.id, {
        site: this.#work.site,
        category: draft.category === "" ? undefined : draft.category,
        name: trimmed === "" ? undefined : trimmed,
        publishName: trimmed === "" ? undefined : draft.publishName,
        consent: draft.publish ? { publish: true, clarification: draft.clarification } : undefined,
      });
      if (!result.ok) {
        if (result.error.code === "publicationConsentRequired") showError("Tick the agreement to offer a copy for publication.", publish.input);
        else if (result.error.code === "invalidName" || result.error.code === "consentWithoutName") showError("Use plain text of up to 80 characters for your name, or leave it empty.", name);
        else showError(result.error.message, null);
        return;
      }
      draft.prepared = result;
      drawPreview();
      this.#say("The copy is ready to read below. Nothing has been sent.");
    });

    for (const input of [category, showName.input, publish.input, clarify.input]) {
      input.addEventListener("change", stale);
    }
    name.addEventListener("input", stale);
    close.addEventListener("click", () => {
      this.#sendFor = null;
      this.#draft = null;
      this.#focusAfter = { id: record.id, control: "send" };
      this.#render();
      this.#say("Nothing was sent.");
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.#sending) close.click();
    });
    box.append(
      field("Prompt (optional)", category, "category"),
      field("Name (optional)", name, "name"),
      showName.wrapper,
      publish.wrapper,
      clarify.wrapper,
      error,
      preview,
      actions,
    );
    drawPreview();
    return box;
  }

  async #post(record, endpoint, button) {
    const prepared = this.#draft?.prepared;
    if (!prepared || this.#sending) return;
    if (globalThis.navigator?.onLine === false) {
      this.#say("You seem to be offline, so nothing was sent. Your reading is unchanged. Try again later, or copy the text and send it yourself.");
      return;
    }
    const controller = new AbortController();
    this.#sending = controller;
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT);
    button.setAttribute("aria-disabled", "true");
    button.textContent = "Sending…";
    this.#say("Sending the copy…");
    let outcome;
    try {
      const response = await fetch(`${endpoint}/feedback`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: prepared.text,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      outcome = {
        status: response.status,
        code: result && typeof result === "object" ? result.code : undefined,
        receipt: result && typeof result === "object" && isReceipt(result.receipt) ? result.receipt : undefined,
      };
    } catch {
      outcome = { status: 0 };
    } finally {
      clearTimeout(timer);
      if (this.#sending === controller) this.#sending = null;
    }
    if (!this.isConnected) return;
    if (outcome.status === 202) {
      const panel = outcome.receipt
        ? receiptPanel({ endpoint, receipt: outcome.receipt, consent: prepared.submission.consent.clarification, noun: "reflection", feature: { revision: 1, agreed: false } })
        : null;
      this.#recorded(record.id, "hosted", panel);
      return;
    }
    button.removeAttribute("aria-disabled");
    button.textContent = "Send for review";
    if (outcome.status === 409 && outcome.code === "duplicate") {
      this.#say("This copy was already sent from here and is waiting for review.");
      return;
    }
    const reason =
      outcome.status === 0
        ? "the service did not answer"
        : outcome.status === 429
          ? "too many have come from here recently"
          : outcome.status === 403 && outcome.code === "closed"
            ? "this work is not taking Third Perspectives now"
            : outcome.status === 404 || outcome.code === "unavailable"
              ? "this site is not taking reflections through the form right now"
              : outcome.status === 413 || outcome.status === 422
                ? "the service could not accept this text"
                : "the service had a problem";
    this.#say(`The copy was not sent: ${reason}. Your reading is unchanged and nothing is recorded as sent. You can try again or copy the text and send it yourself.`);
  }

  /** Only after a copy really left (or the reader says they sent it) is the send written down on the reading. */
  #recorded(id, channel, receipt) {
    const result = this.#commit((document) => markSubmitted(document, id, { channel }));
    this.#sendFor = null;
    this.#draft = null;
    this.#sent = { id, channel, receipt };
    this.#focusAfter = { id, control: "sent" };
    this.#render();
    if (!result.ok) this.#say("The copy was sent, but writing that down here failed.");
    else this.#say(channel === "hosted" ? "Sent for review. It is published only if a moderator approves it." : `Noted that you sent a copy. ${this.#savedWords()}`);
  }

  #sentPanel() {
    const sent = this.#sent;
    const box = el("div", "ob-reflection-history-sent-now");
    box.tabIndex = -1;
    box.dataset.control = "sent";
    box.append(
      el(
        "p",
        undefined,
        sent.channel === "hosted"
          ? `Thank you. A copy was sent for review. It is published only if a moderator approves it, as you chose.${sent.receipt ? " Keep the receipt below: it is shown only once." : ""}`
          : "Noted. Your reading here is unchanged and still private.",
      ),
    );
    if (sent.receipt) box.append(sent.receipt);
    const done = el("button", undefined, "Close");
    done.type = "button";
    done.addEventListener("click", () => {
      this.#sent = null;
      this.#render();
    });
    box.append(done);
    return box;
  }

  /** What one reading says, and where it stands against the post now. Shared by the list and the comparison. */
  #summary(record, state, number, level) {
    const box = el("div", "ob-reflection-history-reading");
    box.append(el(level, "ob-reflection-history-title", this.#title(record, number)));
    const text = el("p", "ob-reflection-history-text", record.text);
    text.setAttribute("dir", "auto");
    box.append(el("p", "ob-reflection-history-meta", `${this.#scope(record.target)}. Written ${when(record.createdAt)}.`), text);
    box.append(el("p", "ob-reflection-history-state", ARTICLE_WORDS[String(state.articleChanged)]));
    if (state.state !== "current") box.append(el("p", "ob-reflection-history-state", STATE_WORDS[state.state] ?? ""));
    return box;
  }

  #comparison(mine, numbers, assessed) {
    const ui = this.#ui;
    const section = el("section", "ob-reflection-history-compare");
    const id = `${ui.id}-compare`;
    section.setAttribute("aria-labelledby", `${id}-title`);
    const title = el("h3", undefined, "Compare two readings");
    title.id = `${id}-title`;
    section.append(title);
    if (mine.length < 2) {
      section.append(el("p", "ob-reflection-history-hint", "Save a second reading to put it beside the first."));
      return section;
    }
    const picks = el("div", "ob-reflection-history-picks");
    const select = (name, label, value) => {
      const field = el("div", "ob-reflection-history-field");
      const control = el("select");
      control.id = `${id}-${name}`;
      control.dataset.control = name;
      const empty = el("option", undefined, "Choose a reading");
      empty.value = "";
      control.append(empty);
      for (const record of mine) {
        const option = el("option", undefined, `${this.#title(record, numbers.get(record.id))} (${when(record.createdAt)})`);
        option.value = record.id;
        control.append(option);
      }
      control.value = mine.some((record) => record.id === value) ? value : "";
      const text = el("label", undefined, label);
      text.htmlFor = control.id;
      field.append(text, control);
      return { field, control };
    };
    const earlier = select("earlier", "One reading", this.#compare.earlier);
    const later = select("later", "Another reading", this.#compare.later);
    picks.append(earlier.field, later.field);
    const result = el("div", "ob-reflection-history-pair");
    result.setAttribute("role", "group");
    result.setAttribute("aria-label", "The two readings you chose");
    const draw = () => {
      this.#compare = { earlier: earlier.control.value, later: later.control.value };
      result.replaceChildren();
      const a = mine.find((record) => record.id === this.#compare.earlier);
      const b = mine.find((record) => record.id === this.#compare.later);
      if (!a || !b) {
        result.append(el("p", "ob-reflection-history-hint", "Choose two readings to see them together. Neither is marked right or wrong."));
        return;
      }
      if (a.id === b.id) {
        result.append(el("p", "ob-reflection-history-hint", "Choose two different readings."));
        return;
      }
      // Whichever was written first is shown first.
      const [first, second] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
      for (const [position, record] of [["Written first", first], ["Written later", second]]) {
        const column = el("article", "ob-reflection-history-column");
        column.append(el("p", "ob-reflection-history-position", position));
        column.append(this.#summary(record, assessed.get(record.id), numbers.get(record.id), "h5"));
        result.append(column);
      }
    };
    earlier.control.addEventListener("change", draw);
    later.control.addEventListener("change", draw);
    section.append(picks, result);
    draw();
    return section;
  }

  #removeAll(count) {
    const box = el("div", "ob-reflection-history-remove");
    if (this.#deleting === "all") {
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", "Remove all readings of this post?");
      box.append(el("p", undefined, `Remove all ${plural(count, "reading")} of this post from this browser? They cannot be brought back, unless you exported them. Copies already sent are not affected, and readings of other posts stay.`));
      const yes = el("button", undefined, "Yes, remove them all");
      yes.type = "button";
      yes.addEventListener("click", () => this.#delete("all"));
      const no = el("button", undefined, "Keep them");
      no.type = "button";
      no.dataset.control = "remove-no";
      no.addEventListener("click", () => {
        this.#deleting = null;
        this.#focusAfter = { id: "all", control: "remove" };
        this.#render();
        this.#say("Nothing was removed.");
      });
      box.addEventListener("keydown", (event) => {
        if (event.key === "Escape") no.click();
      });
      box.append(yes, no);
    } else {
      const remove = el("button", undefined, "Remove all my readings of this post");
      remove.type = "button";
      remove.dataset.control = "remove";
      remove.addEventListener("click", () => {
        this.#deleting = "all";
        this.#sendFor = null;
        this.#focusAfter = { id: "all", control: "remove-no" };
        this.#render();
      });
      box.append(remove);
    }
    return box;
  }

  #restoreFocus() {
    const want = this.#focusAfter;
    this.#focusAfter = null;
    if (!want) return;
    if (want.id === "all") {
      this.#ui.body.querySelector(`.ob-reflection-history-remove [data-control="${want.control}"]`)?.focus();
      return;
    }
    const item = Array.from(this.#ui.body.querySelectorAll("[data-reflection]")).find((each) => each.dataset.reflection === want.id);
    if (!item) return;
    const control = want.control === "item" ? item : item.querySelector(`[data-control="${want.control}"]`) ?? item.querySelector("button");
    control?.focus();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ob-reflection-history")) {
  customElements.define("ob-reflection-history", ObReflectionHistory);
}
