// <ob-future-suggestion> turns a post's suggestion region into a form for a reader's question or
// source for possible future work (ADR 0152 to 0157). The page is complete without it: the region's
// static text tells a reader how to write to the author instead.
//
// A suggestion is a question, text, video, audio or other source, in the reader's own words, with
// an optional public link, optional bibliographic hints, an optional contact the reader agrees to be
// reached at and a name they may choose to have credited. It goes to the editors' private queue,
// never to the page: nothing is published, accepted means only that the editors are interested, and
// nothing the reader sends is fetched, counted or ranked.
//
// A submission is checked by the shared validator (future-suggestion.js) and sent to the hosted
// function's /feedback route only where the site says the service issues receipts, because a reader
// must always be able to take a suggestion back. When it cannot be sent (offline, the service off or
// failing), the reader can try again or copy it, and nothing they wrote is lost. Nothing is stored in
// the browser and nothing is e-mailed.
//
// Every piece of state is a private field, so nothing here can shadow one of HTMLElement's own
// properties.

import { MAX_TEXT_CHARS, SUGGESTION_TYPES, readSuggestionSubmissionJson, suggestionCopyText } from "./future-suggestion.js";
import { isWorkPath } from "./passage-feedback.js";
import { isReceipt, receiptManager, receiptPanel } from "./feedback-receipt.js";

const SEND_TIMEOUT = 20_000;
// Mail programs refuse long links; a longer suggestion is pasted instead.
const MAX_MAIL_LINK = 1800;
const isText = (value) => typeof value === "string";

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

/** What a refused submission means to the reader, and which control to fix. */
const FIELD_PROBLEMS = Object.freeze({
  invalidText: ["text", `Write your suggestion in plain text of up to ${MAX_TEXT_CHARS.toLocaleString("en")} characters.`],
  tooLarge: ["text", "Your suggestion is too long to send. Shorten it a little."],
  notForQuestion: ["url", "A question is words only. Clear the link and the details, or choose another kind of suggestion."],
  invalidUrl: ["url", "Use a link to a public web page that starts with http: or https:, without a password and without a key or token in it."],
  invalidHint: ["hints", "Check the details: a title, creators, a year or an identifier is not in a form this page can use."],
  invalidName: ["name", "Use plain text of up to 80 characters for your name."],
  consentWithoutName: ["showName", "Enter your name to be thanked by it, or leave this unchecked."],
  invalidContact: ["contact", "Use one plain e-mail address such as name@example.org."],
  contactWithoutConsent: ["followUp", "Agree to be contacted, or clear the address."],
});

const IDENTIFIER_LABELS = Object.freeze([["", "None"], ["doi", "DOI"], ["isbn", "ISBN"], ["issn", "ISSN"], ["pmid", "PubMed ID"], ["pmcid", "PubMed Central ID"]]);

let instances = 0;

export class ObFutureSuggestion extends HTMLElement {
  #endpoint = "";
  #page = "";
  #work = "";
  #contact = null;
  #hosted = false;
  #ui = null;
  #sending = null;
  #connected = false;
  #receipt = null;
  #pending = null;

