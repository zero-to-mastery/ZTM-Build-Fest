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

## Module responsibilities

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

`web/index.html` applies a same-origin Content Security Policy. It allows `wasm-unsafe-eval` only for WebAssembly compilation/instantiation; scripts, styles, fetches, images, and fonts remain same-origin. The policy denies objects and restricts base/form targets. A meta-delivered policy cannot set `frame-ancestors`; production hosting should add that directive as an HTTP response header if framing must be prohibited.

## Browser support floor

The target remains the latest two stable major releases of desktop and mobile Chrome, Firefox, and Safari. The browser must provide core WebAssembly, ES modules, Custom Elements, IndexedDB, `CustomEvent`, `TextEncoder`/`TextDecoder`, `crypto.getRandomValues`, and a secure context (including localhost for development). Do not target Internet Explorer or obsolete browsers. The v0.1.0 release was exercised in desktop Chrome through the integrated VS Code browser; the broader target is not certified by that check.

## Handoff implementation

`web/components/kin-handoff-list.js` owns capture/list presentation; kin-app owns command orchestration. The frozen domain and protocol contract is [V0.3.0](V0.3.0.md).

## v0.4.0 Talk

rust/src/event.rs and state.rs add distinct TalkId/TalkStatus/TalkState; protocol.rs adds explicit v4. web/components/kin-talk-list.js presents Talk; kin-app.js reuses canonical refresh and suspended retry infrastructure. No framework or runtime dependency is added. See [V0.4.0](V0.4.0.md).

## v0.5.0 Pulse

event.rs defines PulseValue; state.rs defines actor-scoped PulseState/rebuild_at; protocol.rs adds v5; kin-engine.js requires asOf; kin-pulse.js presents capacity. KinApp owns canonical reprojection and existing retries; EventStore appends atomically. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

`state.rs` derives the bounded structured summary and exact through-event ID. `protocol.rs` adds v6 without changing earlier layouts. `event-store.js` initializes and transactionally advances local cursor metadata in schema 1. `kin-app.js` pairs consistent snapshots, maps stable event IDs to local sequence, owns explicit Caught up intent and emits content-free view-state invalidation. `kin-catch-up.js` renders the projection only; it has no storage or reducer access. See [V0.6.0](V0.6.0.md).
