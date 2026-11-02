// The announcement model of optional scheduled social publishing (epic #353, ADR 0308): the hosted
// half of crates/openblog-core/src/social_schedule.rs. Both read tests/fixtures/social-schedule.json
// and must accept and refuse the same values. The Rust Admin applies these rules before it calls
// the hosted function; the hosted function applies them again on the way into the database.
//
// Pure: no network, no clock of its own (callers pass `now`), no secret. A refused value is never
// repeated in an error. Only built-ins are used, so it runs in Node and in Deno.

export const MAX_CAPTION_CHARS = 3000;
export const MIN_LEAD_SECONDS = 60;
export const MAX_HORIZON_SECONDS = 366 * 86400;
export const MAX_URL_CHARS = 2000;

const MESSAGES = {
  "unsupported-provider": "That destination is not supported yet.",
  "caption-empty": "Write a caption.",
  "caption-too-long": "The caption is longer than this destination allows.",
  "caption-characters": "The caption contains characters that cannot be posted.",
  "time-invalid": "Choose a valid date and time.",
  "time-needs-zone": "The time must say which time zone it is in.",
  "time-too-soon": "Choose a time at least a minute from now.",
  "time-too-far": "Choose a time within the next year.",
  "time-zone-invalid": "That is not a valid time zone name.",
  "key-invalid": "The request needs a valid idempotency key.",
  "url-invalid": "The link is not a valid public https address.",
  "status-transition": "That change is not allowed from the current status.",
  "not-editable": "Only a scheduled announcement that no worker has claimed can be changed.",
};

export class ScheduleError extends Error {
  constructor(code) {
    super(MESSAGES[code] || "The announcement is not valid.");
    this.name = "ScheduleError";
    this.code = code;
  }
}

const PROVIDERS = new Map([
  ["linkedin", { captionLimit: MAX_CAPTION_CHARS }],
  ["facebook", { captionLimit: MAX_CAPTION_CHARS }],
]);

// A destination this release can announce to. A third provider is a code change on purpose: an
// unsupported destination fails explicitly, never by guess.
export function providerOf(value) {
  if (typeof value !== "string" || !PROVIDERS.has(value)) throw new ScheduleError("unsupported-provider");
  return { name: value, ...PROVIDERS.get(value) };
}

const REFUSED_CHARS = /[\p{Cc}\u{2028}\u{2029}\u{FEFF}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

// Normalizes line endings and trims, then checks length and refuses control characters other than
// a newline. The result is what is stored and sent.
export function checkCaption(providerName, caption) {
  const provider = providerOf(providerName);
  const raw = String(caption ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // A byte-order mark is a refused character, and JavaScript's trim() would silently strip it.
  if (raw.includes("﻿")) throw new ScheduleError("caption-characters");
  const text = raw.trim();
  if (!text) throw new ScheduleError("caption-empty");
  if (REFUSED_CHARS.test(text.replace(/\n/g, ""))) throw new ScheduleError("caption-characters");
  if (Array.from(text).length > provider.captionLimit) throw new ScheduleError("caption-too-long");
  return text;
}

export function checkIdempotencyKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ScheduleError("key-invalid");
  return key;
}

// An IANA-style name (`Europe/London`, `UTC`). Only the shape is checked; the stored instant is
// always UTC and the zone says how the author chose it.
export function checkTimeZone(name) {
  const ok =
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    name.split("/").length <= 3 &&
    name.split("/").every((part) => /^[A-Za-z][A-Za-z0-9_+-]*$/.test(part));
  if (!ok) throw new ScheduleError("time-zone-invalid");
  return name;
}

const utf8Length = (value) => new TextEncoder().encode(value).length;

// A full RFC 3339 date and time that names its zone (Z or +hh:mm), as an exact UTC instant at
// least a minute after `now` (a Date or milliseconds) and no later than a year and a day.
// `bounds: false` skips the lead and horizon checks, for recognizing a retried request whose time has since passed.
export function parseSchedule(input, now, { bounds = true } = {}) {
  const text = typeof input === "string" ? input : "";
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const shape = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
  if (!shape || !/^[\x00-\x7F]*$/.test(text) || text.length < 17) {
    throw new ScheduleError(utf8Length(text) === 10 || utf8Length(text) === 16 ? "time-needs-zone" : "time-invalid");
  }
  let rest = text.slice(16);
  let seconds = 0;
  if (rest.length >= 3 && rest[0] === ":") {
    if (!/^:\d\d/.test(rest)) throw new ScheduleError("time-invalid");
    seconds = Number(rest.slice(1, 3));
    rest = rest.slice(3);
    if (rest.startsWith(".")) {
      const digits = /^\.(\d*)/.exec(rest)[1].length;
      if (digits === 0 || digits > 9) throw new ScheduleError("time-invalid");
      rest = rest.slice(1 + digits);
    }
  }
  let offsetMinutes = 0;
  if (rest === "Z") {
    offsetMinutes = 0;
  } else if (rest === "") {
    throw new ScheduleError("time-needs-zone");
  } else {
    const zone = /^([+-])(\d{2}):(\d{2})$/.exec(rest);
    if (!zone || Number(zone[2]) > 23 || Number(zone[3]) > 59) throw new ScheduleError("time-needs-zone");
    offsetMinutes = (zone[1] === "+" ? 1 : -1) * (Number(zone[2]) * 60 + Number(zone[3]));
  }
  const [year, month, day, hour, minute] = shape.slice(1).map(Number);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, seconds, 0);
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    seconds <= 59;
  if (!real) throw new ScheduleError("time-invalid");
  const ms = probe.getTime() - offsetMinutes * 60000;
  const ahead = Math.floor(ms / 1000) - Math.floor(nowMs / 1000);
  if (!bounds) return new Date(ms);
  if (ahead < MIN_LEAD_SECONDS) throw new ScheduleError("time-too-soon");
  if (ahead > MAX_HORIZON_SECONDS) throw new ScheduleError("time-too-far");
  return new Date(ms);
}

