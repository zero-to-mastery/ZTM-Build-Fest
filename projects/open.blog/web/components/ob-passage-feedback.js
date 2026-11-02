// <ob-passage-feedback> turns a post's feedback region into a form for a
// question, a suggested source, a suggested correction or another
// interpretation of a passage (ADR 0082). The page is complete without it:
// the region's static text tells a reader how to send a note to the author.
//
// The passage is the whole post, a section, or words the reader selected in
// the post. A selection is mapped onto the passage text the build published
// in <script type="application/json" id="ob-passages"> (ADR 0076): the
// selected string is normalized and found in that section's build text, and
// the page's DOM is used only to tell which section the selection is in and,
// when the words occur more than once, which occurrence. The article itself is
// never changed, marked or hidden.
//
// A submission is checked by the shared validator (passage-feedback.js) and
// sent to the hosted function's /feedback route. When it cannot be sent
// (offline, the service off or failing), the reader gets the same note as
// plain text to copy and send to the author, and nothing they wrote is lost.
// Nothing is stored in the browser.
//
// A suggested source or correction may also name what it is about (ADR 0116):
// a published claim, an evidence link on it or a source the post cites, and a
// source the site publishes with where in it the reader looked, and how the
// reader says it bears on the passage. The choices are only what the build
// published in <script type="application/json" id="ob-evidence-references">,
// so a reader never types an id and nothing private is ever listed or
// confirmed. The block is the reader's statement; nothing checks or counts it.
//
// Every piece of state is a private field, so nothing here can shadow one of
// HTMLElement's own properties.

import { readTarget } from "./passage-target.js";
import { DATA_ELEMENT_ID, SUPPORTED_VERSION, isText, locateSelection, quoteFromSelection, readPassages, selectionProblem } from "./passage-selection.js";

// The selection helpers moved to passage-selection.js, where the reader's own highlights share them.
export { DATA_ELEMENT_ID, SUPPORTED_VERSION, locateSelection, quoteFromSelection, readPassages };
import {
  EVIDENCE_KINDS,
  EVIDENCE_STANCES,
  FEEDBACK_KINDS,
  LOCATOR_KINDS,
  canonicalTime,
  feedbackCopyText,
  isCanonicalTime,
  isPublicId,
  readFeedbackSubmissionJson,
  readSubmissionJson,
  submissionValue,
} from "./passage-feedback.js";
import { isReceipt, receiptManager, receiptPanel } from "./feedback-receipt.js";

export const EVIDENCE_ELEMENT_ID = "ob-evidence-references";
// Far beyond any site's published sources; anything larger is not read at all.
const MAX_EVIDENCE_DATA_LENGTH = 2_000_000;
const SEND_TIMEOUT = 20_000;
// Mail programs refuse long links; a longer note is pasted instead.
const MAX_MAIL_LINK = 1800;
// Kept clear of the viewport's edges, in CSS pixels.
const GUTTER = 8;
const GAP = 8;


/**
 * The kinds a post's form offers, from its `kinds` attribute (the ids the participation policy has
 * open on the post, ADR 0101), in the registry's order. No attribute offers every kind; an
 * attribute naming no kind this version knows offers none, so the static text stays.
 */
export function offeredKinds(attribute) {
  const all = Object.keys(FEEDBACK_KINDS);
  if (attribute === null || attribute === undefined) return all;
  const named = new Set(String(attribute).split(/\s+/).filter(Boolean));
  return all.filter((kind) => named.has(kind));
}

const choice = (value) => value && typeof value === "object" && isPublicId(value.id) && isText(value.label) && value.label !== "";

/**
 * What the build says a reader may name in an evidence offer: { claims: [{ id, label, links: [{
 * id, label }] }], citations: [{ id, label }], sources: [{ id, label }] }, or null when there is
 * no such data, it cannot be read or its version is newer than this component knows. A malformed
 * entry makes the whole list unusable, so nothing half-read is offered.
 */
export function readEvidenceChoices(text) {
  if (!isText(text) || text.length > MAX_EVIDENCE_DATA_LENGTH) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.version !== 1) return null;
  const list = (value) => (Array.isArray(value) && value.every(choice) ? value.map(({ id, label }) => Object.freeze({ id, label })) : null);
  const citations = list(data.citations);
  const sources = list(data.sources);
  if (!Array.isArray(data.claims) || !citations || !sources) return null;
  const claims = [];
  for (const claim of data.claims) {
    const links = choice(claim) ? list(claim.links) : null;
    if (!links) return null;
    claims.push(Object.freeze({ id: claim.id, label: claim.label, links: Object.freeze(links) }));
  }
  return Object.freeze({ claims: Object.freeze(claims), citations: Object.freeze(citations), sources: Object.freeze(sources) });
}

