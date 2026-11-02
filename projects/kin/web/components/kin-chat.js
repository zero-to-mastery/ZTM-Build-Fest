// Updates → Chat (#112): the household's one chat room.
//
// The room (web/chat/chat-room.js) owns the chat log, sending and sync; this
// element shows a window of it and a composer. It never renders markup from
// a message: every text goes in through textContent, and links stay plain
// text (no previews, which would make requests).
//
// Window: the list renders at most WINDOW_MAX rows of the log. Scrolling near
// the top (or "Show earlier messages") brings older messages in and trims the
// newest; scrolling back down does the reverse. While the window ends at the
// latest message it "follows": new messages join it and, if the list was at
// the bottom, scroll into view; otherwise "Jump to latest" appears. Paging
// keeps the rows on screen where they are.
//
// Rows are reconciled by message ID: a row whose content didn't change is
// kept as it is, so focus, selection and an open menu survive new messages.
//
// The list is a role="log" region kept quiet (aria-live="off"); a separate
// polite live region announces only messages from others this view hasn't
// seen before (by message ID), never paging or the history shown on opening.
// The draft lives in this element only: locking replaces the element.
//
// Read receipts and typing (#120): a message counts as read only while its
// row is mostly on screen in a visible, focused window of this chat (an
// IntersectionObserver on the rows, the page's visibility and focus). The
// room's presence (chat/chat-presence.js) turns that into the member's read
// cursor. Under the member's latest message a "Seen by" line opens that
// message's details; under the list a plain "Sam is typing…" line, which
// screen readers get as the list's description, not as an announcement.
import { VoiceComposer, voicePlayer } from "./kin-chat-voice.js";
import { voicePeaks } from "../chat/chat-voice.js";
import { chatTextProblem, MAX_CHAT_TEXT_CHARS } from "../chat/chat-room.js";
import { emojiOnlyCount, loadEmojiTable } from "../chat/emoji.js";
import { QUICK_REACTIONS, reactionChips, reactionNames } from "../chat/chat-reactions.js";
import { attachmentProblem, MAX_ATTACHMENT_FILES, safeAttachmentName } from "../chat/chat-attachments.js";
import "./kin-chat-poll.js";
import { renderPoll } from "./kin-chat-poll.js";
import { seenText, typingText } from "../chat/chat-presence.js";
import { attachmentKindLabel, formatAttachmentSize } from "../attachments/attachment-preview.js";
import { ObjectUrlRegistry } from "../attachments/object-urls.js";
import { excerptRanges, highlightRanges } from "../chat/chat-search-ranges.js";
import { activeMention, mentionOptions, splitMentions, resolveMentions } from "../chat/chat-mentions.js";
import "./kin-emoji-picker.js";
import "./kin-chat-search.js";
import { fitChat } from "../chat/chat-layout.js";
import { prefersReducedMotion } from "../appearance/display-prefs.js";

/** Rows rendered at first and added per page. */
const PAGE = 60;
/** Most rows kept rendered at once. */
const WINDOW_MAX = 240;
/** Newest messages checked for arrivals while the window shows older ones. */
const ARRIVAL_CHECK = 50;
/** Pixels from an edge that count as "near" it. */
const EDGE = 160;
/** Messages from one author this close together are grouped. */
const GROUP_MS = 5 * 60_000;

const STATUS_TEXT = { deleted: "This message was deleted", "removed-by-admin": "Removed by an admin" };
const ATTACHMENT_TEXT = { loading: "Loading…", pending: "Waiting for these to arrive…", deleted: "This message was deleted", failed: "These couldn't be opened yet." };
/** Blob URLs for photos and downloads last until the room is left (or the
 * page locks): a long lifetime, revoked explicitly. */
const URL_LIFETIME_MS = 2 ** 31 - 1;
// (Blob URLs for photos are also revoked when the room is left, which the
// registry's revokeAll does on resetView and on disconnect.)
/** How long a downloaded file's blob URL lives after the click that saved it. */
const DOWNLOAD_URL_MS = 60_000;
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
const ACTION_LABELS = { copy: "Copy text", reply: "Reply", details: "See who reacted", edit: "Edit", delete: "Delete for everyone", remove: "Remove as admin", hide: "Delete for me", pin: "Pin", unpin: "Unpin", "to-shopping": "Add to Shopping", "to-todo": "Add to To do", "to-handoff": "Make a handoff", "to-note": "Save as a note", "to-photos": "Add to the family photos", "talk-later": "Talk later", "talk-resolve": "Mark talked about", "talk-reopen": "Talk about again" };
/** How long a press on a reaction chip must last to list who reacted. */
const LONG_PRESS_MS = 500;
const NO_RECALL = "Copies people already saved, screenshotted or downloaded can't be recalled.";

const visible = (message) => message.status === "live" || message.status === "edited";

