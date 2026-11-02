// The family fridge (#317, ADR 0011): a fixed 3:4 "door" everyone in the
// household draws on. Rust owns the board (board.rs); this element draws the
// KBRD state the board room returns and turns pointer strokes into board
// changes.
//
// - Strokes are drawn on a canvas sized to the door's CSS box × the device
//   pixel ratio (at most 3). The stroke in progress has its own layer, so the
//   rest is redrawn only when the board changes.
// - Pointer Events with `touch-action: none` on the door only: the page
//   around it still scrolls and zooms. While a pen is down, touches are
//   ignored (palm rejection); a second finger cancels a finger stroke.
// - Colours are palette indices (CSS custom properties), so dark mode and
//   forced colours remap them. Three widths. The eraser removes whole
//   strokes.
// - Undo and redo cover this device's own changes in this visit: undoing a
//   stroke erases it, undoing an erase brings the stroke back.
// - A text summary says what is on the fridge, for screen readers and for
//   anyone who can't see the drawing.
// - Magnets (#322) are buttons over the door, not pixels: each has a name,
//   takes focus, moves with the arrow keys (1%, Shift 10%) or "Move to" one
//   of nine regions, and can be dragged. Nothing needs dragging.
// - Clearing (#323) asks first and can be undone by anyone.
// - Kitchen-screen mode (#324): on a wide landscape touch screen (or in full
//   screen in landscape) the tools move to a side rail and the door takes the
//   height. Full screen shows the fridge alone. Neither changes automatic
//   lock; a note says how this screen locks, and locking leaves full screen.
// - The kitchen display (#700) sets `size="display"`: a layout for a wall
//   tablet (display.css), 64 px tools beside the door, the notes repeated in
//   large type under it, no full screen (the display is already), no
//   hover-only titles, and a magnet's menu offers nine big place buttons
//   instead of a drop-down.
import { MAX_VISIBLE_MAGNETS, MAX_VISIBLE_STROKES, BOARD_WIDTH, BOARD_HEIGHT, boardPoints, normalizeNote, simplifyStroke, splitStroke } from "../wasm/kin-board.js";
import { newBoardId } from "../board/board-room.js";
import { ERASE_REACH, FRIDGE_COLOURS, FRIDGE_WIDTHS, KITCHEN_QUERY, fridgeSummary, kitchenScreenNote, pathPoints, strokeAt } from "../board/fridge-view.js";
import { readAutoLockPreference } from "./app/constants.js";
import { KIN_MAGNETS, MAGNET_REGIONS, magnetName, magnetPosition, magnetTilt, nudge, regionPoint } from "../board/fridge-magnets.js";
import "./kin-emoji-picker.js";

const SVG = "http://www.w3.org/2000/svg";
const UNDONE = Object.freeze({ draw: "Drawing undone.", erase: "Erase undone.", place: "Magnet taken down.", remove: "Magnet back up.", move: "Magnet moved back.", clear: "The fridge is back as it was." });
const REDONE = Object.freeze({ draw: "Drawing restored.", erase: "Erased again.", place: "Magnet back up.", remove: "Magnet taken down.", move: "Magnet moved again.", clear: "Fridge cleared again." });
/** How long a keyboard move waits for more key presses before it is saved. */
const MOVE_SETTLE_MS = 600;

const MAX_PIXEL_RATIO = 3;
const UNDO_LIMIT = 50;

/** What a refused change means, in plain words. */
function changeProblem(error, board) {
  if ((board?.strokes?.length ?? 0) >= MAX_VISIBLE_STROKES) return "The fridge is full. Erase something or clear it to draw more.";
  if ((board?.magnets?.length ?? 0) >= MAX_VISIBLE_MAGNETS) return "The fridge has no room for another magnet. Take one down first.";
  if (error?.code === "board_locked") return "Unlock Kin to draw on the fridge.";
  if (error?.code === "board_read_only") return "Your household has set the fridge to look only for you.";
  return error?.userMessage ?? "Kin couldn't save that to the fridge. Try again.";
}

class KinFridge extends HTMLElement {
  static get observedAttributes() { return ["size"]; }

  constructor() {
    super();
    this.roomValue = null;
    this.unsubscribe = null;
    this.state = null;
    this.colour = 0;
    this.width = 1;
    this.tool = "pen";
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;
    this.penDown = false;
    this.labelOf = (id) => (id === this.memberId ? "you" : "a household member");
    this.memberId = null;
    this.onResize = () => this.resize();
    // Magnets moved by keyboard or drag but not saved yet: id -> [x, y].
    this.movingMagnets = new Map();
    this.moveTimers = new Map();
    // Where each moving magnet started, for undo.
    this.moveFrom = new Map();
    this.drag = null;
    this.onLayout = () => this.updateLayout();
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
    this.resizeObserver ??= typeof ResizeObserver === "function" ? new ResizeObserver(this.onResize) : null;
    this.resizeObserver?.observe(this.door);
    this.kitchenMedia ??= globalThis.matchMedia?.(KITCHEN_QUERY) ?? null;
    this.landscapeMedia ??= globalThis.matchMedia?.("(orientation: landscape)") ?? null;
    this.kitchenMedia?.addEventListener?.("change", this.onLayout);
    this.landscapeMedia?.addEventListener?.("change", this.onLayout);
    document.addEventListener("fullscreenchange", this.onLayout);
    this.updateLayout();
    // Before any room arrives (no sync yet) the line under the board still
    // says why the fridge can't be drawn on (#372); it used to stay blank.
    this.render();
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.kitchenMedia?.removeEventListener?.("change", this.onLayout);
    this.landscapeMedia?.removeEventListener?.("change", this.onLayout);
    document.removeEventListener("fullscreenchange", this.onLayout);
    this.leaveFullscreen();
  }

