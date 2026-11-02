// Gathering a problem report's diagnostics on this device (#632, ADR 0021 §3).
// Everything here is a version, a fixed-list value, a yes/no or a number,
// read from the browser and the app's own state; format.js's table decides
// what is kept, and the person sees each one in the preview and can remove
// it before anything is sent. Nothing is gathered until a report is opened.
import { describePlatform } from "../platform.js";
import { PAGES } from "../diagnostics/registry.js";
import { diagnostics } from "../diagnostics/ring-buffer.js";
import { DIAGNOSTIC_FIELDS, RECENT_LABEL, formatDiagnostic, normalizeDiagnostics } from "./format.js";
import { entryLine } from "../diagnostics/registry.js";

const VERSION_PATTERNS = Object.freeze({
  Chrome: /(?:Chrome|CriOS|Chromium)\/(\d+)/,
  Edge: /Edg(?:e|A|iOS)?\/(\d+)/,
  Firefox: /(?:Firefox|FxiOS)\/(\d+)/,
  Opera: /(?:OPR|OPiOS|OPT)\/(\d+)/,
  "Samsung Internet": /SamsungBrowser\/(\d+)/,
  Safari: /Version\/(\d+)/,
});

/** The browser's major version from its user agent, or undefined. */
export function browserVersion(browser, userAgent) {
  const match = VERSION_PATTERNS[browser]?.exec(userAgent ?? "");
  return match ? Number(match[1]) : undefined;
}

/** "phone", "tablet" or "computer". */
export function deviceType({ os, userAgent = "" }) {
  if (os === "iPhone") return "phone";
  if (os === "iPad") return "tablet";
  if (os === "Android") return /Mobile/.test(userAgent) ? "phone" : "tablet";
  return "computer";
}

const megabytes = (bytes) => (Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes / 104_857.6) / 10 : undefined);

/** The service worker's release from its cache name, or undefined. */
async function serviceWorkerRelease(win) {
  try {
    const names = await win.caches?.keys?.();
    const name = (names ?? []).find((entry) => /^kin-static-v/.test(entry));
    return name ? name.slice("kin-static-v".length) : undefined;
  } catch { return undefined; }
}

/**
 * This device's diagnostics, normalized by the table. `app` is <kin-app>
 * (or null on the lock screen and setup, where only browser facts and the
 * ring buffer are known); `win` is the window (tests pass a stand-in).
 */
export async function collectDiagnostics({ app = null, win = globalThis, recent = diagnostics.snapshot() } = {}) {
  const nav = win.navigator ?? {};
  const doc = win.document;
  const root = doc?.documentElement;
  const meta = doc?.querySelector?.('meta[name="kin-version"]')?.getAttribute?.("content") ?? "";
  const [version, build] = meta.split("+");
  const standalone = nav.standalone === true || Boolean(win.matchMedia?.("(display-mode: standalone)")?.matches);
  const platform = describePlatform({ userAgent: nav.userAgent ?? "", maxTouchPoints: nav.maxTouchPoints ?? 0, standalone });
  const unlocked = Boolean(app?.vault && !app.vault.locked);
  const route = unlocked ? app.route : null;
  let estimate = null;
  try { estimate = await nav.storage?.estimate?.(); } catch { estimate = null; }
  const value = {
    version,
    build,
    browser: platform.browser ?? "Other",
    browserVersion: browserVersion(platform.browser, nav.userAgent),
    os: platform.os ?? "Other",
    deviceType: deviceType({ os: platform.os, userAgent: nav.userAgent }),
    screenWidth: win.screen?.width,
    screenHeight: win.screen?.height,
    viewportWidth: win.innerWidth,
    viewportHeight: win.innerHeight,
    pixelRatio: win.devicePixelRatio,
    textSize: root?.dataset?.kinTextSize ?? "normal",
    installed: platform.standalone,
    page: route?.page && PAGES.includes(route.page) ? route.page : unlocked ? undefined : app?.security?.manifest ? "locked" : "setup",
    segment: route ? route.segment ?? "none" : undefined,
    // Easy mode (ADR 0021 §1) marks the page the way Simple view does.
    easyMode: root?.dataset?.kinEasy === "on",
    simpleView: root?.dataset?.kinSimple === "on",
    signedIn: unlocked && Boolean(app?.household?.identity),
    syncState: unlocked ? (app.syncState?.state ?? (app.syncCoordinator ? "syncing" : "off")) : "off",
    lastSyncAt: unlocked && Number.isFinite(app?.lastSyncAt) ? app.lastSyncAt : undefined,
    storageUsedMB: megabytes(estimate?.usage),
    storageQuotaMB: megabytes(estimate?.quota),
    serviceWorker: await serviceWorkerRelease(win),
    online: nav.onLine !== false,
    recent: recent.map(({ t, code, fields }) => ({ t, code, fields: { ...fields } })),
  };
  if (!["ready", "syncing", "paused", "disabled", "deleted", "off"].includes(value.syncState)) value.syncState = "other";
  return normalizeDiagnostics(value);
}

/**
 * The preview's rows: [{ key, label, value }] in table order, with the
 * recent entries last as one row whose `lines` are shown under it.
 */
export function previewRows(values) {
  const rows = Object.entries(DIAGNOSTIC_FIELDS)
    .filter(([key]) => values[key] !== undefined)
    .map(([key, { label }]) => ({ key, label, value: formatDiagnostic(key, values[key]) }));
  if (values.recent?.length)
    rows.push({ key: "recent", label: RECENT_LABEL, value: `${values.recent.length} ${values.recent.length === 1 ? "entry" : "entries"}`, lines: values.recent.map(entryLine) });
  return rows;
}

/** `values` without the keys the person removed. */
export function withoutRemoved(values, removed) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !removed.has(key)));
}
