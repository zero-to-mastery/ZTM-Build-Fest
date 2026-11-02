// "Chat" settings (#120): whether this member sends read receipts and shows
// when they are typing. Both are per member and sync to all of that member's
// devices through their receipt slot (web/chat/chat-presence.js). Turning
// read receipts off also hides other people's: the usual convention, and
// fair, so the copy says so.

export const RECEIPTS_LABEL = "Send read receipts";
export const TYPING_LABEL = "Show when I'm typing";
export const RECEIPTS_HINT = "People see when you've read their messages. If you turn this off, you also stop seeing when others have read yours.";
export const TYPING_HINT = "People see \"typing…\" while you write. Turning this off doesn't stop you seeing when others are typing.";
export const ONLINE_LABEL = "Show when I'm online";
export const ONLINE_HINT = "People see a green dot and \"Online now\" while Kin is open and visible on any of your devices. If you turn this off, you also stop seeing when others are online. Nothing is kept about when you were last here.";
export const SETTINGS_NOTE = "These apply to you on all of your devices. None of it is ever sent or kept unencrypted, and a message counts as read only when you've had it on screen in an open, active window.";

class KinChatSettings extends HTMLElement {
  constructor() {
    super();
    this.chatRoom = null;
    this.unsubscribe = null;
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
    this.render();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  build() {
    this.className = "chat-settings";
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", "chat-settings-heading");
    const heading = document.createElement("h2");
    heading.id = "chat-settings-heading";
    heading.textContent = "Chat";
    const note = document.createElement("p");
    note.className = "section-hint";
    note.textContent = SETTINGS_NOTE;
    this.receipts = this.toggle("chat-setting-receipts", RECEIPTS_LABEL, RECEIPTS_HINT, (checked) => ({ receipts: checked }));
    this.typing = this.toggle("chat-setting-typing", TYPING_LABEL, TYPING_HINT, (checked) => ({ typing: checked }));
    this.online = this.toggle("chat-setting-online", ONLINE_LABEL, ONLINE_HINT, (checked) => ({ online: checked }));
    this.error = document.createElement("p");
    this.error.className = "field-error";
    this.error.setAttribute("role", "alert");
    this.append(heading, note, this.receipts.field, this.typing.field, this.online.field, this.error);
  }

  toggle(id, label, hint, change) {
    const field = document.createElement("div");
    field.className = "chat-setting";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.setAttribute("aria-describedby", `${id}-hint`);
    const text = document.createElement("label");
    text.htmlFor = id;
    text.textContent = label;
    const description = document.createElement("p");
    description.id = `${id}-hint`;
    description.className = "section-hint";
    description.textContent = hint;
    input.addEventListener("change", () => void this.apply(input, change(input.checked)));
    field.append(input, text, description);
    return { field, input };
  }

  async apply(input, change) {
    const room = this.chatRoom;
    if (!room) return;
    if (input.getAttribute("aria-busy") === "true") return;
    // Not `disabled`: that would drop keyboard focus from the box just used.
    input.setAttribute("aria-busy", "true");
    this.error.textContent = "";
    try {
      await room.presence.setSettings(change);
    } catch {
      // The choice is kept on this device and sent on the next sync.
    } finally {
      input.removeAttribute("aria-busy");
      this.render();
    }
  }

  /** The chat room, or null while there is none (sync not set up, locked). */
  set room(value) {
    if (value === this.chatRoom) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.chatRoom = value ?? null;
    if (this.chatRoom) this.unsubscribe = this.chatRoom.subscribePresence(() => this.render());
    this.render();
  }

  get room() {
    return this.chatRoom;
  }

  render() {
    if (!this.receipts) return;
    const presence = this.chatRoom?.presence;
    // Receipts and typing go with posting: a member the household set to
    // read only (or no access) has nothing to choose (#123).
    // Online status needs chat access only; the other two go with posting.
    const access = this.chatRoom?.access ?? "write";
    this.hidden = !presence || access === "none";
    if (this.hidden) return;
    this.receipts.field.hidden = this.typing.field.hidden = access !== "write";
    this.receipts.input.checked = presence.settings.receipts;
    this.typing.input.checked = presence.settings.typing;
    this.online.input.checked = presence.settings.online;
  }
}

if (!customElements.get("kin-chat-settings")) customElements.define("kin-chat-settings", KinChatSettings);
