// Capture's Assistant helpers (ADRs 0302 and 0304): turn the voice note into words and, after the author has
// seen what is sent, into a draft. Every call here goes through this site's own Admin, which owns the provider
// boundary; nothing is sent before the author confirms, nothing is saved or published by this module, and the
// text that comes back is untrusted, so it is made plain before it reaches the notes. The first half is plain
// functions (tests/web/admin-capture-assistant.test.mjs); the second builds the controls.

import { el } from "./block-forms.js";

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * A transcript made safe to sit in the notes, which become the post's Markdown. `<` becomes an entity, so no tag
 * can form; a line that starts a heading, quote, list, rule or fence is escaped, and a bracket cannot open a
 * link or image. It still reads as the words that were spoken.
 */
export function plainNotes(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&(?=#?\w+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\[/g, "\\[")
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>`~|]|[-+*](?=\s)|\d+[.)](?=\s)|={3,}|-{3,}|\*{3,}|_{3,})/, "$1\\$2"))
    .join("\n")
    .trim();
}

/** The notes after a transcript is added under what the author already typed, cut to the bound. */
export function appendTranscript(notes, transcript, maxChars) {
  const typed = String(notes ?? "").replace(/\s+$/, "");
  const added = plainNotes(transcript);
  const joined = typed ? `${typed}\n\n${added}` : added;
  if (joined.length <= maxChars) return { notes: joined, clipped: false };
  return { notes: joined.slice(0, maxChars).replace(/\s+$/, ""), clipped: true };
}

/** What the server says it would send, as lines for the author to read before confirming. */
export function disclosureLines(disclosure, audioBytes) {
  const lines = [];
  const where = disclosure.engine === "local" ? "this server's own transcription engine" : `${disclosure.destination}${disclosure.model ? ` (${disclosure.model})` : ""}`;
  lines.push(`Sent to: ${where}.`);
  const sends = Array.isArray(disclosure.sends) ? disclosure.sends : [];
  for (const line of sends) lines.push(`Sent: ${String(line).replace(/\(\d+ KB, (\w+)\)/, audioBytes ? `(${sizeText(audioBytes)}, $1)` : "($1)")}`);
  lines.push(disclosure.leavesServer ? "The recording leaves your server." : "The recording stays on your server.");
  if (disclosure.keeps) lines.push(String(disclosure.keeps));
  return lines;
}

/** Whether transcription is possible, read from the server. Anything unexpected counts as not available. */
export async function loadTranscribeAvailability(api) {
  try {
    const disclosure = await api.call("GET", "assistant/transcribe");
    return disclosure?.available ? { available: true, disclosure } : { available: false, reason: String(disclosure?.reason || "") };
  } catch {
    return { available: false, reason: "" };
  }
}

/** Keep the note on the server (the same id keeps the first copy), then transcribe it. Returns `{ transcript, truncated }`. */
export async function transcribeNote({ api, captureId, blob }) {
  await api.call("POST", `capture-audio?capture=${captureId}`, { body: blob, headers: { "Content-Type": "application/octet-stream" } });
  return api.call("POST", "assistant/transcribe", { json: { captureId, confirmed: true } });
}

/**
 * The transcription control under the voice note. `notes` is the Notes textarea; `limits.maxNotesChars` bounds it.
 * `update(note)` is told whether a voice note exists (`{ captureId, blob, size }`) or not (`null`).
 */
export function createTranscribeBox({ api, notes, limits, announce = () => {} }) {
  const root = el("div", { class: "oba-capture-ai", hidden: true, "data-capture-transcribe": "true" });
  let note = null;
  let availability = null;
  let step = "idle";
  let undo = null;
  let token = 0;

  const unavailableText = () => availability?.reason || "Transcription is not set up for this site. Type your notes instead.";

  const button = (label, attrs, onClick) => el("button", { type: "button", class: "oba-btn", ...attrs, onClick }, label);

  const render = () => {
    root.hidden = !note;
    if (!note) {
      root.replaceChildren();
      return;
    }
    if (!availability) {
      root.replaceChildren(el("p", { class: "oba-help" }, "Checking whether transcription is set up…"));
      return;
    }
    if (!availability.available) {
      root.replaceChildren(el("p", { class: "oba-help", "data-capture-transcribe-off": "true" }, unavailableText()));
      return;
    }
    if (step === "confirm") {
      const heading = el("h4", { class: "oba-capture-ai-title", tabindex: "-1" }, "Before anything is sent");
      root.replaceChildren(
        heading,
        el("ul", { class: "oba-capture-ai-sends", "data-capture-disclosure": "true" }, disclosureLines(availability.disclosure, note.size).map((line) => el("li", {}, line))),
        el("div", { class: "oba-capture-voice-actions" },
          button("Send the recording", { class: "oba-btn oba-btn-primary", "data-capture-transcribe-send": "true" }, run),
          button("Cancel", { "data-capture-transcribe-cancel": "true" }, () => {
            step = "idle";
            render();
            root.querySelector("[data-capture-transcribe-start]")?.focus();
          }),
        ),
      );
      heading.focus();
      return;
    }
    const parts = [
      button(step === "working" ? "Transcribing…" : "Transcribe with AI", { "data-capture-transcribe-start": "true", disabled: step === "working", "aria-busy": step === "working" ? "true" : null }, () => {
        step = "confirm";
        render();
      }),
      el("p", { class: "oba-help" }, "Optional. You see what is sent, and where, before anything leaves. You can always type your notes instead."),
    ];
    if (undo) parts.push(button("Undo the transcript", { "data-capture-transcribe-undo": "true" }, () => {
      notes.value = undo.before;
      undo = null;
      announce("Transcript removed. Your notes are as they were.");
      render();
      notes.focus();
    }));
    root.replaceChildren(...parts);
  };

  async function run() {
    const mine = ++token;
    const sending = note;
    step = "working";
    render();
    announce("Transcribing…");
    try {
      const { transcript, truncated } = await transcribeNote({ api, captureId: sending.captureId, blob: sending.blob });
      if (mine !== token) return;
      const before = notes.value;
      const next = appendTranscript(before, transcript, limits.maxNotesChars);
      notes.value = next.notes;
      notes.dispatchEvent?.(new Event("input", { bubbles: true }));
      undo = { before };
      announce(`Transcript added to your notes. It was written by a machine: read it and fix what it got wrong.${next.clipped || truncated ? " It was long, so the end was left out." : ""}`);
    } catch (error) {
      if (mine !== token) return;
      announce(error?.message || "Could not transcribe. Type your notes instead.");
    }
    step = "idle";
    render();
    (root.querySelector("[data-capture-transcribe-undo]") || root.querySelector("[data-capture-transcribe-start]"))?.focus();
  }

  return {
    element: root,
    /** Tell the box about the voice note (or its absence). A different note starts clean. */
    async update(next) {
      const changed = (next?.captureId || null) !== (note?.captureId || null) || next?.blob !== note?.blob;
      note = next;
      if (changed) {
        token += 1;
        step = "idle";
        undo = null;
      }
      render();
      if (note && !availability) {
        availability = await loadTranscribeAvailability(api);
        render();
      }
    },
  };
}

// ----- drafting (ADR 0304) ---------------------------------------------------------------------------------

/** The bounds of a draft, the same as the core's `job_draft` module enforces on the server. */
export const DRAFT_LIMITS = Object.freeze({ title: 120, description: 300, section: 1500 });
export const SECTION_KEYS = Object.freeze(["problem", "found", "did", "result"]);
export const SECTION_LABELS = Object.freeze({ problem: "Problem", found: "What we found", did: "What we did", result: "Result" });

const oneLine = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const block = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

/**
 * A draft read defensively: from the server, from a stored record or from the editable fields. Text is
 * clipped to its bound, never trusted to be shorter. A draft with no title and no words is nothing (`null`).
 */
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = oneLine(raw.title, DRAFT_LIMITS.title);
  const description = oneLine(raw.description, DRAFT_LIMITS.description);
  const sections = {};
  for (const key of SECTION_KEYS) sections[key] = block(raw.sections?.[key], DRAFT_LIMITS.section);
  if (!title && SECTION_KEYS.every((key) => !sections[key])) return null;
  return { title, description, sections };
}

/** The body a draft makes: its sections under the scaffold's own headings (or the standard four). */
export function draftBody({ scaffold = "", sections }) {
  const found = String(scaffold).match(/^## .*$/gm) || [];
  const headings = SECTION_KEYS.map((key, index) => found[index] || `## ${SECTION_LABELS[key]}`);
  return headings.map((heading, index) => `${heading}\n\n${sections[SECTION_KEYS[index]] ? `${sections[SECTION_KEYS[index]]}\n\n` : ""}`).join("");
}

/** What a drafting request would send, as lines for the author to read before confirming. */
export function draftDisclosureLines({ status, notes, photoAlts = [], fields = {}, guide = null }) {
  const lines = [];
  const where = status?.destination ? `${status.destination}${status.model ? ` (${status.model})` : ""}` : "your Assistant provider";
  lines.push(`Sent to: ${where}.`);
  const count = String(notes ?? "").trim().length;
  lines.push(`Sent: your notes (${count} character${count === 1 ? "" : "s"}), including any transcript you added.`);
  const job = [fields.trade, fields.service, fields.town].map((value) => String(value ?? "").trim()).filter(Boolean);
  lines.push(job.length ? `Sent: the job words ${job.join(", ")}.` : "Sent: no trade, service or town.");
  lines.push(photoAlts.length ? `Sent: ${photoAlts.length} photo description${photoAlts.length === 1 ? "" : "s"}.` : "Photos are not sent, and no photo description is added.");
  lines.push(guide ? `Sent: your ${guide.visibility} voice guide, so the draft sounds like you.` : "Your voice guide is not sent.");
  lines.push("Your voice note's audio is never sent with a draft.");
  lines.push("Nothing is saved or published. The draft appears here for you to edit.");
  return lines;
}

/** Whether drafting is possible and which voice guide could be sent, read from the server. */
export async function loadDraftSetup(api) {
  let status = null;
  try {
    status = await api.call("GET", "assistant/status");
  } catch {
    return { ready: false, status: null, guide: null, reason: "" };
  }
  if (!status?.configured) return { ready: false, status, guide: null, reason: String(status?.message || "") };
  let guide = null;
  try {
    const catalog = await api.call("GET", "assistant/context");
    const usable = (catalog?.voiceGuides || []).filter((doc) => doc?.contextType === "voice" && doc.exists === true && doc.valid === true && typeof doc.id === "string");
    const picked = usable.find((doc) => doc.visibility === "private") || usable[0];
    if (picked) guide = { id: picked.id, visibility: picked.visibility === "portable" ? "portable" : "private" };
  } catch {
    // Drafting works without a guide; it just does not sound like the author yet.
  }
  return { ready: true, status, guide, reason: "" };
}

/** Ask for a draft. Resolves to a normalized draft; anything unusable is an error and nothing is applied. */
export async function requestDraft({ api, notes, fields = {}, photoAlts = [], contextIds = [] }) {
  const reply = await api.call("POST", "assistant/job-draft", {
    json: { notes, photoAlts, trade: fields.trade || "", service: fields.service || "", town: fields.town || "", contextIds },
  });
  const draft = normalizeDraft(reply?.draft);
  if (!draft) throw new Error("The Assistant did not return a usable draft. Your notes are unchanged.");
  return draft;
}

/**
 * The drafting control. `notes` is the Notes textarea; `getFields()` and `getPhotoAlts()` read what the capture
 * holds now. Nothing is sent before the author confirms; the draft is shown in editable fields and is not part
 * of any save until the author saves the capture; `Undo the draft` puts everything back as it was.
 */
export function createDraftBox({ api, notes, getFields = () => ({}), getPhotoAlts = () => [], announce = () => {}, onChange = () => {} }) {
  const root = el("div", { class: "oba-capture-ai oba-capture-draft", "data-capture-draft": "true" });
  const form = el("div", { class: "oba-capture-draft-form", "data-capture-draft-form": "true" });
  let setup = null;
  let step = "idle";
  let useGuide = true;
  let applied = false;
  let undo = null;
  let token = 0;
  let loading = null;
  const controls = {};
  const prefix = `oba-draft-${++draftUid}`;

  const field = (key, label, control, help) => el("div", { class: "oba-field" }, el("label", { for: `${prefix}-${key}` }, label), control, help ? el("p", { class: "oba-help" }, help) : null);
  const make = (key, label, tag, props, help) => {
    const control = el(tag, { id: `${prefix}-${key}`, "data-capture-draft-field": key, ...props });
    control.addEventListener("input", onChange);
    controls[key] = control;
    return field(key, label, control, help);
  };
  const buildForm = () => {
    form.replaceChildren(
      make("title", "Title", "input", { type: "text", maxlength: String(DRAFT_LIMITS.title), autocomplete: "off" }),
      make("description", "Description", "textarea", { rows: 2, maxlength: String(DRAFT_LIMITS.description) }, "One sentence for search results and link previews."),
      ...SECTION_KEYS.map((key) => make(key, SECTION_LABELS[key], "textarea", { rows: 4, maxlength: String(DRAFT_LIMITS.section) })),
    );
  };
  buildForm();

  const read = () => normalizeDraft({ title: controls.title.value, description: controls.description.value, sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, controls[key].value])) });
  const write = (draft) => {
    controls.title.value = draft?.title || "";
    controls.description.value = draft?.description || "";
    for (const key of SECTION_KEYS) controls[key].value = draft?.sections?.[key] || "";
  };

  const hasNotes = () => String(notes.value || "").trim().length > 0;
  const button = (label, attrs, onClick) => el("button", { type: "button", class: "oba-btn", ...attrs, onClick }, label);

  const ensureSetup = () => {
    loading ||= loadDraftSetup(api).then((result) => {
      setup = result;
      render();
    });
    return loading;
  };

  let hadNotes = false;
  function render() {
    hadNotes = hasNotes();
    const parts = [];
    if (!setup) {
      parts.push(el("p", { class: "oba-help" }, hasNotes() ? "Checking whether drafting is set up…" : "Add a few words, or a transcript of a voice note, to draft from."));
    } else if (!setup.ready) {
      parts.push(el("p", { class: "oba-help", "data-capture-draft-off": "true" }, `Drafting with AI is not set up on this site${setup.reason ? `: ${setup.reason}` : "."} Your notes are saved as they are.`));
    } else if (step === "confirm") {
      const heading = el("h4", { class: "oba-capture-ai-title", tabindex: "-1" }, "Before anything is sent");
      const lines = draftDisclosureLines({ status: setup.status, notes: notes.value, photoAlts: getPhotoAlts(), fields: getFields(), guide: useGuide ? setup.guide : null });
      const children = [heading, el("ul", { class: "oba-capture-ai-sends", "data-capture-draft-disclosure": "true" }, lines.map((line) => el("li", {}, line)))];
      if (setup.guide) {
        const box = el("input", { type: "checkbox", id: `${prefix}-guide`, checked: useGuide, "data-capture-draft-guide": "true" });
        box.addEventListener("change", () => {
          useGuide = box.checked;
          render();
          root.querySelector("[data-capture-draft-guide]")?.focus();
        });
        children.push(el("div", { class: "oba-field oba-capture-check" }, box, el("label", { for: `${prefix}-guide` }, `Write it in my voice (send my ${setup.guide.visibility} voice guide)`)));
      }
      children.push(el("div", { class: "oba-capture-voice-actions" },
        button("Send to the Assistant", { class: "oba-btn oba-btn-primary", "data-capture-draft-send": "true" }, run),
        button("Cancel", { "data-capture-draft-cancel": "true" }, () => {
          step = "idle";
          render();
          root.querySelector("[data-capture-draft-start]")?.focus();
        }),
      ));
      parts.push(...children);
      root.replaceChildren(el("h3", { class: "oba-capture-ai-heading" }, "Draft with AI"), ...parts);
      heading.focus();
      return;
    } else {
      const busy = step === "working";
      parts.push(button(busy ? "Drafting…" : applied ? "Draft again with AI" : "Draft with AI", { "data-capture-draft-start": "true", disabled: busy || !hasNotes(), "aria-busy": busy ? "true" : null }, () => {
        step = "confirm";
        render();
      }));
      parts.push(el("p", { class: "oba-help" }, hasNotes() ? "Optional. You see what is sent, and where, before anything leaves. Nothing is saved or published." : "Add a few words, or a transcript of a voice note, to draft from."));
    }
    if (applied) {
      parts.push(
        el("p", { class: "oba-help", "data-capture-draft-note": "true" }, "This draft is not saved yet. Change anything you like. It replaces your notes in the saved post; your notes stay in the box above until you save."),
        form,
        button("Undo the draft", { "data-capture-draft-undo": "true" }, () => {
          write(undo?.previous || null);
          applied = Boolean(undo?.previous);
          undo = null;
          announce("The draft was taken back. Your notes are as they were.");
          render();
          onChange();
          root.querySelector("[data-capture-draft-start]")?.focus();
        }),
      );
    }
    root.replaceChildren(el("h3", { class: "oba-capture-ai-heading" }, "Draft with AI"), ...parts);
  }

  async function run() {
    const mine = ++token;
    step = "working";
    render();
    announce("Drafting…");
    try {
      const contextIds = useGuide && setup.guide ? [setup.guide.id] : [];
      const draft = await requestDraft({ api, notes: String(notes.value).trim(), fields: getFields(), photoAlts: getPhotoAlts(), contextIds });
      if (mine !== token) return;
      undo = { previous: applied ? read() : null };
      write(draft);
      applied = true;
      announce("A draft is ready below. It is not saved: read it, change what you like, then save.");
    } catch (error) {
      if (mine !== token) return;
      announce(error?.message || "Could not draft. Your notes are unchanged.");
    }
    step = "idle";
    render();
    onChange();
    (root.querySelector("[data-capture-draft-field='title']") || root.querySelector("[data-capture-draft-start]"))?.focus();
  }

  notes.addEventListener("input", () => {
    const now = hasNotes();
    if (!setup && now) ensureSetup();
    if (now !== hadNotes && step === "idle") render();
  });
  render();

  return {
    element: root,
    /** The draft as edited now, or `null` when none is applied. */
    getDraft: () => (applied ? read() : null),
    isDirty: () => applied,
    /** Called when the author first has something to draft from, to read the setup once. */
    prepare: () => (hasNotes() ? ensureSetup() : Promise.resolve()),
    /** Start clean for the next capture. */
    reset() {
      token += 1;
      step = "idle";
      applied = false;
      undo = null;
      write(null);
      render();
    },
  };
}

let draftUid = 0;