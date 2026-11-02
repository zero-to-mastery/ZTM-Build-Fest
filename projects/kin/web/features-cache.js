// The household's switched-off features as this device last knew them
// (ADR 0021 §2): the service's value for a synced household, so an offline
// unlock hides the same things; the household's own value where it doesn't
// sync. Kept in localStorage, unencrypted, like the display preferences: it
// names which parts of Kin are hidden, never household content, and the
// service knows it too. `noticed` is the set this member has already been
// told about, so the "turned off" note shows once.
import { parseFeatureSet } from "./features.js";

export const FEATURES_KEY = "kin.household-features";

/** `{ scope, off, revision, noticed }` for `scope` (a synced household's ID,
 * or "local"), or null when nothing valid is kept for it. */
export function readFeatureCache(scope, storage = globalThis.localStorage) {
  let value;
  try { value = JSON.parse(storage?.getItem(FEATURES_KEY) ?? "null"); } catch { return null; }
  if (!value || value.scope !== scope) return null;
  const set = parseFeatureSet(value);
  if (!set) return null;
  const noticed = Number.isSafeInteger(value.noticed) && value.noticed >= 0 ? value.noticed & set.off : set.off;
  return { scope, ...set, noticed };
}

/** Keeps the set; best effort (a private window may refuse). */
export function writeFeatureCache({ scope, off, revision, noticed }, storage = globalThis.localStorage) {
  try {
    storage?.setItem(FEATURES_KEY, JSON.stringify({ scope, off, revision, noticed: noticed & off }));
    return true;
  } catch {
    return false;
  }
}
