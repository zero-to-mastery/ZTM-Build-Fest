// The logic behind Admin's Voice view (ADR 0271 to 0273): the countdown, what the page announces
// and when, the copy of a draft kept on this device, how that copy and the server's are reconciled,
// the library's grouping, and the invitation's rule. Nothing here touches the document, so every
// rule is a plain function a test can call at an exact second.
//
// The clock on the page is a display. The server owns the deadline: it refuses a draft from the
// deadline on and accepts a final text only within a short grace. This file never extends a session.

export const VOICE_LIMITS = Object.freeze({
  defaultSeconds: 180,
  warningSeconds: 30,
  graceSeconds: 10,
  /** The most text a draft can hold; the server refuses more. */
  maxDraftBytes: 60 * 1024,
  /** How long typing pauses before the draft is sent to the server. */
  autosaveMs: 1500,
  /** How long typing pauses before the copy on this device is refreshed. */
  localSaveMs: 300,
  /** No timer announcement comes sooner than this after the last one. */
  announceGapMs: 25000,
});

/** The words that explain why a rough draft cannot be edited (ADR 0266). */
export const ROUGH_NOTE =
  "A rough draft stays exactly as you wrote it, typos and all, so it keeps showing how you really write. To fix or reshape it, polish a copy: that is yours to edit.";

export const PRIVATE_NOTE = "Private: kept only in this project's private folder, never committed, published or exported.";
export const PORTABLE_NOTE = "Portable: kept with your project's Assistant files, so it can be committed and shared with the project.";

const encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();
export function byteLength(text) {
  const value = String(text ?? "");
  return encoder ? encoder.encode(value).length : unescape(encodeURIComponent(value)).length;
}

