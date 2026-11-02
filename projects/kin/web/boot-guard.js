// Start-up guard (#594): loads Kin again when its module graph didn't load.
//
// Kin starts from one module script (components/kin-app.js) that imports
// about 240 modules, all answered by the service worker from its cache. On
// Edge for Windows a page load sometimes has every module request still in
// flight at one instant cancelled by the browser (net::ERR_ABORTED, no
// response, no navigation, ~100 ms after the page commits). A module graph
// with one failed fetch never runs, and the browser reports it only as an
// `error` event on the <script> element: no console error, nothing pending,
// a page that says "Skip to content" and nothing else, for good.
//
// This classic, deferred script runs just before that module script and
// watches for exactly that event. A failed graph is loaded again, at most
// twice per tab in a row; after that, a short message offers to try again.
// Exceptions thrown while Kin's modules run are not load failures (they are
// reported on the window, not the element) and never cause a reload.
//
// Edge also sometimes stops part way with no `error` event at all: a dozen
// module requests never finish, the page stays "interactive", `load` never
// fires and kin-app is never defined. So the guard also watches for a start
// that has stopped moving: once nothing has finished loading for STALL_MS
// (the clock starts again with each finished request and at `load`) while
// kin-app is still undefined, it takes the same capped reload. A slow start
// keeps finishing requests, so it is left alone; an exception thrown while
// Kin's modules run is a bug, not a stall, and doesn't reload either. Only a
// finished request counts, so on a very slow link one large module can pass
// the clock while it is still arriving: each reload in a row waits longer
// (STALL_MS), so the next load, with a warm cache, has time to finish.
//
// Refresh-resume (#351) unlocks only a load the browser calls a refresh.
// This guard's own reload is one, so when the failed load was not a refresh
// (a new tab, a link, a shortcut) the one-use resume ticket the previous
// page left is deleted first: that load stays locked, as it would have been.
"use strict";
(function installBootGuard(win) {
  if (!win || !win.document || win.kinBootGuard) return;
  var RETRY_KEY = "kin.boot-retry";
  var TICKET_KEY = "kin.reload-resume";
  var MAX_RETRIES = 2;
  // How long nothing may finish, by how many reloads in a row came before.
  var STALL_MS = [8000, 20000, 45000];
  var doc = win.document;
  var stallTimer = null;
  var threw = false;
  var started = false;
  var stallMs = STALL_MS[0];

  function session() {
    try { return win.sessionStorage || null; } catch (error) { return null; }
  }
  function retries(storage) {
    try {
      var count = Number(storage.getItem(RETRY_KEY));
      return Number.isInteger(count) && count > 0 ? count : 0;
    } catch (error) { return null; }
  }
  function navigationType() {
    try {
      var entry = win.performance.getEntriesByType("navigation")[0];
      return entry ? entry.type : null;
    } catch (error) { return null; }
  }
  function isEntryScript(target) {
    return Boolean(target) && target.tagName === "SCRIPT" && target.type === "module" &&
      /\/components\/kin-app\.js(?:$|[?#])/.test(String(target.src || ""));
  }
  function explain() {
    if (!doc.body || doc.querySelector("[data-kin-boot-failed]")) return;
    var box = doc.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("data-kin-boot-failed", "");
    box.className = "boot-failed";
    var text = doc.createElement("p");
    text.textContent = "Kin didn't finish loading.";
    var button = doc.createElement("button");
    button.type = "button";
    button.textContent = "Try again";
    button.addEventListener("click", function () {
      var storage = session();
      try { if (storage) storage.removeItem(RETRY_KEY); } catch (error) { /* reload anyway */ }
      win.location.reload();
    });
    box.appendChild(text);
    box.appendChild(button);
    doc.body.appendChild(box);
  }
  function onFailedStart() {
    var storage = session();
    var count = storage ? retries(storage) : null;
    // Without a counter a reload could repeat for ever: explain instead.
    if (count === null || count >= MAX_RETRIES) return explain();
    try {
      storage.setItem(RETRY_KEY, String(count + 1));
      if (navigationType() !== "reload") storage.removeItem(TICKET_KEY);
    } catch (error) { return explain(); }
    win.location.reload();
  }

  function defined() {
    try { return Boolean(win.customElements.get("kin-app")); } catch (error) { return true; }
  }
  function stopWatching() {
    if (stallTimer !== null) win.clearTimeout(stallTimer);
    stallTimer = null;
  }
  // Starts the stall clock again; it runs out only if nothing moves.
  function watch() {
    if (started || threw) return;
    stopWatching();
    stallTimer = win.setTimeout(guard.onStall, stallMs);
  }

  var guard = {
    // An `error` event doesn't bubble, but the window sees it while capturing.
    onError: function (event) {
      if (isEntryScript(event && event.target)) return onFailedStart();
      // An exception reaches the window as an error event aimed at it.
      if (event && event.target === win) { threw = true; stopWatching(); }
    },
    onStall: function () {
      stallTimer = null;
      if (started || threw || defined()) return;
      onFailedStart();
    },
  };
  win.kinBootGuard = guard;
  var previous = session();
  var reloaded = previous ? retries(previous) : null;
  if (reloaded) stallMs = STALL_MS[Math.min(reloaded, STALL_MS.length - 1)];
  win.addEventListener("error", guard.onError, true);
  win.addEventListener("load", watch);
  // Each request that finishes is progress: a slow start isn't a stalled one.
  var progress = null;
  try {
    if (typeof win.PerformanceObserver === "function") {
      progress = new win.PerformanceObserver(watch);
      progress.observe({ type: "resource" });
    }
  } catch (error) { progress = null; /* the clock then runs from here and from load */ }
  watch();
  // Kin started: stop watching, and the next failure starts counting again.
  try {
    win.customElements.whenDefined("kin-app").then(function () {
      started = true;
      stopWatching();
      try { if (progress) progress.disconnect(); } catch (error) { /* nothing to stop */ }
      var storage = session();
      try { if (storage) storage.removeItem(RETRY_KEY); } catch (error) { /* nothing to clear */ }
      // A slow start can pass the stall clock at the cap and show the message,
      // then finish: a working Kin doesn't keep saying it didn't load.
      var box = doc.querySelector("[data-kin-boot-failed]");
      if (box && box.parentNode) box.parentNode.removeChild(box);
    });
  } catch (error) { /* no custom elements: Kin can't start here anyway */ }
})(typeof window === "undefined" ? null : window);
