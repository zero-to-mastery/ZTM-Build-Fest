// Outside calendars (#665, #667, #668, ADR 0022 §3) in the real app, against
// the real calendar service and fetcher.
//
// `calendarSyncHarness()` runs in Node beside the regression's static server:
// a CalendarSyncService for one fixed Adult (the static server has no
// sessions), whose fetcher reaches a fake HTTPS calendar server on 127.0.0.1
// through the fetcher's test hooks (its own DNS answer for feed.test, its
// test certificate authority, its port). Only this harness constructs that
// fetcher; the Kin service never does. Nothing touches the real internet.
//
// `calendarSyncRegressions()` runs in the page (serialized with toString).
// The test household doesn't sync, so Identity & appearance first says so;
// then the page starts the controller the way unlock does for a household
// that syncs. It checks a bad link is caught before anything is sent, the
// exact warning before turning sync on, adding "Everyone in the household",
// the read-only "From …" occurrences handed to the views, the sealed
// device cache (no titles in the clear), a link the calendar's server
// refuses, locking clearing memory and unlocking showing the kept copy,
// turning the calendar off removing it everywhere, and no sideways scroll
// at 320 px.
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { CalendarFetcher } from "../server/calendar-fetcher.mjs";
import { CalendarSyncService } from "../server/calendar-sync-service.mjs";
import { PairingError } from "../server/pairing-service.mjs";

const fixture = (name) => readFileSync(new URL(`../server/test-fixtures/${name}`, import.meta.url));
export const CALENDAR_HARNESS_HOUSEHOLD = "c".repeat(32);

/** Today's civil date as YYYYMMDD, local time (the browser's too). */
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
};

/** A weekly event from today and an all-day one tomorrow. */
function workCalendar() {
  const start = today();
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kin regression//EN", "X-WR-CALNAME:Swim club",
    "BEGIN:VEVENT", "UID:swim@regression.test", `DTSTART;TZID=Europe/London:${start}T170000`, `DTEND;TZID=Europe/London:${start}T180000`,
    "SUMMARY:Swim practice", "LOCATION:Leisure centre", "RRULE:FREQ=WEEKLY;COUNT=20", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
}

export async function calendarSyncHarness() {
  const cert = fixture("calendar-feed-test.crt");
  const feeds = createHttpsServer({ cert, key: fixture("calendar-feed-test.key") }, (request, response) => {
    if (new URL(request.url, "https://feed.test").pathname === "/swim.ics") {
      response.writeHead(200, { "Content-Type": "text/calendar", ETag: '"swim-1"' });
      response.end(workCalendar());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => feeds.listen(0, "127.0.0.1", resolve));
  const fetcher = new CalendarFetcher({
    resolve: async (host) => {
      if (host !== "feed.test") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return [{ address: "127.0.0.1", family: 4 }];
    },
    unsafeTestHooks: { allowLoopback: true, ca: cert, connectPort: feeds.address().port },
  });
  const service = new CalendarSyncService({ fetcher });
  const auth = {
    household: { id: CALENDAR_HARNESS_HOUSEHOLD },
    member: { id: "d".repeat(32), householdId: CALENDAR_HARNESS_HOUSEHOLD, kind: "adult", active: true, householdAdmin: true },
    device: { id: "e".repeat(32) },
  };
  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const readJson = (request) => new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { resolve({}); } });
  });
  return {
    service,
    /** Answers a /api/calendar/ request as server/server.mjs does; false
     * for any other path. */
    async handle(request, response) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/api/calendar/")) return false;
      try {
        const feed = /^\/api\/calendar\/subscriptions\/([a-f0-9]{32})\/feed$/.exec(url.pathname);
        const one = /^\/api\/calendar\/subscriptions\/([a-f0-9]{32})$/.exec(url.pathname);
        if (url.pathname === "/api/calendar/subscriptions" && request.method === "GET") json(response, 200, service.list(auth));
        else if (url.pathname === "/api/calendar/subscriptions" && request.method === "POST") json(response, 201, { subscription: await service.add(auth, await readJson(request)) });
        else if (one && request.method === "DELETE") json(response, 200, service.remove(auth, one[1]));
        else if (feed && request.method === "GET") {
          const result = await service.feed(auth, feed[1], { ifNoneMatch: request.headers["if-none-match"] ?? null });
          const headers = { "Cache-Control": "no-store", "X-Kin-Calendar-Fetched-At": String(result.fetchedAt), ...(result.etag ? { ETag: result.etag } : {}) };
          if (result.notModified) { response.writeHead(304, headers); response.end(); }
          else { response.writeHead(200, { ...headers, "Content-Type": "text/calendar; charset=utf-8" }); response.end(result.body); }
        } else json(response, 404, { error: "not_found", message: "Not found." });
      } catch (error) {
        if (error instanceof PairingError) json(response, error.status, { error: error.code, message: error.message });
        else json(response, 500, { error: "server_error", message: "Kin could not complete that request." });
      }
      return true;
    },
    close: () => new Promise((resolve) => { feeds.closeAllConnections?.(); feeds.close(resolve); }),
  };
}

