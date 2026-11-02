import { excerptRanges, markedNodes } from "../chat/chat-search-ranges.js";

// Chat search (#124), used in two places: the Search page (a "Chat" group
// under the household results, driven by that page's box) and the chat view
// (its own box and filters). The engine searches the decrypted texts in
// memory; nothing about a query or its results is stored or sent anywhere,
// and this element drops them when the room changes or Kin locks.
//
// Choosing a result dispatches kin:open-chat-message { messageId, index,
// ranges } (ranges are UTF-8 byte offsets into the message's text).

const DEBOUNCE_MS = 160;
const PAGE_LIMIT = 50;
const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Local midnight of a yyyy-mm-dd value (plus `days` days, by the calendar so
 * a daylight-saving day keeps its length), in ms; null when empty or
 * invalid. Before 1970 it is 0: the engine takes no earlier bound. */
function dayStart(value, days = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  // setFullYear keeps years 0 to 99 as typed (the constructor maps them to 19xx).
  const date = new Date(2000, 0, 1);
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  const time = date.getTime();
  return Number.isFinite(time) ? Math.max(0, time) : null;
}

/** `text` cut to at most `max` UTF-8 bytes on a character boundary. */
function clipBytes(text, max) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let out = "";
  let bytes = 0;
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > max) break;
    out += character;
  }
  return out;
}

class KinChatSearch extends HTMLElement {
  constructor() {
    super();
    this.chatRoom = null;
    this.text = "";
    this.token = 0;
    this.timer = null;
    this.unsubscribe = null;
  }

  connectedCallback() {
    if (this.status) return;
    const section = document.createElement("section");
    section.className = "chat-search";
    if (!this.hasAttribute("with-controls")) {
      const heading = document.createElement("h3");
      heading.className = "chat-search-heading";
      heading.textContent = "Chat";
      section.append(heading);
    } else {
      this.buildControls(section);
    }
    this.status = document.createElement("p");
    this.status.className = "search-result-status chat-search-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("aria-atomic", "true");
    this.results = document.createElement("ol");
    this.results.className = "search-results chat-search-results";
    this.results.setAttribute("aria-label", "Chat results");
    section.append(this.status, this.results);
    this.replaceChildren(section);
    this.section = section;
    this.refresh();
  }

  disconnectedCallback() {
    this.cancel();
  }

