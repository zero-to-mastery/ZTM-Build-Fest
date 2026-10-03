# Architecture

**Status:** v0.11.7 implementation candidate; awaiting human review. Rust owns portable commands, canonical codecs, replay and archive framing/import validation. JavaScript owns root rotation, local encryption/unlock, bounded persistence and browser capabilities. Event DB schema 3 and key DB schema 4 persist encrypted protected values. The same-origin identity/relay service uses SQLite server schema v1 for durable authorization and opaque relay state.

## v0.10 implementation boundary

v0.10.2 adds the [local root lifecycle](ROOT-ROTATION.md): a browser-owned durable
cross-database journal, root-version/lock-epoch CAS, and exact candidate recovery.
Rust continues to validate/replay the unchanged canonical corpus. Recovery
archives are intentionally local-only copies; they authorize no sync reattachment.

v0.10 preserves v0.9.3 encrypted relay sync, two-adult passkey pairing,
recipient-bound key provisioning, deterministic v8 replay, exact-envelope retries
and revocation/epoch rotation. It additionally encrypts local persistent content
and gates replay on successful unlock. The [implementation record](V0.10.0.md)
contains the baseline, frozen contract and validation evidence.

```text
HTML / CSS / Web Components
          |
     application shell
          |
  Locked -> Unlocking -> Unlocked
          |                 |
  public metadata    WebAuthn PRF or explicit recovery
                            |
                      Web Crypto / key capability
                            |
                    browser persistence adapter
                            |
              manual WASM ABI / portable Rust
               commands -> canonical events -> replay
                            |
                authenticated encrypted values
                            |
                         IndexedDB
```

Locked startup loads only the shell/security metadata. It has no household
projection, decrypted corpus, root/DEK, or protected command capability. Successful
unlock obtains/unwraps a root, decrypts the complete corpus and invokes Rust
validation/replay before rendering. Lock invalidates asynchronous work, disposes
the engine, keys and plaintext, clears drafts and broadcasts to peer tabs. This is
a capability boundary, not CSS hiding. Reference disposal does not guarantee
physical memory erasure. Failure returns to Locked without partial projection.

Rust owns household intent semantics, canonical encode/decode/validate and metadata,
historical version interpretation, recurrence, identity-aware deterministic replay,
archive parsing/import planning and deterministic migration policy. The existing
single native `rlib` plus WASM `cdylib` is sufficient; a workspace split has no
demonstrated benefit yet. Browser clock, civil date, random IDs and authorization
context are explicit command inputs. Domain commands remain distinct from browser
authentication and transport operations. JS only passes opaque canonical bytes
outside the narrow codec adapter; it must not decode Lamport time or IDs by offset.

JavaScript retains WebAuthn, Web Crypto, DOM, Web Components, IndexedDB, network,
file/download, lifecycle, focus and accessibility capabilities. A transaction-aware
encrypted storage adapter preserves event/context/outbox/cursor atomicity while
crypto is pending. Root wrappers, recovery and legacy device-key transitions are
specified in [CRYPTOGRAPHY](CRYPTOGRAPHY.md); migration preserves exact event bytes
and resumes cross-database progress as specified in [MIGRATIONS](MIGRATIONS.md).

Sync remains the v0.9 opaque-envelope transport, distinct from local encryption.
Keep canonical identity, retry idempotency, conflict/revocation semantics and
historical signatures. Portable archives use an independent versioned encrypted
container, validated completely before an atomic import. The service worker only
caches an explicit static-shell allowlist; API/user data cannot enter Cache Storage.
Offline startup uses the same lock boundary. See [PORTABILITY](PORTABILITY.md)
and [V0.10.0](V0.10.0.md).