/** Whether a console entry is the browser noting a refused calendar request
 * this regression makes on purpose (a 4xx answer logs an error). */
export function expectedCalendarRefusal(entry) {
  return entry?.source === "network" && typeof entry.url === "string" && new URL(entry.url).pathname.startsWith("/api/calendar/") &&
    /status of 4\d\d/.test(entry.text ?? "");
}

export async function calendarSyncRegressions(householdId) {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (await test()) return; await frame(); }
    check(false, `Timed out: ${message}`, typeof detail === "function" ? detail() : detail);
  };
  const visible = (node) => Boolean(node) && node.isConnected && node.getClientRects().length > 0;
  const { externalOccurrences } = await import("/calendar/external.js");
  const { FEED_WARNING } = await import("/calendar/feed-link.js");
  const sync = app.ctx.calendarSync;
  const section = () => app.calendarSubscriptions;
  const civil = (date) => date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  const todayDate = civil(new Date());
  const inAMonth = civil(new Date(Date.now() + 31 * 86_400_000));
  const swims = () => externalOccurrences(todayDate, inAMonth).filter((occurrence) => occurrence.title === "Swim practice");
  const requests = [];
  const realFetch = window.fetch;
  window.fetch = (input, init) => { requests.push(`${init?.method ?? "GET"} ${new URL(String(input?.url ?? input), location.href).pathname}`); return realFetch(input, init); };
  try {
    // A household that doesn't sync: the section says why there's nothing.
    app.ctx.navigation.navigate("#household/appearance");
    await until(() => visible(section()), "Identity & appearance shows Outside calendars");
    check(section().querySelector("h2").textContent === "Outside calendars", "the section is named");
    check(/Connect this household to a Kin server/.test(section().querySelector(".calendar-sync-state").textContent), "it says calendars need a Kin server", section().textContent);
    check(!visible(section().querySelector("form")), "no form without a server");

    // As unlock does for a household that syncs.
    await sync.start({ householdId });
    const form = section().querySelector("form");
    await until(() => visible(form), "the form shows for an Adult");
    check(visible(section().querySelector(".calendar-subscription-empty")), "no calendars yet");
    const input = form.querySelector('input[type="url"]');
    check(document.querySelector(`label[for="${input.id}"]`)?.textContent === "Private calendar link", "the link field is labelled");
    check(input.getAttribute("aria-describedby").split(" ").every((id) => document.getElementById(id)), "and described");
    const radios = [...form.querySelectorAll('input[type="radio"]')];
    check(radios.map((radio) => radio.closest("label").textContent).join("|") === "Just me|Everyone in the household" && radios[0].checked, "Just me or everyone; Just me first");

    // A link that can't be synced is caught here, before anything is sent.
    requests.length = 0;
    input.value = "http://calendar.example/work.ics";
    form.querySelector(".calendar-subscription-continue").click();
    const error = form.querySelector(".calendar-subscription-error");
    check(visible(error) && /https:\/\/ or webcal:\/\//.test(error.textContent), "an http link is refused with a reason", error.textContent);
    check(input.getAttribute("aria-invalid") === "true" && document.activeElement === input, "the field is marked and focused");
    check(requests.length === 0, "nothing was sent", requests);

    // The warning, then turning it on for everyone.
    input.value = "webcal://feed.test/swim.ics";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    check(!visible(error) && !input.hasAttribute("aria-invalid"), "typing clears the error");
    radios[1].checked = true;
    form.querySelector(".calendar-subscription-continue").click();
    const confirm = form.querySelector(".calendar-subscription-confirm");
    check(visible(confirm), "the warning shows before anything is sent");
    check(confirm.querySelector(".calendar-subscription-warning").textContent === FEED_WARNING &&
      FEED_WARNING === "Your Kin server will download this calendar about every 30 minutes and can read it while it does.", "in the ADR's words");
    check(/Everyone in your household will see/.test(confirm.textContent), "it says who will see it");
    check(document.activeElement === confirm.querySelector("h4"), "focus moves to the warning");
    check(requests.length === 0, "still nothing sent", requests);
    confirm.querySelector(".calendar-subscription-turn-on").click();
    const item = () => section().querySelector(".calendar-subscription");
    await until(() => item() && swims().length > 0, "the calendar is on and its events reach the views", () => section().textContent);
    check(requests.includes("POST /api/calendar/subscriptions") && requests.some((entry) => /^GET \/api\/calendar\/subscriptions\/[a-f0-9]{32}\/feed$/.test(entry)), "added, then fetched through the service", requests);
    const feedback = section().querySelector(".calendar-subscription-feedback");
    check(feedback.getAttribute("role") === "status" && /calendar is on/.test(feedback.textContent), "the result is announced", feedback.textContent);
    check(item().querySelector(".calendar-subscription-name").textContent === "Swim club (feed.test)", "named by the calendar and its source", item().textContent);
    check(item().querySelector(".calendar-subscription-who").textContent === "Everyone in the household · Added by you", "who sees it", item().textContent);
    check(/^Updated just now\. Next: Swim practice, /.test(item().querySelector(".calendar-subscription-status").textContent), "when, and what's next", item().textContent);
    check(input.value === "" && !visible(confirm), "the form is ready for another");
    const occurrence = swims()[0];
    check(occurrence.readOnly === true && occurrence.label === "From feed.test" && occurrence.start.date === todayDate && occurrence.start.minute === 17 * 60 &&
      occurrence.zone === "Europe/London" && occurrence.place === "Leisure centre", "read-only, labelled, in the event's own zone", occurrence);
    check(swims().length >= 4 && swims().length <= 5, "weekly, over the next month", swims().length);
    check(app.state && !JSON.stringify(app.state).includes("Swim practice"), "nothing entered the household history");

    // The device's copy is sealed: no title in the clear.
    const rows = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`kin-calendar-feeds:${householdId}`);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction(["feeds"], "readonly").objectStore("feeds").getAll();
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => reject(read.error);
      };
    });
    check(rows.length === 1 && Object.keys(rows[0]).sort().join() === "sealed,subscriptionId", "one sealed row", rows.map((row) => Object.keys(row)));
    check(!JSON.stringify(rows).includes("Swim"), "no titles in the clear");

    // A link the calendar's server doesn't know: a clear error, nothing added.
    input.value = "https://feed.test/missing.ics";
    form.querySelector(".calendar-subscription-continue").click();
    form.querySelector(".calendar-subscription-turn-on").click();
    await until(() => visible(error) && !section().hasAttribute("aria-busy"), "the refusal shows");
    check(/no longer exists/.test(error.textContent), "the service's reason, in plain words", error.textContent);
    check(section().querySelectorAll(".calendar-subscription").length === 1, "nothing was added");

    // Lock clears memory; unlock shows the kept copy again.
    sync.stop();
    check(swims().length === 0, "locking clears the synced events from memory");
    await sync.start({ householdId });
    await until(() => swims().length > 0 && item(), "unlocking shows the calendar again");

    // Turning it off: asked first, then gone from the views and the device.
    item().querySelector(".calendar-subscription-remove").click();
    await until(() => item()?.querySelector(".calendar-subscription-remove-ask"), "it asks first");
    check(/for everyone in the household/.test(item().querySelector(".calendar-subscription-remove-ask").textContent), "and says for whom");
    await frame();
    check(document.activeElement === item().querySelector(".calendar-subscription-remove-confirm"), "focus is on Turn off");
    item().querySelector(".calendar-subscription-remove-confirm").click();
    await until(() => !item() && swims().length === 0, "it is off");
    check(/is off/.test(feedback.textContent), "and says so", feedback.textContent);
    const left = await new Promise((resolve) => {
      const request = indexedDB.open(`kin-calendar-feeds:${householdId}`);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction(["feeds"], "readonly").objectStore("feeds").count();
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
    check(left === 0, "the device's copy is gone", left);
    check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");
  } finally {
    window.fetch = realFetch;
    // Back to a household that doesn't sync.
    sync.start(null);
    app.ctx.navigation.navigate("#today");
  }
  return "PASS calendar sync: a bad link is caught first, the ADR's warning before turning on, an Adult syncs a calendar for everyone through the service, read-only labelled occurrences reach the views, the device keeps it sealed, a refused link says why, lock clears memory, turning it off removes it everywhere (#665, #667, #668)";
}
