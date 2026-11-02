// Reader receipts (ADR 0107). When the hosted service takes a note, it returns a private receipt
// once: a random secret only the reader holds, kept by the service only as its digest. With it the
// reader can check on the note, agree to be asked to clarify it, answer a clarification request, or
// withdraw the note and have its text and their name deleted. Nothing is e-mailed, no account is
// asked for, and nothing is stored in the browser: the reader keeps the receipt themselves.
//
// Untrusted text is only ever assigned through textContent.

/** What a reader is told about letting an editor feature their reflection (ADR 0176, 0177, 0179). */
export const FEATURE_CONSENT_LABEL = "An editor may feature this reflection in a community section";
export const FEATURE_CONSENT_HINT = "This is separate from publishing it. It covers the text as it is now, shown whole, with an optional short note from the editors, and is the editors’ choice, which does not mean anyone agrees with it. If your text changes you are asked again. Untick it to stop: the reflection stays published, and the feature is taken down when the editors next update the site. You can agree again from this receipt. Copies already published may remain.";

const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const SEND_TIMEOUT = 20_000;
let counter = 0;

/** Whether `value` looks like a receipt the hosted service issues. */
export function isReceipt(value) {
  return typeof value === "string" && RECEIPT.test(value.trim());
}

const CLARIFY_REASONS = Object.freeze({
  unclear: "it was not clear",
  "needs-source": "it needs a source",
  "personal-data": "it contains someone’s personal data",
  other: "of something else in it",
});

const PERSPECTIVE = "third-perspective";
const SUGGESTION = "future-suggestion";

/** What the reader sent, in words: a Third Perspective is their reflection, a suggestion for future work their suggestion, anything else a note. */
export function receiptNoun(item) {
  return item?.kind === PERSPECTIVE ? "reflection" : item?.kind === SUGGESTION ? "suggestion" : "note";
}

/**
 * A suggestion for future work's state, in words (ADR 0156). It is never shown on the site, so
 * nothing here says it is published, and accepting it only means the editors are interested: it
 * is not agreement, a check or permission to use it.
 */
function suggestionStateText(item, purged) {
  // Where it stands, as the service derived it (ADR 0163): a stage and one sentence that never ranks,
  // counts, promises or says what it was linked to. Nothing is added to it here.
  const note = typeof item.standing?.note === "string" && item.standing.note !== "" ? ` ${item.standing.note}` : "";
  const linked = item.standing?.id === "converted" || item.standing?.id === "closed-converted";
  switch (item.status) {
    case "pending":
      return "Waiting for the editors’ review. It is private to them: nothing about it is shown on the site.";
    case "clarification": {
      const why = CLARIFY_REASONS[item.clarification?.reason];
      return `The editors asked you to clarify this suggestion${why ? ` because ${why}` : ""}. Your answer replaces it and goes back for review; what you first wrote is not used.`;
    }
    case "approved":
      return `${linked ? "Linked to future work. " : ""}Accepted means the editors are interested in exploring this. It does not mean they agree with it, have checked it, or have permission to use it.${linked ? note : ""} It is private to them and is not shown on the site.`;
    case "rejected":
      return `The editors decided not to take it forward.${note}${purged}`;
    case "removed":
      return linked ? `The editors closed it, after linking it to future work.${note}${purged}` : `The editors closed it.${note}${purged}`;
    case "withdrawn":
      return `You withdrew it.${purged}`;
    default:
      return "Its state is not one this page knows.";
  }
}

/**
 * A Third Perspective's state, in words (ADR 0115): waiting, asked to clarify, approved and shown
 * as a reader's reflection, not published, or withdrawn. Pending never reads as published, and
 * nothing says who decided or why beyond a clarification request's reason.
 */