/** `text` cut to `max` UTF-16 units with an ellipsis, never inside a pair. */
function clip(text, max) {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

class KinChat extends HTMLElement {
  constructor() {
    super();
    this.chatRoom = null;
    this.unsubscribe = null;
    this.urls = new ObjectUrlRegistry({ lifetimeMs: URL_LIFETIME_MS });
    this.resetView();
    this.editing = null;
    this.stashedDraft = null;
    this.renderQueued = false;
    this.pendingMode = null;
    this.rendering = Promise.resolve();
    this.isDisabled = false;
    this.unsubscribePresence = null;
    // Rows mostly on screen now, by message ID (see evaluateRead()).
    this.onScreen = new Set();
    this.onWindowChange = () => this.windowChanged();
    this.onPageHide = () => { this.voice?.interrupt(); this.windowChanged(); };
    // Opening the Chat page lands on the newest message (#310), unless the
    // "New messages" divider is still waiting to be shown.
    this.onRouteChange = (event) => {
      if (event.detail?.to !== "updates/chat" || !this.chatRoom || this.dividerPending) return;
      requestAnimationFrame(() => {
        // No focus move here: on a phone that would open the keyboard.
        if (!this.following) { this.following = true; void this.queueRender("reset"); return; }
        this.scrollToBottom();
        this.jump.hidden = true;
      });
    };
    this.onDocumentClick = (event) => {
      if (this.reacting && !event.composedPath().some((node) => node?.classList?.contains?.("chat-react-bar") || node?.classList?.contains?.("chat-react-button"))) this.closeReactions();
    };
  }

  /** Forgets everything about the room on screen. */
  resetView() {
    // Locking or changing room ends any recording and drops the draft, and
    // closes an open photo, whose decrypted copy must not outlive the lock.
    this.voice?.dispose();
    if (this.viewer && (this.viewer.open || this.viewer.hasAttribute?.("open"))) {
      if (typeof this.viewer.close === "function" && this.viewer.open) this.viewer.close();
      this.closeViewer();
    }
    this.disposePlayers();
    this.start = 0;
    this.end = 0;
    this.total = 0;
    this.following = true;
    // Where the member left off (#133): the message the "New messages"
    // divider sits above, set when they open the chat; whether they are
    // looking at it now; and whether to scroll to the divider once drawn.
    this.divider = null;
    this.reading = false;
    this.dividerPending = false;
    this.messages = [];
    this.rows = new Map();
    this.menuFor = null;
    if (this.sheet?.open) this.sheet.close();
    this.sheet?.replaceChildren();
    // The message whose reaction bar is open (#127), and whether it shows
    // the whole emoji table; names for chips, once the table has loaded.
    this.reacting = null;
    this.reactMore = false;
    this.emojiNames ??= reactionNames();
    // The message the composer is answering (#129), and the one a jump
    // just highlighted.
    this.replyingTo = null;
    if (this.replyBar) this.replyBar.hidden = true;
    this.highlighted = null;
    clearTimeout(this.highlightTimer);
    this.clearSearchMark();
    // Per message: { deleted } is final; { pending } and { failed } are
    // retried on the room's next change; { loading } while a load runs.
    this.textStatus = new Map();
    // Per attachment message (#114): { status, text, files, thumbs }.
    this.attachments = new Map();
    // Per poll message (#135): { status, question, options } once opened.
    this.polls = new Map();
    this.pollDialog?.reset?.();
    // Photos and files chosen to send, not yet sent.
    this.files = [];
    this.urls?.revokeAll();
    this.onScreen?.clear();
    this.rowObserver?.disconnect();
    this.seen = new Set();
    this.toAnnounce = [];
    this.wasAtBottom = true;
    // Until the first render of a room, what's there is history, not news.
    this.primed = false;
    this.list?.replaceChildren();
    this.pins = [];
    if (this.pinRegion) this.pinRegion.hidden = true;
    this.topics = [];
    this.renderTopics?.();
  }

  connectedCallback() {
    // The To talk about side column follows the width (#312); removed on
    // disconnect so a replaced element isn't kept alive.
    this.wideQuery ??= globalThis.matchMedia?.("(min-width: 1180px)") ?? null;
    this.onWideChange ??= () => this.renderTopics();
    this.wideQuery?.addEventListener?.("change", this.onWideChange);
    window.addEventListener("kin-route-change", this.onRouteChange);
    document.addEventListener("click", this.onDocumentClick);
    document.addEventListener("visibilitychange", this.onWindowChange);
    window.addEventListener("focus", this.onWindowChange);
    window.addEventListener("blur", this.onWindowChange);
    window.addEventListener("pagehide", this.onPageHide);
    if (this.list) {
      this.resizeObserver?.observe(this.scroller);
      this.startFit();
      return;
    }
    const section = document.createElement("section");
    section.className = "today-section chat-section";
    const heading = document.createElement("h2");
    heading.id = "chat-heading";
    heading.textContent = "Household chat";
    const top = document.createElement("div");
    top.className = "chat-top";
    this.searchToggle = document.createElement("button");
    this.searchToggle.type = "button";
    this.searchToggle.className = "chat-search-toggle";
    // "Search" on screen keeps the toolbar to one row on a phone; the name
    // stays "Search chat".
    this.searchToggle.textContent = "Search";
    this.searchToggle.setAttribute("aria-label", "Search chat");
    this.searchToggle.setAttribute("aria-expanded", "false");
    this.searchToggle.setAttribute("aria-controls", "chat-search-panel");
    this.searchToggle.addEventListener("click", () => (this.searchPanel.hidden ? this.openSearch() : this.closeSearch({ focus: true })));
    // To talk about (#312, ADR 0014): messages flagged Talk later, and the
    // older topics. A side column at 1180px and wider; elsewhere a panel the
    // toolbar button opens, its count in words.
    this.topicsToggle = document.createElement("button");
    this.topicsToggle.type = "button";
    this.topicsToggle.className = "chat-topics-toggle";
    // To talk about is Talk later's (#625).
    this.topicsToggle.dataset.feature = "talk";
    this.topicsToggle.setAttribute("aria-expanded", "false");
    this.topicsToggle.setAttribute("aria-controls", "chat-topics");
    this.topicsToggle.addEventListener("click", () => this.toggleTopics());
    const tools = document.createElement("div");
    tools.className = "chat-tools";
    tools.append(this.topicsToggle, this.searchToggle);
    top.append(heading, tools);
    this.topicsOpen = false;
    this.topics = [];
    this.legacyOpen = 0;
    this.topicsPanel = document.createElement("section");
    this.topicsPanel.id = "chat-topics";
    this.topicsPanel.className = "chat-topics";
    this.topicsPanel.dataset.feature = "talk";
    this.topicsPanel.setAttribute("aria-labelledby", "chat-topics-heading");
    const topicsHeading = document.createElement("h3");
    topicsHeading.id = "chat-topics-heading";
    topicsHeading.tabIndex = -1;
    topicsHeading.textContent = "To talk about";
    this.topicsHeading = topicsHeading;
    const topicsHint = document.createElement("p");
    topicsHint.className = "section-hint";
    topicsHint.textContent = "Messages someone marked Talk later, for a calm moment. Marking one talked about only means the conversation happened.";
    this.topicList = document.createElement("ul");
    this.topicList.className = "chat-topic-list";
    this.topicsEmpty = document.createElement("p");
    this.topicsEmpty.className = "empty-state";
    this.topicsEmpty.textContent = "Nothing from Chat yet. Choose Talk later in a message's actions.";
    this.legacyHost = document.createElement("div");
    this.legacyHost.className = "chat-topics-legacy";
    if (this.legacyTopicsElement) this.legacyHost.append(this.legacyTopicsElement);
    this.topicsPanel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.wideTopics() || !this.topicsOpen) return;
      if (event.target.closest?.("input, textarea")) return;
      event.preventDefault();
      this.toggleTopics(false);
      this.topicsToggle.focus();
    });
    this.topicsPanel.append(topicsHeading, topicsHint, this.topicList, this.topicsEmpty, this.legacyHost);
    this.wideQuery ??= globalThis.matchMedia?.("(min-width: 1180px)") ?? null;
    // The chat's own search box and filters (#124).
    this.searchPanel = document.createElement("div");
    this.searchPanel.id = "chat-search-panel";
    this.searchPanel.className = "chat-search-panel";
    this.searchPanel.hidden = true;
    this.search = document.createElement("kin-chat-search");
    this.search.setAttribute("with-controls", "");
    this.search.addEventListener("kin:open-chat-message", (event) => {
      event.stopPropagation();
      void this.showSearchResult(event.detail);
    });
    this.search.addEventListener("kin:close-chat-search", (event) => {
      event.stopPropagation();
      this.closeSearch({ focus: true });
    });
    this.searchPanel.append(this.search);
    this.notice = document.createElement("p");
    this.notice.className = "chat-notice";

    this.scroller = document.createElement("div");
    this.scroller.className = "chat-scroll";
    this.scroller.setAttribute("role", "log");
    this.scroller.setAttribute("aria-live", "off");
    this.scroller.setAttribute("aria-labelledby", "chat-heading");
    this.scroller.tabIndex = 0;
    // Online now (#128): who has Kin open and visible right now. Plain text,
    // not a live region (it would be announced on every change).
    this.onlineLine = document.createElement("p");
    this.onlineLine.className = "chat-online";
    this.onlineLine.hidden = true;
    // Pinned messages (#131): a region above the log. The bar shows the latest
    // pin; pressing it opens the list of all pins, each of which goes to its
    // message.
    this.pinRegion = document.createElement("section");
    this.pinRegion.className = "chat-pins";
    this.pinRegion.setAttribute("aria-label", "Pinned messages");
    this.pinRegion.hidden = true;
    this.pinBar = document.createElement("button");
    this.pinBar.type = "button";
    this.pinBar.className = "chat-pin-bar";
    this.pinBar.setAttribute("aria-expanded", "false");
    this.pinBar.setAttribute("aria-controls", "chat-pin-list");
    this.pinBar.addEventListener("click", () => this.togglePins());
    this.pinList = document.createElement("ol");
    this.pinList.id = "chat-pin-list";
    this.pinList.className = "chat-pin-list";
    this.pinList.hidden = true;
    this.pinRegion.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.pinList.hidden) {
        event.preventDefault();
        this.togglePins(false);
        this.pinBar.focus();
      }
    });
    this.pinRegion.append(this.pinBar, this.pinList);
    this.pins = [];
    this.older = document.createElement("button");
    this.older.type = "button";
    this.older.className = "chat-older";
    this.older.textContent = "Show earlier messages";
    this.older.addEventListener("click", () => void this.loadOlder({ fromButton: true }));
    this.list = document.createElement("ol");
    this.list.className = "chat-list";
    this.scroller.append(this.older, this.list);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    // A hidden panel has no size, so "scroll to the latest" does nothing
    // there; do it once the list is shown (or resized) while following.
    if (typeof ResizeObserver === "function") {
      let height = 0;
      this.resizeObserver = new ResizeObserver(() => {
        const next = this.scroller.clientHeight;
        if (next && (!height || this.wasAtBottom) && this.following) this.scrollToBottom();
        height = next;
      });
      this.resizeObserver.observe(this.scroller);
    }

    this.jump = document.createElement("button");
    this.jump.type = "button";
    this.jump.className = "chat-jump";
    this.jump.textContent = "Jump to latest";
    this.jump.hidden = true;
    this.jump.addEventListener("click", () => void this.jumpToLatest());

    this.announcer = document.createElement("div");
    this.announcer.className = "visually-hidden";
    this.announcer.setAttribute("aria-live", "polite");

    const form = document.createElement("form");
    form.className = "compose-form chat-form";
    this.form = form;
    this.label = document.createElement("label");
    this.label.htmlFor = "chat-text";
    this.label.textContent = "Message";
    this.input = document.createElement("textarea");
    this.input.id = "chat-text";
    this.input.rows = 2;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-describedby", "chat-message");
    // Mentions (#130): "@" offers the members who can read chat, plus everyone.
    this.chosenMentions = new Map();
    this.mentionList = document.createElement("ul");
    this.mentionList.id = "chat-mention-list";
    this.mentionList.className = "chat-mention-list";
    this.mentionList.setAttribute("role", "listbox");
    this.mentionList.setAttribute("aria-label", "Mention someone");
    this.mentionList.hidden = true;
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-expanded", "false");
    this.input.setAttribute("aria-controls", "chat-mention-list");
    this.input.addEventListener("keydown", (event) => {
      if (this.mentionMatch && !event.isComposing) {
        const count = this.mentionChoices.length;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          this.mentionIndex = (this.mentionIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
          this.renderMentionList();
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          this.pickMention(this.mentionChoices[this.mentionIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeMentions();
          return;
        }
      }
      if (event.key === "Escape" && this.editing) {
        event.preventDefault();
        this.stopEditing({ restoreDraft: true });
        return;
      }
      if (event.key === "Escape" && this.replyingTo && !event.isComposing) {
        event.preventDefault();
        this.stopReplying({ focus: true });
        return;
      }
      // Enter sends and Shift+Enter adds a line on a keyboard device; on a
      // touch screen Enter adds a line and the Send button sends.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || !this.enterSends()) return;
      event.preventDefault();
      form.requestSubmit();
    });
    this.send = document.createElement("button");
    this.send.type = "submit";
    this.send.className = "add-button";
    this.send.textContent = "Send";
    this.cancel = document.createElement("button");
    this.cancel.type = "button";
    this.cancel.className = "chat-cancel";
    this.cancel.textContent = "Cancel edit";
    this.cancel.hidden = true;
    this.cancel.addEventListener("click", () => {
      this.stopEditing({ restoreDraft: true });
      this.input.focus();
    });
    this.message = document.createElement("p");
    this.message.id = "chat-message";
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    // Emoji (#113): the OS emoji keyboard works here too.
    // Its panel sits right after the textarea, so the tab order follows what
    // shows: message, emoji (when open), then the buttons.
    const tooLong = `That would make the message too long. Keep it to ${MAX_CHAT_TEXT_CHARS.toLocaleString("en-US")} characters.`;
    this.emoji = document.createElement("kin-emoji-picker");
    this.emoji.target = this.input;
    const panelSlot = document.createElement("div");
    panelSlot.className = "emoji-slot";
    this.emoji.panelHost = panelSlot;
    this.emoji.addEventListener("kin:emoji-refused", () => { this.message.textContent = tooLong; });
    this.emoji.addEventListener("kin:emoji-inserted", () => {
      if (this.message.textContent === tooLong) this.message.textContent = "";
    });
    // Photos and files (#114): chosen with the file dialog, then listed here
    // until sent. The caption is whatever is in the message box.
    // No file input is kept in the page: one is made when Attach is pressed
    // and removed after the choice (see chooseFiles).
    this.attach = document.createElement("button");
    this.attach.type = "button";
    this.attach.className = "chat-attach";
    this.attach.textContent = "Attach";
    this.attach.setAttribute("aria-label", `Attach photos or files (up to ${MAX_ATTACHMENT_FILES})`);
    this.attach.addEventListener("click", () => this.chooseFiles());
    // Camera (#116): only where the main way to point at something is a touch
    // screen. The browser opens the camera app and hands back one photo.
    this.cameraButton = document.createElement("button");
    this.cameraButton.type = "button";
    this.cameraButton.className = "chat-attach chat-camera";
    this.cameraButton.textContent = "Camera";
    this.cameraButton.setAttribute("aria-label", "Camera, take a photo to attach");
    this.cameraButton.hidden = typeof matchMedia !== "function" || !matchMedia("(pointer: coarse)").matches;
    this.cameraButton.addEventListener("click", () => this.chooseFiles({ camera: true }));
    // Quick polls (#135): a question with 2 to 10 options.
    this.pollButton = document.createElement("button");
    this.pollButton.type = "button";
    this.pollButton.className = "chat-attach chat-poll-open";
    this.pollButton.textContent = "Poll";
    this.pollButton.setAttribute("aria-label", "Ask a poll");
    this.pollButton.addEventListener("click", () => this.askPoll());

    // Voice messages (#134): the recorder panel sits above the buttons.
    this.voiceButton = document.createElement("button");
    this.voiceButton.type = "button";
    this.voiceButton.className = "chat-voice-open";
    this.voiceButton.textContent = "Voice";
    this.voiceButton.setAttribute("aria-label", "Record a voice message");
    this.voiceButton.addEventListener("click", () => void this.voice.begin());
    this.voiceHost = document.createElement("div");
    this.voiceHost.className = "chat-voice-recorder";
    this.voice = new VoiceComposer({
      host: this.voiceHost,
      say: (text) => this.say(text),
      onChange: () => { this.applyDisabled(); if (!this.voice.open) (this.voiceButton.hidden ? this.input : this.voiceButton).focus(); },
      send: async ({ blob, durationMs }) => {
        const room = this.chatRoom;
        if (!room) throw new Error("locked");
        const peaks = await voicePeaks(blob, room.engine);
        await room.sendVoice({ recording: blob, durationMs, peaks, replyTo: this.replyingTo?.messageId ?? null });
        if (room !== this.chatRoom) return;
        this.stopReplying();
        await this.queueRender("reset");
      },
    });
    this.players = new Map();
    this.pollDialog = document.createElement("kin-chat-poll");
    // The quote bar above the box while replying (#129).
    this.replyBar = document.createElement("div");
    this.replyBar.className = "chat-replying";
    this.replyBar.hidden = true;
    this.replyBar.setAttribute("role", "group");
    this.replyBar.setAttribute("aria-label", "Replying to");
    this.replyText = document.createElement("p");
    this.replyText.className = "chat-replying-text";
    this.replyCancel = document.createElement("button");
    this.replyCancel.type = "button";
    this.replyCancel.className = "chat-replying-cancel";
    this.replyCancel.textContent = "Cancel";
    this.replyCancel.setAttribute("aria-label", "Cancel reply");
    this.replyCancel.addEventListener("click", () => this.stopReplying({ focus: true }));
    this.replyBar.append(this.replyText, this.replyCancel);
    this.pendingList = document.createElement("ul");
    this.pendingList.className = "chat-pending";
    this.pendingList.setAttribute("aria-label", "Photos and files to send");
    this.pendingList.hidden = true;
    const buttons = document.createElement("div");
    buttons.className = "chat-form-buttons";
    // While files are being prepared: stop. After a failed send: try again.
    this.stopSend = document.createElement("button");
    this.stopSend.type = "button";
    this.stopSend.className = "chat-stop-send";
    this.stopSend.textContent = "Cancel sending";
    this.stopSend.hidden = true;
    this.stopSend.addEventListener("click", () => this.sendAbort?.abort());
    this.retry = document.createElement("button");
    this.retry.type = "button";
    this.retry.className = "chat-attach chat-retry";
    this.retry.textContent = "Retry";
    this.retry.setAttribute("aria-label", "Retry sending");
    this.retry.hidden = true;
    this.retry.addEventListener("click", () => void this.submit());
    // One row (#311): [+] [message] [emoji] [Send, or Voice while empty].
    // Photo, file, camera and poll sit behind +.
    this.addMenu = document.createElement("div");
    this.addMenu.id = "chat-add-menu";
    this.addMenu.className = "chat-add-menu";
    this.addMenu.setAttribute("role", "group");
    this.addMenu.setAttribute("aria-label", "Add to the message");
    this.addMenu.hidden = true;
    this.addMenu.append(this.attach, this.cameraButton, this.pollButton);
    this.addMenu.addEventListener("click", (event) => { if (event.target.closest("button")) this.toggleAddMenu(false); });
    this.addMenu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.toggleAddMenu(false);
      this.more.focus();
    });
    this.more = document.createElement("button");
    this.more.type = "button";
    this.more.className = "chat-more";
    this.more.textContent = "+";
    this.more.setAttribute("aria-label", "Add a photo, file or poll");
    this.more.setAttribute("aria-expanded", "false");
    this.more.setAttribute("aria-controls", "chat-add-menu");
    this.more.addEventListener("click", () => this.toggleAddMenu(this.addMenu.hidden));
    this.input.placeholder = "Message";
    this.input.addEventListener("input", () => this.updateSendMode());
    const row = document.createElement("div");
    row.className = "chat-compose-row";
    row.append(this.more, this.input, this.emoji, this.send, this.voiceButton);
    this.label.className = "visually-hidden";
    buttons.append(this.retry, this.stopSend, this.cancel);
    form.append(this.label, this.replyBar, row, this.mentionList, this.addMenu, this.pendingList, this.voiceHost, panelSlot, buttons, this.message);
    this.updateSendMode();

    // A viewer for one photo, shown modally; its URL is released on close.
    this.viewer = document.createElement("dialog");
    this.viewer.className = "chat-viewer";
    this.viewer.setAttribute("aria-labelledby", "chat-viewer-name");
    this.viewer.addEventListener("close", () => this.closeViewer());

    // Who is typing: plain visible text, not a live region (it would be
    // announced on every change). The log's description carries it instead.
    this.typingLine = document.createElement("p");
    this.typingLine.id = "chat-typing";
    this.typingLine.className = "chat-typing";
    this.typingLine.hidden = true;
    this.scroller.setAttribute("aria-describedby", "chat-typing");
    this.input.addEventListener("input", () => { this.composerChanged(); this.updateMentions(); });
    this.input.addEventListener("click", () => this.updateMentions());
    this.input.addEventListener("paste", (event) => this.onPaste(event));
    this.addEventListener("dragover", (event) => this.onDragOver(event));
    this.addEventListener("dragleave", (event) => { if (!this.contains(event.relatedTarget)) this.form.classList.remove("chat-dropping"); });
    this.addEventListener("drop", (event) => this.onDrop(event));
    this.input.addEventListener("blur", () => {
      clearTimeout(this.mentionBlurTimer);
      this.mentionBlurTimer = setTimeout(() => this.closeMentions(), 150);
    });
    this.input.addEventListener("focus", () => clearTimeout(this.mentionBlurTimer));
    this.input.addEventListener("blur", () => this.chatRoom?.presence?.stopTyping());

    // A message's details: who has read it, and when.
    this.details = document.createElement("dialog");
    this.details.className = "chat-details";
    this.details.setAttribute("aria-labelledby", "chat-details-heading");
    this.details.addEventListener("close", () => this.closeDetails());

    // Message actions (#311): one sheet for every message. On a touch screen
    // it rises from the bottom (at most 480px wide); with a mouse it opens by
    // the message's ⋯, above it near the bottom of the screen. Long-press or
    // right-click a message, or press its ⋯. Escape, the backdrop or a swipe
    // down closes it, and focus goes back to the message's ⋯.
    this.sheet = document.createElement("dialog");
    this.sheet.className = "chat-action-sheet";
    this.sheet.addEventListener("cancel", (event) => { event.preventDefault(); this.closeMenu({ focusToggle: true }); });
    this.sheet.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.closeMenu({ focusToggle: true });
    });
    this.sheet.addEventListener("click", (event) => {
      if (event.target !== this.sheet) return;
      const box = this.sheet.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) this.closeMenu({ focusToggle: true });
    });
    let swipeFrom = null;
    this.sheet.addEventListener("pointerdown", (event) => { swipeFrom = event.pointerType === "mouse" ? null : event.clientY; });
    this.sheet.addEventListener("pointerup", (event) => {
      if (swipeFrom !== null && event.clientY - swipeFrom > 60) this.closeMenu({ focusToggle: true });
      swipeFrom = null;
    });
    this.sheet.addEventListener("pointercancel", () => { swipeFrom = null; });

    // Which rows are on screen decides what counts as read.
    if (typeof IntersectionObserver === "function") {
      this.rowObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.messageId;
          const root = entry.rootBounds?.height ?? 0;
          const shown = entry.isIntersecting && (entry.intersectionRatio >= 0.5 || (root > 0 && entry.intersectionRect.height >= root * 0.5));
          if (shown) this.onScreen.add(id);
          else this.onScreen.delete(id);
        }
        this.evaluateRead();
      }, { root: this.scroller, threshold: [0, 0.5, 1] });
    }

    this.readOnly = document.createElement("p");
    this.readOnly.className = "section-hint chat-read-only";
    this.readOnly.setAttribute("role", "status");
    this.readOnly.textContent = "Your household has set chat to read-only for you.";
    this.readOnly.hidden = true;
    section.append(top, this.searchPanel, this.notice, this.onlineLine, this.pinRegion, this.topicsPanel, this.scroller, this.typingLine, this.jump, form, this.readOnly, this.announcer, this.viewer, this.details, this.pollDialog, this.sheet);
    this.replaceChildren(section);
    this.section = section;
    this.renderTopics();
    // Composing on a phone (#310): the bottom navigation steps aside so the
    // composer sits right above the keyboard.
    form.addEventListener("focusin", () => this.setComposing(true));
    form.addEventListener("focusout", (event) => { if (!form.contains(event.relatedTarget)) this.setComposing(false); });
    this.startFit();
    this.queueRender("reset");
  }

  disconnectedCallback() {
    this.wideQuery?.removeEventListener?.("change", this.onWideChange);
    window.removeEventListener("kin-route-change", this.onRouteChange);
    document.removeEventListener("click", this.onDocumentClick);
    document.removeEventListener("visibilitychange", this.onWindowChange);
    window.removeEventListener("focus", this.onWindowChange);
    window.removeEventListener("blur", this.onWindowChange);
    window.removeEventListener("pagehide", this.onPageHide);
    this.chatRoom?.presence?.stopTyping();
    this.voice?.dispose();
    this.disposePlayers();
    this.resizeObserver?.disconnect();
    this.stopFit?.();
    this.stopFit = null;
    this.setComposing(false);
    this.urls.revokeAll();
  }

  /** Keeps the chat exactly as tall as the visible screen allows (#310). */
  startFit() {
    if (this.stopFit || !this.section) return;
    this.stopFit = fitChat(this.section, {
      bar: () => document.querySelector(".primary-nav"),
      onComposer: () => document.documentElement.style.setProperty("--chat-composer-height", `${Math.round(this.form?.getBoundingClientRect().height ?? 0)}px`),
    });
  }

  setComposing(on) {
    const root = document.documentElement;
    if (on === root.hasAttribute("data-chat-composing")) return;
    root.toggleAttribute("data-chat-composing", on);
    this.stopFit?.schedule();
  }

  /** The chat room, or null while there is none (sync not set up, locked). */
  set room(value) {
    if (value === this.chatRoom) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribePresence?.();
    this.unsubscribePresence = null;
    this.chatRoom?.presence?.stopTyping();
    this.chatRoom = value ?? null;
    if (this.search) this.search.room = this.chatRoom;
    this.resetView();
    this.stopEditing({ restoreDraft: true });
    if (this.chatRoom) {
      this.unsubscribe = this.chatRoom.subscribe(() => this.roomChanged());
      this.unsubscribePresence = this.chatRoom.subscribePresence?.(() => this.presenceChanged()) ?? null;
    }
    this.queueRender("reset");
    this.publishUnread({ now: true });
  }

  /** Tells the app how many messages are unread (#133), when that changed:
   * the Chat link and the app icon badge show it. No room, no count. */
  publishUnread({ now = false } = {}) {
    // Several changes in a row (a message arriving, then read) make one
    // update, so the link and the icon badge don't flicker.
    if (!now) {
      if (this.unreadTimer) return;
      this.unreadTimer = setTimeout(() => { this.unreadTimer = null; this.publishUnread({ now: true }); }, 250);
      return;
    }
    clearTimeout(this.unreadTimer);
    this.unreadTimer = null;
    let unread = { count: 0, mentions: 0, capped: false };
    try {
      if (this.chatRoom) unread = this.chatRoom.unread();
    } catch { /* a view that can't count shows none */ }
    const key = `${unread.count}:${unread.mentions ?? 0}:${unread.capped}`;
    if (key === this.publishedUnread) return;
    this.publishedUnread = key;
    this.dispatchEvent(new CustomEvent("kin:chat-unread", { bubbles: true, composed: true, detail: { count: unread.count, mentions: unread.mentions ?? 0, capped: unread.capped } }));
  }

  get room() {
    return this.chatRoom;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    this.applyDisabled();
  }

  /** Send shows while there's something to send; Voice while the box is
   * empty (#311). Editing always shows Send ("Save"). */
  updateSendMode() {
    if (!this.send || !this.voiceButton) return;
    const empty = !this.input.value.trim() && !this.files?.length && !this.editing;
    this.send.hidden = empty;
    this.voiceButton.hidden = !empty;
  }

  toggleAddMenu(open) {
    if (!this.addMenu) return;
    this.addMenu.hidden = !open;
    this.more.setAttribute("aria-expanded", String(open));
    if (open) this.addMenu.querySelector("button:not([hidden]):not(:disabled)")?.focus();
  }

  applyDisabled() {
    if (!this.input) return;
    this.updateSendMode();
    const off = this.isDisabled || !this.chatRoom;
    this.input.disabled = off;
    this.send.disabled = off || Boolean(this.sending);
    this.emoji.disabled = off;
    // Attachments aren't edited: no attaching while editing a message.
    this.attach.disabled = off || Boolean(this.sending) || Boolean(this.editing) || this.voice?.open === true;
    this.cameraButton.disabled = this.attach.disabled;
    this.retry.disabled = off || Boolean(this.sending) || Boolean(this.editing) || this.voice?.open === true;
    this.pollButton.disabled = off || Boolean(this.sending) || Boolean(this.editing);
    this.voiceButton.disabled = off || Boolean(this.sending) || Boolean(this.editing) || this.voice.open;
    this.more.disabled = off || Boolean(this.sending) || Boolean(this.editing);
  }

  enterSends() {
    return typeof matchMedia !== "function" || matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  /**
   * The app disables the workspace briefly while it refreshes household
   * state, which would drop focus from the composer mid-typing; it calls
   * these around that (app/status.js) so focus and the caret come back.
   */
  deferFocusedControl() {
    if (document.activeElement !== this.input) return;
    this.deferred = { start: this.input.selectionStart, end: this.input.selectionEnd };
  }

  settleDeferredFocus() {
    const deferred = this.deferred;
    this.deferred = null;
    if (!deferred || !this.input || this.input.disabled || !this.isConnected) return;
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(deferred.start, deferred.end);
  }

  /* ---------- Read receipts and typing (#120) ---------- */

  /** Whether the chat is really in front of someone: shown, in a visible and
   * focused window. Only then does a message on screen count as read. */
  canRead() {
    return this.isConnected && document.visibilityState === "visible" && document.hasFocus() &&
      this.offsetParent !== null && !this.closest("[hidden]");
  }

  /**
   * The newest message mostly on screen becomes the member's read position
   * (#133, private, kept even with read receipts off) and, if they send
   * receipts, their read cursor. On opening the chat, or coming back to it,
   * the "New messages" divider is placed first, from where they left off.
   */
  evaluateRead() {
    const room = this.chatRoom;
    if (!room) return;
    const reading = this.canRead();
    if (reading !== this.reading) {
      this.reading = reading;
      const first = reading ? room.unread?.().first?.messageId ?? null : null;
      if (first !== this.divider) {
        this.divider = first;
        this.dividerPending = Boolean(first);
        this.queueRender("page");
      }
    }
    if (!reading) return;
    let latest = null;
    // A message dated in the future can't be read past: the newest sane one counts.
    const horizon = (room.now?.() ?? Date.now()) + 5 * 60_000;
    for (const message of this.messages) if (this.onScreen.has(message.messageId) && message.postedAt <= horizon) latest = message;
    if (!latest) return;
    void room.markReadPosition?.(latest).catch(() => {});
    room.presence?.markRead(latest);
  }

  /** Scrolls to the divider, so the chat opens where the member left off. */
  scrollToDivider() {
    if (!this.dividerPending || !this.divider) return;
    const row = this.rows.get(this.divider)?.row;
    // One try: a divider outside the drawn rows (more unread than a page)
    // must not pull the view later, when older rows are drawn.
    this.dividerPending = false;
    if (!row || !this.scroller.clientHeight) return;
    this.scroller.scrollTop += row.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    this.wasAtBottom = this.atBottom();
    if (!this.wasAtBottom) this.jump.hidden = false;
  }

  windowChanged() {
    if (document.visibilityState !== "visible" || !document.hasFocus()) this.chatRoom?.presence?.stopTyping();
    // Recording stops when the page goes away; what was said is kept to review.
    if (document.visibilityState !== "visible") this.voice?.interrupt();
    this.evaluateRead();
  }

  /** Shows the mention choices for the "@word" at the caret, if any. */
  updateMentions() {
    const room = this.chatRoom;
    const match = room && !this.isDisabled ? activeMention(this.input.value, this.input.selectionStart ?? this.input.value.length) : null;
    const choices = match ? mentionOptions(room.mentionable?.() ?? [], match.query) : [];
    if (!match || !choices.length) { this.closeMentions(); return; }
    if (!this.mentionMatch || this.mentionMatch.query !== match.query) this.mentionIndex = 0;
    this.mentionMatch = match;
    this.mentionChoices = choices;
    this.renderMentionList();
  }

  renderMentionList() {
    this.mentionList.textContent = "";
    this.mentionChoices.forEach((choice, index) => {
      const option = document.createElement("li");
      option.id = `chat-mention-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === this.mentionIndex));
      option.textContent = choice.everyone ? "@everyone (everyone in this chat)" : `@${choice.label}`;
      // pointerdown keeps the focus in the message box.
      option.addEventListener("pointerdown", (event) => { event.preventDefault(); this.pickMention(choice); });
      this.mentionList.append(option);
    });
    this.mentionList.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.input.setAttribute("aria-activedescendant", `chat-mention-${this.mentionIndex}`);
    this.mentionList.children[this.mentionIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  closeMentions() {
    this.mentionMatch = null;
    this.mentionChoices = [];
    if (!this.mentionList) return;
    this.mentionList.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  pickMention(choice) {
    const match = this.mentionMatch;
    if (!match || !choice) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const text = this.input.value;
    const label = choice.everyone ? "everyone" : choice.label;
    const insert = `@${label} `;
    this.input.value = text.slice(0, match.start) + insert + text.slice(caret);
    const at = match.start + insert.length;
    this.input.setSelectionRange(at, at);
    if (choice.everyone) this.mentionEveryone = true;
    else this.chosenMentions.set(choice.label, choice.id);
    this.closeMentions();
    this.say(`Mentioned ${label}.`);
    this.input.focus();
    this.composerChanged();
  }

  /** The mentions to send with `text`: only those still written in it. */
  mentionsFor(text) {
    // Labels typed by hand count too, when they name someone who can be mentioned.
    const known = new Map(this.chosenMentions);
    for (const person of this.chatRoom?.mentionable?.() ?? []) if (!known.has(person.label)) known.set(person.label, person.id);
    return resolveMentions(text, known, true);
  }

  resetMentions() {
    this.chosenMentions = new Map();
    this.mentionEveryone = false;
    this.closeMentions();
  }

  composerChanged() {
    const presence = this.chatRoom?.presence;
    if (!presence) return;
    if (this.editing || !this.input.value.trim()) presence.stopTyping();
    else presence.typed();
  }

  /** The newest message from this member that the window shows, if the
   * window ends at the latest message: the one that carries "Seen by". */
  latestOwnId() {
    const room = this.chatRoom;
    if (!room || this.end !== this.total) return null;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.authorId === room.identity.memberId && visible(message) && !room.pendingMessages?.has(message.messageId)) return message.messageId;
    }
    return null;
  }

  /** The members who may have read `message`: the active members but its author. */
  audienceOf(message, room) {
    return (room.members ?? []).filter((member) => member.active !== false && member.id !== message.authorId);
  }

  /** Who has read `message`, and the line that says so ("" when no one). */
  seenLine(message, room) {
    // Only members still in the household count: a removed member's last
    // slot stays on the service, but they are no longer a reader.
    const audience = this.audienceOf(message, room);
    const readers = (room.presence?.readers(message) ?? []).filter((reader) => audience.some((member) => member.id === reader.memberId));
    if (!readers.length) return { readers, text: "" };
    const everyone = audience.length > 0 && audience.every((member) => readers.some((reader) => reader.memberId === member.id));
    return { readers, text: seenText(readers.map((reader) => room.authorLabel(reader.memberId)), everyone) };
  }

  /** The presence changed: redraw the "Seen by" line and the typing line,
   * not the messages. */
  /** Who is online now, as one line; a member this device shows no status
   * for (their own setting is off) sees nothing. */
  onlineMembers() {
    const room = this.chatRoom;
    return room?.presence?.online?.() ?? [];
  }

  renderOnline() {
    const room = this.chatRoom;
    const names = room ? this.onlineMembers().map((memberId) => room.authorLabel(memberId)) : [];
    this.onlineLine.hidden = !names.length;
    if (!names.length) {
      this.onlineLine.textContent = "";
      return;
    }
    const dot = document.createElement("span");
    dot.className = "chat-online-dot";
    dot.setAttribute("aria-hidden", "true");
    this.onlineLine.replaceChildren(dot, ` Online now: ${names.join(", ")}`);
  }

  presenceChanged() {
    const room = this.chatRoom;
    if (!room || !this.list) return;
    this.reconcile();
    this.renderOnline();
    const text = typingText(room.presence.typing().map((memberId) => room.authorLabel(memberId)));
    if (this.typingLine.textContent !== text) this.typingLine.textContent = text;
    this.typingLine.hidden = !text;
    this.evaluateRead();
  }

  openDetails(message) {
    const room = this.chatRoom;
    if (!room || typeof this.details.showModal !== "function") return;
    this.detailsOpener = document.activeElement;
    const { readers } = this.seenLine(message, room);
    const heading = document.createElement("h3");
    heading.id = "chat-details-heading";
    heading.textContent = "Message details";
    const seen = document.createElement("ul");
    seen.className = "chat-details-readers";
    seen.setAttribute("aria-label", "Seen by");
    for (const reader of readers) {
      const item = document.createElement("li");
      const when = new Date(reader.readAt);
      const time = document.createElement("time");
      time.dateTime = when.toISOString();
      time.textContent = (when.toDateString() === new Date().toDateString() ? TIME : DATE_TIME).format(when);
      item.append(`${room.authorLabel(reader.memberId)} · `, time);
      seen.append(item);
    }
    const others = this.audienceOf(message, room).filter((member) => !readers.some((reader) => reader.memberId === member.id));
    // Someone who sends no receipts isn't "not seen yet": nothing is known.
    const off = others.filter((member) => room.presence?.slots?.get(member.id)?.receipts === false);
    const waiting = others.filter((member) => !off.includes(member));
    const children = [heading, seen];
    const chips = reactionChips(message.reactions, room.identity.memberId, { names: this.emojiNames, labelOf: (id) => room.authorLabel(id) });
    if (chips.length) {
      const reacted = document.createElement("ul");
      reacted.className = "chat-details-reactions";
      reacted.setAttribute("aria-label", "Reactions");
      for (const chip of chips) {
        const item = document.createElement("li");
        item.textContent = `${chip.emoji} ${chip.name}: ${chip.who.join(", ")}`;
        reacted.append(item);
      }
      children.push(reacted);
    }
    for (const [members, label] of [[waiting, "Not seen yet"], [off, "Read receipts off"]]) {
      if (!members.length) continue;
      const rest = document.createElement("p");
      rest.className = "chat-details-waiting";
      rest.textContent = `${label}: ${members.map((member) => room.authorLabel(member.id)).join(", ")}`;
      children.push(rest);
    }
    const note = document.createElement("p");
    note.className = "section-hint";
    note.textContent = "A time is when that person's device had your message on screen, rounded to when it last reported.";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.details.close());
    this.details.replaceChildren(...children, note, close);
    this.details.showModal();
  }

  closeDetails() {
    this.details.replaceChildren();
    const opener = this.detailsOpener;
    this.detailsOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  roomChanged() {
    this.publishUnread();
    // Texts that weren't there yet, or couldn't be opened, get another try.
    for (const [messageId, status] of this.textStatus)
      if (status.pending || status.failed) this.textStatus.delete(messageId);
    for (const [messageId, state] of this.attachments)
      if (state.status === "pending" || state.status === "failed") this.attachments.delete(messageId);
    for (const [messageId, state] of this.polls)
      if (state.status === "pending" || state.status === "failed") this.polls.delete(messageId);
    this.queueRender("update");
  }

  /**
   * Coalesces renders: the room may notify several times in a row. A mode
   * says how the view moves: "reset" (to the latest), "page" (keep the rows
   * on screen in place), "update" (follow if following at the bottom, else
   * keep in place).
   */
  queueRender(mode = "update") {
    const rank = { update: 0, page: 1, reset: 2 };
    if (!this.pendingMode || rank[mode] > rank[this.pendingMode]) this.pendingMode = mode;
    if (this.renderQueued) return this.rendering;
    this.renderQueued = true;
    this.rendering = this.rendering.then(() => new Promise((resolve) => queueMicrotask(resolve))).then(() => {
      this.renderQueued = false;
      const next = this.pendingMode;
      this.pendingMode = null;
      try {
        this.render(next);
      } catch (error) {
        this.showNotice(error?.code === "chat_locked" ? "" : "Kin couldn't show the chat right now.");
      }
    });
    return this.rendering;
  }

  showNotice(text) {
    if (!this.notice) return;
    this.notice.textContent = text;
    this.notice.hidden = !text;
  }

  noticeText() {
    const room = this.chatRoom;
    if (!room) return "Chat works once this device syncs with your household. Turn on sync under Household → People & devices.";
    if (room.access === "none") return "Chat isn't available to you in this household.";
    if (room.chatKeys?.pending) return "Chat is paused until an adult's device updates the chat key. Messages you send wait on this device.";
    if (room.syncError?.code === "connection_unavailable") return "Offline. Messages you send wait on this device and go out when you reconnect.";
    if (room.syncError?.code === "chat_rate_limited") return "You're sending faster than the household service allows. Messages wait on this device and go out in a minute.";
    if (room.syncError?.code === "chat_storage_full") return "The household's chat storage is full. Messages and attachments wait on this device. An adult can free space by deleting old messages.";
    if (room.syncError?.code === "chat_limit") return "This household's chat has reached its size limit, so new messages wait on this device.";
    if (room.syncError) return "Chat is paused until household sync can continue. Messages you send wait on this device.";
    if (room.retireRefusal) return "A message was deleted here, but Kin couldn't delete its content on the household service.";
    if (room.refused?.length) return "Kin skipped a chat message it couldn't verify.";
    if (room.hiddenError?.code === "chat_hidden_full") return room.hiddenError.message;
    if (room.hiddenError) return "Messages you deleted for yourself aren't syncing with your other devices right now.";
    if (room.hiddenWaiting) return "Messages you deleted for yourself on your other devices arrive once one of them syncs.";
    return "";
  }

  /** The admin's chat policy for this member (#123): read-only swaps the
   * composer for a note; no access hides the chat itself. */
  applyAccess() {
    const access = this.chatRoom?.access ?? "write";
    this.form.hidden = access !== "write";
    // Without permission to post, a recording in progress ends with the form.
    if (access !== "write") this.voice?.dispose();
    this.readOnly.hidden = access !== "read";
    // A hidden scroller loses its position: start again at the latest message
    // when access comes back.
    const reappearing = this.scroller.hidden && access !== "none";
    this.scroller.hidden = access === "none";
    if (reappearing) queueMicrotask(() => this.queueRender("reset"));
    this.jump.hidden = this.jump.hidden || access === "none";
    if (access === "none" && this.details.open) this.details.close();
    if (access === "none" && this.viewer.open) this.viewer.close();
    this.typingLine.hidden = access === "none" || this.typingLine.hidden;
    if (access !== this.announcedAccess) {
      this.announcedAccess = access;
      this.dispatchEvent(new CustomEvent("kin:chat-access", { bubbles: true, composed: true, detail: { access } }));
    }
  }

  render(mode) {
    if (!this.list) return;
    this.applyDisabled();
    this.applyAccess();
    this.showNotice(this.noticeText());
    const room = this.chatRoom;
    if (!room) {
      this.list.replaceChildren();
      this.rows.clear();
      this.messages = [];
      this.older.hidden = true;
      this.jump.hidden = true;
      return;
    }
    const measured = this.scroller.clientHeight > 0;
    const atBottom = measured ? this.atBottom() : this.wasAtBottom;
    const wasFollowing = this.following;
    const anchor = mode === "reset" ? null : this.captureAnchor();
    const firstRender = !this.primed;
    this.primed = true;

    // One engine page per render: the newest messages while following,
    // otherwise the window as it stands.
    let page;
    if (mode === "reset") {
      page = room.page({ limit: PAGE, includePins: true, includeTopics: true });
    } else if (this.following) {
      // The window as it stands plus room for what arrived since, then
      // trimmed back to where the window starts (and to its size).
      const wide = room.page({ limit: Math.min(WINDOW_MAX + ARRIVAL_CHECK, this.end - this.start + ARRIVAL_CHECK), includePins: true, includeTopics: true });
      const from = Math.max(this.start, wide.total - WINDOW_MAX);
      const messages = wide.messages.filter((message) => message.index >= from);
      page = { ...wide, start: messages[0]?.index ?? wide.total, messages };
    } else {
      page = room.page({ before: this.end, limit: Math.max(1, this.end - this.start), includePins: true, includeTopics: true });
    }
    this.total = page.total;
    this.pins = page.pins ?? [];
    this.topics = page.topics ?? [];
    // Messages this member deleted for themselves don't show (#119); the
    // window still counts them, as the engine does.
    this.messages = page.messages.filter((message) => !room.isHidden?.(message.messageId));
    this.start = page.start;
    this.end = page.start + page.messages.length;
    if (this.end === this.total) this.following = true;

    // Arrivals: among the newest messages only, those from others this view
    // hasn't seen. Older history brought in by paging, and what's there when
    // a room opens, is seen, not announced.
    const newest = this.following ? page.messages.slice(-ARRIVAL_CHECK) : room.page({ limit: ARRIVAL_CHECK }).messages;
    const arrived = [];
    for (const message of newest) {
      if (this.seen.has(message.messageId)) continue;
      this.seen.add(message.messageId);
      if (mode !== "reset" && !firstRender && message.authorId !== room.identity.memberId && visible(message) && !room.isHidden?.(message.messageId)) arrived.push(message);
    }
    for (const message of page.messages) this.seen.add(message.messageId);

    this.reconcile();
    this.older.hidden = this.start === 0;
    if (mode === "reset" || (wasFollowing && atBottom && mode !== "page")) {
      this.scrollToBottom();
      this.jump.hidden = true;
    } else {
      if (anchor) this.restoreAnchor(anchor);
      if (!this.following || (arrived.length && !atBottom)) this.jump.hidden = false;
      else if (this.atBottom()) this.jump.hidden = true;
    }
    this.wasAtBottom = measured ? this.atBottom() : atBottom;
    this.scrollToDivider();
    if (arrived.length) this.toAnnounce.push(...arrived.map((message) => message.messageId));
    this.flushAnnouncements(newest);
    this.loadMissingTexts();
    this.loadMissingAttachments();
    this.loadMissingPolls();
  }

  /** Opens texts the engine doesn't hold yet, outside the render queue, and
   * repaints once they're in. */
  loadMissingTexts() {
    const room = this.chatRoom;
    const target = this.replyingTo && this.messages.find((message) => message.messageId === this.replyingTo.messageId);
    if (this.replyingTo && (room.isHidden?.(this.replyingTo.messageId) || (target && !visible(target)))) {
      this.stopReplying();
      this.say("The message you were replying to is gone.");
    }
    this.loadMissingQuotes();
    this.renderPins();
    this.renderTopics();
    this.renderOnline();
    const missing = this.messages.filter((message) => message.text === null && message.blobRef && message.contentKind === "text" && !this.textStatus.has(message.messageId));
    if (!missing.length) return;
    for (const message of missing) this.textStatus.set(message.messageId, { loading: true });
    room.loadTexts(missing).then((results) => {
      if (room !== this.chatRoom) return;
      for (const message of missing) {
        const result = results.get(message.messageId) ?? { failed: true };
        // Opened text goes to the engine, not here: the next page has it.
        if (typeof result.text === "string") this.textStatus.delete(message.messageId);
        else this.textStatus.set(message.messageId, result);
      }
      this.queueRender("update");
    }, () => {
      if (room !== this.chatRoom) return;
      for (const message of missing) this.textStatus.set(message.messageId, { failed: true });
      this.queueRender("update");
    });
  }

  /** The same for what replies quote (#129): the original's text, opened on
   * demand when it isn't in the engine yet. */
  loadMissingQuotes() {
    const room = this.chatRoom;
    // Pinned messages (#131) are opened the same way as quotes.
    const pinned = [...this.pins, ...this.topics.map((topic) => topic.quote)].map((pin) => ({ replyTo: pin, pin: true }));
    const replies = [...this.messages.filter((message) => message.replyTo && visible(message)), ...pinned].filter((message) => {
      const original = message.replyTo;
      return original && original.contentKind === "text" && original.blobRef && original.text === null &&
        !room.isHidden?.(original.messageId) && !this.textStatus.has(`quote:${original.messageId}`);
    });
    // A quoted attachment says "Photo" or its file name once its list is open.
    const files = [...new Map([...this.messages.filter((message) => visible(message)), ...pinned]
      .filter((message) => {
        const original = message.replyTo;
        return original && original.contentKind === "attachment" && original.blobRef &&
          !room.isHidden?.(original.messageId) && !this.attachments.has(original.messageId) &&
          !this.messages.some((shown) => shown.messageId === original.messageId);
      })
      .map(({ replyTo }) => [replyTo.messageId, replyTo])).values()];
    for (const original of files) {
      this.attachments.set(original.messageId, { status: "loading", text: "", files: [], thumbs: new Map(), quoteOnly: true });
      void this.loadAttachment(room, { ...original, contentKind: "attachment" }, { thumbnails: false });
    }
    if (!replies.length) return;
    for (const { replyTo } of replies) this.textStatus.set(`quote:${replyTo.messageId}`, { loading: true });
    const keys = [...new Set(replies.map(({ replyTo }) => replyTo.messageId))];
    room.loadQuoteTexts(replies).then((results) => {
      if (room !== this.chatRoom) return;
      for (const id of keys) {
        const result = results.get(id) ?? { failed: true };
        if (typeof result.text === "string") this.textStatus.delete(`quote:${id}`);
        else this.textStatus.set(`quote:${id}`, result);
      }
      this.queueRender("update");
    }, () => {
      if (room !== this.chatRoom) return;
      for (const id of keys) this.textStatus.set(`quote:${id}`, { failed: true });
      this.queueRender("update");
    });
  }

  /** Announces arrivals once their text is in (or that it can't be). */
  flushAnnouncements(newest) {
    const room = this.chatRoom;
    if (!this.toAnnounce.length || !room) return;
    const byId = new Map([...this.messages, ...newest].map((message) => [message.messageId, message]));
    const ready = [], waiting = [];
    for (const messageId of this.toAnnounce) {
      const message = byId.get(messageId);
      if (!message) continue;
      const status = this.textStatus.get(messageId);
      // Outside the window its text isn't being opened: say who wrote.
      const shown = this.rows.has(messageId);
      // An attachment's caption and files are settled once its load is done.
      const attachment = message.contentKind === "attachment" && visible(message);
      const poll = message.contentKind === "poll" && visible(message);
      const settled = attachment
        ? this.attachments.get(messageId)?.status !== undefined && this.attachments.get(messageId).status !== "loading"
        : poll
          ? this.polls.get(messageId)?.status !== undefined && this.polls.get(messageId).status !== "loading"
          : message.text !== null || !message.blobRef || (status && !status.loading);
      if (!shown || settled) ready.push(message);
      else waiting.push(messageId);
    }
    this.toAnnounce = waiting;
    if (!ready.length) return;
    const last = ready.at(-1);
    const more = ready.length > 1 ? `${ready.length} new messages. ` : "";
    const who = room.authorLabel(last.authorId);
    const asked = last.contentKind === "poll" && this.polls.get(last.messageId)?.status === "ready" ? this.polls.get(last.messageId).question : null;
    this.say(last.text !== null ? `${more}${who}: ${last.text}` : asked ? `${more}${who} asked a poll: ${asked}` : `${more}New message from ${who}.`);
  }

  /** Opens the captions and file lists of attachment messages on screen,
   * then their photo thumbnails, outside the render queue. */
  loadMissingAttachments() {
    const room = this.chatRoom;
    if (!room) return;
    const missing = this.messages.filter((message) => visible(message) && message.contentKind === "attachment" && message.blobRef &&
      (!this.attachments.has(message.messageId) || (this.attachments.get(message.messageId).quoteOnly && this.attachments.get(message.messageId).status !== "loading")));
    for (const message of missing) this.attachments.set(message.messageId, { status: "loading", text: "", files: [], thumbs: new Map() });
    for (const message of missing) void this.loadAttachment(room, message);
  }

  /** Opens the question and options of the polls on screen. */
  loadMissingPolls() {
    const room = this.chatRoom;
    if (!room) return;
    const missing = this.messages.filter((message) => visible(message) && message.contentKind === "poll" && message.blobRef && message.poll && !this.polls.has(message.messageId));
    for (const message of missing) this.polls.set(message.messageId, { status: "loading" });
    for (const message of missing) {
      room.openPoll(message).then((content) => {
        if (room !== this.chatRoom) return;
        this.polls.set(message.messageId, { status: "ready", ...content });
        this.queueRender("update");
      }, (error) => {
        if (room !== this.chatRoom) return;
        const status = error?.code === "chat_poll_deleted" ? "deleted" : error?.code === "chat_poll_pending" ? "pending" : "failed";
        this.polls.set(message.messageId, { status });
        this.queueRender("update");
      });
    }
  }

  async loadAttachment(room, message, { thumbnails = true } = {}) {
    let opened;
    try {
      opened = await room.openAttachment(message);
    } catch (error) {
      if (room !== this.chatRoom) return;
      const status = error?.code === "chat_attachment_deleted" ? "deleted" : error?.code === "chat_attachment_pending" ? "pending" : "failed";
      this.attachments.set(message.messageId, { status, text: "", files: [], thumbs: new Map(), quoteOnly: !thumbnails });
      this.queueRender("update");
      return;
    }
    if (room !== this.chatRoom) return;
    const state = { status: "ready", text: opened.text, files: opened.files, thumbs: new Map(), quoteOnly: !thumbnails };
    this.attachments.set(message.messageId, state);
    this.queueRender("update");
    for (let index = 0; thumbnails && index < opened.files.length; index += 1) {
      if (!opened.files[index].photo) continue;
      try {
        const blob = await room.attachmentThumbnail(message, index);
        if (!blob || room !== this.chatRoom || this.attachments.get(message.messageId) !== state) continue;
        state.thumbs.set(index, this.urls.create(blob));
        this.queueRender("update");
      } catch {
        // No thumbnail: the photo still opens from its button.
      }
    }
  }

  /** Brings the list in line with this.messages, reusing unchanged rows. */
  reconcile() {
    const room = this.chatRoom;
    const keep = new Map();
    let previous = null;
    let cursor = this.list.firstElementChild;
    this.latestOwn = this.latestOwnId();
    for (const message of this.messages) {
      const grouped = Boolean(previous && previous.authorId === message.authorId &&
        message.postedAt - previous.postedAt < GROUP_MS && visible(previous));
      const signature = this.signature(message, grouped, room);
      let entry = this.rows.get(message.messageId);
      if (!entry || entry.signature !== signature) {
        const focus = entry ? this.focusIn(entry.row) : null;
        const row = this.row(message, grouped, room);
        if (entry) {
          if (cursor === entry.row) cursor = row;
          this.rowObserver?.unobserve(entry.row);
          entry.row.replaceWith(row);
        }
        this.rowObserver?.observe(row);
        entry = { row, signature };
        if (focus) this.restoreFocus(row, focus);
      }
      keep.set(message.messageId, entry);
      if (entry.row !== cursor) this.list.insertBefore(entry.row, cursor);
      else cursor = cursor.nextElementSibling;
      previous = message;
    }
    for (const [messageId, entry] of this.rows) {
      if (keep.has(messageId)) continue;
      this.rowObserver?.unobserve(entry.row);
      this.onScreen.delete(messageId);
      this.disposePlayersOf(messageId);
      entry.row.remove();
    }
    this.rows = keep;
    if (this.searchMark) this.applySearchMark();
  }

  /** Plain text, with the message's mentions wrapped for emphasis. */
  fillText(body, message, room) {
    const found = room.mentionsOf?.(message);
    if (!found || (!found.everyone && !found.members.length)) { body.textContent = message.text; return; }
    const entries = room.mentionable?.() ?? [];
    const named = [...entries.filter((entry) => found.members.includes(entry.id))];
    // Others typed the label this member has in Household access, not "You".
    const myLabel = room.labels?.get(room.identity.memberId);
    const self = found.members.includes(room.identity.memberId) && myLabel ? [{ id: room.identity.memberId, label: myLabel }] : [];
    for (const piece of splitMentions(message.text, [...named, ...self], found.everyone)) {
      if (!piece.mention) { body.append(piece.text); continue; }
      const mark = document.createElement("mark");
      mark.className = "chat-mention";
      mark.textContent = piece.text;
      body.append(mark);
    }
  }

  signature(message, grouped, room) {
    const status = this.textStatus.get(message.messageId);
    const attachment = this.attachments.get(message.messageId);
    return [
      message.status, message.text ?? "", message.editedAt ?? "", message.blobRef ?? "", grouped,
      room.pendingMessages?.has(message.messageId) ?? false, status ? Object.keys(status)[0] : "",
      attachment ? [attachment.status, attachment.text, attachment.files.length, attachment.thumbs.size].join("\u0001") : "",
      room.authorLabel(message.authorId), this.actionsFor(message, room).join(),
      message.messageId === this.latestOwn ? this.seenLine(message, room).text : "",
      JSON.stringify(message.reactions ?? []), this.reacting === message.messageId ? (this.reactMore ? 2 : 1) : 0,
      (room.access ?? "write") === "write", this.emojiNames.size,
      message.replyTo ? [message.replyTo.index, message.replyTo.state, message.replyTo.text ?? "", message.replyTo.blobRef ?? "", room.isHidden?.(message.replyTo.messageId) ?? false, this.attachments.get(message.replyTo.messageId)?.status ?? "", this.attachments.get(message.replyTo.messageId)?.files[0]?.name ?? "", Object.keys(this.textStatus.get(`quote:${message.replyTo.messageId}`) ?? {})[0] ?? ""].join("\u0001") : "",
      this.highlighted === message.messageId, this.divider === message.messageId,
      room.mentionsOf ? JSON.stringify(room.mentionsOf(message)) : "",
      this.pins.some((pin) => pin.messageId === message.messageId),
      this.topicOf(message.messageId)?.state ?? "",
      this.onlineMembers().includes(message.authorId),
      message.contentKind === "poll" ? [this.polls.get(message.messageId)?.status ?? "", JSON.stringify(message.poll ?? null)].join("\u0001") : "",
    ].join("\u0000");
  }

  /** What in `row` has focus, to put it back on its replacement. */
  focusIn(row) {
    const active = document.activeElement;
    if (!active || !row.contains(active)) return null;
    if (active === row) return { row: true };
    return active.dataset.action ? { action: active.dataset.action } : { toggle: true };
  }

  restoreFocus(row, focus) {
    if (focus.row) {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      return;
    }
    const target = (focus.action && row.querySelector(`[data-action="${focus.action}"]`)) || row.querySelector(".chat-menu-button");
    if (target) target.focus({ preventScroll: true });
    else this.scroller.focus({ preventScroll: true });
  }

  row(message, grouped, room) {
    const item = document.createElement("li");
    item.className = "chat-row";
    item.dataset.messageId = message.messageId;
    if (message.authorId === room.identity.memberId) item.classList.add("own");
    if (room.mentionsOf?.(message).me) item.classList.add("chat-mentions-me");
    if (grouped) item.classList.add("grouped");
    const author = room.authorLabel(message.authorId);
    const header = document.createElement("p");
    // A grouped row keeps its author and time for screen readers.
    header.className = grouped ? "chat-meta visually-hidden" : "chat-meta";
    const name = document.createElement("span");
    name.className = "chat-author";
    name.textContent = author;
    if (this.onlineMembers().includes(message.authorId)) {
      const dot = document.createElement("span");
      dot.className = "chat-online-dot";
      dot.setAttribute("aria-hidden", "true");
      const sr = document.createElement("span");
      sr.className = "visually-hidden";
      sr.textContent = " (online now)";
      name.append(" ", dot, sr);
    }
    const time = document.createElement("time");
    const posted = new Date(message.postedAt);
    time.dateTime = posted.toISOString();
    const sameDay = posted.toDateString() === new Date().toDateString();
    time.textContent = (sameDay ? TIME : DATE_TIME).format(posted);
    time.title = FULL.format(posted);
    header.append(name, " · ", time);
    // "edited" sits by the time (and so in its row's accessible text).
    if (message.status === "edited") {
      const edited = document.createElement("span");
      edited.className = "chat-edited";
      edited.textContent = " · edited";
      header.append(edited);
    }
    if (this.divider === message.messageId) {
      const divider = document.createElement("div");
      divider.className = "chat-unread-divider";
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-label", "New messages");
      const label = document.createElement("span");
      label.setAttribute("aria-hidden", "true");
      label.textContent = "New messages";
      divider.append(label);
      item.append(divider);
    }
    item.append(header);
    if (this.highlighted === message.messageId) item.classList.add("chat-highlight");
    if (message.replyTo && visible(message)) item.append(this.quote(message, room));
    const topic = visible(message) ? this.topicOf(message.messageId) : null;
    if (topic) {
      const mark = document.createElement("p");
      mark.className = `chat-topic-mark chat-topic-${topic.state}`;
      mark.textContent = topic.state === "open" ? "🗨 To talk about" : "✓ Talked about";
      item.append(mark);
    }

    const body = document.createElement("p");
    body.className = "chat-text";
    if (!visible(message)) {
      body.classList.add("chat-gone");
      body.textContent = STATUS_TEXT[message.status];
    } else if (message.contentKind === "attachment") {
      // The caption, once its manifest is open; a message of files alone has none.
      const state = this.attachments.get(message.messageId);
      if (state?.status === "ready" && state.text) body.textContent = state.text;
      else if (state?.status === "ready") body.hidden = true;
      else {
        body.classList.add("chat-gone");
        body.textContent = ATTACHMENT_TEXT[state?.status ?? "loading"];
      }
    } else if (message.contentKind === "poll") {
      // The poll below carries its own question; until it opens, say so here.
      const state = this.polls.get(message.messageId);
      if (state?.status === "ready") body.hidden = true;
      else {
        body.classList.add("chat-gone");
        body.textContent = state?.status === "deleted" ? "This message was deleted"
          : state?.status === "pending" ? "Waiting for this poll to arrive…"
          : state?.status === "failed" ? "This poll couldn't be opened yet."
          : "Loading…";
      }
    } else if (message.text !== null) {
      this.fillText(body, message, room);
      // A message of only 1–3 emoji shows larger (#113).
      const count = emojiOnlyCount(message.text);
      if (count >= 1 && count <= 3) body.classList.add("chat-emoji-only");
    } else {
      const status = this.textStatus.get(message.messageId);
      body.classList.add("chat-gone");
      body.textContent = status?.deleted ? "This message was deleted"
        : status?.pending ? "Waiting for this message to arrive…"
        : status?.failed ? "This message couldn't be opened yet."
        : "Loading…";
    }
    item.append(body);
    const attached = visible(message) && message.contentKind === "attachment" ? this.attachments.get(message.messageId) : null;
    if (attached?.status === "ready" && attached.files.length) item.append(this.attachmentList(message, attached));
    const asked = visible(message) && message.contentKind === "poll" && message.poll ? this.polls.get(message.messageId) : null;
    if (asked?.status === "ready") {
      item.append(renderPoll({
        message, content: asked, room, canVote: (room.access ?? "write") === "write",
        onChoose: (choice) => void this.castVote(message, choice),
        onClose: () => void this.closePoll(message),
      }));
    }

    const notes = [];
    // A grouped row's time is visually hidden: show "edited" with the notes.
    if (message.status === "edited" && grouped) notes.push("Edited");
    if (room.pendingMessages?.has(message.messageId)) notes.push((room.access ?? "write") === "write" ? "Waiting to send" : "Not sent: chat is read-only for you");
    if (notes.length) {
      const note = document.createElement("p");
      note.className = "chat-note";
      note.textContent = notes.join(" · ");
      // A grouped row's hidden header already says "edited" to screen
      // readers: don't say it twice.
      if (notes.length === 1 && notes[0] === "Edited") note.setAttribute("aria-hidden", "true");
      item.append(note);
    }
    if (message.messageId === this.latestOwn) {
      const { text } = this.seenLine(message, room);
      if (text) {
        const seen = document.createElement("button");
        seen.type = "button";
        seen.className = "chat-seen";
        seen.textContent = text;
        seen.setAttribute("aria-label", `${text}. Show message details`);
        seen.addEventListener("click", () => this.openDetails(message));
        item.append(seen);
      }
    }
    if (visible(message)) {
      const chips = this.reactionList(message, room);
      if (chips) item.append(chips);
      if (this.reacting === message.messageId && this.canReact(room)) item.append(this.reactionBar(message, room));
    }
    const actions = this.actionsFor(message, room);
    const react = visible(message) && this.canReact(room) ? this.reactButton(message, author) : null;
    if (actions.length) this.bindPress(item, message.messageId);
    if (actions.length) item.append(this.menu(message, actions, author, react));
    else if (react) {
      const wrap = document.createElement("div");
      wrap.className = "chat-menu-wrap";
      wrap.append(react);
      item.append(wrap);
    }
    return item;
  }

  /** What a quote of `original` says: its first line, or why there isn't one. */
  quoteLine(original, room) {
    if (original.state === "unknown") return { text: "Original message isn't available", gone: true };
    if (room.isHidden?.(original.messageId)) return { text: "Message hidden", gone: true };
    if (original.state === "deleted") return { text: "Original message was deleted", gone: true };
    if (original.state === "removed-by-admin") return { text: "Original message was removed by an admin", gone: true };
    if (original.contentKind === "poll") return { text: "Poll", gone: false };
    if (original.contentKind === "attachment") {
      const attachment = this.attachments.get(original.messageId);
      if (attachment?.status === "deleted") return { text: "Original message was deleted", gone: true };
      const first = attachment?.status === "ready" ? attachment.files[0] : null;
      return { text: first?.photo ? "Photo" : first ? first.name : "Attachment", gone: false };
    }
    if (original.text === null) {
      const status = this.textStatus.get(`quote:${original.messageId}`);
      if (status?.deleted) return { text: "Original message was deleted", gone: true };
      if (status?.pending) return { text: "This message is still arriving.", gone: false };
      return { text: status?.failed ? "This message couldn't be opened yet." : "Loading…", gone: false };
    }
    const line = original.text.split("\n").find((part) => part.trim()) ?? "";
    return { text: clip(line, 100), gone: false };
  }

  /** The pinned bar and its list (#131). Pins this member deleted for
   * themselves don't show. */
  renderPins() {
    const room = this.chatRoom;
    const pins = room ? this.pins.filter((pin) => !room.isHidden?.(pin.messageId)) : [];
    this.shownPins = pins;
    if (!pins.length) {
      this.pinRegion.hidden = true;
      this.pinList.hidden = true;
      this.pinBar.setAttribute("aria-expanded", "false");
      return;
    }
    this.pinRegion.hidden = false;
    const latest = pins[pins.length - 1];
    const { text } = this.quoteLine(latest, room);
    const count = pins.length === 1 ? "1 pinned message" : `${pins.length} pinned messages`;
    this.pinBar.textContent = "";
    const icon = document.createElement("span");
    icon.className = "chat-pin-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📌";
    const line = document.createElement("span");
    line.className = "chat-pin-line";
    line.textContent = text;
    const total = document.createElement("span");
    total.className = "chat-pin-count";
    total.textContent = pins.length > 1 ? `${pins.length} pinned` : "Pinned";
    this.pinBar.append(icon, " ", total, " · ", line);
    this.pinBar.setAttribute("aria-label", `${count}. Latest: ${text}. ${this.pinList.hidden ? "Show" : "Hide"} all pinned messages`);
    const canPost = (room.access ?? "write") === "write";
    // A render replaces the list; keep the focus where it was (by pin and button).
    const focused = this.pinList.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused ? `${focused.closest(".chat-pin-item")?.dataset.messageId}:${focused.className}` : null;
    this.pinList.replaceChildren(...[...pins].reverse().map((pin) => {
      const item = document.createElement("li");
      item.className = "chat-pin-item";
      item.dataset.messageId = pin.messageId;
      const who = room.authorLabel(pin.pinnedBy);
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "chat-pin-jump";
      const { text: pinText } = this.quoteLine(pin, room);
      const author = pin.authorId ? room.authorLabel(pin.authorId) : "";
      jump.textContent = `${author ? `${author}: ` : ""}${pinText}`;
      const by = document.createElement("span");
      by.className = "chat-pin-by";
      by.textContent = `Pinned by ${who === "You" ? "you" : who}`;
      jump.setAttribute("aria-label", `${author ? `${author}: ` : ""}${pinText}. Pinned by ${who === "You" ? "you" : who}. Go to the message`);
      jump.addEventListener("click", () => {
        this.togglePins(false);
        void this.jumpTo(pin);
      });
      item.append(jump, by);
      if (canPost) {
        const unpin = document.createElement("button");
        unpin.type = "button";
        unpin.className = "chat-pin-unpin";
        unpin.textContent = "Unpin";
        unpin.setAttribute("aria-label", `Unpin: ${pinText}`);
        unpin.addEventListener("click", () => void this.setPin(pin, false));
        item.append(unpin);
      }
      return item;
    }));
    if (focusKey) {
      const same = [...this.pinList.querySelectorAll("button")].find((button) => `${button.closest(".chat-pin-item")?.dataset.messageId}:${button.className}` === focusKey);
      // The pin is gone (unpinned or removed): the bar is the next stop.
      (same ?? this.pinBar).focus({ preventScroll: true });
    }
  }

  topicOf(messageId) {
    return this.topics?.find((topic) => topic.messageId === messageId) ?? null;
  }

  wideTopics() {
    return Boolean(this.wideQuery?.matches);
  }

  /** The older Talk topics' element (kin-talk-list), kept in the panel. */
  set legacyTopics(element) {
    this.legacyTopicsElement = element;
    if (this.legacyHost && element && element.parentElement !== this.legacyHost) this.legacyHost.append(element);
  }

  get legacyTopics() {
    return this.legacyTopicsElement ?? null;
  }

  /** Open older topics, for the toolbar count (set by the app). */
  set legacyOpenCount(value) {
    const count = Number(value) || 0;
    if (count === this.legacyOpen) return;
    this.legacyOpen = count;
    this.renderTopics();
  }

  toggleTopics(open = !this.topicsOpen) {
    this.topicsOpen = open;
    this.renderTopics();
    if (open && !this.wideTopics()) this.topicsHeading?.focus({ preventScroll: true });
    this.stopFit?.schedule?.();
  }

  /** Shows the list (an old #updates/talk link): open, its heading focused. */
  openTopics() {
    const inside = this.topicsPanel?.contains(document.activeElement);
    this.topicsOpen = true;
    this.renderTopics();
    this.stopFit?.schedule?.();
    // Focus goes to the list's heading unless it is already in the list.
    if (!inside) this.topicsHeading?.focus({ preventScroll: false });
  }

  renderTopics() {
    if (!this.topicsPanel) return;
    const room = this.chatRoom;
    const topics = room ? this.topics.filter((topic) => !room.isHidden?.(topic.messageId)) : [];
    const open = topics.filter((topic) => topic.state === "open").length + this.legacyOpen;
    const wide = this.wideTopics() && !this.simple;
    // Simple view (#341) has no To talk about list.
    this.topicsPanel.hidden = this.simple || (!wide && !this.topicsOpen);
    this.topicsPanel.classList.toggle("chat-topics-side", wide);
    this.topicsToggle.hidden = wide || Boolean(this.simple);
    this.topicsToggle.setAttribute("aria-expanded", String(this.topicsOpen));
    this.topicsToggle.textContent = open ? `To talk about · ${open} open` : "To talk about";
    this.topicsToggle.setAttribute("aria-label", open ? `To talk about, ${open} open` : "To talk about, none open");
    this.section?.classList.toggle("chat-has-side", wide);
    const canPost = (room?.access ?? "write") === "write";
    const focused = this.topicList.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused ? `${focused.closest("[data-message-id]")?.dataset.messageId}:${focused.dataset.topicAction}` : null;
    const ordered = [...topics.filter((topic) => topic.state === "open"), ...topics.filter((topic) => topic.state !== "open")];
    this.topicsEmpty.hidden = ordered.length > 0;
    this.topicList.replaceChildren(...ordered.map((topic) => {
      const item = document.createElement("li");
      item.className = `chat-topic chat-topic-${topic.state}`;
      item.dataset.messageId = topic.messageId;
      const { text } = this.quoteLine(topic.quote, room);
      const author = topic.quote.authorId ? room.authorLabel(topic.quote.authorId) : "";
      const who = room.authorLabel(topic.flaggedBy);
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "chat-topic-jump";
      jump.dataset.topicAction = "jump";
      jump.textContent = `${author ? `${author}: ` : ""}${text}`;
      jump.setAttribute("aria-label", `${author ? `${author}: ` : ""}${text}. ${topic.state === "open" ? "To talk about" : "Talked about"}. Go to the message`);
      jump.addEventListener("click", () => {
        if (!wide) this.toggleTopics(false);
        void this.jumpTo(topic.quote);
      });
      const meta = document.createElement("span");
      meta.className = "chat-topic-meta";
      meta.textContent = `${topic.state === "open" ? "To talk about" : "Talked about"} · marked by ${who === "You" ? "you" : who}`;
      item.append(jump, meta);
      if (canPost) {
        const actions = document.createElement("div");
        actions.className = "chat-topic-actions";
        const act = (label, state, kind, aria) => {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.topicAction = kind;
          button.textContent = label;
          button.setAttribute("aria-label", `${aria}: ${text}`);
          button.addEventListener("click", () => void this.setTopic(topic.quote, state));
          actions.append(button);
        };
        if (topic.state === "open") act("Talked about", "resolved", "resolve", "Mark talked about");
        else act("Reopen", "open", "reopen", "Talk about again");
        act("Remove", "cleared", "remove", "Remove from the list");
        item.append(actions);
      }
      return item;
    }));
    if (focusKey) {
      const same = [...this.topicList.querySelectorAll("button")].find((button) => `${button.closest("[data-message-id]")?.dataset.messageId}:${button.dataset.topicAction}` === focusKey);
      (same ?? this.topicsHeading).focus({ preventScroll: true });
    }
  }

  /** Talk later, talked about, again, or off the list (#312). */
  async setTopic(message, state) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      await room.setTopic(message, state);
      this.say(state === "open" ? "On the To talk about list." : state === "resolved" ? "Marked talked about." : "Removed from the To talk about list.");
      await this.queueRender("update");
    } catch (error) {
      this.message.textContent = error?.code === "chat_read_only" ? "Chat is read-only for you." : "Kin couldn't change the list right now. Try again.";
    }
  }

  togglePins(open = this.pinList.hidden) {
    this.pinList.hidden = !open;
    this.pinBar.setAttribute("aria-expanded", String(open));
    this.renderPins();
  }

  /** Pins or unpins a message; the engine and the room say why when they refuse. */
  async setPin(message, on) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      await room.pin(message, on);
      this.say(on ? "Pinned." : "Unpinned.");
      await this.queueRender("update");
      if (!on && !this.shownPins?.length) this.input.focus();
    } catch (error) {
      const plain = error?.code === "chat_pin_limit" || error?.code === "chat_text_invalid";
      this.message.textContent = plain ? error.message : "Kin couldn't change the pin right now. Try again.";
    }
  }

  /** A compact quote above a reply; pressing it goes to the original. */
  quote(message, room) {
    const original = message.replyTo;
    const { text, gone } = this.quoteLine(original, room);
    const who = original.authorId ? room.authorLabel(original.authorId) : "";
    const hidden = room.isHidden?.(original.messageId) ?? false;
    const jumpable = original.index !== null && !hidden && original.state !== "unknown";
    const quote = document.createElement(jumpable ? "button" : "p");
    quote.className = "chat-quote";
    if (gone) quote.classList.add("chat-gone");
    if (jumpable) {
      quote.type = "button";
      quote.dataset.action = "quote";
      quote.setAttribute("aria-label", `In reply to ${who === "You" ? "you" : who}: ${text}. Go to the original message`);
      quote.addEventListener("click", () => void this.jumpTo(original));
    }
    if (who && !gone) {
      const name = document.createElement("span");
      name.className = "chat-quote-author";
      name.textContent = who;
      quote.append(name, " ");
    }
    quote.append(text);
    return quote;
  }

  /** Brings the original of a reply into view and marks it for a moment. */
  async jumpTo(original) {
    const room = this.chatRoom;
    if (!room || original.index === null) return;
    let row = this.rowFor(original.messageId);
    if (!row) {
      // Not in the window: load the stretch around it, as paging back does.
      const end = Math.min(this.total, original.index + Math.ceil(PAGE / 2));
      this.following = false;
      this.end = end;
      this.start = Math.max(0, end - PAGE);
      await this.queueRender("page");
      row = this.rowFor(original.messageId);
    }
    if (!row) {
      this.say("That message isn't available.");
      return;
    }
    clearTimeout(this.highlightTimer);
    this.highlighted = original.messageId;
    this.reconcile();
    row = this.rowFor(original.messageId);
    const calm = prefersReducedMotion();
    row.tabIndex = -1;
    row.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    row.focus({ preventScroll: true });
    this.highlightTimer = setTimeout(() => {
      this.highlighted = null;
      this.reconcile();
    }, 1800);
  }

  openSearch() {
    this.searchPanel.hidden = false;
    this.searchToggle.setAttribute("aria-expanded", "true");
    this.search.room = this.chatRoom;
    this.search.focusInput();
  }

  closeSearch({ focus = false } = {}) {
    this.searchPanel.hidden = true;
    this.searchToggle.setAttribute("aria-expanded", "false");
    this.clearSearchMark();
    if (focus) this.searchToggle.focus();
  }

  /** Opens a search result: brings the message into view, marks the row for
   * a moment and highlights the matched text with text ranges (the CSS
   * Custom Highlight API), never by rewriting markup (#124). */
  async showSearchResult({ messageId, index, ranges = [] }) {
    this.clearSearchMark();
    await this.jumpTo({ messageId, index });
    const message = this.messages.find((candidate) => candidate.messageId === messageId);
    if (!message || typeof message.text !== "string") return;
    this.searchMark = { messageId, text: message.text, ranges: excerptRanges(message.text, 0, ranges) };
    this.applySearchMark();
  }

  applySearchMark() {
    this.unmark?.();
    this.unmark = null;
    const mark = this.searchMark;
    // An edit since the search changed the text the ranges point into.
    const current = mark && this.messages.find((message) => message.messageId === mark.messageId);
    if (mark && current?.text !== mark.text) {
      this.searchMark = null;
      return;
    }
    const text = mark && this.rowFor(mark.messageId)?.querySelector(".chat-text");
    if (text) this.unmark = highlightRanges(text, mark.ranges);
  }

  clearSearchMark() {
    this.unmark?.();
    this.unmark = null;
    this.searchMark = null;
  }

  /** Starts answering `message`: the quote bar shows above the box. */
  startReplying(message) {
    const room = this.chatRoom;
    if (!room) return;
    if (this.editing) this.stopEditing({ restoreDraft: true });
    this.replyingTo = message;
    const who = room.authorLabel(message.authorId);
    const attachment = this.attachments.get(message.messageId);
    const first = attachment?.status === "ready" ? attachment.files[0] : null;
    const line = message.contentKind === "poll"
      ? `Poll: ${this.polls.get(message.messageId)?.question ?? ""}`
      : message.contentKind === "attachment"
      ? (first?.photo ? "Photo" : first ? first.name : "Attachment")
      : (message.text ?? "").split("\n").find((part) => part.trim()) ?? "";
    this.replyText.textContent = `Replying to ${who === "You" ? "yourself" : who}: ${clip(line, 80)}`;
    this.say(`Replying to ${who === "You" ? "yourself" : who}.`);
    this.replyBar.hidden = false;
    this.input.focus();
  }

  stopReplying({ focus = false } = {}) {
    this.replyingTo = null;
    this.replyBar.hidden = true;
    this.replyText.textContent = "";
    if (focus) this.input.focus();
  }

  canReact(room) {
    return (room.access ?? "write") === "write";
  }

  /** The chips under a message: emoji and count, each a button that toggles
   * this member's reaction. Pressing and holding (or the "See who reacted"
   * action) lists who reacted. */
  reactionList(message, room) {
    const chips = reactionChips(message.reactions, room.identity.memberId, { names: this.emojiNames, labelOf: (id) => room.authorLabel(id) });
    if (!chips.length) return null;
    // Names for emoji outside the quick set come from the picker's table.
    if (!this.namesLoaded && chips.some((chip) => chip.name === chip.emoji)) void this.loadNames();
    const list = document.createElement("ul");
    list.className = "chat-reactions";
    list.setAttribute("aria-label", "Reactions");
    const canReact = this.canReact(room);
    for (const chip of chips) {
      const entry = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-reaction";
      button.dataset.action = `react-${chip.emoji}`;
      button.setAttribute("aria-pressed", String(chip.mine));
      button.setAttribute("aria-label", chip.label);
      // Without write access the chip is a count, not a switch.
      if (!canReact) {
        button.setAttribute("aria-disabled", "true");
        button.removeAttribute("aria-pressed");
      }
      // Hover lists who reacted.
      button.title = `${chip.name}: ${chip.who.join(", ")}`;
      const emoji = document.createElement("span");
      emoji.textContent = chip.emoji;
      emoji.setAttribute("aria-hidden", "true");
      const count = document.createElement("span");
      count.className = "chat-reaction-count";
      count.textContent = String(chip.count);
      count.setAttribute("aria-hidden", "true");
      button.append(emoji, count);
      let timer = null;
      let held = false;
      const clear = () => { clearTimeout(timer); timer = null; };
      button.addEventListener("pointerdown", () => {
        held = false;
        clear();
        timer = setTimeout(() => { held = true; this.openDetails(message); }, LONG_PRESS_MS);
      });
      button.addEventListener("pointerup", clear);
      for (const type of ["pointerleave", "pointercancel"]) button.addEventListener(type, () => { clear(); held = false; });
      button.addEventListener("contextmenu", (event) => { event.preventDefault(); });
      button.addEventListener("click", () => {
        if (held) { held = false; return; }
        if (canReact) void this.react(message, chip.emoji, !chip.mine);
      });
      entry.append(button);
      list.append(entry);
    }
    return list;
  }

  reactButton(message, author) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-react-button";
    button.dataset.action = "react-open";
    button.textContent = "🙂";
    button.setAttribute("aria-label", `Add a reaction to ${author === "You" ? "your" : `${author}'s`} message`);
    button.setAttribute("aria-expanded", String(this.reacting === message.messageId));
    if (this.reacting === message.messageId) button.setAttribute("aria-controls", `chat-react-${message.messageId}`);
    button.addEventListener("click", () => {
      this.closeMenu();
      this.reacting = this.reacting === message.messageId ? null : message.messageId;
      this.reactMore = false;
      this.reconcile();
      this.rowFor(message.messageId)?.querySelector(this.reacting ? ".chat-react-bar button" : '[data-action="react-open"]')?.focus({ preventScroll: true });
    });
    return button;
  }

  /** Six quick reactions and "More", which opens every emoji the picker has. */
  reactionBar(message, room) {
    const bar = document.createElement("div");
    bar.className = "chat-react-bar";
    bar.id = `chat-react-${message.messageId}`;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Choose a reaction");
    bar.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.closeReactions({ focusToggle: true });
    });
    const choose = (emoji, name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = `react-${emoji}`;
      button.textContent = emoji;
      button.setAttribute("aria-label", name);
      const mine = (message.reactions ?? []).some((group) => group.emoji === emoji && group.actors.includes(room.identity.memberId));
      button.setAttribute("aria-pressed", String(mine));
      button.addEventListener("click", () => void this.react(message, emoji, !mine));
      return button;
    };
    for (const [emoji, name] of QUICK_REACTIONS) bar.append(choose(emoji, name));
    const more = document.createElement("button");
    more.type = "button";
    more.className = "chat-react-more";
    more.dataset.action = "react-more";
    more.textContent = this.reactMore ? "Fewer" : "More";
    more.setAttribute("aria-expanded", String(this.reactMore));
    more.addEventListener("click", async () => {
      this.reactMore = !this.reactMore;
      if (this.reactMore) await this.loadNames();
      this.reconcile();
      this.rowFor(message.messageId)?.querySelector('[data-action="react-more"]')?.focus({ preventScroll: true });
    });
    bar.append(more);
    if (this.reactMore) {
      const grid = document.createElement("div");
      grid.className = "chat-react-grid";
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", "All emoji");
      const quick = new Set(QUICK_REACTIONS.map(([emoji]) => emoji));
      for (const [emoji, name] of this.emojiNames) if (!quick.has(emoji)) grid.append(choose(emoji, name));
      bar.append(grid);
    }
    return bar;
  }

  closeReactions({ focusToggle = false } = {}) {
    const messageId = this.reacting;
    if (!messageId) return;
    this.reacting = null;
    this.reactMore = false;
    this.reconcile();
    if (focusToggle) this.rowFor(messageId)?.querySelector('[data-action="react-open"]')?.focus({ preventScroll: true });
  }

  /** Names for the chips of emoji outside the quick set: the picker's table. */
  async loadNames() {
    if (this.namesLoaded) return;
    this.namesLoaded = true;
    try {
      this.emojiNames = reactionNames(await loadEmojiTable());
      this.queueRender("update");
    } catch {
      this.namesLoaded = false;
    }
  }

  /** Opens the dialog that asks a poll (#135). */
  askPoll() {
    const room = this.chatRoom;
    if (!room || this.pollButton.disabled) return;
    this.pollDialog.open({
      opener: this.pollButton,
      submit: async (poll) => {
        try {
          const sent = await room.sendPoll(poll);
          this.following = true;
          await this.queueRender("reset");
          this.say("Poll sent.");
          return sent;
        } catch (error) {
          throw new Error(error?.code?.startsWith?.("chat_") ? error.message : "Kin couldn't send the poll. Try again.");
        }
      },
    });
  }

  /** Votes in a poll, or clears the vote; the engine refuses a vote in a
   * closed poll or one that changes nothing. */
  async castVote(message, choice) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      await room.vote(message, choice);
      this.say(choice.length ? "Vote saved." : "Vote cleared.");
    } catch (error) {
      if (error?.code !== 4) this.message.textContent = "Kin couldn't save your vote. Try again.";
      else this.say("That poll has changed. Showing the latest results.");
    }
    await this.queueRender("update");
  }

  async closePoll(message) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      await room.closePoll(message);
      this.say("Poll closed.");
    } catch {
      this.message.textContent = "Kin couldn't close the poll. Try again.";
    }
    await this.queueRender("update");
  }

  /** Turns this member's reaction on or off. */
  async react(message, emoji, on) {
    const room = this.chatRoom;
    if (!room || !this.canReact(room)) return;
    const focus = this.reacting === message.messageId;
    try {
      await room.react(message, emoji, on);
      this.say(on ? "Reaction added." : "Reaction removed.");
    } catch (error) {
      // A reaction that changed nothing (another device got there first)
      // just shows the current state.
      if (error?.code !== 4) this.message.textContent = "Kin couldn't do that right now. Try again.";
    }
    if (focus) this.closeReactions({ focusToggle: true });
    await this.queueRender("update");
  }

  /** The photos and files of an attachment message: a thumbnail per photo,
   * and a name, type and size per file. Both open (the photo in a viewer,
   * the file as a download). */
  attachmentList(message, state) {
    const list = document.createElement("ul");
    list.className = "chat-files";
    list.setAttribute("aria-label", "Attachments");
    state.files.forEach((file, index) => {
      const entry = document.createElement("li");
      const label = attachmentKindLabel(file);
      const size = formatAttachmentSize(file.size);
      if (file.photo) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-photo";
        button.setAttribute("aria-label", `Open photo ${file.name}`);
        const url = state.thumbs.get(index);
        if (url) {
          const image = document.createElement("img");
          image.src = url;
          image.alt = "";
          image.decoding = "async";
          button.append(image);
        } else {
          button.classList.add("chat-gone");
          button.textContent = "Loading photo…";
        }
        button.addEventListener("click", () => void this.openPhoto(message, index));
        entry.append(button);
      } else if (file.voice) {
        // One player per voice message, kept when its row is rebuilt (a
        // reaction arriving) so playback carries on.
        const key = `${message.messageId}:${index}`;
        let player = this.players.get(key);
        if (!player) {
          player = voicePlayer({
            author: this.chatRoom?.authorLabel(message.authorId) ?? "a member",
            voice: file.voice,
            load: () => this.chatRoom.attachmentFile(message, index),
          });
          this.players.set(key, player);
        }
        entry.append(player);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-file";
        button.setAttribute("aria-label", `Download ${file.name}, ${label}, ${size}`);
        const name = document.createElement("span");
        name.className = "chat-file-name";
        name.textContent = file.name;
        const details = document.createElement("span");
        details.className = "chat-file-details";
        details.textContent = `${label} · ${size}`;
        button.append(name, details);
        button.addEventListener("click", () => void this.downloadFile(message, index));
        entry.append(button);
      }
      list.append(entry);
    });
    return list;
  }

  disposePlayers() {
    for (const player of this.players?.values() ?? []) player.dispose();
    this.players?.clear();
  }

  /** Releases the voice players of one message that left the window. */
  disposePlayersOf(messageId) {
    for (const [key, player] of this.players ?? []) {
      if (!key.startsWith(`${messageId}:`)) continue;
      player.dispose();
      this.players.delete(key);
    }
  }

  /** Opens a photo in the viewer at full size. */
  async openPhoto(message, index) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      const blob = await room.attachmentFile(message, index);
      // Locked, or another room, while it decrypted: don't show it (#327).
      if (room !== this.chatRoom) return;
      const url = this.urls.create(blob);
      const file = this.attachments.get(message.messageId)?.files[index];
      if (this.viewerUrl) this.urls.revoke(this.viewerUrl);
      this.viewerUrl = url;
      // Focus goes back to the photo that was opened, when the viewer closes.
      this.viewerOpener = document.activeElement;
      this.viewer.replaceChildren();
      const heading = document.createElement("p");
      heading.id = "chat-viewer-name";
      heading.className = "chat-viewer-name";
      heading.textContent = file?.name ?? "Photo";
      const image = document.createElement("img");
      image.src = url;
      image.alt = `Photo: ${file?.name ?? "attachment"}`;
      const actions = document.createElement("div");
      actions.className = "chat-viewer-actions";
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = "Download";
      download.addEventListener("click", () => void this.downloadFile(message, index));
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => this.viewer.close());
      actions.append(download, close);
      this.viewer.append(heading, image, actions);
      this.viewer.showModal?.();
      if (!this.viewer.open) this.viewer.setAttribute("open", "");
      close.focus();
    } catch (error) {
      this.message.textContent = this.attachmentError(error);
    }
  }

  closeViewer() {
    if (this.viewerUrl) this.urls.revoke(this.viewerUrl);
    this.viewerUrl = null;
    this.viewer.replaceChildren();
    this.viewer.removeAttribute("open");
    const opener = this.viewerOpener;
    this.viewerOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  /** Saves a file (or a photo at full size) through a short-lived link. */
  async downloadFile(message, index) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      const blob = await room.attachmentFile(message, index);
      // Locked, or another room, while it decrypted: don't save it (#327).
      if (room !== this.chatRoom) return;
      const name = this.attachments.get(message.messageId)?.files[index]?.name ?? "Attachment";
      const url = this.urls.create(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => this.urls.revoke(url), DOWNLOAD_URL_MS);
    } catch (error) {
      this.message.textContent = this.attachmentError(error);
    }
  }

  attachmentError(error) {
    if (error?.code === "chat_attachment_deleted") return "That message was deleted.";
    if (error?.code === "chat_attachment_pending") return "That is still arriving. Try again in a moment.";
    if (error?.code === "chat_storage_unavailable" || error?.code === "connection_unavailable") return "Kin couldn't reach that attachment right now. Try again.";
    return "Kin couldn't open that attachment.";
  }

  /** Opens the file dialog once; the input is removed after the choice (or
   * a cancel), so the page never holds a file input between sends. */
  chooseFiles({ camera = false } = {}) {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    if (camera) {
      input.accept = "image/*";
      input.setAttribute("capture", "environment");
    } else {
      input.multiple = true;
    }
    const done = () => input.remove();
    input.addEventListener("change", () => { done(); this.addFiles([...input.files]); });
    input.addEventListener("cancel", done);
    document.body.append(input);
    input.click();
  }

  /** Something shared from another app (#389): into the composer, not
   * sent until the member presses Send. */
  prefill({ text = "", files = [] } = {}) {
    if (!this.input || this.input.disabled) return false;
    if (text) {
      this.input.value = this.input.value ? `${this.input.value}\n${text}` : text;
      this.input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (files.length) this.addFiles([...files]);
    this.updateSendMode?.();
    this.input.focus();
    return true;
  }

  /** Adds photos and files to the ones to send, within the limits. */
  addFiles(incoming) {
    if (!incoming.length) return;
    if (!this.canAttach()) {
      this.message.textContent = "Files can't be added right now.";
      return;
    }
    // A dropped folder arrives as an empty file.
    const empty = incoming.find((file) => !file.size);
    if (empty) {
      this.message.textContent = `${safeAttachmentName(empty.name)} is empty, or is a folder. Choose a file that has content.`;
      incoming = incoming.filter((file) => file.size);
      if (!incoming.length) return;
    }
    const next = [...this.files, ...incoming];
    const problem = attachmentProblem(next);
    if (problem) {
      this.message.textContent = problem;
      return;
    }
    if (!empty) this.message.textContent = "";
    this.files = next;
    this.retry.hidden = true;
    this.renderPending();
    this.say(incoming.length === 1 ? "1 file added." : `${incoming.length} files added.`);
  }

  /** Whether files can be added now: a room that allows posting, not mid-send,
   * not editing and not recording. */
  canAttach() {
    return Boolean(this.chatRoom) && (this.chatRoom.access ?? "write") === "write" && !this.isDisabled && !this.attach.disabled;
  }

  /** Paste and drop (#116): files from the clipboard or dragged in from the
   * desktop. Text pastes and drags are left to the browser. */
  filesOf(transfer) {
    return transfer?.types && [...transfer.types].includes("Files") ? [...(transfer.files ?? [])] : [];
  }

  onPaste(event) {
    const files = this.filesOf(event.clipboardData);
    // Copied text that also carries a picture (a spreadsheet, say) pastes as text.
    if (!files.length || [...event.clipboardData.types].includes("text/plain")) return;
    event.preventDefault();
    this.addFiles(files);
  }

  onDragOver(event) {
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    // Always claimed, so a drop never makes the browser open the file in this
    // tab and lose the draft; it is only accepted where files can be added.
    event.preventDefault();
    if (!this.canAttach()) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    this.form.classList.add("chat-dropping");
  }

  onDrop(event) {
    this.form.classList.remove("chat-dropping");
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    event.preventDefault();
    this.addFiles([...(event.dataTransfer.files ?? [])]);
  }

  renderPending() {
    this.pendingList.replaceChildren(...this.files.map((file, index) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${safeAttachmentName(file.name)} · ${formatAttachmentSize(file.size)}`;
      if (this.sending && this.progress) {
        // Preparing (encrypting) this file: a native progress bar, named.
        const bar = document.createElement("progress");
        const state = this.progress.get(index) ?? { done: 0, total: file.size };
        bar.max = Math.max(1, state.total);
        bar.value = state.done;
        bar.setAttribute("aria-label", `Preparing ${safeAttachmentName(file.name)}`);
        bar.textContent = `${Math.round((state.done / Math.max(1, state.total)) * 100)}%`;
        item.append(name, " ", bar);
        return item;
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-pending-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${safeAttachmentName(file.name)}`);
      remove.addEventListener("click", () => {
        this.files = this.files.filter((_, at) => at !== index);
        this.renderPending();
        (this.pendingList.querySelector("button") ?? this.attach).focus();
      });
      item.append(name, " ", remove);
      return item;
    }));
    this.pendingList.hidden = this.files.length === 0;
    this.updateSendMode();
    if (!this.files.length) this.retry.hidden = true;
  }

  actionsFor(message, room) {
    // Actions of switched-off features (#625): Talk later's, Save as a note.
    const hidden = this.hiddenActions;
    if (hidden?.size) return this.allActionsFor(message, room).filter((action) => !hidden.has(action));
    return this.allActionsFor(message, room);
  }

  allActionsFor(message, room) {
    // Anyone can delete any message for themselves; a deleted one too.
    if (!visible(message)) return ["hide"];
    const own = message.authorId === room.identity.memberId;
    const actions = [];
    if (message.text !== null) actions.push("copy");
    if (message.reactions?.length) actions.push("details");
    if ((room.access ?? "write") === "write") actions.push("reply");
    // Talk later (#312): onto the To talk about list, then talked about.
    if ((room.access ?? "write") === "write" && !this.simple) {
      const topic = this.topicOf(message.messageId);
      actions.push(topic?.state === "open" ? "talk-resolve" : topic?.state === "resolved" ? "talk-reopen" : "talk-later");
    }
    // Simple view (#341) adds nothing: no turning a message into a record.
    if (this.shareable(message) && !this.simple) actions.push("to-shopping", "to-todo", "to-handoff", "to-note");
    // A chat photo into the family photos (#673).
    if (!this.simple && message.contentKind === "attachment" && this.attachments.get(message.messageId)?.files?.some((file) => file.photo)) actions.push("to-photos");
    if ((room.access ?? "write") === "write") actions.push(this.pins.some((pin) => pin.messageId === message.messageId) ? "unpin" : "pin");
    // Read-only members (#123) can copy, hide and turn a message into a record
    // (#132), but not post, react, pin, edit or delete.
    const canPost = (room.access ?? "write") === "write";
    if (canPost && own && message.text !== null && message.contentKind === "text") actions.push("edit");
    if (canPost && own) actions.push("delete");
    else if (canPost && room.isAdmin) actions.push("remove");
    // Your own message still waiting to send would go out anyway.
    if (!(own && room.pendingMessages?.has(message.messageId))) actions.push("hide");
    return actions;
  }

  /** A message Kin can turn into a record (#132): its text or its files are
   * here on screen. Any member who can read chat may; the records are the
   * household's, not the chat's. */
  shareable(message) {
    if (message.contentKind === "attachment") return this.attachments.get(message.messageId)?.status === "ready";
    return message.contentKind === "text" && typeof message.text === "string" && message.text.trim() !== "";
  }

  /** Hands a message's text, and the files it carries, to the app's dialog
   * for a shopping item, task, handoff or note. */
  shareMessage(message, kind, opener) {
    const room = this.chatRoom;
    if (!room || !this.shareable(message)) return;
    const state = message.contentKind === "attachment" ? this.attachments.get(message.messageId) : null;
    const files = (state?.files ?? []).map((file, index) => ({ name: file.name, size: file.size, type: file.type, load: () => room.attachmentFile(message, index) }));
    const readers = new Set(room.readers ?? []);
    const limited = (room.members ?? []).some((member) => member.active !== false && !readers.has(member.id));
    this.dispatchEvent(new CustomEvent("kin:chat-to-record", { bubbles: true, composed: true, detail: { kind, text: state ? state.text ?? "" : message.text, files, limited, opener } }));
  }

  /** The row's ⋯: it opens the action sheet (#311). */
  menu(message, actions, author, react = null) {
    const wrap = document.createElement("div");
    wrap.className = "chat-menu-wrap";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "chat-menu-button";
    toggle.textContent = "⋯";
    toggle.setAttribute("aria-label", `Actions for ${author === "You" ? "your" : `${author}'s`} message`);
    toggle.setAttribute("aria-haspopup", "dialog");
    toggle.setAttribute("aria-expanded", String(this.menuFor === message.messageId));
    toggle.addEventListener("click", () => {
      if (this.menuFor === message.messageId) this.closeMenu({ focusToggle: true });
      else this.openMenu(message.messageId);
    });
    wrap.append(...(react ? [react] : []), toggle);
    return wrap;
  }

  /** Long-press (touch or pen) or right-click a message to open its
   * actions. Links, players, polls, reaction chips and buttons keep their
   * own presses. */
  bindPress(row, messageId) {
    let timer = 0;
    let start = null;
    let held = false;
    const skip = (target) => Boolean(target?.closest?.("a[href], audio, video, input, textarea, select, button, .chat-poll"));
    const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
    row.addEventListener("pointerdown", (event) => {
      held = false;
      if (event.pointerType === "mouse" || event.button !== 0 || skip(event.target)) return;
      start = [event.clientX, event.clientY];
      timer = setTimeout(() => { timer = 0; held = true; this.openMenu(messageId); }, LONG_PRESS_MS);
    });
    row.addEventListener("pointermove", (event) => {
      if (start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 10) cancel();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) row.addEventListener(type, cancel);
    // The click that ends a long press presses nothing else.
    row.addEventListener("click", (event) => {
      if (!held) return;
      held = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    row.addEventListener("contextmenu", (event) => {
      if (skip(event.target)) return;
      event.preventDefault();
      // A touch long press can bring both this and the timer: open once.
      cancel();
      if (this.menuFor !== messageId) this.openMenu(messageId);
    });
  }

  rowFor(messageId) {
    return this.rows.get(messageId)?.row ?? null;
  }

  openMenu(messageId) {
    const room = this.chatRoom;
    const message = this.messages.find((candidate) => candidate.messageId === messageId);
    if (!room || !message) return;
    const actions = this.actionsFor(message, room);
    if (!actions.length) return;
    if (this.menuFor && this.menuFor !== messageId) this.closeMenu();
    if (this.reacting) this.closeReactions();
    this.menuFor = messageId;
    // The ⋯ says the sheet is open; the row itself isn't redrawn.
    this.rowFor(messageId)?.querySelector(".chat-menu-button")?.setAttribute("aria-expanded", "true");
    const sheet = this.sheet;
    const author = room.authorLabel(message.authorId);
    const coarse = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
    sheet.replaceChildren();
    sheet.dataset.messageId = messageId;
    sheet.classList.toggle("chat-sheet-bottom", coarse);
    const heading = document.createElement("h2");
    heading.className = "visually-hidden";
    heading.id = "chat-sheet-heading";
    heading.textContent = `Actions for ${author === "You" ? "your" : `${author}'s`} message`;
    sheet.setAttribute("aria-labelledby", heading.id);
    sheet.append(heading);
    if (coarse) {
      const grip = document.createElement("div");
      grip.className = "chat-sheet-grip";
      grip.setAttribute("aria-hidden", "true");
      sheet.append(grip);
    }
    // First, quick reactions; "More" opens the full table on the row.
    if (visible(message) && this.canReact(room)) {
      const quick = document.createElement("div");
      quick.className = "chat-sheet-reactions";
      quick.setAttribute("role", "group");
      quick.setAttribute("aria-label", "React");
      for (const [emoji, name] of QUICK_REACTIONS) {
        const mine = (message.reactions ?? []).some((group) => group.emoji === emoji && group.actors.includes(room.identity.memberId));
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = `react-${emoji}`;
        button.textContent = emoji;
        button.setAttribute("aria-label", name);
        button.setAttribute("aria-pressed", String(mine));
        button.addEventListener("click", () => {
          this.closeMenu({ focusToggle: true });
          void this.react(message, emoji, !mine);
        });
        quick.append(button);
      }
      const more = document.createElement("button");
      more.type = "button";
      more.className = "chat-sheet-more";
      more.textContent = "More";
      more.setAttribute("aria-label", "More reactions");
      more.addEventListener("click", async () => {
        this.closeMenu();
        this.reacting = messageId;
        this.reactMore = true;
        await this.loadNames();
        this.reconcile();
        this.rowFor(messageId)?.querySelector(".chat-react-bar button")?.focus({ preventScroll: true });
      });
      quick.append(more);
      sheet.append(quick);
    }
    const list = document.createElement("div");
    list.className = "chat-menu";
    list.id = `chat-menu-${messageId}`;
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Message actions");
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = ACTION_LABELS[action];
      button.addEventListener("click", () => void this.act(action, message));
      list.append(button);
    }
    sheet.append(list);
    sheet.style.removeProperty("top");
    sheet.style.removeProperty("left");
    if (!sheet.open) sheet.showModal();
    if (!coarse) this.placeSheet(this.rowFor(messageId)?.querySelector(".chat-menu-button") ?? this.rowFor(messageId));
    list.querySelector("button")?.focus({ preventScroll: true });
  }

  /** With a mouse, the sheet opens by the message's ⋯: below it, or above
   * it when it wouldn't fit (the last messages, near the composer). */
  placeSheet(anchor) {
    if (!anchor) return;
    const view = globalThis.visualViewport;
    const bottom = view ? view.offsetTop + view.height : innerHeight;
    const right = view ? view.offsetLeft + view.width : innerWidth;
    const at = anchor.getBoundingClientRect();
    const box = this.sheet.getBoundingClientRect();
    const below = at.bottom + 4;
    const top = below + box.height <= bottom - 8 ? below : Math.max(8, at.top - box.height - 4);
    const left = Math.min(Math.max(8, at.right - box.width), right - box.width - 8);
    this.sheet.style.top = `${Math.round(top)}px`;
    this.sheet.style.left = `${Math.round(Math.max(8, left))}px`;
  }

  closeMenu({ focusToggle = false } = {}) {
    const messageId = this.menuFor;
    if (!messageId) return;
    this.menuFor = null;
    if (this.sheet?.open) this.sheet.close();
    this.sheet?.replaceChildren();
    if (this.sheet) delete this.sheet.dataset.messageId;
    this.rowFor(messageId)?.querySelector(".chat-menu-button")?.setAttribute("aria-expanded", "false");
    if (focusToggle) this.rowFor(messageId)?.querySelector(".chat-menu-button")?.focus({ preventScroll: true });
  }

  async act(action, message) {
    const room = this.chatRoom;
    this.closeMenu({ focusToggle: action === "copy" });
    if (!room) return;
    try {
      if (action === "details") {
        this.openDetails(message);
      } else if (action === "reply") {
        this.startReplying(message);
      } else if (action === "talk-later" || action === "talk-resolve" || action === "talk-reopen") {
        await this.setTopic(message, action === "talk-resolve" ? "resolved" : "open");
        this.rowFor(message.messageId)?.querySelector(".chat-menu-button")?.focus({ preventScroll: true });
      } else if (action === "pin" || action === "unpin") {
        await this.setPin(message, action === "pin");
        this.rowFor(message.messageId)?.querySelector(".chat-menu-button")?.focus({ preventScroll: true });
      } else if (action.startsWith("to-")) {
        this.shareMessage(message, action.slice(3), this.rowFor(message.messageId)?.querySelector(".chat-menu-button") ?? null);
      } else if (action === "copy") {
        await navigator.clipboard.writeText(message.text);
        this.say("Copied.");
      } else if (action === "edit") {
        this.stopReplying();
        if (!this.editing) {
          this.stashedDraft = this.input.value;
          this.stashedMentions = { chosen: this.chosenMentions, everyone: this.mentionEveryone === true };
        }
        this.editing = message;
        this.input.value = message.text;
        this.updateSendMode();
        this.resetMentions();
        for (const person of room.mentionable?.() ?? []) {
          if (room.mentionsOf?.(message).members.includes(person.id)) this.chosenMentions.set(person.label, person.id);
        }
        this.mentionEveryone = room.mentionsOf?.(message).everyone === true;
        this.label.textContent = "Editing message";
        this.form.classList.add("chat-editing");
        this.send.textContent = "Save";
        this.cancel.hidden = false;
        this.input.focus();
      } else if (action === "hide") {
        if (!confirm("Delete this message for you? It disappears here now and on your other devices as they sync. Nobody else sees any change.")) {
          this.rowFor(message.messageId)?.querySelector(".chat-menu-button")?.focus();
          return;
        }
        await room.hide(message);
        this.say("Deleted for you.");
        await this.queueRender("update");
        this.input.focus();
      } else if (action === "delete" || action === "remove") {
        const question = action === "delete"
          ? `Delete this message for everyone? Everyone will see that it was deleted. ${NO_RECALL}`
          : `Remove this message for everyone? Everyone will see "Removed by an admin". ${NO_RECALL}`;
        if (!confirm(question)) {
          this.rowFor(message.messageId)?.querySelector(".chat-menu-button")?.focus();
          return;
        }
        await room.remove(message, { byAdmin: action === "remove" });
        this.say(action === "delete" ? "Message deleted." : "Message removed.");
        await this.queueRender("update");
        // The row stays (now "This message was deleted").
        this.input.focus();
      }
    } catch (error) {
      this.message.textContent = action === "copy"
        ? "Kin couldn't copy that text."
        : error?.code === "chat_text_invalid" ? error.message : "Kin couldn't do that right now. Try again.";
    }
  }

  stopEditing({ restoreDraft = false } = {}) {
    const wasEditing = Boolean(this.editing);
    this.editing = null;
    if (!this.input) return;
    if (wasEditing && restoreDraft) this.input.value = this.stashedDraft ?? "";
    this.updateSendMode();
    this.stashedDraft = null;
    if (wasEditing) {
      this.resetMentions();
      if (restoreDraft && this.stashedMentions) {
        this.chosenMentions = this.stashedMentions.chosen;
        this.mentionEveryone = this.stashedMentions.everyone;
      }
      this.stashedMentions = null;
    }
    this.label.textContent = "Message";
    this.form?.classList.remove("chat-editing");
    this.send.textContent = "Send";
    this.cancel.hidden = true;
  }

  async submit() {
    const room = this.chatRoom;
    if (!room || this.isDisabled || this.sending) return;
    const text = this.input.value;
    room.presence?.stopTyping();
    // With photos or files, the caption may be empty.
    const withFiles = !this.editing && this.files.length > 0;
    const caption = withFiles && !text.trim() ? "" : text;
    const problem = withFiles ? (caption ? chatTextProblem(caption) : null) : chatTextProblem(text);
    if (problem) {
      this.message.textContent = problem;
      this.input.focus();
      return;
    }
    this.message.textContent = "";
    this.sending = true;
    this.retry.hidden = true;
    this.applyDisabled();
    const editing = this.editing;
    // Per-file progress and Cancel while photos and files are prepared.
    this.sendAbort = withFiles ? new AbortController() : null;
    this.progress = withFiles ? new Map() : null;
    if (withFiles) {
      this.stopSend.hidden = false;
      this.renderPending();
      // Send is about to be disabled; keep the keyboard on something useful.
      this.stopSend.focus();
      this.say("Sending files.");
    }
    try {
      const mentions = this.mentionsFor(withFiles ? caption : text);
      if (editing) await room.edit(editing, text, { mentions });
      else if (withFiles) {
        await room.sendAttachments({
          text: caption, files: this.files, replyTo: this.replyingTo?.messageId ?? null, mentions, signal: this.sendAbort.signal,
          onProgress: ({ index, done, total }) => {
            this.progress.set(index, { done, total });
            const bar = this.pendingList.children[index]?.querySelector("progress");
            if (bar) { bar.max = Math.max(1, total); bar.value = done; }
          },
        });
      }
      else await room.send(text, { replyTo: this.replyingTo?.messageId ?? null, mentions });
      // Locked or moved to another room meanwhile: its composer is someone
      // else's now; leave it alone (#327).
      if (room !== this.chatRoom) return;
      if (editing) {
        // Back to whatever draft was there before editing.
        this.stopEditing({ restoreDraft: this.input.value === text });
        await this.queueRender("update");
      } else {
        if (withFiles) {
          this.files = [];
          this.renderPending();
        }
        // Only clear what was sent: typing that continued meanwhile stays.
        if (this.input.value === text) { this.input.value = ""; this.resetMentions(); }
        this.updateSendMode();
        this.stopReplying();
        await this.queueRender("reset");
      }
    } catch (error) {
      if (room !== this.chatRoom) return;
      const plain = error?.code === "chat_text_invalid" || error?.code === "chat_attachment_invalid";
      if (withFiles && error?.code === "chat_attachment_cancelled") {
        this.message.textContent = "Sending was cancelled. Your files are still here.";
      } else if (withFiles && !plain) {
        // The draft stays, with a Retry beside Send.
        this.message.textContent = "Kin couldn't send that. Your text and files are still here.";
        this.retry.hidden = false;
      } else {
        this.message.textContent = plain ? error.message : "Kin couldn't send that. Your text is still here.";
      }
    } finally {
      this.sending = false;
      this.sendAbort = null;
      this.progress = null;
      this.stopSend.hidden = true;
      if (withFiles) this.renderPending();
      this.applyDisabled();
      if (!this.input.disabled) this.input.focus();
    }
  }

  say(text) {
    this.announcer.textContent = "";
    setTimeout(() => { this.announcer.textContent = text; }, 50);
  }

  atBottom() {
    const s = this.scroller;
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < EDGE;
  }

  scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.wasAtBottom = true;
  }

  /** The first row at or below the top of the view, and where it sits. */
  captureAnchor() {
    if (!this.scroller.clientHeight) return null;
    const top = this.scroller.getBoundingClientRect().top;
    for (const row of this.list.children) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { messageId: row.dataset.messageId, offset: box.top - top };
    }
    return null;
  }

  restoreAnchor(anchor) {
    const row = this.rowFor(anchor.messageId);
    if (!row) return;
    const top = this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += row.getBoundingClientRect().top - top - anchor.offset;
  }

  onScroll() {
    if (!this.chatRoom || this.paging || !this.scroller.clientHeight) return;
    this.wasAtBottom = this.atBottom();
    if (this.scroller.scrollTop < EDGE && this.start > 0) void this.loadOlder();
    else if (this.wasAtBottom && !this.following) void this.loadNewer();
    if (this.following && this.wasAtBottom) this.jump.hidden = true;
    // Jump to latest (#310) also shows once you scroll up more than half a
    // screen from the newest message.
    else if (this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight > this.scroller.clientHeight / 2) this.jump.hidden = false;
  }

  /** Brings older messages into the window, trimming the newest past the
   * window's size; the rows on screen stay where they are. */
  async loadOlder({ fromButton = false } = {}) {
    if (!this.chatRoom || this.start === 0 || this.paging) return;
    this.paging = true;
    try {
      this.start = Math.max(0, this.start - PAGE);
      if (this.end - this.start > WINDOW_MAX) this.end = this.start + WINDOW_MAX;
      if (this.end < this.total) this.following = false;
      await this.queueRender("page");
      // The button hides at the start of history: keep focus in the list.
      if (fromButton && this.older.hidden) this.scroller.focus({ preventScroll: true });
    } finally {
      this.paging = false;
    }
  }

  async loadNewer() {
    if (!this.chatRoom || this.paging) return;
    this.paging = true;
    try {
      this.end = Math.min(this.total, this.end + PAGE);
      if (this.end - this.start > WINDOW_MAX) this.start = this.end - WINDOW_MAX;
      await this.queueRender("page");
    } finally {
      this.paging = false;
    }
  }

  async jumpToLatest() {
    this.following = true;
    await this.queueRender("reset");
    this.jump.hidden = true;
    this.input?.focus();
  }

  /** Puts keyboard focus in the composer (keyboard shortcuts, navigation). */
  focusInput() {
    this.input?.focus();
  }
}

if (!customElements.get("kin-chat")) customElements.define("kin-chat", KinChat);

export { KinChat, MAX_CHAT_TEXT_CHARS };