  get fullscreen() {
    return document.fullscreenElement === this;
  }

  /** On the kitchen display (#700). */
  get forDisplay() {
    return this.getAttribute("size") === "display";
  }

  attributeChangedCallback(name, before, after) {
    if (name !== "size" || before === after || !this.door) return;
    this.closeMagnetMenu({ focus: false });
    this.updateLayout();
    this.render();
  }

  /** The side-rail layout and the lock note (#324). */
  updateLayout() {
    if (!this.door) return;
    const fullscreen = this.fullscreen;
    const display = this.forDisplay;
    const rail = !display && (Boolean(this.kitchenMedia?.matches) || (fullscreen && Boolean(this.landscapeMedia?.matches)));
    if (display) this.dataset.layout = "display";
    else if (rail) this.dataset.layout = "rail";
    else delete this.dataset.layout;
    // The display is full screen already, and its lock is its own.
    if (display) this.leaveFullscreen();
    this.fullscreenButton.hidden = display || !this.canFullscreen;
    this.fullscreenButton.textContent = fullscreen ? "Leave full screen" : "Full screen";
    // A tooltip needs a hover a wall tablet doesn't have: the names stay as
    // accessible names, without the title.
    for (const button of [...this.colourButtons, ...this.widthButtons]) {
      if (display) button.removeAttribute("title");
      else button.title = button.getAttribute("aria-label");
    }
    this.kitchenNote.hidden = display || !(rail || fullscreen) || !this.room;
    if (!this.kitchenNote.hidden) this.kitchenNote.textContent = kitchenScreenNote(readAutoLockPreference());
    this.resize();
  }

  async toggleFullscreen() {
    try {
      if (this.fullscreen) await document.exitFullscreen();
      else await this.requestFullscreen({ navigationUI: "hide" });
    } catch {
      this.showStatus("This browser didn't allow full screen.");
    }
  }

  leaveFullscreen() {
    if (this.fullscreen) document.exitFullscreen?.().catch(() => {});
  }

  get room() {
    return this.roomValue;
  }

  /** The board room (board-room.js), or null while locked or unavailable. */
  set room(value) {
    if (value === this.roomValue) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.roomValue = value;
    this.undoStack = [];
    this.redoStack = [];
    this.cancelStroke();
    // A keyboard or drag move still settling belonged to the old room.
    for (const timer of this.moveTimers.values()) clearTimeout(timer);
    this.moveTimers.clear();
    this.movingMagnets.clear();
    this.moveFrom.clear();
    // Locking (no room) leaves full screen: a shared screen goes back to
    // the unlock screen, not a fridge that can't be used (#324).
    if (!value) this.leaveFullscreen();
    if (value) this.unsubscribe = value.subscribe(() => this.render());
    if (!this.firstElementChild) this.build();
    this.render();
    this.updateLayout();
  }

