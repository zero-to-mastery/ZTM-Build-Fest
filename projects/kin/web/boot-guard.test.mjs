// The start-up guard (#594): a failed module graph loads the page again, at
// most twice in a row, and a reload it makes never turns a locked start into
// a refresh-resume (#351).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./boot-guard.js", import.meta.url), "utf8");

function page({ navigation = "navigate", stored = {}, storageThrows = false } = {}) {
  const items = new Map(Object.entries(stored));
  const storage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
  const listeners = [];
  const appended = [];
  // A clock the test moves by hand, and the guard's view of finished requests.
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  let observed = null;
  let defined;
  let isDefined = false;
  const element = (tagName) => ({
    tagName: tagName.toUpperCase(), children: [], attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  });
  const body = {
    appendChild(child) { child.parentNode = body; appended.push(child); },
    removeChild(child) { appended.splice(appended.indexOf(child), 1); child.parentNode = null; },
  };
  const win = {
    reloads: 0,
    location: { reload() { win.reloads += 1; } },
    get sessionStorage() { if (storageThrows) throw new Error("blocked"); return storage; },
    performance: { getEntriesByType: () => [{ type: navigation }] },
    customElements: {
      whenDefined: () => new Promise((resolve) => { defined = resolve; }),
      get: (name) => (name === "kin-app" && isDefined ? class {} : undefined),
    },
    setTimeout(callback, ms) { timers.set(++nextTimer, { callback, at: now + ms }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    PerformanceObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(options) { observed = { options, callback: this.callback, connected: true, observer: this }; }
      disconnect() { observed.connected = false; }
    },
    addEventListener(type, callback, capture) { listeners.push({ type, callback, capture }); },
    document: {
      body,
      createElement: element,
      querySelector: (selector) => (selector === "[data-kin-boot-failed]" ? appended[0] ?? null : null),
    },
  };
  vm.runInNewContext(source, { window: win, Number, String, Boolean });
  const fail = (src = "http://kin.test/components/kin-app.js") => {
    for (const { type, callback } of listeners) if (type === "error") callback({ target: { tagName: "SCRIPT", type: "module", src } });
  };
  // Moves the clock on, running each timer that comes due.
  const wait = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = until;
  };
  const finishRequest = () => { if (observed?.connected) observed.callback({ getEntries: () => [] }, observed.observer); };
  const emit = (type, event) => { for (const listener of listeners) if (listener.type === type) listener.callback(event); };
  return {
    win, items, listeners, appended, fail, wait, finishRequest, emit, timers,
    observed: () => observed,
    define: () => { isDefined = true; },
    start: () => { isDefined = true; defined?.(); },
  };
}

test("the guard listens for errors while capturing, and for load, on the window", () => {
  const { listeners } = page();
  assert.deepEqual(listeners.map(({ type, capture }) => [type, capture]), [["error", true], ["load", undefined]]);
});

// A start that stops part way without an error event (Edge, after #594).
test("a start that stops moving without an error loads the page again", () => {
  const stalled = page();
  stalled.finishRequest();
  stalled.wait(7_999);
  assert.equal(stalled.win.reloads, 0, "not before 8 s without progress");
  stalled.wait(1);
  assert.equal(stalled.win.reloads, 1);
  assert.equal(stalled.items.get("kin.boot-retry"), "1");
  stalled.wait(60_000);
  assert.equal(stalled.win.reloads, 1, "one reload per stalled load");
});

test("a stalled start shares the error path's cap, so it never loops", () => {
  let stored = {};
  let load;
  for (const [expected, stall] of [[1, 8_000], [1, 20_000], [0, 45_000]]) {
    load = page({ navigation: "reload", stored });
    load.wait(stall);
    assert.equal(load.win.reloads, expected);
    stored = Object.fromEntries(load.items);
  }
  assert.equal(stored["kin.boot-retry"], "2");
  assert.equal(load.appended.length, 1, "after two reloads it explains instead");
});

test("a slow start that passes the stall clock at the cap drops the message once Kin starts", async () => {
  // One large module can take longer than the stall clock with nothing else
  // finishing; on the third such load the guard explains, then Kin starts.
  const slow = page({ navigation: "reload", stored: { "kin.boot-retry": "2" } });
  slow.wait(45_000);
  assert.equal(slow.win.reloads, 0);
  assert.equal(slow.appended.length, 1, "at the cap it explains");
  slow.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.appended.length, 0, "a started Kin removes the message");
  assert.equal(slow.items.has("kin.boot-retry"), false);
});

// On a very slow link one large module can be the only open request for
// longer than 8 s; it is still arriving, so each reload waits longer.
test("each stall reload in a row waits longer, so a warm second load has time", () => {
  const second = page({ navigation: "reload", stored: { "kin.boot-retry": "1" } });
  second.finishRequest();
  second.wait(19_999);
  assert.equal(second.win.reloads, 0, "the second load gets 20 s");
  second.wait(1);
  assert.equal(second.win.reloads, 1);
  assert.equal(second.items.get("kin.boot-retry"), "2");

  const third = page({ navigation: "reload", stored: { "kin.boot-retry": "2" } });
  third.wait(44_999);
  assert.equal(third.appended.length, 0, "the third load gets 45 s");
  third.wait(1);
  assert.equal(third.appended.length, 1);
  assert.equal(third.win.reloads, 0);
});