The post-v0.10 roadmap first closes platform gaps: v0.11 makes identity and relay
state durable and defines deployment/restart behavior; v0.12 defines retention,
deletion and event lifecycle; v0.13 defines recovery authority and continuity.
Only then does v0.14 own holistic navigation, visual and interaction refinement.
Basic accessible lock, unsupported-unlock, recovery, migration and corruption
states remain required in v0.10. The architecture is not complete if v0.14 must
redesign encryption, storage, commands, service durability, deletion or recovery.
See [ROADMAP](ROADMAP.md) and the [v0.11](V0.11.0.md)–[v0.14](V0.14.0.md)
planning contracts.

## v0.9.3 system shape (baseline)

```text
Web Components
      |
      v
Vanilla JavaScript and browser APIs
      |
      v
Household event stream
      |
      v
Rust compiled for WebAssembly
      |
      v
Derived household state
      |
      +------> Web Components render the result
```

The v0.1.0 module layout and ABI are implemented as documented in [IMPLEMENTATION](IMPLEMENTATION.md) and [ABI](ABI.md). The boundary is the important part: browser concerns stay in the browser layer; authoritative, deterministic household-state rules live in Rust.

## Browser and JavaScript responsibilities

JavaScript owns browser integration and presentation:

- DOM, Web Components, rendering, and browser events
- IndexedDB and persistence lifecycle
- WebAuthn authentication and Web Crypto encryption/key wrapping
- Networking and synchronization transport
- Browser lifecycle and accessibility interactions
- Loading the WebAssembly module and passing data across the boundary

JavaScript should not duplicate Kin's authoritative household-state logic. It may validate UI input for usability, but Rust remains responsible for validating events and deriving state.

## Rust and WebAssembly responsibilities

Rust owns deterministic domain behavior:

- Household event model and event validation
- State transitions and reconstruction by replay
- Implemented Daily/Weekly recurrence with explicit civil-date context
- Diffing and useful search/indexing where justified
- Distributed v8 event ordering and deterministic domain replay

Rust must not manipulate the DOM. It should be possible to test domain behavior independently from browser rendering and storage.

## Manual WebAssembly boundary

The v0.1.0 implementation targets `wasm32-unknown-unknown` and uses the explicit JavaScript-to-WASM ABI in [ABI](ABI.md). It has no `wasm-bindgen`, `web-sys`, `js-sys`, `serde`, or framework runtime dependency.

A manual ABI is implemented for v0.1.0 in [ABI](ABI.md), including exported function signatures, versioned request/result encoding, ownership and lifetimes, errors, bounds, and repeated-call behavior. JavaScript allocates/copies input and decodes output; Rust reads validated input ranges and returns a well-defined result. The browser layer retains ownership of DOM, storage, cryptographic APIs, networking, and lifecycle integration.

The manual boundary keeps the interface visible and avoids convenience bindings before a demonstrated need. A later requirement may justify revisiting that choice through an explicit architecture decision; the v0.1.0 implementation must follow the current contract.

## Canonical boundary debt resolved in v0.10.0

The v0.9.3 baseline duplicated canonical layouts in browser code and read fields
by fixed offsets. v0.10.0 moved command construction, codec validation and metadata
to Rust through the narrow WASM adapter. Browser storage/sync pass canonical bytes
and consume validated metadata. No remaining domain codec migration is assigned
to the planned platform and UX lines; no remaining domain codec migration is
assigned to a future release.

v0.10.3 adds compact Rust-owned archive header/layout validation so opaque
ciphertext does not cross WASM merely to be copied. KARC v1 bytes and existing
full-buffer ABI exports remain unchanged. Web Crypto, networking, IndexedDB and
DOM remain browser responsibilities.

## Local-first progression

The current implementation works locally:

```text
Browser UI
    |
    v
IndexedDB event log
    |
    v
Rust reconstructs household state
```

Opt-in encrypted sync now extends the local-first event store. The browser encrypts the exact canonical event bytes, the authenticated service stores/forwards opaque envelopes, and Rust validates/replays decrypted canonical records on each authorized device:

```text
Device A <---- encrypted event sync ----> Service <---- encrypted event sync ----> Device B
```

