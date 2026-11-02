// The pure rules of reading modes (ADR 0140, 0141, 0142), shared by
// <ob-reading-modes> and its tests. Nothing here touches the page.
//
// A reading mode only decides which author-written supplements are shown. The
// three names, the order and the rule below are the same contract the build
// uses (`openblog_core::reading_depth`); tests/fixtures/reading-modes.json
// holds it once, and both the Rust and the Node tests read that file.

export const MODES = ["standard", "guided", "deep-dive"];
export const LABELS = { standard: "Standard", guided: "Guided", "deep-dive": "Deep dive" };
/**
 * The key the choice is kept under for a site at the root of its host.
 * localStorage is per origin, not per site: every GitHub Pages project site of
 * one account shares an origin, so a site under a folder adds its base path
 * (see [`storageKey`]) and its choice never reaches a sibling site.
 */
export const STORAGE_KEY = "ob-reading-mode";
export const LEVELS = ["guided", "deep-dive"];

/**
 * The key for a site served under `basePath` ("" at the root, "/blog" for
 * https://user.github.io/blog/). Anything that is not a plain absolute path is
 * read as the root.
 */
export function storageKey(basePath = "") {
  const base = typeof basePath === "string" ? basePath.trim().replace(/\/+$/, "") : "";
  return base.startsWith("/") && base.length > 1 && base.length <= 200 ? `${STORAGE_KEY}:${base}` : STORAGE_KEY;
}

export const isMode = (value) => typeof value === "string" && MODES.includes(value);
export const isLevel = (value) => typeof value === "string" && LEVELS.includes(value);

/**
 * Whether `mode` shows a supplement of `level`: standard shows none, guided
 * shows the guided ones, deep-dive shows both. A supplement that holds a
 * warning or caution callout (`always`) is shown in every mode, so safety
 * text is never hidden.
 */
export function shows(mode, level, always = false) {
  if (always) return true;
  if (mode === "guided") return level === "guided";
  if (mode === "deep-dive") return level === "guided" || level === "deep-dive";
  return false;
}

/**
 * What the page does with one supplement: [`shows`], except that a supplement
 * whose level is missing or not one this release knows is always shown. The
 * build only writes known levels, so this only protects the reader from
 * hand-edited or newer markup: a layer is never lost to a label it cannot read.
 */
export function shouldShow(mode, level, always = false) {
  return isLevel(level) ? shows(mode, level, always) : true;
}

/**
 * A page's path without a trailing `index.html`: `/post/` and `/post/index.html` are the same page
 * (a static host serves one for the other), so a link written either way points here.
 */
export function pagePath(pathname) {
  return typeof pathname === "string" ? pathname.replace(/\/index\.html$/, "/") : "";
}

/** The mode to open in: the reader's saved choice, else the author's default, else standard. */
export function resolveMode(preference, authorDefault) {
  if (isMode(preference)) return preference;
  if (isMode(authorDefault)) return authorDefault;
  return "standard";
}

/** The browser's local storage, or null where it is blocked or missing. */
export function localStore() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved mode, or null when there is none, it is not a mode, or storage fails. */
export function readPreference(storage = localStore(), key = STORAGE_KEY) {
  try {
    const value = storage?.getItem(key);
    return isMode(value) ? value : null;
  } catch {
    return null;
  }
}

/** Saves the choice on this device only. False when it could not be saved. */
export function writePreference(storage, mode, key = STORAGE_KEY) {
  if (!isMode(mode)) return false;
  try {
    if (!storage) return false;
    storage.setItem(key, mode);
    return true;
  } catch {
    return false;
  }
}

/** Forgets the saved choice. False when storage failed. */
export function clearPreference(storage, key = STORAGE_KEY) {
  try {
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** How many supplements each mode shows, from `[{ level, always }]`. */
export function countsByMode(items) {
  return Object.fromEntries(
    MODES.map((mode) => [mode, items.filter((item) => shouldShow(mode, item.level, item.always)).length]),
  );
}

/** The one line that says what a mode does, with how many supplements it shows. */
export function describe(mode, shown, total) {
  if (mode === "standard") {
    return shown === 0
      ? "The article alone."
      : `The article, with ${plural(shown, "supplement")} that hold${shown === 1 ? "s" : ""} a warning.`;
  }
  const what = mode === "guided" ? "short explanations" : "everything the author added";
  return `Adds ${what}: ${shown} of ${plural(total, "supplement")} shown.`;
}

/**
 * The one line paper carries when a mode left supplements out: what was
 * printed and how many layers it does not show. Empty when nothing was left out,
 * so a page that printed everything says nothing extra.
 */
export function printNote(mode, hidden) {
  return hidden > 0 ? `Printed in ${LABELS[mode]} mode; ${plural(hidden, "supplement")} not shown.` : "";
}

/** What is announced to a screen reader after a mode change. */
export function announcement(mode, shown, total) {
  return shown === 0
    ? `${LABELS[mode]} reading. No supplements shown.`
    : `${LABELS[mode]} reading. Showing ${shown} of ${plural(total, "supplement")}.`;
}
