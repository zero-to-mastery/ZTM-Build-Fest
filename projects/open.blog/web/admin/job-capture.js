// <ob-job-capture>: the Capture view (ADR 0296). A phone-first way to start a job on site: add photos,
// pick trade, service and town (remembered from last time), type a few lines, and save an unpublished job
// draft. The first half of this file is plain functions (tested in tests/web/admin-job-capture.test.mjs);
// the second builds the view. A capture only ever talks to this site's own Admin; the Assistant is used only when the author asks (capture-assistant.js).

import { el } from "./block-forms.js";
import { audioLimits, clock, createRecorder, START_PROBLEMS } from "./capture-recorder.js";
import { createDraftBox, createTranscribeBox, draftBody } from "./capture-assistant.js";
import { createCaptureQueue, openIndexedStore, queueLimits } from "./capture-queue.js";
import { localDay } from "./job-form.js";

export const PREFS_KEY = "openblog.capture.prefs.v1";
export const PREFS_VERSION = 1;
export const MAX_RECENT_TOWNS = 8;
const MAX_FIELD = 80;

export const DEFAULT_LIMITS = Object.freeze({
  maxPhotos: 12,
  maxNotesChars: 8000,
  maxPhotoBytes: 10 * 1024 * 1024,
  maxAudioSeconds: 180,
});

const text = (value) => (value === undefined || value === null ? "" : String(value).trim());
const short = (value) => text(value).slice(0, MAX_FIELD);

/** A new capture id: 128 random bits as 32 lowercase hex digits. It is the idempotency key (ADR 0297). */
export function newCaptureId(random = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The limits the server advertised, with the defaults for any it did not. */
export function captureLimits(meta = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = meta?.capture?.[key];
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

/** The remembered picks, read defensively: anything unreadable or from another version is an empty memory. */
export function readPrefs(storage) {
  const empty = { trade: "", service: "", towns: [] };
  try {
    const stored = JSON.parse(storage?.getItem(PREFS_KEY) || "null");
    if (!stored || stored.v !== PREFS_VERSION) return empty;
    const towns = [];
    for (const town of Array.isArray(stored.towns) ? stored.towns : []) {
      const name = short(town);
      if (name && !towns.some((known) => known.toLowerCase() === name.toLowerCase())) towns.push(name);
    }
    return { trade: short(stored.trade).toLowerCase(), service: short(stored.service), towns: towns.slice(0, MAX_RECENT_TOWNS) };
  } catch {
    return empty;
  }
}

/** The memory after one more saved capture: its picks first, the town moved to the front of a bounded list. */
export function rememberPicks(prefs, { trade, service, town }) {
  const name = short(town);
  const towns = name
    ? [name, ...prefs.towns.filter((known) => known.toLowerCase() !== name.toLowerCase())].slice(0, MAX_RECENT_TOWNS)
    : prefs.towns;
  return { trade: short(trade).toLowerCase() || prefs.trade, service: short(service) || prefs.service, towns };
}

export function writePrefs(storage, prefs) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, ...prefs }));
  } catch {
    // Storage is optional; the picks are simply not remembered.
  }
}

const sentence = (value) => value.charAt(0).toUpperCase() + value.slice(1);

/** A working title for a draft the author has not named yet. */
export function captureTitle({ trade, town }, now = new Date()) {
  const kind = text(trade) ? sentence(text(trade).replaceAll("-", " ")) : "Job";
  if (text(town)) return `${kind} in ${text(town)}`;
  return text(trade) ? `${kind} job` : `Job notes, ${localDay(now)}`;
}

