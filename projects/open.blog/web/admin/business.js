// The Business facts screen (ADR 0307, #508): your name, phone, hours, license and insurance, set once
// under Site and used by the footer, the home page and search engines. One column from 320px, every
// control at least 44px tall, a native control for every choice (a select for each day, real time
// inputs, checkboxes), and every problem said beside the field it is about in plain words. The server
// judges the block again and answers with the same kind of problem, so a rule can never pass here and
// fail there.
//
// The pure functions at the top are the contract and are tested without a page.

import { el } from "./block-forms.js";

export const WEEKDAYS = Object.freeze([
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
]);

export const PAYMENT_METHODS = Object.freeze([
  ["cash", "Cash"],
  ["check", "Check"],
  ["credit-card", "Credit card"],
  ["debit-card", "Debit card"],
  ["bank-transfer", "Bank transfer"],
  ["mobile-payment", "Mobile payment"],
  ["financing", "Financing"],
]);

export const DAY_MODES = Object.freeze([
  ["unset", "Not shown"],
  ["open", "Open"],
  ["allday", "Open 24 hours"],
  ["closed", "Closed"],
]);

export const FIRST_YEAR = 1800;
export const LAST_YEAR = 2100;
const TEXT_FIELDS = ["displayName", "legalName", "trade", "phone", "email", "licenseNumber", "licenseIssuer"];
const MAX_LINE = 120;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** The form for a stored block: everything the owner can see and change, and nothing else. */
export function formFromBusiness(business) {
  const stored = isObject(business) ? business : {};
  const hours = {};
  for (const [day] of WEEKDAYS) {
    const value = isObject(stored.hours) ? stored.hours[day] : null;
    if (isObject(value) && value.closed === true) hours[day] = { mode: "closed", open: "08:00", close: "17:00" };
    else if (isObject(value) && value.open === "00:00" && value.close === "24:00") hours[day] = { mode: "allday", open: "08:00", close: "17:00" };
    else if (isObject(value) && typeof value.open === "string" && typeof value.close === "string") hours[day] = { mode: "open", open: value.open, close: value.close };
    else hours[day] = { mode: "unset", open: "08:00", close: "17:00" };
  }
  const form = { insured: stored.insured === true, foundedYear: Number.isInteger(stored.foundedYear) ? String(stored.foundedYear) : "", paymentMethods: Array.isArray(stored.paymentMethods) ? stored.paymentMethods.filter((id) => PAYMENT_METHODS.some(([known]) => known === id)) : [], hours };
  for (const field of TEXT_FIELDS) form[field] = clean(stored[field]);
  return form;
}

