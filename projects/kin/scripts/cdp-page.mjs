// Waits until a freshly opened tab has committed its navigation to Kin's
// origin and finished loading (issue #164). The runners open a tab with
// /json/new?<origin> and used to poll location.origin for about 2 s, then
// carry on regardless. On the Windows runner the navigation sometimes took
// longer, so a check ran on about:blank ("Failed to resolve module specifier
// '/security/local-vault.js'") or lost its context when the navigation
// committed mid-check ("Execution context was destroyed").
//
// `evaluate(expression)` returns the value and may reject while the page
// changes; those rejections are retried until the deadline. `navigate()`,
// when given, is called if the tab is still not on the origin after a few
// seconds: on the Windows runner a /json/new tab sometimes stayed on
// about:blank. "Loaded" means past "loading": a page with a long-lived
// request may never report "complete".
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setMedia } from "./cdp-media.mjs";

export const PAGE_TIMEOUT_MS = 30_000;

export const RENAVIGATE_AFTER_MS = 5_000;

// How long a start may take before the start-up guard gives up on it: its
// three stall clocks (8 s, 20 s and 45 s with nothing finishing) and the
// loads between them.
export const KIN_START_TIMEOUT_MS = 120_000;

// A call that lost its context ran while the page navigated: the tab is on its
// way somewhere (the start-up guard's reload, say), not stuck.
const LOST_CONTEXT = /Execution context was destroyed|Cannot find context/;

export async function waitForOrigin(evaluate, origin, { timeoutMs = PAGE_TIMEOUT_MS, navigate, renavigateAfterMs = RENAVIGATE_AFTER_MS, ready, readyText = "" } = {}) {
  const expression = `location.origin === ${JSON.stringify(origin)} && document.readyState !== "loading"${ready ? ` && (${ready})` : ""}`;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let nextNavigation = started + renavigateAfterMs;
  let last = "no answer";
  for (;;) {
    let navigating = false;
    try {
      if (await evaluate(expression) === true) return;
      last = await evaluate("`${location.href} (${document.readyState})`").catch(() => last);
    } catch (error) {
      last = error?.message ?? String(error);
      navigating = LOST_CONTEXT.test(last);
    }
    // Still not on the origin (a page that is loading it, or navigating, doesn't
    // need help: navigating again would cancel that load's requests).
    if (navigate && !navigating && Date.now() >= nextNavigation && !last.startsWith(origin)) {
      nextNavigation = Date.now() + renavigateAfterMs * 2;
      await navigate().catch(() => {});
    }
    if (Date.now() >= deadline)
      throw new Error(`The browser tab did not finish loading ${origin}${readyText} within ${timeoutMs} ms; last seen: ${last}`);
    await delay(50);
  }
}

// Waits, from Node, until the tab has loaded Kin and defined kin-app (#469).
// The start-up guard (web/boot-guard.js) reloads a start that has stopped,
// which destroys the context of any call still running in the page. A suite
// that waits for Kin inside one long in-page call would fail on that reload
// even when the reloaded page starts; these short calls just ask again. Once
// kin-app is defined the guard has stopped, so later calls are safe.
export function waitForKinStart(evaluate, origin, options = {}) {
  return waitForOrigin(evaluate, origin, { timeoutMs: KIN_START_TIMEOUT_MS, ...options, ready: 'Boolean(customElements.get("kin-app"))', readyText: " or start Kin" });
}

// Browser regressions reload pages and expect the lock screen, so every
// regression tab starts with refresh-resume (#351) off. The check that wants
// it on sets the preference to "on" itself; this only fills an unset value.
export const REGRESSION_DEFAULTS_SCRIPT =
  'try { if (localStorage.getItem("kin.reload-resume-enabled") === null) localStorage.setItem("kin.reload-resume-enabled", "off"); } catch {}';

