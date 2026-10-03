# JavaScript–WASM ABI

**Status:** v0.11.7 implementation candidate; awaiting human review. v0.10 added portable commands, metadata and archive operations. Canonical event schemas and replay protocols v1-v8 remain byte-compatible. Earlier version sections are historical contracts.

## Target and exports

Compile Rust for `wasm32-unknown-unknown` and expose a narrow C-compatible ABI. Names below are the planned v0.1.0 names:

```text
kin_alloc(length: u32) -> ptr: u32
kin_free(ptr: u32, length: u32) -> status: i32
kin_apply_events(ptr: u32, length: u32) -> status: i32
kin_result_ptr() -> ptr: u32
kin_result_len() -> length: u32
kin_error_ptr() -> ptr: u32
kin_error_len() -> length: u32
```

Pointers are byte offsets into the current WebAssembly linear memory, represented as `u32`; JavaScript must not treat them as host pointers. `kin_apply_events` uses the stable status codes defined in the protocol section; `kin_free` returns `0` on success and `1` for an invalid range. Error text is diagnostic only; clients branch on codes.

## Protocol version 1 (legacy)

All multibyte integers are little-endian. IDs are exactly 16 opaque bytes; never parse or sort their internal bytes except for the explicit bytewise tie-break defined in [EVENTS](EVENTS.md). Text is strict UTF-8 with no terminator. Reserved fields must be zero. Reject truncated input, trailing bytes, integer overflow, unknown kind codes, invalid UTF-8, and unsupported versions; do not attempt to reinterpret a different layout.

The request begins with a 12-byte header:

```text
offset  size  field
0       4     ASCII "KINE"
4       2     protocol_version = 1
6       2     reserved = 0
8       4     event_count
```

It is followed by exactly `event_count` consecutive records, each with an 88-byte fixed header and the declared payload:

```text
size  field
2     event_version = 1
2     event_kind (1 = ITEM_ADDED, 2 = ITEM_COMPLETED)
16    event_id
16    household_id
16    actor_id
16    device_id
8     timestamp (signed UTC Unix milliseconds)
8     logical_time (unsigned)
4     payload_length in bytes
N     payload bytes
```

The `ITEM_ADDED` payload is `item_id[16]`, `text_length:u32`, then exactly that many UTF-8 text bytes. Text length must be 1–4096 bytes. The `ITEM_COMPLETED` payload is exactly `item_id[16]`. Every request is limited to 10,000 events and 64 MiB total; results are subject to the same 64 MiB output limit. All events in one v0.1.0 request must have the same household ID and must appear in IndexedDB `local_sequence` order. The protocol does not encode local sequence; the caller supplies records in that order.

A successful state result begins with a 12-byte header:

```text
offset  size  field
0       4     ASCII "KINS"
4       2     protocol_version = 1
6       2     reserved = 0
8       4     item_count
```

Each item record is 48 bytes followed by its UTF-8 text:

```text
size  field
16    item_id
16    created_by actor_id
8     created_at UTC Unix milliseconds
1     status (0 = active, 1 = completed)
3     reserved = 0
4     text_length in bytes
N     text bytes
```

Items are serialized in `ITEM_ADDED` event order, not hash-map iteration order. Empty household state is a valid 12-byte `KINS` response with `item_count = 0`.

On failure, the error buffer is:

```text
ASCII "KERR" | protocol_version:u16 | error_code:u16 | message_length:u32 | UTF-8 message
```

The error code is also returned from `kin_apply_events`: `0` success, `1` invalid ABI pointer/range, `2` malformed protocol/payload, `3` unsupported protocol/event version or kind, `4` invalid domain event/state, `5` size/allocation limit, `6` internal error. The same failure must always produce the same category; the message is not a machine-readable contract and must not contain household text.

Protocol v1 is retained byte-for-byte for legacy callers. Its event kinds are only `ITEM_ADDED` (1) and `ITEM_COMPLETED` (2), event schema is v1, result status is `0 = active` or `1 = completed`, and all its reserved bytes remain zero. It does not reinterpret reserved bytes as classification or archived status.

## Protocol version 2 (legacy classified Items)

Protocol v2 uses the same `KINE`/`KINS` signatures, 12-byte outer headers, 88-byte event headers, little-endian encoding, 10,000-event limit, and 64 MiB request/result limits. Its header version is `2`; event envelope fields retain the protocol-v1 byte offsets. It supports legacy schema-v1 records and current event kinds 1–4; `ITEM_ADDED` schema v2 is the only new payload version.

