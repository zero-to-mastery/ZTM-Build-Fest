# v0.1.0 Canonical Test Vectors

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; earlier version sections are historical contracts. See Pulse and v0.6.0 below.

## Common envelope values

All IDs below are 16-byte values shown as 32 lowercase hexadecimal characters. Unless overridden, events use:

```text
household_id = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
actor_id     = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
device_id    = cccccccccccccccccccccccccccccccc
event_version = 1
protocol_version = 1
```

Timestamps are signed UTC Unix milliseconds. `local_sequence` is IndexedDB ordering metadata and is not encoded in the event payload. Text strings are exact UTF-8 values.

Unless a vector overrides a field, each event uses `event_version = 1`, the common household/actor/device IDs above, protocol version 1, and the timestamp, event ID, item ID, logical time, and local sequence shown in that vector. A vector that does not specify an ordering uses input order with `local_sequence` and `logical_time` starting at 1 and incrementing by one.

## Vector 001 — Add item

Input event at `local_sequence = 1`:

```text
kind          = ITEM_ADDED
event_id      = 00000000000000000000000000000001
item_id       = 11111111111111111111111111111111
timestamp     = 1760000000000
logical_time  = 1
text          = "Buy milk"
```

Expected state:

```text
household_id = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
items = [
  { item_id: 11111111111111111111111111111111,
    text: "Buy milk",
    created_by: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
    created_at: 1760000000000,
    status: active }
]
```

## Vector 002 — Multiple items

Input these complete events in `local_sequence` order, using the common envelope values above:

```text
Event 1
local_sequence = 1
kind = ITEM_ADDED
event_id = 00000000000000000000000000000001
item_id = 11111111111111111111111111111111
timestamp = 1760000000000
logical_time = 1
text = "Buy milk"

Event 2
local_sequence = 2
kind = ITEM_ADDED
event_id = 00000000000000000000000000000002
item_id = 22222222222222222222222222222222
timestamp = 1760000030000
logical_time = 2
text = "Restock wipes"
```

Expected: two independent active items in addition order. Neither item overwrites the other; item text is not an identity key.

## Vector 003 — Complete item

Input Vector 001 followed at `local_sequence = 2` by:

```text
kind          = ITEM_COMPLETED
event_id      = 00000000000000000000000000000002
item_id       = 11111111111111111111111111111111
timestamp     = 1760000060000
logical_time  = 2
```

Expected: the item remains present with the same text and `status = completed`.

## Vector 004 — Invalid reference

Input one event at `local_sequence = 1`:

```text
kind          = ITEM_COMPLETED
event_id      = 00000000000000000000000000000004
item_id       = ffffffffffffffffffffffffffffffff
timestamp     = 1760000000000
logical_time  = 1
```

There is no prior `ITEM_ADDED` for this item ID.

Expected: deterministic invalid-domain-event error (ABI status code 4), no result projection, and no partial state.

## Vector 005 — Duplicate event ID

Input the exact canonical Vector 001 event twice in one test replay.

Expected: the identical duplicate is idempotently ignored; exactly one active item results. If the duplicate has the same event ID but different canonical bytes (for example, changed text), expected result is deterministic integrity/domain failure (status code 4), never overwrite.

## Vector 006 — Replay determinism

Let `A` be the ordered input from Vector 003. Run `rebuild(A)` repeatedly.

Expected: each successful state is structurally identical, including item ordering and fields. Replay must not depend on ambient time, random values, map iteration order, network, or DOM state.

## Vector 007 — Repeated completion

Input Vector 003 followed at `local_sequence = 3` by this second event:

```text
kind          = ITEM_COMPLETED
event_id      = 00000000000000000000000000000003
item_id       = 11111111111111111111111111111111
timestamp     = 1760000120000
logical_time  = 3
```

Expected: successful replay; item remains completed. The distinct completion fact remains in history and is a state no-op. Exact delivery duplication is covered by Vector 005.

## Vector 008 — Unsupported version

Use either protocol version `2` in the request header or event version `2` on a record.

Expected: deterministic unsupported-version status (ABI status code 3), no partial result, and original event bytes remain preserved by the caller/storage layer.

## Vector 009 — Malformed payload

Provide a protocol-v1 request with `event_count = 1` and one event at `local_sequence = 1`:

```text
event_version = 1
event_kind = 1 (ITEM_ADDED)
event_id = 00000000000000000000000000000009
household_id = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
actor_id = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
device_id = cccccccccccccccccccccccccccccccc
timestamp = 1760000000000
logical_time = 1
payload_length = 22 bytes
payload = item_id[16] | text_length:u32 = 5 | UTF-8 bytes for "hi" (2 bytes)
```

The record's payload length is internally present (22 bytes), but its text length exceeds the two text bytes supplied.

Expected: deterministic malformed-protocol status (ABI status code 2), no crash, no partial result, and no IndexedDB append.

## Vector 010 — Household mismatch

Provide two `ITEM_ADDED` events in one request. The first uses the common envelope values above; the second uses the same actor/device but a different household:

```text
Event 1
local_sequence = 1
timestamp = 1760000000000
household_id = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
event_id = 00000000000000000000000000000001
item_id = 11111111111111111111111111111111
logical_time = 1
text = "Buy milk"

Event 2
local_sequence = 2
timestamp = 1760000030000
household_id = dddddddddddddddddddddddddddddddd
event_id = 00000000000000000000000000000002
item_id = 22222222222222222222222222222222
logical_time = 2
text = "Restock wipes"
```

Expected: deterministic invalid-event/domain status (ABI status code 4); the stream is rejected as a whole.

## Vector 011 — User text remains inert

Use Vector 001 with text exactly:

```text
<script>alert("x")</script>
```

Expected domain state preserves the exact string as text. Browser acceptance verifies it is rendered inertly as text, never executed or interpreted as markup; see [TESTING](TESTING.md) and [ACCESSIBILITY](ACCESSIBILITY.md).

## v0.2.0 Today + Needs vectors

The original vectors above remain protocol-v1/schema-v1 compatibility fixtures. The following cases use protocol v2 unless noted.

### Vector 012 — Classified add

Use event envelope values from Vector 001 with protocol version 2, event schema version 2, kind `ITEM_ADDED`, item ID `11111111111111111111111111111111`, text `"Restock wipes"`, and classification byte `1` (`Need`). The schema-v2 payload is `item_id[16] | classification:u8 | reserved[3]=0 | text_length:u32 | text`.

Expected: one active item with classification `Need`, exact text, and original add ordering.

### Vector 013 — Legacy add normalization

Replay the exact protocol-v1/schema-v1 bytes from Vector 001 using protocol v2.

Expected: the item is represented as classification `Today`; the source bytes remain byte-identical and the result is deterministic across replay.

### Vector 014 — Complete, reopen, archive

Apply Vector 012, then distinct schema-v1 events in increasing logical/local order: `ITEM_COMPLETED`, `ITEM_REOPENED`, and `ITEM_ARCHIVED`, each with a 16-byte reference to the added item.

Expected: final status `archived`, classification remains `Need`, and all four immutable source events remain in history.

### Vector 015 — Archived item mutation

Apply Vector 014 followed by a distinct `ITEM_REOPENED`, `ITEM_COMPLETED`, or `ITEM_ARCHIVED` event for the same item.

Expected: deterministic invalid-domain-event error (ABI status code 4), no partial projection, and no append to IndexedDB.

### Vector 016 — Protocol-v1 reserved bytes

Use a valid protocol-v1 result/request and set any reserved protocol-v1 byte to a nonzero value.

Expected: deterministic malformed-protocol error. Protocol v2 does not reinterpret any protocol-v1 reserved byte as classification or status.

### Vector 017 — Exact lifecycle payload lengths

For protocol v2, encode each of `ITEM_REOPENED` and `ITEM_ARCHIVED` with schema version 1. Try payload lengths 0 through 17, excluding 16, with the same valid event envelope.

Expected: every record fails with malformed-protocol status (ABI status code 2). The supported payload is exactly the referenced `item_id[16]`; no truncated or trailing payload bytes are reinterpreted.

### Vector 018 — Maximum classified replay

Construct 10,000 protocol-v2/schema-v2 `ITEM_ADDED` events in increasing logical/local order. Use unique event and item IDs, one shared household, one-byte UTF-8 text, and alternate classification `Need`/`Today`.

Expected: Rust derives 10,000 ordered active items with exactly 5,000 items in each classification. Protocol-v2 result encoding remains below 64 MiB and is byte-identical across repeated reconstruction. The equivalent real-WASM replay succeeds without stale output or memory-view reuse.

