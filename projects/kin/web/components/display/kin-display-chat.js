// <kin-display-chat> (#671, ADR 0022 §4): the household chat's newest
// messages on the kitchen display, read-only. There is no composer, no
// reactions and no menu: Chat composition never shows on the display. It
// doesn't mark anything read for the adult whose device this is.
//
// Give it `room` (the household's chat room, app/sync.js); it follows the
// room's changes and shows the last few live messages. Texts this device
// hasn't opened yet are opened through the room, as Chat does.

const SHOWN = 4;
const READ = 12;
const visible = (message) => message.status === "live" || message.status === "edited";
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

class KinDisplayChat extends HTMLElement {
  constructor() {
    super();
    this.chatRoom = null;
    this.unsubscribe = null;
    this.texts = new Map();
    this.opening = false;
  }

  connectedCallback() {
    if (!this.list) this.build();
    this.render();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  set room(value) {
    if (value === this.chatRoom && this.unsubscribe) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.chatRoom = value ?? null;
    this.texts = new Map();
    if (this.chatRoom?.subscribe && this.isConnected) this.unsubscribe = this.chatRoom.subscribe(() => this.render());
    this.render();
  }
  get room() { return this.chatRoom; }

  build() {
    this.classList.add("display-chat");
    const heading = document.createElement("h2");
    heading.className = "display-panel-title";
    heading.textContent = "Recent messages";
    this.list = document.createElement("ol");
    this.list.className = "display-chat-list";
    this.list.setAttribute("aria-label", "Recent messages");
    this.empty = document.createElement("p");
    this.empty.className = "display-empty";
    this.append(heading, this.list, this.empty);
  }

  /** The newest live messages, oldest first, with their text where known. */
  messages() {
    const room = this.chatRoom;
    if (!room || room.access === "none") return [];
    let page;
    try { page = room.page({ limit: READ }); } catch { return []; }
    return (page.messages ?? []).filter((message) => visible(message) && !room.isHidden?.(message.messageId)).slice(-SHOWN);
  }

  render() {
    if (!this.list) return;
    if (this.chatRoom && !this.unsubscribe && this.isConnected && this.chatRoom.subscribe) this.unsubscribe = this.chatRoom.subscribe(() => this.render());
    const messages = this.messages();
    const missing = messages.filter((message) => message.contentKind === "text" && message.text === null && !this.texts.has(message.messageId));
    if (missing.length) void this.open(missing);
    this.list.replaceChildren(...messages.map((message) => {
      const row = document.createElement("li");
      row.className = "display-chat-row";
      const who = document.createElement("span");
      who.className = "display-chat-author";
      who.textContent = this.chatRoom.authorLabel?.(message.authorId) ?? "Household member";
      const when = document.createElement("time");
      when.className = "display-chat-time";
      const date = new Date(message.postedAt);
      when.dateTime = date.toISOString();
      when.textContent = timeFormat.format(date);
      const text = document.createElement("p");
      text.className = "display-chat-text";
      text.textContent = this.textOf(message);
      row.append(who, " ", when, text);
      return row;
    }));
    this.list.hidden = !messages.length;
    this.empty.hidden = messages.length > 0;
    this.empty.textContent = this.chatRoom ? "No messages yet." : "Messages show here once Kin has connected.";
  }

  textOf(message) {
    if (message.contentKind === "poll") return "Started a poll.";
    if (message.contentKind !== "text") return "Shared a photo or file.";
    const text = typeof message.text === "string" ? message.text : this.texts.get(message.messageId);
    return typeof text === "string" ? text : "…";
  }

  async open(messages) {
    if (this.opening || !this.chatRoom?.loadTexts) return;
    this.opening = true;
    const room = this.chatRoom;
    try {
      const opened = await room.loadTexts(messages);
      if (room !== this.chatRoom) return;
      for (const message of messages) {
        const result = opened.get(message.messageId);
        this.texts.set(message.messageId, typeof result?.text === "string" ? result.text : "");
      }
    } catch {
      for (const message of messages) this.texts.set(message.messageId, "");
    } finally {
      this.opening = false;
    }
    if (room === this.chatRoom) this.render();
  }
}

customElements.define("kin-display-chat", KinDisplayChat);