/** Turns what a person types into the stored phone form: separators dropped, ten digits read as a US or Canada number. */
export function normalizePhone(input) {
  const trimmed = clean(input);
  if (!trimmed) return "";
  if (!/^[0-9+\s().-]+$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

/** `(360) 555-0142` for a US or Canada number, the stored form otherwise: what the site will show. */
export function formatPhone(phone) {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

/** The block to send: only what is stated, in the stored shape. */
export function businessFromForm(form) {
  const business = {};
  for (const field of TEXT_FIELDS) {
    const value = field === "phone" ? normalizePhone(form[field]) : clean(form[field]);
    if (value) business[field] = field === "trade" ? value.toLowerCase() : value;
  }
  if (form.insured) business.insured = true;
  const year = clean(form.foundedYear);
  if (year) business.foundedYear = /^\d+$/.test(year) ? Number(year) : year;
  if (form.paymentMethods?.length) business.paymentMethods = PAYMENT_METHODS.map(([id]) => id).filter((id) => form.paymentMethods.includes(id));
  const hours = {};
  for (const [day] of WEEKDAYS) {
    const row = form.hours?.[day];
    if (!row) continue;
    if (row.mode === "closed") hours[day] = { closed: true };
    else if (row.mode === "allday") hours[day] = { open: "00:00", close: "24:00" };
    else if (row.mode === "open") hours[day] = { open: row.open, close: row.close };
  }
  if (Object.keys(hours).length) business.hours = hours;
  return business;
}

export function sameBusiness(a, b) {
  return JSON.stringify(businessFromForm(a)) === JSON.stringify(businessFromForm(b));
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Every problem with the form, each with the field (and day) it belongs to, in words an owner can act on. */
export function validateForm(form) {
  const problems = [];
  const add = (field, message, day) => problems.push({ field, message, ...(day ? { day } : {}) });
  for (const field of ["displayName", "legalName"]) {
    if (clean(form[field]).length > MAX_LINE) add(field, `Keep this to ${MAX_LINE} characters or fewer.`);
  }
  const phone = normalizePhone(form.phone);
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) add("phone", "Add the country code and the digits, like +1 360 555 0142. A US or Canada number with its area code works too.");
  const email = clean(form.email);
  if (email && (email.length > 254 || !EMAIL.test(email) || email.includes(".."))) add("email", "Type one email address, like office@example.com.");
  if (clean(form.licenseNumber).length > 40) add("licenseNumber", "Keep the license number to 40 characters or fewer.");
  if (clean(form.licenseIssuer).length > 80) add("licenseIssuer", "Keep this to 80 characters or fewer.");
  if (clean(form.licenseIssuer) && !clean(form.licenseNumber)) add("licenseIssuer", "Add the license number that goes with this issuer, or clear the issuer.");
  const year = clean(form.foundedYear);
  if (year && (!/^\d{4}$/.test(year) || Number(year) < FIRST_YEAR || Number(year) > LAST_YEAR)) add("foundedYear", `Type a four-digit year between ${FIRST_YEAR} and ${LAST_YEAR}.`);
  for (const [day, label] of WEEKDAYS) {
    const row = form.hours?.[day];
    if (row?.mode !== "open") continue;
    if (!CLOCK.test(row.open || "") || !CLOCK.test(row.close || "")) add("hours", `${label}: choose both an opening and a closing time.`, day);
    else if (row.close <= row.open) add("hours", `${label}: closing time must be after the opening time. For a day that runs all night, choose Open 24 hours.`, day);
  }
  return problems;
}

/** Copy one day's setting onto other days, as a new form. */
export function copyDay(form, from, to) {
  const source = form.hours?.[from];
  if (!source) return form;
  const hours = { ...form.hours };
  for (const day of to) hours[day] = { ...source };
  return { ...form, hours };
}

const ERROR_TEXT = Object.freeze({
  413: "That is too much to save. Shorten the longest entries and try again.",
  401: "You were signed out. Sign in again, then save.",
});

export function businessErrorText(error) {
  const status = error?.status;
  if (ERROR_TEXT[status]) return ERROR_TEXT[status];
  if (status === 409) return "These facts changed in another window or by someone else. Reload them, then make your changes again.";
  const detail = String(error?.data?.error || error?.message || "").trim();
  return detail ? `The facts were not saved. ${detail}` : "The facts were not saved. Check your connection and try again.";
}

let uid = 0;

export function createBusinessFacts({ api }) {
  const id = `oba-biz-${++uid}`;
  let form = formFromBusiness({});
  let saved = formFromBusiness({});
  let etag = "";
  let choices = { trades: [], weekdays: WEEKDAYS };
  let busy = false;
  let destroyed = false;

  const root = el("div", { class: "oba-business", "data-business-screen": "true" });
  const status = el("p", { class: "oba-small oba-business-status", role: "status", "aria-live": "polite", "data-business-status": "true" });
  const conflict = el("div", { class: "oba-notice oba-business-conflict", hidden: true, "data-business-conflict": "true" });
  const form_ = el("form", { class: "oba-business-form", novalidate: true, "aria-label": "Business facts", onSubmit: (event) => { event.preventDefault(); save(); } });
  const saveButton = el("button", { class: "oba-btn oba-btn-primary", type: "submit", "data-action": "business-save" }, "Save business facts");
  const dirtyNote = el("span", { class: "oba-small oba-business-dirty", "data-business-dirty": "true" });

  const say = (message, kind = "small") => {
    status.className = `oba-business-status oba-${kind === "error" ? "error" : kind === "ok" ? "ok" : "small"}`;
    status.setAttribute("role", kind === "error" ? "alert" : "status");
    status.textContent = message;
  };

  // ----- controls, each with its own place for a problem

  const refs = new Map();
  const slot = (key, control, label, help, wrapper = "div") => {
    const errorId = `${id}-${key}-error`;
    const helpId = help ? `${id}-${key}-help` : null;
    const problem = el("p", { class: "oba-error oba-business-problem", id: errorId, hidden: true, "data-problem-for": key });
    control.setAttribute?.("aria-describedby", [helpId, errorId].filter(Boolean).join(" "));
    refs.set(key, { control, problem });
    return el(wrapper, { class: "oba-field" }, label, help ? el("p", { class: "oba-help", id: helpId }, help) : null, control, problem);
  };
  const input = (key, label, { type = "text", help, inputmode, autocomplete, maxlength } = {}) => {
    const control = el("input", { id: `${id}-${key}`, type, name: key, inputmode, autocomplete, maxlength, value: form[key] ?? "" });
    const onChange = () => {
      form[key] = control.value;
      changed();
    };
    control.addEventListener("input", onChange);
    control.addEventListener("change", onChange);
    return slot(key, control, el("label", { for: control.id }, label), help);
  };
  const trade = () => {
    const control = el("select", { id: `${id}-trade`, name: "trade" }, el("option", { value: "" }, "Choose your trade"), ...choices.trades.map((value) => el("option", { value }, value.replace(/-/g, " "))));
    control.value = form.trade;
    control.addEventListener("change", () => {
      form.trade = control.value;
      changed();
    });
    return slot("trade", control, el("label", { for: control.id }, "Your trade"), "Search engines use this to describe your business, for example as a plumber or a roofing contractor.");
  };
  const insured = () => {
    const control = el("input", { id: `${id}-insured`, type: "checkbox", name: "insured", checked: form.insured });
    control.addEventListener("change", () => {
      form.insured = control.checked;
      changed();
    });
    const problem = el("p", { class: "oba-error oba-business-problem", id: `${id}-insured-error`, hidden: true, "data-problem-for": "insured" });
    control.setAttribute("aria-describedby", `${id}-insured-help ${problem.id}`);
    refs.set("insured", { control, problem });
    return el("div", { class: "oba-field" },
      el("label", { for: control.id, class: "oba-business-check" }, control, " We are insured"),
      el("p", { class: "oba-help", id: `${id}-insured-help` }, "With a license number this shows a Licensed and insured badge. It is your statement; open.blog does not check it."),
      problem,
    );
  };
  const payments = () => {
    const boxes = PAYMENT_METHODS.map(([value, label]) => {
      const box = el("input", { id: `${id}-pay-${value}`, type: "checkbox", name: "paymentMethods", value, checked: form.paymentMethods.includes(value) });
      box.addEventListener("change", () => {
        form.paymentMethods = PAYMENT_METHODS.map(([known]) => known).filter((known) => (known === value ? box.checked : form.paymentMethods.includes(known)));
        changed();
      });
      return el("label", { class: "oba-business-check", for: box.id }, box, ` ${label}`);
    });
    const group = el("fieldset", { class: "oba-business-group", "data-business-group": "paymentMethods" }, el("legend", {}, "Ways customers can pay"), ...boxes);
    const problem = el("p", { class: "oba-error oba-business-problem", id: `${id}-paymentMethods-error`, hidden: true, "data-problem-for": "paymentMethods" });
    refs.set("paymentMethods", { control: group, problem });
    return el("div", { class: "oba-field" }, group, problem);
  };

  // ----- hours: one small group per day

  const dayRows = new Map();
  const hours = () => {
    const days = WEEKDAYS.map(([day, label]) => {
      const row = form.hours[day];
      const select = el("select", { id: `${id}-hours-${day}`, name: `hours-${day}`, "data-day": day }, ...DAY_MODES.map(([value, text]) => el("option", { value }, text)));
      select.value = row.mode;
      const open = el("input", { id: `${id}-open-${day}`, type: "time", value: row.open, "data-day": day, "data-which": "open" });
      const close = el("input", { id: `${id}-close-${day}`, type: "time", value: row.close, "data-day": day, "data-which": "close" });
      const times = el("div", { class: "oba-business-times", hidden: row.mode !== "open" },
        el("label", { for: open.id }, el("span", {}, "Opens"), open),
        el("label", { for: close.id }, el("span", {}, "Closes"), close),
      );
      const problem = el("p", { class: "oba-error oba-business-problem", id: `${id}-hours-${day}-error`, hidden: true, "data-problem-for": `hours-${day}` });
      const apply = () => {
        form.hours[day] = { mode: select.value, open: open.value, close: close.value };
        times.hidden = select.value !== "open";
        changed();
      };
      for (const control of [select, open, close]) {
        control.addEventListener("input", apply);
        control.addEventListener("change", apply);
        control.setAttribute("aria-describedby", problem.id);
      }
      dayRows.set(day, { select, open, close, times, problem });
      return el("fieldset", { class: "oba-business-day", "data-business-day": day }, el("legend", {}, label), el("div", { class: "oba-business-day-row" }, el("label", { class: "oba-business-day-mode", for: select.id }, el("span", {}, "Hours"), select), times), problem);
    });
    const weekdays = ["tuesday", "wednesday", "thursday", "friday"];
    const copy = el("button", { class: "oba-btn oba-business-copy", type: "button", "data-action": "business-copy-monday", onClick: () => {
      form = copyDay(form, "monday", weekdays);
      for (const day of weekdays) {
        const row = form.hours[day];
        const ref = dayRows.get(day);
        ref.select.value = row.mode;
        ref.open.value = row.open;
        ref.close.value = row.close;
        ref.times.hidden = row.mode !== "open";
      }
      changed();
      say("Monday's hours are now on Tuesday to Friday. Not saved yet.");
    } }, "Copy Monday to Tuesday through Friday");
    const hint = el("p", { class: "oba-help" }, "Leave a day as Not shown if you would rather not say. Choose Closed to say you are closed that day.");
    return el("fieldset", { class: "oba-business-group oba-business-hours", "data-business-group": "hours" }, el("legend", {}, "Opening hours"), hint, copy, ...days);
  };

  const changed = () => {
    dirtyNote.textContent = isDirty() ? "You have unsaved changes." : "All changes saved.";
    if (status.textContent && status.getAttribute("role") !== "alert") status.textContent = "";
  };

  // ----- problems, shown beside their fields

  const clearProblems = () => {
    for (const { control, problem } of refs.values()) {
      problem.hidden = true;
      problem.textContent = "";
      control.removeAttribute?.("aria-invalid");
    }
    for (const { problem, select, open, close } of dayRows.values()) {
      problem.hidden = true;
      problem.textContent = "";
      for (const control of [select, open, close]) control.removeAttribute("aria-invalid");
    }
  };
  /** Show every problem and put focus on the first control that has one. */
  const showProblems = (problems) => {
    clearProblems();
    let first = null;
    for (const item of problems) {
      const dayRef = item.field === "hours" && item.day ? dayRows.get(item.day) : null;
      const ref = dayRef ? { control: dayRef.select, problem: dayRef.problem } : refs.get(item.field);
      if (!ref) continue;
      ref.problem.hidden = false;
      ref.problem.textContent = ref.problem.textContent ? `${ref.problem.textContent} ${item.message}` : item.message;
      ref.control.setAttribute?.("aria-invalid", "true");
      first ||= ref.control;
    }
    const unplaced = problems.filter((item) => !(item.field === "hours" && item.day ? dayRows.get(item.day) : refs.get(item.field)));
    if (unplaced.length) say(unplaced.map((item) => item.message).join(" "), "error");
    return first;
  };

  const isDirty = () => !sameBusiness(form, saved);

  // ----- build the form from what the server sent

  const build = () => {
    refs.clear();
    dayRows.clear();
    form_.replaceChildren(
      el("fieldset", { class: "oba-business-group", "data-business-group": "name" }, el("legend", {}, "Who you are"),
        input("displayName", "Name customers know you by", { help: "Shown in the footer and in search results.", autocomplete: "organization", maxlength: MAX_LINE }),
        input("legalName", "Legal name", { help: "Optional. Use it when it differs, for example Maple Falls Flooring LLC.", maxlength: MAX_LINE }),
        trade(),
        input("foundedYear", "Year you started", { type: "text", inputmode: "numeric", help: "Optional, four digits.", maxlength: 4 }),
      ),
      el("fieldset", { class: "oba-business-group", "data-business-group": "contact" }, el("legend", {}, "How to reach you"),
        el("p", { class: "oba-help" }, "These are published on your site. Only add what you want customers to see."),
        input("phone", "Phone", { type: "tel", inputmode: "tel", autocomplete: "tel", help: "Type it the way you would say it. We keep it with the country code, like +13605550142." }),
        input("email", "Email", { type: "email", inputmode: "email", autocomplete: "email" }),
      ),
      hours(),
      el("fieldset", { class: "oba-business-group", "data-business-group": "trust" }, el("legend", {}, "License and insurance"),
        input("licenseNumber", "License number", { maxlength: 40 }),
        input("licenseIssuer", "Who issued it", { help: "For example your state licensing board. Needs a license number.", maxlength: 80 }),
        insured(),
      ),
      payments(),
      el("div", { class: "oba-business-actions" }, saveButton, dirtyNote),
    );
    changed();
  };

  // ----- load and save

  const apply = (result) => {
    etag = result.etag;
    choices = { trades: Array.isArray(result.trades) ? result.trades : [], weekdays: result.weekdays || WEEKDAYS };
    saved = formFromBusiness(result.business);
    form = formFromBusiness(result.business);
    build();
    if (Array.isArray(result.problems) && result.problems.length) {
      say("The facts saved on your site have a problem. Fix it and save again.", "error");
      showProblems(result.problems);
    }
  };

  const showConflict = () => {
    conflict.hidden = false;
    conflict.replaceChildren(
      el("p", {}, businessErrorText({ status: 409 })),
      el("button", { class: "oba-btn", type: "button", "data-action": "business-reload", onClick: async () => {
        conflict.hidden = true;
        conflict.replaceChildren();
        await load();
        say("Loaded the latest facts.", "ok");
      } }, "Reload the latest facts"),
    );
  };

  async function load() {
    root.setAttribute("aria-busy", "true");
    try {
      apply(await api.call("GET", "business"));
    } catch (error) {
      if (error?.status === 401) throw error;
      say(businessErrorText(error), "error");
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
      const result = await api.call("PUT", "business", { json: { etag, business: businessFromForm(sent) } });
      if (destroyed) return false;
      etag = result.etag;
      saved = formFromBusiness(result.business);
      // Typed phones become E.164 on the server; show the stored form, but never undo edits made while saving.
      if (sameBusiness(form, sent)) {
        form = formFromBusiness(result.business);
        build();
      }
      conflict.hidden = true;
      if (result.buildError) say(`Saved, but your site could not be rebuilt yet: ${result.buildError}`, "error");
      else say("Saved. Your footer, home page and search data now use these facts. Make your site live to publish them.", "ok");
      return true;
    } catch (error) {
      if (destroyed) return false;
      if (error?.status === 409) {
        showConflict();
        say(businessErrorText(error), "error");
      } else if (error?.status === 422 && Array.isArray(error.data?.problems)) {
        say("The server found something to fix.", "error");
        showProblems(error.data.problems)?.focus?.();
      } else say(businessErrorText(error), "error");
      return false;
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  }

  root.append(
    el("section", { class: "oba-contributor-intro" }, el("p", {}, "Say who you are once. Your footer, your home page and search engines all use these facts, so nothing on your site can disagree with itself. Customers can see everything you add here, and nothing about customers is ever kept in it.")),
    status,
    conflict,
    form_,
  );

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
