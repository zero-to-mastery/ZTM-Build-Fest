// The diagnostic code registry (#631, ADR 0021 §3): the only things the local
// diagnostic ring buffer (ring-buffer.js) may hold, and the only codes a
// problem report's "recent diagnostics" may carry to the service, which
// checks them again with the same table (server/feedback-service.mjs).
//
// Every entry is a code from DIAGNOSTIC_CODES and fields that are either
// finite numbers or one value from a fixed list. There is no string field:
// household text, names, usernames, IDs, URLs and exception messages have no
// way in. An unknown code is dropped; an unknown field is dropped; a value
// outside its list becomes "other" (every list has it) and a number is
// rounded and clamped.
//
// The table only grows: a code, once shipped, keeps its meaning, so a report
// from an older device still reads correctly.

const freeze = (values) => Object.freeze([...values, "other"]);

/** Error names worth telling apart; anything else (including an error that
 * named itself) is "other". */
export const ERROR_NAMES = freeze([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "NotAllowedError",
  "QuotaExceededError", "InvalidStateError", "NotFoundError", "DataError", "TransactionInactiveError",
  "VersionError", "UnknownError", "SecurityError", "NetworkError", "TimeoutError", "OperationError",
  "ConstraintError", "DataCloneError", "EncodingError", "NotSupportedError", "CompileError", "LinkError",
  "RuntimeError", "KinEngineError", "EventStoreError",
]);

/** Why a sync pass stopped: the service's and client's own error codes. */
export const SYNC_REASONS = freeze([
  "connection_unavailable", "authentication_required", "device_not_trusted", "membership_removed",
  "household_deleted", "household_deletion_pending", "sync_rate_limited", "sync_client_rate_budget",
  "sync_no_progress", "sync_disabled", "sync_conflict", "durable_store_unavailable", "server_error",
  "rotation_required", "epoch_key_missing", "event_signature_invalid", "provisioning_signature_invalid",
  "chat_rate_limited", "chat_unavailable", "chat_read_only", "chat_key_stale", "private_rate_limited",
  "private_storage_full", "private_unavailable", "board_unavailable", "origin_rejected", "not_found",
  "bad_request", "invalid_request", "timeout", "provisioning_grant_refused", "household_key_missing",
  "household_key_missing_after_rotation", "household_key_missing_for_binding",
]);

/** The streams a pass syncs. */
export const SYNC_ROOMS = freeze(["household", "chat", "board", "private"]);

/** Local stores. */
export const STORES = freeze(["events", "keys", "chat", "board", "private", "attachments", "outbox", "settings"]);

/** Where rendering failed. */
export const COMPONENTS = freeze([
  "workspace", "today", "lists", "routines", "updates", "household", "chat", "fridge", "meals", "journal",
  "search", "week", "detail", "simple", "security", "report",
]);

/** Route names: the pages of web/routes.js. */
export const PAGES = freeze(["today", "lists", "routines", "updates", "household", "search", "week", "foryou", "journal", "locked", "setup"]);

/** Engine stages. */
export const ENGINE_STAGES = freeze(["load", "instantiate", "call"]);

/** Why a key rotation was committed without the account vault (#791). */
export const ROTATION_VAULT_REASONS = freeze([
  "vault_version_conflict", "vault_not_found", "vault_rate_limited", "vault_invalid", "request_too_large",
  "vault_epoch_conflict", "vault_unreadable", "not_applied",
]);

/** What an unexpected error was. */
export const UNEXPECTED_KINDS = freeze(["error", "rejection"]);

// Field types: NUMBER, or one of the lists above.
const NUMBER = "number";

/**
 * code → { field: NUMBER | list }. Codes are lower_snake_case.
 * `status` is an HTTP status, `ms` a duration, `code` a numeric engine or
 * transport code, `count` a small count.
 */
