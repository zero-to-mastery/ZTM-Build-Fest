// The setup page (ADR 0025 §10, #719), one step at a time: the name (with
// a live check through the relay), Let's Encrypt's terms, an own domain's
// DNS records, connecting, the certificate, and then opening Kin at its new
// address to create the household with Kin's normal first run.
//
// `view` is the server's setup view (server/home/setup.mjs); every action
// answers with the next one, which this element passes up in a "view"
// event so the panel keeps one copy. Focus moves to the step's heading when
// the step changes, so a screen reader hears where it is.
import { el } from "./dom.js";
import { explain, explainCertificateState, explainTunnelState } from "./explain.js";
import { formatDate, formatDateTime } from "./format.js";

const CHECK_DELAY_MS = 600;
const STEPS = [
  ["name", "Name"],
  ["terms", "Agreement"],
  ["records", "DNS records"],
  ["connect", "Connect"],
  ["certificate", "Certificate"],
  ["done", "Open Kin"],
];
const STEP_OF = { connecting: "certificate" };
const RECORD_CHECKS = {
  relay: "The relay",
  address: "A and AAAA records",
  txt: "TXT record",
  caa: "CAA record",
  ech: "No Encrypted Client Hello",
};
const AVAILABILITY = {
  available: "Available.",
  taken: "Taken: that name belongs to another home server.",
  "not-allowed": "The relay doesn't allow that name.",
  limit: "This server already has a free name, or too many names were checked. Wait a minute.",
  "not-proven": "The relay can use this domain once its DNS records are in place (the next steps).",
  unknown: "The relay can't check names ahead of time; it will tell when Kin connects.",
};

export class KinControlSetup extends HTMLElement {
  #view = null;
  #renderedStep = null;

  constructor() {
    super();
    this.api = null;
    this.kind = null;
    this.editingName = false;
    this.busy = false;
    this.checkTimer = null;
    this.checkGeneration = 0;
    this.termsUrl = null;
  }

  get view() { return this.#view; }
  set view(value) {
    // Polling sends the same view again and again; redraw only on a change,
    // so typing and focus aren't disturbed.
    if (this.#view && JSON.stringify(value) === JSON.stringify(this.#view)) return;
    this.#view = value;
    this.render();
  }

  disconnectedCallback() { clearTimeout(this.checkTimer); }

  get step() {
    const step = this.#view?.step ?? "name";
    return this.editingName && ["terms", "records", "connect"].includes(step) ? "name" : step;
  }

  #publish(view) {
    this.editingName = false;
    this.dispatchEvent(new CustomEvent("view", { detail: view, bubbles: true }));
  }

  /** Runs `action` once at a time, shows its error in plain words. */
  async #run(action, button) {
    if (this.busy) return;
    this.busy = true;
    if (button) button.disabled = true;
    this.#say("");
    try {
      const view = await action();
      if (view?.step) this.#publish(view);
    } catch (error) {
      this.#say(explain(error.code), true);
    } finally {
      this.busy = false;
      if (button) button.disabled = false;
    }
  }

