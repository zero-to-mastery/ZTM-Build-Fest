# v0.1.0 Implementation Contract

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; earlier version sections are historical contracts. See Pulse and v0.6.0 below.

## Proposed project layout

```text
projects/kin/
├── AGENTS.md
├── README.md
├── CHANGELOG.md
├── LICENSE
├── Cargo.toml
├── build-wasm.ps1
├── .gitignore
├── docs/
├── rust/
│   └── src/
│       ├── lib.rs
│       ├── abi.rs
│       ├── event.rs
│       ├── state.rs
│       ├── protocol.rs
│       └── error.rs
└── web/
    ├── index.html
    ├── components/
    │   ├── kin-app.js
    │   ├── kin-today.js
    │   ├── kin-compose.js
    │   └── kin-item.js
    ├── wasm/
    │   ├── kin-engine.js
    │   └── kin-engine.test.mjs
    ├── storage/
    │   └── event-store.js
    └── styles/
```

The v0.1.0 implementation uses this layout. The generated `target/` tree and `web/wasm/kin_engine.wasm` are local build artifacts and are ignored by Git. Avoid a general framework or extra component/module unless a scoped requirement needs it.

## Rust modules today (refactor track)

The layout above is the v0.1.0 starting point. Since the refactor track the
Rust core is organised as follows:

- `wire.rs`, `request.rs`, `event_decode.rs`: the protocol-24 request and
  canonical event decoding.
- `history.rs`: the history an engine instance holds, and its replay
  checkpoint.
- `replay/`: the reducers. `Replay::apply` checks every event and dispatches
  it to `items.rs`, `conversations.rs`, `routines.rs`, `records.rs` or
  `household.rs`. `Replay::finalize` derives the time-dependent values
  (Pulse expiry, Routine occurrences) for one evaluation time and date.
- `state.rs`: the household state types and text normalization;
  `state/summary.rs` is the catch-up summary.
- `state_encode.rs` and `sections.rs`: the KINS projection and its section
  revisions.
- `command.rs`, `codec.rs`, `archive.rs`, `abi.rs`: commands, canonical
  encoding, archives (KARC framing and the import plan of the held history)
  and the manual ABI. The archive's segment format and encryption are the
  browser's: `web/security/archive-stream.js`, used by
  `web/security/archive.js`.

## Server modules today (refactor track)

- `server.mjs`: the HTTP server and routes. `http-body.mjs` reads request
  bodies with their byte limit enforced as they stream. `start.mjs` starts it
  inside Node's permission model through the launcher, `launcher.mjs`, whose
  flags and startup check live in `permissions.mjs`; `server.mjs` refuses to
  serve without that sandbox. `mode.mjs` is `KIN_MODE` (hosted or home) and
  `service-install.mjs` installs Kin as a service (ADR 0025,
  [HOME-SERVER](HOME-SERVER.md)).
- `durable-store.mjs`: the SQLite store's core (opening, locks,
  transactions, backup, restore). Its method groups live in `durable-store/`:
  `schema.mjs`, `validation.mjs`, `identity.mjs`, `lifecycle.mjs`,
  `authority.mjs`, `envelopes.mjs`, plus `lock.mjs` and `shared.mjs`.
- `pairing-service.mjs`: the identity service's core (state, audit, rate
  limits). Its methods live in `pairing-service/` by flow stage:
  `sessions.mjs`, `create.mjs`, `claim.mjs`, `approve.mjs`, then
  `devices.mjs`, `membership.mjs`, `lifecycle.mjs` and `shared.mjs`.
- `mixins.mjs`: `addMethods` attaches those groups to their class.
- `sync-service.mjs` and `sync-contract.mjs`: the relay and its envelope
  rules. Event envelopes travel as binary through
  `web/sync/envelope-wire.js`, which the server imports.

## Module responsibilities (v0.1.0)