// The instant as it is stored and sent: UTC, to the second, with a Z.
export const utcInstant = (date) => `${new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().slice(0, 19)}Z`;

const publicHttps = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const lastLabel = host.split(".").pop();
  const address = host.startsWith("[") || /^(\d+|0x[0-9a-f]*)$/i.test(lastLabel);
  const ok =
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    !url.includes("?") &&
    !url.includes("#") &&
    !address &&
    host.includes(".") &&
    !/\.(localhost|local|internal)$/.test(host);
  return ok ? parsed : null;
};

// The shape of a stored link: a public https address whose path is the post's own site-relative
// path (`work`), so a link can never point somewhere the post does not live.
export function checkCanonicalUrl(url, work) {
  const parsed = typeof url === "string" && url.length <= MAX_URL_CHARS && /^[\x00-\x7F]*$/.test(url) ? publicHttps(url) : null;
  const workOk =
    typeof work === "string" &&
    work.startsWith("/") &&
    !work.startsWith("//") &&
    work.length >= 2 &&
    work.length <= 500 &&
    !/[?#\\\u0000-\u001F]/.test(work);
  if (!parsed || !workOk || !parsed.pathname.endsWith(work) || parsed.pathname.slice(0, -work.length).endsWith("/") || parsed.pathname.includes("//")) throw new ScheduleError("url-invalid");
  return url;
}

export const STATUSES = Object.freeze(["scheduled", "claimed", "published", "failed", "canceled", "unknown"]);
const TRANSITIONS = new Set([
  "scheduled>claimed",
  "scheduled>canceled",
  "claimed>published",
  "claimed>failed",
  "claimed>unknown",
  "claimed>scheduled",
  "failed>scheduled",
  "unknown>published",
  "unknown>failed",
]);

export const validStatus = (value) => STATUSES.includes(value);
// Only a scheduled announcement, which no worker has claimed, can be changed or canceled by an
// author. A claimed one may already be on its way; an unknown outcome is reconciled, not edited.
export const editable = (status) => status === "scheduled";
export const canBecome = (from, to) => TRANSITIONS.has(`${from}>${to}`);

export function checkAuthorChange(from, to) {
  if (!editable(from)) throw new ScheduleError("not-editable");
  if (to !== "canceled" || !canBecome(from, to)) throw new ScheduleError("status-transition");
}
