// Issue #164: a new tab is used only once it has loaded Kin's origin.
import assert from "node:assert/strict";
import test from "node:test";
import { createLoadTrace, waitForKinStart, waitForOrigin } from "./cdp-page.mjs";

test("waitForOrigin waits through about:blank and a lost context until the page has loaded", async () => {
  const answers = [false, new Error("Execution context was destroyed."), false, true];
  let calls = 0;
  await waitForOrigin(async (expression) => {
    if (expression.startsWith("`")) return "about:blank (complete)";
    const next = answers[Math.min(calls++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }, "http://127.0.0.1:1");
  assert.equal(calls, 4);
});

test("waitForOrigin fails clearly instead of carrying on with the wrong page", async () => {
  await assert.rejects(
    waitForOrigin(async (expression) => expression.startsWith("`") ? "about:blank (complete)" : false, "http://127.0.0.1:1", { timeoutMs: 120 }),
    /did not finish loading http:\/\/127\.0\.0\.1:1 within 120 ms; last seen: about:blank \(complete\)/);
});

test("waitForOrigin re-navigates a tab stuck on about:blank", async () => {
  let navigated = 0;
  await waitForOrigin(async (expression) => {
    if (expression.startsWith("`")) return navigated ? "http://127.0.0.1:1/ (interactive)" : "about:blank (complete)";
    return navigated > 0;
  }, "http://127.0.0.1:1", { renavigateAfterMs: 60, navigate: async () => { navigated += 1; } });
  assert.equal(navigated, 1);
});

// #469: the start-up guard can reload a stalled start after the page is
// "interactive"; the wait asks again until the reloaded page defines kin-app.
test("waitForKinStart waits through a start-up guard reload until kin-app is defined", async () => {
  const answers = [false, new Error('{"code":-32000,"message":"Execution context was destroyed."}'), false, true];
  const asked = [];
  await waitForKinStart(async (expression) => {
    if (expression.startsWith("`")) return "http://127.0.0.1:1/ (interactive)";
    asked.push(expression);
    const next = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }, "http://127.0.0.1:1");
  assert.equal(asked.length, 4);
  assert.match(asked[0], /document\.readyState !== "loading" && \(Boolean\(customElements\.get\("kin-app"\)\)\)$/);
});

// The guard reloads only after its stall clock (8 s or more), well past the
// re-navigate window: a lost context then is that reload, not a stuck tab.
test("waitForKinStart doesn't navigate again during the start-up guard's reload", async () => {
  const started = Date.now();
  let lost = 0;
  let navigated = 0;
  await waitForKinStart(async (expression) => {
    const elapsed = Date.now() - started;
    if (expression.startsWith("`")) return "http://127.0.0.1:1/ (interactive)";
    if (elapsed < 150) return false;
    if (lost < 3) { lost += 1; throw new Error(lost === 1 ? "Execution context was destroyed." : "Cannot find context with specified id"); }
    return elapsed >= 250;
  }, "http://127.0.0.1:1", { renavigateAfterMs: 60, navigate: async () => { navigated += 1; } });
  assert.equal(lost, 3);
  assert.equal(navigated, 0, "the reload is left to finish");
});

test("waitForKinStart says Kin didn't start when kin-app never appears", async () => {
  await assert.rejects(
    waitForKinStart(async (expression) => expression.startsWith("`") ? "http://127.0.0.1:1/ (interactive)" : false, "http://127.0.0.1:1", { timeoutMs: 120 }),
    /did not finish loading http:\/\/127\.0\.0\.1:1 or start Kin within 120 ms; last seen: http:\/\/127\.0\.0\.1:1\/ \(interactive\)/);
});

// #594: a start that stopped part way says which scripts it still waits for.
test("createLoadTrace counts scripts per load and names open and aborted ones", () => {
  let clock = 1_000;
  const trace = createLoadTrace({ now: () => clock });
  const event = (method, params) => trace.observe({ method, params });
  event("Page.frameNavigated", { frame: { loaderId: "LOAD1", url: "http://127.0.0.1:1/" } });
  for (const [requestId, path] of [["1", "/components/kin-app.js"], ["2", "/a.js"], ["3", "/b.js"]])
    event("Network.requestWillBeSent", { requestId, loaderId: "LOAD1", type: "Script", request: { url: `http://127.0.0.1:1${path}` }, initiator: { type: "script" } });
  event("Network.responseReceived", { requestId: "1", response: { status: 200, fromServiceWorker: true } });
  event("Network.loadingFinished", { requestId: "1" });
  event("Network.loadingFailed", { requestId: "2", type: "Script", errorText: "net::ERR_ABORTED", canceled: true });
  clock += 500;
  const lines = trace.lines();
  assert.equal(lines[0], "scripts per load: LLOAD1 3 sent/1 done (1 by the worker)/1 failed, 500 ms ago");
  assert.equal(lines[1], "scripts not finished: LLOAD1 /b.js 500 ms, response none");
  assert.match(lines[2], /committed {2}LLOAD1 \/ \| -500ms failed Script LLOAD1 net::ERR_ABORTED canceled \/a\.js by script after 0 ms/);
  assert.equal(trace.abortedSummary(), "1 page load(s) lost a module request (/a.js); the start-up guard loads such a page again");
});

test("createLoadTrace has no aborted summary when nothing was cancelled", () => {
  const trace = createLoadTrace();
  trace.observe({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom\n at x" } } } });
  assert.equal(trace.abortedSummary(), "");
  assert.match(trace.lines().at(-1), /exception Error: boom/);
});

test("createLoadTrace can share one aborted map across tabs, for one summary", () => {
  const aborted = new Map();
  for (const [tab, path] of [["TAB1", "/a.js"], ["TAB2", "/b.js"]]) {
    const trace = createLoadTrace({ aborted });
    trace.observe({ method: "Network.requestWillBeSent", params: { requestId: "1", loaderId: tab, type: "Script", request: { url: `http://127.0.0.1:1${path}` } } });
    trace.observe({ method: "Network.loadingFailed", params: { requestId: "1", type: "Script", errorText: "net::ERR_ABORTED", canceled: true } });
  }
  assert.equal(createLoadTrace({ aborted }).abortedSummary(), "2 page load(s) lost a module request (/a.js, /b.js); the start-up guard loads such a page again");
});