  connectedCallback() {
    this.#connected = true;
    if (this.#ui) return;
    const work = this.getAttribute("work") || "";
    const endpoint = safeEndpoint(this.getAttribute("endpoint"));
    // Without its page or an endpoint the static text stays, as without JavaScript.
    if (!isWorkPath(work) || !endpoint) return;
    this.#work = work;
    this.#endpoint = endpoint;
    this.#page = this.getAttribute("page") || "";
    this.#contact = safeContact(this.getAttribute("contact"));
    // A hosted copy always has a receipt, so the form sends only where receipts are issued.
    this.#hosted = this.hasAttribute("receipts");
    instances += 1;
    this.#ui = this.#build(`ob-future-suggestion-${instances}`);
    this.querySelector(".ob-future-suggestion-static")?.remove();
    this.append(this.#ui.done, this.#ui.form, this.#ui.status, this.#ui.fallback);
    if (this.#hosted) this.append(receiptManager({ endpoint, noun: "suggestion" }));
  }

  disconnectedCallback() {
    this.#connected = false;
    this.#sending?.abort();
    this.#sending = null;
  }

  /** The form and its companions, every reader-facing string set as text. */
  #build(id) {
    const make = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const errorFor = (name) => {
      const error = make("p", "ob-future-suggestion-error");
      error.id = `${id}-${name}-error`;
      error.hidden = true;
      return error;
    };
    const hint = (name, text) => {
      const element = make("p", "ob-future-suggestion-hint", text);
      element.id = `${id}-${name}-hint`;
      return element;
    };
    const labelled = (control, controlId, text) => {
      control.id = controlId;
      const label = make("label", undefined, text);
      label.htmlFor = controlId;
      return label;
    };
    const choice = (control, label, description) => {
      const wrapper = make("div", "ob-future-suggestion-choice");
      wrapper.append(control, label);
      if (description) wrapper.append(description);
      return wrapper;
    };
    const field = (...children) => {
      const wrapper = make("div", "ob-future-suggestion-field");
      wrapper.append(...children);
      return wrapper;
    };
    const input = (type, autocomplete) => {
      const element = make("input");
      element.type = type;
      if (autocomplete) element.autocomplete = autocomplete;
      return element;
    };

    const form = make("form", "ob-future-suggestion-form");
    form.noValidate = true;
    const alert = make("div", "ob-future-suggestion-alert");
    alert.setAttribute("role", "alert");

    // What kind of suggestion it is: a closed set of intents, never a rating.
    const kinds = make("fieldset", "ob-future-suggestion-type");
    const radios = SUGGESTION_TYPES.map((entry, position) => {
      const radio = input("radio");
      radio.name = `${id}-type`;
      radio.value = entry.id;
      radio.checked = position === 0;
      return radio;
    });
    kinds.append(make("legend", undefined, "What are you suggesting?"), ...radios.map((radio, position) => choice(radio, labelled(radio, `${id}-type-${radio.value}`, SUGGESTION_TYPES[position].label))));

    // The reader's own words.
    const text = make("textarea");
    text.rows = 6;
    text.required = true;
    const textLabel = labelled(text, `${id}-text`, SUGGESTION_TYPES[0].words);
    const textHint = hint("text", `Plain text, up to ${MAX_TEXT_CHARS.toLocaleString("en")} characters. It is read by the editors only; it is never shown on the site.`);
    const textError = errorFor("text");
    text.setAttribute("aria-describedby", textHint.id);

    // The source: a link and what the reader knows about it. A question has neither.
    const source = make("fieldset", "ob-future-suggestion-source");
    const link = input("url", "off");
    link.spellcheck = false;
    const linkHint = hint("url", "Optional. A public web page. Nothing is opened or checked for you; an editor looks at it.");
    const linkError = errorFor("url");
    link.setAttribute("aria-describedby", linkHint.id);
    const title = input("text");
    const creators = make("textarea");
    creators.rows = 2;
    const creatorsHint = hint("creators", "One name per line, up to 8.");
    creators.setAttribute("aria-describedby", creatorsHint.id);
    const year = input("text");
    const publisher = input("text");
    const scheme = make("select");
    for (const [value, label] of IDENTIFIER_LABELS) {
      const option = make("option", undefined, label);
      option.value = value;
      scheme.append(option);
    }
    const identifier = input("text", "off");
    identifier.spellcheck = false;
    const hintsError = errorFor("hints");
    const hintsHint = hint("hints", "Optional, and only what you know. These are your own words about the source: nobody checks them.");
    source.append(
      make("legend", undefined, "The source (optional)"),
      hintsHint,
      field(labelled(link, `${id}-url`, "Link"), linkHint, link, linkError),
      field(labelled(title, `${id}-title`, "Title"), title),
      field(labelled(creators, `${id}-creators`, "Creators"), creatorsHint, creators),
      field(labelled(year, `${id}-year`, "Year"), year),
      field(labelled(publisher, `${id}-publisher`, "Publisher or archive"), publisher),
      field(labelled(scheme, `${id}-scheme`, "Identifier"), scheme),
      field(labelled(identifier, `${id}-identifier`, "Identifier value"), identifier),
      hintsError,
    );

    const aboutArticle = input("checkbox");
    const aboutHint = hint("about", "Optional. Tells the editors which article led you to this.");
    aboutArticle.setAttribute("aria-describedby", aboutHint.id);

    // A name and a way to reach the reader: each optional, each the reader's own choice.
    const identity = make("fieldset", "ob-future-suggestion-identity");
    const name = input("text", "name");
    const nameHint = hint("name", "Optional. Moderators and editors see it. Leave it empty to stay anonymous.");
    const nameError = errorFor("name");
    name.setAttribute("aria-describedby", nameHint.id);
    const credit = input("checkbox");
    const creditHint = hint("credit", "If the editors use your suggestion they may thank you by this name. They will not unless you check this, and it covers the text as you wrote it: if you later change it, you are asked again.");
    credit.setAttribute("aria-describedby", creditHint.id);
    const creditError = errorFor("showName");
    const address = input("email", "email");
    const addressHint = hint("contact", "Optional. Only the site’s administrator can see it, and it is deleted after a while. Nothing is e-mailed to you by this site.");
    const addressError = errorFor("contact");
    address.setAttribute("aria-describedby", addressHint.id);
    const followUp = input("checkbox");
    const followUpError = errorFor("followUp");
    identity.append(
      make("legend", undefined, "About you (optional)"),
      field(labelled(name, `${id}-name`, "Name"), nameHint, name, nameError),
      choice(credit, labelled(credit, `${id}-credit`, "You may thank me by this name"), creditHint),
      creditError,
      field(labelled(address, `${id}-address`, "E-mail address"), addressHint, address, addressError),
      choice(followUp, labelled(followUp, `${id}-follow-up`, "You may contact me at this address about this suggestion")),
      followUpError,
    );

    const privacy = hint("privacy", this.#hosted
      ? "It goes to the site’s editors for review and is never published. Accepting it only means they are interested. No account is asked for; keep the receipt you get to check on it or take it back."
      : "This site does not take suggestions through the form: when you are ready, your suggestion is prepared for you to copy and send to the author.");
    const submit = make("button", undefined, this.#hosted ? "Send to the editors" : "Prepare to send to the author");
    submit.type = "submit";
    const actions = make("div", "ob-future-suggestion-actions");
    actions.append(submit);
    const optional = make("div", "ob-future-suggestion-about");
    optional.append(choice(aboutArticle, labelled(aboutArticle, `${id}-about-article`, "It is about this article"), aboutHint));
    form.append(alert, kinds, field(textLabel, textHint, text, textError), source, optional, identity, privacy, actions);

    // Outside the form, so a busy form never silences them.
    const status = make("p", "ob-future-suggestion-status");
    status.setAttribute("role", "status");
    const done = make("p", "ob-future-suggestion-done");
    done.tabIndex = -1;
    done.hidden = true;

    const fallback = make("div", "ob-future-suggestion-fallback");
    fallback.hidden = true;
    const fallbackMessage = make("p", "ob-future-suggestion-fallback-message");
    fallbackMessage.tabIndex = -1;
    const copyArea = make("textarea");
    copyArea.readOnly = true;
    copyArea.rows = 10;
    const copyLabel = labelled(copyArea, `${id}-copy`, "Your suggestion, ready to send to the author");
    const retry = make("button", undefined, "Try again");
    retry.type = "button";
    retry.hidden = true;
    const copyButton = make("button", undefined, "Copy suggestion");
    copyButton.type = "button";
    const contactLink = make("a", "ob-future-suggestion-contact", this.#contact?.startsWith("mailto:") ? "Write to the author" : "Open the author’s contact page");
    contactLink.hidden = !this.#contact;
    const fallbackActions = make("div", "ob-future-suggestion-actions");
    fallbackActions.append(retry, copyButton, contactLink);
    fallback.append(fallbackMessage, copyLabel, copyArea, fallbackActions);

    const errors = { text: textError, url: linkError, hints: hintsError, name: nameError, showName: creditError, contact: addressError, followUp: followUpError };
    const controls = { text, url: link, hints: title, name, showName: credit, contact: address, followUp };
    const described = { text: textHint.id, url: linkHint.id, hints: hintsHint.id, name: nameHint.id, showName: creditHint.id, contact: addressHint.id };

    const setKind = () => {
      const kind = radios.find((radio) => radio.checked)?.value ?? "question";
      const entry = SUGGESTION_TYPES.find((item) => item.id === kind);
      textLabel.textContent = entry.words;
      // A question is words only, so its source controls are out of reach rather than silently ignored.
      source.hidden = kind === "question";
      for (const control of [link, title, creators, year, publisher, scheme, identifier]) control.disabled = kind === "question";
    };
    for (const radio of radios) radio.addEventListener("change", setKind);
    setKind();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submit();
    });
    copyButton.addEventListener("click", () => this.#copy());
    retry.addEventListener("click", () => {
      if (this.#pending) this.#send(this.#pending);
    });

    return {
      form, alert, radios, text, link, title, creators, year, publisher, scheme, identifier, aboutArticle, name, credit, address, followUp, submit, status, done, fallback,
      fallbackMessage, copyArea, copyLabel, retry, copyButton, contactLink, errors, controls, described, kinds,
    };
  }

  #clearErrors() {
    const ui = this.#ui;
    ui.alert.textContent = "";
    for (const [name, error] of Object.entries(ui.errors)) {
      error.hidden = true;
      error.textContent = "";
      const control = ui.controls[name];
      control.removeAttribute("aria-invalid");
      if (ui.described[name]) control.setAttribute("aria-describedby", ui.described[name]);
      else control.removeAttribute("aria-describedby");
    }
    // A detail control that was marked is cleared with the rest, whichever it was, and gets back its own description.
    for (const control of [ui.title, ui.creators, ui.year, ui.publisher, ui.scheme, ui.identifier]) {
      control.removeAttribute("aria-invalid");
      if (control.dataset.described === undefined) continue;
      if (control.dataset.described) control.setAttribute("aria-describedby", control.dataset.described);
      else control.removeAttribute("aria-describedby");
      delete control.dataset.described;
    }
  }

  /** Marks one control invalid, describes it with the message, announces it and moves focus there. */
  #showError(name, message, focus = null) {
    const ui = this.#ui;
    const error = ui.errors[name];
    error.textContent = message;
    error.hidden = false;
    ui.alert.textContent = message;
    // A problem with the details is marked on the first detail the reader filled in (or the control
    // the caller names), not on the title they may have left empty.
    const control = focus ?? (name === "hints" ? this.#firstFilledHint() : ui.controls[name]);
    control.setAttribute("aria-invalid", "true");
    if (control !== ui.controls[name]) control.dataset.described = control.getAttribute("aria-describedby") ?? "";
    control.setAttribute("aria-describedby", [control === ui.controls[name] ? ui.described[name] : control.dataset.described, error.id].filter(Boolean).join(" "));
    control.focus();
  }

  /** The first source-detail control that has something in it: title, creators, year, publisher, then the identifier. */
  #firstFilledHint() {
    const ui = this.#ui;
    const filled = [ui.title, ui.creators, ui.year, ui.publisher, ui.scheme, ui.identifier].find((control) => control.value.trim() !== "");
    return filled ?? ui.title;
  }

  /** The reader's choices as a submission value, before the shared validator reads it. */
  #value() {
    const ui = this.#ui;
    const type = ui.radios.find((radio) => radio.checked)?.value ?? "question";
    const value = { version: 1, kind: "future-suggestion", type, text: ui.text.value };
    if (type !== "question") {
      if (ui.link.value.trim() !== "") value.url = ui.link.value.trim();
      const hints = {};
      if (ui.title.value.trim() !== "") hints.title = ui.title.value;
      const names = ui.creators.value.split("\n").filter((line) => line.trim() !== "");
      if (names.length) hints.creators = names;
      if (ui.year.value.trim() !== "") hints.year = ui.year.value;
      if (ui.publisher.value.trim() !== "") hints.publisher = ui.publisher.value;
      if (ui.scheme.value !== "" || ui.identifier.value.trim() !== "") hints.identifiers = [{ scheme: ui.scheme.value, value: ui.identifier.value }];
      if (Object.keys(hints).length) value.hints = hints;
    }
    if (ui.aboutArticle.checked) value.about = { article: this.#work };
    // An empty name is no name, so agreeing to be thanked without one is that choice's own error.
    if (ui.name.value.trim() !== "" || ui.credit.checked) value.attribution = { ...(ui.name.value.trim() !== "" ? { name: ui.name.value } : {}), publishName: ui.credit.checked };
    if (ui.address.value.trim() !== "" || ui.followUp.checked) value.contact = { address: ui.address.value.trim(), followUp: ui.followUp.checked };
    return value;
  }

  #submit() {
    const ui = this.#ui;
    if (this.#sending) return;
    this.#clearErrors();
    ui.done.hidden = true;
    ui.fallback.hidden = true;
    ui.status.textContent = "";
    // An identifier needs both its kind and its value, so a half-filled pair is the reader's to fix.
    if ((ui.scheme.value === "") !== (ui.identifier.value.trim() === "") && !ui.scheme.disabled) {
      this.#showError("hints", "Choose the kind of identifier and give its value, or clear both.", ui.scheme.value === "" ? ui.scheme : ui.identifier);
      return;
    }
    const read = readSuggestionSubmissionJson(JSON.stringify(this.#value()));
    if (!read.ok) {
      const known = FIELD_PROBLEMS[read.error.code];
      if (known) {
        this.#showError(...known);
        return;
      }
      this.#fallback(null, "The form cannot prepare your suggestion. Please write to the author instead.");
      return;
    }
    if (!this.#hosted) {
      this.#fallback(read.submission, "Your suggestion is ready.", { lost: false });
      return;
    }
    this.#send(read.submission);
  }

  async #send(submission) {
    const ui = this.#ui;
    if (this.#sending) return;
    this.#pending = submission;
    ui.fallback.hidden = true;
    if (globalThis.navigator?.onLine === false) {
      this.#fallback(submission, "You seem to be offline, so your suggestion was not sent.", { retry: true });
      return;
    }
    const controller = new AbortController();
    this.#sending = controller;
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT);
    ui.form.setAttribute("aria-busy", "true");
    ui.submit.setAttribute("aria-disabled", "true");
    ui.retry.setAttribute("aria-disabled", "true");
    ui.submit.textContent = "Sending…";
    ui.status.textContent = "Sending your suggestion…";
    let outcome;
    try {
      const response = await fetch(`${this.#endpoint}/feedback?work=${encodeURIComponent(this.#work)}`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
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
      ui.retry.removeAttribute("aria-disabled");
      ui.submit.textContent = "Send to the editors";
    }
    if (!this.#connected) return;
    if (outcome.status === 202) {
      this.#succeeded(submission, outcome.receipt);
      return;
    }
    const known = FIELD_PROBLEMS[outcome.code];
    if ((outcome.status === 422 || outcome.status === 413) && known) {
      ui.status.textContent = "";
      this.#showError(...known);
      return;
    }
    if (outcome.status === 403 && outcome.code === "closed") {
      this.#fallback(submission, "This site is not taking suggestions now, so yours was not sent.");
      return;
    }
    // The same suggestion from here within the hour: it is already waiting for review.
    if (outcome.status === 409 && outcome.code === "duplicate") {
      this.#pending = null;
      ui.status.textContent = "This suggestion was already sent and is waiting for review.";
      return;
    }
    const retry = outcome.status === 0 || outcome.status === 429 || outcome.status >= 500;
    const reason =
      outcome.status === 0
        ? "Your suggestion could not be sent: the service did not answer."
        : outcome.status === 429
          ? "Your suggestion was not sent: too many have come from here recently. Try again later."
          : outcome.status === 404 || outcome.status === 403 || outcome.code === "unavailable"
            ? "Your suggestion was not sent: this site is not taking suggestions through the form right now."
            : "Your suggestion could not be sent: the service had a problem.";
    this.#fallback(submission, reason, { retry });
  }

  #succeeded(submission, receipt) {
    const ui = this.#ui;
    this.#pending = null;
    ui.text.value = "";
    ui.status.textContent = "Sent to the editors.";
    ui.done.textContent = receipt
      ? "Thank you. Your suggestion went to the editors, who may or may not take it up. It is never published. Keep the receipt below."
      : "Thank you. Your suggestion went to the editors, who may or may not take it up. It is never published.";
    ui.done.hidden = false;
    this.#receipt?.remove();
    this.#receipt = receipt ? receiptPanel({ endpoint: this.#endpoint, receipt, consent: false, noun: "suggestion" }) : null;
    if (this.#receipt) ui.done.after(this.#receipt);
    ui.done.focus();
  }

  /** The copy-and-send path: the suggestion as plain text, retry when it may help, and the contact. */
  #fallback(submission, reason, { retry = false, lost = true } = {}) {
    const ui = this.#ui;
    const nothingLost = submission
      ? lost
        ? " Nothing you wrote was lost: try again, or copy your suggestion below and send it to the author."
        : " Copy it below to send it to the author."
      : "";
    ui.status.textContent = "";
    ui.fallbackMessage.textContent = `${reason}${nothingLost}`;
    ui.copyArea.value = submission ? suggestionCopyText(submission, this.#page) : "";
    const copyable = Boolean(submission);
    ui.copyArea.hidden = !copyable;
    ui.copyLabel.hidden = !copyable;
    ui.copyButton.hidden = !copyable;
    ui.retry.hidden = !(retry && copyable);
    if (this.#contact) ui.contactLink.href = this.#contactHref(submission);
    ui.fallback.hidden = false;
    ui.fallbackMessage.focus();
  }

  #contactHref(submission) {
    const contact = this.#contact;
    if (!contact.startsWith("mailto:") || !submission) return contact;
    const subject = `A suggestion from ${this.#page || this.#work}`;
    const withBody = `${contact}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(this.#ui.copyArea.value)}`;
    return withBody.length <= MAX_MAIL_LINK ? withBody : `${contact}?subject=${encodeURIComponent(subject)}`;
  }

  async #copy() {
    const ui = this.#ui;
    try {
      await globalThis.navigator.clipboard.writeText(ui.copyArea.value);
      ui.status.textContent = "Your suggestion was copied.";
    } catch {
      ui.copyArea.focus();
      ui.copyArea.select();
      ui.status.textContent = "Your suggestion is selected: press Control+C (or Command+C) to copy it.";
    }
  }
}

if (!customElements.get("ob-future-suggestion")) {
  customElements.define("ob-future-suggestion", ObFutureSuggestion);
}