## Vector 019 — Handoff

Protocol 3, kind 5/schema 1, common envelope, handoff_id = 22222222222222222222222222222222, text = Dishwasher running. Result: unacknowledged Handoff with envelope author/time. Append kind 6/schema 1 with a distinct event ID and increasing logical time: acknowledged. Repeat acknowledgement: valid no-op. Append kind 7: archived. Subsequent mutation fails with code 4. Protocols 1/2 reject kinds 5–7 and Handoff output with code 3. Exact duplicate delivery is ignored; conflicting event-ID reuse fails.

## v0.3.1 correctness evidence

Handoff tests reject every shortened payload, overlong references, unsupported schemas, extreme lengths, invalid UTF-8 and whitespace-only domain text. Exact v3 result records and separate entity namespaces are checked. Actor provenance comes from envelopes; same and different acknowledging actors both succeed. Browser fault injection verifies event/counter rollback, retry once, and metadata mismatch preservation; Node tests reject malformed Handoff result fields and recover on the next call.

## v0.3.3 hardening evidence

Rust checks truncated Handoff request/event headers, reserved fields, extreme text lengths and a deterministic 10,000-event mixed projection. Real WASM tests reject every truncated Handoff result boundary and trailing bytes, observe memory growth during 10,000-Handoff replay, and verify independent host-owned results across success/error/empty/repeated calls. The complete earlier regression suite remains required.

## v0.4.0 Talk

Vector 020: protocol 4, schema 1, kind 8 adds an open topic; kind 9 resolves (repeated 9 is a valid no-op), 10 reopens (including open no-op), and 11 archives. Unknown references and archived mutations fail category 4. Earlier protocols reject every Talk kind/state with category 3. See [V0.4.0](V0.4.0.md).

## v0.4.1 correctness evidence

Talk correctness audit passes the full lifecycle matrix, every truncated payload, overlong references, unsupported schemas, empty/oversized/invalid UTF-8 and blank text, exact v4 records, malformed status/reserved/count/length fields and combined entity limits. Exact pre-Talk writer/result fixtures remain unchanged. Browser tests verify event/counter rollback, retry once, metadata preservation and invalid-transition non-append. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts and both launchers (page/WASM HTTP 200), and the complete Chrome 154.0.8037.59 browser suite on Windows x64/Node 22.12.0; POSIX via WSL. Previously listed platform/assistive-technology gaps remain.

## v0.4.3 hardening and final audit

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

Architecture/product/privacy audit confirms Rust-only reduction; separate Item/Handoff/Talk semantics; immutable canonical IndexedDB schema-1 events; no migration; unchanged v1/v2/v3 contracts and explicit v4; content-free invalidation; textContent rendering; same-origin static requests; no framework/runtime dependency, analytics, AI, remote service, sentiment, scores, blame, identity inference, resolver attribution or response metrics. Resolved is workflow state only and claims neither agreement nor an objective solution. No remaining release-blocking defect was found in exercised environments. Cross-browser, assistive-technology and native-zoom checks remain validation gaps, not certifications. No additional UI feature was added. Duplication remains manageable, so no orchestration refactor was introduced.

## v0.5.0 Pulse

Vector 021: actor A SET Drained at 1000ms, expiry 2000ms. as_of 1999 => active; 2000/2001 => expired; rollback to 1000 => active. SET replaces A only; CLEAR A twice succeeds; B remains independent. No expiry event. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

Vector 022: protocol v6 stream is `ITEM_ADDED(event 1, "Milk")`, `ITEM_COMPLETED(event 2, milk)`, `PULSE_SET(event 3)`, with cursor event 1. Expected summary: one `item-completed` entry with event ID 2, entity Item, text “Milk”, absent classification; `summary_total_count = 1`; through-event ID is 3, not 2. Pulse has no entry. A cursor absent from the stream fails category 4 rather than guessing.

Vector 023: ten meaningful changes followed by `PULSE_CLEARED(event 11)`, no cursor. Expected `summary_total_count = 10`, `summary_count = 8`, entries are meaningful events 3–10 in original order, omitted count is 2, and through-event ID is 11. No actor ID or event timestamp is part of any summary record. Exact protocol layout and browser race vectors are in [V0.6.0](V0.6.0.md).