  #say(text, alert = false) {
    if (!this.message) return;
    this.message.setAttribute("role", alert ? "alert" : "status");
    this.message.textContent = text;
  }

  render() {
    const view = this.#view;
    if (!view) { this.replaceChildren(); return; }
    const step = this.step;
    const ownDomain = view.freeName === false;
    this.message = el("p", { className: "control-message", role: "status" });
    const visible = STEPS.filter(([id]) => id !== "records" || ownDomain);
    const current = STEP_OF[step] ?? step;
    const progress = el("ol", { className: "control-steps", "aria-label": "Setup steps" },
      visible.map(([id, label]) => el("li", { "aria-current": id === current ? "step" : null, "data-done": visible.findIndex(([value]) => value === id) < visible.findIndex(([value]) => value === current) ? "true" : null, text: label })));
    const body = {
      name: () => this.#nameStep(),
      terms: () => this.#termsStep(),
      records: () => this.#recordsStep(),
      connect: () => this.#connectStep(),
      connecting: () => this.#progressStep(),
      certificate: () => this.#progressStep(),
      done: () => this.#doneStep(),
    }[step]?.() ?? [el("p", { text: "Kin is getting ready…" })];
    // replaceChildren would turn a null into the text "null".
    this.replaceChildren(progress, ...body.filter(Boolean), this.message);
    if (this.#renderedStep !== null && this.#renderedStep !== step) this.querySelector?.("#control-step-title")?.focus();
    this.#renderedStep = step;
  }

  #title(text) { return el("h2", { id: "control-step-title", tabIndex: -1, text }); }

  // ---------------------------------------------------------------- name

  #nameStep() {
    const view = this.#view;
    const refused = view.progress?.tunnel?.nameError;
    this.kind ??= view.freeName === false ? "own" : "free";
    const free = this.kind === "free";
    const zone = view.zone;
    const current = view.name ?? "";
    const initial = free ? (current.endsWith(`.${zone}`) ? current.slice(0, -zone.length - 1) : "") : (current.endsWith(`.${zone}`) ? "" : current);
    this.nameInput = el("input", {
      id: "control-name", name: "name", type: "text", value: initial, autocomplete: "off", autocapitalize: "none", spellcheck: false, required: true,
      maxLength: free ? 40 : 253, inputMode: "url", "aria-describedby": free ? "control-name-suffix control-name-hint" : "control-name-hint",
      oninput: () => this.#scheduleCheck(),
    });
    this.availability = el("p", { className: "control-availability", role: "status", "aria-live": "polite" });
    const choose = el("button", { type: "submit", className: "primary-action", text: "Use this name" });
    const kindOption = (value, label, hint) => el("label", { className: "control-choice" },
      el("input", { type: "radio", name: "control-kind", value, checked: this.kind === value, onchange: () => { this.kind = value; this.render(); } }),
      el("span", {}, el("strong", { text: label }), el("span", { className: "control-hint", text: hint })));
    const form = el("form", { className: "control-form", onsubmit: (event) => { event.preventDefault(); this.#run(() => this.api.post("setup/name", { name: this.#typedName() }), choose); } },
      el("fieldset", { className: "control-kinds" },
        el("legend", { text: "Which kind of name?" }),
        kindOption("free", "A free name", `Like fern.${zone}. Nothing else to set up.`),
        kindOption("own", "Our own domain", "Like kin.smith.family. You add a few DNS records, and only you control who can get a certificate for it.")),
      el("label", { for: "control-name", text: free ? "Name" : "Your domain" }),
      el("div", { className: free ? "control-name-field" : "control-name-field own" },
        this.nameInput,
        free ? el("span", { id: "control-name-suffix", className: "control-suffix", text: `.${zone}` }) : null),
      el("p", { id: "control-name-hint", className: "control-hint", text: free ? "3 to 40 letters, digits or hyphens." : "The full name, such as kin.smith.family." }),
      this.availability,
      el("div", { className: "control-actions" }, choose));
    if (initial) queueMicrotask(() => this.#scheduleCheck(0));
    return [
      this.#title("Choose this home server's name"),
      el("p", { text: "Phones and computers open Kin at this address, from home or anywhere. Choose it once: passkeys, the installed app and each device's saved data all belong to it." }),
      refused ? el("p", { className: "control-problem", role: "alert", "data-code": refused, text: explain(refused) }) : null,
      view.nameFromEnvironment ? el("p", { className: "control-problem", text: explain("setup-name-from-environment") }) : form,
    ];
  }

  #typedName() {
    const typed = this.nameInput.value.trim().toLowerCase();
    return this.kind === "free" && typed && !typed.includes(".") ? `${typed}.${this.#view.zone}` : typed;
  }

  #scheduleCheck(delay = CHECK_DELAY_MS) {
    clearTimeout(this.checkTimer);
    const generation = ++this.checkGeneration;
    const name = this.#typedName();
    if (!name) { this.availability.textContent = ""; return; }
    this.checkTimer = setTimeout(async () => {
      this.availability.textContent = "Checking…";
      try {
        const result = await this.api.post("setup/check-name", { name });
        if (generation !== this.checkGeneration) return;
        this.availability.dataset.answer = result.answer;
        this.availability.textContent = `${result.name}: ${AVAILABILITY[result.answer] ?? AVAILABILITY.unknown}`;
      } catch (error) {
        if (generation !== this.checkGeneration) return;
        this.availability.dataset.answer = "error";
        this.availability.textContent = explain(error.code);
      }
    }, delay);
  }

  // --------------------------------------------------------------- terms

  #termsStep() {
    const view = this.#view;
    // Not `required`: Kin says why in its own words instead of the browser's.
    const agree = el("input", { id: "control-terms", type: "checkbox" });
    const link = el("a", { href: this.termsUrl ?? "https://letsencrypt.org/repository/", target: "_blank", rel: "noopener noreferrer", text: "Read Let's Encrypt's Subscriber Agreement" });
    if (!this.termsUrl) this.api.post("setup/terms-url").then(({ url }) => { if (url) { this.termsUrl = url; link.href = url; } }).catch(() => {});
    const go = el("button", { type: "submit", className: "primary-action", text: "Agree and continue" });
    return [
      this.#title("Agree to Let's Encrypt's terms"),
      el("p", { text: `Kin gets the certificate that lets phones trust ${view.name} from Let's Encrypt, a free, nonprofit certificate authority. To get one, you agree to its Subscriber Agreement.` }),
      el("p", {}, link, el("span", { className: "visually-hidden", text: " (opens in a new tab)" })),
      el("form", { className: "control-form", onsubmit: (event) => {
        event.preventDefault();
        if (!agree.checked) { this.#say(explain("setup-terms-required"), true); agree.focus(); return; }
        this.#run(() => this.api.post("setup/terms", { agreed: true }), go);
      } },
        el("label", { className: "control-check" }, agree, el("span", { text: "I agree to Let's Encrypt's Subscriber Agreement." })),
        el("div", { className: "control-actions" }, go, el("button", { type: "button", className: "secondary", text: "Choose another name", onclick: () => { this.editingName = true; this.render(); } }))),
    ];
  }

  // ------------------------------------------------------------- records

  #recordsStep() {
    const view = this.#view;
    const records = view.records?.records ?? view.expectedRecords ?? [];
    const check = el("button", { type: "button", className: "primary-action", text: "Check the records", onclick: () => this.#run(() => this.api.post("setup/records"), check) });
    const rows = records.map((record) => el("tr", {},
      el("th", { scope: "row", text: record.type }),
      el("td", {}, el("code", { text: record.name })),
      el("td", {}, el("code", { text: record.value }), " ", this.#copyButton(record))));
    const results = view.records?.checks ?? [];
    return [
      this.#title("Add these DNS records"),
      el("p", { text: `At the company that runs DNS for ${view.name}, add these records. Then check them here. New records can take a few minutes to appear.` }),
      records.length ? el("div", { className: "control-table-wrap", role: "region", "aria-label": "DNS records", tabIndex: 0 },
        el("table", { className: "control-records" },
          el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Type" }), el("th", { scope: "col", text: "Name" }), el("th", { scope: "col", text: "Value" }))),
          el("tbody", {}, rows))) : el("p", { className: "control-problem", text: explain("dns-relay-unknown") }),
      el("p", { className: "control-hint", text: "Use A and AAAA records with these addresses, not a CNAME. If your DNS provider offers Encrypted Client Hello (ECH) for this name, turn it off." }),
      results.length ? el("ul", { className: "control-checks", "aria-label": "Check results" }, results.map((result) => el("li", { "data-ok": String(result.ok) },
        el("strong", { text: `${RECORD_CHECKS[result.id] ?? result.id}: ` }),
        result.ok ? (result.unknown ? "Couldn't check; it doesn't stop setup." : "In place.") : explain(result.problem)))) : null,
      view.records?.checkedAt ? el("p", { className: "control-muted", text: `Checked ${formatDateTime(view.records.checkedAt)}.` }) : null,
      el("div", { className: "control-actions" }, check, el("button", { type: "button", className: "secondary", text: "Choose another name", onclick: () => { this.editingName = true; this.render(); } })),
    ];
  }

  #copyButton(record) {
    const button = el("button", { type: "button", className: "secondary control-copy", text: "Copy", "aria-label": `Copy the ${record.type} value` });
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(record.value); this.#say(`Copied the ${record.type} value.`); } catch { this.#say("Copying didn't work here. Select the value and copy it instead.", true); }
    });
    return button;
  }

  // ------------------------------------------------------------- connect

  #connectStep() {
    const view = this.#view;
    const connect = el("button", { type: "button", className: "primary-action", text: "Connect", onclick: () => this.#run(() => this.api.post("setup/connect"), connect) });
    return [
      this.#title("Connect"),
      el("p", { text: `Kin connects to the relay as ${view.name} and gets its certificate. Kin restarts once on the way; this page waits for it.` }),
      el("div", { className: "control-actions" }, connect, el("button", { type: "button", className: "secondary", text: "Choose another name", onclick: () => { this.editingName = true; this.render(); } })),
    ];
  }

  // ------------------------------------------------- connecting, certificate

  #progressStep() {
    const view = this.#view;
    const tunnel = view.progress?.tunnel;
    const certificate = view.progress?.certificate;
    const item = (label, state, text) => el("li", { "data-state": state }, el("strong", { text: `${label}: ` }), text);
    const routed = tunnel?.routed;
    const items = [
      item("Relay", tunnel?.state === "connected" ? "done" : "working", tunnel ? explainTunnelState(tunnel.state) : "Kin is restarting…"),
      item("Name", routed ? "done" : "working", routed ? `${view.name} is ready.` : `Waiting for the relay to route ${view.name ?? "the name"}.`),
      item("Certificate", certificate?.notAfter ? "done" : certificate?.state === "failed" ? "problem" : "working", certificate ? explainCertificateState(certificate.state) : "Waiting."),
    ];
    const problems = [tunnel?.nameError, tunnel?.error, certificate?.error].filter(Boolean);
    const retry = certificate?.state === "failed"
      ? el("button", { type: "button", className: "secondary", text: "Try again now", onclick: () => this.#run(() => this.api.post("setup/retry"), retry) })
      : null;
    return [
      this.#title(routed ? "Getting the certificate" : "Connecting"),
      el("p", { text: "This usually takes under a minute. You can leave this page open; it updates by itself." }),
      el("ul", { className: "control-progress", "aria-label": "Progress" }, items),
      ...problems.map((code) => el("p", { className: "control-problem", "data-code": code, text: explain(code) })),
      certificate?.nextAttemptAt && certificate.state === "failed" ? el("p", { className: "control-muted", text: `Kin tries again by itself at ${formatDateTime(certificate.nextAttemptAt)}.` }) : null,
      retry ? el("div", { className: "control-actions" }, retry) : null,
    ];
  }

  // ---------------------------------------------------------------- done

  #doneStep() {
    const view = this.#view;
    return [
      this.#title("Kin is ready"),
      el("p", { text: `Kin is ready at ${view.origin}. Open it there to create your household, on the phone or computer you'll use most. Add your other devices and people from there.` }),
      view.progress?.certificate?.notAfter ? el("p", { className: "control-muted", text: `The certificate is valid until ${formatDate(view.progress.certificate.notAfter)}; Kin renews it by itself.` }) : null,
      el("p", { className: "control-actions" }, el("a", { className: "control-button primary-action", href: view.origin, text: `Open ${view.origin}` })),
      el("p", { className: "control-hint", text: "Create the household there, not here: passkeys and each device's saved data belong to that address." }),
    ];
  }
}

if (!customElements.get("kin-control-setup")) customElements.define("kin-control-setup", KinControlSetup);