const STANCE_LABELS = Object.freeze({ supports: "It supports the passage", contradicts: "It contradicts the passage", contextualizes: "It gives context to the passage" });

const KIND_HINTS = Object.freeze({
  question: "Ask what a passage means, how it was reached or where it comes from.",
  "source-suggestion": "Suggest a source that bears on the passage. A link to it is required.",
  "correction-suggestion": "Suggest a correction to a section or to words you selected. It stays a suggestion until the author decides.",
  "alternative-interpretation": "Offer another reading of the passage.",
});

/** What a refused submission means to the reader, and which control to fix. */
const FIELD_PROBLEMS = Object.freeze({
  invalidBody: ["body", "Write your note, in plain text of up to 4,000 characters."],
  tooLarge: ["body", "Your note is too long to send. Shorten it a little."],
  missingSource: ["source", "A suggested source needs a link to the source."],
  invalidSourceUrl: ["source", "Enter a full web address that starts with https:// or http://, without a user name or password."],
  invalidSuggestedText: ["suggested", "Write the suggested wording in plain text of up to 2,000 characters."],
  targetNotAllowed: ["passage", "A suggested correction needs a section or words you selected, not the whole post."],
  invalidTarget: ["passage", "That passage cannot be used. Choose a section, or select the words again."],
  invalidName: ["name", "Use plain text of up to 80 characters for your name."],
  consentWithoutName: ["consent", "Enter your name to have it shown, or leave this unchecked."],
  linkWithoutClaim: ["claim", "Choose the claim the evidence link belongs to."],
  locatorsWithoutSource: ["offered", "Choose the source you looked in before saying where."],
  invalidLocator: ["locator", "Say where in the source in plain text of up to 64 characters on one line, such as 40 or 12–14."],
  stanceWithoutEvidence: ["stance", "Say how a source bears on the passage only when you offer one: choose a source or give a link."],
});