function perspectiveStateText(item, purged) {
  switch (item.status) {
    case "pending":
      return "Waiting for a moderator’s review. It is not published: nothing is shown unless a moderator approves it, and then only as you agreed.";
    case "clarification": {
      const why = CLARIFY_REASONS[item.clarification?.reason];
      return `A moderator asked you to clarify this reflection${why ? ` because ${why}` : ""}. It is not published. Your answer replaces it and goes back for review; what you first wrote is never published.`;
    }
    case "approved":
      if (item.published === null) return "Approved. This page cannot tell whether it is shown on the work’s page now; the author can.";
      return item.published
        ? "Approved; it appears on the work’s page as a reader’s reflection, as you agreed, once the site is updated."
        : "Approved, but not shown: it is published only while your consent allows it and the site takes reflections.";
    case "rejected":
      return `Not published: it will not be shown on the work’s page.${purged}`;
    case "removed":
      return `Not published any more: it was taken off the work’s page.${purged}`;
    case "withdrawn":
      return `You withdrew it, so it is not published.${purged}`;
    default:
      return "Its state is not one this page knows.";
  }
}

/** What a reader is told about their note's state, in words. */
export function receiptStateText(item) {
  if (!item || typeof item !== "object") return "";
  const purged = item.purged ? " Its text and your name were deleted; only a private record that it existed and what was decided remains." : "";
  if (item.kind === PERSPECTIVE) return perspectiveStateText(item, purged);
  if (item.kind === SUGGESTION) return suggestionStateText(item, purged);
  switch (item.status) {
    case "pending":
      return "Waiting for the author’s review. Nothing is published unless they approve it.";
    case "clarification": {
      const why = CLARIFY_REASONS[item.clarification?.reason];
      return `The author asked you to clarify this note${why ? ` because ${why}` : ""}. Your answer replaces it and goes back for review; what you first wrote is never published.`;
    }
    case "approved":
      return item.published ? "Approved and published on the post." : "Approved.";
    case "rejected":
      return `The author decided not to publish it.${purged}`;
    case "removed":
      return `The author took it off the post.${purged}`;
    case "withdrawn":
      return `You withdrew it.${purged}`;
    default:
      return "Its state is not one this page knows.";
  }
}

/** What a reader is told when a receipt request fails, from the hosted answer. */
export function receiptProblem(status, code) {
  if (status === 404 && code === "unknownReceipt") return "No note matches this receipt. Check that you copied all of it.";
  if (status === 404) return "This site does not offer receipts right now. You can write to the author instead.";
  if (status === 409) return "Your note changed since you looked it up. Here it is as it is now.";
  if (status === 429) return "Too many requests have come from here recently. Please try again later.";
  if (status === 422) return code === "contentPurged" ? "This note’s text was already deleted." : "That could not be done with this note now.";
  if (status === 0) return "The service did not answer. Check your connection and try again.";
  return "Something went wrong. Please try again later, or write to the author.";
}