/** Installs REGRESSION_DEFAULTS_SCRIPT for every later page load in a tab. */
// Every page a regression opened (newest last), so a failure can show what
// each one looked like (#328).
const livePages = [];
const MAX_CAPTURED_PAGES = 6;
const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * Saves, for each page the failing regression still has open, a screenshot
 * and its address, title and text, into KIN_DIAGNOSTICS_DIR (nothing when it
 * isn't set). Called from a regression's outer catch before its browser is
 * closed; never throws, and a page that no longer answers is skipped.
 */
export async function captureFailure(suite, { dir = process.env.KIN_DIAGNOSTICS_DIR } = {}) {
  if (!dir) return [];
  const saved = [];
  try {
    await mkdir(dir, { recursive: true });
    const slug = String(suite).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const pages = livePages.slice(-MAX_CAPTURED_PAGES);
    for (const [index, send] of pages.entries()) {
      const call = (method, params) => Promise.race([
        send(method, params),
        delay(CAPTURE_TIMEOUT_MS).then(() => { throw new Error("no answer"); }),
      ]);
      const base = join(dir, `${slug}-page${index + 1}`);
      try {
        const { result } = await call("Runtime.evaluate", {
          expression: `JSON.stringify({ href: location.href, title: document.title, text: (document.body?.innerText ?? "").slice(0, 20000) }, null, 2)`,
          returnByValue: true,
        });
        await writeFile(`${base}.txt`, result?.value ?? "");
        saved.push(`${base}.txt`);
      } catch { /* that page is gone */ }
      try {
        const { data } = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(`${base}.png`, Buffer.from(data, "base64"));
        saved.push(`${base}.png`);
      } catch { /* that page is gone */ }
    }
  } catch { /* diagnostics must never hide the failure itself */ }
  if (saved.length) console.error(`Saved failure diagnostics: ${saved.join(", ")}`);
  return saved;
}

export async function applyRegressionDefaults(send) {
  livePages.push(send);
  // The Page domain must be on, or the script may not be installed.
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: REGRESSION_DEFAULTS_SCRIPT });
  // The tab may already have loaded Kin before the script existed.
  await send("Runtime.evaluate", { expression: REGRESSION_DEFAULTS_SCRIPT }).catch(() => {});
  // Light with forced colours off, whatever the machine's appearance (#795).
  await setMedia({ send });
}

/**
 * A tab's load trace (#594), which every browser suite prints: the
 * recent navigations, document loads, service worker states, failed requests
 * and uncaught exceptions, in order, with how many scripts each document load
 * sent, finished and lost, and which loads lost a module request. Pass every
 * CDP event to observe(). It sees a load only if the Page, Network and
 * Runtime domains (and ServiceWorker, for worker states) are on before the
 * tab navigates to Kin. Tabs that pass one `aborted` map share it, so one
 * summary can cover them all.
 */