/** A contact link the build allows: a plain mailto: address or an https: page. */
export function safeContact(value) {
  if (!isText(value)) return null;
  if (/^mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** The safe endpoint of the hosted function: an https: address without credentials. */
function safeEndpoint(value) {
  if (!isText(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

let instances = 0;

export class ObPassageFeedback extends HTMLElement {
  #listeners = null;
  #passages = null;
  #prose = null;
  #endpoint = "";
  #page = "";
  #contact = null;
  #kinds = [];
  #seenAt = undefined;
  #ui = null;
  #quote = null;
  #sending = null;
  #scheduled = false;
  #receipt = null;
  #choices = null;

  connectedCallback() {
    if (this.#listeners) return;
    if (!this.#ui) {
      const passages = readPassages(document.getElementById(DATA_ELEMENT_ID)?.textContent);
      const endpoint = safeEndpoint(this.getAttribute("endpoint"));
      const kinds = offeredKinds(this.getAttribute("kinds"));
      // Without its data, an endpoint or a kind to offer the static text stays, as without JavaScript.
      if (!passages || !endpoint || !kinds.length) return;
      this.#kinds = kinds;
      this.#passages = passages;
      this.#endpoint = endpoint;
      this.#page = this.getAttribute("page") || "";
      this.#contact = safeContact(this.getAttribute("contact"));
      // The evidence offer, once the site says the hosted service stores it, and only with readable
      // choices; without them the form is exactly what it was.
      this.#choices = this.hasAttribute("evidence") && kinds.some((each) => EVIDENCE_KINDS.includes(each))
        ? readEvidenceChoices(document.getElementById(EVIDENCE_ELEMENT_ID)?.textContent)
        : null;
      const seen = canonicalTime(new Date());
      this.#seenAt = seen && isCanonicalTime(seen) ? seen : undefined;
      instances += 1;
      this.#ui = this.#build(`ob-passage-feedback-${instances}`);
      this.querySelector(".ob-passage-feedback-static")?.remove();
      this.append(this.#ui.done, this.#ui.form, this.#ui.status, this.#ui.fallback, this.#ui.selectionButton);
      // A reader's receipt (ADR 0107) is usable here once the site says the
      // hosted service issues receipts.
      if (this.hasAttribute("receipts")) this.append(receiptManager({ endpoint }));
      this.#kindChanged();
    }
    // The form's own listeners live as long as it does; these follow the page.
    this.#prose = this.closest("article")?.querySelector(".ob-prose") ?? null;
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    if (this.#prose) {
      document.addEventListener("selectionchange", () => this.#schedule(), { signal });
      window.addEventListener("scroll", () => this.#schedule(), { signal, passive: true });
      window.addEventListener("resize", () => this.#schedule(), { signal });
    }
  }

  disconnectedCallback() {
    this.#listeners?.abort();
    this.#listeners = null;
    this.#sending?.abort();
    this.#sending = null;
    if (this.#ui) this.#ui.selectionButton.hidden = true;
  }

  /** The form and its companions, every reader-facing string set as text. */
  #build(id) {
    const make = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const describe = (control, ...ids) => control.setAttribute("aria-describedby", ids.filter(Boolean).join(" "));
    const errorFor = (name) => {
      const error = make("p", "ob-passage-feedback-error");
      error.id = `${id}-${name}-error`;
      error.hidden = true;
      return error;
    };
    const hint = (name, text) => {
      const element = make("p", "ob-passage-feedback-hint", text);
      element.id = `${id}-${name}-hint`;
      return element;
    };
    const labelled = (control, controlId, text) => {
      control.id = controlId;
      const label = make("label", undefined, text);
      label.htmlFor = controlId;
      return label;
    };
    const choice = (control, label) => {
      const wrapper = make("div", "ob-passage-feedback-choice");
      wrapper.append(control, label);
      return wrapper;
    };

    const form = make("form", "ob-passage-feedback-form");
    form.noValidate = true;
    const alert = make("div", "ob-passage-feedback-alert");
    alert.setAttribute("role", "alert");

    // Which part of the post.
    const passage = make("fieldset", "ob-passage-feedback-passage");
    const passageError = errorFor("passage");
    const passageHint = hint("passage", "Select words in the post to quote them, or choose a section or the whole post.");
    const radio = (value) => {
      const input = make("input");
      input.type = "radio";
      input.name = `${id}-passage`;
      input.value = value;
      return input;
    };
    const work = radio("work");
    work.checked = true;
    const section = radio("section");
    const quote = radio("quote");
    quote.disabled = true;
    const sectionSelect = make("select");
    for (const item of this.#passages.sections) {
      const option = make("option", undefined, item.title || (item.anchor === undefined ? "The opening, before the first heading" : `#${item.anchor}`));
      option.value = String(item.index);
      sectionSelect.append(option);
    }
    const sectionField = make("div", "ob-passage-feedback-subfield");
    sectionField.append(labelled(sectionSelect, `${id}-section-select`, "Section"));
    sectionField.append(sectionSelect);
    if (this.#passages.sections.length === 0) {
      section.disabled = true;
      sectionSelect.disabled = true;
    }
    const quoteText = make("p", "ob-passage-feedback-quote", "No words selected yet.");
    quoteText.id = `${id}-quote-text`;
    const selectionNote = make("p", "ob-passage-feedback-hint");
    selectionNote.id = `${id}-selection-note`;
    selectionNote.hidden = true;
    describe(quote, quoteText.id);
    passage.setAttribute("aria-describedby", passageHint.id);
    passage.append(
      make("legend", undefined, "Which part of the post?"),
      passageHint,
      choice(work, labelled(work, `${id}-work`, "The whole post")),
      choice(section, labelled(section, `${id}-section`, "A section")),
      sectionField,
      choice(quote, labelled(quote, `${id}-quote`, "The words I selected")),
      quoteText,
      selectionNote,
      passageError,
    );

    // Kind, note, source and suggested wording.
    const field = (...children) => {
      const wrapper = make("div", "ob-passage-feedback-field");
      wrapper.append(...children);
      return wrapper;
    };
    const kind = make("select");
    for (const value of this.#kinds) {
      const rules = FEEDBACK_KINDS[value];
      const option = make("option", undefined, rules.label);
      option.value = value;
      kind.append(option);
    }
    const kindHint = hint("kind", "");
    describe(kind, kindHint.id);
    const body = make("textarea");
    body.rows = 6;
    body.required = true;
    const bodyError = errorFor("body");
    const source = make("input");
    source.type = "url";
    source.autocomplete = "url";
    source.spellcheck = false;
    source.setAttribute("inputmode", "url");
    const sourceHint = hint("source", "A web address that starts with https:// or http://.");
    const sourceError = errorFor("source");
    const sourceLabel = labelled(source, `${id}-source`, "Link to a source (optional)");
    const suggested = make("textarea");
    suggested.rows = 3;
    const suggestedError = errorFor("suggested");
    const suggestedField = field(labelled(suggested, `${id}-suggested`, "Suggested wording (optional)"), suggested, suggestedError);

    // The reader's name, private unless they agree to show it.
    const attribution = make("fieldset", "ob-passage-feedback-attribution");
    const name = make("input");
    name.type = "text";
    name.autocomplete = "name";
    const nameError = errorFor("name");
    const consent = make("input");
    consent.type = "checkbox";
    const consentError = errorFor("consent");
    const nameHint = hint("name", "Leave it empty to send your note without a name. A name is kept private unless you agree below.");
    attribution.append(
      make("legend", undefined, "Your name (optional)"),
      field(labelled(name, `${id}-name`, "Name"), nameHint, name, nameError),
      choice(consent, labelled(consent, `${id}-consent`, "Show my name with this note if the author publishes it")),
      consentError,
    );

    // The evidence offer (ADR 0116): every choice is something the site publishes.
    const evidence = this.#choices ? this.#buildEvidence(id, { make, hint, labelled, choice, describe, errorFor, field }) : null;

    const privacy = hint("privacy", "Your note goes to the author for review. Nothing is published unless they approve it, and no e-mail address or account is asked for.");
    const submit = make("button", undefined, "Send for review");
    submit.type = "submit";
    const actions = make("div", "ob-passage-feedback-actions");
    actions.append(submit);
    form.append(
      alert,
      passage,
      field(labelled(kind, `${id}-kind`, "Kind of feedback"), kind, kindHint),
      field(labelled(body, `${id}-body`, "Your note"), body, bodyError),
      field(sourceLabel, source, sourceHint, sourceError),
      suggestedField,
      ...(evidence ? [evidence.fieldset] : []),
      attribution,
      privacy,
      actions,
    );

    // Outside the form, so a busy form never silences them.
    const status = make("p", "ob-passage-feedback-status");
    status.id = `${id}-status`;
    status.setAttribute("role", "status");
    const done = make("p", "ob-passage-feedback-done");
    done.id = `${id}-done`;
    done.tabIndex = -1;
    done.hidden = true;

    const fallback = make("div", "ob-passage-feedback-fallback");
    fallback.hidden = true;
    const fallbackMessage = make("p", "ob-passage-feedback-fallback-message");
    fallbackMessage.id = `${id}-fallback-message`;
    fallbackMessage.tabIndex = -1;
    const copyArea = make("textarea");
    copyArea.readOnly = true;
    copyArea.rows = 10;
    const copyButton = make("button", undefined, "Copy note");
    copyButton.type = "button";
    const fallbackActions = make("div", "ob-passage-feedback-actions");
    fallbackActions.append(copyButton);
    const contactLink = make("a", "ob-passage-feedback-contact", this.#contact?.startsWith("mailto:") ? "Write to the author" : "Open the author’s contact page");
    contactLink.hidden = !this.#contact;
    fallbackActions.append(contactLink);
    fallback.append(fallbackMessage, labelled(copyArea, `${id}-copy`, "Your note, ready to send to the author"), copyArea, fallbackActions);

    const selectionButton = make("button", "ob-passage-feedback-selection", "Give feedback on the selected words");
    selectionButton.type = "button";
    selectionButton.hidden = true;

    const errors = { passage: passageError, body: bodyError, source: sourceError, suggested: suggestedError, name: nameError, consent: consentError, ...(evidence?.errors || {}) };
    const controls = { body, source, suggested, name, consent, ...(evidence?.controls || {}) };
    const hints = { passage: passageHint.id, source: sourceHint.id, name: nameHint.id, ...(evidence?.hints || {}) };
    describe(source, sourceHint.id);
    describe(name, nameHint.id);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submit();
    });
    kind.addEventListener("change", () => this.#kindChanged());
    sectionSelect.addEventListener("change", () => {
      section.checked = true;
    });
    copyButton.addEventListener("click", () => this.#copy());
    // A press on the button must not collapse the selection it is about.
    selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
    selectionButton.addEventListener("click", () => this.#useSelection());

    return {
      form, alert, passage, work, section, quote, sectionSelect, quoteText, selectionNote, kind, kindHint, body, source,
      sourceLabel, suggested, suggestedField, name, consent, submit, status, done, fallback, fallbackMessage, copyArea,
      copyButton, contactLink, selectionButton, errors, controls, hints, evidence,
    };
  }

  /**
   * The evidence fieldset: the claim, an evidence link on it, a cited source, an offered source with
   * where in it, and the reader's stance, each optional and chosen only from published choices.
   */
  #buildEvidence(id, { make, hint, labelled, describe, errorFor, field }) {
    const choices = this.#choices;
    const fieldset = make("fieldset", "ob-passage-feedback-evidence");
    const intro = hint("evidence", "Optional. Name what your note is about, from what this site publishes. The author reads it as your statement; nothing is checked, scored or counted.");
    fieldset.setAttribute("aria-describedby", intro.id);
    const select = (name, none, items) => {
      const control = make("select");
      control.name = name;
      const empty = make("option", undefined, none);
      empty.value = "";
      control.append(empty);
      for (const item of items) {
        const option = make("option", undefined, item.label);
        option.value = item.id;
        control.append(option);
      }
      return control;
    };
    const claim = select("claim", "No claim", choices.claims);
    const link = select("evidence-link", "No evidence link", []);
    link.disabled = true;
    const citation = select("citation", "No cited source", choices.citations);
    const offered = select("offered", "No source", choices.sources);
    const locatorKind = make("select");
    for (const kind of LOCATOR_KINDS) {
      const option = make("option", undefined, kind[0].toUpperCase() + kind.slice(1));
      option.value = kind;
      locatorKind.append(option);
    }
    const locator = make("input");
    locator.type = "text";
    locator.maxLength = 64;
    locator.spellcheck = false;
    const locatorTo = make("input");
    locatorTo.type = "text";
    locatorTo.maxLength = 64;
    locatorTo.spellcheck = false;
    const locatorHint = hint("locator", "Where in the source you looked, such as page 40; add an end for a range.");
    for (const control of [locatorKind, locator, locatorTo]) control.disabled = true;
    const stance = make("fieldset", "ob-passage-feedback-stance");
    const stanceHint = hint("stance", "Only for a source you offer here or link above.");
    stance.setAttribute("aria-describedby", stanceHint.id);
    stance.append(make("legend", undefined, "How does it bear on the passage?"), stanceHint);
    const stances = [];
    for (const value of ["", ...EVIDENCE_STANCES]) {
      const input = make("input");
      input.type = "radio";
      input.name = `${id}-stance`;
      input.value = value;
      input.checked = value === "";
      stances.push(input);
      const wrapper = make("div", "ob-passage-feedback-choice");
      wrapper.append(input, labelled(input, `${id}-stance-${value || "none"}`, value ? STANCE_LABELS[value] : "I am not saying"));
      stance.append(wrapper);
    }
    const errors = { claim: errorFor("claim"), offered: errorFor("offered"), locator: errorFor("locator"), stance: errorFor("stance") };
    stance.append(errors.stance);
    const subfield = (...children) => {
      const wrapper = make("div", "ob-passage-feedback-subfield");
      wrapper.append(...children);
      return wrapper;
    };
    const locatorFields = make("div", "ob-passage-feedback-locator");
    locatorFields.append(
      subfield(labelled(locatorKind, `${id}-locator-kind`, "Kind of place"), locatorKind),
      subfield(labelled(locator, `${id}-locator`, "Where"), locator),
      subfield(labelled(locatorTo, `${id}-locator-to`, "To (optional)"), locatorTo),
    );
    describe(locator, locatorHint.id);
    const parts = [make("legend", undefined, "Evidence (optional)"), intro];
    if (choices.claims.length) {
      parts.push(field(labelled(claim, `${id}-claim`, "A claim in this post your note is about"), claim, errors.claim));
      parts.push(field(labelled(link, `${id}-evidence-link`, "Evidence for that claim you question"), link));
    }
    if (choices.citations.length) parts.push(field(labelled(citation, `${id}-citation`, "A source this post cites that you question"), citation));
    if (choices.sources.length) {
      parts.push(field(labelled(offered, `${id}-offered`, "A source this site publishes that you offer"), offered, errors.offered));
      parts.push(field(locatorHint, locatorFields, errors.locator));
    }
    parts.push(stance);
    fieldset.append(...parts);
    const syncLinks = () => {
      const chosen = choices.claims.find((item) => item.id === claim.value);
      link.replaceChildren(link.options[0]);
      for (const item of chosen?.links || []) {
        const option = make("option", undefined, item.label);
        option.value = item.id;
        link.append(option);
      }
      link.value = "";
      link.disabled = !chosen || chosen.links.length === 0;
    };
    const syncLocator = () => {
      for (const control of [locatorKind, locator, locatorTo]) control.disabled = offered.value === "";
    };
    claim.addEventListener("change", syncLinks);
    offered.addEventListener("change", syncLocator);
    // Back to nothing named, after a note was sent.
    const reset = () => {
      for (const control of [claim, citation, offered, locator, locatorTo]) control.value = "";
      syncLinks();
      syncLocator();
      stances[0].checked = true;
    };
    return {
      fieldset, claim, link, citation, offered, locatorKind, locator, locatorTo, stances, errors, reset,
      controls: { claim, offered, locator, stance: stances[0] },
      hints: { locator: locatorHint.id, stance: stanceHint.id },
    };
  }

  /** The evidence block the reader chose, or null when they named nothing. */
  #evidenceValue() {
    const ui = this.#ui.evidence;
    if (!ui || ui.fieldset.hidden) return null;
    const value = {};
    if (ui.claim.value) value.claim = ui.claim.value;
    if (ui.link.value) value.evidenceLink = ui.link.value;
    if (ui.citation.value) value.citation = ui.citation.value;
    if (ui.offered.value) value.source = ui.offered.value;
    if (ui.offered.value && (ui.locator.value.trim() !== "" || ui.locatorTo.value.trim() !== "")) {
      const locator = { kind: ui.locatorKind.value, value: ui.locator.value };
      if (ui.locatorTo.value.trim() !== "") locator.to = ui.locatorTo.value;
      value.locators = [locator];
    }
    const stance = ui.stances.find((input) => input.checked)?.value;
    if (stance) value.stance = stance;
    return Object.keys(value).length ? value : null;
  }

  #kindChanged() {
    const ui = this.#ui;
    const rules = FEEDBACK_KINDS[ui.kind.value] ?? FEEDBACK_KINDS.question;
    ui.kindHint.textContent = KIND_HINTS[ui.kind.value] ?? "";
    const required = rules.sourceUrl === "required";
    ui.sourceLabel.textContent = required ? "Link to the source" : "Link to a source (optional)";
    ui.source.required = required;
    ui.suggestedField.hidden = rules.suggestedText === "notUsed";
    // Only a suggested source or correction offers evidence (ADR 0116).
    if (ui.evidence) ui.evidence.fieldset.hidden = !EVIDENCE_KINDS.includes(ui.kind.value);
  }

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    const run = () => {
      this.#scheduled = false;
      if (this.#listeners) this.#capture();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** Reads the current selection, keeping the last usable quotation until a new one replaces it. */
  #capture() {
    const ui = this.#ui;
    const selection = document.getSelection?.();
    const located = locateSelection(this.#prose, selection, this.#passages);
    if (!located) {
      ui.selectionButton.hidden = true;
      return;
    }
    const made = located.problem ? selectionProblem(located.problem) : quoteFromSelection(this.#passages, located.index, located.text, located.hint);
    if (!made.ok) {
      ui.selectionButton.hidden = true;
      ui.selectionNote.textContent = made.message;
      ui.selectionNote.hidden = false;
      return;
    }
    ui.selectionNote.hidden = true;
    ui.selectionNote.textContent = "";
    this.#quote = made.target;
    ui.quote.disabled = false;
    ui.quoteText.textContent = `“${made.target.exact}”`;
    this.#placeButton(selection.getRangeAt(0));
  }

  /** Shows the selection button just below the selection (or above it), inside the viewport. */
  #placeButton(range) {
    const button = this.#ui.selectionButton;
    const view = document.documentElement;
    const rect = range.getBoundingClientRect?.();
    if (!rect || !view) {
      button.hidden = true;
      return;
    }
    const width = view.clientWidth;
    const height = view.clientHeight;
    if (rect.bottom < 0 || rect.top > height) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    const box = button.getBoundingClientRect();
    let left = Math.min(Math.max(rect.left, GUTTER), width - GUTTER - box.width);
    left = Math.max(left, GUTTER);
    let top = rect.bottom + GAP;
    if (top + box.height > height - GUTTER && rect.top - GAP - box.height >= GUTTER) top = rect.top - GAP - box.height;
    top = Math.max(GUTTER, Math.min(top, height - GUTTER - box.height));
    button.style.setProperty("--ob-passage-feedback-x", `${Math.round(left)}px`);
    button.style.setProperty("--ob-passage-feedback-y", `${Math.round(top)}px`);
  }

  #useSelection() {
    const ui = this.#ui;
    if (!this.#quote) return;
    ui.quote.checked = true;
    ui.selectionButton.hidden = true;
    ui.quote.focus();
    ui.passage.scrollIntoView?.({ block: "center" });
  }

  #target() {
    const ui = this.#ui;
    if (ui.quote.checked && this.#quote) return this.#quote;
    if (ui.section.checked) {
      const item = this.#passages.sections[Number(ui.sectionSelect.value)];
      if (!item) return null;
      const value = { version: 1, kind: "section", digest: item.digest };
      if (item.anchor !== undefined) value.section = item.anchor;
      const read = readTarget(value);
      return read.ok ? read.target : null;
    }
    return { version: 1, kind: "work" };
  }

  #clearErrors() {
    const ui = this.#ui;
    ui.alert.textContent = "";
    for (const [name, error] of Object.entries(ui.errors)) {
      error.hidden = true;
      error.textContent = "";
      if (name === "passage" || name === "stance") continue;
      const control = ui.controls[name];
      control.removeAttribute("aria-invalid");
      if (ui.hints[name]) control.setAttribute("aria-describedby", ui.hints[name]);
      else control.removeAttribute("aria-describedby");
    }
    ui.passage.setAttribute("aria-describedby", ui.hints.passage);
    for (const radio of [ui.work, ui.section, ui.quote]) radio.removeAttribute("aria-invalid");
    if (ui.evidence) {
      for (const radio of ui.evidence.stances) radio.removeAttribute("aria-invalid");
      ui.evidence.fieldset.querySelector(".ob-passage-feedback-stance")?.setAttribute("aria-describedby", ui.hints.stance);
    }
  }

  /** Marks one control invalid, describes it with the message, announces it and moves focus there. */
  #showError(name, message) {
    const ui = this.#ui;
    const error = ui.errors[name];
    error.textContent = message;
    error.hidden = false;
    ui.alert.textContent = message;
    if (name === "stance") {
      const group = ui.evidence.fieldset.querySelector(".ob-passage-feedback-stance");
      group.setAttribute("aria-describedby", `${ui.hints.stance} ${error.id}`);
      const checked = ui.evidence.stances.find((radio) => radio.checked) ?? ui.evidence.stances[0];
      checked.setAttribute("aria-invalid", "true");
      checked.focus();
      return;
    }
    if (name === "passage") {
      ui.passage.setAttribute("aria-describedby", `${ui.hints.passage} ${error.id}`);
      const checked = [ui.work, ui.section, ui.quote].find((radio) => radio.checked) ?? ui.work;
      checked.setAttribute("aria-invalid", "true");
      checked.focus();
      return;
    }
    const control = ui.controls[name];
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", [ui.hints[name], error.id].filter(Boolean).join(" "));
    control.focus();
  }

  #submit() {
    const ui = this.#ui;
    if (this.#sending) return;
    this.#clearErrors();
    ui.done.hidden = true;
    ui.fallback.hidden = true;
    ui.status.textContent = "";
    const target = this.#target();
    if (!target) {
      this.#showError("passage", FIELD_PROBLEMS.invalidTarget[1]);
      return;
    }
    const rules = FEEDBACK_KINDS[ui.kind.value];
    const value = {
      version: 1,
      kind: ui.kind.value,
      work: this.#passages.work,
      revision: this.#passages.revision,
      target,
      body: ui.body.value,
    };
    const details = {};
    if (ui.source.value.trim() !== "") details.sourceUrl = ui.source.value.trim();
    if (rules?.suggestedText !== "notUsed" && ui.suggested.value.trim() !== "") details.suggestedText = ui.suggested.value;
    if (Object.keys(details).length) value.details = details;
    if (this.#seenAt) value.seenAt = this.#seenAt;
    const name = ui.name.value;
    if (name.trim() !== "" || ui.consent.checked) value.attribution = { name, publishName: ui.consent.checked };
    const evidence = this.#evidenceValue();
    if (evidence) Object.assign(value, { version: 2, evidence });
    const read = evidence ? readSubmissionJson(JSON.stringify(value), { evidence: true }) : readFeedbackSubmissionJson(JSON.stringify(value));
    if (!read.ok) {
      const known = FIELD_PROBLEMS[read.error.code];
      if (known) {
        this.#showError(known[0], known[1]);
        return;
      }
      this.#fallback(null, "This page’s feedback data cannot be used, so the form cannot send your note. Please write to the author instead.");
      return;
    }
    this.#send(read.submission);
  }

  async #send(submission) {
    const ui = this.#ui;
    if (globalThis.navigator?.onLine === false) {
      this.#fallback(submission, "You seem to be offline, so your note was not sent.");
      return;
    }
    const controller = new AbortController();
    this.#sending = controller;
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT);
    ui.form.setAttribute("aria-busy", "true");
    ui.submit.setAttribute("aria-disabled", "true");
    ui.submit.textContent = "Sending…";
    ui.status.textContent = "Sending your note…";
    let outcome;
    try {
      const response = await fetch(`${this.#endpoint}/feedback`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submissionValue(submission)),
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
      ui.form.removeAttribute("aria-busy");
      ui.submit.removeAttribute("aria-disabled");
      ui.submit.textContent = "Send for review";
    }
    if (!this.#listeners) return;
    if (outcome.status === 202) {
      this.#succeeded(outcome.receipt);
      return;
    }
    const known = FIELD_PROBLEMS[outcome.code];
    if ((outcome.status === 422 || outcome.status === 413) && known) {
      ui.status.textContent = "";
      this.#showError(known[0], known[1]);
      return;
    }
    // A site whose hosted service does not store evidence yet refuses version 2 (ADR 0116): the
    // note, with its evidence, is still the reader's to copy and send.
    if (outcome.status === 422 && outcome.code === "unsupportedVersion") {
      this.#fallback(submission, "Your note was not sent: this site does not take evidence through the form right now.");
      return;
    }
    if (outcome.status === 403 && outcome.code === "closed") {
      ui.status.textContent = "Feedback on this post is closed, so your note was not sent.";
      return;
    }
    // The same note from here within the hour (ADR 0108): it is already with the author, so there
    // is nothing to copy and send again.
    if (outcome.status === 409 && outcome.code === "duplicate") {
      ui.status.textContent = "This note was already sent and is waiting for review.";
      return;
    }
    const reason =
      outcome.status === 0
        ? "Your note could not be sent: the feedback service did not answer."
        : outcome.status === 429
          ? "Your note was not sent: too many notes have come from here recently."
          : outcome.status === 404 || outcome.code === "unavailable"
            ? "Your note was not sent: this site is not taking feedback through the form right now."
            : "Your note could not be sent: the feedback service had a problem.";
    this.#fallback(submission, reason);
  }

  #succeeded(receipt) {
    const ui = this.#ui;
    for (const control of [ui.body, ui.source, ui.suggested]) control.value = "";
    ui.evidence?.reset();
    ui.status.textContent = "Sent for review.";
    ui.done.textContent = receipt
      ? "Thank you. Your note was sent to the author for review. Nothing is published unless they approve it. Keep the receipt below."
      : "Thank you. Your note was sent to the author for review. Nothing is published unless they approve it.";
    ui.done.hidden = false;
    // The receipt is shown once, right after the note was taken; a newer one replaces it.
    this.#receipt?.remove();
    this.#receipt = receipt ? receiptPanel({ endpoint: this.#endpoint, receipt }) : null;
    if (this.#receipt) ui.done.after(this.#receipt);
    ui.done.focus();
  }

  /** The copy-and-send path: the note as plain text, a copy button and the author's contact, if any. */
  #fallback(submission, reason) {
    const ui = this.#ui;
    const nothingLost = submission
      ? " Nothing you wrote was lost: copy the note below and send it to the author."
      : "";
    ui.status.textContent = "";
    ui.fallbackMessage.textContent = `${reason}${nothingLost}`;
    ui.copyArea.value = submission ? feedbackCopyText(submission, this.#page) : "";
    const copyable = Boolean(submission);
    ui.copyArea.hidden = !copyable;
    ui.copyButton.hidden = !copyable;
    for (const label of ui.fallback.querySelectorAll("label")) label.hidden = !copyable;
    if (this.#contact) ui.contactLink.href = this.#contactHref(submission);
    ui.fallback.hidden = false;
    ui.fallbackMessage.focus();
  }

  #contactHref(submission) {
    const contact = this.#contact;
    if (!contact.startsWith("mailto:") || !submission) return contact;
    const subject = `${FEEDBACK_KINDS[submission.kind].label} about ${this.#page || submission.work}`;
    const withBody = `${contact}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(this.#ui.copyArea.value)}`;
    return withBody.length <= MAX_MAIL_LINK ? withBody : `${contact}?subject=${encodeURIComponent(subject)}`;
  }

  async #copy() {
    const ui = this.#ui;
    try {
      await globalThis.navigator.clipboard.writeText(ui.copyArea.value);
      ui.status.textContent = "Your note was copied.";
    } catch {
      ui.copyArea.focus();
      ui.copyArea.select();
      ui.status.textContent = "Your note is selected: press Control+C (or Command+C) to copy it.";
    }
  }
}

if (!customElements.get("ob-passage-feedback")) {
  customElements.define("ob-passage-feedback", ObPassageFeedback);
}
