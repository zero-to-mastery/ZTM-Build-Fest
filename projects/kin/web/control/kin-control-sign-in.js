// Opening the control panel on the home server's own computer (ADR 0025
// §10–§11, #719): the one-time code Kin printed in its window and log.
// Events: "signed-in" once the code worked.
import { el } from "./dom.js";
import { explain } from "./explain.js";
import { formatDateTime } from "./format.js";

export class KinControlSignIn extends HTMLElement {
  constructor() {
    super();
    this.api = null;
    this.configured = false;
    this.codeExpiresAt = null;
    this.busy = false;
  }

  connectedCallback() { if (!this.form) this.render(); }

  render() {
    this.input = el("input", {
      id: "control-code", name: "code", type: "text", autocomplete: "one-time-code", autocapitalize: "characters",
      spellcheck: false, required: true, maxLength: 11, "aria-describedby": "control-code-hint",
    });
    this.message = el("p", { className: "control-message", role: "status" });
    this.submitButton = el("button", { type: "submit", className: "primary-action", text: "Continue" });
    this.newCodeButton = el("button", { type: "button", className: "secondary", text: "Print a new code", onclick: () => this.newCode() });
    this.form = el("form", { className: "control-form", onsubmit: (event) => { event.preventDefault(); this.submit(); } },
      el("label", { for: "control-code", text: "Code" }),
      this.input,
      el("p", { id: "control-code-hint", className: "control-hint", text: "10 letters and digits, like ABCDE-23456. Capitals and the hyphen don't matter." }),
      el("div", { className: "control-actions" }, this.submitButton, this.newCodeButton),
      this.message);
    const lead = this.configured
      ? "To open the control panel on this computer, enter a code from Kin. Kin writes it in its own window and in its log; this keeps other programs on this computer out."
      : "Kin printed a setup code when it started: in its own window, and in its log on a computer without a screen. Enter it here to begin. It keeps other programs on this computer from setting Kin up.";
    this.replaceChildren(...[
      el("h2", { id: "control-step-title", tabIndex: -1, text: this.configured ? "Open the control panel" : "Enter the setup code" }),
      el("p", { text: lead }),
      this.codeExpiresAt ? el("p", { className: "control-muted", text: `The current code works once, until ${formatDateTime(this.codeExpiresAt)}.` }) : null,
      this.form,
    ].filter(Boolean));
  }

  #say(text, alert = false) {
    this.message.setAttribute("role", alert ? "alert" : "status");
    this.message.textContent = text;
  }

  async submit() {
    if (this.busy) return;
    const code = this.input.value.trim();
    if (!code) { this.#say("Type the code first.", true); this.input.focus(); return; }
    this.busy = true;
    this.submitButton.disabled = true;
    try {
      await this.api.post("sign-in", { code });
      this.input.value = "";
      this.dispatchEvent(new CustomEvent("signed-in", { bubbles: true }));
    } catch (error) {
      const left = Number.isInteger(error.attemptsLeft) ? ` ${error.attemptsLeft === 1 ? "One more try" : `${error.attemptsLeft} more tries`} with this code.` : "";
      this.#say(`${explain(error.code)}${left}`, true);
      this.input.setAttribute("aria-invalid", "true");
      this.input.focus();
    } finally {
      this.busy = false;
      this.submitButton.disabled = false;
    }
  }

  async newCode() {
    try {
      const { expiresAt } = await this.api.post("code");
      this.codeExpiresAt = expiresAt;
      this.#say(`Kin printed a new code in its window and log. It works once, until ${formatDateTime(expiresAt)}.`);
    } catch (error) {
      this.#say(explain(error.code), true);
    }
  }
}

if (!customElements.get("kin-control-sign-in")) customElements.define("kin-control-sign-in", KinControlSignIn);
