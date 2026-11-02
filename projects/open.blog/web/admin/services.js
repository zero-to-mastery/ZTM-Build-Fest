// The Services screen (ADR 0313, #511): each thing the business sells, written once. A list of the
// services under `#/services`, and a form for one (`#/services/new`, `#/services/edit/<path>`) with a name,
// an id, a summary, what is included, a price band, a typical timeline, a list of questions and answers, and
// the text that goes on the service's own page. It edits the `services/` collection through the same
// document routes posts, pages and series use; the server judges every file with the build's own rules and
// answers with the same kind of sentence, so a rule can never pass here and fail there.
//
// Designed at 400px first: one column, every control at least 44px tall, every label and message wraps.
// The pure functions at the top are the contract and are tested without a page.

import { el } from "./block-forms.js";
import { COST_BAND_LABELS } from "./job-form.js";

export const SERVICE_VERSION = 1;

export const LIMITS = Object.freeze({
  id: 60,
  name: 120,
  summary: 300,
  includes: 30,
  include: 160,
  timeline: 80,
  faq: 20,
  question: 200,
  answer: 1000,
});

// Keys the form owns; any other key in a file is carried through a save untouched.
const MANAGED = new Set(["version", "id", "name", "summary", "includes", "priceBand", "typicalTimeline", "draft"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

const clean = (value) => (typeof value === "string" ? value.trim() : "");
const plain = (value) => value !== "" && !CONTROL.test(value);
const sentence = (message) => {
  const text = String(message || "").trim();
  if (!text) return "";
  const capital = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** A service id for a name: lowercase letters, digits and hyphens, at most 60 characters. */
export function slugId(name) {
  return clean(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.id)
    .replace(/-+$/g, "");
}

export function isServiceId(value) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && value.length <= LIMITS.id && value !== "page";
}

export function blankService() {
  return { id: "", name: "", summary: "", includes: [], priceBand: "", typicalTimeline: "", faq: [], draft: false, body: "", extra: {} };
}

const list = (value) => {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  return text ? text.split(",").map(clean).filter(Boolean) : [];
};

/** The form for a stored document: its front matter fields (flattened `faq.<n>.question` keys) and its body. */
export function formFromDocument(fields = {}, body = "") {
  const form = blankService();
  const entries = new Map();
  for (const [key, value] of Object.entries(fields)) {
    const faq = /^faq\.(\d+)\.(question|answer)$/.exec(key);
    if (faq) {
      const entry = entries.get(Number(faq[1])) || { question: "", answer: "" };
      entry[faq[2]] = String(value ?? "");
      entries.set(Number(faq[1]), entry);
    } else if (!MANAGED.has(key) && !/^faq(\.|$)/.test(key)) {
      form.extra[key] = value;
    }
  }
  form.faq = [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  form.id = clean(fields.id);
  form.name = clean(fields.name);
  form.summary = clean(fields.summary);
  form.includes = list(fields.includes);
  form.priceBand = clean(fields.priceBand);
  form.typicalTimeline = clean(fields.typicalTimeline);
  form.draft = ["true", "yes", "on"].includes(clean(fields.draft).toLowerCase());
  form.body = typeof body === "string" ? body : "";
  return form;
}

const blankEntry = (entry) => clean(entry.question) === "" && clean(entry.answer) === "";

/** Positions in `form.faq` of the entries a save writes: an entry with neither question nor answer is dropped. */
export function faqSlots(form) {
  return form.faq.map((entry, index) => (blankEntry(entry) ? -1 : index)).filter((index) => index >= 0);
}

/** The front matter fields a save sends: the form's answers, then every key it does not own, as it was. */
export function fieldsFromForm(form) {
  const fields = { ...form.extra, version: String(SERVICE_VERSION), id: clean(form.id), name: clean(form.name), summary: clean(form.summary) };
  const includes = form.includes.map(clean).filter(Boolean);
  if (includes.length) fields.includes = includes;
  if (clean(form.priceBand)) fields.priceBand = clean(form.priceBand);
  if (clean(form.typicalTimeline)) fields.typicalTimeline = clean(form.typicalTimeline);
  if (form.draft) fields.draft = "true";
  faqSlots(form).forEach((index, position) => {
    fields[`faq.${position + 1}.question`] = clean(form.faq[index].question);
    fields[`faq.${position + 1}.answer`] = clean(form.faq[index].answer);
  });
  for (const key of Object.keys(fields)) if (fields[key] === "") delete fields[key];
  return fields;
}

/**
 * The problems the build would find, as `{ field, message, index?, part? }`. A draft is only held to
 * having an id (it names the file); the build warns about the rest and does not publish it.
 */
export function validateForm(form) {
  const problems = [];
  const add = (field, message, extra = {}) => problems.push({ field, message, ...extra });
  const id = clean(form.id);
  if (!id) add("id", "Add a short id, such as hardwood-install. Jobs use it to say which service they were.");
  else if (!isServiceId(id)) add("id", `Use lowercase letters, digits and hyphens, up to ${LIMITS.id} characters, and not "page".`);
  if (form.draft) return problems;

  const text = (field, value, max, label) => {
    const trimmed = clean(value);
    if (!trimmed) add(field, `Add the service's ${label}.`);
    else if (!plain(trimmed) || [...trimmed].length > max) add(field, `Use 1 to ${max} characters of plain text on one line.`);
  };
  text("name", form.name, LIMITS.name, "name");
  text("summary", form.summary, LIMITS.summary, "summary");

  const includes = form.includes.map(clean).filter(Boolean);
  if (includes.length > LIMITS.includes) add("includes", `List at most ${LIMITS.includes} things the service includes.`);
  else if (includes.some((item) => !plain(item) || [...item].length > LIMITS.include)) add("includes", `Each item needs 1 to ${LIMITS.include} characters of plain text.`);

  if (clean(form.priceBand) && !(clean(form.priceBand) in COST_BAND_LABELS)) add("priceBand", "Choose one of the price bands in the list.");
  const timeline = clean(form.typicalTimeline);
  if (timeline && (!plain(timeline) || [...timeline].length > LIMITS.timeline)) add("typicalTimeline", `Use up to ${LIMITS.timeline} characters of plain text, such as 2 to 3 days.`);

  const slots = faqSlots(form);
  if (slots.length > LIMITS.faq) add("faq", `List at most ${LIMITS.faq} questions.`);
  for (const index of slots) {
    const question = clean(form.faq[index].question);
    const answer = clean(form.faq[index].answer);
    if (!question) add("faq", "Add the question this answer is for.", { index, part: "question" });
    else if (!plain(question) || [...question].length > LIMITS.question) add("faq", `A question needs 1 to ${LIMITS.question} characters of plain text.`, { index, part: "question" });
    if (!answer) add("faq", "Add an answer.", { index, part: "answer" });
    else if (!plain(answer) || [...answer].length > LIMITS.answer) add("faq", `An answer needs 1 to ${LIMITS.answer} characters of plain text.`, { index, part: "answer" });
  }
  return problems;
}

const FIELD_NAMES = ["version", "id", "name", "summary", "includes", "priceBand", "typicalTimeline"];

/**
 * The server's problem sentences (`services/x.md: summary: ...; faq entry 2: add an answer`) as the same
 * `{ field, message, index?, part? }` the form produces. `slots` is `faqSlots(form)` for what was sent, because
 * the server counts only the entries that were written.
 */
export function problemsFromServer(items, slots = []) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item).replace(/^[^\s:]*\.md: /, "");
    for (const part of text.split(/; (?=(?:version|id|name|summary|includes|priceBand|typicalTimeline|faq entry \d+|faq): )/)) {
      const entry = /^faq entry (\d+): (.*)$/s.exec(part);
      if (entry) {
        const index = slots[Number(entry[1]) - 1];
        const message = sentence(entry[2]);
        const which = /question/.test(entry[2]) && !/answer/.test(entry[2]) ? "question" : /answer/.test(entry[2]) && !/question/.test(entry[2]) ? "answer" : "";
        out.push({ field: "faq", message, ...(index === undefined ? {} : { index }), ...(which ? { part: which } : {}) });
        continue;
      }
      const named = /^([A-Za-z]+): (.*)$/s.exec(part);
      if (named && (FIELD_NAMES.includes(named[1]) || named[1] === "faq")) {
        out.push({ field: named[1] === "version" ? "" : named[1], message: sentence(named[2]) });
      } else {
        out.push({ field: "", message: sentence(part) });
      }
    }
  }
  return out;
}

