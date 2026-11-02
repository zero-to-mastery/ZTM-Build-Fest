// The Admin "Social" screen (epic #353, story #356, ADR 0310): the time in the author's own zone as
// a UTC instant (with the days the clocks change), the caption count, the words for statuses and
// errors, and the panel's behavior against a fake Admin: labelled fields, problems beside them,
// idempotent retries, versioned edits, a confirmed cancel, and a refreshed queue after a lost race.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_LIMIT,
  STATUS_BADGES,
  captionCount,
  createAnnouncementsPanel,
  destinationLabel,
  errorText,
  fieldForCode,
  formatWhen,
  instantToLocalInput,
  localToInstant,
  lockedReason,
  newKey,
  problemWords,
  REFRESH_CODES,
} from "../../web/admin/announcements.js";
import { ApiError, withDom } from "./dom-shim.mjs";
// Importing the Voice harness makes the shared DOM refuse what a real browser would turn into text
// (null, false and arrays passed to append/replaceChildren), which a forgiving shim hid once before.
import "./voice-harness.mjs";

const NY = "America/New_York";

test("a time in the author's zone is the UTC instant it names", () => {
  assert.deepEqual(localToInstant("2026-11-02T09:30", NY), { ok: true, iso: "2026-11-02T14:30:00Z", ambiguous: false }, "standard time");
  assert.deepEqual(localToInstant("2026-07-01T09:30", NY), { ok: true, iso: "2026-07-01T13:30:00Z", ambiguous: false }, "daylight time");
  assert.equal(localToInstant("2026-11-02T09:30", "Asia/Kolkata").iso, "2026-11-02T04:00:00Z");
  assert.equal(localToInstant("2026-11-02T09:30", "UTC").iso, "2026-11-02T09:30:00Z");
  assert.equal(localToInstant("2026-10-26T01:30", "Europe/London").iso, "2026-10-26T01:30:00Z", "after the clocks went back in London");
});

test("the days the clocks change: a skipped time does not exist, a repeated time uses the earlier", () => {
  assert.deepEqual(localToInstant("2026-03-08T02:30", NY), { ok: false, code: "nonexistent" });
  assert.equal(localToInstant("2026-03-08T03:30", NY).iso, "2026-03-08T07:30:00Z");
  const repeated = localToInstant("2026-11-01T01:30", NY);
  assert.deepEqual(repeated, { ok: true, iso: "2026-11-01T05:30:00Z", ambiguous: true });
  assert.equal(localToInstant("2026-11-01T02:30", NY).ambiguous, false);
});

test("input that is not a time is refused with a reason", () => {
  assert.deepEqual(localToInstant("", NY), { ok: false, code: "missing" });
  for (const bad of ["garbage", "2026-02-30T10:00", "2026-13-01T10:00", "2026-11-02T25:00", "2026-11-02", "2026-11-02T09:30:00"]) {
    assert.deepEqual(localToInstant(bad, NY), { ok: false, code: "invalid" }, bad);
  }
  assert.equal(localToInstant("2026-11-02T09:30", "Not/AZone").code, "zone");
});

test("an instant round-trips into a datetime-local value and reads in plain words", () => {
  assert.equal(instantToLocalInput("2026-11-02T14:30:00Z", NY), "2026-11-02T09:30");
  assert.equal(localToInstant(instantToLocalInput("2026-07-01T13:30:00Z", NY), NY).iso, "2026-07-01T13:30:00Z");
  assert.equal(instantToLocalInput("nope", NY), "");
  const words = formatWhen("2026-11-02T14:30:00Z", NY);
  assert.match(words, /Mon/);
  assert.match(words, /09:30/);
  assert.equal(formatWhen("not a time", NY), "not a time");
});

test("the caption count follows the server: code points of the trimmed text", () => {
  assert.deepEqual(captionCount("  hello  "), { count: 5, limit: CAPTION_LIMIT, over: false, text: "5 of 3000 characters" });
  assert.equal(captionCount("😀😀").count, 2);
  assert.equal(captionCount("a\r\nb").count, 3);
  const over = captionCount("a".repeat(CAPTION_LIMIT + 2));
  assert.equal(over.over, true);
  assert.match(over.text, /^2 characters too many/);
});

