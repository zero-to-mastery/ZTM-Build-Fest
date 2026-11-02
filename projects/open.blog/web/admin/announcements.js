// Admin "Social" screen (epic #353, story #356, ADR 0307): compose an announcement of a published
// post for a connected account, see how it will look, choose a time in the author's own zone, and
// manage the queue (edit, reschedule, cancel). Everything here talks to Admin's own
// /admin/api/social/* routes; the browser never sees a key, a token or Supabase.
//
// The pure helpers at the top carry the rules a person needs while typing (the time in their zone
// as a UTC instant, the caption count, the words for a status or an error) and are tested without
// a DOM. The panel below builds labelled, keyboard-operable controls with the shared `el()`; it
// never writes markup from data, only text nodes.

import { el } from "./block-forms.js";

export const CAPTION_LIMIT = 3000;
const PREVIEW_DELAY_MS = 350;

// ---------------------------------------------------------------------- time

/** The browser's own IANA zone name, or "UTC" where it cannot say. */
export function browserZone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const PARTS = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };

/** Minutes the zone is ahead of UTC at the instant `ms` (negative west of Greenwich). */
export function zoneOffsetMinutes(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { ...PARTS, timeZone: zone }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * A wall-clock time in `zone` ("2026-11-02T09:30", what a datetime-local field holds) as the UTC
 * instant it names. A time the clocks skip over does not exist (`nonexistent`); a time they repeat
 * happens twice, and the earlier one is used (`ambiguous`).
 */
export function localToInstant(value, zone) {
  const match = LOCAL_INPUT.exec(String(value ?? ""));
  if (!match) return { ok: false, code: value ? "invalid" : "missing" };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const real = new Date(wall);
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day || real.getUTCHours() !== hour || real.getUTCMinutes() !== minute) {
    return { ok: false, code: "invalid" };
  }
  try {
    const offsets = new Set([zoneOffsetMinutes(wall - 86400000, zone), zoneOffsetMinutes(wall + 86400000, zone), zoneOffsetMinutes(wall, zone)]);
    const found = [...offsets].map((offset) => wall - offset * 60000).filter((candidate) => zoneOffsetMinutes(candidate, zone) === (wall - candidate) / 60000);
    const unique = [...new Set(found)].sort((a, b) => a - b);
    if (!unique.length) return { ok: false, code: "nonexistent" };
    return { ok: true, iso: `${new Date(unique[0]).toISOString().slice(0, 16)}:00Z`, ambiguous: unique.length > 1 };
  } catch {
    return { ok: false, code: "zone" };
  }
}

/** A UTC instant as the value for a datetime-local field in `zone`. */
export function instantToLocalInput(iso, zone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const shifted = new Date(ms + zoneOffsetMinutes(ms, zone) * 60000);
  return shifted.toISOString().slice(0, 16);
}

/** "Mon, 2 Nov 2026, 09:30 GMT" for an instant in `zone`; the ISO text if it cannot be read. */
export function formatWhen(iso, zone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso ?? "");
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone, timeZoneName: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

// ------------------------------------------------------------------- caption

/** Characters as the server counts them (code points of the trimmed text), against the limit. */
export function captionCount(text, limit = CAPTION_LIMIT) {
  const count = Array.from(String(text ?? "").replace(/\r\n?/g, "\n").trim()).length;
  const over = count > limit;
  return { count, limit, over, text: over ? `${count - limit} characters too many (${count} of ${limit})` : `${count} of ${limit} characters` };
}

