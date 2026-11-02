// "Set up Kin for someone" (#613, #614; ADR 0021 §4): a household admin
// prepares an invitation for one person — their name, what kind of member
// they'll be, easy mode, a note — and gets a QR code, a link and a printable
// one-page "How to open Kin" sheet. The person opens it, sees their name,
// chooses a password and waits; the admin still approves after comparing
// fingerprints, ideally side by side (the in-person path below).
//
// The person's name, the helper's name and the note travel only inside the
// card sealed on this device (security/prepared-card.js); its key and the
// code live in this page's memory while it is open and are never stored, so
// the sheet can be printed again only until Kin closes or locks. After that,
// cancel and make a new one.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { invitationLink } from "../../pairing-link.js";
import { MAX_CARD_NAME, MAX_CARD_NOTE, cardFields, sealCard } from "../../security/prepared-card.js";
import { misleadingMemberName } from "./member-labels.js";
import "../kin-qr.js";

/** How long a prepared invitation can last, in days (the service allows 1–7). */
export const SETUP_DAYS = Object.freeze([1, 3, 7]);

/** The member kinds the form offers, in plain words. */
export const SETUP_KINDS = Object.freeze([
  Object.freeze({ value: "adult", label: "A grown-up in the household" }),
  Object.freeze({ value: "limited", label: "A child or teenager" }),
  Object.freeze({ value: "temporary", label: "A babysitter, carer or guest, for a while" }),
]);

/** The day an invitation ends, in words: "Tuesday 28 October". */
export function setupDate(time, locale = undefined) {
  return new Date(time).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
}

/** The sheet's three steps, in plain words, naming the helper. */
export function sheetSteps(helper) {
  const who = helper || "the person who gave you this";
  return [
    "Open the camera on your phone or tablet and point it at the square code. Tap the link that appears.",
    "Kin says hello and asks you to choose a password. Write the password down and keep it somewhere safe.",
    `Wait for ${who} to say yes. Then Kin opens, ready for you.`,
  ];
}

/** Checks the form; returns { field: message } for each problem. Pure. */
export function setupProblems(values, now = Date.now()) {
  const problems = {};
  const name = String(values.name ?? "").trim();
  if (!name) problems.name = "Enter their name.";
  else if ([...name].length > MAX_CARD_NAME) problems.name = `Use at most ${MAX_CARD_NAME} characters.`;
  else if (misleadingMemberName(name)) problems.name = "Use their own name rather than “You”.";
  const helper = String(values.helper ?? "").trim();
  if (!helper) problems.helper = "Enter your name, so they know who to call.";
  else if ([...helper].length > MAX_CARD_NAME) problems.helper = `Use at most ${MAX_CARD_NAME} characters.`;
  if ([...String(values.note ?? "").trim()].length > MAX_CARD_NOTE) problems.note = `Use at most ${MAX_CARD_NOTE} characters.`;
  if (!SETUP_KINDS.some((kind) => kind.value === values.kind)) problems.kind = "Choose who they are.";
  if (values.kind === "temporary" && !(Number.isSafeInteger(values.memberEndsAt) && values.memberEndsAt > now))
    problems.memberEndsAt = "Choose when their access ends, in the future.";
  if (!SETUP_DAYS.includes(values.days)) problems.days = "Choose how long the invitation lasts.";
  return problems;
}

/** While the sheet is on screen, the print stylesheet prints only it
 * (app.css, `html.printing-setup-sheet`). */
export function printingSheet(on) {
  globalThis.document?.documentElement?.classList?.toggle("printing-setup-sheet", on);
}