export const DIAGNOSTIC_CODES = Object.freeze({
  // Sync (web/sync/sync-coordinator.js).
  // `epoch`: the household key epoch a household_key_missing* pass lacked.
  sync_failed: Object.freeze({ reason: SYNC_REASONS, status: NUMBER, epoch: NUMBER }),
  sync_room_failed: Object.freeze({ room: SYNC_ROOMS, reason: SYNC_REASONS, status: NUMBER }),
  sync_slow: Object.freeze({ ms: NUMBER }),
  // The household engine (web/wasm/).
  engine_load_failed: Object.freeze({ stage: ENGINE_STAGES, status: NUMBER, name: ERROR_NAMES }),
  engine_error: Object.freeze({ code: NUMBER }),
  // Local storage (web/storage/).
  storage_failed: Object.freeze({ store: STORES, name: ERROR_NAMES }),
  // Rendering and navigation (web/components/app/).
  render_failed: Object.freeze({ component: COMPONENTS, name: ERROR_NAMES }),
  render_slow: Object.freeze({ component: COMPONENTS, ms: NUMBER }),
  route_failed: Object.freeze({ page: PAGES, name: ERROR_NAMES }),
  // An error or rejection nothing else caught (diagnostics/global.js).
  unexpected_error: Object.freeze({ kind: UNEXPECTED_KINDS, name: ERROR_NAMES }),
  // An error message was shown to the person.
  alert_shown: Object.freeze({}),
  // Unlocking (timing only).
  unlocked: Object.freeze({ ms: NUMBER }),
  unlock_failed: Object.freeze({ name: ERROR_NAMES }),
  // Online state changes.
  went_offline: Object.freeze({}),
  went_online: Object.freeze({}),
  // The report channel itself (web/feedback/).
  feedback_send_failed: Object.freeze({ status: NUMBER }),
  // A key rotation committed without the account vault change (#791,
  // web/sync/rotation-vault.js), recorded only after the commit: the vault
  // keeper adds the key afterwards. "vault_epoch_conflict" stays in the list
  // (the table only grows) though its rotation is always refused as stale.
  rotation_vault_skipped: Object.freeze({ reason: ROTATION_VAULT_REASONS }),
});

/** Largest number a field keeps; beyond it the value is clamped. */
export const MAX_FIELD_NUMBER = 2 ** 48;

/** The value a list field takes, or "other". */
function listValue(list, value) {
  return typeof value === "string" && list.includes(value) ? value : "other";
}

/** A number field: finite, rounded to an integer, clamped. */
function numberValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(-MAX_FIELD_NUMBER, Math.min(MAX_FIELD_NUMBER, Math.round(value)));
}

/**
 * Normalizes `fields` for `code`, or returns null when the code is not in
 * the registry. Only own, known fields survive; a field whose value can't be
 * kept is left out. The result is a new frozen plain object.
 */
export function normalizeFields(code, fields = {}) {
  if (typeof code !== "string" || !Object.hasOwn(DIAGNOSTIC_CODES, code)) return null;
  const schema = DIAGNOSTIC_CODES[code];
  const out = {};
  if (fields && typeof fields === "object") {
    for (const name of Object.keys(schema)) {
      if (!Object.hasOwn(fields, name)) continue;
      const type = schema[name];
      const value = fields[name];
      if (value === undefined || value === null) continue;
      if (type === NUMBER) {
        const number = numberValue(value);
        if (number !== null) out[name] = number;
      } else out[name] = listValue(type, value);
    }
  }
  return Object.freeze(out);
}

/**
 * A ring buffer entry as it travels in a report: `{ t, code, ...fields }`
 * with `t` a time in milliseconds since 1970. Returns a normalized copy, or
 * null when it can't be one (unknown code, bad time).
 */
export function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const t = numberValue(entry.t);
  if (t === null || t < 0) return null;
  const fields = normalizeFields(entry.code, entry.fields ?? {});
  if (!fields) return null;
  return Object.freeze({ t, code: entry.code, fields });
}

/** One entry as a line of text: "2026-10-21T10:00:00Z sync_failed reason=…". */
export function entryLine(entry) {
  const time = new Date(entry.t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const fields = Object.entries(entry.fields ?? {}).map(([name, value]) => `${name}=${value}`).join(" ");
  return fields ? `${time} ${entry.code} ${fields}` : `${time} ${entry.code}`;
}