The v2 `ITEM_ADDED` payload is:

```text
size  field
16    item_id
1     classification (0 = Today, 1 = Need)
3     reserved = 0
4     text_length in bytes
N     strict UTF-8 text
```

Text length remains 1–4096 bytes. Schema-v1 `ITEM_ADDED` retains its original payload and normalizes to Today without changing its source bytes. Event schema v1 carries `ITEM_COMPLETED` (kind 2), `ITEM_REOPENED` (kind 3), and `ITEM_ARCHIVED` (kind 4), each with an exact 16-byte item ID payload.

A v2 result record is 48 bytes plus UTF-8 text:

```text
size  field
16    item_id
16    created_by actor_id
8     created_at UTC Unix milliseconds
1     classification (0 = Today, 1 = Need)
1     status (0 = active, 1 = completed, 2 = archived)
2     reserved = 0
4     text_length in bytes
N     text bytes
```

Items remain serialized in original add-event order, including archived tombstones so the caller can make a filtered view without becoming a reducer. The browser hides archived items from ordinary lists. Protocol v7 is the current browser writer; see the additive contracts below. `KERR` retains the v1 header/version and stable numeric error codes across all supported request protocol versions.

## Ownership and lifetime

- `kin_alloc(n)` allocates an input buffer owned by JavaScript. For `n == 0`, it returns `0`. Allocation failure returns `0`; the bridge treats that as failure and does not call apply.
- JavaScript writes exactly `n` bytes within the current `memory.buffer`, refreshes its view after any operation that may grow memory, and calls `kin_apply_events(ptr, n)`.
- `kin_apply_events` accepts only the exact pointer and length of a currently tracked `kin_alloc` input buffer. Rust reads from that owned allocation for the duration of the call and does not retain a caller pointer after return.
- JavaScript calls `kin_free(ptr, n)` exactly once after apply returns, whether apply succeeds or fails. `(0, 0)` is a no-op; other invalid free ranges fail safely and never free an unrelated allocation.
- Rust owns result/error buffers. `kin_result_ptr/len` refer to the most recent successful result; `kin_error_ptr/len` refer to the most recent failed call. The inactive pair returns `(0, 0)`.
- Result/error bytes stay valid until the next `kin_apply_events` call or module teardown. JavaScript must copy them into host-owned memory before another call. The bridge must not retain a view that may become stale if WASM memory grows.
- Each call clears the previous result and error before processing. Repeated calls are independent full replays; the module has no hidden household state between calls.
- A valid empty household response is a non-empty protocol result containing zero entity counts (12 bytes for v1/v2, 16 for v3, 20 for v4). A zero-length error/result accessor means that no buffer is available, not a successful empty state.
- Output allocation is released by Rust on the next apply call/module teardown; JavaScript must not call `kin_free` on result/error pointers.

## Call behavior

`kin_apply_events` accepts one complete event batch using protocol version 1, 2, 3, 4, 5, 6, 7, or 8. Protocols v1-v7 replay the supplied order; v8 sorts a copy for distributed state replay while preserving input order for catch-up boundaries. It validates the entire request and reconstructs from scratch. On success it publishes a complete result in the requested protocol version and returns zero. On failure it publishes an error and no partial result; stored IndexedDB bytes remain untouched. Unknown protocol/event versions fail with a stable unsupported-version code; malformed payload, bounds overflow, and invalid state transitions fail deterministically.

The function may grow memory while parsing or building output. JavaScript must reacquire `memory.buffer` after the call before copying result/error bytes. Length arithmetic is checked for overflow in both languages. Cap a request and result at 64 MiB, a request at 10,000 events, and individual item text at 4096 UTF-8 bytes for v0.1.0; reject larger input before unbounded allocation. The matching 10,000-event storage limit is specified in [STORAGE](STORAGE.md).

## JavaScript bridge responsibilities

The high-level bridge owns loading/instantiation, ABI export checks, buffer allocation/copy/free, memory view refresh, binary protocol encode/decode, and conversion of stable ABI errors to UI-safe messages. It must not implement event replay or state transitions.

## Protocol version 3 (legacy Handoff)

Requests retain the 12-byte KINE header and 88-byte envelope with explicit version 3. All v2 events plus schema-1 kinds 5 HANDOFF_ADDED, 6 HANDOFF_ACKNOWLEDGED, and 7 HANDOFF_ARCHIVED are supported. Add payload: handoff_id[16], text_length:u32, strict UTF-8 text (1–4096 bytes). Reference payloads: exactly handoff_id[16]. Existing codes/payloads are unchanged.

