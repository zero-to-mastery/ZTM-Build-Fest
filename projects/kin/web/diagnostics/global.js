// Page-wide diagnostic hooks (#631): an error or promise rejection nothing
// else handled is recorded as `unexpected_error` with only its kind and its
// error's constructor name (never its message or stack, which can carry
// household text), and online/offline changes are noted. `onUnexpected` lets
// the app offer "Report a problem" after such an error (#632); it is called
// at most once a minute so a loop of errors can't keep interrupting.
import { ERROR_NAMES } from "./registry.js";
import { recordDiagnostic } from "./ring-buffer.js";

const OFFER_GAP_MS = 60_000;

/** The error's name if it is one of the known ones, else "other". Reads
 * only `name` and never calls anything on the value. */
export function errorName(value) {
  let name;
  try { name = value && typeof value === "object" ? value.name : undefined; } catch { name = undefined; }
  return typeof name === "string" && ERROR_NAMES.includes(name) ? name : "other";
}

/** Installs the hooks on `target` (a window); returns an uninstall. */
export function installGlobalDiagnostics(target = globalThis, { onUnexpected = null, now = () => Date.now() } = {}) {
  let lastOffer = -Infinity;
  const offer = () => {
    if (typeof onUnexpected !== "function") return;
    const at = now();
    if (at - lastOffer < OFFER_GAP_MS) return;
    lastOffer = at;
    try { onUnexpected(); } catch { /* never let reporting cause another error */ }
  };
  const onError = (event) => {
    // A resource that failed to load (an <img>, a script) reaches a capture
    // listener too; those aren't program errors and have no `error`.
    if (!event || event.error === undefined) return;
    recordDiagnostic("unexpected_error", { kind: "error", name: errorName(event.error) });
    offer();
  };
  const onRejection = (event) => {
    recordDiagnostic("unexpected_error", { kind: "rejection", name: errorName(event?.reason) });
    offer();
  };
  const onOffline = () => recordDiagnostic("went_offline");
  const onOnline = () => recordDiagnostic("went_online");
  target.addEventListener?.("error", onError);
  target.addEventListener?.("unhandledrejection", onRejection);
  target.addEventListener?.("offline", onOffline);
  target.addEventListener?.("online", onOnline);
  return () => {
    target.removeEventListener?.("error", onError);
    target.removeEventListener?.("unhandledrejection", onRejection);
    target.removeEventListener?.("offline", onOffline);
    target.removeEventListener?.("online", onOnline);
  };
}
