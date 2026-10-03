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

A local “export diagnostics” feature, if considered, requires a preview/redaction policy and user consent. Diagnostics must not become hidden analytics or activity surveillance.