KINS v3 header: magic[4], version:u16=3, reserved:u16=0, item_count:u32, handoff_count:u32 (16 bytes). All v2-layout Item records precede Handoff records. A Handoff record is handoff_id[16], created_by[16], created_at:i64, status:u8 (0 unacknowledged, 1 acknowledged, 2 archived), reserved[3]=0, text_length:u32, text. Fixed record size is 48 bytes. Collections retain original add order including tombstones; combined count is at most 10,000. The 64 MiB bound remains. Empty v3 output is 16 bytes. KERR stays version 1.

Protocols v1/v2 reject Handoff events and cannot serialize Handoff projection, including archived state. They never silently omit it. Protocol v1 still rejects Needs/archived Item state. See [V0.3.0](V0.3.0.md).

## v0.4.0 Talk

Protocol v4 requests retain the 12-byte KINE header and 88-byte envelope, version 4. KINS header: magic[4], version:u16=4, reserved:u16=0, item_count:u32, handoff_count:u32, talk_count:u32 (20 bytes). All v2 Item records precede v3 Handoff records and Talk records. Talk: talk_id[16], created_by[16], created_at:i64, status:u8 (0 open, 1 resolved, 2 archived), reserved[3]=0, text_length:u32, text[N]. Combined count is at most 10,000; 64 MiB limits, little-endian integers, strict UTF-8, exact lengths and KERR v1 remain unchanged. Protocols 1–3 reject Talk events/state, including tombstones, with unsupported category 3. The current browser writes v7; see the v0.7.0 contract below. See [V0.4.0](V0.4.0.md).

## v0.5.0 Pulse

Protocol v5 KINE: magic[4], version:u16=5, reserved:u16=0, event_count:u32, as_of:i64 (20 bytes). KINS adds pulse_count:u32 after talk_count (24-byte header), followed by unchanged Item/Handoff/Talk records and 40-byte Pulse records: actor_id[16], set_at:i64, expires_at:i64, value:u8, status:u8, reserved[6]=0. Integers little-endian; Pulse/as_of timestamps in ±8,640,000,000,000,000ms and expiry > set_at. Protocols 1–4 unchanged and reject Pulse. KERR remains v1. Browser applyEvents(records, asOf) requires time. Full offsets/error categories are in the frozen contract. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

Protocol v6 is additive; v1–v5 request/result layouts and supported behavior remain unchanged. The v6 request is exactly 40 bytes: `KINE`, version 6, reserved zero, event_count:u32, explicit `as_of:i64`, cursor_present:u8, reserved[3]=0, cursor_event_id[16]. An absent cursor requires all-zero ID bytes. A present cursor must exactly match an event in the ordered stream or the request fails with invalid-event status 4.

