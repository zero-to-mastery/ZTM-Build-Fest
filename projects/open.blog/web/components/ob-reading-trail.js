// <ob-reading-trail> lets a reader keep saved sources and reading trails in their own browser
// (ADRs 0237, 0242 and 0243, docs/specs/reader-annotations.md). The page is complete without it: the
// region's static text says what it needs.
//
// Nothing is recorded as the reader reads. A trail is a list the reader builds by hand: sources
// they choose to save (this post, or a reference it cites) and highlights or notes they chose to
// add. Nothing is stored until the reader acts, nothing is sent anywhere, and the list says so.
//
// It reads and writes the same document as <ob-annotations> through reader-annotations-store.js, so
// every change is checked by the contract. Unlike the highlights, this panel keeps nothing in
// memory only: a change that cannot be saved is refused with the reason and nothing is altered.
// Saved data this version cannot read is never written over. Every reader-facing string is set as
// text; every link comes from validated data.

import { MAX_TITLE_CHARS, workKey } from "./reader-annotations.js";
import { DATA_ELEMENT_ID, readPassages } from "./passage-selection.js";
import { MAX_IMPORT_BYTES, buildExport, planImport, summarize } from "./reader-annotations-transfer.js";
import {
  CHANGED_EVENT,
  DISABLED_KEY,
  STORAGE_KEY,
  addTrailStep,
  annotatedWorks,
  clearStore,
  commitStore,
  createTrail,
  deleteTrail,
  deleteSource,
  deleteWorkAnnotations,
  fitTitle,
  isDisabled,
  moveTrailStep,
  readStore,
  recentTrails,
  recordById,
  removeTrailStep,
  saveSource,
  savedKeys,
  setDisabled,
} from "./reader-annotations-store.js";

const REFERENCES_ELEMENT_ID = "ob-references";
const MAX_REFERENCES_LENGTH = 1_000_000;

const NOTICES = Object.freeze({
  blocked: "This browser does not allow saving here, so sources and trails cannot be kept. Reading is not affected.",
  unreadable: "Highlights, notes or trails saved earlier in this browser could not be read. They have been left untouched and nothing here can change them, but you can clear them below.",
});
const FAILURES = Object.freeze({
  blocked: "This browser does not allow saving here, so nothing was changed.",
  full: "This browser has no room to save that, so nothing was changed. Remove something to make room.",
  unreadable: "What is saved in this browser could not be read, so nothing was changed and nothing was written over it.",
});
const PROBLEM_WORDS = Object.freeze({
  alreadySaved: "That source is already saved.",
  duplicateStep: "That is already in this trail.",
  tooMany: "There is no room for another one. Remove one first.",
  tooLarge: "That is too large to keep. Remove something first.",
  emptyText: "Write a name first.",
  textTooLong: `A name can hold at most ${MAX_TITLE_CHARS} characters.`,
  forbiddenCharacter: "A name cannot hold control or text-direction characters.",
  missing: "That is no longer saved.",
  changed: "What is saved in this browser changed since the preview, so nothing was imported. Choose the file again.",
});
const IMPORT_PROBLEMS = Object.freeze({
  wrongFormat: "This is not a reading-trail file made by open.blog.",
  malformed: "The file is not a readable reading-trail document.",
  unsupportedVersion: "The file was made by a newer version than this page understands.",
  tooLarge: "The file is larger than this page will read.",
  tooMany: "The file holds more records than this page can keep.",
  unsafeScheme: "A link in the file is not a plain http or https link.",
  invalidUrl: "A link in the file is not in its canonical form.",
  invalidPath: "A path in the file is not a safe, canonical path.",
  invalidSite: "A site in the file is not a plain http or https origin.",
  forbiddenCharacter: "The file holds control or text-direction characters.",
  unknownField: "The file holds a field this version does not know.",
  unknownKind: "The file holds a kind of record this version does not know.",
  duplicateId: "Two records in the file share an id.",
  danglingRef: "A trail in the file names a record that is not in it.",
  privacyMismatch: "The file says it leaves out notes but holds note text.",
});

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const short = (text, max = 60) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A link as the contract keeps it (plain http or https, no credentials, canonical), else null. */
function canonicalLink(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
    return url.href === value ? value : url.href;
  } catch {
    return null;
  }
}

/**
 * What this page cites that a reader can save: [{ id, title, url }] from the page's own reference data. A
 * reference with an outside link is saved by that link; one without is saved as a pointer to its note in
 * this post. Anything unreadable is simply not offered.
 */
export function savableReferences(text, here) {
  if (typeof text !== "string" || text.length > MAX_REFERENCES_LENGTH) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.references) || !Array.isArray(data.citations)) return [];
  const notes = new Map();
  for (const citation of data.citations) {
    if (citation && typeof citation.reference === "string" && typeof citation.note === "string" && citation.note && !notes.has(citation.reference)) {
      notes.set(citation.reference, citation.note);
    }
  }
  const seen = new Set();
  const found = [];
  for (const reference of data.references) {
    if (!reference || typeof reference.id !== "string" || typeof reference.formatted !== "string") continue;
    const title = fitTitle(reference.formatted);
    if (!title) continue;
    let url = canonicalLink(reference.link);
    if (!url && notes.has(reference.id)) {
      try {
        const page = new URL(`${here.site}${here.path}`);
        page.hash = notes.get(reference.id);
        url = canonicalLink(page.href);
      } catch {
        url = null;
      }
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    found.push({ id: reference.id, title, url });
  }
  return found;
}