const localDateTimeValue = (timestamp) => {
  const date = new Date(timestamp);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export class HouseholdPrepared {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    // pairingId → { code, key, fields, link }: memory only, never stored.
    this.kept = new Map();
    this.draft = null;
    this.problems = {};
  }

  /** Takes the panel for a view of this part (like People & devices). */
  takePanel(title) {
    printingSheet(false);
    clearTimeout(this.host.poll);
    clearInterval(this.host.timer);
    this.host.viewGeneration = (this.host.viewGeneration ?? 0) + 1;
    this.host.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = title;
    heading.tabIndex = -1;
    this.host.append(heading);
    return heading;
  }

  /** The member's own household name, for "If you get stuck, call …". */
  async ownName() {
    try {
      const names = (await this.host.memberNames?.load()) ?? [];
      return names.find((entry) => entry?.memberId === this.host.identity?.memberId)?.preferredName?.trim() ?? "";
    } catch {
      return "";
    }
  }

  /** People & devices → "Set up Kin for someone". */
  async start() {
    const helper = await this.ownName();
    this.draft = { name: "", kind: "adult", memberEndsAt: Date.now() + 7 * 24 * 60 * 60_000, easyMode: true, helper, note: "", days: 7 };
    this.problems = {};
    this.renderForm();
  }

  renderForm() {
    const heading = this.takePanel("Set up Kin for someone");
    this.host.text("Make Kin ready for someone who'd rather not set it up alone. You'll get a sheet to print or a link to send. They open it, choose a password, and you say yes.");
    const form = document.createElement("form");
    form.className = "setup-form";
    form.noValidate = true;
    const draft = this.draft;
    const field = (key, label, control, hint = "") => {
      const wrapper = document.createElement("div");
      wrapper.className = "setup-field";
      const caption = document.createElement("label");
      caption.htmlFor = control.id = `setup-${key}`;
      caption.textContent = label;
      wrapper.append(caption, control);
      const described = [];
      if (hint) {
        const help = document.createElement("p");
        help.id = `setup-${key}-hint`;
        help.className = "hint";
        help.textContent = hint;
        described.push(help.id);
        wrapper.append(help);
      }
      if (this.problems[key]) {
        const error = document.createElement("p");
        error.id = `setup-${key}-error`;
        error.className = "field-error";
        error.textContent = this.problems[key];
        control.setAttribute("aria-invalid", "true");
        described.push(error.id);
        wrapper.append(error);
      }
      if (described.length) control.setAttribute("aria-describedby", described.join(" "));
      form.append(wrapper);
      return wrapper;
    };
    const input = (key, { type = "text", autocomplete = "off", maxLength = null } = {}) => {
      const element = document.createElement(type === "textarea" ? "textarea" : "input");
      if (type !== "textarea") element.type = type;
      element.name = key;
      element.autocomplete = autocomplete;
      if (maxLength) element.maxLength = maxLength;
      element.value = draft[key] ?? "";
      element.addEventListener("input", () => { draft[key] = element.value; });
      return element;
    };
    field("name", "Their name", input("name", { maxLength: MAX_CARD_NAME * 4 }), "Kin greets them by it, and your household sees it.");
    // Who they are: a native radio group in a fieldset.
    const kinds = document.createElement("fieldset");
    kinds.className = "setup-kinds";
    const legend = document.createElement("legend");
    legend.textContent = "Who they are";
    kinds.append(legend);
    for (const option of SETUP_KINDS) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "kind";
      radio.value = option.value;
      radio.checked = draft.kind === option.value;
      radio.addEventListener("change", () => { draft.kind = option.value; this.renderForm(); });
      label.append(radio, document.createTextNode(` ${option.label}`));
      kinds.append(label);
    }
    if (this.problems.kind) {
      const error = document.createElement("p");
      error.className = "field-error";
      error.textContent = this.problems.kind;
      kinds.append(error);
    }
    form.append(kinds);
    if (draft.kind === "temporary") {
      const ends = input("memberEndsAt", { type: "datetime-local" });
      ends.value = localDateTimeValue(draft.memberEndsAt);
      ends.min = localDateTimeValue(Date.now() + 60_000);
      ends.addEventListener("input", () => { draft.memberEndsAt = Date.parse(ends.value); });
      field("memberEndsAt", "Their access ends", ends, "Uses this device's local time.");
    }
    const easy = document.createElement("label");
    easy.className = "setup-easy";
    const easyBox = document.createElement("input");
    easyBox.type = "checkbox";
    easyBox.name = "easyMode";
    easyBox.checked = draft.easyMode;
    easyBox.addEventListener("change", () => { draft.easyMode = easyBox.checked; });
    easy.append(easyBox, document.createTextNode(" Start in easy mode: bigger text and buttons, fewer things on screen. They can turn it off."));
    form.append(easy);
    field("helper", "Your name", input("helper", { autocomplete: "nickname", maxLength: MAX_CARD_NAME * 4 }), "Shown to them as the person to call if they get stuck.");
    field("note", "A note for them (optional)", input("note", { type: "textarea", maxLength: MAX_CARD_NOTE * 4 }), "For example: “Call me when you get this and I'll help.”");
    const days = document.createElement("select");
    days.name = "days";
    for (const count of SETUP_DAYS) {
      const option = document.createElement("option");
      option.value = String(count);
      option.textContent = count === 1 ? "1 day" : `${count} days, until ${setupDate(Date.now() + count * 24 * 60 * 60_000)}`;
      option.selected = draft.days === count;
      days.append(option);
    }
    days.addEventListener("change", () => { draft.days = Number(days.value); });
    field("days", "The invitation works for", days, "Long enough to post the sheet. It works once.");
    const actions = document.createElement("div");
    actions.className = "setup-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = "Make the invitation";
    actions.append(submit, this.host.makeButton("Back", () => this.ctx.membership.showDevices(), "secondary"));
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.create();
    });
    this.host.append(form);
    const first = form.querySelector('[aria-invalid="true"]');
    queueMicrotask(() => (first ?? heading).focus());
  }

  async create() {
    const draft = this.draft;
    const problems = setupProblems(draft);
    if (Object.keys(problems).length) {
      this.problems = problems;
      this.renderForm();
      return;
    }
    this.problems = {};
    let made = null;
    await this.host.run(async () => {
      const fields = cardFields(draft);
      const { card, key } = await sealCard(fields);
      const pairing = await this.host.api("/api/pairings/prepared", {
        method: "POST",
        body: JSON.stringify({
          kind: draft.kind,
          ...(draft.kind === "temporary" ? { expiresAt: draft.memberEndsAt } : {}),
          easyMode: Boolean(draft.easyMode),
          card,
          days: draft.days,
        }),
      });
      // As for any invitation: the service's record of this device's key
      // must be the key this device holds before anything is shown.
      if (!this.host.localFingerprint || pairing.inviterKeyFingerprint !== this.host.localFingerprint)
        throw new Error("This device's approved key does not match its local key.");
      this.kept.set(pairing.pairingId, { code: pairing.code, key, fields, link: invitationLink(location.origin, pairing.code, key) });
      made = pairing;
    });
    if (!made) return;
    this.draft = null;
    this.open(made);
  }

  /** Shows one prepared invitation (it becomes the panel's pairing, so the
   * pairing part's polling, approval and cancelling apply). */
  open(view) {
    const { code: _code, ...rest } = view;
    this.host.pairing = rest;
    this.host.verifiedFingerprint = null;
    this.host.render();
  }

  /** Who the invitation is for, as far as this page knows. */
  nameOf(pairingId) {
    return this.kept.get(pairingId)?.fields.name ?? "";
  }

  /** The admin's view of a prepared invitation (views.js renderMember calls
   * this while the panel's pairing is a prepared one). */
  renderPairing() {
    const pairing = this.host.pairing;
    const kept = this.kept.get(pairing.pairingId);
    const name = kept?.fields.name ?? "";
    const lapsed = pairing.state === "Pending" && Number.isFinite(pairing.expiresAt) && pairing.expiresAt <= Date.now();
    const state = lapsed ? "Expired" : pairing.state;
    const title = document.createElement("h3");
    title.className = "pairing-path";
    const status = document.createElement("p");
    status.className = "pairing-state";
    status.setAttribute("role", "status");
    this.host.append(title, status);
    const actions = document.createElement("div");
    actions.className = "pairing-actions setup-pairing-actions";
    if (state === "Pending") {
      title.textContent = name ? `${name}'s invitation is ready` : "Your invitation is ready";
      status.textContent = `Give ${name || "them"} the setup sheet, or send the link. It works once, until ${setupDate(pairing.invitationExpiresAt ?? pairing.expiresAt)}.`;
      if (kept) {
        const qr = document.createElement("kin-qr");
        qr.className = "pairing-qr";
        qr.label = `QR code that opens Kin for ${name}.`;
        qr.expiredMessage = "This invitation ended.";
        qr.code = "";
        qr.value = kept.link;
        qr.expiresAt = pairing.invitationExpiresAt ?? pairing.expiresAt;
        const code = document.createElement("output");
        code.className = "pairing-code";
        code.textContent = kept.code;
        code.setAttribute("aria-label", `Invitation code ${[...kept.code].join(" ")}`);
        this.host.append(qr, code);
        const print = this.host.makeButton("Print the setup sheet", () => this.renderSheet(pairing.pairingId), "primary-action");
        print.className += " setup-print";
        actions.append(print, this.host.makeButton("Share the link", () => this.share(pairing.pairingId), "secondary"));
      } else {
        this.host.text("Kin doesn't keep the code, so the sheet can't be printed again. To make a new sheet, cancel this invitation and set it up again.");
      }
      actions.append(this.host.makeButton("Cancel this invitation", () => this.ctx.pairing.revoke(), "danger"));
    } else if (state === "Claimed") {
      title.textContent = name ? `${name} is joining` : "Someone is joining";
      status.textContent = `${pairing.deviceLabel || "Their phone or computer"} is waiting for you to say yes.`;
      this.host.text(`If you're with ${name || "them"}, look at both screens: their screen shows a code. Say yes only if it matches this one.`);
      this.host.text(`If you're not together, call ${name || "them"} and ask them to read their code to you.`);
      const fingerprint = pairing.syncKeyFingerprint;
      const shown = this.host.showFingerprint(`${name ? `${name}'s` : "Their"} code`, fingerprint);
      if (shown) shown.className += " setup-fingerprint";
      const approve = this.host.makeButton(name ? `Yes, let ${name} in` : "Yes, let them in", () => this.ctx.pairing.approve(), "primary-action");
      this.host.setControlDisabled(approve, !fingerprint || this.host.verifiedFingerprint !== fingerprint);
      if (fingerprint) {
        const label = document.createElement("label");
        label.className = "setup-match";
        const confirmation = document.createElement("input");
        confirmation.type = "checkbox";
        confirmation.checked = this.host.verifiedFingerprint === fingerprint;
        confirmation.addEventListener("change", () => {
          this.host.verifiedFingerprint = confirmation.checked ? fingerprint : null;
          this.host.setControlDisabled(approve, !confirmation.checked);
        });
        label.append(confirmation, document.createTextNode(" The codes match on both screens."));
        actions.append(label);
      } else {
        this.host.message("This device has no code to compare. Cancel and set Kin up again.", true);
      }
      actions.append(approve, this.host.makeButton("Cancel this invitation", () => this.ctx.pairing.revoke(), "danger"));
    } else if (state === "Confirmed") {
      title.textContent = name ? `${name} is in` : "They're in";
      status.textContent = `One last step on ${name ? `${name}'s` : "their"} screen: it asks whether its code matches this one. Show them, or read it to them.`;
      const shown = this.host.showFingerprint("Your code", this.host.localFingerprint);
      if (shown) shown.className += " setup-fingerprint";
      actions.append(this.host.makeButton("Done", () => { this.host.pairing = null; this.host.render(); }, "primary-action"));
    } else {
      title.textContent = "This invitation ended";
      status.textContent = state === "Revoked" ? "It was cancelled." : "It ran out of time. Set Kin up again to make a new one.";
      this.kept.delete(pairing.pairingId);
      actions.append(this.host.makeButton("Back to household", () => { this.host.pairing = null; this.host.render(); }, "secondary"));
    }
    if (["Pending", "Claimed"].includes(state))
      actions.append(this.host.makeButton("Back", () => this.ctx.membership.showDevices(), "secondary"));
    this.host.append(actions);
    if (["Pending", "Claimed"].includes(state)) this.ctx.pairing.pollPairing();
  }

  async share(pairingId) {
    const kept = this.kept.get(pairingId);
    if (!kept) return;
    const text = `${kept.fields.helper} set up Kin for you. Open this link on your phone or tablet, choose a password, and wait for ${kept.fields.helper} to say yes.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Kin is ready for you", text, url: kept.link });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(kept.link);
      this.host.message("Link copied. Send it only to them: it works once.");
    } catch {
      this.host.message(`Send them this address: ${kept.link}`, true);
    }
  }

  /** The one-page "How to open Kin" sheet (#614): large type, the QR code,
   * the link and the code, three steps, who to call and when it ends. The
   * print stylesheet (app.css, .setup-sheet) prints only the sheet. */
  renderSheet(pairingId) {
    const kept = this.kept.get(pairingId);
    const pairing = this.host.pairing;
    if (!kept || pairing?.pairingId !== pairingId) return;
    this.takePanel("Setup sheet");
    this.host.text("Print this page, or show it on this screen. Only the sheet below is printed.");
    const sheet = document.createElement("section");
    sheet.className = "setup-sheet";
    sheet.setAttribute("aria-labelledby", "setup-sheet-title");
    const title = document.createElement("h2");
    title.id = "setup-sheet-title";
    title.textContent = "How to open Kin";
    const greeting = document.createElement("p");
    greeting.className = "setup-sheet-for";
    greeting.textContent = `For ${kept.fields.name}, from ${kept.fields.helper}`;
    const qr = document.createElement("kin-qr");
    qr.className = "setup-sheet-qr";
    qr.size = 320;
    qr.label = `QR code that opens Kin for ${kept.fields.name}.`;
    qr.code = "";
    qr.value = kept.link;
    const steps = document.createElement("ol");
    steps.className = "setup-sheet-steps";
    for (const step of sheetSteps(kept.fields.helper)) {
      const item = document.createElement("li");
      item.textContent = step;
      steps.append(item);
    }
    const link = document.createElement("p");
    link.className = "setup-sheet-link";
    link.append(document.createTextNode("No camera? Type this address into the internet browser: "));
    const address = document.createElement("span");
    address.className = "setup-sheet-address";
    address.textContent = kept.link;
    link.append(address);
    const code = document.createElement("p");
    code.className = "setup-sheet-code";
    code.append(document.createTextNode(`Or go to ${location.host}/pair and type this code: `));
    const codeValue = document.createElement("strong");
    codeValue.textContent = kept.code;
    code.append(codeValue);
    sheet.append(title, greeting, qr, steps, link, code);
    if (kept.fields.note) {
      const note = document.createElement("p");
      note.className = "setup-sheet-note";
      note.textContent = `“${kept.fields.note}” — ${kept.fields.helper}`;
      sheet.append(note);
    }
    const call = document.createElement("p");
    call.className = "setup-sheet-call";
    call.textContent = `If you get stuck, call ${kept.fields.helper}.`;
    const ends = document.createElement("p");
    ends.className = "setup-sheet-ends";
    ends.textContent = `This sheet works once, until ${setupDate(pairing.invitationExpiresAt ?? pairing.expiresAt)}. Keep it private: anyone with it can ask to join.`;
    sheet.append(call, ends);
    const actions = document.createElement("div");
    actions.className = "setup-sheet-actions";
    actions.append(
      this.host.makeButton("Print", () => globalThis.print?.(), "primary-action"),
      this.host.makeButton("Back", () => this.host.render(), "secondary"),
    );
    this.host.append(sheet, actions);
    printingSheet(true);
  }

  /** People & devices: the prepared invitations still waiting, each one
   * tap from its view. */
  async waitingList() {
    let invitations = [];
    try {
      ({ invitations } = await this.host.api("/api/pairings/prepared"));
    } catch {
      return null;
    }
    if (!invitations?.length) return null;
    const section = document.createElement("section");
    section.className = "setup-waiting";
    const heading = document.createElement("h3");
    heading.textContent = "Invitations you set up";
    const list = document.createElement("ul");
    for (const view of invitations) {
      const item = document.createElement("li");
      const name = this.nameOf(view.pairingId);
      const words = document.createElement("span");
      words.textContent = view.state === "Claimed"
        ? `${name || "Someone"} is asking to join`
        : `${name ? `For ${name}` : "Waiting to be opened"}, until ${setupDate(view.invitationExpiresAt ?? view.expiresAt)}`;
      item.append(words, this.host.makeButton(view.state === "Claimed" ? "Check and say yes" : "Open", () => this.open(view), view.state === "Claimed" ? "primary-action" : "secondary"));
      list.append(item);
    }
    section.append(heading, list);
    return section;
  }
}
