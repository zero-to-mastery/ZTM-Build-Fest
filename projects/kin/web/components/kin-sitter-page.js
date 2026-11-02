// For you (#441, #448, ADR 0017): the page a Temporary member (a babysitter,
// carer or guest) lands on. It shows what the family chose, live: a short
// intro, then notes, reference records (phone numbers as tap-to-call links)
// and routines with today's state. It is a layout, not a lock: the household's
// other pages stay reachable as the Temporary policy allows.

import { phoneHref, resolveEntries } from "../sitter-view.js";

const CADENCE = { daily: "Every day", weekdays: "Weekdays", weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month" };
class KinSitterPage extends HTMLElement {
  constructor() {
    super();
    this.page = null;
    this.state = null;
    this.preview = false;
  }

  connectedCallback() {
    this.render();
  }

  /** `{ page: { intro, entries }, state, preview }`. */
  update({ page, state, preview = false }) {
    this.page = page;
    this.state = state;
    this.preview = preview;
    this.render();
  }

  render() {
    const parts = [];
    if (this.preview) {
      const note = document.createElement("p");
      note.className = "section-hint sitter-preview-note";
      note.textContent = "This is what a babysitter or guest sees first. It isn't a lock: their device can read the household while their access lasts.";
      parts.push(note);
    }
    if (!this.page) {
      const loading = document.createElement("p");
      loading.className = "empty-state";
      loading.textContent = "Loading…";
      parts.push(loading);
      this.replaceChildren(...parts);
      return;
    }
    if (this.page.intro) {
      const intro = document.createElement("p");
      intro.className = "sitter-intro";
      intro.textContent = this.page.intro;
      parts.push(intro);
    }
    const entries = resolveEntries(this.page, this.state);
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "The family hasn't added anything here yet.";
      parts.push(empty);
    }
    for (const entry of entries) parts.push(this.card(entry));
    this.replaceChildren(...parts);
  }

  card({ kind, record }) {
    const card = document.createElement("section");
    card.className = `sitter-card sitter-${kind}`;
    const heading = document.createElement("h2");
    card.append(heading);
    if (kind === "note") {
      heading.textContent = record.title;
      if (record.body) {
        const body = document.createElement("p");
        body.className = "sitter-body";
        body.textContent = record.body;
        card.append(body);
      }
    } else if (kind === "reference-record") {
      heading.textContent = record.title;
      const list = document.createElement("dl");
      list.className = "sitter-fields";
      for (const field of record.fields ?? []) {
        const term = document.createElement("dt");
        term.textContent = field.label;
        const value = document.createElement("dd");
        const href = phoneHref(field.value);
        if (href) {
          const link = document.createElement("a");
          link.href = href;
          link.className = "sitter-call";
          link.textContent = field.value;
          link.setAttribute("aria-label", `Call ${field.label}: ${field.value}`);
          value.append(link);
        } else {
          value.textContent = field.value;
        }
        list.append(term, value);
      }
      card.append(list);
    } else {
      heading.textContent = record.text;
      const status = document.createElement("p");
      status.className = "sitter-routine";
      status.textContent = [CADENCE[record.cadence] ?? "Repeats",
        record.occurrenceStatus === "completed" ? "Done for now" : record.occurrenceStatus === "open" ? "Still to do" : null].filter(Boolean).join(" · ");
      card.append(status);
    }
    return card;
  }
}

if (!customElements.get("kin-sitter-page")) customElements.define("kin-sitter-page", KinSitterPage);