/** The file name stem for a capture: the title in plain letters, then the start of the id so two captures never collide. */
export function captureSlug(title, id) {
  const stem = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${stem || "job"}-${id.slice(0, 6)}`;
}

const stamp = (now) => now.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The front matter of the draft a capture becomes. Only keys the Job form already writes (ADR 0287). */
export function captureFields(capture, now = new Date()) {
  const { trade, service, town, draft } = capture.fields;
  const title = draft?.title || captureTitle(capture.fields, now);
  const fields = {
    title,
    slug: captureSlug(title, capture.id),
    date: stamp(now),
    draft: "true",
    profile: "job",
    "job.started": localDay(now),
    "job.finished": localDay(now),
  };
  if (text(trade)) fields["job.trade"] = text(trade).toLowerCase();
  if (text(service)) fields["job.service"] = text(service);
  if (text(town)) fields["job.place.town"] = text(town);
  if (draft?.description) fields.description = draft.description;
  return fields;
}

/** The body: the job scaffold, the notes under its first heading, then the photos, each with a plain alt for the author to improve. */
export function captureBody({ scaffold = "", notes = "", photoUrls = [], draft = null }) {
  const words = draft ? "" : text(notes);
  let body = draft ? draftBody({ scaffold, sections: draft.sections }) : scaffold;
  if (words) {
    const heading = body.match(/^## .*$/m);
    body = heading ? body.replace(heading[0], `${heading[0]}\n\n${words}`) : `${words}\n\n${body}`;
  }
  if (photoUrls.length) {
    const pictures = photoUrls.map((url, index) => `![Photo ${index + 1} from the job](${url})`).join("\n\n");
    body = `${body.replace(/\s+$/, "")}\n\n${pictures}\n`;
  }
  return body;
}

/** What is wrong with a capture before it is saved, as a sentence, or an empty string. */
export function captureProblem(capture, limits = DEFAULT_LIMITS) {
  const { notes } = capture.fields;
  if (!capture.photos.length && !text(notes) && !capture.audio) return "Add a photo or a few words first.";
  if (capture.photos.length > limits.maxPhotos) return `A capture holds at most ${limits.maxPhotos} photos.`;
  if (text(notes).length > limits.maxNotesChars) return `Notes can be at most ${limits.maxNotesChars} characters.`;
  return "";
}

/** Whether a chosen file may be added, as a sentence naming the file, or an empty string. */
export function photoProblem(file, limits = DEFAULT_LIMITS) {
  if (file.type && !file.type.startsWith("image/")) return `${file.name} is not a photo.`;
  if (file.size > limits.maxPhotoBytes) return `${file.name} is larger than ${Math.floor(limits.maxPhotoBytes / (1024 * 1024))} MB.`;
  return "";
}

/** A photo the server refused for good (not an image, too large): the draft goes on without it. */
export const isPermanentPhotoError = (error) => [400, 413, 415, 422].includes(error?.status);

/**
 * Upload the photos, then create the draft. `api.call` is the Admin API. Photos the server refuses for good
 * are skipped and named; anything else stops the send and is thrown for the caller to retry or report.
 */
export async function sendCapture({ api, capture, scaffold, now = new Date() }) {
  const photoUrls = [];
  const skipped = [];
  for (const [slot, photo] of capture.photos.entries()) {
    try {
      const query = new URLSearchParams({ name: photo.name, capture: capture.id, slot: String(slot) });
      const sent = await api.call("POST", `upload?${query}`, {
        body: photo.blob,
        headers: { "Content-Type": "application/octet-stream" },
      });
      photoUrls.push(sent.url);
    } catch (error) {
      if (!isPermanentPhotoError(error)) throw error;
      skipped.push(photo.name);
    }
  }
  // The voice note is kept privately beside the draft, never in its body (ADR 0298).
  let audio = "none";
  if (capture.audio) {
    try {
      await api.call("POST", `capture-audio?capture=${capture.id}`, {
        body: capture.audio.blob,
        headers: { "Content-Type": "application/octet-stream" },
      });
      audio = "kept";
    } catch (error) {
      if (!isPermanentPhotoError(error)) throw error;
      audio = "refused";
    }
  }
  const saved = await api.call("POST", "document", {
    json: {
      kind: "posts",
      captureId: capture.id,
      fields: captureFields(capture, now),
      body: captureBody({ scaffold, notes: capture.fields.notes, photoUrls, draft: capture.fields.draft }),
    },
  });
  return { path: saved.path, skipped, audio };
}

let uid = 0;

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Returns `{ element, load, isDirty, isBusy, destroy }`. `api.call(method, path, { json, body, headers })` is
 * the Admin API; `meta` is the Admin meta (`job`, `capture`); `storage` holds the remembered picks.
 */
export function createJobCapture({ api, meta = {}, storage = globalThis.localStorage, store: store_, now = () => new Date(), recorderOptions = {} }) {
  const id = `oba-capture-${++uid}`;
  const limits = queueLimits(meta);
  const job = meta.job || {};
  const root = el("ob-job-capture", { class: "oba-capture", "data-job-capture": "true" });
  let prefs = readPrefs(storage);
  let captureId = newCaptureId();
  let photos = [];
  let busy = false;
  let queue = null;

  const status = el("p", { class: "oba-capture-status", role: "status", "aria-live": "polite", "data-capture-status": "true" });
  const saved = el("p", { class: "oba-capture-saved", role: "status", "aria-live": "polite", "data-capture-saved": "true" });
  const pendingList = el("ul", { class: "oba-capture-pending-list" });
  const pending = el("section", { class: "oba-capture-pending", "aria-labelledby": `${id}-pending`, hidden: true, "data-capture-pending-list": "true" }, el("h3", { id: `${id}-pending`, tabindex: "-1" }, "Waiting to send"), pendingList);

  const photoInput = el("input", { id: `${id}-photos`, class: "oba-capture-file", type: "file", accept: "image/*", multiple: true, "data-capture-photos": "true" });
  const photoLabel = el("label", { for: `${id}-photos`, class: "oba-btn oba-btn-primary oba-capture-add" }, "Add photos");
  const photoList = el("ul", { class: "oba-capture-photos", "aria-label": "Photos in this capture" });

  const trades = [...(job.trades || [])];
  if (prefs.trade && !trades.includes(prefs.trade)) trades.push(prefs.trade);
  const tradeSelect = el("select", { id: `${id}-trade`, "data-capture-field": "trade" }, el("option", { value: "" }, "Choose a trade"), trades.map((trade) => el("option", { value: trade }, trade)));
  tradeSelect.value = prefs.trade;

  const services = [...new Set([prefs.service, ...(job.services || [])].filter(Boolean))];
  const serviceList = el("datalist", { id: `${id}-services` }, services.map((service) => el("option", { value: service })));
  const serviceInput = el("input", { id: `${id}-service`, type: "text", list: `${id}-services`, value: prefs.service, autocomplete: "off", autocapitalize: "none", spellcheck: "false", "data-capture-field": "service" });

  const townInput = el("input", { id: `${id}-town`, type: "text", list: `${id}-towns`, autocomplete: "off", "data-capture-field": "town" });
  const townList = el("datalist", { id: `${id}-towns` });
  const townChips = el("div", { class: "oba-capture-chips", role: "group", "aria-label": "Recent towns" });

  const notes = el("textarea", { id: `${id}-notes`, rows: 6, maxlength: String(limits.maxNotesChars), "data-capture-field": "notes" });
  const field = (name, label, control, help) =>
    el("div", { class: "oba-field" }, el("label", { for: `${id}-${name}` }, label), control, help ? el("p", { class: "oba-help" }, help) : null);

  const saveButton = el("button", { type: "button", class: "oba-btn oba-btn-primary oba-capture-save", "data-capture-save": "true" }, "Save draft");

  // The voice note (ADR 0298): recorded only after a tap, at most three minutes, kept in memory until sent.
  let audio = null;
  let audioPreview = "";
  const voiceBody = el("div", { class: "oba-capture-voice-body" });
  const voice = el("fieldset", { class: "oba-fieldset oba-capture-voice", "data-capture-voice": "true" }, el("legend", { class: "oba-legend" }, "Voice note"), voiceBody);
  const transcribeBox = createTranscribeBox({ api, notes, limits, announce: (message) => { status.textContent = message; } });
  voice.append(transcribeBox.element);
  const draftBox = createDraftBox({
    api,
    notes,
    getFields: () => ({ trade: tradeSelect.value, service: serviceInput.value, town: townInput.value }),
    announce: (message) => { status.textContent = message; },
    onChange: () => {},
  });
  const dropAudio = () => {
    if (audioPreview) URL.revokeObjectURL(audioPreview);
    audioPreview = "";
    audio = null;
  };
  const stopMessage = { time: "Stopped at the three minute limit.", size: "Stopped at the size limit.", error: "The recording stopped on its own." };
  const recorder = createRecorder({
    ...recorderOptions,
    limits: audioLimits(meta),
    onChange: (state) => {
      if (state === "recorded") {
        dropAudio();
        const note = recorder.result();
        audio = { type: note.type, size: note.size, seconds: note.seconds, blob: note.blob };
        audioPreview = URL.createObjectURL(note.blob);
        status.textContent = stopMessage[note.reason] || "Voice note recorded.";
      } else if (state === "idle") dropAudio();
      renderVoice();
    },
    onTick: (seconds) => {
      const timer = voiceBody.querySelector("[data-capture-timer]");
      if (timer) timer.textContent = `Recording ${clock(seconds)} of ${clock(audioLimits(meta).maxAudioSeconds)}`;
      // Leaving the view lets go of the microphone.
      if (!root.isConnected) recorder.discard();
    },
  });
  const renderVoice = () => {
    paintVoice();
    transcribeBox.update(recorder.state === "recorded" && audio ? { captureId, blob: audio.blob, size: audio.size } : null);
  };
  const paintVoice = () => {
    const state = recorder.state;
    const maxMinutes = Math.round(audioLimits(meta).maxAudioSeconds / 60);
    if (!recorder.support.supported) {
      voiceBody.replaceChildren(el("p", { class: "oba-help" }, START_PROBLEMS.unsupported));
    } else if (state === "recording") {
      voiceBody.replaceChildren(
        el("p", { class: "oba-capture-timer", "data-capture-timer": "true" }, `Recording ${clock(0)} of ${clock(audioLimits(meta).maxAudioSeconds)}`),
        el("div", { class: "oba-capture-voice-actions" },
          el("button", { type: "button", class: "oba-btn oba-btn-primary", "data-capture-stop": "true", onClick: () => recorder.stop() }, "Stop recording"),
          el("button", { type: "button", class: "oba-btn", "data-capture-discard-voice": "true", onClick: () => { recorder.discard(); status.textContent = "Recording discarded."; } }, "Discard"),
        ),
      );
    } else if (state === "recorded" && audio) {
      const player = el("audio", { controls: true, src: audioPreview, "aria-label": "Your voice note" });
      voiceBody.replaceChildren(
        player,
        el("p", { class: "oba-help" }, `Voice note: ${clock(audio.seconds)} (${sizeText(audio.size)}). It is kept on your own server with the draft and is not published.`),
        el("button", { type: "button", class: "oba-btn", "data-capture-discard-voice": "true", onClick: () => { recorder.discard(); status.textContent = "Voice note discarded."; recordButton().focus?.(); } }, "Discard voice note"),
      );
    } else {
      voiceBody.replaceChildren(
        el("button", { type: "button", class: "oba-btn oba-capture-record", "data-capture-record": "true", disabled: state === "starting", onClick: startRecording }, state === "starting" ? "Starting…" : "Record a voice note"),
        el("p", { class: "oba-help" }, `Up to ${maxMinutes} minutes. It stays on your own server. Nothing is sent to an AI unless you choose to transcribe it.`),
      );
    }
  };
  const recordButton = () => voiceBody.querySelector("[data-capture-record]") || saveButton;
  const startRecording = async (event) => {
    const started = await recorder.start(event);
    if (!started.ok) status.textContent = START_PROBLEMS[started.reason] || START_PROBLEMS.unavailable;
    else status.textContent = "Recording.";
  };

  const renderTowns = () => {
    townList.replaceChildren(...prefs.towns.map((town) => el("option", { value: town })));
    townChips.replaceChildren(
      ...prefs.towns.slice(0, 5).map((town) =>
        el("button", { type: "button", class: "oba-btn oba-capture-chip", onClick: () => { townInput.value = town; townInput.focus(); } }, town),
      ),
    );
    townChips.hidden = prefs.towns.length === 0;
  };

  const renderPhotos = () => {
    photoList.replaceChildren(
      ...photos.map((photo, index) =>
        el(
          "li",
          { class: "oba-capture-photo" },
          el("img", { src: photo.preview, alt: "", width: "56", height: "56" }),
          el("span", { class: "oba-capture-photo-name" }, `${photo.name} (${sizeText(photo.size)})`),
          el("button", {
            type: "button",
            class: "oba-btn",
            "aria-label": `Remove photo ${index + 1}: ${photo.name}`,
            onClick: () => {
              URL.revokeObjectURL(photo.preview);
              photos.splice(index, 1);
              renderPhotos();
              photoLabel.focus();
            },
          }, "Remove"),
        ),
      ),
    );
    photoList.hidden = photos.length === 0;
  };

  photoInput.addEventListener("change", () => {
    const problems = [];
    for (const file of [...photoInput.files]) {
      const problem = photoProblem(file, limits);
      if (problem) problems.push(problem);
      else if (photos.length >= limits.maxPhotos) problems.push(`A capture holds at most ${limits.maxPhotos} photos.`);
      else photos.push({ name: file.name || "photo.jpg", type: file.type, size: file.size, blob: file, preview: URL.createObjectURL(file) });
    }
    photoInput.value = "";
    renderPhotos();
    status.textContent = problems.length ? [...new Set(problems)].join(" ") : "";
  });

  const read = () => ({
    id: captureId,
    fields: { trade: tradeSelect.value, service: serviceInput.value, town: townInput.value, notes: notes.value, draft: draftBox.getDraft() },
    photos: photos.map(({ name, type, size, blob }) => ({ name, type, size, blob })),
    audio: audio ? { ...audio } : null,
  });

  const reset = () => {
    for (const photo of photos) URL.revokeObjectURL(photo.preview);
    photos = [];
    recorder.discard();
    captureId = newCaptureId();
    notes.value = "";
    draftBox.reset();
    townInput.value = "";
    renderPhotos();
    renderTowns();
  };

  const openInWrite = (path) => el("a", { href: `#/edit/${encodeURIComponent(path).replaceAll("%2F", "/")}` }, "Open it in Write");
  const skippedText = (count, voiceNote = "none") =>
    `${count ? ` ${count} photo${count === 1 ? " was" : "s were"} not an accepted image and ${count === 1 ? "was" : "were"} left out.` : ""}${voiceNote === "kept" ? " The voice note is kept privately on your server." : voiceNote === "refused" ? " The voice note could not be kept." : ""}`;

  const finish = (capture) => {
    prefs = rememberPicks(prefs, capture.fields);
    writePrefs(storage, prefs);
    reset();
  };

  const sendRecord = (record) => sendCapture({ api, capture: record, scaffold: job.scaffold || "", now: new Date(record.createdAt) });

  const report = ({ sent, blocked }) => {
    const last = sent.at(-1);
    saved.replaceChildren();
    if (last) {
      const skipped = sent.reduce((sum, item) => sum + item.skipped.length, 0);
      const voiceNote = sent.some((item) => item.audio === "refused") ? "refused" : sent.some((item) => item.audio === "kept") ? "kept" : "none";
      saved.append(sent.length > 1 ? `${sent.length} captures were saved as drafts. The latest: ` : "Saved as a draft. ", openInWrite(last.path), skippedText(skipped, voiceNote));
    }
    if (blocked === "offline") status.textContent = "No connection yet. Your capture is kept on this device and sends when you are back online.";
    else if (blocked === "signin") status.textContent = "Sign in again to send what is waiting.";
    else if (last) status.textContent = "";
  };

  const runFlush = async () => {
    if (!queue) return;
    try {
      report(await queue.flush());
    } catch {
      status.textContent = "Could not read what is waiting on this device.";
    }
  };

  const renderPending = () => {
    const entries = queue ? queue.entries() : [];
    pending.hidden = entries.length === 0;
    pendingList.replaceChildren(
      ...entries.map((entry) => {
        const record = entry.record;
        const label = record ? `${captureTitle(record.fields, new Date(record.createdAt))}, ${record.photos.length} photo${record.photos.length === 1 ? "" : "s"}` : "Saved capture";
        const state = !record
          ? entry.state === "newer" ? "Saved by a newer version of open.blog. It is kept exactly as it is." : "This saved capture could not be read."
          : entry.sending ? "Sending…" : record.failed ? `Not sent: ${record.lastError}` : record.attempts ? "Waiting for a connection." : "Waiting to send.";
        const actions = [];
        if (record && !entry.sending) {
          actions.push(el("button", { type: "button", class: "oba-btn", "aria-label": `${record.failed ? "Try again" : "Send now"}: ${label}`, onClick: () => (record.failed ? queue.retry(entry.id).then(report) : runFlush()) }, record.failed ? "Try again" : "Send now"));
        }
        if (!entry.sending) {
          actions.push(el("button", {
            type: "button",
            class: "oba-btn",
            "aria-label": `Discard: ${label}`,
            onClick: async () => {
              if (globalThis.confirm?.("Discard this capture from this device? Its photos and notes cannot be recovered.") === false) return;
              await queue.discard(entry.id);
              pendingList.closest("section")?.querySelector("h3")?.focus();
            },
          }, "Discard"));
        }
        return el("li", { class: "oba-capture-pending-item", "data-capture-pending": entry.id }, el("span", { class: "oba-capture-pending-label" }, label), el("span", { class: "oba-capture-pending-state" }, state), el("span", { class: "oba-capture-pending-actions" }, actions));
      }),
    );
  };

  const save = async () => {
    if (busy) return;
    busy = true;
    saveButton.disabled = true;
    // A recording still running is stopped and kept, so Save never leaves it behind.
    if (recorder.state === "recording") await recorder.stop();
    const capture = read();
    const problem = captureProblem(capture, limits);
    saved.replaceChildren();
    if (problem) {
      status.textContent = problem;
      busy = false;
      saveButton.disabled = false;
      return;
    }
    status.textContent = "Saving…";
    try {
      if (queue) {
        // Keep it on the device first, so nothing is lost if the connection or the tab goes mid-send.
        const kept = await queue.add(capture, now());
        if (!kept.ok) {
          status.textContent = kept.reason;
          return;
        }
        finish(capture);
        status.textContent = "Kept on this device. Sending…";
        busy = false;
        await runFlush();
      } else {
        const result = await sendCapture({ api, capture, scaffold: job.scaffold || "", now: now() });
        finish(capture);
        status.textContent = "";
        saved.append("Saved as a draft. ", openInWrite(result.path), skippedText(result.skipped.length, result.audio));
      }
    } catch (error) {
      status.textContent = error?.message || "Could not save. Your photos and notes are still here.";
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  };
  saveButton.addEventListener("click", save);

  const onOnline = () => {
    if (!root.isConnected) {
      globalThis.removeEventListener?.("online", onOnline);
      return;
    }
    runFlush();
  };

  root.append(
    el("p", { class: "oba-capture-lead" }, "Add photos and a few lines now. Name and tidy the job later in Write; nothing is published."),
    el("div", { class: "oba-capture-photo-row" }, photoInput, photoLabel),
    photoList,
    field("trade", "Trade", tradeSelect),
    field("service", "Service", serviceInput, "A short id such as hardwood-install."),
    field("town", "Town", townInput, "A town only, never a street address."),
    townChips,
    townList,
    serviceList,
    field("notes", "Notes", notes),
    voice,
    draftBox.element,
    saveButton,
    status,
    saved,
    pending,
  );
  renderTowns();
  renderPhotos();
  renderVoice();
  const onHide = () => recorder.discard();
  globalThis.addEventListener?.("pagehide", onHide);

  return {
    element: root,
    /** Open the device's queue (when the browser has one) and send whatever is waiting. */
    async load() {
      const store = store_ !== undefined ? store_ : await openIndexedStore();
      if (!store) return;
      queue = createCaptureQueue({ store, limits, send: sendRecord, onChange: renderPending });
      try {
        await queue.refresh();
      } catch {
        queue = null;
        return;
      }
      globalThis.addEventListener?.("online", onOnline);
      await runFlush();
    },
    isDirty: () => photos.length > 0 || draftBox.isDirty() || text(notes.value) !== "" || recorder.state === "recording" || recorder.state === "recorded",
    isBusy: () => busy,
    destroy() {
      globalThis.removeEventListener?.("online", onOnline);
      globalThis.removeEventListener?.("pagehide", onHide);
      recorder.discard();
      for (const photo of photos) URL.revokeObjectURL(photo.preview);
    },
  };
}
