// The Job form in the Write view (ADR 0287): the few questions a job needs, written as the flattened
// `job.*` front matter keys the engine already validates. The form never owns the body: the four
// scaffold headings are ordinary Markdown placed once into an empty draft. The first half of this file
// is plain functions (tested in tests/web/admin-job-form.test.mjs); the second builds the form.

import { el } from "./block-forms.js";

export const JOB_PROFILE = "job";

const KEY = {
  trade: "job.trade",
  service: "job.service",
  town: "job.place.town",
  region: "job.place.region",
  started: "job.started",
  finished: "job.finished",
  costBand: "job.costBand",
  before: "job.media.before",
  after: "job.media.after",
};

export const COST_BAND_LABELS = {
  "under-500": "Under $500",
  "500-2k": "$500 to $2,000",
  "2k-10k": "$2,000 to $10,000",
  "10k-50k": "$10,000 to $50,000",
  "over-50k": "Over $50,000",
  ask: "Ask for a quote",
};

const text = (value) => (value === undefined || value === null ? "" : String(value).trim());
const list = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : []);

/** The form's answers, read from the post's front matter fields. */
export function readJobDraft(fields = {}) {
  return {
    trade: text(fields[KEY.trade]).toLowerCase(),
    service: text(fields[KEY.service]),
    town: text(fields[KEY.town]),
    region: text(fields[KEY.region]),
    started: text(fields[KEY.started]),
    finished: text(fields[KEY.finished]),
    costBand: text(fields[KEY.costBand]),
    before: list(fields[KEY.before]),
    after: list(fields[KEY.after]),
  };
}

/** The fields with the form's answers written in. Keys the form does not ask about (hours, materials, review) are left alone. */
export function applyJobDraft(fields, draft) {
  const next = { ...fields };
  for (const [name, key] of Object.entries(KEY)) {
    const value = draft[name];
    const empty = Array.isArray(value) ? value.length === 0 : text(value) === "";
    if (empty) delete next[key];
    else next[key] = Array.isArray(value) ? [...value] : text(value);
  }
  return next;
}

/** A body is empty enough to take the scaffold when it holds nothing but space. */
export function bodyTakesScaffold(markdown) {
  return text(markdown) === "";
}

/** Today in the writer's own calendar, as `YYYY-MM-DD`. */
export function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A date input only holds a plain day; anything else is shown empty and kept until the writer picks one. */
export function dayValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : "";
}

let uid = 0;

/**
 * `meta` is the Admin `job` block (trades, costBands, services, scaffold). `upload(file)` resolves to the
 * stored address or null. `check(fields)` resolves to the build's own problem sentences.
 * Returns `{ element, draft(), setVisible(on), prefillDates(), scaffold() }`.
 */