The service is not a household source of truth or plaintext domain processor. It still sees and persists routing/membership metadata, event timing/count/size, cursors, and traffic patterns; it controls availability. Relay acknowledgement follows a committed SQLite transaction, but does not prove recipient delivery, backup, or hardware durability. The implementation and limitations are documented in [SYNC](SYNC.md), [IDENTITY](IDENTITY.md), [CRYPTOGRAPHY](CRYPTOGRAPHY.md), and [THREAT-MODEL](THREAT-MODEL.md).

## Future capability leverage

The v0.1.x core is intended to be extended, not treated as proof that later features already exist:

| Future capability     | Foundation already present                           | Extendable without replacing the core? | Still required                                                        |
| --------------------- | ---------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Today / Needs         | Versioned event pipeline and Rust-derived projection | Implemented in v0.2.0                  | Stabilization and accessibility audit in v0.2.1–v0.2.3                |
| Handoff               | Actor-aware immutable event envelope                 | Implemented in v0.3.0                  | Stabilization through v0.3.3                                          |
| Talk                  | Identified events and deterministic replay           | Implemented in v0.4.0                  | Stabilization audited through v0.4.3; see V0.4.0                      |
| Pulse                 | Actor IDs and timestamps                             | Implemented in v0.5.0                  | Explicit as_of, fixed enum, set/replace/clear; audited through v0.5.3 |
| Since You Last Looked | Ordered immutable event history                      | Implemented in v0.6.0                  | Stabilization through v0.6.3                                          |
| Routines              | Event infrastructure and explicit civil context      | Implemented in v0.7.0                  | Correctness/resilience/hardening audits in v0.7.1–v0.7.4              |
| Pairing               | Household/member/device identity fields              | Implemented through v0.8.8             | Durable service backup/restore and recovery beyond live trusted devices |
| Offline sync          | Random event IDs and immutable canonical event bytes | Implemented in v0.9.2                  | Bounded to current relay/storage limits                               |
| Encrypted sync        | Versioned canonical events and browser Web Crypto    | Implemented through v0.9.3             | Independent audit, all-device recovery, broader UX                    |
| Export/import         | Versioned event representation and preserved history | Yes                                    | Portable container, validation, and recovery UX                       |

“Yes” means the existing infrastructure can be extended; it does not mean the capability is implemented, secure, or ready to ship without its listed domain and validation work.

## Dependency policy

The goal is not “dependencies are bad.” The goal is to understand and use Rust and the modern web platform before adding dependencies. The long-term default stack is Rust, WebAssembly, HTML, CSS, JavaScript, Web Components, and browser APIs. No external framework is planned unless a concrete requirement provides compelling justification. Any dependency must have a clear owner, purpose, security/update story, and cost worth accepting.

## Decisions still open

The domain event envelope, event naming, ordering requirements, and replay behavior are specified in [Events](EVENTS.md) and [State](STATE.md). The v0.0.6 [implementation](IMPLEMENTATION.md), [ABI](ABI.md), and [storage](STORAGE.md) contracts define module responsibilities, browser support, buffer protocol, and initial IndexedDB shape. Persistent contract versioning and non-destructive evolution are specified in [VERSIONING](VERSIONING.md) and [MIGRATIONS](MIGRATIONS.md). The examples in this document are not a wire format.

## v0.5.0 Pulse

Pulse adds Rust rebuild_at(events, as_of). Timers request canonical reprojection; Rust never reads ambient time. Same events plus same explicit time yield identical state. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

Rust protocol v6 derives structured summary entries and the exact through-event boundary from the ordered canonical stream plus an optional stable event-ID cursor. IndexedDB local_sequence remains browser-only. Browser local_context holds the installation cursor; no summary view or acknowledgement is a household event. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Rust derives Daily/Weekly periods from validated explicit civil dates, alongside as_of for Pulse. JS obtains local year/month/day from one browser clock sample; timers only request replay. Inside occurrence append transactions, JS compares the frozen intent key with Rust’s fresh canonical current key before candidate replay. This is identity checking, not a browser recurrence reducer. See [V0.7.0](V0.7.0.md).