/** Whitespace-separated words, as the server counts them. */
export function wordCount(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export const wordsText = (count) => `${count} ${count === 1 ? "word" : "words"}`;

/** `3:00`, `0:30`, `0:00`. */
export function formatClock(seconds) {
  const whole = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The time left in words, for a screen reader: "1 minute", "30 seconds", "1 minute 5 seconds". */
export function spokenTime(seconds) {
  const whole = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts = [];
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (rest || !minutes) parts.push(`${rest} ${rest === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/** `running`, `warning` (the last 30 seconds) or `locked`. */
export function timerState(remaining, locked = false) {
  if (locked || remaining <= 0) return "locked";
  return remaining <= VOICE_LIMITS.warningSeconds ? "warning" : "running";
}

/**
 * What the timer says in text and a shape, never in color alone: the symbol is a different shape for each
 * state, and the words say what it means.
 */
export function timerLabel(remaining, locked = false) {
  const state = timerState(remaining, locked);
  if (state === "locked") return { state, symbol: "■", text: "Time is up" };
  if (state === "warning") return { state, symbol: "▲", text: `${spokenTime(remaining)} left` };
  return { state, symbol: "●", text: "Writing" };
}

/**
 * A countdown driven by the server's remaining time. `now` is a monotonic clock in milliseconds. Each answer
 * from the server restates the time left, and the countdown only ever moves the end sooner: an answer that
 * arrives late can not give the author more time than they had.
 */
export function createCountdown(now = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {
  let end = null;
  return {
    sync(remainingSeconds) {
      const next = now() + Math.max(0, Number(remainingSeconds) || 0) * 1000;
      end = end === null ? next : Math.min(end, next);
    },
    reset() {
      end = null;
    },
    get started() {
      return end !== null;
    },
    remaining() {
      return end === null ? 0 : Math.max(0, Math.ceil((end - now()) / 1000));
    },
    expired() {
      return end !== null && now() >= end;
    },
  };
}

/**
 * What the polite live region says, and when. Thresholds are one minute and thirty seconds; each is said once
 * as the clock passes it, no timer announcement comes within 25 seconds of the last (the two marks are 30 seconds apart, and
 * a save that restates the clock can bring them a little closer, so both are always said), and the lock is said once
 * when it happens (it is an event, not a tick). The first update of a resumed session says where it stands.
 */
export function createAnnouncer(gapMs = VOICE_LIMITS.announceGapMs) {
  const said = new Set();
  let first = true;
  let lastAt = -Infinity;
  let lockSaid = false;
  return {
    update(remaining, nowMs) {
      if (remaining <= 0) return null;
      let message = null;
      if (first) {
        first = false;
        for (const threshold of [60, 30]) if (remaining <= threshold) said.add(threshold);
        if (remaining < VOICE_LIMITS.defaultSeconds) {
          message = `Resumed. ${spokenTime(remaining)} left.`;
          lastAt = nowMs;
        }
        return message;
      }
      for (const threshold of [60, 30]) {
        if (remaining <= threshold && !said.has(threshold)) {
          said.add(threshold);
          if (nowMs - lastAt >= gapMs) {
            message = `${spokenTime(threshold)} left.`;
            lastAt = nowMs;
          }
        }
      }
      return message;
    },
    lock(expired = true) {
      if (lockSaid) return null;
      lockSaid = true;
      return expired ? "Time is up. Your rough draft is locked." : "Your rough draft is locked.";
    },
  };
}

/** The sentence for a failed call. The server's sentences never contain the author's text. */
export function voiceErrorText(error) {
  const sentence = error?.data?.error;
  if (typeof sentence === "string" && sentence) return sentence;
  if (error?.status === 401) return "Your sign-in ended. Sign in again; the copy of your writing on this device is kept.";
  if (error?.status === 413) return "That is longer than a sample can hold.";
  if (error?.status >= 500) return "The server could not do that just now. Your writing is kept on this device.";
  return "The server could not be reached. Your writing is kept on this device.";
}

// ---------------------------------------------------------------- the copy kept on this device

const DRAFT_VERSION = 1;
const memory = new Map();
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A bounded copy of the draft kept on this device, one record per site and sign-in, so a reload or a lost
 * connection loses nothing. `storage` is a function so a browser that throws on access (a private window,
 * blocked site data) is handled where it is read: the copy then lives in memory until the page closes, and
 * the server's autosave is what protects the writing.
 */
export function createVoiceDraftStore(key, storage = () => globalThis.localStorage) {
  let blocked = false;
  const valid = (record) =>
    isObject(record) && record.v === DRAFT_VERSION && typeof record.sessionId === "string" && typeof record.text === "string" && typeof record.deadline === "string" && Number.isFinite(record.savedAt);
  return {
    get inMemoryOnly() {
      return blocked;
    },
    load(now = Date.now()) {
      let found = null;
      try {
        const text = storage()?.getItem(key);
        const record = text ? JSON.parse(text) : null;
        if (valid(record)) found = record;
      } catch {
        blocked = true;
      }
      found = found || memory.get(key) || null;
      if (found && stale(found, ROUGH_COPY_TTL_MS, now)) {
        this.clear();
        return null;
      }
      return found;
    },
    /** Keep `text` for the session. A draft over the limit is not kept (the server would refuse it too). */
    save({ sessionId, deadline, text }, now = Date.now()) {
      if (byteLength(text) > VOICE_LIMITS.maxDraftBytes) return false;
      const record = { v: DRAFT_VERSION, sessionId, deadline, text, savedAt: now };
      memory.set(key, record);
      try {
        storage().setItem(key, JSON.stringify(record));
        blocked = false;
      } catch {
        blocked = true;
      }
      return true;
    },
    clear() {
      memory.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        blocked = true;
      }
    },
  };
}

/**
 * Which text an open session continues with. The server's session wins for the deadline (it is not in this
 * function: the page only ever takes the time left from the server). For the text, the longer of the copy on
 * this device and the server's wins when both belong to the same session, because the one that was cut short
 * is the one that missed some typing. `push` says the server is behind and should be sent the text.
 */
export function reconcileDraft({ sessionId, serverDraft }, local) {
  const server = String(serverDraft ?? "");
  if (local && local.sessionId === sessionId && [...local.text].length > [...server].length) {
    return { text: local.text, from: "device", push: true };
  }
  return { text: server, from: "server", push: false };
}

/**
 * What to do with a session whose time ran out while the page was away. The best text is the longer of the
 * device's copy and the server's, but only a copy last kept before the deadline (plus the server's grace)
 * counts, and the server still decides: it takes a final text only within its own grace and otherwise locks
 * what it saved. Nothing here gives time back.
 */
export function expiredPlan(session, local) {
  if (!session?.open || !session.expired || !local || local.sessionId !== session.sessionId) return { useDevice: false };
  const deadline = Date.parse(session.deadline);
  const keptInTime = Number.isFinite(deadline) && local.savedAt <= deadline + VOICE_LIMITS.graceSeconds * 1000;
  const longer = [...local.text].length > Number(session.draftChars || 0);
  return { useDevice: keptInTime && longer && local.text.trim() !== "" };
}

/** Whether a kept rough copy's session is over for good (its deadline plus the server's grace is past). */
export function copyIsPastGrace(local, now = Date.now()) {
  const deadline = Date.parse(local?.deadline);
  return Number.isFinite(deadline) && now > deadline + VOICE_LIMITS.graceSeconds * 1000;
}

// ---------------------------------------------------------------- polished drafts

/** Whether the polished editor differs from the state that was saved (or pre-filled), so the guard asks. */
export function polishedDirty(current, baseline) {
  return current.title !== baseline.title || current.body !== baseline.body;
}

const POLISHED_VERSION = 1;

/** How long a copy of private text may stay on this device (a rough draft one day, a polished one 30 days). */
export const ROUGH_COPY_TTL_MS = 24 * 60 * 60 * 1000;
export const POLISHED_COPY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const stale = (record, ttl, now) => !Number.isFinite(record.savedAt) || now - record.savedAt > ttl;

/**
 * Remove voice copies on this device. Signing out removes every one. Signing in removes every
 * copy except `keepUser`'s, so a session that ended without signing out gives the same author their
 * unsaved writing back, and nobody else ever sees it. Never throws.
 */
export function clearVoiceCopies(storage = () => globalThis.localStorage, { keepUser = null } = {}) {
  const kept = (key) => keepUser !== null && (key === `ob-voice-draft:${keepUser}` || key.startsWith(`ob-voice-polished:${keepUser}:`));
  const voice = (key) => typeof key === "string" && (key.startsWith("ob-voice-draft:") || key.startsWith("ob-voice-polished:")) && !kept(key);
  try {
    const store = storage();
    if (store) {
      const keys = [];
      for (let i = 0; i < store.length; i += 1) keys.push(store.key(i));
      for (const key of keys) if (voice(key)) store.removeItem(key);
    }
  } catch {
    // Blocked storage holds nothing to clear.
  }
  for (const key of [...memory.keys()]) {
    if (voice(key)) memory.delete(key);
  }
}

/** The copy of unsaved polished edits, one record per rough draft. */
export function createPolishedDraftStore(key, storage = () => globalThis.localStorage) {
  let blocked = false;
  const valid = (record) =>
    isObject(record) && record.v === POLISHED_VERSION && (record.base === null || typeof record.base === "string") && typeof record.title === "string" && typeof record.body === "string";
  return {
    get inMemoryOnly() {
      return blocked;
    },
    load(now = Date.now()) {
      let found = null;
      try {
        const text = storage()?.getItem(key);
        const record = text ? JSON.parse(text) : null;
        if (valid(record)) found = record;
      } catch {
        blocked = true;
      }
      found = found || memory.get(key) || null;
      if (found && stale(found, POLISHED_COPY_TTL_MS, now)) {
        this.clear();
        return null;
      }
      return found;
    },
    save({ base, title, body }, now = Date.now()) {
      if (byteLength(body) > VOICE_LIMITS.maxDraftBytes) return false;
      const record = { v: POLISHED_VERSION, base: base ?? null, title, body, savedAt: now };
      memory.set(key, record);
      try {
        storage().setItem(key, JSON.stringify(record));
        blocked = false;
      } catch {
        blocked = true;
      }
      return true;
    },
    clear() {
      memory.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        blocked = true;
      }
    },
  };
}

// ---------------------------------------------------------------- the library

const newest = (a, b) => (b.date || "").localeCompare(a.date || "") || a.file.localeCompare(b.file);

/**
 * The gap list the core computes (`voice --list` prints the same), in words. Prompt and pack ids become their
 * titles where the catalog knows them. Returns an empty list when nothing is missing.
 */
export function gapLines(gaps, coverage = []) {
  if (!gaps) return [];
  const packTitle = new Map(coverage.map((pack) => [pack.id, pack.title]));
  const promptTitle = new Map(coverage.flatMap((pack) => (pack.prompts || []).map((prompt) => [prompt.id, prompt.title])));
  const lines = [];
  const packs = (gaps.unansweredPacks || []).map((id) => packTitle.get(id) || id);
  if (packs.length) lines.push({ kind: "packs", text: `Packs with no sample yet: ${packs.join(", ")}.` });
  const rough = (gaps.roughOnlyPrompts || []).map((id) => promptTitle.get(id) || id);
  if (rough.length) lines.push({ kind: "rough-only", text: `Rough only, no polished draft yet: ${rough.join(", ")}.` });
  const traits = gaps.oneSampleTraits || [];
  if (traits.length) lines.push({ kind: "one-sample", text: "Voice guide traits that rest on one sample:", items: traits.map((t) => `${t.statement} (${t.section})`) });
  return lines;
}

/** `3 of 4 prompts written, 1 polished`. */
export function coverageText(pack) {
  const written = `${pack.withRough} of ${pack.total} ${pack.total === 1 ? "prompt" : "prompts"} written`;
  return pack.withPolished ? `${written}, ${pack.withPolished} polished` : written;
}

/**
 * The library as groups. Packs come in the catalog's order, and inside a pack the prompts with samples come
 * newest first (by the newest file, then by name), so the same files always give the same page. Each rough draft
 * is a row, with its own polished draft (the one whose `roughOf` names it) and both badges, so a prompt answered
 * on several days lists every answer; a polished draft whose rough draft is missing is a row of its own. Samples
 * of a pack the catalog no longer offers
 * go in a last group, and files that cannot be read in a group of their own with guidance for repairing them.
 */
export function groupLibrary({ samples = [], coverage = [] }) {
  const valid = samples.filter((sample) => sample.valid);
  const rowsFor = (items) => {
    const titleOf = (sample) => sample.promptTitle || sample.title || sample.prompt;
    const roughs = items.filter((sample) => sample.stage === "rough");
    const roughFiles = new Set(roughs.map((sample) => sample.file));
    const polishedOf = new Map();
    const orphans = [];
    for (const sample of items.filter((s) => s.stage === "polished")) {
      if (sample.roughOf && roughFiles.has(sample.roughOf) && !polishedOf.has(sample.roughOf)) polishedOf.set(sample.roughOf, sample);
      else orphans.push(sample);
    }
    const pairs = [
      ...roughs.map((sample) => ({ prompt: sample.prompt, title: titleOf(sample), rough: sample, polished: polishedOf.get(sample.file) || null })),
      ...orphans.map((sample) => ({ prompt: sample.prompt, title: titleOf(sample), rough: null, polished: sample })),
    ];
    const rows = pairs.map((row) => {
      const files = [row.rough, row.polished].filter(Boolean);
      const latest = [...files].sort(newest)[0];
      const best = row.polished || row.rough;
      return {
        ...row,
        badges: [row.rough && "rough", row.polished && "polished"].filter(Boolean),
        words: best.words,
        visibility: best.visibility,
        date: latest.date,
        sort: latest,
      };
    });
    return rows.sort((a, b) => newest(a.sort, b.sort));
  };
  const known = new Set(coverage.map((pack) => pack.id));
  const groups = coverage.map((pack) => ({
    id: pack.id,
    title: pack.title,
    summary: pack.summary,
    coverage: coverageText(pack),
    pack,
    rows: rowsFor(valid.filter((sample) => sample.pack === pack.id)),
    unwritten: pack.prompts.filter((prompt) => !prompt.rough).length,
  }));
  const others = valid.filter((sample) => !known.has(sample.pack));
  const otherRows = rowsFor(others);
  return {
    groups,
    other: otherRows.length ? { id: "other", title: "Other prompts", summary: "Samples of prompts this site no longer offers. They stay readable.", rows: otherRows } : null,
    invalid: samples.filter((sample) => !sample.valid).sort((a, b) => a.file.localeCompare(b.file)),
    empty: samples.length === 0,
  };
}

/** The badge words and a shape for each stage; the shape is not the only signal. */
export const STAGE_BADGES = Object.freeze({
  rough: Object.freeze({ symbol: "◇", text: "Rough" }),
  polished: Object.freeze({ symbol: "◆", text: "Polished" }),
});

export const visibilityText = (visibility) => (visibility === "portable" ? "Portable" : "Private");

export const dateText = (date) => {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString(undefined, { dateStyle: "medium" });
};

export const EMPTY_LIBRARY_TEXT =
  "A voice sample is a short piece of your own writing, written against a three-minute clock so it sounds like you talking. Samples are private by default and never become posts or appear on your site. Start a session to write your first one.";

// ---------------------------------------------------------------- the invitation

/**
 * Whether the one-time invitation shows (ADR 0273): only when the author has no samples, has not dismissed it
 * and no session is open. A status the page could not read shows nothing.
 */
export function invitationVisible({ dismissed, status }) {
  if (dismissed || !status || typeof status !== "object") return false;
  if (status.session?.open) return false;
  return Number(status.samples) === 0;
}

/** The hash for the Voice view, with the pack a session should draw from if one is named. */
export const voiceHash = (pack) => (pack ? `#/voice?pack=${encodeURIComponent(pack)}` : "#/voice");
export const libraryHash = (id) => (id ? `#/voice/library/${encodeURIComponent(id)}` : "#/voice/library");