test("an idempotency key has the shape the server accepts, and is fresh each time", () => {
  const a = newKey();
  assert.match(a, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(a, newKey());
  assert.match(newKey({ getRandomValues: (bytes) => bytes.fill(7) }), /^ob-0707/);
});

test("statuses and errors have words, and a locked announcement says why", () => {
  for (const status of ["scheduled", "claimed", "published", "failed", "canceled", "unknown"]) {
    assert.ok(STATUS_BADGES[status].text && STATUS_BADGES[status].symbol, status);
  }
  assert.match(lockedReason("claimed"), /no longer be changed/);
  assert.equal(lockedReason("scheduled"), "");
  assert.equal(fieldForCode("caption-too-long"), "caption");
  assert.equal(fieldForCode("time-too-soon"), "time");
  assert.equal(fieldForCode("post-not-published"), "post");
  assert.equal(fieldForCode("canonical-elsewhere"), "post");
  assert.equal(fieldForCode("destination-not-connected"), "destination");
  assert.equal(fieldForCode("unsupported-provider"), "destination");
  assert.equal(fieldForCode("hosted-failed"), "general");
  assert.equal(errorText(new ApiError("x", 422, { error: "Write a caption.", code: "caption-empty" })), "Write a caption.");
  assert.match(errorText(new ApiError("x", 409, { error: "Changed.", code: "stale" })), /refreshed/);
  assert.match(errorText(new ApiError("x", 409, { error: "Only a scheduled one.", code: "not-editable" })), /refreshed/);
  assert.match(errorText(new TypeError("Failed to fetch")), /could not be reached/);
  assert.equal(destinationLabel({ displayName: "Lantern", provider: "facebook", kind: "page" }), "Lantern (Facebook Page)");
});

// ------------------------------------------------------------------ the panel

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const all = (root, selector) => root.querySelectorAll(selector);
const byData = (root, name, value) => all(root, `[${name}]`).filter((node) => (value === undefined ? true : node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === value));
const button = (root, action) => byData(root, "data-action", action)[0];
const text = (node) => node.textContent;

const dest = [
  { id: "d-1", provider: "linkedin", kind: "member", displayName: "Mikey Nichols", status: "connected" },
  { id: "d-2", provider: "facebook", kind: "page", displayName: "Lantern Page", status: "connected" },
];
const found = [
  { work: "/posts/hello/", title: "Hello", eligible: true, canonicalUrl: "https://blog.example.org/posts/hello/", reason: null },
  { work: "/posts/draft/", title: "Secret draft", eligible: false, canonicalUrl: null, reason: { code: "post-not-published", message: "Only a published post can be announced." } },
];
const row = (over = {}) => ({
  id: "a-1",
  accountId: "d-1",
  destination: dest[0],
  work: "/posts/hello/",
  canonicalUrl: "https://blog.example.org/posts/hello/",
  caption: "A new post is live.",
  scheduledFor: "2099-01-01T15:00:00Z",
  status: "scheduled",
  version: 1,
  lastErrorCode: null,
  editable: true,
  ...over,
});

function fakeAdmin({ queue = [row()], fail = {} } = {}) {
  const calls = [];
  let current = queue;
  const api = {
    calls,
    async call(method, path, options = {}) {
      calls.push({ method, path, json: options.json });
      const route = `${method} ${path.split("?")[0]}`;
      if (fail[route]) {
        const failure = fail[route];
        if (failure.once) delete fail[route];
        throw failure.error;
      }
      if (route === "GET social/destinations") return { destinations: dest };
      if (route === "GET social/posts") return { posts: found, now: "2026-11-01T12:00:00Z" };
      if (route === "GET social/announcements") return { announcements: current };
      if (route === "POST social/preview") return { ok: true, caption: options.json.caption.trim(), link: "https://blog.example.org/posts/hello/", scheduledFor: options.json.scheduledFor || null, problems: [] };
      if (route === "POST social/announcements") {
        const made = row({ id: "a-2", caption: options.json.caption, scheduledFor: options.json.scheduledFor });
        current = [made, ...current];
        return { announcement: made, replayed: false };
      }
      if (route === "PATCH social/announcements" || route === "POST social/announcements/reschedule") {
        const made = row({ ...current[0], version: 2, caption: options.json.caption ?? current[0].caption, scheduledFor: options.json.scheduledFor ?? current[0].scheduledFor });
        current = [made];
        return { announcement: made };
      }
      if (route === "POST social/announcements/cancel") {
        const made = row({ ...current[0], status: "canceled", editable: false, version: 2 });
        current = [made];
        return { announcement: made };
      }
      if (route === "POST social/announcements/retry") {
        const made = row({ ...current[0], status: "scheduled", editable: true, retryable: false, version: current[0].version + 1 });
        current = [made];
        return { announcement: made };
      }
      if (route === "POST social/announcements/resolve") {
        const published = options.json.outcome === "published";
        const made = row({ ...current[0], status: published ? "published" : "failed", editable: false, resolvable: false, retryable: !published, version: current[0].version + 1 });
        current = [made];
        return { announcement: made };
      }
      if (route === "GET social/announcements/attempts") {
        return { attempts: [{ attemptNo: 1, startedAt: "2026-11-01T12:00:00Z", finishedAt: "2026-11-01T12:00:02Z", outcome: "failed", httpStatus: 503, errorCode: "provider-unavailable", errorDetail: "x", providerPostId: null }, { attemptNo: 2, startedAt: "2026-11-01T12:05:00Z", finishedAt: null, outcome: null, httpStatus: null, errorCode: null, errorDetail: null, providerPostId: null }] };
      }
      throw new Error(`unexpected ${route}`);
    },
  };
  return api;
}

const timers = () => ({ setTimeout: (run) => { timers.last = run; return 1; }, clearTimeout: () => {} });

async function open(options) {
  const api = fakeAdmin(options);
  const panel = createAnnouncementsPanel({ api, zone: NY, timers: timers(), random: (() => { let n = 0; return () => `key-${String(++n).padStart(14, "0")}`; })() });
  await panel.load();
  return { api, panel, root: panel.element };
}

const fill = (root, id, value) => {
  const node = all(root, "select, textarea, input").find((item) => item.id.endsWith(`-${id}`));
  node.value = value;
  return node;
};

async function compose(root, { caption = "A new post is live.", when = "2026-11-02T09:30" } = {}) {
  fill(root, "destination", "d-1");
  fill(root, "post", "/posts/hello/");
  fill(root, "caption", caption);
  fill(root, "when", when);
}
const submit = (root) => byData(root, "data-social-composer")[0].dispatch("submit");

test("the screen loads destinations and posts into labelled fields and explains posts it cannot offer", withDom(async () => {
  const { root } = await open();
  const labels = all(root, "label").map(text);
  assert.deepEqual(labels.slice(0, 4), ["Destination", "Post to announce", "Caption", "Date and time (America/New_York)"]);
  for (const control of all(root, "select, textarea, input")) assert.ok(control.id, "every control has an id its label points at");
  const destination = all(root, "select")[0];
  assert.deepEqual(destination.children.map(text), ["Choose where to post", "Mikey Nichols (LinkedIn profile)", "Lantern Page (Facebook Page)"]);
  const options = all(root, "option").filter((node) => node.parentNode.tagName === "OPTGROUP" || node.disabled);
  assert.match(text(options[0]), /Secret draft - Only a published post can be announced\./);
  assert.equal(options[0].disabled, true, "an unavailable post cannot be chosen");
}));

test("with nothing connected the screen says so and offers no destination", withDom(async () => {
  const api = fakeAdmin();
  api.call = ((original) => async (method, path, options) => (path === "social/destinations" ? { destinations: [] } : original(method, path, options)))(api.call);
  const panel = createAnnouncementsPanel({ api, zone: NY, timers: timers() });
  await panel.load();
  assert.match(text(byData(panel.element, "data-social-status")[0]), /No account is connected yet/);
  assert.equal(all(panel.element, "select")[0].disabled, true);
}));

test("a load that fails says so with a way to try again", withDom(async () => {
  const api = fakeAdmin({ fail: { "GET social/posts": { error: new ApiError("Social publishing is not configured", 404, { error: "Social publishing is not configured" }), once: true } } });
  const panel = createAnnouncementsPanel({ api, zone: NY, timers: timers() });
  await panel.load();
  const error = byData(panel.element, "data-social-load-error")[0];
  assert.equal(error.hidden, false);
  assert.match(text(error), /not configured/);
  await button(error, "social-retry").dispatch("click");
  await flush();
  assert.equal(error.hidden, true);
  assert.equal(all(panel.element, "select")[0].children.length, 3);
}));

test("typing a caption shows the count, and too long is said in words beside the field", withDom(async () => {
  const { root } = await open();
  const caption = fill(root, "caption", "hello");
  await caption.dispatch("input");
  assert.equal(text(byData(root, "data-social-count")[0]), "5 of 3000 characters");
  fill(root, "caption", "a".repeat(3005));
  await caption.dispatch("input");
  assert.match(text(byData(root, "data-social-count")[0]), /5 characters too many/);
  assert.equal(caption.getAttribute("aria-invalid"), "true");
  assert.match(text(byData(root, "data-error-for", "caption")[0]), /5 characters too long/);
}));

test("the preview shows the caption, the link and the time in the author's zone", withDom(async () => {
  const { root, api } = await open();
  await compose(root);
  await fill(root, "caption", "A new post is live.").dispatch("input");
  await timers.last();
  await flush();
  const preview = byData(root, "data-social-preview")[0];
  assert.match(text(byData(preview, "data-preview-to")[0]), /To Mikey Nichols \(LinkedIn profile\)/);
  assert.equal(text(byData(preview, "data-preview-caption")[0]), "A new post is live.");
  assert.equal(text(byData(preview, "data-preview-link")[0]), "https://blog.example.org/posts/hello/");
  assert.match(text(byData(preview, "data-preview-when")[0]), /09:30.*2026-11-02 14:30 UTC/);
  const sent = api.calls.find((call) => call.path === "social/preview").json;
  assert.deepEqual(sent, { provider: "linkedin", caption: "A new post is live.", work: "/posts/hello/", scheduledFor: "2026-11-02T14:30:00Z", timeZone: NY });
}));

test("a clock-change time is explained in the preview before anything is sent", withDom(async () => {
  const { root } = await open();
  await compose(root, { when: "2026-11-01T01:30" });
  await fill(root, "when", "2026-11-01T01:30").dispatch("input");
  await timers.last();
  await flush();
  assert.match(text(byData(root, "data-preview-notes")[0]), /happens twice/);
}));

test("submitting an incomplete form lists what to fix, beside the fields, and sends nothing", withDom(async () => {
  const { root, api } = await open();
  await submit(root);
  const box = byData(root, "data-social-problems")[0];
  assert.equal(box.hidden, false);
  assert.match(text(box), /There are 4 things to fix/);
  for (const name of ["destination", "post", "caption", "time"]) {
    assert.equal(byData(root, "data-error-for", name)[0].hidden, false, name);
    assert.equal(all(root, "select, textarea, input").find((item) => item.id.endsWith(name === "time" ? "-when" : `-${name}`)).getAttribute("aria-invalid"), "true");
  }
  assert.equal(api.calls.some((call) => call.method === "POST" && call.path === "social/announcements"), false);
  assert.equal(root.ownerDocument?.activeElement ?? globalThis.document.activeElement, box, "focus moves to the list of problems");
}));

test("a skipped clock time is refused with its own explanation", withDom(async () => {
  const { root, api } = await open();
  await compose(root, { when: "2026-03-08T02:30" });
  await submit(root);
  assert.match(text(byData(root, "data-error-for", "time")[0]), /does not exist in your time zone/);
  assert.equal(api.calls.some((call) => call.path === "social/announcements" && call.method === "POST"), false);
}));

test("a valid submit sends UTC, the zone and a key; then says what happened and clears the form", withDom(async () => {
  const { root, api } = await open();
  await compose(root);
  await submit(root);
  await flush();
  const create = api.calls.find((call) => call.method === "POST" && call.path === "social/announcements");
  assert.deepEqual(create.json, { accountId: "d-1", work: "/posts/hello/", caption: "A new post is live.", scheduledFor: "2026-11-02T14:30:00Z", timeZone: NY, idempotencyKey: "key-00000000000001" });
  assert.match(text(byData(root, "data-social-status")[0]), /^Scheduled for .*Mikey Nichols \(LinkedIn profile\)\.$/);
  assert.equal(all(root, "textarea")[0].value, "", "the form is cleared");
  assert.equal(byData(root, "data-social-problems")[0].hidden, true);
  assert.equal(all(root, "li").filter((node) => node.dataset.announcement).length, 2, "the queue was refreshed");
}));

test("a retry of the same announcement keeps its key, and a changed one gets a new key", withDom(async () => {
  const lost = new TypeError("Failed to fetch");
  const { root, api } = await open({ fail: { "POST social/announcements": { error: lost, once: true } } });
  await compose(root);
  await submit(root);
  await flush();
  assert.match(text(byData(root, "data-social-problems")[0]), /could not be reached/);
  await submit(root);
  await flush();
  const keys = api.calls.filter((call) => call.path === "social/announcements" && call.method === "POST").map((call) => call.json.idempotencyKey);
  assert.deepEqual(keys, ["key-00000000000001", "key-00000000000001"], "the same composed announcement is the same request");

  const second = await open({ fail: { "POST social/announcements": { error: lost, once: true } } });
  await compose(second.root);
  await submit(second.root);
  await flush();
  await compose(second.root, { caption: "Different words." });
  await submit(second.root);
  await flush();
  const different = second.api.calls.filter((call) => call.path === "social/announcements" && call.method === "POST").map((call) => call.json.idempotencyKey);
  assert.notEqual(different[0], different[1]);
}));

test("a create whose outcome is unknown reloads the queue and warns the announcement may exist", withDom(async () => {
  const lost = new TypeError("Failed to fetch");
  const { root, api } = await open({ fail: { "POST social/announcements": { error: lost, once: true } } });
  await compose(root);
  await submit(root);
  await flush();
  const after = api.calls.slice(api.calls.findIndex((call) => call.method === "POST" && call.path === "social/announcements") + 1);
  assert.ok(after.some((call) => call.method === "GET" && call.path.startsWith("social/announcements")), "the queue is reloaded");
  assert.match(text(root), /may already be scheduled/);
}));

test("a refusal from the server appears beside the field it is about", withDom(async () => {
  const refusal = new ApiError("x", 422, { error: "The caption is longer than this destination allows.", code: "caption-too-long" });
  const { root } = await open({ fail: { "POST social/announcements": { error: refusal } } });
  await compose(root);
  await submit(root);
  await flush();
  assert.match(text(byData(root, "data-error-for", "caption")[0]), /longer than this destination allows/);
}));

test("the queue lists each announcement with its status in words, and says why a locked one cannot change", withDom(async () => {
  const { root } = await open({ queue: [row(), row({ id: "a-9", status: "claimed", editable: false }), row({ id: "a-8", status: "failed", editable: false, lastErrorCode: "provider-rejected" })] });
  const rows = all(root, "li").filter((node) => node.dataset.announcement);
  assert.equal(rows.length, 3);
  assert.match(text(byData(rows[0], "data-status-badge")[0]), /Scheduled/);
  assert.ok(button(rows[0], "social-edit") && button(rows[0], "social-cancel"));
  assert.equal(button(rows[1], "social-edit"), undefined, "a claimed announcement has no edit");
  assert.match(text(byData(rows[1], "data-row-locked")[0]), /no longer be changed/);
  assert.match(text(byData(rows[2], "data-row-error")[0]), /provider-rejected/);
  assert.match(button(rows[0], "social-cancel").getAttribute("aria-label"), /Cancel the announcement of \/posts\/hello\//);
}));

test("cancel asks first, keeps by default, and names the version it cancels", withDom(async () => {
  const { root, api } = await open();
  const list = () => all(root, "li").filter((node) => node.dataset.announcement)[0];
  await button(list(), "social-cancel").dispatch("click");
  assert.equal(button(list(), "social-cancel").getAttribute("aria-expanded"), "true");
  await button(list(), "social-keep").dispatch("click");
  assert.equal(api.calls.some((call) => call.path.startsWith("social/announcements/cancel")), false);
  await button(list(), "social-cancel").dispatch("click");
  await button(list(), "social-confirm-cancel").dispatch("click");
  await flush();
  const cancel = api.calls.find((call) => call.path.startsWith("social/announcements/cancel"));
  assert.equal(cancel.path, "social/announcements/cancel?id=a-1");
  assert.deepEqual(cancel.json, { version: 1 });
  assert.equal(text(byData(root, "data-social-status")[0]), "Canceled. It will not be posted.");
  assert.equal(list().dataset.status, "canceled");
}));

test("an edit sends the caption with its version, a time-only change reschedules, and no change is said so", withDom(async () => {
  const { root, api } = await open();
  const rowOf = () => all(root, "li").filter((node) => node.dataset.announcement)[0];
  await button(rowOf(), "social-edit").dispatch("click");
  const panel = () => all(rowOf(), "div").find((node) => node.dataset.mode === "edit");
  await button(panel(), "social-save").dispatch("click");
  assert.match(text(all(panel(), "p").find((node) => node.getAttribute("role") === "alert")), /Nothing has changed/);
  assert.equal(api.calls.some((call) => call.method !== "GET"), false);

  const when = all(panel(), "input")[0];
  when.value = "2099-02-03T10:15";
  await button(panel(), "social-save").dispatch("click");
  await flush();
  const move = api.calls.find((call) => call.path.startsWith("social/announcements/reschedule"));
  assert.deepEqual(move.json, { version: 1, scheduledFor: "2099-02-03T15:15:00Z", timeZone: NY });

  await button(rowOf(), "social-edit").dispatch("click");
  const words = all(panel(), "textarea")[0];
  words.value = "Better words.";
  await button(panel(), "social-save").dispatch("click");
  await flush();
  const edit = api.calls.find((call) => call.method === "PATCH");
  assert.equal(edit.path, "social/announcements?id=a-1");
  assert.deepEqual(edit.json, { version: 2, caption: "Better words." });
}));

test("a lost race refreshes the queue and says the announcement changed", withDom(async () => {
  const stale = new ApiError("x", 409, { error: "This announcement changed or was claimed just now.", code: "conflict" });
  const { root, api } = await open({ fail: { "POST social/announcements/cancel": { error: stale, once: true } } });
  const rowOf = () => all(root, "li").filter((node) => node.dataset.announcement)[0];
  await button(rowOf(), "social-cancel").dispatch("click");
  const before = api.calls.filter((call) => call.method === "GET" && call.path.startsWith("social/announcements")).length;
  await button(rowOf(), "social-confirm-cancel").dispatch("click");
  await flush();
  assert.match(text(byData(root, "data-social-status")[0]), /changed or was claimed just now.*refreshed/);
  assert.equal(api.calls.filter((call) => call.method === "GET" && call.path.startsWith("social/announcements")).length, before + 1);
}));

test("the status filter asks for just that status", withDom(async () => {
  const { root, api } = await open();
  const filter = all(root, "select").find((node) => node.id.endsWith("-filter"));
  filter.value = "published";
  await filter.dispatch("change");
  await flush();
  assert.ok(api.calls.some((call) => call.path === "social/announcements?status=published"));
}));

test("unsaved words count as unsaved work, and a scheduled form does not", withDom(async () => {
  const { root, panel } = await open();
  assert.equal(panel.isDirty(), false);
  fill(root, "caption", "half written");
  assert.equal(panel.isDirty(), true);
}));

// ------------------------------------------------------------------ recovery (ADR 0318)

const failedRow = (over = {}) => row({ id: "a-5", status: "failed", editable: false, retryable: true, version: 4, attemptCount: 3, lastErrorCode: "attempts-exhausted", ...over });
const unknownRow = (over = {}) => row({ id: "a-6", status: "unknown", editable: false, resolvable: true, version: 3, attemptCount: 1, lastErrorCode: "timeout", ...over });
const rowOf = (root) => all(root, "li").filter((node) => node.dataset.announcement)[0];
const listReads = (api) => api.calls.filter((call) => call.method === "GET" && (call.path === "social/announcements" || call.path.startsWith("social/announcements?"))).length;

test("a short code reads as a sentence, and a queue that moved on refreshes", () => {
  assert.match(problemWords("rate-limited"), /slow down/);
  assert.match(problemWords("timeout"), /may or may not have been posted/);
  assert.equal(problemWords("nothing-like-this"), "");
  for (const code of ["stale", "conflict", "not-editable", "not-retryable", "not-resolvable", "needs-resolution"]) assert.ok(REFRESH_CODES.includes(code), code);
  assert.match(errorText(new ApiError("x", 409, { error: "Check first.", code: "needs-resolution" })), /refreshed/);
});

test("a failed announcement says why in words and offers to try again, after asking", withDom(async () => {
  const { root, api } = await open({ queue: [failedRow()] });
  assert.match(text(byData(root, "data-row-error")[0]), /allowed number of times.*attempts-exhausted/);
  const retry = button(root, "social-retry");
  assert.match(retry.getAttribute("aria-label"), /Try again: the announcement of \/posts\/hello\//);
  assert.equal(retry.getAttribute("aria-expanded"), "false");
  await retry.dispatch("click");
  assert.equal(retry.getAttribute("aria-expanded"), "true");
  assert.equal(api.calls.some((call) => call.method === "POST"), false, "asking sends nothing");
  await button(root, "social-keep").dispatch("click");
  assert.equal(api.calls.some((call) => call.method === "POST"), false);
  await button(root, "social-retry").dispatch("click");
  await button(root, "social-confirm-retry").dispatch("click");
  await flush();
  const sent = api.calls.find((call) => call.path.startsWith("social/announcements/retry"));
  assert.equal(sent.path, "social/announcements/retry?id=a-5");
  assert.deepEqual(sent.json, { version: 4 });
  assert.match(text(byData(root, "data-social-status")[0]), /Back in the queue/);
  assert.equal(rowOf(root).dataset.status, "scheduled");
}));

test("an unknown result asks the author to look first, and records what they found", withDom(async () => {
  const { root, api } = await open({ queue: [unknownRow()] });
  assert.match(text(byData(root, "data-row-error")[0]), /may or may not have been posted/);
  assert.equal(button(root, "social-retry"), undefined, "an unknown outcome cannot simply be retried");
  await button(root, "social-resolve").dispatch("click");
  const panel = () => all(rowOf(root), "div").find((node) => node.dataset.mode === "resolve");
  assert.match(text(panel()), /It will not be sent again until you do/);
  assert.deepEqual(all(panel(), "label").map(text), ["It was posted", "It was not posted", "Post id (only if it was posted)"]);
  for (const control of all(panel(), "input")) assert.ok(control.id);
  const alertText = () => text(all(panel(), "p").find((node) => node.getAttribute("role") === "alert"));

  await button(panel(), "social-confirm-resolve").dispatch("click");
  assert.match(alertText(), /Choose what you found/);
  const [posted, , postId] = all(panel(), "input");
  posted.checked = true;
  await button(panel(), "social-confirm-resolve").dispatch("click");
  assert.match(alertText(), /Enter the post id/);
  postId.value = "has a space";
  await button(panel(), "social-confirm-resolve").dispatch("click");
  assert.match(alertText(), /no spaces/);
  assert.equal(api.calls.some((call) => call.method === "POST"), false, "nothing invalid was sent");

  postId.value = "urn:li:share:7000";
  await button(panel(), "social-confirm-resolve").dispatch("click");
  await flush();
  const sent = api.calls.find((call) => call.path.startsWith("social/announcements/resolve"));
  assert.equal(sent.path, "social/announcements/resolve?id=a-6");
  assert.deepEqual(sent.json, { version: 3, outcome: "published", providerPostId: "urn:li:share:7000" });
  assert.equal(text(byData(root, "data-social-status")[0]), "Recorded as posted.");
  assert.equal(rowOf(root).dataset.status, "published");
}));

test("recording that it was not posted sends no id and offers a retry afterwards", withDom(async () => {
  const { root, api } = await open({ queue: [unknownRow()] });
  await button(root, "social-resolve").dispatch("click");
  const panel = () => all(rowOf(root), "div").find((node) => node.dataset.mode === "resolve");
  const [, missing, postId] = all(panel(), "input");
  postId.value = "ignored-when-not-posted";
  missing.checked = true;
  await button(panel(), "social-confirm-resolve").dispatch("click");
  await flush();
  const sent = api.calls.find((call) => call.path.startsWith("social/announcements/resolve"));
  assert.deepEqual(sent.json, { version: 3, outcome: "not-posted" });
  assert.match(text(byData(root, "data-social-status")[0]), /not posted.*try it again/);
  assert.ok(button(root, "social-retry"), "a failed announcement can now be retried");
}));

test("a refusal that the queue moved on refreshes the list and says so", withDom(async () => {
  const moved = new ApiError("x", 409, { error: "This may already be posted. Check the account, then say whether it was posted.", code: "needs-resolution" });
  const { root, api } = await open({ queue: [failedRow()], fail: { "POST social/announcements/retry": { error: moved, once: true } } });
  await button(root, "social-retry").dispatch("click");
  const before = listReads(api);
  await button(root, "social-confirm-retry").dispatch("click");
  await flush();
  assert.match(text(byData(root, "data-social-status")[0]), /refreshed/);
  assert.equal(listReads(api), before + 1);
}));

test("the history of tries loads when asked and reads in words", withDom(async () => {
  const { root, api } = await open({ queue: [failedRow()] });
  const details = byData(root, "data-history")[0];
  assert.match(text(all(details, "summary")[0]), /What was tried \(3\)/);
  assert.equal(api.calls.some((call) => call.path.startsWith("social/announcements/attempts")), false, "not loaded until opened");
  details.open = true;
  await details.dispatch("toggle");
  await flush();
  const items = all(details, "li");
  assert.equal(items.length, 2);
  assert.match(text(items[0]), /Try 1,.*not posted \(HTTP 503\)\. The provider could not take it just now\./);
  assert.match(text(items[1]), /Try 2,.*in progress/);
  assert.equal(api.calls.filter((call) => call.path.startsWith("social/announcements/attempts")).length, 1);
  assert.equal(api.calls.find((call) => call.path.startsWith("social/announcements/attempts")).path, "social/announcements/attempts?id=a-5");
}));

test("a scheduled announcement waiting to try again says when", withDom(async () => {
  const { root } = await open({ queue: [row({ attemptCount: 1, nextAttemptAt: "2099-01-01T15:05:00Z", lastErrorCode: "provider-unavailable" })] });
  assert.match(text(byData(root, "data-row-next")[0]), /Will try again/);
  assert.match(text(byData(root, "data-row-error")[0]), /could not take it just now/);
}));