  build() {
    this.className = "fridge";
    const heading = document.createElement("h2");
    heading.className = "fridge-heading";
    heading.textContent = "Fridge";
    const lead = document.createElement("p");
    lead.className = "section-hint fridge-lead";
    lead.textContent = "A shared board for the household: draw anything. Everyone sees it once they sync.";

    this.tools = document.createElement("div");
    this.tools.className = "fridge-tools";
    this.tools.setAttribute("role", "toolbar");
    this.tools.setAttribute("aria-label", "Drawing tools");
    const colours = document.createElement("div");
    colours.className = "fridge-colours";
    colours.setAttribute("role", "group");
    colours.setAttribute("aria-label", "Pen colour");
    this.colourButtons = FRIDGE_COLOURS.map((name, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fridge-colour";
      button.style.setProperty("--swatch", `var(--fridge-ink-${index})`);
      button.setAttribute("aria-label", name);
      button.title = name;
      button.addEventListener("click", () => { this.colour = index; this.tool = "pen"; this.updateTools(); });
      colours.append(button);
      return button;
    });
    const widths = document.createElement("div");
    widths.className = "fridge-widths";
    widths.setAttribute("role", "group");
    widths.setAttribute("aria-label", "Pen width");
    this.widthButtons = FRIDGE_WIDTHS.map(({ label }, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fridge-width";
      button.dataset.width = String(index);
      button.setAttribute("aria-label", label);
      button.title = label;
      button.addEventListener("click", () => { this.width = index; this.tool = "pen"; this.updateTools(); });
      widths.append(button);
      return button;
    });
    this.eraserButton = document.createElement("button");
    this.eraserButton.type = "button";
    this.eraserButton.className = "fridge-eraser";
    this.eraserButton.textContent = "Eraser";
    this.eraserButton.addEventListener("click", () => { this.tool = this.tool === "eraser" ? "pen" : "eraser"; this.updateTools(); });
    this.undoButton = document.createElement("button");
    this.undoButton.type = "button";
    this.undoButton.textContent = "Undo";
    this.undoButton.addEventListener("click", () => void this.undo());
    this.redoButton = document.createElement("button");
    this.redoButton.type = "button";
    this.redoButton.textContent = "Redo";
    this.redoButton.addEventListener("click", () => void this.redo());
    const history = document.createElement("div");
    history.className = "fridge-history";
    history.append(this.undoButton, this.redoButton);
    this.magnetButton = document.createElement("button");
    this.magnetButton.type = "button";
    this.magnetButton.className = "fridge-add-magnet";
    this.magnetButton.textContent = "Add magnet";
    this.magnetButton.addEventListener("click", () => this.openMagnetDialog());
    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "fridge-clear";
    this.clearButton.textContent = "Clear fridge";
    this.clearButton.addEventListener("click", () => this.openClearDialog());
    this.restoreButton = document.createElement("button");
    this.restoreButton.type = "button";
    this.restoreButton.className = "fridge-restore";
    this.restoreButton.textContent = "Bring back what was cleared";
    this.restoreButton.hidden = true;
    this.restoreButton.addEventListener("click", () => void this.undoClear());
    this.fullscreenButton = document.createElement("button");
    this.fullscreenButton.type = "button";
    this.fullscreenButton.className = "fridge-fullscreen";
    this.fullscreenButton.textContent = "Full screen";
    this.canFullscreen = Boolean(document.fullscreenEnabled && typeof this.requestFullscreen === "function");
    this.fullscreenButton.hidden = !this.canFullscreen;
    this.fullscreenButton.addEventListener("click", () => void this.toggleFullscreen());
    this.tools.append(colours, widths, this.eraserButton, history, this.magnetButton, this.clearButton, this.restoreButton);

    this.door = document.createElement("div");
    this.door.className = "fridge-door";
    this.ink = document.createElement("canvas");
    this.ink.className = "fridge-ink";
    this.ink.setAttribute("aria-hidden", "true");
    this.live = document.createElement("canvas");
    this.live.className = "fridge-live";
    this.live.setAttribute("aria-hidden", "true");
    this.magnetLayer = document.createElement("ul");
    this.magnetLayer.className = "fridge-magnets";
    this.magnetLayer.setAttribute("aria-label", "Magnets");
    this.door.append(this.ink, this.live, this.magnetLayer);
    this.door.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.door.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.door.addEventListener("pointerup", (event) => void this.pointerUp(event));
    this.door.addEventListener("pointercancel", (event) => this.pointerCancel(event));
    this.door.addEventListener("contextmenu", (event) => event.preventDefault());

    this.summary = document.createElement("p");
    this.summary.className = "fridge-summary";
    this.summary.setAttribute("aria-live", "polite");
    this.status = document.createElement("p");
    this.status.className = "fridge-status";
    this.status.setAttribute("role", "status");
    this.status.hidden = true;
    this.kitchenNote = document.createElement("p");
    this.kitchenNote.className = "fridge-kitchen-note";
    this.kitchenNote.hidden = true;
    // The display's notes in large type (#700), readable across a kitchen
    // however small the door is drawn.
    this.notes = document.createElement("section");
    this.notes.className = "fridge-notes";
    this.notes.setAttribute("aria-labelledby", "fridge-notes-title");
    this.notes.hidden = true;
    const notesTitle = document.createElement("h3");
    notesTitle.id = "fridge-notes-title";
    notesTitle.className = "fridge-notes-title";
    notesTitle.textContent = "Notes on the fridge";
    this.notesList = document.createElement("ul");
    this.notesList.className = "fridge-notes-list";
    this.notes.append(notesTitle, this.notesList);

    const board = document.createElement("div");
    board.className = "fridge-board";
    board.append(this.door);
    this.append(heading, lead, this.tools, this.fullscreenButton, board, this.notes, this.summary, this.status, this.kitchenNote, this.buildMagnetDialog(), this.buildClearDialog());
    this.updateTools();
  }