/** A fresh idempotency key: one per composed announcement, kept across retries of the same one. */
export function newKey(cryptoSource = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  if (cryptoSource?.getRandomValues) cryptoSource.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `ob-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// -------------------------------------------------------------------- words

/** A status as a word and a shape, never a color alone. */
export const STATUS_BADGES = Object.freeze({
  scheduled: { symbol: "◷", text: "Scheduled" },
  claimed: { symbol: "…", text: "Sending" },
  published: { symbol: "✓", text: "Published" },
  failed: { symbol: "✕", text: "Failed" },
  canceled: { symbol: "⊘", text: "Canceled" },
  unknown: { symbol: "?", text: "Needs checking" },
});

const WHY_LOCKED = Object.freeze({
  claimed: "A sender has picked this up, so it can no longer be changed.",
  published: "This was posted, so it can no longer be changed.",
  failed: "This could not be posted.",
  canceled: "This was canceled.",
  unknown: "The result is not known yet; it will not be sent again until it is checked.",
});

/** Server codes that mean the queue moved on while the author looked: the list is refreshed. */
export const REFRESH_CODES = Object.freeze(["stale", "conflict", "not-editable", "not-retryable", "not-resolvable", "needs-resolution"]);

/** What a short code kept on a failed or unchecked announcement means, in words. */
const PROBLEM_WORDS = Object.freeze({
  "rate-limited": "The provider asked us to slow down.",
  "provider-unavailable": "The provider could not take it just now.",
  "provider-rejected": "The provider refused the post.",
  "provider-auth": "The provider refused the saved sign-in. Connect the account again.",
  "needs-reauth": "The account must be connected again.",
  "account-not-connected": "The destination is no longer connected.",
  "unsupported-provider": "This destination cannot be posted to yet.",
  "attempts-exhausted": "It was tried the allowed number of times.",
  timeout: "The provider did not answer, so it may or may not have been posted.",
  "lease-expired": "The sender stopped before it knew the result.",
  "not-delivered": "The provider confirmed it was not posted.",
  "reviewed-not-posted": "You checked and it was not posted.",
  "needs-review": "It could not be checked automatically. Look at the account.",
  "credential-error": "The saved sign-in could not be used.",
});

export const problemWords = (code) => PROBLEM_WORDS[code] || "";

export const lockedReason = (status) => WHY_LOCKED[status] || "";

/** Which field a server error code belongs to: destination, post, caption, time, or general. */
export function fieldForCode(code) {
  if (/^caption-/.test(code || "")) return "caption";
  if (/^time-/.test(code || "")) return "time";
  if (/^(post-|canonical-|url-)/.test(code || "")) return "post";
  if (/^(destination-|unsupported-provider|invalid-account)/.test(code || "")) return "destination";
  return "general";
}

/** The sentence to show for a failed call. A server message is already plain text with no secrets. */
export function errorText(error) {
  const message = error?.data?.error || (error?.status ? error.message : "");
  if (REFRESH_CODES.includes(error?.data?.code)) return `${message} The list has been refreshed.`;
  if (message) return message;
  return "Admin could not be reached. Check your connection and try again.";
}

const providerName = (provider) => ({ linkedin: "LinkedIn", facebook: "Facebook" })[provider] || String(provider || "");
const kindName = (kind) => ({ member: "profile", page: "Page" })[kind] || String(kind || "");

/** "Mikey Nichols (LinkedIn profile)". */
export const destinationLabel = (destination) => (destination ? `${destination.displayName} (${providerName(destination.provider)} ${kindName(destination.kind)})` : "Unknown destination");

// --------------------------------------------------------------------- panel

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

function field({ id, label, control, hint, error }) {
  return el("div", { class: "oba-field oba-announce-field", "data-field": id }, el("label", { for: control.id }, label), control, hint || null, error || null);
}

/**
 * The Social screen. `api.call(method, path, { json })` is Admin's client; its errors carry `status`
 * and `data` (`{ error, code, version }`). Resolves nothing itself: `load()` fills it.
 */
export function createAnnouncementsPanel({ api, zone = browserZone(), timers = globalThis, random = newKey } = {}) {
  const ids = nextId("oba-announce");
  let destinations = [];
  let posts = [];
  let announcements = [];
  let busy = 0;
  let key = null;
  let keyFor = "";
  let previewTicket = 0;
  let previewTimer = null;
  let filter = "";

  const status = el("p", { class: "oba-announce-status", role: "status", "aria-live": "polite", tabindex: "-1", "data-social-status": "true" });
  const loadError = el("div", { class: "oba-error", role: "alert", hidden: true, "data-social-load-error": "true" });

  // ---- composer
  const destination = el("select", { id: `${ids}-destination`, name: "destination", required: true, "aria-describedby": `${ids}-destination-hint ${ids}-destination-error` });
  const post = el("select", { id: `${ids}-post`, name: "post", required: true, "aria-describedby": `${ids}-post-hint ${ids}-post-error` });
  const caption = el("textarea", { id: `${ids}-caption`, name: "caption", rows: "6", required: true, "aria-describedby": `${ids}-caption-count ${ids}-caption-error`, autocomplete: "off" });
  const count = el("p", { class: "oba-small oba-announce-count", id: `${ids}-caption-count`, "data-social-count": "true" });
  const when = el("input", { id: `${ids}-when`, name: "when", type: "datetime-local", required: true, "aria-describedby": `${ids}-when-hint ${ids}-when-error` });
  const errors = {};
  const errorNode = (name) => (errors[name] = el("p", { class: "oba-field-error", id: `${ids}-${name}-error`, hidden: true, "data-error-for": name }));
  const problemsBox = el("div", { class: "oba-error oba-announce-problems", role: "alert", tabindex: "-1", hidden: true, "data-social-problems": "true" });
  const submit = el("button", { class: "oba-btn oba-btn-primary", type: "submit", "data-action": "social-schedule" }, "Schedule announcement");
  const clear = el("button", { class: "oba-btn", type: "button", "data-action": "social-clear" }, "Clear");
  const previewBox = el("section", { class: "oba-announce-preview", "aria-labelledby": `${ids}-preview-title`, "data-social-preview": "true" });
  const form = el("form", { class: "oba-announce-composer", novalidate: true, "aria-labelledby": `${ids}-compose-title`, "data-social-composer": "true" });

  const controls = { destination, post, caption, time: when };

  function setError(name, message) {
    const node = errors[name];
    if (node) {
      node.textContent = message || "";
      node.hidden = !message;
    }
    const control = controls[name];
    if (control) {
      if (message) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
  }
  const clearErrors = () => {
    for (const name of Object.keys(controls)) setError(name, "");
    problemsBox.hidden = true;
    problemsBox.replaceChildren();
  };

  /** Shows problems beside their fields and in one list at the top, and moves focus to the first. */
  function showProblems(list) {
    clearErrors();
    const lines = [];
    for (const problem of list) {
      const name = problem.field && controls[problem.field] ? problem.field : controls[fieldForCode(problem.code)] ? fieldForCode(problem.code) : null;
      if (name && !errors[name].textContent) setError(name, problem.message);
      lines.push(el("li", {}, name ? el("a", { href: `#${controls[name].id}`, onClick: (event) => { event.preventDefault?.(); controls[name].focus(); } }, problem.message) : problem.message));
    }
    if (!lines.length) return;
    problemsBox.replaceChildren(el("p", {}, lines.length === 1 ? "There is 1 thing to fix before this can be scheduled:" : `There are ${lines.length} things to fix before this can be scheduled:`), el("ul", {}, lines));
    problemsBox.hidden = false;
    problemsBox.focus();
  }

  const selectedDestination = () => destinations.find((item) => item.id === destination.value) || null;
  const selectedPost = () => posts.find((item) => item.work === post.value) || null;

  function fillDestinations() {
    destination.replaceChildren(
      el("option", { value: "" }, destinations.length ? "Choose where to post" : "No connected accounts"),
      ...destinations.map((item) => el("option", { value: item.id }, destinationLabel(item))),
    );
    destination.disabled = !destinations.length;
  }

  function fillPosts() {
    const eligible = posts.filter((item) => item.eligible);
    const blocked = posts.filter((item) => !item.eligible);
    post.replaceChildren(
      el("option", { value: "" }, eligible.length ? "Choose a published post" : "No published posts yet"),
      ...eligible.map((item) => el("option", { value: item.work }, item.title)),
      ...(blocked.length ? [el("optgroup", { label: "Not available to announce" }, blocked.map((item) => el("option", { value: item.work, disabled: true }, `${item.title} - ${item.reason?.message || "not available"}`)))] : []),
    );
    post.disabled = !eligible.length;
  }

  // ---- preview
  function renderPreview(model) {
    const chosen = selectedDestination();
    const body = [el("h3", { id: `${ids}-preview-title` }, "Preview")];
    if (!model) {
      body.push(el("p", { class: "oba-small", "data-preview-empty": "true" }, "Choose a destination, a post and write a caption to see the announcement here."));
      previewBox.replaceChildren(...body);
      return;
    }
    body.push(
      el(
        "article",
        { class: "oba-announce-card", "aria-label": "How the announcement will look" },
        el("p", { class: "oba-small oba-announce-card-to", "data-preview-to": "true" }, chosen ? `To ${destinationLabel(chosen)}` : "No destination chosen"),
        el("p", { class: "oba-announce-card-caption", "data-preview-caption": "true" }, model.caption ?? caption.value.trim()),
        model.link ? el("p", { class: "oba-announce-card-link" }, el("span", { class: "oba-small" }, "Links to "), el("span", { class: "oba-announce-url", "data-preview-link": "true" }, model.link)) : null,
        el("p", { class: "oba-small oba-announce-card-when", "data-preview-when": "true" }, model.scheduledFor ? `Posts ${formatWhen(model.scheduledFor, zone)} (${model.scheduledFor.replace("T", " ").replace(":00Z", " UTC")})` : "No time chosen yet."),
      ),
    );
    if (model.notes?.length) body.push(el("ul", { class: "oba-small", "data-preview-notes": "true" }, model.notes.map((note) => el("li", {}, note))));
    if (model.problems?.length) body.push(el("ul", { class: "oba-small oba-announce-preview-problems", "data-preview-problems": "true" }, model.problems.map((problem) => el("li", {}, problem.message))));
    previewBox.replaceChildren(...body);
  }

  function updateCount() {
    const result = captionCount(caption.value);
    count.textContent = result.text;
    count.setAttribute("data-over", result.over ? "true" : "false");
    if (result.over) setError("caption", `The caption is ${result.count - result.limit} characters too long.`);
    else if (errors.caption.textContent.startsWith("The caption is ")) setError("caption", "");
  }

  async function refreshPreview() {
    const ticket = ++previewTicket;
    const chosen = selectedDestination();
    const picked = selectedPost();
    const converted = localToInstant(when.value, zone);
    if (!chosen || !caption.value.trim()) return renderPreview(null);
    const notes = [];
    if (converted.ok && converted.ambiguous) notes.push("This time happens twice when the clocks change. The earlier one is used.");
    if (!converted.ok && converted.code === "nonexistent") notes.push("This time does not exist in your time zone because the clocks skip it. Choose another.");
    try {
      const answer = await api.call("POST", "social/preview", {
        json: { provider: chosen.provider, caption: caption.value, ...(picked ? { work: picked.work } : {}), ...(converted.ok ? { scheduledFor: converted.iso, timeZone: zone } : {}) },
      });
      if (ticket !== previewTicket) return;
      renderPreview({ ...answer, caption: answer.caption ?? caption.value.trim(), notes });
    } catch (error) {
      if (ticket !== previewTicket) return;
      renderPreview({ caption: caption.value.trim(), link: picked?.canonicalUrl || null, scheduledFor: converted.ok ? converted.iso : null, notes, problems: [{ message: errorText(error) }] });
    }
  }

  function schedulePreview() {
    updateCount();
    timers.clearTimeout?.(previewTimer);
    previewTimer = timers.setTimeout(() => {
      refreshPreview();
    }, PREVIEW_DELAY_MS);
  }

  // ---- create
  const draftSignature = () => JSON.stringify([destination.value, post.value, caption.value.trim(), when.value]);

  async function onSubmit(event) {
    event.preventDefault?.();
    if (busy) return;
    clearErrors();
    const chosen = selectedDestination();
    const picked = selectedPost();
    const converted = localToInstant(when.value, zone);
    const problems = [];
    if (!chosen) problems.push({ field: "destination", code: "destination-missing", message: "Choose where to post." });
    if (!picked) problems.push({ field: "post", code: "post-missing", message: "Choose a published post." });
    if (!caption.value.trim()) problems.push({ field: "caption", code: "caption-empty", message: "Write a caption." });
    else if (captionCount(caption.value).over) problems.push({ field: "caption", code: "caption-too-long", message: `The caption is ${captionCount(caption.value).count - CAPTION_LIMIT} characters too long.` });
    if (!converted.ok) {
      problems.push({ field: "time", code: "time-invalid", message: converted.code === "nonexistent" ? "That time does not exist in your time zone because the clocks skip it. Choose another." : when.value ? "Choose a valid date and time." : "Choose a date and time." });
    }
    if (problems.length) return showProblems(problems);
    // The same composed announcement keeps its key, so a retry after a timeout cannot post twice.
    const signature = draftSignature();
    if (!key || keyFor !== signature) {
      key = random();
      keyFor = signature;
    }
    busy += 1;
    submit.disabled = true;
    status.textContent = "Scheduling...";
    try {
      const answer = await api.call("POST", "social/announcements", {
        json: { accountId: chosen.id, work: picked.work, caption: caption.value, scheduledFor: converted.iso, timeZone: zone, idempotencyKey: key },
      });
      const made = answer.announcement;
      status.textContent = `${answer.replayed ? "Already scheduled" : "Scheduled"} for ${formatWhen(made.scheduledFor, zone)} on ${destinationLabel(chosen)}.`;
      key = null;
      keyFor = "";
      resetComposer();
      await loadAnnouncements();
      status.focus();
    } catch (error) {
      status.textContent = "";
      const code = error?.data?.code;
      if (error?.status === 422 || code) showProblems([{ field: fieldForCode(code) === "general" ? null : fieldForCode(code), code, message: errorText(error) }]);
      else {
        showProblems([{ message: errorText(error) }]);
        // The outcome is unknown: the announcement may exist. Show the queue and keep the key, so
        // sending the same draft again is recognized rather than posted twice.
        status.textContent = "The announcement may already be scheduled. Check the list below before trying again.";
        try {
          await loadAnnouncements();
        } catch {
          // The list is shown again on the next successful load.
        }
      }
    } finally {
      busy -= 1;
      submit.disabled = false;
    }
  }

  function resetComposer() {
    caption.value = "";
    when.value = "";
    post.value = "";
    clearErrors();
    updateCount();
    renderPreview(null);
  }

  form.addEventListener("submit", onSubmit);
  clear.addEventListener("click", () => {
    resetComposer();
    destination.focus();
  });
  for (const control of [destination, post, caption, when]) {
    control.addEventListener("input", schedulePreview);
    control.addEventListener("change", schedulePreview);
  }

  form.append(
    el("h2", { id: `${ids}-compose-title` }, "Announce a post"),
    el("p", { class: "oba-small" }, "Write a short caption for one of your published posts and choose when it goes out. The link to the post is added for you."),
    problemsBox,
    field({
      id: "destination",
      label: "Destination",
      control: destination,
      hint: el("p", { class: "oba-small oba-landing-hint", id: `${ids}-destination-hint` }, "The LinkedIn profile or Facebook Page that will post it."),
      error: errorNode("destination"),
    }),
    field({
      id: "post",
      label: "Post to announce",
      control: post,
      hint: el("p", { class: "oba-small oba-landing-hint", id: `${ids}-post-hint` }, "Only published posts can be announced. A draft or a post dated in the future is listed as not available."),
      error: errorNode("post"),
    }),
    field({ id: "caption", label: "Caption", control: caption, hint: count, error: errorNode("caption") }),
    field({
      id: "time",
      label: `Date and time (${zone})`,
      control: when,
      hint: el("p", { class: "oba-small oba-landing-hint", id: `${ids}-when-hint` }, `In your time zone, ${zone}. It must be at least a minute from now and within a year.`),
      error: errorNode("time"),
    }),
    previewBox,
    el("div", { class: "oba-landing-actions oba-announce-actions" }, submit, clear),
  );

  // ---- list
  const list = el("div", { class: "oba-announce-list-wrap" });
  const filterSelect = el(
    "select",
    { id: `${ids}-filter`, "aria-describedby": `${ids}-filter-hint` },
    [["", "All announcements"], ["scheduled", "Scheduled"], ["published", "Published"], ["failed", "Failed"], ["unknown", "Needs checking"], ["canceled", "Canceled"]].map(([value, text]) => el("option", { value }, text)),
  );
  filterSelect.addEventListener("change", () => {
    filter = filterSelect.value;
    loadAnnouncements();
  });

  function rowNode(item) {
    const badge = STATUS_BADGES[item.status] || { symbol: "?", text: item.status };
    const heading = nextId(`${ids}-row`);
    const meta = el("p", { class: "oba-small oba-announce-meta" }, `${formatWhen(item.scheduledFor, zone)} - ${destinationLabel(item.destination)}`);
    const row = el(
      "li",
      { class: "oba-announce-row", "data-announcement": item.id, "data-status": item.status, "aria-labelledby": heading },
      el(
        "div",
        { class: "oba-announce-row-head" },
        el("strong", { id: heading, class: "oba-announce-row-title" }, el("a", { href: item.canonicalUrl, target: "_blank", rel: "noopener" }, item.work)),
        el("span", { class: `oba-announce-badge oba-announce-badge-${item.status}`, "data-status-badge": item.status }, el("span", { "aria-hidden": "true" }, `${badge.symbol} `), badge.text),
      ),
      meta,
      el("p", { class: "oba-announce-caption", "data-row-caption": "true" }, item.caption),
      item.lastErrorCode ? el("p", { class: "oba-small oba-announce-error-code", "data-row-error": "true" }, `Last problem: ${problemWords(item.lastErrorCode) || item.lastErrorCode} (${item.lastErrorCode})`) : null,
      item.status === "scheduled" && item.nextAttemptAt ? el("p", { class: "oba-small oba-announce-next", "data-row-next": "true" }, `Will try again ${formatWhen(item.nextAttemptAt, zone)}.`) : null,
    );
    const actions = el("div", { class: "oba-landing-actions oba-announce-row-actions" });
    if (item.editable) {
      const edit = el("button", { class: "oba-btn", type: "button", "data-action": "social-edit", "aria-label": `Edit the announcement of ${item.work}`, "aria-expanded": "false" }, "Edit");
      const cancel = el("button", { class: "oba-btn", type: "button", "data-action": "social-cancel", "aria-label": `Cancel the announcement of ${item.work}`, "aria-expanded": "false" }, "Cancel announcement");
      const panel = el("div", { class: "oba-announce-row-panel", hidden: true });
      edit.addEventListener("click", () => openEditor(item, panel, edit, cancel));
      cancel.addEventListener("click", () => openCancel(item, panel, edit, cancel));
      actions.append(edit, cancel);
      row.append(actions, panel);
    } else {
      row.append(el("p", { class: "oba-small oba-announce-locked", "data-row-locked": "true" }, lockedReason(item.status)));
      if (item.retryable || item.resolvable) row.append(recoveryNode(item));
    }
    if (item.attemptCount > 0) row.append(historyNode(item));
    return row;
  }

  // ---- recovery: try a failed one again, or say what happened to one whose result is unknown
  function recoveryNode(item) {
    const box = el("div", { class: "oba-announce-recovery" });
    const panel = el("div", { class: "oba-announce-row-panel", hidden: true });
    const open = el("button", { class: "oba-btn", type: "button", "aria-expanded": "false", "aria-label": `${item.retryable ? "Try again: the announcement of" : "Check the result of the announcement of"} ${item.work}`, "data-action": item.retryable ? "social-retry" : "social-resolve" }, item.retryable ? "Try again" : "Check the result");
    const close = (focus) => {
      panel.hidden = true;
      panel.replaceChildren();
      open.setAttribute("aria-expanded", "false");
      if (focus) open.focus();
    };
    const problem = el("p", { class: "oba-field-error", role: "alert", hidden: true });
    const keep = el("button", { class: "oba-btn", type: "button", "data-action": "social-keep" }, "Not now");
    keep.addEventListener("click", () => close(true));
    // Show the panel before focusing into it: a hidden element cannot take focus.
    const reveal = () => {
      panel.hidden = false;
      open.setAttribute("aria-expanded", "true");
    };
    open.addEventListener("click", () => {
      if (!panel.hidden) return close(true);
      problem.hidden = true;
      if (item.retryable) {
        const confirm = el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "social-confirm-retry" }, "Yes, try again");
        confirm.addEventListener("click", () => change(() => api.call("POST", `social/announcements/retry?id=${encodeURIComponent(item.id)}`, { json: { version: item.version } }), () => "Back in the queue. It will be tried again within a minute.", problem, confirm));
        panel.replaceChildren(el("p", {}, `Try the announcement of ${item.work} again? It was not posted, so this will not post it twice.`), problem, el("div", { class: "oba-landing-actions" }, confirm, keep));
        panel.dataset.mode = "retry";
        panel.setAttribute("data-mode", "retry");
        reveal();
        confirm.focus?.();
      } else {
        const id = nextId(`${ids}-resolve`);
        const posted = el("input", { type: "radio", name: id, id: `${id}-posted`, value: "published" });
        const missing = el("input", { type: "radio", name: id, id: `${id}-missing`, value: "not-posted" });
        const postId = el("input", { type: "text", id: `${id}-post-id`, autocomplete: "off", spellcheck: "false", "aria-describedby": `${id}-post-id-hint` });
        const confirm = el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "social-confirm-resolve" }, "Save what I found");
        confirm.addEventListener("click", () => {
          const outcome = posted.checked ? "published" : missing.checked ? "not-posted" : "";
          const value = postId.value.trim();
          if (!outcome) return fail("Choose what you found.", posted);
          if (outcome === "published" && !/^[\x21-\x7e]{1,300}$/.test(value)) return fail("Enter the post id the provider shows for it, with no spaces.", postId);
          const json = { version: item.version, outcome };
          if (outcome === "published") json.providerPostId = value;
          return change(() => api.call("POST", `social/announcements/resolve?id=${encodeURIComponent(item.id)}`, { json }), (made) => (made.status === "published" ? "Recorded as posted." : "Recorded as not posted. You can try it again."), problem, confirm);
        });
        function fail(message, control) {
          problem.textContent = message;
          problem.hidden = false;
          control.focus?.();
        }
        panel.replaceChildren(
          el("p", {}, `The provider did not say whether ${item.work} was posted. Look at the ${providerName(item.destination?.provider)} account, then say what you found. It will not be sent again until you do.`),
          el("fieldset", { class: "oba-field oba-fieldset" }, el("legend", {}, "What did you find?"), el("div", { class: "oba-announce-choice" }, posted, el("label", { for: posted.id }, "It was posted")), el("div", { class: "oba-announce-choice" }, missing, el("label", { for: missing.id }, "It was not posted"))),
          el("div", { class: "oba-field" }, el("label", { for: postId.id }, "Post id (only if it was posted)"), postId, el("p", { class: "oba-small", id: `${id}-post-id-hint` }, "The id the provider shows for the post, such as the end of its address.")),
          problem,
          el("div", { class: "oba-landing-actions" }, confirm, keep),
        );
        panel.dataset.mode = "resolve";
        panel.setAttribute("data-mode", "resolve");
        reveal();
        posted.focus?.();
      }
    });
    box.append(el("div", { class: "oba-landing-actions oba-announce-row-actions" }, open), panel);
    return box;
  }

  // ---- history: what was tried, loaded when the author asks
  function historyNode(item) {
    const body = el("div", { class: "oba-announce-history-body" });
    const details = el("details", { class: "oba-announce-history", "data-history": item.id }, el("summary", {}, `What was tried (${item.attemptCount})`), body);
    let loaded = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded) return;
      loaded = true;
      body.replaceChildren(el("p", { class: "oba-small" }, "Loading…"));
      try {
        const answer = await api.call("GET", `social/announcements/attempts?id=${encodeURIComponent(item.id)}`);
        const tries = Array.isArray(answer.attempts) ? answer.attempts : [];
        body.replaceChildren(
          tries.length
            ? el(
                "ol",
                { class: "oba-announce-attempts", "aria-label": `Attempts for ${item.work}` },
                tries.map((attempt) =>
                  el(
                    "li",
                    { "data-attempt": String(attempt.attemptNo) },
                    `Try ${attempt.attemptNo}, ${formatWhen(attempt.startedAt, zone)}: ${attempt.outcome ? ({ published: "posted", failed: "not posted", unknown: "result unknown" })[attempt.outcome] || attempt.outcome : "in progress"}${attempt.httpStatus ? ` (HTTP ${attempt.httpStatus})` : ""}${attempt.errorCode ? `. ${problemWords(attempt.errorCode) || attempt.errorCode}` : ""}`,
                  ),
                ),
              )
            : el("p", { class: "oba-small" }, "Nothing has been tried yet."),
        );
      } catch (error) {
        loaded = false;
        body.replaceChildren(el("p", { class: "oba-field-error", role: "alert" }, errorText(error)));
      }
    });
    return details;
  }

  function closePanel(panel, edit, cancel, focus) {
    panel.hidden = true;
    panel.replaceChildren();
    edit.setAttribute("aria-expanded", "false");
    cancel.setAttribute("aria-expanded", "false");
    focus?.focus();
  }

  function openEditor(item, panel, edit, cancel) {
    if (!panel.hidden && panel.dataset.mode === "edit") return closePanel(panel, edit, cancel, edit);
    const id = nextId(`${ids}-edit`);
    const text = el("textarea", { id: `${id}-caption`, rows: "5", "aria-describedby": `${id}-count ${id}-error` });
    text.value = item.caption;
    const at = el("input", { id: `${id}-when`, type: "datetime-local", "aria-describedby": `${id}-error` });
    at.value = instantToLocalInput(item.scheduledFor, zone);
    const counter = el("p", { class: "oba-small oba-announce-count", id: `${id}-count` }, captionCount(item.caption).text);
    text.addEventListener("input", () => {
      counter.textContent = captionCount(text.value).text;
    });
    const problem = el("p", { class: "oba-field-error", id: `${id}-error`, role: "alert", hidden: true });
    const save = el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "social-save" }, "Save changes");
    const discard = el("button", { class: "oba-btn", type: "button", "data-action": "social-discard" }, "Discard");
    discard.addEventListener("click", () => closePanel(panel, edit, cancel, edit));
    save.addEventListener("click", async () => {
      problem.hidden = true;
      const converted = localToInstant(at.value, zone);
      if (!converted.ok) {
        problem.textContent = converted.code === "nonexistent" ? "That time does not exist in your time zone because the clocks skip it." : "Choose a valid date and time.";
        problem.hidden = false;
        return at.focus();
      }
      const captionChanged = text.value.trim() !== item.caption;
      const timeChanged = converted.iso !== item.scheduledFor;
      if (!captionChanged && !timeChanged) {
        problem.textContent = "Nothing has changed.";
        problem.hidden = false;
        return text.focus();
      }
      if (captionCount(text.value).over || !text.value.trim()) {
        problem.textContent = text.value.trim() ? "The caption is too long." : "Write a caption.";
        problem.hidden = false;
        return text.focus();
      }
      await change(
        () => (captionChanged ? api.call("PATCH", `social/announcements?id=${encodeURIComponent(item.id)}`, { json: { version: item.version, caption: text.value, ...(timeChanged ? { scheduledFor: converted.iso, timeZone: zone } : {}) } }) : api.call("POST", `social/announcements/reschedule?id=${encodeURIComponent(item.id)}`, { json: { version: item.version, scheduledFor: converted.iso, timeZone: zone } })),
        (made) => `Saved. It is scheduled for ${formatWhen(made.scheduledFor, zone)}.`,
        problem,
        save,
      );
    });
    panel.dataset.mode = "edit";
    panel.replaceChildren(
      el("div", { class: "oba-field oba-announce-field" }, el("label", { for: text.id }, "Caption"), text, counter),
      el("div", { class: "oba-field oba-announce-field" }, el("label", { for: at.id }, `Date and time (${zone})`), at),
      problem,
      el("div", { class: "oba-landing-actions" }, save, discard),
    );
    panel.setAttribute("data-mode", "edit");
    panel.hidden = false;
    edit.setAttribute("aria-expanded", "true");
    cancel.setAttribute("aria-expanded", "false");
    text.focus();
  }

  function openCancel(item, panel, edit, cancel) {
    if (!panel.hidden && panel.dataset.mode === "cancel") return closePanel(panel, edit, cancel, cancel);
    const problem = el("p", { class: "oba-field-error", role: "alert", hidden: true });
    const confirm = el("button", { class: "oba-btn oba-btn-danger", type: "button", "data-action": "social-confirm-cancel" }, "Yes, cancel it");
    const keep = el("button", { class: "oba-btn", type: "button", "data-action": "social-keep" }, "Keep it");
    keep.addEventListener("click", () => closePanel(panel, edit, cancel, cancel));
    confirm.addEventListener("click", () =>
      change(() => api.call("POST", `social/announcements/cancel?id=${encodeURIComponent(item.id)}`, { json: { version: item.version } }), () => "Canceled. It will not be posted.", problem, confirm),
    );
    panel.dataset.mode = "cancel";
    panel.setAttribute("data-mode", "cancel");
    panel.replaceChildren(el("p", {}, `Cancel the announcement of ${item.work}? It will not be posted. You can schedule a new one later.`), problem, el("div", { class: "oba-landing-actions" }, confirm, keep));
    panel.hidden = false;
    cancel.setAttribute("aria-expanded", "true");
    edit.setAttribute("aria-expanded", "false");
    keep.focus();
  }

  /** Runs a change, then refreshes the queue and says what happened. A lost race refreshes it and says so. */
  async function change(run, done, problem, button) {
    if (busy) return;
    busy += 1;
    button.disabled = true;
    problem.hidden = true;
    try {
      const answer = await run();
      status.textContent = done(answer.announcement);
      await loadAnnouncements();
      status.focus();
    } catch (error) {
      const message = errorText(error);
      if (REFRESH_CODES.includes(error?.data?.code)) {
        status.textContent = message;
        await loadAnnouncements();
        status.focus();
      } else {
        problem.textContent = message;
        problem.hidden = false;
        button.disabled = false;
      }
    } finally {
      busy -= 1;
    }
  }

  function renderList() {
    list.replaceChildren(
      announcements.length
        ? el("ul", { class: "oba-announce-list", "aria-label": "Announcements" }, announcements.map((item) => rowNode(item)))
        : el("p", { class: "oba-notice", "data-social-empty": "true" }, filter ? "No announcements with that status." : "Nothing is scheduled yet. Announce a post above."),
    );
  }

  async function loadAnnouncements() {
    const query = filter ? `?status=${encodeURIComponent(filter)}` : "";
    const answer = await api.call("GET", `social/announcements${query}`);
    announcements = answer.announcements || [];
    renderList();
  }

  async function load() {
    loadError.hidden = true;
    try {
      const [dest, found, queue] = await Promise.all([api.call("GET", "social/destinations"), api.call("GET", "social/posts"), api.call("GET", "social/announcements")]);
      destinations = dest.destinations || [];
      posts = found.posts || [];
      announcements = queue.announcements || [];
    } catch (error) {
      if (error?.status === 401) throw error;
      const retry = el("button", { class: "oba-btn", type: "button", "data-action": "social-retry" }, "Try again");
      retry.addEventListener("click", () => load());
      loadError.replaceChildren(el("p", {}, errorText(error)), retry);
      loadError.hidden = false;
      return;
    }
    fillDestinations();
    fillPosts();
    updateCount();
    renderPreview(null);
    renderList();
    if (!destinations.length) {
      status.textContent = "No account is connected yet, so there is nowhere to post. Connect a LinkedIn profile or Facebook Page first.";
    }
  }

  const element = el(
    "div",
    { class: "oba-announce", "data-social-screen": "true" },
    status,
    loadError,
    form,
    el(
      "section",
      { class: "oba-announce-queue", "aria-labelledby": `${ids}-queue-title` },
      el("h2", { id: `${ids}-queue-title` }, "Announcements"),
      el("div", { class: "oba-field oba-announce-field" }, el("label", { for: `${ids}-filter` }, "Show"), filterSelect, el("p", { class: "oba-small oba-landing-hint", id: `${ids}-filter-hint` }, `Times are shown in your time zone, ${zone}.`)),
      list,
    ),
  );
  renderPreview(null);
  updateCount();

  return {
    element,
    load,
    isDirty: () => Boolean(caption.value.trim()),
    isBusy: () => busy > 0,
  };
}
