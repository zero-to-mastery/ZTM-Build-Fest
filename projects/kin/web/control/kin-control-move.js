// Moving a household here (ADR 0026 §1, #739), on the home server's own
// computer only: the move code is printed to Kin's window and log, like the
// panel's other codes, and typed on the address the household is moving
// from, with this server's address. That server sends the household; Kin
// adds it and restarts, and people sign in here again.
import { el } from "./dom.js";
import { explain } from "./explain.js";
import { countOf, formatDateTime } from "./format.js";

export class KinControlMove extends HTMLElement {
  #status = null;

  constructor() {
    super();
    this.api = null;
    this.busy = false;
  }

  get status() { return this.#status; }
  set status(value) {
    const before = JSON.stringify(this.#status?.lastMove ?? null);
    this.#status = value;
    // Redraw only when a move arrived, so the message stays.
    if (!this.message || before !== JSON.stringify(value?.lastMove ?? null)) this.render();
  }

  render() {
    const status = this.#status;
    if (!status) { this.replaceChildren(); return; }
    this.message = el("p", { className: "control-message", role: "status" });
    const button = el("button", { type: "button", className: "secondary", text: "Get a move code", onclick: () => this.ask(button) });
    const last = status.lastMove;
    this.replaceChildren(el("section", { className: "control-card", "data-section": "move", "aria-labelledby": "control-move-title" },
      el("h2", { id: "control-move-title", text: "Moving a household here" }),
      el("p", { text: "Moving from kin.journeytocode.io or another Kin server? Get a move code here. Then, on the old address, a household admin opens Household › Move to a home server and enters this server's address and the code." }),
      el("p", { className: "control-muted", text: "Everyone keeps their account and the household's history. Each person signs in here again with their password or backup code, and adds a new passkey: passkeys belong to the old address." }),
      ...(last ? [el("p", { className: "control-state", text: `A household moved here on ${formatDateTime(last.at)}, with ${countOf(last.members, "member", "members")}.` })] : []),
      el("div", { className: "control-actions" }, button),
      this.message));
  }

  async ask(button) {
    if (this.busy) return;
    this.busy = true;
    button.disabled = true;
    try {
      const answer = await this.api.post("move-code");
      const until = Number.isNaN(Date.parse(answer.expiresAt)) ? "" : ` It works once, until ${new Date(answer.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
      this.message.setAttribute("role", "status");
      this.message.textContent = `Kin printed a move code in its window and log on this computer. Enter it, with ${answer.address}, on the old address.${until}`;
    } catch (error) {
      this.message.setAttribute("role", "alert");
      this.message.textContent = explain(error.code);
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }
}

if (!customElements.get("kin-control-move")) customElements.define("kin-control-move", KinControlMove);