The v6 result header is exactly 52 bytes: `KINS`, version 6, reserved zero, Item/Handoff/Talk/Pulse counts, summary_count, summary_total_count, through-present:u8, reserved[3]=0, and summary_through_event_id[16] (all zero when absent). It is followed by unchanged v2 Item, v3 Handoff, v4 Talk and v5 Pulse records, then at most eight summary records. Each summary record is event_id[16], kind:u8 (1–11), entity_kind:u8, classification:u8 (0 Today, 1 Needs, 255 absent), reserved:u8=0, text_length:u32, and strict UTF-8 text. Pulse entries are excluded, but the through ID is the exact last event in the input stream, including Pulse. Full offsets, bounds, validation and ownership are in [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Protocol v7 adds an explicit civil date: 44-byte KINE header and 56-byte KINS header, unchanged exports/ownership, schema-1 Routine kinds 14–17, 56-byte Routine result records and summary kinds 12–15. Current browser calls `applyEvents(records, asOf, cursorEventId, civilDate)` with required explicit context. v1–v6 retain exact layouts/behavior; KERR stays v1. See [V0.7.0](V0.7.0.md) for authoritative offsets, validation and bounds.

## v0.9.0 Distributed replay

Protocol v8 is additive; v1–v7 request/result layouts remain unchanged. A v8 request begins with the v7 44-byte header and appends:

```text
offset  size  field
44      16    authenticated target household ID
60      2     identity_binding_count (0..256)
62      2     reserved = 0
```

Then come `identity_binding_count` fixed 96-byte records, before the unchanged 88-byte event records:

```text
size  field
16    legacy household ID
16    legacy actor ID
16    legacy device ID
16    authenticated household ID (must equal request target)
16    authenticated member/actor ID
16    authenticated trusted-device ID
```

All IDs are opaque 16-byte values. Duplicate legacy tuple mappings, conflicting/ambiguous bindings, a target-household mismatch, missing binding for an event from a different household, truncated binding, nonzero reserved bytes, or more than 256 bindings fail closed. The JS caller supplies only bindings already verified by the encrypted/signature-checked control record; the ABI itself is not a cryptographic verifier. Event header/payload bytes and `canonical_bytes` are never rewritten.

For v8 only, equal logical times are valid. Rust creates an owned copy and sorts that copy for household state reduction by `(logical_time, effective device_id bytewise, event_id bytewise)`. The decoded request retains input/local-arrival order; summary `through_event_id` and the Since You Last Looked cursor use that original order, not the reducer's sort. The v8 KINS result has the same 56-byte header and record layout as v7, with `version=8`. The KERR layout/statuses, 10,000-event bound, and 64 MiB request/result bounds remain unchanged.

## v0.10 portable operations

The dependency-free `kin` library remains both a native `rlib` and a WASM
`cdylib`. `core::project`, `command::execute`, `codec::encode_event`,
`codec::metadata`, `archive::decode`, and `archive::plan_import` are directly
native-testable. No crate split, browser dependency or JSON dependency is needed.
Browser authentication, randomness, time, Web Crypto, storage and networking stay
outside Rust. Rust validation does not authenticate a caller; the application
only gives an unlocked session access to its engine capability.

The following exports use the same exact-live-allocation, status, result and
error-buffer contract as `kin_apply_events`:

| Export                         | Input                                          | Result                                                        |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| `kin_encode_command(ptr,len)`  | KCMD v1 intent                                 | Canonical event bytes                                         |
| `kin_execute_command(ptr,len)` | Command length:u32, KCMD, KINE history/context | KCMT v1 event + metadata + projection                         |
| `kin_event_metadata(ptr,len)`  | One complete canonical event                   | KMET v1 validated metadata                                    |
| `kin_encode_archive(ptr,len)`  | Metadata length:u32, metadata, ciphertext      | KARC v1 archive                                               |
| `kin_decode_archive(ptr,len)`  | Complete KARC v1 archive                       | Metadata length:u32, metadata, ciphertext                     |
| `kin_plan_import(ptr,len)`     | Decrypted KINE history/context                 | KIMP v1 import plan                                           |
| `kin_clear()`                  | No arguments                                   | No return value; releases retained allocations/results/errors |

All operations are synchronous and bounded by the existing 64 MiB ABI limit.
Every operation clears previous success/error results before validating its
input. The host copies result bytes before another operation or memory growth.
`kin_clear` releases intentionally retained buffers; it does not guarantee
physical memory zeroization. `engine.dispose()` calls it, removes the shared
codec capability when owned by that engine, and drops the instance reference.
A disposed engine rejects replay and commands. Startup/lock ordering belongs to
the security shell; Rust does not manufacture authentication from a boolean.

### KCMD v1 intent transport

This is an independent command transport, not the canonical event layout. JS
writes these explicit capability/context fields; Rust selects event schemas,
constructs canonical payloads and validates command semantics.

| Offset | Width | Field                                                               |
| ------ | ----- | ------------------------------------------------------------------- |
| 0      | 4     | `KCMD`                                                              |
| 4      | 2     | Command transport version = 1                                       |
| 6      | 2     | Reserved zero                                                       |
| 8      | 2     | Action code (1�17, corresponding to the documented domain actions)  |
| 10     | 2     | Reserved zero                                                       |
| 12     | 16    | Supplied event ID                                                   |
| 28     | 16    | Authorized household ID                                             |
| 44     | 16    | Authorized actor ID                                                 |
| 60     | 16    | Authorized device ID                                                |
| 76     | 8     | Explicit timestamp:i64                                              |
| 84     | 8     | Explicit logical time:u64                                           |
| 92     | 16    | Entity ID; zero for Pulse                                           |
| 108    | 4     | Routine creation date/occurrence key; zero otherwise                |
| 112    | 1     | Item classification, Pulse value or Routine cadence; zero otherwise |
| 113    | 3     | Reserved zero                                                       |
| 116    | 8     | Pulse expiration:i64; zero otherwise                                |
| 124    | 4     | UTF-8 text length; zero for noncapture actions                      |
| 128    | N     | Text, only for Item/Handoff/Talk/Routine creation                   |

IDs and time are explicit browser capabilities. Capture commands use a supplied
random entity ID. Noncapture commands use the referenced entity ID. All unused
fields, reserved bytes, schema/enum/date/length values and strict UTF-8 are
validated. The native `HouseholdCommand` separates household intent from browser
identity/pairing operations. `execute` validates the existing corpus first,
requires a new event ID and logical time greater than observed history, checks
household context, rejects stale Routine occurrence intent, then rebuilds and
serializes the complete candidate. Persistence occurs only in the adapter's
successful transaction. Historic repeated completion facts retain prior replay
semantics.

KCMT v1 consists of `KCMT`, version:u16=1, reserved:u16=0,
event-length:u32, metadata-length:u32, projection-length:u32, then the three
buffers exactly. The projection is the existing KINS format for the request's
protocol. One command crossing returns all information needed for persistence.

### KMET v1 validated metadata

The result is exactly 92 bytes: `KMET`, version:u16=1, reserved:u16=0,
event/household/actor/device IDs (16 bytes each), timestamp:i64,
logical-time:u64, event-version:u16 and event-kind:u16. It is generated by Rust
after decoding the full canonical event. Browser storage/sync code consumes
structured metadata and never reads canonical offsets. Metadata is derived and
must be compared to authoritative decrypted bytes; it is not another source of
truth. Existing `encode*Record` JS exports are compatibility adapters over
`kin_encode_command` and require a loaded engine; they contain no event encoder.

`kin_event_metadata_batch(ptr,len)` validates a complete batch in one crossing.
Input KMDQ v1: magic, version:u16=1, reserved:u16=0, count:u32, then each
record length:u32 and canonical bytes. Output KMDL v1 has the same prefix/count
and exactly `count` consecutive 92-byte KMET records. Bounds remain 10,000 events
and 64 MiB. An invalid record rejects the complete batch. The JS
`eventMetadataBatch(records)` helper (also on the engine) returns metadata in
input order; EventStore uses it before replay to avoid one crossing per row.

### KARC v1 encrypted archive framing

v0.10.3 adds two compact framing operations while retaining the original
`kin_encode_archive` and `kin_decode_archive` exports and their byte layouts.
`kin_archive_header(ptr,len)` accepts exactly two little-endian u32 lengths
(metadata and ciphertext) and returns the validated 16-byte KARC v1 header.
`kin_archive_layout(ptr,len)` accepts that header plus the actual complete archive
buffer length:u32 (20 bytes total), validates the same bounds/version/reserved
fields/exact total length, and returns the two lengths (8 bytes). Rust remains
the framing authority; the browser copies opaque payload sections directly into
or out of its own buffers without routing their contents through WASM. These
operations do not authenticate ciphertext. The adapter returns detached copies
when decoding, so callers cannot mutate an archive input during asynchronous
authentication. Host ownership and ordinary ABI result lifetimes still apply.

Header: `KARC`, archive-version:u16=1, reserved:u16=0,
metadata-length:u32, ciphertext-length:u32, followed by exactly those two opaque
sections. Metadata must contain 1�1,048,576 bytes; ciphertext at least a 16-byte
AEAD tag; total archive size at most 64 MiB. Unknown versions, nonzero flags,
overflow/excess lengths, truncation and trailing bytes fail closed. Fixed single
sections cannot contain duplicate section identifiers. Browser cryptography
owns authentication and encrypted-body interpretation; successful framing parse
alone is not an integrity/authenticity claim. The archive adapter must authenticate
or compare all consequential public metadata before import.

After authenticating/decrypting the archive, `kin_plan_import` validates the
entire event history using the existing KINE contract. Duplicate event IDs
(including exact duplicates), conflicting identities, invalid state, unsupported
versions and an overflowing next logical counter fail before a plan is returned.
KIMP v1 is `KIMP`, version:u16=1, reserved:u16=0, event-count:u32,
next-logical-time:u64, projection-length:u32, and the KINS projection. It performs
no writes. The browser requires explicit restore approval and applies the
verified replacement atomically; a plan does not authorize restoring device trust.

Validation: native command/codec/archive tests, all historical protocol fixtures,
and `web/wasm/portable-core.test.mjs` exercise all 17 command variants, full
canonical metadata decoding, stale Routine rejection, archive/import corruption,
and disposed-engine capability rejection through the real release WASM.