test("a warm second load that finishes its last module after 8 s still starts", async () => {
  const warm = page({ navigation: "reload", stored: { "kin.boot-retry": "1" } });
  warm.wait(15_000);
  warm.finishRequest();
  warm.wait(3_000);
  warm.start();
  await new Promise((resolve) => setImmediate(resolve));
  warm.wait(60_000);
  assert.equal(warm.win.reloads, 0);
  assert.equal(warm.items.has("kin.boot-retry"), false);
});

test("a first load, or one with an unreadable count, keeps the 8 s clock", () => {
  const blocked = page({ storageThrows: true });
  blocked.wait(8_000);
  assert.equal(blocked.appended.length, 1, "no counter: it explains at 8 s");
  const fresh = page({ stored: { "kin.boot-retry": "nonsense" } });
  fresh.wait(8_000);
  assert.equal(fresh.win.reloads, 1);
});

test("a slow start that keeps finishing requests is left alone", async () => {
  const slow = page();
  for (let second = 0; second < 40; second += 1) {
    slow.wait(1_000);
    slow.finishRequest();
  }
  slow.emit("load");
  slow.wait(5_000);
  slow.start();
  await new Promise((resolve) => setImmediate(resolve));
  slow.wait(60_000);
  assert.equal(slow.win.reloads, 0);
  assert.equal(slow.timers.size, 0, "a started Kin stops the clock");
  assert.equal(slow.observed().connected, false, "and stops watching requests");
});

test("the stall clock never reloads a Kin that has defined kin-app", () => {
  // Defined, but the whenDefined callback hasn't run yet when the timer fires.
  const racing = page();
  racing.define();
  racing.wait(8_000);
  assert.equal(racing.win.reloads, 0);
});

test("an exception while Kin's modules run is not a stall", () => {
  const broken = page();
  broken.emit("error", { target: broken.win, message: "Uncaught TypeError" });
  broken.wait(60_000);
  assert.equal(broken.win.reloads, 0);
  assert.equal(broken.appended.length, 0);
});

test("the stall clock starts again at load", () => {
  const loaded = page();
  loaded.wait(6_000);
  loaded.emit("load");
  loaded.wait(7_999);
  assert.equal(loaded.win.reloads, 0);
  loaded.wait(1);
  assert.equal(loaded.win.reloads, 1);
});

test("a failed app module graph loads the page again, twice at most, then explains", () => {
  const first = page();
  first.fail();
  assert.equal(first.win.reloads, 1);
  assert.equal(first.items.get("kin.boot-retry"), "1");

  const second = page({ navigation: "reload", stored: Object.fromEntries(first.items) });
  second.fail();
  assert.equal(second.win.reloads, 1);
  assert.equal(second.items.get("kin.boot-retry"), "2");

  const third = page({ navigation: "reload", stored: Object.fromEntries(second.items) });
  third.fail();
  assert.equal(third.win.reloads, 0, "no third reload in a row");
  assert.equal(third.appended.length, 1);
  assert.equal(third.appended[0].attributes.role, "alert");
  third.fail();
  assert.equal(third.appended.length, 1, "the message is shown once");
  third.appended[0].children[1].listeners.click();
  assert.equal(third.win.reloads, 1, "Try again reloads");
  assert.equal(third.items.has("kin.boot-retry"), false, "and starts counting again");
});

test("a reload after a load that wasn't a refresh drops the resume ticket, so it stays locked", () => {
  const navigated = page({ navigation: "navigate", stored: { "kin.reload-resume": "{}" } });
  navigated.fail();
  assert.equal(navigated.win.reloads, 1);
  assert.equal(navigated.items.has("kin.reload-resume"), false);

  const refreshed = page({ navigation: "reload", stored: { "kin.reload-resume": "{}" } });
  refreshed.fail();
  assert.equal(refreshed.win.reloads, 1);
  assert.equal(refreshed.items.get("kin.reload-resume"), "{}", "a refresh stays a refresh");
});

test("only the app's own module script counts as a failed start", () => {
  const { win, listeners } = page();
  const onError = listeners[0].callback;
  onError({ target: win });
  onError({ target: { tagName: "IMG", src: "http://kin.test/components/kin-app.js" } });
  onError({ target: { tagName: "SCRIPT", type: "module", src: "http://kin.test/other.js" } });
  onError({ target: { tagName: "SCRIPT", type: "", src: "http://kin.test/components/kin-app.js" } });
  assert.equal(win.reloads, 0);
});

test("a started Kin clears the count", async () => {
  const { items, start } = page({ stored: { "kin.boot-retry": "2" } });
  start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(items.has("kin.boot-retry"), false);
});

test("without session storage the guard explains rather than risk reloading for ever", () => {
  const { win, appended, fail } = page({ storageThrows: true });
  fail();
  assert.equal(win.reloads, 0);
  assert.equal(appended.length, 1);
});
