# Debugging and Diagnostics

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; privacy-safe diagnostic policy. Current ABI errors and UI feedback use bounded messages; no household-content logging exists. Symbolic diagnostics below remain future vocabulary.

## Useful diagnostic categories

Future errors should be deterministic and actionable without exposing private household content. Stable machine-readable codes may include:

```text
KIN_PROTOCOL_UNSUPPORTED
KIN_EVENT_INVALID
KIN_REFERENCE_UNKNOWN
KIN_STORAGE_FAILED
KIN_MIGRATION_FAILED
KIN_EXPORT_INVALID
KIN_SYNC_CONFLICT
KIN_AUTH_FAILED
KIN_CRYPTO_FAILED
```

These names are a diagnostic vocabulary, not current ABI codes or implemented APIs. The v0.1.0 manual ABI already specifies numeric WASM status categories in [ABI](ABI.md); a future bridge may map those categories to stable user/support codes without changing their domain meaning. Avoid duplicating error registries without need.

## Privacy-safe logging

> Debugging must not casually expose private household text.

Logs should favor bounded technical context:

```text
event_id
event_type
error_code
protocol_version
storage_schema_version
application_version
```

Do not log event payloads, item text, Handoff text, Talk topics, Pulse values, member display names, passkey assertions, encryption keys, pairing secrets, or decrypted exports. Avoid URLs, exception messages, and browser storage dumps that may include content.

If a developer explicitly opts into inspecting local synthetic test data, keep it local, visible, narrowly scoped, and off by default. Never upload diagnostic bundles containing household content automatically. Bug reports should include repro steps, browser/OS version, and redacted diagnostic codes rather than private messages.

## Planned failure investigation

- **WASM load/ABI mismatch:** check local artifact presence, expected export names, protocol version, and status code; do not dump linear memory.
- **Malformed event/replay mismatch:** use synthetic event IDs/payloads and canonical test vectors; report event kind, version, sequence, and error category, not text.
- **IndexedDB failure/migration:** record operation, schema versions, transaction state, and recoverability; preserve database bytes and do not clear storage as a debugging shortcut.
- **Protocol incompatibility:** report expected/observed version numbers and preserve unsupported bytes.
- **Sync conflict:** use synthetic households/devices, event IDs, logical order, and conflict class; do not include plaintext event content.
- **Authentication/cryptography failure:** never log credentials, assertions, pairing codes, plaintext keys, or secret material. Capture only reviewed high-level failure categories and protocol versions.

## Push notification checks

The in-app **Notifications on this device** panel is the safe first diagnostic. It shows this browser's permission, whether this device has a Kin subscription, and its mute state. It deliberately does not show or export the push endpoint, subscription keys, or endpoint fingerprint.

Test delivery with two distinct household members: opt in on the receiving member's device, leave it unmuted, then make and sync a household change from the other member's device. Allow up to the two-minute coalescing window. A second device belonging to the author is not a receiver, because selection uses the stable member ID and excludes all devices owned by that member. There is no manual push sender, delivery receipt, read receipt, or presence diagnostic.

If the panel cannot load subscription state, check the connection and retry there. If permission is blocked, change the site's notification permission in the browser. On iPhone and iPad, use the Home Screen installation. If the server reports notifications unavailable, its operator must configure an HTTPS VAPID subject; do not work around that state by exposing subscription details.

The original push design and its service, subscription, recipient, service-worker, and client contracts are tracked in [#85](https://github.com/mnichols08/ZTM-Build-Fest/issues/85), [#86](https://github.com/mnichols08/ZTM-Build-Fest/issues/86), [#87](https://github.com/mnichols08/ZTM-Build-Fest/issues/87), [#88](https://github.com/mnichols08/ZTM-Build-Fest/issues/88), [#89](https://github.com/mnichols08/ZTM-Build-Fest/issues/89), and [#90](https://github.com/mnichols08/ZTM-Build-Fest/issues/90).

## Reports from the app (ADR 0021 §3)

The planned "export diagnostics" is replaced by **Report a problem**
([ADR 0021](decisions/0021-kin-for-everyone.md) §3, #630). Diagnostics never
leave a device except in a report the person previewed and sent; they never
become analytics.

- **The diagnostic ring buffer** (`web/diagnostics/ring-buffer.js`) holds the
  last 50 entries in the page's memory only (no localStorage,
  sessionStorage or IndexedDB; a reload or closed tab empties it). Its writer
  takes a code from the fixed registry in `web/diagnostics/registry.js` and
  fields that are numbers or values from a fixed list; anything else becomes
  `other` or is dropped. It records: `sync_failed` and `sync_room_failed`
  (an error code from a fixed list and an HTTP status; for a missing
  household key, `sync_failed` also has the key epoch it lacked), `sync_slow`,
  `engine_load_failed`, `engine_error` (the engine's numeric category),
  `storage_failed`, `render_failed`, `render_slow`, `route_failed`,
  `unexpected_error` (error or rejection, and the error's constructor name,
  never its message or stack), `alert_shown`, `unlocked` (timing),
  `unlock_failed` (the error's name when a household didn't start),
  `went_offline`, `went_online` and `feedback_send_failed`. Add a code to the
  registry before recording it; the table only grows.
  `rotation_vault_skipped` (a reason from a fixed list) is recorded once a
  key rotation has committed without the account vault change (#791); the
  vault keeper adds the new key after the device installs it. A rotation
  that didn't commit records nothing.
- **What a report carries** is the table in `web/feedback/format.js`:
  version and build, browser and version, system and device type, screen and
  window size, pixel ratio, text size, installed or tab, the page and section
  as route names, easy mode and Simple view, signed in, sync state and last
  sync time, storage use, the service worker's release, online state, and
  the ring buffer. The person sees each in the preview and can remove any.
  The service applies the same table again and drops anything else.
- **Reading reports** is for the operator: `node server/admin.mjs
  feedback-list`, `feedback-show <reference>` (with `--screenshot <file>` to
  save a picture), `feedback-set-status`, `feedback-forward` and
  `feedback-purge`; see the README's [reports section](../README.md#reports-and-suggestions-from-the-app). A person quotes their
  reference number (`KR-…` for a report, `KS-…` for a suggestion).