  updateTools() {
    if (!this.tools) return;
    // Look only (#323): the fridge shows, its tools don't.
    // Without a room (no sync yet) there's nothing to draw on, so no tools:
    // showing them made the door look drawable when it wasn't (#372).
    const drawing = this.room?.access === "write";
    this.tools.hidden = !drawing;
    this.colourButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(this.tool === "pen" && index === this.colour)));
    this.widthButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === this.width)));
    this.eraserButton.setAttribute("aria-pressed", String(this.tool === "eraser"));
    this.door.dataset.tool = this.tool;
    const usable = Boolean(this.room);
    this.undoButton.disabled = !usable || !this.undoStack.length;
    this.redoButton.disabled = !usable || !this.redoStack.length;
    this.magnetButton.disabled = !usable;
    const empty = !(this.state?.strokes?.length || this.state?.magnets?.length);
    this.clearButton.disabled = !usable || empty;
    this.restoreButton.hidden = !usable || !this.state?.openClear;
  }

  showStatus(message) {
    this.status.textContent = message ?? "";
    this.status.hidden = !message;
  }

  render() {
    if (!this.firstElementChild) return;
    const room = this.room;
    if (!room) {
      this.state = null;
      this.summary.replaceChildren(
        "The fridge is shared through household sync, so it opens once this device syncs. Turn on sync under ",
        Object.assign(document.createElement("a"), { href: "#household/people", textContent: "Household → People & devices" }),
        ".",
      );
      this.door.setAttribute("aria-disabled", "true");
      this.drawInk();
      this.renderNotes();
      this.updateTools();
      return;
    }
    if (room.access === "none") {
      this.state = null;
      this.summary.textContent = "The fridge isn't available to you in this household.";
      this.door.hidden = true;
      this.renderNotes();
      this.updateTools();
      return;
    }
    this.door.hidden = false;
    this.door.removeAttribute("aria-disabled");
    if (room.access === "read") this.door.setAttribute("aria-disabled", "true");
    try {
      this.state = room.board();
    } catch (error) {
      if (error?.code === "board_locked") return;
      this.state = null;
      this.showStatus("Kin couldn't read the fridge on this device.");
    }
    let summary = fridgeSummary(this.state, this.labelOf);
    if (room.access === "read") summary += " Your household has set the fridge to look only for you.";
    if (room.waiting) summary += " Waiting to send.";
    // A household service from before the fridge has no board routes (404).
    if (room.syncError?.code === "not_found") summary += " The fridge needs an updated household service to reach the rest of the household; drawings stay on this device until then.";
    else if (room.syncError) summary += " The fridge will sync again shortly.";
    // A polite live region: only a real change is announced again.
    if (this.summary.textContent !== summary) this.summary.textContent = summary;
    this.drawInk();
    this.renderMagnets();
    this.renderNotes();
    this.updateTools();
  }

  /** The note magnets as a list in large type, on the display only. */
  renderNotes() {
    if (!this.notes) return;
    const notes = this.forDisplay ? (this.state?.magnets ?? []).filter((magnet) => magnet.kind === "note" && magnet.text) : [];
    this.notes.hidden = notes.length === 0;
    this.notesList.replaceChildren(...notes.map((magnet) => {
      const item = document.createElement("li");
      item.className = "fridge-note";
      const text = document.createElement("span");
      text.className = "fridge-note-text";
      text.textContent = magnet.text;
      const by = document.createElement("span");
      by.className = "fridge-note-by";
      by.textContent = `from ${this.labelOf(magnet.author)}`;
      item.append(text, by);
      return item;
    }));
  }

  // ---- Canvas -------------------------------------------------------------

  resize() {
    if (!this.door) return;
    const rect = this.door.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(MAX_PIXEL_RATIO, globalThis.devicePixelRatio || 1);
    for (const canvas of [this.ink, this.live]) {
      const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    this.drawInk();
  }

  palette() {
    const style = getComputedStyle(this);
    return FRIDGE_COLOURS.map((_, index) => style.getPropertyValue(`--fridge-ink-${index}`).trim() || "CanvasText");
  }

  /** Board units to canvas pixels. */
  scale(canvas) {
    return { x: canvas.width / BOARD_WIDTH, y: canvas.height / BOARD_HEIGHT };
  }

  drawPath(context, points, scale, widthUnits) {
    context.lineWidth = Math.max(1, widthUnits * scale.x);
    context.beginPath();
    if (points.length === 2) {
      context.arc(points[0] * scale.x, points[1] * scale.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    context.moveTo(points[0] * scale.x, points[1] * scale.y);
    for (let p = 2; p < points.length; p += 2) context.lineTo(points[p] * scale.x, points[p + 1] * scale.y);
    context.stroke();
  }

  drawInk() {
    const context = this.ink?.getContext?.("2d");
    if (!context) return;
    context.clearRect(0, 0, this.ink.width, this.ink.height);
    const strokes = this.state?.strokes ?? [];
    if (!strokes.length) return;
    const palette = this.palette();
    const scale = this.scale(this.ink);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      context.strokeStyle = context.fillStyle = palette[stroke.colour] ?? palette[0];
      this.drawPath(context, stroke.points, scale, FRIDGE_WIDTHS[stroke.width]?.units ?? FRIDGE_WIDTHS[1].units);
    }
  }

  // ---- Pointer input ------------------------------------------------------

  boardPoint(event) {
    const rect = this.door.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * BOARD_WIDTH, ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT];
  }

  pointerDown(event) {
    if (!this.room || this.room.access !== "write" || event.button > 0) return;
    // A magnet handles its own pointer (drag or menu).
    if (event.target.closest?.(".fridge-magnet-item")) return;
    // Palm rejection: while a pen is drawing, touches don't count.
    if (event.pointerType === "touch" && this.penDown) return;
    // A second finger while drawing with a finger is a gesture, not ink.
    if (this.stroke && this.stroke.pointerId !== event.pointerId) {
      if (this.stroke.pointerType === "touch" && event.pointerType === "touch") this.cancelStroke();
      return;
    }
    event.preventDefault();
    // Capture keeps a stroke going past the door's edge; some pointers
    // (a synthetic one, or one already lifted) can't be captured.
    try { this.door.setPointerCapture?.(event.pointerId); } catch { /* still draws inside the door */ }
    if (event.pointerType === "pen") this.penDown = true;
    if (this.tool === "eraser") {
      const point = this.boardPoint(event);
      this.stroke = { pointerId: event.pointerId, pointerType: event.pointerType, erasing: true, erased: new Set(), last: point };
      void this.eraseAt(point);
      return;
    }
    this.stroke = { pointerId: event.pointerId, pointerType: event.pointerType, points: [this.boardPoint(event)] };
    this.drawLive();
  }

  pointerMove(event) {
    const stroke = this.stroke;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const samples = events.length ? events : [event];
    if (stroke.erasing) {
      // Along the whole path between samples, so a quick swipe can't skip
      // over a thin line.
      for (const sample of samples) {
        const point = this.boardPoint(sample);
        for (const along of pathPoints(stroke.last, point, ERASE_REACH / 2)) void this.eraseAt(along);
        stroke.last = point;
      }
      return;
    }
    for (const sample of samples) stroke.points.push(this.boardPoint(sample));
    this.drawLive();
  }

  async pointerUp(event) {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    const stroke = this.stroke;
    if (event.pointerType === "pen") this.penDown = false;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    this.stroke = null;
    this.clearLive();
    if (stroke.erasing) return;
    const points = simplifyStroke(boardPoints(stroke.points), 2);
    if (!points.length) return;
    const ids = [];
    try {
      for (const piece of splitStroke(points)) {
        const strokeId = newBoardId();
        await this.changeIn(room, { type: "add-stroke", strokeId, colour: this.colour, width: this.width, points: piece });
        ids.push(strokeId);
      }
      this.showStatus("");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    if (ids.length) this.remember(room, { kind: "draw", ids });
  }

  pointerCancel(event) {
    if (event.pointerType === "pen") this.penDown = false;
    if (this.stroke?.pointerId === event.pointerId) this.cancelStroke();
  }

  cancelStroke() {
    this.stroke = null;
    this.clearLive();
  }

  drawLive() {
    const context = this.live?.getContext?.("2d");
    const points = this.stroke?.points;
    if (!context || !points?.length) return;
    context.clearRect(0, 0, this.live.width, this.live.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = context.fillStyle = this.palette()[this.colour];
    this.drawPath(context, points.flat(), this.scale(this.live), FRIDGE_WIDTHS[this.width].units);
  }

  clearLive() {
    const context = this.live?.getContext?.("2d");
    if (context) context.clearRect(0, 0, this.live.width, this.live.height);
  }

  async eraseAt([x, y]) {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    const hit = strokeAt(this.state?.strokes ?? [], x, y);
    if (!hit || this.stroke?.erased?.has(hit.id)) return;
    this.stroke?.erased?.add(hit.id);
    try {
      await this.changeIn(room, { type: "hide-stroke", strokeId: hit.id, hidden: true });
      this.remember(room, { kind: "erase", ids: [hit.id] });
      this.showStatus("");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
  }

  // ---- Magnets (#322) ----------------------------------------------------

  kinMagnetIcon(number) {
    const drawn = KIN_MAGNETS[number - 1];
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", drawn?.path ?? "");
    path.setAttribute("fill", drawn?.fill ?? "currentColor");
    if (drawn?.number === 3) { path.setAttribute("stroke", drawn.fill); path.setAttribute("stroke-width", "2"); }
    svg.append(path);
    return svg;
  }

  renderMagnets() {
    if (!this.magnetLayer) return;
    const magnets = this.state?.magnets ?? [];
    const focused = this.magnetLayer.contains(document.activeElement) ? document.activeElement.dataset.magnetId : null;
    const items = magnets.map((magnet) => {
      const item = document.createElement("li");
      item.className = "fridge-magnet-item";
      const pending = this.movingMagnets.get(magnet.id);
      const shown = pending ? { ...magnet, x: pending[0], y: pending[1] } : magnet;
      const { left, top } = magnetPosition(shown);
      item.style.left = left;
      item.style.top = top;
      item.style.setProperty("--tilt", `${magnetTilt(magnet.id)}deg`);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `fridge-magnet fridge-magnet-${magnet.kind}`;
      button.dataset.magnetId = magnet.id;
      const name = magnetName(magnet);
      const by = this.labelOf(magnet.author);
      button.setAttribute("aria-label", `${name}, put up by ${by}`);
      if (!this.forDisplay) button.title = `Put up by ${by}`;
      if (magnet.kind === "kin") button.append(this.kinMagnetIcon(magnet.number));
      else button.textContent = magnet.text;
      button.addEventListener("keydown", (event) => this.magnetKey(event, magnet));
      button.addEventListener("pointerdown", (event) => this.magnetPointerDown(event, magnet, item));
      button.addEventListener("pointermove", (event) => this.magnetPointerMove(event, item));
      button.addEventListener("pointerup", (event) => void this.magnetPointerUp(event, magnet, item));
      button.addEventListener("pointercancel", () => { this.drag = null; this.renderMagnets(); });
      button.addEventListener("click", (event) => {
        if (event.detail === 0 && this.room?.access === "write") this.openMagnetMenu(magnet, button);
      });
      item.append(button);
      return item;
    });
    this.magnetLayer.replaceChildren(...items);
    if (focused) this.magnetLayer.querySelector(`[data-magnet-id="${focused}"]`)?.focus();
  }

  magnetKey(event, magnet) {
    if (this.room?.access !== "write") return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      void this.removeMagnet(magnet);
      return;
    }
    const from = this.movingMagnets.get(magnet.id) ?? [magnet.x, magnet.y];
    const to = nudge(from, event.key, { large: event.shiftKey });
    if (!to) return;
    event.preventDefault();
    this.queueMove(magnet, to);
  }

  /** Moves a magnet on screen now and saves it once the keys settle, so a
   * held arrow key makes one change, not dozens. */
  queueMove(magnet, to) {
    if (!this.movingMagnets.has(magnet.id)) this.moveFrom.set(magnet.id, [magnet.x, magnet.y]);
    this.movingMagnets.set(magnet.id, to);
    this.renderMagnets();
    clearTimeout(this.moveTimers.get(magnet.id));
    this.moveTimers.set(magnet.id, setTimeout(() => void this.saveMove(magnet.id), MOVE_SETTLE_MS));
  }

  async saveMove(magnetId) {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    clearTimeout(this.moveTimers.get(magnetId));
    this.moveTimers.delete(magnetId);
    const to = this.movingMagnets.get(magnetId);
    const from = this.moveFrom.get(magnetId);
    this.moveFrom.delete(magnetId);
    if (!to || !this.room) { this.movingMagnets.delete(magnetId); return; }
    try {
      if (!from || from[0] !== to[0] || from[1] !== to[1]) {
        await this.changeIn(room, { type: "move-magnet", magnetId, x: to[0], y: to[1] });
        this.remember(room, { kind: "move", id: magnetId, from, to });
      }
      this.showStatus("");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    } finally {
      this.movingMagnets.delete(magnetId);
      this.render();
    }
  }

  magnetPointerDown(event, magnet, item) {
    if (!this.room || this.room.access !== "write" || event.button > 0) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* still moves inside the door */ }
    this.drag = { pointerId: event.pointerId, magnetId: magnet.id, startX: event.clientX, startY: event.clientY, moved: false };
    item.classList.add("is-dragging");
  }

  magnetPointerMove(event, item) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) drag.moved = true;
    if (!drag.moved) return;
    const [x, y] = this.boardPoint(event);
    const at = [Math.min(4095, Math.max(0, Math.round(x))), Math.min(5460, Math.max(0, Math.round(y)))];
    drag.to = at;
    const { left, top } = magnetPosition({ x: at[0], y: at[1] });
    item.style.left = left;
    item.style.top = top;
  }

  async magnetPointerUp(event, magnet, item) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    item.classList.remove("is-dragging");
    if (!drag.moved || !drag.to) {
      this.openMagnetMenu(magnet, event.currentTarget);
      return;
    }
    this.movingMagnets.set(magnet.id, drag.to);
    this.moveFrom.set(magnet.id, [magnet.x, magnet.y]);
    await this.saveMove(magnet.id);
  }

  /** A small menu for a magnet: move it to a named place, or take it down. */
  openMagnetMenu(magnet, anchor) {
    this.closeMagnetMenu();
    const menu = document.createElement("div");
    menu.className = "fridge-magnet-menu";
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", magnetName(magnet));
    const moveTo = (to) => {
      this.closeMagnetMenu({ focus: false });
      this.movingMagnets.set(magnet.id, to);
      this.moveFrom.set(magnet.id, [magnet.x, magnet.y]);
      void this.saveMove(magnet.id).then(() => this.focusMagnet(magnet.id));
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "fridge-magnet-remove";
    remove.textContent = "Take it down";
    remove.addEventListener("click", () => { this.closeMagnetMenu({ focus: false }); void this.removeMagnet(magnet); });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "fridge-magnet-done";
    close.textContent = "Done";
    close.addEventListener("click", () => this.closeMagnetMenu());
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.closeMagnetMenu(); }
    });
    this.magnetMenu = { menu, magnetId: magnet.id };
    if (this.forDisplay) {
      // A wall tablet (#700): the nine places as a 3 × 3 grid of big
      // buttons, laid out like the door; one tap moves the magnet.
      const places = document.createElement("div");
      places.className = "fridge-magnet-places";
      places.setAttribute("role", "group");
      places.setAttribute("aria-label", "Move to");
      for (const region of MAGNET_REGIONS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "fridge-magnet-place";
        button.dataset.region = region.id;
        button.textContent = region.label;
        button.addEventListener("click", () => moveTo(regionPoint(region.id)));
        places.append(button);
      }
      const heading = document.createElement("p");
      heading.className = "fridge-magnet-menu-title";
      heading.textContent = `${magnetName(magnet)}: move it, or take it down`;
      menu.append(heading, places, remove, close);
      this.door.after(menu);
      places.querySelector('[data-region="middle"]')?.focus();
      void anchor;
      return;
    }
    const label = document.createElement("label");
    label.textContent = "Move to ";
    const select = document.createElement("select");
    const keep = document.createElement("option");
    keep.value = "";
    keep.textContent = "Choose a place";
    select.append(keep);
    for (const region of MAGNET_REGIONS) {
      const option = document.createElement("option");
      option.value = region.id;
      option.textContent = region.label;
      select.append(option);
    }
    // Choosing a place doesn't move the magnet by itself (arrow keys on a
    // closed select fire "change"); the Move button does (WCAG 3.2.2).
    const move = document.createElement("button");
    move.type = "button";
    move.className = "fridge-magnet-move";
    move.textContent = "Move";
    move.addEventListener("click", () => {
      if (!select.value) { select.focus(); return; }
      moveTo(regionPoint(select.value));
    });
    label.append(select);
    menu.append(label, move, remove, close);
    this.door.after(menu);
    select.focus();
    void anchor;
  }

  closeMagnetMenu({ focus = true } = {}) {
    const open = this.magnetMenu;
    this.magnetMenu = null;
    if (!open) return;
    open.menu.remove();
    if (focus) this.focusMagnet(open.magnetId);
  }

  focusMagnet(magnetId) {
    this.magnetLayer?.querySelector(`[data-magnet-id="${magnetId}"]`)?.focus();
  }

  async removeMagnet(magnet) {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    try {
      await this.changeIn(room, { type: "hide-magnet", magnetId: magnet.id, hidden: true });
      this.remember(room, { kind: "remove", id: magnet.id });
      this.showStatus("Magnet taken down. Undo puts it back.");
      this.undoButton.focus();
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
  }

  buildMagnetDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "fridge-dialog fridge-magnet-dialog";
    dialog.setAttribute("aria-labelledby", "fridge-magnet-title");
    const form = document.createElement("form");
    form.method = "dialog";
    const title = document.createElement("h3");
    title.id = "fridge-magnet-title";
    title.textContent = "Add a magnet";
    const kinds = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Kind";
    kinds.append(legend);
    this.magnetKind = "emoji";
    const panels = {};
    for (const [value, text] of [["emoji", "Emoji"], ["kin", "Kin magnet"], ["note", "Note"]]) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "fridge-magnet-kind";
      radio.value = value;
      radio.checked = value === "emoji";
      radio.addEventListener("change", () => {
        this.magnetKind = value;
        for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== value;
      });
      label.append(radio, ` ${text}`);
      kinds.append(label);
    }
    // Emoji: type one or use the picker.
    panels.emoji = document.createElement("div");
    const emojiLabel = document.createElement("label");
    emojiLabel.textContent = "Emoji ";
    this.emojiInput = document.createElement("input");
    this.emojiInput.type = "text";
    this.emojiInput.className = "fridge-emoji-input";
    this.emojiInput.autocomplete = "off";
    this.emojiInput.maxLength = 32;
    // A magnet is one emoji: typing or picking another replaces it.
    this.emojiInput.addEventListener("input", () => {
      const value = this.emojiInput.value;
      if (typeof Intl?.Segmenter !== "function" || !value) return;
      const last = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.trim())].at(-1)?.segment ?? "";
      if (last !== value) this.emojiInput.value = last;
    });
    emojiLabel.append(this.emojiInput);
    const picker = document.createElement("kin-emoji-picker");
    picker.target = this.emojiInput;
    panels.emoji.append(emojiLabel, picker);
    // Kin-drawn magnets: one choice of twelve.
    panels.kin = document.createElement("fieldset");
    panels.kin.className = "fridge-kin-magnets";
    const kinLegend = document.createElement("legend");
    kinLegend.textContent = "Kin magnet";
    panels.kin.append(kinLegend);
    this.kinChoice = 1;
    for (const drawn of KIN_MAGNETS) {
      const label = document.createElement("label");
      label.className = "fridge-kin-choice";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "fridge-kin-magnet";
      radio.value = String(drawn.number);
      radio.checked = drawn.number === 1;
      radio.setAttribute("aria-label", drawn.name);
      radio.addEventListener("change", () => { this.kinChoice = drawn.number; });
      label.append(radio, this.kinMagnetIcon(drawn.number));
      label.title = drawn.name;
      panels.kin.append(label);
    }
    panels.kin.hidden = true;
    // A short note, for people who'd rather write than draw.
    panels.note = document.createElement("div");
    const noteLabel = document.createElement("label");
    noteLabel.textContent = "Note ";
    this.noteInput = document.createElement("input");
    this.noteInput.type = "text";
    this.noteInput.maxLength = 60;
    this.noteInput.placeholder = "Milk please";
    noteLabel.append(this.noteInput);
    panels.note.append(noteLabel);
    panels.note.hidden = true;
    const whereLabel = document.createElement("label");
    whereLabel.textContent = "Put it ";
    this.whereSelect = document.createElement("select");
    for (const region of MAGNET_REGIONS) {
      const option = document.createElement("option");
      option.value = region.id;
      option.textContent = region.label.toLowerCase().replace(/^middle$/, "in the middle").replace(/^(top|bottom|left|right)/, (word) => `at the ${word}`);
      option.selected = region.id === "middle";
      this.whereSelect.append(option);
    }
    whereLabel.append(this.whereSelect);
    this.magnetError = document.createElement("p");
    this.magnetError.className = "error-message";
    this.magnetError.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "fridge-dialog-actions";
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "primary-action";
    add.textContent = "Put it up";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close());
    actions.append(add, cancel);
    form.append(title, kinds, panels.emoji, panels.kin, panels.note, whereLabel, this.magnetError, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.placeMagnet();
    });
    // Focus goes to the magnet just put up, or back to "Add magnet".
    dialog.addEventListener("close", () => {
      const placed = this.focusAfterDialog;
      this.focusAfterDialog = null;
      if (placed) this.focusMagnet(placed);
      else this.magnetButton?.focus();
    });
    dialog.append(form);
    this.magnetDialog = dialog;
    return dialog;
  }

  openMagnetDialog() {
    if (!this.room) return;
    this.magnetError.textContent = "";
    this.emojiInput.value = "";
    this.noteInput.value = "";
    this.magnetDialog.showModal?.();
    (this.magnetKind === "note" ? this.noteInput : this.magnetKind === "emoji" ? this.emojiInput : this.magnetDialog.querySelector('input[name="fridge-kin-magnet"]:checked'))?.focus();
  }

  async placeMagnet() {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    let content;
    if (this.magnetKind === "emoji") {
      const emoji = this.emojiInput.value.trim();
      if (!emoji) { this.magnetError.textContent = "Choose or type an emoji."; return; }
      content = { kind: "emoji", emoji };
    } else if (this.magnetKind === "kin") {
      content = { kind: "kin", number: this.kinChoice };
    } else {
      const text = normalizeNote(this.noteInput.value);
      if (!text) { this.magnetError.textContent = "Write a short note of up to 60 characters on one line."; return; }
      content = { kind: "note", text };
    }
    const [x, y] = regionPoint(this.whereSelect.value);
    const magnetId = newBoardId();
    try {
      await this.changeIn(room, { type: "place-magnet", magnetId, x, y, content });
    } catch (error) {
      this.magnetError.textContent = error?.code === 2 && content.kind === "emoji"
        ? "That isn't a single emoji. Choose one from the picker."
        : changeProblem(error, this.state);
      return;
    }
    this.remember(room, { kind: "place", id: magnetId });
    this.focusAfterDialog = magnetId;
    this.magnetDialog.close();
    this.showStatus("Magnet put up.");
  }

  // ---- Clearing (#323) ----------------------------------------------------

  buildClearDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "fridge-dialog fridge-clear-dialog";
    dialog.setAttribute("aria-labelledby", "fridge-clear-title");
    const title = document.createElement("h3");
    title.id = "fridge-clear-title";
    title.textContent = "Clear the fridge?";
    const text = document.createElement("p");
    text.textContent = "Everything on it comes down for the whole household. Anyone can bring it back afterwards.";
    const actions = document.createElement("div");
    actions.className = "fridge-dialog-actions";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "danger-action";
    clear.textContent = "Clear fridge";
    clear.addEventListener("click", () => void this.clearFridge());
    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep it";
    keep.addEventListener("click", () => dialog.close());
    actions.append(clear, keep);
    dialog.append(title, text, actions);
    dialog.addEventListener("close", () => (this.clearButton?.disabled ? this.undoButton : this.clearButton)?.focus());
    this.clearDialog = dialog;
    return dialog;
  }

  openClearDialog() {
    if (!this.room) return;
    this.clearDialog.showModal?.();
    this.clearDialog.querySelector("button:last-child")?.focus();
  }

  async clearFridge() {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    const clearId = newBoardId();
    try {
      await this.changeIn(room, { type: "clear-board", clearId });
      this.remember(room, { kind: "clear", id: clearId });
      this.showStatus("Fridge cleared. Undo brings it all back.");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    this.clearDialog.close();
  }

  /** Anyone can bring back the most recent clear, theirs or someone else's. */
  async undoClear() {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    const clearId = this.state?.openClear;
    if (!clearId) return;
    try {
      if (this.room.board().openClear !== clearId) { this.showStatus("Someone changed the fridge meanwhile. Nothing was brought back."); return; }
      await this.changeIn(room, { type: "undo-clear", clearId });
      this.showStatus("The fridge is back as it was.");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
  }

  // ---- Undo and redo (this device's own changes in this visit) -------------

  /** One board change, only while `room` is still this fridge's room. */
  changeIn(room, command) {
    if (!room || room !== this.room) {
      const error = new Error("Unlock Kin to draw on the fridge.");
      error.code = "board_locked";
      return Promise.reject(error);
    }
    return room.change(command);
  }

  remember(room, entry) {
    // An operation from a room that has since gone (lock, or another
    // household) mustn't land in the new room's undo history.
    if (room !== this.room) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateTools();
  }

  /** Applies an entry backwards (undo) or forwards (redo). Something
   * someone else changed meanwhile is left as it is. */
  async apply(entry, backwards) {
    // The room this operation started on: a lock or a new room meanwhile
    // stops it rather than writing into the next one (#327).
    const room = this.room;
    const board = this.room.board();
    if (entry.kind === "draw" || entry.kind === "erase") {
      const hidden = entry.kind === "draw" ? backwards : !backwards;
      const visible = new Set((board.strokes ?? []).map((stroke) => stroke.id));
      let changed = false;
      for (const strokeId of entry.ids) {
        if (visible.has(strokeId) !== hidden) continue;
        await this.changeIn(room, { type: "hide-stroke", strokeId, hidden });
        changed = true;
      }
      return changed;
    }
    if (entry.kind === "place" || entry.kind === "remove") {
      const hidden = entry.kind === "place" ? backwards : !backwards;
      const shown = (board.magnets ?? []).some((magnet) => magnet.id === entry.id);
      if (shown !== hidden) return false;
      await this.changeIn(room, { type: "hide-magnet", magnetId: entry.id, hidden });
      return true;
    }
    if (entry.kind === "move") {
      const magnet = (board.magnets ?? []).find((candidate) => candidate.id === entry.id);
      const [x, y] = backwards ? entry.from : entry.to;
      if (!magnet || (magnet.x === x && magnet.y === y)) return false;
      await this.changeIn(room, { type: "move-magnet", magnetId: entry.id, x, y });
      return true;
    }
    if (entry.kind === "clear") {
      if (backwards) {
        if (board.openClear !== entry.id) return false;
        await this.changeIn(room, { type: "undo-clear", clearId: entry.id });
        return true;
      }
      entry.id = newBoardId();
      await this.changeIn(room, { type: "clear-board", clearId: entry.id });
      return true;
    }
    return false;
  }

  async undo() {
    const entry = this.undoStack.pop();
    if (!entry || !this.room) return;
    try {
      const room = this.room;
      const changed = await this.apply(entry, true);
      if (room !== this.room) return;
      this.redoStack.push(entry);
      this.showStatus(changed ? UNDONE[entry.kind] ?? "Undone." : "Someone changed that meanwhile, so there was nothing to undo.");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    this.updateTools();
  }

  async redo() {
    const entry = this.redoStack.pop();
    if (!entry || !this.room) return;
    try {
      const room = this.room;
      const changed = await this.apply(entry, false);
      if (room !== this.room) return;
      this.undoStack.push(entry);
      this.showStatus(changed ? REDONE[entry.kind] ?? "Redone." : "Someone changed that meanwhile, so there was nothing to redo.");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    this.updateTools();
  }
}

customElements.define("kin-fridge", KinFridge);