async function call(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT);
  try {
    if (globalThis.navigator?.onLine === false) return { status: 0, data: {} };
    const response = await fetch(`${endpoint}/receipt`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const labelled = (control, id, text) => {
  control.id = id;
  const label = make("label", undefined, text);
  label.htmlFor = id;
  return label;
};

/**
 * The panel a reader sees after sending a note: their receipt, ready to copy, what it is for, and
 * whether the author may ask them to clarify the note through it. `consent` is what the reader
 * already chose when sending (a Third Perspective asks first), and `noun` names what they sent.
 */
export function receiptPanel({ endpoint, receipt, consent: initialConsent = false, noun = "note", feature: initialFeature = null }) {
  counter += 1;
  const prefix = `ob-receipt-${counter}`;
  const panel = make("section", "ob-receipt");
  const title = make("h3", undefined, "Your private receipt");
  title.id = `${prefix}-title`;
  panel.setAttribute("aria-labelledby", title.id);
  const explain = make("p", undefined, `Keep this receipt to check on your ${noun}, answer the author if they ask you to clarify it, or withdraw it and have it deleted. It is shown only once and is the only way to reach your ${noun}: nothing is e-mailed to you and nothing is saved in this browser.`);
  explain.id = `${prefix}-explain`;
  const field = make("input");
  field.type = "text";
  field.readOnly = true;
  field.value = receipt;
  field.spellcheck = false;
  field.setAttribute("aria-describedby", explain.id);
  const copy = make("button", undefined, "Copy receipt");
  copy.type = "button";
  const status = make("p", "ob-receipt-status");
  status.setAttribute("role", "status");
  const consent = make("input");
  consent.type = "checkbox";
  consent.checked = initialConsent === true;
  const row = make("p", "ob-receipt-consent");
  row.append(consent, " ", labelled(consent, `${prefix}-consent`, `The author may ask me to clarify this ${noun} through this receipt`));
  panel.append(title, explain, labelled(field, `${prefix}-field`, "Receipt"), field, copy, row);
  let version = 1;
  // Whether an editor may feature a reflection: its own choice, for the revision the reader sees.
  let feature = initialFeature;
  if (feature) {
    const box = make("input");
    box.type = "checkbox";
    box.checked = feature.agreed === true;
    const featureHint = make("p", "ob-receipt-hint", FEATURE_CONSENT_HINT);
    featureHint.id = `${prefix}-feature-hint`;
    box.setAttribute("aria-describedby", featureHint.id);
    const featureRow = make("p", "ob-receipt-feature");
    featureRow.append(box, " ", labelled(box, `${prefix}-feature`, FEATURE_CONSENT_LABEL));
    panel.append(featureRow, featureHint);
    box.addEventListener("change", async () => {
      const wanted = box.checked;
      box.disabled = true;
      status.textContent = "Saving…";
      const { status: code, data } = await call(endpoint, { receipt, action: "feature", consent: wanted, ...(wanted ? { revisionSeen: feature.revision } : {}), expectedVersion: version });
      box.disabled = false;
      box.focus();
      if (code === 200 && data.item) {
        version = data.item.version;
        feature = data.item.feature || feature;
        box.checked = feature.agreed === true;
        status.textContent = box.checked ? "Saved: an editor may feature this text." : "Saved: it will not be featured.";
      } else {
        box.checked = data.item?.feature ? data.item.feature.agreed === true : !wanted;
        if (data.item?.version) version = data.item.version;
        status.textContent = code === 409 ? `Your ${noun} changed since you sent it, so this was not saved. Try again.` : receiptProblem(code, data.code);
      }
    });
  }
  panel.append(status);
  copy.addEventListener("click", async () => {
    try {
      await globalThis.navigator.clipboard.writeText(receipt);
      status.textContent = "Your receipt was copied. Keep it somewhere safe.";
    } catch {
      field.focus();
      field.select();
      status.textContent = "Your receipt is selected: press Control+C (or Command+C) to copy it.";
    }
  });
  consent.addEventListener("change", async () => {
    const wanted = consent.checked;
    consent.disabled = true;
    status.textContent = "Saving…";
    const { status: code, data } = await call(endpoint, { receipt, action: "consent", consent: wanted, expectedVersion: version });
    consent.disabled = false;
    // Disabling the box while saving took focus from it; give it back to the reader.
    consent.focus();
    if (code === 200 && data.item) {
      version = data.item.version;
      consent.checked = data.item.consent === true;
      status.textContent = consent.checked ? `Saved: the author may ask you to clarify this ${noun}.` : `Saved: the author will not ask you to clarify this ${noun}.`;
    } else {
      consent.checked = data.item ? data.item.consent === true : !wanted;
      if (data.item?.version) version = data.item.version;
      status.textContent = code === 409 ? `Your ${noun} changed since you sent it, so this was not saved. Try again.` : receiptProblem(code, data.code);
    }
  });
  return panel;
}

/**
 * A disclosure where a reader enters a receipt to check on a note they sent, answer a
 * clarification request, or withdraw the note and have it deleted.
 */
export function receiptManager({ endpoint, noun: managed = "note" }) {
  counter += 1;
  const prefix = `ob-receipt-manage-${counter}`;
  const details = make("details", "ob-receipt-manage");
  details.append(make("summary", undefined, `Check, clarify or withdraw a ${managed} you sent`));
  const form = make("form");
  form.noValidate = true;
  const input = make("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  const hint = make("p", "ob-receipt-hint", `Paste the receipt you were given when you sent the ${managed}.`);
  hint.id = `${prefix}-hint`;
  input.setAttribute("aria-describedby", hint.id);
  const look = make("button", undefined, `Look up my ${managed}`);
  look.type = "submit";
  form.append(labelled(input, `${prefix}-receipt`, "Your receipt"), hint, input, look);
  const status = make("p", "ob-receipt-status");
  status.setAttribute("role", "status");
  status.tabIndex = -1;
  const result = make("div", "ob-receipt-result");
  details.append(form, status, result);

  let receipt = "";
  const show = (item, message) => {
    result.replaceChildren();
    if (!item) return;
    const noun = receiptNoun(item);
    const where = item.kind === PERSPECTIVE ? "the work’s page" : item.kind === SUGGESTION ? "the editors’ list" : "the post";
    // Only a published kind has anything to take off a page; a suggestion was never on one, and keeps
    // a contact address a note does not.
    const publicKind = item.kind !== SUGGESTION;
    const heading = make("h3", undefined, `Your ${noun}`);
    heading.id = `${prefix}-note-title`;
    heading.tabIndex = -1;
    const state = make("p", "ob-receipt-state", receiptStateText(item));
    result.append(heading, state);
    if (!item.purged && typeof item.body === "string") {
      result.append(make("p", "ob-receipt-label", "What you wrote:"), make("blockquote", "ob-receipt-body", item.body));
    }
    if (item.kind === PERSPECTIVE && item.feature && !item.purged) {
      // The reader's own choice about featuring, for the text they see (ADR 0176, 0177). An agreement
      // for an earlier text is said plainly: it does not cover this one.
      const box = make("input");
      box.type = "checkbox";
      box.checked = item.feature.agreed === true;
      const boxHint = make("p", "ob-receipt-hint", item.feature.earlier ? `You agreed to feature an earlier text. That does not cover this one. ${FEATURE_CONSENT_HINT}` : FEATURE_CONSENT_HINT);
      boxHint.id = `${prefix}-feature-hint`;
      box.setAttribute("aria-describedby", boxHint.id);
      const boxRow = make("p", "ob-receipt-feature");
      boxRow.append(box, " ", labelled(box, `${prefix}-feature`, FEATURE_CONSENT_LABEL));
      box.addEventListener("change", async () => {
        const wanted = box.checked;
        box.disabled = true;
        status.textContent = "Saving…";
        const { status: code, data } = await call(endpoint, { receipt, action: "feature", consent: wanted, ...(wanted ? { revisionSeen: item.feature.revision } : {}), expectedVersion: item.version });
        if (code === 200 && data.item) show(data.item, wanted ? "Saved: an editor may feature this text." : "Saved: it will not be featured.");
        else if (code === 409 && data.item) show(data.item, receiptProblem(code, data.code));
        else {
          box.disabled = false;
          box.checked = !wanted;
          box.focus();
          status.textContent = receiptProblem(code, data.code);
        }
      });
      result.append(boxRow, boxHint);
    }
    if (item.kind === SUGGESTION && item.credit && !item.purged) {
      // Whether the editors may credit them by the name they gave, for this text as it stands (ADR
      // 0167). Agreement is for one version of the text: after a clarification they are asked again.
      const credit = make("input");
      credit.type = "checkbox";
      credit.checked = item.credit.agreed === true;
      const creditHint = make("p", "ob-receipt-hint", "This covers the suggestion as it is now. If you change its text, tick it again. Nothing is published or sent by ticking it: only an editor can choose to thank you.");
      creditHint.id = `${prefix}-credit-hint`;
      credit.setAttribute("aria-describedby", creditHint.id);
      const creditRow = make("p", "ob-receipt-credit");
      creditRow.append(credit, " ", labelled(credit, `${prefix}-credit`, "The editors may credit me by the name I gave for this suggestion"));
      credit.addEventListener("change", async () => {
        const wanted = credit.checked;
        credit.disabled = true;
        status.textContent = "Saving…";
        const { status: code, data } = await call(endpoint, { receipt, action: "credit", consent: wanted, expectedVersion: item.version });
        if (code === 200 && data.item) show(data.item, wanted ? "Saved: the editors may credit you by your name for this text." : "Saved: the editors may not credit you by name.");
        else if (code === 409 && data.item) show(data.item, receiptProblem(code, data.code));
        else {
          credit.disabled = false;
          credit.checked = !wanted;
          credit.focus();
          status.textContent = receiptProblem(code, data.code);
        }
      });
      result.append(creditRow, creditHint);
    }
    if (item.status === "clarification" && item.clarification && !item.purged) {
      const answer = make("textarea");
      answer.rows = 5;
      answer.value = item.body || "";
      const answerHint = make("p", "ob-receipt-hint", `Your answer replaces the ${noun} and goes back to ${noun === "note" ? "the author" : noun === "suggestion" ? "the editors" : "a moderator"} for review.`);
      answerHint.id = `${prefix}-answer-hint`;
      answer.setAttribute("aria-describedby", answerHint.id);
      const send = make("button", undefined, `Send my clarified ${noun}`);
      send.type = "button";
      send.addEventListener("click", async () => {
        if (!answer.value.trim()) {
          status.textContent = `Write your clarified ${noun} first.`;
          answer.focus();
          return;
        }
        send.disabled = true;
        status.textContent = "Sending…";
        const { status: code, data } = await call(endpoint, { receipt, action: "clarify", expectedVersion: item.version, body: answer.value, ...(item.details && Object.keys(item.details).length ? { details: item.details } : {}) });
        send.disabled = false;
        if (code === 200 && data.item) show(data.item, `Thank you. Your clarified ${noun} was sent for review.`);
        else if (code === 409 && data.item) show(data.item, receiptProblem(code, data.code));
        else {
          status.textContent = code === 422 && data.error ? `Your note could not be sent: ${data.error}.` : receiptProblem(code, data.code);
          answer.focus();
        }
      });
      result.append(labelled(answer, `${prefix}-answer`, `Your clarified ${noun}`), answerHint, answer, send);
    }
    if (!item.purged) {
      const confirm = make("input");
      confirm.type = "checkbox";
      const withdraw = make("button", undefined, `Withdraw and delete my ${noun}`);
      withdraw.type = "button";
      const confirmRow = make("p", "ob-receipt-confirm");
      confirmRow.append(confirm, " ", labelled(confirm, `${prefix}-confirm`, item.status === "approved" && publicKind ? `I want this ${noun} taken off ${where}${item.kind === PERSPECTIVE ? " and out of any community section it is featured in" : ""} and the hosted copy of its text and my name deleted. I understand that copies already published (the site’s history, feeds and the repository’s history) may remain, and that a feature or a name that was published stays in them. This cannot be undone.` : `I want this ${noun}’s ${publicKind ? "text and my name" : "text, my name and any contact address I gave"} deleted. This cannot be undone.`));
      withdraw.addEventListener("click", async () => {
        if (!confirm.checked) {
          status.textContent = `Confirm that you want the ${noun} deleted first.`;
          confirm.focus();
          return;
        }
        withdraw.disabled = true;
        status.textContent = "Withdrawing…";
        const { status: code, data } = await call(endpoint, { receipt, action: "withdraw", expectedVersion: item.version });
        withdraw.disabled = false;
        if (code === 200 && data.item) show(data.item, item.status === "approved" && publicKind ? `Your ${noun} was withdrawn and the hosted copy of its text and your name deleted. The author has been shown that it must come off ${where}. Copies already published (the site’s history, feeds and the repository’s history) may remain.` : `Your ${noun} was withdrawn and its ${publicKind ? "text and your name" : "text, your name and any contact address"} deleted.`);
        else if (code === 409 && data.item) show(data.item, receiptProblem(code, data.code));
        else {
          // Disabling the button while sending took focus from it: the reader is taken to why.
          status.textContent = receiptProblem(code, data.code);
          status.focus();
        }
      });
      result.append(make("h4", undefined, "Withdraw it"), confirmRow, withdraw);
    }
    status.textContent = message || "";
    (message ? status : heading).focus();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    input.removeAttribute("aria-invalid");
    if (!isReceipt(value)) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = "That is not a receipt: it is 43 letters, digits, hyphens and underscores.";
      input.focus();
      return;
    }
    receipt = value;
    look.setAttribute("aria-disabled", "true");
    status.textContent = `Looking up your ${managed}…`;
    const { status: code, data } = await call(endpoint, { receipt, action: "read" });
    look.removeAttribute("aria-disabled");
    if (code === 200 && data.item) show(data.item, "");
    else {
      result.replaceChildren();
      status.textContent = receiptProblem(code, data.code);
      status.focus();
    }
  });
  return details;
}