const ERROR_TEXT = Object.freeze({
  413: "That is too much to save. Shorten the longest entries and try again.",
  401: "You were signed out. Sign in again, then save.",
});

export function serviceErrorText(error) {
  const status = error?.status;
  if (ERROR_TEXT[status]) return ERROR_TEXT[status];
  if (status === 409) return "This service changed in another window or by someone else. Reload it, then make your changes again.";
  const detail = String(error?.data?.error || error?.message || "").trim();
  return detail ? `The service was not saved. ${detail}` : "The service was not saved. Check your connection and try again.";
}

export const PRICE_BAND_CHOICES = Object.freeze(Object.entries(COST_BAND_LABELS));

let uid = 0;

/**
 * `route` is what follows `#/services/`: nothing for the list, `new`, or `edit/<encoded path>`. `onSaved(path)`
 * runs after a first save gives a new service its address; `onLeave(hash)` after a delete.
 */
export function createServices({ api, route = "", onSaved = () => {}, onLeave = () => {} }) {
  const id = `oba-svc-${++uid}`;
  const editPath = route.startsWith("edit/") ? decodeURIComponent(route.slice(5)) : "";
  const listing = !route;
  let path = editPath;
  let form = blankService();
  let snapshot = "";
  let etag = "";
  let busy = false;
  let destroyed = false;
  let idTouched = Boolean(editPath);

  const root = el("div", { class: "oba-business oba-services", "data-services-screen": listing ? "list" : "form" });
  const status = el("p", { class: "oba-small oba-business-status", role: "status", "aria-live": "polite", "data-services-status": "true" });
  const say = (message, kind = "small") => {
    status.className = `oba-business-status oba-${kind === "error" ? "error" : kind === "ok" ? "ok" : "small"}`;
    status.setAttribute("role", kind === "error" ? "alert" : "status");
    status.textContent = message;
  };
  const isDirty = () => !listing && JSON.stringify([fieldsFromForm(form), form.body]) !== snapshot;

  // ----- problems, shown beside their fields

  const clearProblems = () => {
    for (const slot of root.querySelectorAll("[data-problem-for]")) {
      slot.hidden = true;
      slot.textContent = "";
    }
    for (const control of root.querySelectorAll("[aria-invalid]")) control.removeAttribute("aria-invalid");
  };
  const showProblems = (problems) => {
    clearProblems();
    let first = null;
    const loose = [];
    for (const item of problems) {
      const key = item.field === "faq" && item.index !== undefined ? `faq-${item.index}` : item.field;
      const slot = key ? root.querySelector(`[data-problem-for="${key}"]`) : null;
      if (!slot) {
        loose.push(item.message);
        continue;
      }
      slot.hidden = false;
      slot.textContent = slot.textContent ? `${slot.textContent} ${item.message}` : item.message;
      const control =
        (item.part && root.querySelector(`[data-service-field="faq-${item.index}-${item.part}"]`)) ||
        root.querySelector(`[data-service-field="${key}"]`) ||
        root.querySelector(`[data-service-field="${key}-question"]`);
      control?.setAttribute("aria-invalid", "true");
      first ||= control;
    }
    if (loose.length) say(loose.join(" "), "error");
    return first;
  };

  // ----- controls

  const changed = () => {
    dirtyNote.textContent = isDirty() ? "You have unsaved changes." : "All changes saved.";
    if (status.textContent && status.getAttribute("role") !== "alert") status.textContent = "";
  };
  const slot = (key, control, label, help) => {
    const problem = el("p", { class: "oba-error oba-business-problem", id: `${id}-${key}-error`, hidden: true, "data-problem-for": key });
    const helpId = help ? `${id}-${key}-help` : null;
    control.setAttribute("aria-describedby", [helpId, problem.id].filter(Boolean).join(" "));
    control.setAttribute("data-service-field", key);
    return el("div", { class: "oba-field" }, label, help ? el("p", { class: "oba-help", id: helpId }, help) : null, control, problem);
  };
  const text = (key, label, { help, maxlength, readonly = false, autocapitalize } = {}) => {
    const control = el("input", { id: `${id}-${key}`, type: "text", name: key, maxlength, value: form[key] ?? "", readonly, autocomplete: "off", autocapitalize });
    const onInput = () => {
      form[key] = control.value;
      if (key === "id") idTouched = true;
      if (key === "name" && !idTouched) {
        form.id = slugId(control.value);
        const idControl = root.querySelector('[data-service-field="id"]');
        if (idControl) idControl.value = form.id;
      }
      changed();
    };
    control.addEventListener("input", onInput);
    return slot(key, control, el("label", { for: control.id }, label), help);
  };
  const area = (key, label, { help, maxlength, rows = 3 } = {}) => {
    const control = el("textarea", { id: `${id}-${key}`, name: key, rows, maxlength, value: form[key] ?? "" });
    control.addEventListener("input", () => {
      form[key] = control.value;
      changed();
    });
    return slot(key, control, el("label", { for: control.id }, label), help);
  };
  const priceBand = () => {
    const control = el("select", { id: `${id}-priceBand`, name: "priceBand" }, el("option", { value: "" }, "Do not show a price"), ...PRICE_BAND_CHOICES.map(([value, label]) => el("option", { value }, label)));
    if (form.priceBand && !(form.priceBand in COST_BAND_LABELS)) control.append(el("option", { value: form.priceBand }, form.priceBand));
    control.value = form.priceBand;
    control.addEventListener("change", () => {
      form.priceBand = control.value;
      changed();
    });
    return slot("priceBand", control, el("label", { for: control.id }, "Starting price band"), "A guide for customers, shown in words. It is never a quote, and nothing is calculated from it.");
  };

  // Rows of one repeated thing: move up, move down and remove, each at least 44px and each named.
  const tools = (noun, index, count, move, remove) =>
    el("div", { class: "oba-services-tools" },
      el("button", { class: "oba-btn", type: "button", disabled: index === 0, "aria-label": `Move ${noun} ${index + 1} up`, "data-action": "service-up", onClick: () => move(index, index - 1) }, "Up"),
      el("button", { class: "oba-btn", type: "button", disabled: index === count - 1, "aria-label": `Move ${noun} ${index + 1} down`, "data-action": "service-down", onClick: () => move(index, index + 1) }, "Down"),
      el("button", { class: "oba-btn", type: "button", "aria-label": `Remove ${noun} ${index + 1}`, "data-action": "service-remove", onClick: () => remove(index) }, "Remove"),
    );
  const shift = (items, from, to) => {
    if (to < 0 || to >= items.length) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
  };

  const includesGroup = () => {
    const rows = el("ul", { class: "oba-services-rows", "data-service-includes": "true" });
    const add = el("button", { class: "oba-btn", type: "button", "data-action": "service-add-include", onClick: () => {
      form.includes.push("");
      draw(form.includes.length - 1);
      changed();
    } }, "Add an item");
    const draw = (focus) => {
      rows.replaceChildren(
        ...form.includes.map((item, index) => {
          const input = el("input", { type: "text", value: item, maxlength: LIMITS.include, autocomplete: "off", "aria-label": `Included item ${index + 1}`, "data-service-field": `include-${index}` });
          input.addEventListener("input", () => {
            form.includes[index] = input.value;
            changed();
          });
          return el("li", { class: "oba-services-row", "data-include": String(index) }, input,
            tools("included item", index, form.includes.length,
              (from, to) => { shift(form.includes, from, to); draw(to); changed(); },
              (at) => { form.includes.splice(at, 1); draw(Math.min(at, form.includes.length - 1)); changed(); }));
        }),
      );
      add.disabled = form.includes.length >= LIMITS.includes;
      if (typeof focus === "number" && focus >= 0) rows.querySelectorAll("input")[focus]?.focus();
      else if (focus === -1) add.focus();
    };
    draw();
    const problem = el("p", { class: "oba-error oba-business-problem", hidden: true, "data-problem-for": "includes" });
    return el("fieldset", { class: "oba-business-group", "data-service-group": "includes" }, el("legend", {}, "What is included"),
      el("p", { class: "oba-help" }, "One short line for each thing a customer gets, such as Removing the old floor."), rows, add, problem);
  };

  const faqGroup = () => {
    const rows = el("ol", { class: "oba-services-rows oba-services-faq", "data-service-faq": "true" });
    const add = el("button", { class: "oba-btn", type: "button", "data-action": "service-add-question", onClick: () => {
      form.faq.push({ question: "", answer: "" });
      draw(form.faq.length - 1);
      changed();
    } }, "Add a question");
    const draw = (focus) => {
      rows.replaceChildren(
        ...form.faq.map((entry, index) => {
          const question = el("input", { id: `${id}-faq-${index}-q`, type: "text", value: entry.question, maxlength: LIMITS.question, autocomplete: "off", "data-service-field": `faq-${index}-question` });
          const answer = el("textarea", { id: `${id}-faq-${index}-a`, rows: 3, maxlength: LIMITS.answer, value: entry.answer, "data-service-field": `faq-${index}-answer` });
          question.addEventListener("input", () => { entry.question = question.value; changed(); });
          answer.addEventListener("input", () => { entry.answer = answer.value; changed(); });
          const problem = el("p", { class: "oba-error oba-business-problem", id: `${id}-faq-${index}-error`, hidden: true, "data-problem-for": `faq-${index}` });
          question.setAttribute("aria-describedby", problem.id);
          answer.setAttribute("aria-describedby", problem.id);
          return el("li", { class: "oba-services-row", "data-faq-entry": String(index) },
            el("fieldset", { class: "oba-services-entry" }, el("legend", {}, `Question ${index + 1}`),
              el("div", { class: "oba-field" }, el("label", { for: question.id }, "Question"), question),
              el("div", { class: "oba-field" }, el("label", { for: answer.id }, "Answer"), answer),
              problem,
              tools("question", index, form.faq.length,
                (from, to) => { shift(form.faq, from, to); draw(to); changed(); },
                (at) => { form.faq.splice(at, 1); draw(Math.min(at, form.faq.length - 1)); changed(); })),
          );
        }),
      );
      add.disabled = form.faq.length >= LIMITS.faq;
      if (typeof focus === "number" && focus >= 0) rows.querySelectorAll("li")[focus]?.querySelector("input")?.focus();
      else if (focus === -1) add.focus();
    };
    draw();
    const problem = el("p", { class: "oba-error oba-business-problem", hidden: true, "data-problem-for": "faq" });
    return el("fieldset", { class: "oba-business-group", "data-service-group": "faq" }, el("legend", {}, "Questions customers ask"),
      el("p", { class: "oba-help" }, "Each question and answer shows on the service's page. When there is at least one, search engines are told about them too."), rows, add, problem);
  };

  const draftBox = () => {
    const control = el("input", { id: `${id}-draft`, type: "checkbox", name: "draft", checked: form.draft, "data-service-field": "draft" });
    control.addEventListener("change", () => {
      form.draft = control.checked;
      changed();
    });
    return el("div", { class: "oba-field" },
      el("label", { class: "oba-business-check", for: control.id }, control, " Keep this as a draft"),
      el("p", { class: "oba-help" }, "A draft is not on your site. Untick it when the service is ready."));
  };

  // ----- the form

  const dirtyNote = el("span", { class: "oba-small oba-business-dirty", "data-services-dirty": "true" });
  const saveButton = el("button", { class: "oba-btn oba-btn-primary", type: "submit", "data-action": "service-save" }, "Save service");
  const conflict = el("div", { class: "oba-notice oba-business-conflict", hidden: true, "data-services-conflict": "true" });
  const formElement = el("form", { class: "oba-business-form", novalidate: true, "data-service-form": "true", "aria-label": "Service", onSubmit: (event) => { event.preventDefault(); save(); } });

  const build = () => {
    const isNew = !path;
    const actions = el("div", { class: "oba-business-actions" }, saveButton, dirtyNote);
    formElement.replaceChildren(
      el("fieldset", { class: "oba-business-group", "data-service-group": "about" }, el("legend", {}, "About this service"),
        text("name", "Name", { help: "What customers call it, such as Hardwood floor installation.", maxlength: LIMITS.name }),
        text("id", "Id", { help: isNew ? "Short, lowercase, with hyphens. Jobs use it to say which service they were, and it is the end of the page's address." : "The id names this service's file and page address, so it cannot be changed here. Add a new service to use another id.", maxlength: LIMITS.id, readonly: !isNew, autocapitalize: "none" }),
        area("summary", "Summary", { help: "One sentence that says what you do. It leads the page and the search result.", maxlength: LIMITS.summary, rows: 3 }),
      ),
      includesGroup(),
      el("fieldset", { class: "oba-business-group", "data-service-group": "price" }, el("legend", {}, "Price and time"),
        priceBand(),
        text("typicalTimeline", "Typical timeline", { help: "A short phrase, such as 2 to 4 days.", maxlength: LIMITS.timeline }),
      ),
      faqGroup(),
      el("fieldset", { class: "oba-business-group", "data-service-group": "body" }, el("legend", {}, "About this service, in your words"),
        area("body", "Page text", { help: "Optional. Ordinary Markdown: it appears on the service's page under what is included.", rows: 8 })),
      draftBox(),
      actions,
    );
    if (!isNew) {
      formElement.append(deleteArea());
    }
    changed();
  };

  const deleteArea = () => {
    const ask = el("button", { class: "oba-btn", type: "button", "data-action": "service-delete" }, "Delete this service");
    const confirmBox = el("div", { class: "oba-notice", hidden: true, "data-services-delete-confirm": "true" },
      el("p", {}, "Move this service to the trash? Its page leaves your site; the file is kept in .openblog/trash."),
      el("div", { class: "oba-business-actions" },
        el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "service-delete-yes", onClick: () => remove() }, "Yes, delete it"),
        el("button", { class: "oba-btn", type: "button", "data-action": "service-delete-no", onClick: () => { confirmBox.hidden = true; ask.hidden = false; ask.focus(); } }, "Keep it")));
    ask.addEventListener("click", () => {
      ask.hidden = true;
      confirmBox.hidden = false;
      confirmBox.querySelector("button")?.focus();
    });
    return el("div", { class: "oba-business-actions oba-services-delete" }, ask, confirmBox);
  };

  // ----- load, save, delete

  const showConflict = () => {
    conflict.hidden = false;
    conflict.replaceChildren(
      el("p", {}, serviceErrorText({ status: 409 })),
      el("button", { class: "oba-btn", type: "button", "data-action": "service-reload", onClick: async () => {
        conflict.hidden = true;
        await load();
        say("Loaded the latest version.", "ok");
      } }, "Reload this service"),
    );
  };

  const adopt = (document) => {
    etag = document.etag || "";
    form = formFromDocument(document.fields || {}, document.body || "");
    snapshot = JSON.stringify([fieldsFromForm(form), form.body]);
    build();
  };

  async function loadList() {
    const result = await api.call("GET", "documents?kind=services");
    const items = Array.isArray(result.items) ? result.items : [];
    root.replaceChildren(
      status,
      el("section", { class: "oba-contributor-intro" }, el("p", {}, "Describe each thing you sell once: what it includes, a price band, how long it usually takes and the questions customers ask. Each service gets its own page on your site, and a job can say which service it was.")),
      el("div", { class: "oba-business-actions" }, el("a", { class: "oba-btn oba-btn-primary", href: "#/services/new", "data-action": "service-new" }, "Add a service")),
      items.length
        ? el("ul", { class: "oba-services-list", "data-services-list": "true" },
            items.map((item) =>
              el("li", { class: "oba-services-item", "data-service-row": item.path },
                item.status === "error"
                  ? el("span", {}, `${item.path}: ${item.error || "Invalid front matter"}`)
                  : el("a", { href: `#/services/edit/${encodeURIComponent(item.path)}` }, item.title || item.path),
                item.status === "draft" ? el("span", { class: "oba-badge oba-badge-draft" }, "draft") : null)),
          )
        : el("p", { class: "oba-small", "data-services-empty": "true" }, "No services yet. Add your first one, for example the work you are asked for most."),
    );
  }

  async function loadForm() {
    if (!path) {
      form = blankService();
      snapshot = JSON.stringify([fieldsFromForm(form), form.body]);
      etag = "";
      build();
      return;
    }
    const document = await api.call("GET", `document?path=${encodeURIComponent(path)}`);
    if (document.error) {
      root.replaceChildren(el("p", { class: "oba-error", role: "alert" }, `${path} cannot be edited here: ${document.error}`), el("a", { class: "oba-btn", href: "#/services" }, "Back to services"));
      return;
    }
    adopt(document);
  }

  async function load() {
    root.setAttribute("aria-busy", "true");
    try {
      if (listing) await loadList();
      else await loadForm();
    } catch (error) {
      if (error?.status === 401) throw error;
      say(error?.status === 404 ? "That service was not found." : serviceErrorText(error), "error");
    } finally {
      root.removeAttribute("aria-busy");
    }
  }

  async function save() {
    if (busy) return false;
    clearProblems();
    const problems = validateForm(form);
    if (problems.length) {
      say(`${problems.length === 1 ? "One thing needs fixing" : `${problems.length} things need fixing`} before this can be saved.`, "error");
      showProblems(problems)?.focus?.();
      return false;
    }
    busy = true;
    saveButton.disabled = true;
    say("Saving…");
    try {
      const sent = structuredClone(form);
      const payload = { fields: fieldsFromForm(sent), body: sent.body, etag, kind: "services" };
      const result = path
        ? await api.call("PUT", `document?path=${encodeURIComponent(path)}`, { json: payload })
        : await api.call("POST", "document", { json: payload });
      if (destroyed) return false;
      const wasNew = !path;
      path = result.path;
      etag = result.etag;
      snapshot = JSON.stringify([payload.fields, payload.body]);
      conflict.hidden = true;
      if (wasNew) {
        build();
        onSaved(path);
      }
      changed();
      if (result.build && result.build.ok === false) say(`Saved, but your site could not be rebuilt yet: ${result.build.error}`, "error");
      else say(sent.draft ? "Draft saved. It is not on your site yet." : "Saved. Your service page, the services list and search data now use it. Make your site live to publish it.", "ok");
      return true;
    } catch (error) {
      if (destroyed) return false;
      if (error?.status === 409) {
        showConflict();
        say(serviceErrorText(error), "error");
      } else if (error?.status === 422 && Array.isArray(error.data?.problems)) {
        say("The server found something to fix.", "error");
        showProblems(problemsFromServer(error.data.problems, faqSlots(form)))?.focus?.();
      } else say(serviceErrorText(error), "error");
      return false;
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  }

  async function remove() {
    if (busy || !path) return false;
    busy = true;
    try {
      await api.call("DELETE", `document?path=${encodeURIComponent(path)}`);
      if (destroyed) return true;
      snapshot = JSON.stringify([fieldsFromForm(form), form.body]);
      onLeave("#/services");
      return true;
    } catch (error) {
      say(serviceErrorText(error), "error");
      return false;
    } finally {
      busy = false;
    }
  }

  if (!listing) root.append(
    el("section", { class: "oba-contributor-intro" }, el("p", {}, "This is one service. Its page, the services list and the structured data search engines read are all made from what you write here. Customers can see everything you add, and nothing about customers belongs in it.")),
    el("p", {}, el("a", { href: "#/services", "data-action": "service-back" }, "All services")),
    status,
    conflict,
    formElement,
  );
  else root.append(status);

  return {
    element: root,
    load,
    save,
    isDirty,
    isBusy: () => busy,
    destroy: () => {
      destroyed = true;
    },
  };
}