export function createLoadTrace({ now = Date.now, aborted = new Map() } = {}) {
  const timeline = [];
  const loaders = new Map();
  const inFlight = new Map();
  // Document loads that lost a module request, by load (in `aborted`): the
  // start-up guard (web/boot-guard.js) should have loaded each again.
  let workerStates = "";
  const short = (value) => String(value ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 70);
  const tag = (loaderId) => (loaderId ? String(loaderId).slice(-5) : "-");
  const mark = (text) => {
    timeline.push({ at: now(), text });
    if (timeline.length > 60) timeline.shift();
  };
  const loader = (loaderId) => {
    if (!loaders.has(loaderId)) loaders.set(loaderId, { scripts: 0, done: 0, fromWorker: 0, failed: 0, at: now() });
    if (loaders.size > 6) loaders.delete(loaders.keys().next().value);
    return loaders.get(loaderId);
  };
  function observe(message) {
    const params = message?.params ?? {};
    switch (message?.method) {
      case "Page.frameRequestedNavigation": mark(`requested ${params.reason}/${params.disposition} ${short(params.url)}`); break;
      case "Page.frameStartedNavigating": mark(`starting ${params.navigationType} L${tag(params.loaderId)} ${short(params.url)}`); break;
      case "Page.frameNavigated": if (!params.frame?.parentId) mark(`committed ${params.type ?? ""} L${tag(params.frame?.loaderId)} ${short(params.frame?.url)}`); break;
      case "Page.frameStartedLoading": mark("loading"); break;
      case "Page.frameStoppedLoading": mark("stopped loading"); break;
      case "Page.domContentEventFired": mark("DOMContentLoaded"); break;
      case "Page.loadEventFired": mark("load"); break;
      case "Inspector.targetCrashed": mark("renderer crashed"); break;
      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails ?? {};
        mark(`exception ${String(details.exception?.description ?? details.text ?? "").split("\n")[0].slice(0, 120)} ${short(details.url)}`);
        break;
      }
      case "ServiceWorker.workerVersionUpdated": {
        const states = (params.versions ?? []).map((version) => `v${version.versionId}:${version.runningStatus}/${version.status}${version.controlledClients?.length ? `(${version.controlledClients.length})` : ""}`).join(" ");
        if (states !== workerStates) mark(`worker ${(workerStates = states)}`);
        break;
      }
      case "Network.requestWillBeSent": {
        const initiator = params.initiator;
        inFlight.set(params.requestId, { url: params.request?.url, type: params.type ?? null, at: now(), loaderId: params.loaderId,
          initiator: `${initiator?.type ?? "?"}${initiator?.url ? ` ${short(initiator.url)}` : ""}` });
        if (params.type === "Document") mark(`document request L${tag(params.loaderId)} ${short(params.request?.url)}`);
        if (params.type === "Script") loader(params.loaderId).scripts += 1;
        break;
      }
      case "Network.responseReceived": {
        const request = inFlight.get(params.requestId);
        if (request) Object.assign(request, { status: params.response?.status, sw: Boolean(params.response?.fromServiceWorker) });
        break;
      }
      case "Network.loadingFailed": {
        const request = inFlight.get(params.requestId);
        inFlight.delete(params.requestId);
        if (request?.type === "Script") {
          loader(request.loaderId).failed += 1;
          if (params.canceled) aborted.set(request.loaderId, short(request.url));
        }
        mark(`failed ${params.type ?? request?.type} L${tag(request?.loaderId)} ${params.errorText}${params.canceled ? " canceled" : ""}${params.blockedReason ? ` blocked:${params.blockedReason}` : ""} ${short(request?.url)} by ${request?.initiator ?? "?"} after ${request ? now() - request.at : "?"} ms, response ${request?.status ?? "none"}${request?.sw ? " from worker" : ""}`);
        break;
      }
      case "Network.loadingFinished": {
        const request = inFlight.get(params.requestId);
        inFlight.delete(params.requestId);
        if (request?.type === "Script") {
          loader(request.loaderId).done += 1;
          if (request.sw) loader(request.loaderId).fromWorker += 1;
        }
        break;
      }
    }
  }
  // The trace as short lines (ms before now), each fit for one CI annotation
  // line: script counts per document load, the oldest scripts still open,
  // then the timeline.
  function lines() {
    const at = now();
    const out = [`scripts per load: ${[...loaders].map(([id, counts]) => `L${tag(id)} ${counts.scripts} sent/${counts.done} done (${counts.fromWorker} by the worker)/${counts.failed} failed, ${at - counts.at} ms ago`).join("; ")}`];
    const open = [...inFlight.values()].filter((request) => request.type === "Script").sort((a, b) => a.at - b.at).slice(0, 6);
    if (open.length) out.push(`scripts not finished: ${open.map((request) => `L${tag(request.loaderId)} ${short(request.url)} ${at - request.at} ms, response ${request.status ?? "none"}${request.sw ? " from worker" : ""}`).join("; ")}`);
    let line = "";
    for (const { at: when, text } of timeline) {
      const entry = `-${at - when}ms ${text}`;
      if (line.length + entry.length > 1300) { out.push(line); line = ""; }
      line += (line ? " | " : "") + entry;
    }
    if (line) out.push(line);
    return out;
  }
  // One sentence about the loads that lost a module request, or "".
  function abortedSummary() {
    if (!aborted.size) return "";
    return `${aborted.size} page load(s) lost a module request (${[...aborted.values()].join(", ")}); the start-up guard loads such a page again`;
  }
  return { observe, lines, abortedSummary };
}

/** Prints a load trace; in GitHub Actions each line is a warning annotation. */
export function printLoadTrace(trace, label = "") {
  const prefix = label ? `[${label}] ` : "";
  for (const line of trace.lines()) {
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Kin load trace (#594)::${prefix}${line.replace(/%/g, "%25")}`);
    else console.error(`load trace: ${prefix}${line}`);
  }
}

/** Prints which loads lost a module request, if any did. */
export function printAbortedModules(trace, label = "") {
  const summary = trace.abortedSummary();
  if (!summary) return;
  const text = `${label ? `[${label}] ` : ""}${summary}`;
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Kin aborted module loads (#594)::${text}` : `NOTE ${text}`);
}
