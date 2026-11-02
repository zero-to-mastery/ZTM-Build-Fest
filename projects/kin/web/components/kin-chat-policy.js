// "Who can chat" (#123): the household admin's choice for Limited members
// (children) and Temporary members (babysitters, guests). The policy is
// authorization metadata the service enforces, never chat content. Changing
// it needs the admin's passkey, like other admin changes. Only an admin sees
// this panel: the service sends the policy to admins alone.
import { freshConfirmation } from "./household/fresh-confirmation.js";

export const POLICY_CHOICES = Object.freeze([
  Object.freeze({ value: "write", label: "Read and post" }),
  Object.freeze({ value: "read", label: "Read only" }),
  Object.freeze({ value: "none", label: "No access" }),
]);
export const POLICY_NOTE = "Adults can always read and post. Everyone can post by default. Read only keeps the conversation visible but removes the message box. No access hides Chat for that group.";

/** What each policy panel says and where it saves (#123 chat, #323 fridge). */
const CHAT_CONFIG = Object.freeze({
  className: "chat-policy", heading: "Who can chat", note: POLICY_NOTE, choices: POLICY_CHOICES, idPrefix: "chat-policy",
  save: "Save chat access", statusKey: "chat", path: "/api/household/chat-policy",
  confirm: "Change who can chat?",
  demoted: " Members with no access can't read new messages. Anything already on their devices stays there.",
  saved: "Chat access saved. Members who are online see it now.", usage: true,
});

const json = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message || "Kin couldn't reach the household service."), { code: value.error });
  return value;
};

export class KinChatPolicy extends HTMLElement {
  static config = CHAT_CONFIG;

  constructor() {
    super();
    this.saved = null;
    this.busy = false;
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
  }

  get config() {
    return this.constructor.config;
  }

  build() {
    const config = this.config;
    this.hidden = true;
    this.className = `${config.className} policy-panel`;
    const heading = document.createElement("h2");
    heading.textContent = config.heading;
    const note = document.createElement("p");
    note.className = "section-hint";
    note.textContent = config.note;
    this.limited = this.field(`${config.idPrefix}-limited`, "Limited members (children)");
    this.temporary = this.field(`${config.idPrefix}-temporary`, "Temporary members (babysitters, guests)");
    this.save = document.createElement("button");
    this.save.type = "button";
    this.save.className = "primary-action";
    this.save.textContent = config.save;
    this.save.addEventListener("click", () => void this.submit());
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.usage = document.createElement("p");
    this.usage.className = "section-hint chat-storage-usage";
    // A fieldset names the group of choices for assistive technology.
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.className = "visually-hidden";
    legend.textContent = config.heading;
    group.append(legend, this.limited.field, this.temporary.field);
    this.group = group;
    this.append(heading, note, group, this.save, this.feedback, this.usage);
  }

  field(id, text) {
    const field = document.createElement("div");
    field.className = "chat-policy-field";
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = text;
    const select = document.createElement("select");
    select.id = id;
    for (const choice of this.config.choices) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      select.append(option);
    }
    select.addEventListener("change", () => { this.feedback.textContent = ""; this.apply(); });
    field.append(label, select);
    return { field, select };
  }

  /** Reads the policy; the service sends it to admins only. */
  async load() {
    if (this.busy) return;
    // A show() meanwhile (a demotion, a lock, another household) is newer
    // than this answer: keep it (#327).
    const generation = this.generation ?? 0;
    try {
      const status = await json("/api/sync/status");
      if ((this.generation ?? 0) !== generation) return;
      const policy = status[this.config.statusKey]?.policy ?? null;
      this.show(policy);
      if (policy && this.config.usage) await this.loadUsage();
    } catch {
      // Keep what is shown (and any message): not being able to reach the
      // service is not the same as not being an admin. Before the first
      // successful load the panel simply stays hidden.
    }
  }

  /** How full the household's chat storage is (#125); admins only, and
   * best effort: the line stays empty if it can't be read. */
  async loadUsage() {
    try {
      const use = await json("/api/chat/storage");
      const mib = (bytes) => `${Math.max(0, Math.round(bytes / 1048576))} MiB`;
      this.usage.textContent = `Chat storage: ${mib(use.bytes)} of ${mib(use.byteLimit)} used, ${use.events.toLocaleString()} of ${use.eventLimit.toLocaleString()} messages and edits.`;
    } catch {
      this.usage.textContent = "";
    }
  }

  show(policy) {
    this.generation = (this.generation ?? 0) + 1;
    this.saved = policy;
    this.hidden = !policy;
    if (!policy) return;
    this.limited.select.value = policy.limited;
    this.temporary.select.value = policy.temporary;
    this.apply();
  }

  apply() {
    const unchanged = this.saved && this.limited.select.value === this.saved.limited && this.temporary.select.value === this.saved.temporary;
    this.save.disabled = this.busy || unchanged;
    this.limited.select.disabled = this.temporary.select.disabled = this.busy;
  }

  async submit() {
    if (this.busy || !this.saved) return;
    const change = { limited: this.limited.select.value, temporary: this.temporary.select.value };
    const demoted = (from, to) => from !== "none" && to === "none";
    const warning = demoted(this.saved.limited, change.limited) || demoted(this.saved.temporary, change.temporary)
      ? this.config.demoted
      : "";
    if (!confirm(`${this.config.confirm}${warning}`)) return;
    this.busy = true;
    this.apply();
    this.feedback.textContent = "Confirm the change when Kin asks.";
    const generation = this.generation ?? 0;
    try {
      const started = await json(`${this.config.path}/options`, { method: "POST", body: JSON.stringify(change) });
      const proof = await freshConfirmation(started);
      await json(`${this.config.path}/finish`, { method: "POST", body: JSON.stringify({ flow: started.flow, ...proof }) });
      // Saved; but if the panel was hidden or replaced meanwhile, don't bring it back.
      if ((this.generation ?? 0) !== generation) return;
      this.saved = change;
      this.feedback.textContent = this.config.saved;
    } catch (error) {
      if ((this.generation ?? 0) !== generation) return;
      this.feedback.textContent = error?.name === "NotAllowedError" ? "Canceled. Nothing changed." : (error?.message || "Kin couldn't save that.");
      this.busy = false;
      await this.load();
    } finally {
      this.busy = false;
      this.apply();
      // The button disables itself when nothing differs; keep focus somewhere real.
      if (this.save.disabled && this.contains(document.activeElement) === false) this.limited.select.focus();
    }
  }
}

if (!customElements.get("kin-chat-policy")) customElements.define("kin-chat-policy", KinChatPolicy);

/** "Who can use the fridge" (#323): the same panel for the family fridge. */
export const BOARD_POLICY_CHOICES = Object.freeze([
  Object.freeze({ value: "write", label: "Draw" }),
  Object.freeze({ value: "read", label: "Look only" }),
  Object.freeze({ value: "none", label: "No access" }),
]);

class KinBoardPolicy extends KinChatPolicy {
  static config = Object.freeze({
    className: "board-policy", heading: "Who can use the fridge", idPrefix: "board-policy", choices: BOARD_POLICY_CHOICES,
    note: "Adults can always draw. Everyone can draw by default. Look only shows the fridge without its tools. No access hides the fridge for that group.",
    save: "Save fridge access", statusKey: "board", path: "/api/household/board-policy",
    confirm: "Change who can use the fridge?",
    demoted: " Members with no access stop seeing the fridge. Anything already on their devices stays there.",
    saved: "Fridge access saved. Members who are online see it now.", usage: false,
  });
}

if (!customElements.get("kin-board-policy")) customElements.define("kin-board-policy", KinBoardPolicy);