const storage = () => window.localStorage;
let instances = 0;

export class ObReadingTrail extends HTMLElement {
  #listeners = null;
  #ui = null;
  #here = null;
  #document = null;
  #stored = "empty";
  #references = [];
  #confirm = null;
  #focus = null;
  #trailChoice = null;
  #exportNotes = false;
  #import = null;
  #importError = null;
  #fields = { trail: "", item: "" };

  connectedCallback() {
    if (this.#listeners) return;
    const passages = readPassages(document.getElementById(DATA_ELEMENT_ID)?.textContent);
    // The path the build published for this post, so /tides/ and /tides/index.html are one work.
    this.#here = { site: location.origin, path: passages?.work ?? location.pathname };
    this.#references = savableReferences(document.getElementById(REFERENCES_ELEMENT_ID)?.textContent, this.#here);
    if (!this.#ui) {
      instances += 1;
      this.#ui = { id: `ob-reading-trail-${instances}`, status: el("p", "ob-trail-status"), notice: el("p", "ob-trail-notice"), body: el("div", "ob-trail-body") };
      this.#ui.status.setAttribute("role", "status");
      this.#ui.notice.hidden = true;
      this.querySelector(".ob-reading-trail-static")?.remove();
      this.append(this.#ui.status, this.#ui.notice, this.#ui.body);
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
    this.#listeners?.abort();
    this.#listeners = null;
  }

  #reload() {
    const read = readStore(storage);
    this.#document = read.document;
    this.#stored = read.status;
    this.#render();
  }

  #say(message) {
    const { status } = this.#ui;
    status.textContent = "";
    // A changed text is what a screen reader announces.
    setTimeout(() => {
      status.textContent = message;
    }, 30);
  }

  /**
   * Apply a change to the freshest saved document. On success the panel and the page's highlights are
   * refreshed; on failure nothing has changed and the reason is returned in the reader's words.
   */
  #apply(change, { done, focus } = {}) {
    const result = commitStore(storage, change);
    if (!result.ok) {
      const message = result.reason === "problem" ? PROBLEM_WORDS[result.problem.code] ?? "That could not be saved." : FAILURES[result.reason];
      return { ok: false, message };
    }
    this.#document = result.document;
    this.#stored = "ok";
    this.#confirm = null;
    this.#focus = focus ?? null;
    this.#render();
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { from: this } }));
    if (done) this.#say(done);
    return result;
  }

  #fail(message) {
    this.#confirm = null;
    this.#render();
    this.#say(message);
  }

  #heading(text, id) {
    const heading = el("h3", "ob-trail-heading", text);
    heading.id = id;
    heading.tabIndex = -1;
    heading.dataset.focus = id;
    return heading;
  }

  #render() {
    const ui = this.#ui;
    const document_ = this.#document;
    const note = NOTICES[this.#stored];
    ui.notice.textContent = note ?? "";
    ui.notice.hidden = !note;
    const off = isDisabled(storage);
    const lead = el("p", "ob-trail-lead", "Nothing is recorded as you read. Saved sources and trails hold only what you choose to add, are kept in this browser and are never sent anywhere.");
    const children = off
      ? [lead, this.#transfer(document_, true), this.#clear()]
      : [lead, this.#sources(document_), this.#works(document_), this.#trails(document_), this.#transfer(document_, false), this.#clear()];
    ui.body.replaceChildren(...children);
    this.#restoreFocus();
  }

  #restoreFocus() {
    const want = this.#focus;
    this.#focus = null;
    if (!want) return;
    const candidates = Array.isArray(want) ? want : [want];
    for (const key of candidates) {
      const target = Array.from(this.#ui.body.querySelectorAll("[data-focus]")).find((node) => node.dataset.focus === key);
      if (target) {
        target.focus();
        return;
      }
    }
  }

  /** A button that asks first: the first press shows "Confirm" and "Keep it", the confirm does the work. */
  #danger({ key, label, name, confirmLabel, onConfirm }) {
    const actions = el("span", "ob-trail-actions");
    if (this.#confirm === key) {
      const yes = el("button", undefined, confirmLabel);
      yes.type = "button";
      yes.dataset.focus = `${key}:confirm`;
      yes.setAttribute("aria-label", `${confirmLabel}: ${name}`);
      const keep = el("button", undefined, "Keep it");
      keep.type = "button";
      yes.addEventListener("click", onConfirm);
      keep.addEventListener("click", () => {
        this.#confirm = null;
        this.#focus = `${key}:ask`;
        this.#render();
        this.#say("Nothing was changed.");
      });
      actions.append(yes, keep);
    } else {
      const ask = el("button", undefined, label);
      ask.type = "button";
      ask.dataset.focus = `${key}:ask`;
      ask.setAttribute("aria-label", `${label}: ${name}`);
      ask.addEventListener("click", () => {
        this.#confirm = key;
        this.#focus = `${key}:confirm`;
        this.#render();
      });
      actions.append(ask);
    }
    return actions;
  }

  #workLink(work, text) {
    const link = el("a", undefined, text ?? work.path);
    link.href = `${work.site}${work.path}`;
    return link;
  }

  #isHere(work) {
    return work.site === this.#here.site && work.path === this.#here.path;
  }

  #describe(record) {
    if (record.kind === "source") return `Source: ${short(record.title, 60)}`;
    const words = record.target.kind === "quote" ? record.target.exact : record.text ?? "the whole post";
    return `${record.kind === "note" ? "Note" : "Highlight"}: ${short(record.text !== undefined && record.target.kind === "quote" ? `${record.target.exact} (${record.text})` : words, 60)}`;
  }

  #sources(document_) {
    const section = el("section", "ob-trail-section");
    section.setAttribute("aria-labelledby", `${this.#ui.id}-sources`);
    section.append(this.#heading("Saved sources", `${this.#ui.id}-sources`));

    const pageTitle = fitTitle(this.closest("article")?.querySelector("h1")?.textContent || document.title);
    const form = el("form", "ob-trail-form");
    form.noValidate = true;
    const error = el("p", "ob-trail-error");
    error.id = `${this.#ui.id}-source-error`;
    error.hidden = true;
    const savePost = el("button", undefined, "Save this post as a source");
    savePost.type = "button";
    savePost.dataset.focus = "save-post";
    savePost.setAttribute("aria-describedby", error.id);
    const refuse = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    savePost.addEventListener("click", () => {
      const result = this.#apply((current) => saveSource(current, { title: pageTitle || this.#here.path, work: this.#here }), {
        done: "This post is saved as a source.",
        focus: "save-post",
      });
      if (!result.ok) {
        refuse(result.message);
        this.#say(result.message);
      }
    });
    form.append(savePost);

    if (this.#references.length > 0) {
      const field = el("div", "ob-trail-field");
      const select = el("select");
      select.id = `${this.#ui.id}-reference`;
      const label = el("label", undefined, "A reference this post cites");
      label.htmlFor = select.id;
      for (const reference of this.#references) {
        const option = el("option", undefined, short(reference.title, 110));
        option.value = reference.url;
        select.append(option);
      }
      select.setAttribute("aria-describedby", error.id);
      const save = el("button", undefined, "Save the reference");
      save.type = "button";
      save.dataset.focus = "save-reference";
      save.setAttribute("aria-describedby", error.id);
      save.addEventListener("click", () => {
        const reference = this.#references.find((each) => each.url === select.value);
        if (!reference) return;
        const result = this.#apply((current) => saveSource(current, { title: reference.title, url: reference.url, from: this.#here }), {
          done: `Saved the source: ${short(reference.title)}.`,
          focus: "save-reference",
        });
        if (!result.ok) {
          refuse(result.message);
          this.#say(result.message);
        }
      });
      field.append(label, select, save);
      form.append(field);
    }
    form.append(error);
    form.addEventListener("submit", (event) => event.preventDefault());
    section.append(form);

    const list = el("ul", "ob-trail-list");
    list.setAttribute("aria-label", "Your saved sources");
    for (const source of document_.sources) list.append(this.#sourceItem(source));
    if (document_.sources.length === 0) section.append(el("p", "ob-trail-empty", "No sources saved yet."));
    else section.append(list);
    return section;
  }

  #sourceItem(source) {
    const item = el("li", "ob-trail-item");
    item.dataset.record = source.id;
    const link = source.url !== undefined ? el("a", undefined, source.title) : this.#workLink(source.work, source.title);
    if (source.url !== undefined) {
      link.href = source.url;
      link.rel = "noopener noreferrer";
    }
    const title = el("p", "ob-trail-title");
    title.append(link);
    item.append(title);
    const where = el("p", "ob-trail-meta");
    if (source.url !== undefined) {
      let host = source.url;
      try {
        host = new URL(source.url).host;
      } catch {
        // The contract has checked the link; the host is only a courtesy.
      }
      where.append(`Link to ${host}`);
      if (source.from) {
        where.append(" · Found in ");
        where.append(this.#workLink(source.from, this.#isHere(source.from) ? "this post" : source.from.path));
      }
    } else {
      where.append("A post");
    }
    item.append(where);
    item.append(
      this.#danger({
        key: `source:${source.id}`,
        label: "Remove",
        name: short(source.title),
        confirmLabel: "Confirm remove",
        onConfirm: () => {
          const result = this.#apply((current) => deleteSource(current, source.id), { done: "The source was removed.", focus: ["save-post"] });
          if (!result.ok) this.#fail(result.message);
        },
      }),
    );
    return item;
  }

  #works(document_) {
    const section = el("section", "ob-trail-section");
    section.setAttribute("aria-labelledby", `${this.#ui.id}-works`);
    section.append(this.#heading("Posts you have marked", `${this.#ui.id}-works`));
    const works = annotatedWorks(document_);
    if (works.length === 0) {
      section.append(el("p", "ob-trail-empty", "You have not highlighted or noted anything yet."));
      return section;
    }
    const list = el("ul", "ob-trail-list");
    list.setAttribute("aria-label", "Posts you have highlighted or noted");
    for (const entry of works) {
      const item = el("li", "ob-trail-item");
      const title = el("p", "ob-trail-title");
      title.append(this.#workLink(entry.work, this.#isHere(entry.work) ? `${entry.work.path} (this post)` : `${entry.work.site}${entry.work.path}`));
      const counts = [];
      if (entry.highlights) counts.push(plural(entry.highlights, "highlight"));
      if (entry.notes) counts.push(plural(entry.notes, "note"));
      item.append(title, el("p", "ob-trail-meta", counts.join(", ")));
      const key = `work:${entry.work.site}${entry.work.path}`;
      item.append(
        this.#danger({
          key,
          label: "Remove these highlights and notes",
          name: entry.work.path,
          confirmLabel: "Confirm remove",
          onConfirm: () => {
            const result = this.#apply((current) => deleteWorkAnnotations(current, entry.work), {
              done: `Removed ${counts.join(" and ")} on ${entry.work.path}.`,
              focus: [`${this.#ui.id}-works`],
            });
            if (!result.ok) this.#fail(result.message);
          },
        }),
      );
      list.append(item);
    }
    section.append(list);
    return section;
  }

  #trails(document_) {
    const section = el("section", "ob-trail-section");
    const headingId = `${this.#ui.id}-trails`;
    section.setAttribute("aria-labelledby", headingId);
    section.append(this.#heading("Your reading trails", headingId));
    section.append(el("p", "ob-trail-hint", "A trail is an ordered list you build yourself from saved sources and your highlights and notes."));

    const make = el("form", "ob-trail-form");
    make.noValidate = true;
    const field = el("div", "ob-trail-field");
    const input = el("input");
    input.type = "text";
    input.id = `${this.#ui.id}-trail-name`;
    input.maxLength = MAX_TITLE_CHARS;
    input.autocomplete = "off";
    input.value = this.#fields.name ?? "";
    input.addEventListener("input", () => (this.#fields.name = input.value));
    const label = el("label", undefined, "Name a new trail");
    label.htmlFor = input.id;
    const error = el("p", "ob-trail-error");
    error.id = `${this.#ui.id}-trail-error`;
    error.hidden = true;
    const start = el("button", undefined, "Start the trail");
    start.type = "submit";
    field.append(label, input, start);
    make.append(field, error);
    make.addEventListener("submit", (event) => {
      event.preventDefault();
      error.hidden = true;
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      const title = fitTitle(input.value);
      const refuse = (message) => {
        error.textContent = message;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", error.id);
        input.focus();
      };
      if (title === "") return refuse("Write a name for the trail first.");
      const result = this.#apply((current) => createTrail(current, { title }), { done: `Started the trail: ${short(title)}.`, focus: "trail-name" });
      if (!result.ok) return refuse(result.message);
      this.#fields.name = "";
      this.#trailChoice = result.id;
      this.#focus = "trail-name";
      this.#render();
    });
    input.dataset.focus = "trail-name";
    section.append(make);

    if (document_.trails.length > 0 && document_.sources.length + document_.annotations.length > 0) section.append(this.#addForm(document_));

    const trails = recentTrails(document_);
    if (trails.length === 0) {
      section.append(el("p", "ob-trail-empty", "No trails yet."));
      return section;
    }
    const list = el("ul", "ob-trail-list");
    list.setAttribute("aria-label", "Your trails, most recently changed first");
    for (const trail of trails) list.append(this.#trailItem(document_, trail));
    section.append(list);
    return section;
  }

  #addForm(document_) {
    const form = el("form", "ob-trail-form");
    form.noValidate = true;
    const id = this.#ui.id;
    const trailField = el("div", "ob-trail-field");
    const trailSelect = el("select");
    trailSelect.id = `${id}-add-trail`;
    const trailLabel = el("label", undefined, "Add to the trail");
    trailLabel.htmlFor = trailSelect.id;
    const trails = recentTrails(document_);
    for (const trail of trails) {
      const option = el("option", undefined, trail.title);
      option.value = trail.id;
      trailSelect.append(option);
    }
    if (this.#trailChoice && trails.some((trail) => trail.id === this.#trailChoice)) trailSelect.value = this.#trailChoice;
    trailField.append(trailLabel, trailSelect);

    const itemField = el("div", "ob-trail-field");
    const itemSelect = el("select");
    itemSelect.id = `${id}-add-item`;
    const itemLabel = el("label", undefined, "This source, highlight or note");
    itemLabel.htmlFor = itemSelect.id;
    itemField.append(itemLabel, itemSelect);

    const error = el("p", "ob-trail-error");
    error.id = `${id}-add-error`;
    error.hidden = true;
    const add = el("button", undefined, "Add to the trail");
    add.type = "submit";
    add.setAttribute("aria-describedby", error.id);

    const fill = () => {
      this.#trailChoice = trailSelect.value;
      const trail = document_.trails.find((each) => each.id === trailSelect.value);
      const inTrail = new Set(trail ? trail.steps.map((step) => step.ref) : []);
      itemSelect.replaceChildren();
      const group = (labelText, records) => {
        const wanted = records.filter((record) => !inTrail.has(record.id));
        if (wanted.length === 0) return;
        const optgroup = el("optgroup");
        optgroup.label = labelText;
        for (const record of wanted) {
          const option = el("option", undefined, this.#describe(record));
          option.value = record.id;
          optgroup.append(option);
        }
        itemSelect.append(optgroup);
      };
      group("Saved sources", document_.sources);
      group("Highlights and notes", document_.annotations);
      add.disabled = itemSelect.options.length === 0;
      if (itemSelect.options.length === 0) {
        const none = el("option", undefined, "Everything saved is already in this trail");
        none.value = "";
        itemSelect.append(none);
      }
    };
    trailSelect.addEventListener("change", fill);
    fill();
    form.append(trailField, itemField, add, error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!itemSelect.value) return;
      const ref = itemSelect.value;
      const trailId = trailSelect.value;
      const record = recordById(document_, ref);
      const result = this.#apply((current) => addTrailStep(current, trailId, ref), {
        done: `Added to the trail: ${short(record ? this.#describe(record) : "")}.`,
        focus: ["add-item", "add-trail"],
      });
      if (!result.ok) {
        error.textContent = result.message;
        error.hidden = false;
        this.#say(result.message);
      } else {
        this.#trailChoice = trailId;
      }
    });
    itemSelect.dataset.focus = "add-item";
    trailSelect.dataset.focus = "add-trail";
    return form;
  }

  #stepLabel(record) {
    if (record.kind === "source") {
      const link = el("a", undefined, record.title);
      if (record.url !== undefined) {
        link.href = record.url;
        link.rel = "noopener noreferrer";
      } else {
        link.href = `${record.work.site}${record.work.path}`;
      }
      return { kind: "Source", node: link, plain: record.title };
    }
    const quoted = record.target.kind === "quote";
    const words = quoted ? record.target.exact : record.target.kind === "section" ? "A section" : "The whole post";
    const shown = short(record.text !== undefined && !quoted ? record.text : words, 100);
    const link = this.#workLink(record.work, shown);
    return { kind: record.kind === "note" ? "Note" : "Highlight", node: link, plain: shown, work: record.work };
  }

  #trailItem(document_, trail) {
    const item = el("li", "ob-trail-item");
    item.dataset.record = trail.id;
    const title = el("h4", "ob-trail-title", trail.title);
    item.append(title);
    item.append(el("p", "ob-trail-meta", plural(trail.steps.length, "step")));
    if (trail.steps.length === 0) {
      item.append(el("p", "ob-trail-empty", "Nothing in this trail yet."));
    } else {
      const steps = el("ol", "ob-trail-steps");
      steps.setAttribute("aria-label", `Steps of ${short(trail.title, 60)}`);
      trail.steps.forEach((step, position) => {
        const record = recordById(document_, step.ref);
        if (!record) return;
        const label = this.#stepLabel(record);
        const row = el("li", "ob-trail-step");
        const text = el("p", "ob-trail-title");
        text.append(`${label.kind}: `, label.node);
        row.append(text);
        if (label.work) row.append(el("p", "ob-trail-meta", this.#isHere(label.work) ? "In this post" : `In ${label.work.site}${label.work.path}`));
        const name = short(label.plain, 50);
        const actions = el("div", "ob-trail-actions");
        const key = `step:${trail.id}:${step.ref}`;
        const mover = (direction, text_, disabled) => {
          const button = el("button", undefined, text_);
          button.type = "button";
          button.dataset.focus = `${key}:${direction}`;
          button.setAttribute("aria-label", `${text_}: ${name}`);
          button.disabled = disabled;
          button.addEventListener("click", () => {
            const result = this.#apply((current) => moveTrailStep(current, trail.id, step.ref, direction === "up" ? -1 : 1), {
              done: `Moved ${direction === "up" ? "earlier" : "later"}, to step ${position + (direction === "up" ? 0 : 2)} of ${trail.steps.length}.`,
              focus: [`${key}:${direction}`, `${key}:${direction === "up" ? "down" : "up"}`],
            });
            if (!result.ok) this.#fail(result.message);
          });
          return button;
        };
        const remove = el("button", undefined, "Remove from the trail");
        remove.type = "button";
        remove.dataset.focus = `${key}:remove`;
        remove.setAttribute("aria-label", `Remove from the trail: ${name}`);
        remove.addEventListener("click", () => {
          const next = trail.steps[position + 1] ?? trail.steps[position - 1];
          const result = this.#apply((current) => removeTrailStep(current, trail.id, step.ref), {
            done: "Removed from the trail. The source, highlight or note itself is kept.",
            focus: [next ? `step:${trail.id}:${next.ref}:remove` : `trail:${trail.id}:ask`, `${this.#ui.id}-trails`],
          });
          if (!result.ok) this.#fail(result.message);
        });
        actions.append(mover("up", "Move earlier", position === 0), mover("down", "Move later", position === trail.steps.length - 1), remove);
        row.append(actions);
        steps.append(row);
      });
      item.append(steps);
    }
    item.append(
      this.#danger({
        key: `trail:${trail.id}`,
        label: "Delete the trail",
        name: short(trail.title, 50),
        confirmLabel: "Confirm delete",
        onConfirm: () => {
          const result = this.#apply((current) => deleteTrail(current, trail.id), {
            done: "The trail was deleted. Its sources, highlights and notes are kept.",
            focus: ["trail-name"],
          });
          if (!result.ok) this.#fail(result.message);
        },
      }),
    );
    return item;
  }

  /** The works this page can check an imported passage against: only the post being read. */
  #knownWorks() {
    const passages = readPassages(document.getElementById(DATA_ELEMENT_ID)?.textContent);
    return passages ? { [workKey(this.#here)]: { revision: passages.revision, sections: passages.sections } } : {};
  }

  #counts(counts) {
    const parts = [plural(counts.highlights, "highlight"), plural(counts.notes, "note"), plural(counts.sources, "saved source"), plural(counts.trails, "trail")];
    if (counts.reflections > 0) parts.push(plural(counts.reflections, "reflection"));
    return parts.join(", ");
  }

  /** Export, import and the off switch, with a plain statement of what is kept in this browser. */
  #transfer(document_, off) {
    const id = this.#ui.id;
    const section = el("section", "ob-trail-section");
    section.setAttribute("aria-labelledby", `${id}-transfer`);
    section.append(this.#heading("Export, import and privacy", `${id}-transfer`));

    // What is kept, read from the browser each time so the statement can be checked.
    const keys = savedKeys(storage);
    const kept = el("p", "ob-trail-kept");
    if (this.#stored === "blocked" || keys === null) kept.textContent = "This browser does not allow saving here, so nothing from this feature is kept.";
    else if (this.#stored === "unreadable") kept.textContent = "Something is saved in this browser that this page cannot read. It is untouched; you can erase it below.";
    else {
      const counts = summarize(document_);
      const any = counts.highlights + counts.notes + counts.sources + counts.trails + counts.reflections > 0;
      kept.textContent = any ? `Kept in this browser: ${this.#counts(counts)}.` : "Kept in this browser: nothing.";
    }
    section.append(kept);
    section.append(el("p", "ob-trail-hint", `Browser storage used by this feature: ${keys && keys.length > 0 ? keys.join(", ") : "none"}. Nothing leaves the browser unless you download a file below.`));

    // Export.
    const exportBox = el("div", "ob-trail-form");
    exportBox.setAttribute("role", "group");
    exportBox.setAttribute("aria-labelledby", `${id}-export`);
    const exportHeading = el("h4", "ob-trail-subheading", "Export");
    exportHeading.id = `${id}-export`;
    exportBox.append(exportHeading);
    const choice = el("div", "ob-trail-field");
    const include = el("input");
    include.type = "checkbox";
    include.id = `${id}-export-notes`;
    include.checked = this.#exportNotes;
    include.dataset.focus = "export-notes";
    const includeLabel = el("label", undefined, "Include the text of my notes and source notes, and my private readings");
    includeLabel.htmlFor = include.id;
    choice.append(include, includeLabel);
    exportBox.append(choice);
    const readable = this.#stored === "ok" || this.#stored === "empty";
    const made = readable ? buildExport(document_, { notes: this.#exportNotes }) : null;
    const empty = made ? made.counts.highlights + made.counts.notes + made.counts.sources + made.counts.trails + made.counts.reflections === 0 : true;
    const describe = el("p", "ob-trail-meta");
    describe.id = `${id}-export-describe`;
    if (!made) describe.textContent = "Nothing can be exported because the saved data cannot be read.";
    else if (empty && made.omittedReflections > 0) {
      describe.textContent = `Nothing would be in the file: ${plural(made.omittedReflections, "reflection")} left out. Your private readings are only exported when you include the text of your notes and readings.`;
    } else if (empty) describe.textContent = "Nothing to export yet.";
    else {
      const left = made.omittedReflections > 0 ? `; ${plural(made.omittedReflections, "reflection")} left out` : "";
      const dropped = (made.omittedNotes > 0 ? `; ${plural(made.omittedNotes, "note")} on a section or the whole post would be dropped` : "") + left;
      describe.textContent = `The file will hold: ${this.#counts(made.counts)}, with ${plural(made.counts.steps, "trail step")} (${made.bytes.toLocaleString("en-US")} bytes). The words you highlighted are always in it. Your own notes are ${this.#exportNotes ? "included" : "left out"}${dropped}. It holds nothing else from this site, and nothing is uploaded.`;
    }
    include.setAttribute("aria-describedby", describe.id);
    include.addEventListener("change", () => {
      this.#exportNotes = include.checked;
      this.#focus = "export-notes";
      this.#render();
    });
    exportBox.append(describe);
    const download = el("button", undefined, "Download my reading trail");
    download.type = "button";
    download.dataset.focus = "download";
    download.disabled = !made || empty;
    download.setAttribute("aria-describedby", describe.id);
    download.addEventListener("click", () => {
      const fresh = readStore(storage);
      if (fresh.status !== "ok") return this.#say("Nothing was exported because the saved data could not be read.");
      const file = buildExport(fresh.document, { notes: this.#exportNotes });
      const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
      const link = el("a");
      link.href = url;
      link.download = file.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.#say(`Downloaded ${file.fileName}: ${this.#counts(file.counts)}. Notes ${file.notes ? "included" : "left out"}.`);
    });
    exportBox.append(download);
    if (made && !empty) {
      const details = el("details", "ob-trail-details");
      details.append(el("summary", undefined, "Show exactly what the file contains"));
      const pre = el("pre", "ob-trail-file");
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "The file contents");
      details.addEventListener("toggle", () => {
        pre.textContent = details.open ? made.text : "";
      });
      details.append(pre);
      exportBox.append(details);
    }
    section.append(exportBox);

    if (!off) section.append(this.#importBox());

    // The off switch.
    const offBox = el("div", "ob-trail-form");
    offBox.append(el("h4", "ob-trail-subheading", off ? "Turned off here" : "Turn off"));
    offBox.append(
      el(
        "p",
        "ob-trail-hint",
        off
          ? "Highlights, notes, saved sources and trails are turned off in this browser: nothing is marked in posts, shown or saved. What was saved before is kept until you erase it."
          : "Turn highlights, notes, saved sources and trails off in this browser. Nothing is marked in posts, shown or saved; what is already saved is kept until you erase it.",
      ),
    );
    const toggle = el("button", undefined, off ? "Turn highlights, notes and trails back on" : "Turn highlights, notes and trails off");
    toggle.type = "button";
    toggle.dataset.focus = "toggle-off";
    toggle.addEventListener("click", () => {
      const result = setDisabled(storage, !off);
      if (!result.ok) return this.#fail(FAILURES.blocked);
      this.#confirm = null;
      this.#import = null;
      this.#focus = "toggle-off";
      this.#reload();
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { from: this } }));
      this.#say(off ? "Highlights, notes and trails are on again." : "Highlights, notes and trails are off. Nothing saved was removed.");
    });
    offBox.append(toggle);
    section.append(offBox);
    return section;
  }

  #importBox() {
    const id = this.#ui.id;
    const box = el("div", "ob-trail-form");
    box.setAttribute("role", "group");
    box.setAttribute("aria-labelledby", `${id}-import`);
    const heading = el("h4", "ob-trail-subheading", "Import");
    heading.id = `${id}-import`;
    box.append(heading);
    box.append(el("p", "ob-trail-hint", "Choose a file you exported. You see what it would change first, and nothing is saved until you press Import. The file is read in this browser and not uploaded."));
    const field = el("div", "ob-trail-field");
    const input = el("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.id = `${id}-import-file`;
    input.dataset.focus = "import-file";
    const label = el("label", undefined, "Reading-trail file");
    label.htmlFor = input.id;
    field.append(label, input);
    const error = el("p", "ob-trail-error");
    error.id = `${id}-import-error`;
    error.hidden = this.#importError === null;
    error.textContent = this.#importError ?? "";
    input.setAttribute("aria-describedby", error.id);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      this.#importError = null;
      this.#import = null;
      if (file.size > MAX_IMPORT_BYTES) {
        this.#importError = "That file is larger than 4 MiB, so it was not read. Nothing was changed.";
      } else if (this.#stored === "unreadable" || this.#stored === "blocked") {
        this.#importError = this.#stored === "blocked" ? FAILURES.blocked : FAILURES.unreadable;
      } else {
        let text = null;
        try {
          text = await file.text();
        } catch {
          text = null;
        }
        if (text === null) this.#importError = "That file could not be read. Nothing was changed.";
        else {
          const name = Array.from(file.name, (character) => (character.codePointAt(0) < 0x20 ? " " : character)).join("");
          this.#import = { name: short(name, 60), size: file.size, text, choice: "keep" };
        }
      }
      this.#focus = this.#import ? `${id}-preview` : "import-file";
      this.#render();
      if (this.#importError) this.#say(this.#importError);
    });
    box.append(field, error);
    if (this.#import) box.append(this.#preview());
    return box;
  }

  #preview() {
    const id = this.#ui.id;
    const pending = this.#import;
    const plan = planImport(this.#document, pending.text, { choice: pending.choice, works: this.#knownWorks() });
    const wrap = el("div", "ob-trail-preview");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-labelledby", `${id}-preview`);
    const heading = el("h5", "ob-trail-subheading", `Import preview: ${pending.name}`);
    heading.id = `${id}-preview`;
    heading.tabIndex = -1;
    heading.dataset.focus = `${id}-preview`;
    wrap.append(heading);
    const cancel = el("button", undefined, "Cancel");
    cancel.type = "button";
    cancel.dataset.focus = "import-cancel";
    cancel.addEventListener("click", () => {
      this.#import = null;
      this.#importError = null;
      this.#focus = "import-file";
      this.#render();
      this.#say("Import cancelled. Nothing was changed.");
    });
    if (!plan.ok) {
      wrap.append(el("p", "ob-trail-error", "This file cannot be imported, so nothing was changed."));
      const list = el("ul", "ob-trail-list");
      for (const problem of plan.problems) {
        list.append(el("li", undefined, `${IMPORT_PROBLEMS[problem.code] ?? `The file breaks a rule (${problem.code}).`} (${short(problem.object, 80)})`));
      }
      wrap.append(list);
      if (plan.moreProblems > 0) wrap.append(el("p", "ob-trail-meta", `${plural(plan.moreProblems, "more problem")} not listed.`));
      wrap.append(cancel);
      return wrap;
    }
    const lines = el("ul", "ob-trail-list");
    const add = plan.added;
    lines.append(el("li", undefined, `Would add: ${plural(add.annotations, "highlight or note", "highlights and notes")}, ${plural(add.sources, "saved source")}, ${plural(add.trails, "trail")}, ${plural(add.reflections ?? 0, "private reading")}.`));
    const sameTotal = plan.same.annotations + plan.same.sources + plan.same.trails + (plan.same.reflections ?? 0);
    if (sameTotal > 0) lines.append(el("li", undefined, `${plural(sameTotal, "record")} already saved, left as is.`));
    if (plan.duplicates.length > 0) lines.append(el("li", undefined, `${plural(plan.duplicates.length, "record")} already saved under another id, not added again.`));
    if (plan.stale.length > 0) {
      lines.append(el("li", undefined, `${plural(plan.stale.length, "added highlight, note or private reading", "added highlights, notes and private readings")} on this post no longer ${plan.stale.length === 1 ? "matches" : "match"} its text. They would be kept and shown as not found.`));
    }
    if (plan.reanchored > 0) lines.append(el("li", undefined, `${plural(plan.reanchored, "added highlight, note or private reading", "added highlights, notes and private readings")} would be found again in changed text.`));
    if (plan.unchecked > 0) lines.append(el("li", undefined, `${plural(plan.unchecked, "added highlight, note or private reading", "added highlights, notes and private readings")} on other posts will be checked when you open those posts.`));
    if (plan.notes === "omitted") lines.append(el("li", undefined, "This file leaves out the text of notes."));
    wrap.append(lines);
    if (plan.conflicts.length > 0) {
      const set = el("fieldset", "ob-trail-choice");
      set.append(el("legend", undefined, `${plural(plan.conflicts.length, "record")} in the file ${plan.conflicts.length === 1 ? "has" : "have"} the same id as one you have but different content`));
      const radio = (value, text) => {
        const input = el("input");
        input.type = "radio";
        input.name = `${id}-conflict`;
        input.value = value;
        input.id = `${id}-conflict-${value}`;
        input.checked = pending.choice === value;
        input.dataset.focus = `conflict-${value}`;
        input.addEventListener("change", () => {
          pending.choice = value;
          this.#focus = `conflict-${value}`;
          this.#render();
        });
        const row = el("div", "ob-trail-field");
        const labelNode = el("label", undefined, text);
        labelNode.htmlFor = input.id;
        row.append(input, labelNode);
        return row;
      };
      set.append(radio("keep", "Keep what I have saved"), radio("file", "Use the file's version"));
      wrap.append(set);
    }
    const go = el("button", undefined, "Import");
    go.type = "button";
    go.dataset.focus = "import-go";
    go.disabled = !plan.changes;
    go.addEventListener("click", () => {
      this.#import = null;
      const result = this.#apply(
        (current) => {
          const fresh = planImport(current, pending.text, { choice: pending.choice, works: this.#knownWorks() });
          if (!fresh.ok) return { ok: false, problem: { code: fresh.problems[0]?.code ?? "malformed", object: "document", message: "" } };
          if (fresh.text !== plan.text) return { ok: false, problem: { code: "changed", object: "document", message: "" } };
          return { ok: true, document: fresh.document };
        },
        { done: `Imported. Now saved in this browser: ${this.#counts(plan.counts)}.`, focus: "import-file" },
      );
      if (!result.ok) {
        this.#import = pending;
        this.#importError = result.message;
        this.#focus = "import-cancel";
        this.#render();
        this.#say(result.message);
      } else {
        this.#importError = null;
      }
    });
    wrap.append(el("p", "ob-trail-meta", plan.changes ? `After the import: ${this.#counts(plan.counts)}.` : "Nothing in the file would change what is saved."));
    wrap.append(go, cancel);
    return wrap;
  }

  #clear() {
    const section = el("section", "ob-trail-section");
    section.setAttribute("aria-labelledby", `${this.#ui.id}-clear`);
    section.append(this.#heading("Clear everything", `${this.#ui.id}-clear`));
    section.append(
      el("p", "ob-trail-hint", "This removes every highlight, note, saved source and trail kept by this site in this browser, including anything this page could not read. It cannot be undone; export first if you want a copy."),
    );
    section.append(
      this.#danger({
        key: "clear-all",
        label: "Clear all my local data",
        name: "highlights, notes, sources and trails in this browser",
        confirmLabel: "Confirm clear everything",
        onConfirm: () => {
          const result = clearStore(storage);
          if (!result.ok) return this.#fail("This browser would not let the saved data be cleared, so nothing was changed.");
          this.#confirm = null;
          this.#focus = [`${this.#ui.id}-clear`];
          this.#reload();
          window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { from: this } }));
          this.#say("Everything was cleared from this browser.");
        },
      }),
    );
    return section;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ob-reading-trail")) {
  customElements.define("ob-reading-trail", ObReadingTrail);
}