export function buildJobForm({ fields, meta = {}, upload, check, onChange = () => {} }) {
  const id = `oba-job-${++uid}`;
  const state = readJobDraft(fields);
  const touch = () => onChange(state);

  const status = el("p", { class: "oba-small oba-job-status", role: "status", "aria-live": "polite" });
  const problems = el("ul", { class: "oba-job-problems" });

  const field = (name, label, control, help) =>
    el("div", { class: "oba-field" }, el("label", { for: `${id}-${name}` }, label), control, help ? el("p", { class: "oba-help" }, help) : null);

  const trades = [...(meta.trades || [])];
  const tradeSelect = el("select", { id: `${id}-trade`, "data-job-field": "trade" }, el("option", { value: "" }, "Choose a trade"));
  if (state.trade && !trades.includes(state.trade)) trades.push(state.trade);
  for (const trade of trades) tradeSelect.append(el("option", { value: trade, selected: trade === state.trade }, trade));
  tradeSelect.value = state.trade;
  tradeSelect.addEventListener("change", () => { state.trade = tradeSelect.value; touch(); });

  const serviceList = el("datalist", { id: `${id}-services` }, (meta.services || []).map((service) => el("option", { value: service })));
  const serviceInput = el("input", { id: `${id}-service`, type: "text", list: `${id}-services`, value: state.service, autocomplete: "off", autocapitalize: "none", spellcheck: "false", "data-job-field": "service" });
  serviceInput.addEventListener("input", () => { state.service = serviceInput.value; touch(); });

  const plain = (name, autocomplete) => {
    const input = el("input", { id: `${id}-${name}`, type: "text", value: state[name], autocomplete, "data-job-field": name });
    input.addEventListener("input", () => { state[name] = input.value; touch(); });
    return input;
  };
  const townInput = plain("town", "off");
  const regionInput = plain("region", "off");

  const dayInput = (name) => {
    const input = el("input", { id: `${id}-${name}`, type: "date", value: dayValue(state[name]), "data-job-field": name });
    input.addEventListener("input", () => { state[name] = input.value; touch(); });
    return input;
  };
  const startedInput = dayInput("started");
  const finishedInput = dayInput("finished");

  const bandSelect = el("select", { id: `${id}-costBand`, "data-job-field": "costBand" }, el("option", { value: "" }, "Do not show a price"));
  for (const band of meta.costBands || Object.keys(COST_BAND_LABELS)) {
    bandSelect.append(el("option", { value: band, selected: band === state.costBand }, COST_BAND_LABELS[band] || band));
  }
  bandSelect.value = state.costBand;
  bandSelect.addEventListener("change", () => { state.costBand = bandSelect.value; touch(); });

  const photos = (name, label) => {
    const items = el("ul", { class: "oba-job-photos", "aria-label": `${label} photos` });
    const picker = el("input", { id: `${id}-${name}-file`, type: "file", accept: "image/*", multiple: true, "data-job-photos": name });
    const render = () => {
      items.replaceChildren(
        ...state[name].map((address, index) =>
          el(
            "li",
            {},
            el("span", { class: "oba-job-photo-name" }, address.split("/").pop() || address),
            el("button", {
              type: "button",
              class: "oba-btn",
              "aria-label": `Remove ${label.toLowerCase()} photo ${index + 1}: ${address.split("/").pop() || address}`,
              onClick: () => {
                state[name].splice(index, 1);
                render();
                touch();
                picker.focus();
              },
            }, "Remove"),
          ),
        ),
      );
    };
    picker.addEventListener("change", async () => {
      const files = [...picker.files];
      picker.value = "";
      for (const file of files) {
        status.textContent = `Uploading ${file.name}…`;
        const address = await upload(file);
        if (address) state[name].push(address);
      }
      status.textContent = files.length ? `Added ${files.length} ${label.toLowerCase()} photo${files.length === 1 ? "" : "s"}.` : "";
      render();
      touch();
    });
    render();
    return el(
      "fieldset",
      { class: "oba-fieldset oba-job-group", "data-job-group": name },
      el("legend", { class: "oba-legend" }, `${label} photos`),
      items,
      el("label", { for: `${id}-${name}-file`, class: "oba-job-add" }, `Add ${label.toLowerCase()} photos`),
      picker,
    );
  };

  const checkButton = el("button", { type: "button", class: "oba-btn", "data-job-check": "true" }, "Check this job");
  checkButton.addEventListener("click", async () => {
    status.textContent = "Checking…";
    problems.replaceChildren();
    try {
      const result = await check(applyJobDraft({}, state));
      problems.replaceChildren(...result.map((sentence) => el("li", {}, sentence)));
      status.textContent = result.length
        ? `${result.length} thing${result.length === 1 ? "" : "s"} to fix before this job can be published.`
        : "This job has everything it needs to publish.";
    } catch (error) {
      status.textContent = error.message;
    }
  });

  const element = el(
    "section",
    { class: "oba-job-form", "data-job-form": "true", "aria-labelledby": `${id}-heading`, hidden: true },
    el("h3", { id: `${id}-heading`, class: "oba-job-heading" }, "About this job"),
    field("trade", "Trade", tradeSelect),
    field("service", "Service", serviceInput, "A short id such as hardwood-install."),
    field("town", "Town", townInput, "A town only, never a street address."),
    field("region", "Region or state", regionInput),
    field("started", "Started", startedInput),
    field("finished", "Finished", finishedInput),
    field("costBand", "Price range", bandSelect, "A public signal, never a quote."),
    serviceList,
    photos("before", "Before"),
    photos("after", "After"),
    checkButton,
    status,
    problems,
  );

  return {
    element,
    draft: () => state,
    setVisible(on) {
      element.hidden = !on;
    },
    /** A new job starts on today's date; an answered date is never replaced. */
    prefillDates(now = new Date()) {
      const today = localDay(now);
      let changed = false;
      for (const [name, input] of [["started", startedInput], ["finished", finishedInput]]) {
        if (!state[name]) {
          state[name] = today;
          input.value = today;
          changed = true;
        }
      }
      if (changed) touch();
    },
    scaffold: () => meta.scaffold || "",
  };
}