  buildControls(section) {
    const form = document.createElement("form");
    form.className = "search-form chat-search-form";
    form.autocomplete = "off";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.run();
    });
    const label = document.createElement("label");
    label.htmlFor = "chat-search-query";
    label.textContent = "Search chat";
    this.input = document.createElement("input");
    this.input.id = "chat-search-query";
    this.input.type = "search";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.maxLength = 120;
    this.input.placeholder = "Try a word or phrase";
    this.input.addEventListener("input", () => {
      this.text = this.input.value;
      this.refresh();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        this.dispatchEvent(new CustomEvent("kin:close-chat-search", { bubbles: true, composed: true }));
      }
    });
    const filters = document.createElement("details");
    filters.className = "search-filters-disclosure";
    const summary = document.createElement("summary");
    summary.textContent = "Filters";
    const fieldset = document.createElement("fieldset");
    fieldset.className = "search-filters";
    const legend = document.createElement("legend");
    legend.className = "visually-hidden";
    legend.textContent = "Filter chat results";
    fieldset.append(legend);
    this.fromPerson = this.select(fieldset, "From", [["", "Anyone"]]);
    this.files = document.createElement("input");
    this.files.type = "checkbox";
    this.files.addEventListener("change", () => this.refresh());
    const filesLabel = document.createElement("label");
    filesLabel.className = "chat-search-files";
    filesLabel.append(this.files, " Only photos and files");
    this.mine = document.createElement("input");
    this.mine.type = "checkbox";
    this.mine.addEventListener("change", () => this.refresh());
    const mineLabel = document.createElement("label");
    mineLabel.className = "chat-search-files";
    mineLabel.append(this.mine, " Only messages that mention me");
    this.since = this.date(fieldset, "On or after");
    this.until = this.date(fieldset, "On or before");
    fieldset.append(filesLabel, mineLabel);
    filters.append(summary, fieldset);
    this.filters = filters;
    form.append(label, this.input, filters);
    section.append(form);
  }

  select(fieldset, text, options) {
    const label = document.createElement("label");
    label.textContent = text;
    const select = document.createElement("select");
    for (const [value, name] of options) select.append(new Option(name, value));
    select.addEventListener("change", () => this.refresh());
    label.append(select);
    fieldset.append(label);
    return select;
  }

  date(fieldset, text) {
    const label = document.createElement("label");
    label.textContent = text;
    const input = document.createElement("input");
    input.type = "date";
    input.addEventListener("change", () => this.refresh());
    label.append(input);
    fieldset.append(label);
    return input;
  }

  /** People who can be picked in "From": everyone the room knows. */
  updatePeople() {
    if (!this.fromPerson) return;
    const room = this.chatRoom;
    const selected = this.fromPerson.value;
    this.fromPerson.replaceChildren(new Option("Anyone", ""));
    for (const member of room?.members ?? []) this.fromPerson.append(new Option(room.authorLabel(member.id), member.id));
    this.fromPerson.value = [...this.fromPerson.options].some((option) => option.value === selected) ? selected : "";
  }

  set room(value) {
    if (value === this.chatRoom) return;
    this.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.chatRoom = value ?? null;
    this.unsubscribe = this.chatRoom?.subscribe?.(() => this.roomChanged()) ?? null;
    this.updatePeople();
    this.clearResults();
    this.refresh();
  }

  get room() {
    return this.chatRoom;
  }

  /** The text to search for, when this element has no box of its own. */
  set query(value) {
    const next = typeof value === "string" ? value : "";
    if (next === this.text) return;
    this.text = next;
    this.refresh();
  }

  get query() {
    return this.text;
  }

  focusInput() {
    this.input?.focus();
  }

  roomChanged() {
    // New messages, edits and deletions change what matches.
    this.updatePeople();
    if (this.text.trim() || this.files?.checked || this.mine?.checked) this.refresh({ quiet: true });
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
    this.token += 1;
  }

  clearResults() {
    this.results?.replaceChildren();
    if (this.status) this.status.textContent = "";
  }

  /** Searches again soon (debounced), or clears when there's nothing to find. */
  refresh({ quiet = false } = {}) {
    if (!this.status) return;
    this.cancel();
    const searching = this.text.trim() || this.files?.checked || this.mine?.checked;
    // A member shut out of chat can't search it, whatever this device holds.
    const allowed = this.chatRoom && (this.chatRoom.access ?? "write") !== "none";
    if (!allowed || !searching) {
      this.clearResults();
      if (allowed && this.input) this.status.textContent = "Enter text above to search the chat.";
      this.hidden = !this.input;
      return;
    }
    this.hidden = false;
    this.timer = setTimeout(() => void this.run({ quiet }), DEBOUNCE_MS);
  }

  options() {
    const from = dayStart(this.since?.value ?? "");
    const until = dayStart(this.until?.value ?? "", 1);
    const person = this.fromPerson?.value;
    return {
      query: clipBytes(this.text.trim(), 256),
      limit: PAGE_LIMIT,
      attachmentsOnly: Boolean(this.files?.checked),
      ...(this.mine?.checked && this.chatRoom?.identity?.memberId ? { mentioning: this.chatRoom.identity.memberId } : {}),
      authors: person ? [person] : [],
      from: from ?? 0,
      // "On or before" includes that whole day.
      to: until === null ? 0 : Math.max(1, until),
    };
  }

  async run({ quiet = false } = {}) {
    const room = this.chatRoom;
    if (!room || (room.access ?? "write") === "none") return;
    const token = ++this.token;
    const options = this.options();
    if (options.to && options.from && options.to <= options.from) {
      this.results.replaceChildren();
      this.status.textContent = "The end date is before the start date.";
      return;
    }
    const stopped = () => token !== this.token || room !== this.chatRoom;
    if (!quiet) this.status.textContent = "Searching…";
    try {
      await room.search(options, (update) => {
        if (!stopped()) this.show(update, options);
      }, stopped);
    } catch {
      if (!stopped()) this.status.textContent = "Chat couldn't be searched right now.";
    }
  }

  show(update, options) {
    const room = this.chatRoom;
    const focused = this.results.contains(document.activeElement) ? document.activeElement.dataset.messageId : null;
    this.results.replaceChildren();
    const { total, results, searching, incomplete } = update;
    const older = searching ? " Searching older messages…" : incomplete ? " Some older messages couldn't be searched." : "";
    if (!total) {
      this.status.textContent = `${searching ? "Searching older messages…" : `No matching chat messages.${incomplete ? older : ""}`}`;
      return;
    }
    const count = total > results.length
      ? `Showing the newest ${results.length} of ${total} chat messages.`
      : `${total} chat ${total === 1 ? "message" : "messages"}.`;
    this.status.textContent = count + older;
    for (const result of results) this.results.append(this.item(room, result, options));
    if (focused) [...this.results.querySelectorAll("button")].find((node) => node.dataset.messageId === focused)?.focus();
  }

  item(room, result) {
    const entry = document.createElement("li");
    entry.className = "search-result";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "search-result-open";
    open.dataset.messageId = result.messageId;
    const who = room.authorLabel(result.authorId);
    const when = DATE_TIME.format(result.postedAt);
    const attachment = result.contentKind === "attachment";
    const kind = document.createElement("strong");
    kind.className = "search-result-kind";
    kind.textContent = who;
    const text = document.createElement("span");
    text.className = "search-result-text";
    const excerpt = attachment ? "Photos or files" : result.excerpt;
    if (attachment) {
      text.textContent = excerpt;
    } else {
      const marked = excerptRanges(excerpt, result.excerptOffset, result.ranges);
      const lead = result.excerptOffset > 0 ? "…" : "";
      text.append(...(lead ? [document.createTextNode(lead)] : []), ...markedNodes(excerpt, marked));
    }
    const time = document.createElement("small");
    time.className = "search-result-context";
    time.textContent = when;
    open.append(kind, text, time);
    open.setAttribute("aria-label", `Open chat message from ${who === "You" ? "you" : who}, ${when}: ${excerpt}`);
    open.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:open-chat-message", {
      detail: { messageId: result.messageId, index: result.index, ranges: result.ranges, opener: open },
      bubbles: true,
      composed: true,
    })));
    entry.append(open);
    return entry;
  }
}

if (!customElements.get("kin-chat-search")) customElements.define("kin-chat-search", KinChatSearch);
