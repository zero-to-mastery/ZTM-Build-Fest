// Sharing into Kin (#389, #390, #395). The installed app is a share target
// (manifest `share_target`): another app's share sheet POSTs the title, text,
// link and files to /share. The service worker answers that POST itself, so
// the content never reaches the server: it keeps the share in memory under a
// random id and sends the page to `/#kin-share=<id>`. As the app loads, the
// id is taken out of the address (like an invitation code, pairing-link.js)
// and the content is fetched from the worker once. It then waits in memory
// until Kin is unlocked; nothing about it is stored, and a lock drops it.

export const SHARE_PATH = "/share";
const SHARE_PARAMETER = "kin-share";
const ID = /^[a-f0-9]{32}$/;

/** Longest text kept from a share (an item's text is shorter still; the
 * dialog trims it to fit where it goes). */
export const MAX_SHARED_TEXT = 4_000;
/** Most files kept from one share. */
export const MAX_SHARED_FILES = 10;

/** Takes the share id from `#kin-share=<id>` and resets the address to the
 * app's start. Returns the id, or "" when the address carries none. */
export function takeShareId(where = globalThis.location, past = globalThis.history) {
  const hash = String(where?.hash ?? "").replace(/^#/, "");
  if (!hash.toLowerCase().startsWith(`${SHARE_PARAMETER}=`)) return "";
  const id = hash.slice(SHARE_PARAMETER.length + 1).toLowerCase();
  past?.replaceState(null, "", "/");
  return ID.test(id) ? id : "";
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+/i;

/** What a share says, tidied: `text` for an item or a message (title or first
 * line, then the link), and `body` for a note (everything). */
export function sharedText({ title = "", text = "", url = "" } = {}) {
  const clean = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_SHARED_TEXT);
  let heading = clean(title);
  let detail = clean(text);
  let link = clean(url);
  // Many apps put the link inside the text instead of the url field.
  if (!link) {
    const found = URL_IN_TEXT.exec(detail);
    if (found) {
      link = found[0].replace(/[).,;!?]+$/, "");
      detail = detail.replace(found[0], "").trim();
    }
  }
  if (heading && detail === heading) detail = "";
  const firstLine = (heading || detail).split("\n").find((line) => line.trim()) ?? "";
  const line = [firstLine.trim(), link].filter(Boolean).join(" ");
  const body = [heading, detail, link].filter(Boolean).join("\n\n");
  return { text: line.slice(0, MAX_SHARED_TEXT), body: body.slice(0, MAX_SHARED_TEXT), link };
}

/** Asks the service worker for the share it holds under `id`, once.
 * Resolves `{ title, text, url, files }` or null. */
export async function fetchShared(id, { worker = globalThis.navigator?.serviceWorker, timeout = 3_000 } = {}) {
  if (!ID.test(id ?? "") || !worker) return null;
  const controller = worker.controller ?? (await Promise.race([worker.ready, new Promise((done) => setTimeout(done, timeout))]))?.active;
  if (!controller) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, timeout);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (!data || typeof data !== "object") return resolve(null);
      const files = Array.isArray(data.files) ? data.files.filter((file) => file instanceof Blob).slice(0, MAX_SHARED_FILES) : [];
      resolve({ title: String(data.title ?? ""), text: String(data.text ?? ""), url: String(data.url ?? ""), files });
    };
    controller.postMessage({ type: "kin-share-take", id }, [channel.port2]);
  });
}

/** Home-screen shortcuts (#399, #472) that run an action rather than open a
 * page: `#kin-action=<name>`. Taken from the address like a share id, so it
 * never stays in the address or history; being a fragment, it never reaches
 * the server either. "quick-add" is the "Add a task" shortcut (its address
 * is kept so shortcuts on existing installs still work). Shortcuts that only
 * open a page (`#week`, `#lists/shopping`, …) are ordinary routes, which a
 * lock leaves in the address until unlock. */
// "new-journal-entry" (#509) opens the member's journal editor.
export const LAUNCH_ACTIONS = Object.freeze(["quick-add", "add-shopping", "new-journal-entry"]);
export function takeLaunchAction(where = globalThis.location, past = globalThis.history) {
  const hash = String(where?.hash ?? "").replace(/^#/, "").toLowerCase();
  if (!hash.startsWith("kin-action=")) return "";
  past?.replaceState(null, "", "/");
  const action = hash.slice("kin-action=".length);
  return LAUNCH_ACTIONS.includes(action) ? action : "";
}

/** Where a shortcut action lands (pure): the page to show and whether Quick
 * add opens there, its destination following the page (To do or Shopping).
 * Simple view has no Quick add (#345), so it lands on Today instead. Unknown
 * actions land nowhere (null). */
export function shortcutLanding(action, { simpleView = false, available = () => true } = {}) {
  if (!LAUNCH_ACTIONS.includes(action)) return null;
  if (simpleView) return { hash: "#today", quickAdd: false };
  // A household that switched the journal off (#625, ADR 0021): Today, and
  // `unavailable` names the route for the calm line.
  if (action === "new-journal-entry")
    return available("journal") ? { hash: "#journal", quickAdd: false, journal: true } : { hash: "#today", quickAdd: false, unavailable: "journal" };
  return { hash: action === "add-shopping" ? "#lists/shopping" : "#lists/todo", quickAdd: true };
}

let pending = null;
let pendingAction = "";

/** As the app loads, or when the address changes while it runs: a
 * shortcut's action, kept until Kin is unlocked. A newer shortcut replaces
 * one still waiting. */
export function captureLaunchAction(where, past) {
  const action = takeLaunchAction(where, past);
  if (action) pendingAction = action;
  return action;
}

/** The shortcut action waiting for unlock, once. */
export function consumeLaunchAction() {
  const action = pendingAction;
  pendingAction = "";
  return action;
}

/** As the app loads (kin-app.js): takes a share id from the address and
 * starts fetching its content. */
export function captureShare(where, past) {
  const id = takeShareId(where, past);
  if (id) pending = fetchShared(id);
  return Boolean(id);
}

/** The share waiting for Kin to unlock, once; later calls get null. */
export async function consumeShare() {
  const waiting = pending;
  pending = null;
  return waiting ? waiting.catch(() => null) : null;
}

/** Forgets a waiting share (a lock). */
export function dropShare() {
  pending = null;
}