- **`rust/src/event.rs`:** event kinds, typed classification, envelope representation, and normalized payloads.
- **`rust/src/state.rs`:** deterministic reducer and projection of ordered events into classified Item state and dedicated Handoff and Talk state.
- **`rust/src/protocol.rs`:** bounded protocol-v1/v2/v3/v4 parsing/results and explicit event-schema v1/v2 decoding.
- **`rust/src/abi.rs`:** exported C-ABI functions, pointer/length checks, buffer ownership, and status codes.
- **`rust/src/error.rs`:** stable error categories and non-sensitive messages.
- **`rust/src/lib.rs`:** module exports only; no DOM or browser API access.
- **`web/wasm/kin-engine.js`:** load WASM, validate memory ranges, allocate/copy input, call exports, copy result/error bytes before another mutating call, and decode the protocol.
- **`web/storage/event-store.js`:** open/migrate IndexedDB, read the ordered event log, and append an event atomically.
- **`web/components/kin-app.js`:** orchestrate initialization, event-store and WASM calls, loading/error states, and rendering.
- **`web/components/kin-today.js`:** display Today and Needs active/completed items from the Rust projection; omit archived items.
- **`web/components/kin-compose.js`:** capture short item text and fixed classification, preserving draft ownership, and dispatch a browser-native custom event.
- **`web/components/kin-item.js`:** render one item and expose lifecycle intents; it contains no authoritative state transition.
- **`web/index.html` and styles:** semantic shell and minimal responsive presentation.

See [ABI](ABI.md), [Storage](STORAGE.md), and [Components](COMPONENTS.md) for implementable contracts. Rust owns authoritative domain rules; JavaScript owns browser integration and persistence.

## Build boundary

The target is `wasm32-unknown-unknown`. The local WASM artifact is loaded by the page; no remote code loader is used. Kin has no `wasm-bindgen`, `web-sys`, `js-sys`, `serde`, `serde_json`, UI framework, or runtime library dependency. `build-wasm.ps1` and `build-wasm.sh` build and copy the artifact; `run.ps1` and `run.sh` reuse those scripts before serving the static web root on loopback for development.

`web/index.html` applies a same-origin Content Security Policy. It allows `wasm-unsafe-eval` only for WebAssembly compilation/instantiation; scripts, styles, fetches, images, and fonts remain same-origin (images and audio may also come from same-session `blob:` URLs, for decrypted attachment previews and voice messages). The server's `Permissions-Policy` allows the microphone for this origin only (voice messages); camera and geolocation stay off. The policy denies objects and restricts base/form targets. Because a meta-delivered policy cannot set `frame-ancestors`, Kin's server also sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. Deployments that replace the built-in server must preserve those response headers.

## Browser support floor

The target remains the latest two stable major releases of desktop and mobile Chrome, Firefox, and Safari. The browser must provide core WebAssembly, ES modules, Custom Elements, IndexedDB, `CustomEvent`, `TextEncoder`/`TextDecoder`, `crypto.getRandomValues`, and a secure context (including localhost for development). Do not target Internet Explorer or obsolete browsers. The v0.1.0 release was exercised in desktop Chrome through the integrated VS Code browser; the broader target is not certified by that check.

## Handoff implementation

`web/components/kin-handoff-list.js` owns capture/list presentation; kin-app owns command orchestration. The frozen domain and protocol contract is [V0.3.0](planning/V0.3.0.md).

## v0.4.0 Talk

rust/src/event.rs and state.rs add distinct TalkId/TalkStatus/TalkState; protocol.rs adds explicit v4. web/components/kin-talk-list.js presents Talk; kin-app.js reuses canonical refresh and suspended retry infrastructure. No framework or runtime dependency is added. See [V0.4.0](planning/V0.4.0.md).

## v0.5.0 Pulse

event.rs defines PulseValue; state.rs defines actor-scoped PulseState/rebuild_at; protocol.rs adds v5; kin-engine.js requires asOf; kin-pulse.js presents capacity. KinApp owns canonical reprojection and existing retries; EventStore appends atomically. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

`state.rs` derives the bounded structured summary and exact through-event ID. `protocol.rs` adds v6 without changing earlier layouts. `event-store.js` initializes and transactionally advances local cursor metadata in schema 1. `kin-app.js` pairs consistent snapshots, maps stable event IDs to local sequence, owns explicit Caught up intent and emits content-free view-state invalidation. `kin-catch-up.js` renders the projection only; it has no storage or reducer access. See [V0.6.0](planning/V0.6.0.md).
