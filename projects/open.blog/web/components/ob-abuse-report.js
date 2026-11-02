// Abuse reports (ADR 0107): a small, progressive form a reader opens under a public comment or a
// published reader note to tell the author it is abusive. A report is private and anonymous: it is
// never published or counted, it changes nothing by itself, and nothing about the reader is sent
// beyond the ground they choose and what they write. The page is complete without this script:
// <ob-abuse-report> keeps its static text, which tells the reader how to write to the author.
//
// Untrusted text is only ever assigned through textContent.

export const REPORT_GROUNDS = Object.freeze([
  ["spam", "Spam"],
  ["abusive", "Abusive"],
  ["personal-data", "It shares someone’s personal data"],
  ["off-topic", "Off topic"],
  ["rights", "It uses someone’s work without permission"],
  ["other", "Something else"],
]);
export const MAX_REPORT_CHARS = 1000;
const SEND_TIMEOUT = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let counter = 0;

/** What a reader is told after sending a report, from the hosted answer. */
export function reportOutcome(status) {
  if (status === 202) return { ok: true, message: "Thank you. Your report was sent to the author, who reviews every report. It is not published." };
  if (status === 404) return { ok: false, message: "This can no longer be reported here. You can still write to the author." };
  if (status === 429) return { ok: false, message: "Too many reports have come from here recently. Please try again later." };
  if (status === 422) return { ok: false, message: "Choose why you are reporting it, and write at most 1,000 characters." };
  if (status === 0) return { ok: false, message: "Your report could not be sent: the service did not answer. You can write to the author instead." };
  return { ok: false, message: "Your report could not be sent. You can write to the author instead." };
}

/**
 * A disclosure with the report form for one item. `source` is "comment" or "feedback", `id` the
 * item's id and `subject` how the summary names it ("this comment").
 */
export function reportForm({ endpoint, source, id, subject = "this item" }) {
  counter += 1;
  const prefix = `ob-abuse-report-${counter}`;
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const details = make("details", "ob-abuse-report-form");
  details.append(make("summary", undefined, `Report ${subject}`));
  const form = make("form");
  form.noValidate = true;
  const grounds = make("fieldset");
  grounds.append(make("legend", undefined, "Why are you reporting it?"));
  const radios = REPORT_GROUNDS.map(([value, label], index) => {
    const radio = make("input");
    radio.type = "radio";
    radio.name = `${prefix}-ground`;
    radio.value = value;
    radio.id = `${prefix}-ground-${index}`;
    const labelElement = make("label", undefined, label);
    labelElement.htmlFor = radio.id;
    const row = make("div", "ob-abuse-report-choice");
    row.append(radio, " ", labelElement);
    grounds.append(row);
    return radio;
  });
  const groundError = make("p", "ob-abuse-report-error");
  groundError.id = `${prefix}-ground-error`;
  groundError.hidden = true;
  grounds.append(groundError);
  const note = make("textarea");
  note.id = `${prefix}-note`;
  note.rows = 3;
  note.maxLength = MAX_REPORT_CHARS;
  const noteLabel = make("label", undefined, "Anything the author should know (optional)");
  noteLabel.htmlFor = note.id;
  const hint = make("p", "ob-abuse-report-hint", "Reports are private and anonymous. They are never published or counted and change nothing by themselves; the author reviews each one. Don’t include your name or contact details.");
  hint.id = `${prefix}-hint`;
  note.setAttribute("aria-describedby", hint.id);
  const submit = make("button", undefined, "Send report");
  submit.type = "submit";
  const status = make("p", "ob-abuse-report-status");
  status.setAttribute("role", "status");
  status.tabIndex = -1;
  form.append(grounds, noteLabel, note, hint, submit);
  details.append(form, status);

  let sending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;
    const chosen = radios.find((radio) => radio.checked);
    groundError.hidden = true;
    for (const radio of radios) radio.removeAttribute("aria-invalid");
    if (!chosen) {
      groundError.textContent = "Choose why you are reporting it.";
      groundError.hidden = false;
      radios[0].setAttribute("aria-invalid", "true");
      radios[0].setAttribute("aria-describedby", groundError.id);
      status.textContent = groundError.textContent;
      radios[0].focus();
      return;
    }
    if (Array.from(note.value.trim()).length > MAX_REPORT_CHARS) {
      status.textContent = "Write at most 1,000 characters.";
      note.focus();
      return;
    }
    sending = true;
    submit.setAttribute("aria-disabled", "true");
    form.setAttribute("aria-busy", "true");
    status.textContent = "Sending your report…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT);
    let code = 0;
    try {
      if (globalThis.navigator?.onLine === false) throw new Error("offline");
      const response = await fetch(`${endpoint}/reports`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, id, ground: chosen.value, ...(note.value.trim() ? { body: note.value.trim() } : {}) }),
        signal: controller.signal,
      });
      code = response.status;
    } catch {
      code = 0;
    } finally {
      clearTimeout(timer);
      sending = false;
      submit.removeAttribute("aria-disabled");
      form.removeAttribute("aria-busy");
    }
    const outcome = reportOutcome(code);
    status.textContent = outcome.message;
    if (outcome.ok) {
      form.hidden = true;
    }
    status.focus();
  });
  return details;
}

/** <ob-abuse-report endpoint source item subject>: the report form for one published item. */
export class ObAbuseReport extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    const endpoint = (this.getAttribute("endpoint") || "").replace(/\/$/, "");
    const source = this.getAttribute("source");
    const id = this.getAttribute("item") || "";
    if (!/^https:\/\//.test(endpoint) || !["comment", "feedback"].includes(source) || !UUID.test(id)) return;
    this.dataset.ready = "true";
    this.replaceChildren(reportForm({ endpoint, source, id, subject: this.getAttribute("subject") || "this item" }));
  }
}

if (!customElements.get("ob-abuse-report")) customElements.define("ob-abuse-report", ObAbuseReport);
