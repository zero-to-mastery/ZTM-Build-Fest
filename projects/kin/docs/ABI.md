# JavaScript–WASM ABI

**Status:** Protocol 24 is the only replay format (refactor track, Slice 2; owner decision D3). Protocols 1–23 and the schema-1 `ITEM_ADDED` payload were removed, not migrated; their contracts survive only in the release records. The Rust sources that implement this contract are `rust/src/wire.rs`, `request.rs`, `event_decode.rs`, `history.rs`, `state_encode.rs` (with `state_encode/records.rs`), `sections.rs`, `codec.rs`, `command.rs`, `archive.rs` and `abi.rs`. Refactor Slice 4 added the KINS section table and regrouped the body into one contiguous section per domain. Slice 6 moved the history into the engine instance (`kin_history_*`, `kin_project`, `kin_execute`) and removed the whole-history `kin_apply_events` and `kin_execute_command`. The version stays 24 because event encoding and the KINE layout are unchanged.

All multibyte integers are little-endian. IDs are exactly 16 opaque bytes and are never parsed, except for the bytewise tie-break in replay ordering. Text is strict UTF-8 with no terminator. Reserved fields must be zero. Decoders reject truncation, trailing bytes, overflow, unknown codes, invalid UTF-8 and unsupported versions; they never reinterpret a different layout.

## Exports and ownership

```text
kin_alloc(length) -> ptr             kin_free(ptr, length) -> status
kin_history_reset() -> status        empty the instance's history
kin_history_append(ptr, len)         append a record batch to the history
kin_history_truncate(count) -> status   keep the first `count` records
kin_project(ptr, len)                replay the history: KINE context -> KINS
kin_device_names(ptr, len)           replay the history: KINE context -> KDEV (v1.1)
kin_member_names(ptr, len)           replay the history: KINE context -> KMNM (v1.3)
kin_meals(ptr, len)                  replay the history: KINE context -> KMLS v1 (#333)
kin_meal_plans(ptr, len)             replay the history: KINE context -> KMLS v2 (#679)
kin_meal_shopping_plan(ptr, len)     KMPQ v1/v2 + KINE context -> KMSP (#333, #679)
kin_item_emojis(ptr, len)            replay the history: KINE context -> KIEM (#344)
kin_my_things(ptr, len)              KMTQ + KINE context -> KMTD (#344)
kin_week(ptr, len)                   KWKQ + KINE context -> KWKD (#417)
kin_shopping_sections(ptr, len)      replay the history: KINE context -> KSHS (#411)
kin_routine_rotations(ptr, len)      replay the history: KINE context -> KRRS (#429)
kin_sitter_page(ptr, len)            replay the history: KINE context -> KSIT (#442)
kin_album(ptr, len)                  replay the history: KINE context -> KALB (#673)
kin_chore_chart(ptr, len)            KCCQ + KINE context -> KCCD (#676)
kin_calendar_range(ptr, len)         KCAQ + KINE context -> KCAL (#656)
kin_ical_parse(ptr, len)             .ics file bytes -> KICS (#666); no household state
kin_chat_history_reset() -> status   empty the chat log (the text arena stays)
kin_chat_history_append(ptr, len)    append a chat record batch to the chat log
kin_chat_history_truncate(count) -> status   keep the chat log's first `count`
kin_chat_execute(ptr, len)           chat command: length + KCMD + admins + KINE context -> KCMT
kin_chat_page(ptr, len)              replay the chat log: KCHQ -> KCHP (v1.1)
kin_chat_search(ptr, len)            search the chat's decrypted texts: KCHF -> KCHR (v1.1)
kin_chat_text(ptr, len)              decrypted texts for the arena: KCHT -> KCHS
kin_chat_texts_clear() -> status     drop every decrypted chat text
kin_board_history_reset() -> status  empty the fridge log (#317)
kin_board_history_append(ptr, len)   append a board record batch to the fridge log
kin_board_history_truncate(count) -> status   keep the fridge log's first `count`
kin_board_execute(ptr, len)          fridge command: length + KCMD (52–58) + KINE context -> KCMT
kin_board_state(ptr, len)            replay the fridge log: KINE context -> KBRD
kin_private_history_reset() -> status   empty the member's private log (#489)
kin_private_history_append(ptr, len)    append a private record batch to the private log
kin_private_history_truncate(count) -> status   keep the private log's first `count`
kin_private_state(ptr, len)          replay the private log: KINE context -> KPRV
kin_private_execute(ptr, len)        private command: length + KCMD (100–199) + KINE context -> KCMT
kin_execute(ptr, len)                command: length + KCMD + KINE context -> KCMT
kin_encode_command(ptr, len)         KCMD -> canonical event bytes
kin_event_metadata(ptr, len)         one canonical event -> KMET
kin_event_metadata_batch(ptr, len)   KMDQ -> KMDL
kin_audio_peaks(ptr, len)            voice samples: KAPQ -> KAPR (v1.1)
kin_plan_import(ptr, len)            import plan of the history: KINE context -> KIMP
kin_archive_header(ptr, len)         two lengths -> 16-byte KARC header
kin_archive_layout(ptr, len)         KARC header + total length -> two lengths
kin_qr_encode(ptr, len)              UTF-8 text -> KQRM matrix (no crates; qr/)
kin_qr_decode(ptr, len)              width, height, luma -> QR payload bytes
kin_encode_archive / kin_decode_archive   whole KARC framing (retained)
kin_result_ptr/len, kin_error_ptr/len     the last call's result or error
kin_clear()                               drop every retained buffer (and QR scratch)
```

Pointers are byte offsets into the module's linear memory. Every operation
accepts only the exact pointer and length of a live `kin_alloc` buffer, clears
the previous result and error first, and publishes either a complete result or
a KERR error, never a partial result. Result and error bytes stay valid until
the next call or `kin_clear`; the host copies them before calling again and
re-reads `memory.buffer` after every call, since memory may grow. The host
frees each input exactly once on every exit path (`callCore` in
`web/wasm/kin-engine.js`); `kin_free` returns 1 for an unknown or mismatched
range and never frees an unrelated allocation. Requests and results are capped
at 64 MiB and 10,000 events (250,000 for the chat log).

`kin_alloc(0)` and a failed allocation return 0, which the host treats as
failure. Live allocations sit in a fixed table of 8 slots. The host holds one
input at a time, so a full table means a leaked allocation, and `kin_alloc`
returns 0. The browser's QR codec runs on its own instance and holds two at
most: its frame buffer and, briefly, an encode input. `kin_clear` releases
retained buffers, the history, the chat log and the chat-text arena (whose
bytes it zero-fills first); it does not promise physical erasure. `engine.dispose()`
calls it.

## Instance history (Slice 6)

Each engine instance holds one canonical history (`rust/src/history.rs`):
records in local arrival order, stored as received in one byte buffer with an
`(offset, length)` span per record. Projections and commands replay this
history; no call carries a whole history any more. Since Slice 9
`kin_plan_import` also takes a record-less context: the host fills the
instance's history with the archive's records being imported (the mirror
resets it to that history, in batches of about 4 MiB, and back to the
session's history on the next replay) and the plan is computed from it.

- `kin_history_append(ptr, len)` adds records after those held. Its input is
  `count:u32`, then `count` record lengths (u32 each), then the records back
  to back. Every record is checked (`decode_event`) before any is appended,
  so a failure leaves the history unchanged and publishes a KERR error. It
  publishes no result on success. The history is capped at 10,000 records
  and 64 MiB.
- `kin_history_truncate(count)` keeps the first `count` records (status 1 if
  `count` exceeds the history). It touches neither result nor error buffer.
- `kin_history_reset()` empties the history, zero-filling its bytes, and drops
  its checkpoint.
- `kin_project(ptr, len)` takes a KINE request whose `event_count` is 0 and
  which carries no records: its as_of, cursor, civil date, target household
  and bindings are the replay context. It publishes the KINS projection with
  stamped section revisions.
- `kin_execute(ptr, len)` takes `intent length:u32`, the KCMD intent, then such
  a record-less KINE context, and publishes KCMT. The history is not changed;
  the host appends the new event once it is stored.

The history also keeps a checkpoint (Slice 7): the replay state of its first
N records, built in one identity context (target household and bindings). A
projection or command applies only the records after N, if each of them has a
logical time strictly greater than the checkpoint's last one. A record at an
equal logical time could make an earlier decision concurrent with a new
archive, so it rebuilds instead. So does a different identity context, a
truncation below N, or an apply error. The result always equals a replay of
the whole history; `rust/src/history_tests.rs` checks this after every record
of every golden fixture. `kin_project` advances the checkpoint to the whole
history. `kin_execute` uses it and applies the command's event to a copy.

**The chat log (v1.1, #109).** Each instance also holds a second history,
the chat log, with the same layout, batches, checkpoint and mirror
(`kin_chat_history_*`). It takes chat records (kinds 44–50) only, and the
household history takes every other kind; either refuses the other's with
code 4, as does a whole KINE request carrying a chat record. The chat log
holds up to 250,000 records and 64 MiB. `kin_chat_execute` runs chat
commands against it (any other command fails with code 4, as a chat command
does against the household history). Its input is `intent length:u32`, the
KCMD intent, `admin count:u32` (at most 16), the household admins' member IDs
as the service reports them (16 bytes each, non-zero), `member count:u32` (at
most 64) and the IDs of the members who can read chat (the only ones a
mention may name, #130), then a record-less
KINE context. It publishes KCMT with an empty projection: a chat event changes
no projection, and applying it to a copy of the chat would copy all of it. `kin_chat_page` and `kin_chat_text` read the
chat log and the text arena (side formats below).

**The private log (#489, [ADR 0019](decisions/0019-member-private-log.md)).**
A fourth history holds the unlocked member's private records (kinds
100–199), with the same layout, batches, checkpoint and mirror
(`kin_private_history_*`). Every other history, and a whole KINE request,
refuses a private record with code 4; the private log refuses every other
kind the same way. It holds up to 50,000 records and 64 MiB, and every record
in it must have the same header actor (the member): a second author fails
replay with code 4. `kin_private_state` takes a record-less KINE context and
publishes KPRV (side formats below). `kin_private_execute` (#511,
`private_command.rs`) makes a new private event the way `kin_board_execute`
makes a fridge one: a u32 command length, a KCMD whose action is a private
kind (100–199) and whose text is the event's exact payload (zero entity ID,
date, option and expiry), then a record-less KINE context. It is validated
against the private log only (code 4: a full log, a logical time not after
the log's latest, a known event ID, a household other than the log's or the
context's target, an author other than the log's member, or the kind's own
rules, such as `PrivateItems::check_command` for 110–118 and
`JournalState::check_command` for the journal's 101–104, and
`private_prefs::check_command` for reminders and settings, 120–139, #520,
which refuse a change that changes nothing) and publishes KCMT
with an empty projection; the log is not changed until the host appends the
stored event. `web/wasm/kin-private.js` encodes the packets
(`encodePrivateIntent`; reminders and settings through
`web/wasm/kin-prefs.js` `encodePrefsIntent`) and `PrivateLog.execute` runs them under the
member's write lock. `kin_clear` empties the private log with the others.

Records stay where they were appended: the history keeps one buffer and an
`(offset, length)` span per record, and reads them as `EventView`s
(`event_decode.rs`). A view gives the header fields and the payload slice
without copying or decoding. Since Slice 8 only the records the checkpoint
has not applied are decoded into owned events. The catch-up summary reads the
event ID and a small borrowed extract (`SummaryInput`) from each view. Command
checks use what the replay already knows (its household, last logical time
and event IDs) instead of scanning the history.

The bridge keeps the instance's history equal to what a caller asks it to
replay (`web/wasm/history-mirror.js`). Views of the same session arena and
epoch send only the records added since the last call, or truncate for a
shorter view. Another arena, a new epoch or a plain array resets the instance
and sends that history whole. `historyWith(view, extras)` appends the extras
for one replay and truncates them afterwards. Growth reserves an eighth more
than the history holds, so appending a few events copies nothing.

## Status codes and KERR

`0` success, `1` invalid ABI pointer or range, `2` malformed protocol or
payload, `3` unsupported version or kind, `4` invalid domain event or state,
`5` size or allocation limit, `6` internal error, `7` no readable QR code in
the image. The same failure always maps
to the same code; messages are diagnostic only and never contain household
text. The error buffer is `KERR | version:u16 = 1 | code:u16 | length:u32 |
UTF-8 message`.

## KINE replay request (protocol 24)

```text
offset size field
0      4    "KINE"
4      2    protocol_version = 24
6      2    reserved = 0
8      4    event_count (<= 10,000)
12     8    as_of: i64 UTC milliseconds (|value| <= 8.64e15)
20     1    cursor_present (0 or 1)
21     3    reserved = 0
24     16   cursor event ID (all zero when absent)
40     4    civil date YYYYMMDD (years 1-9999)
44     16   target household ID (all zero = local replay)
60     2    identity_binding_count (<= 256; must be 0 for local replay)
62     2    reserved = 0
64     96*n identity bindings, then event_count canonical event records
```

A binding is three placeholder IDs (household, actor, device) followed by
three authenticated IDs (household, member, device). Its authenticated
household must equal the target; a duplicate placeholder tuple, a mismatch,
or an event from another household without a binding fails with code 4.
Bindings change only the replay identity; `canonical_bytes` keep the signed
source event. They are how history created before sync (with placeholder IDs
in its canonical bytes) replays after sync, so they are part of the current
contract, not a migration ([IDENTITY](IDENTITY.md)).

For `kin_project` and `kin_execute` the request is only the context: its
`event_count` must be 0 and nothing may follow the bindings; the events are
the instance history's records.

Replay reduces an owned copy sorted by `(logical_time, device_id, event_id)`;
equal logical times are valid. The catch-up summary uses input (local arrival)
order: its through event is the last input event, and a present cursor must
name an event in the input or the request fails with code 4. Exact duplicate
events are ignored; one event ID with different bytes fails with code 4.

## Canonical events

Each record is an 88-byte envelope followed by its payload:

```text
2  event_version (2 for ITEM_ADDED, 1 for every other kind)
2  event_kind
16 event_id
16 household_id
16 actor_id
16 device_id
8  timestamp: i64 UTC milliseconds
8  logical_time: u64
4  payload_length
N  payload
```

| Kind | Name | Payload |
| --- | --- | --- |
| 1 | ITEM_ADDED (schema 2) | item ID, classification u8 (0 Today, 1 Need, 2 Shopping, 3 Staple), 3 reserved, text length u32, text (1–4096 bytes) |
| 2–4 | ITEM_COMPLETED / REOPENED / ARCHIVED | item ID |
| 5 | HANDOFF_ADDED | handoff ID, text length u32, text |
| 6–7 | HANDOFF_ACKNOWLEDGED / ARCHIVED | handoff ID |
| 8 | TALK_ADDED | talk ID, text length u32, text |
| 9–11 | TALK_RESOLVED / REOPENED / ARCHIVED | talk ID |
| 12 | PULSE_SET | value u8 (0–4), 7 reserved, expires_at i64 |
| 13 | PULSE_CLEARED | empty |
| 14 | ROUTINE_CREATED | routine ID, cadence u8 (0 Daily, 1 Weekly, 2 every two weeks, 3 Monthly, 4 Weekdays), 3 reserved, created_on u32, text length u32, text |
| 15–16 | ROUTINE_OCCURRENCE_COMPLETED / REOPENED | routine ID, occurrence key u32 |
| 17 | ROUTINE_ARCHIVED | routine ID |
| 18–19 | AREA_CREATED / RENAMED | area ID, name length u32, name (1–96 bytes) |
| 20 | AREA_ARCHIVED | area ID |
| 21 | ITEM_AREA_CHANGED | item ID, area ID (zero clears) |
| 22–23 | NOTE_CREATED / UPDATED | note ID, area ID (zero = none), title length u32, body length u32, title, body |
| 24 | NOTE_ARCHIVED | note ID |
| 25 | ITEM_STEP_ADDED | item ID, step ID, text length u32, text (≤ 256 bytes) |
| 26–28 | ITEM_STEP_COMPLETED / REOPENED / ARCHIVED | item ID, step ID |
| 29 | HOUSEHOLD_MODE_CHANGED | mode u8 (0 Normal, 1 Vacation, 2 Guests, 3 Rest) |
| 30 | ITEM_PLANNING_DATE_CHANGED | item ID, date u32 (zero clears) |
| 31–32 | PIN_ADDED / REMOVED | target kind u8 (1 Item, 2 Note, 3 Routine, 4 Area), 3 reserved, target ID |
| 33 | PLAYBOOK_SAVED | playbook ID, title length u16, entry count u8 (1–16), reserved u8, title, then entries as u16 length + text |
| 34 | PLAYBOOK_ARCHIVED | playbook ID |
| 35 | REFERENCE_RECORD_SAVED | record ID, area ID, title length u16, field count u8 (1–16), reserved u8, title, then fields as field ID, label length u16, value length u16, label, value |
| 36 | REFERENCE_RECORD_ARCHIVED | record ID |
| 37 | MAINTENANCE_EVENT_SAVED | maintenance ID, record ID, performed u32, next u32 (zero = none), routine ID (zero = none), summary length u16, summary |
| 38 | MAINTENANCE_EVENT_ARCHIVED | maintenance ID |
| 39 | ATTACHMENT_BOUND | attachment ID, parent kind u8 (1 Note, 2 Reference Record, 3 Maintenance, 4 Item), parent ID |
| 40 | ATTACHMENT_REMOVED | attachment ID |
| 41 | RESPONSIBILITY_CHANGED | target kind u8 (1 Item, 2 Routine), target ID, member ID (zero clears) |
| 42 | DEVICE_DESCRIBED (v1.1) | name length u32, the header device's automatic name (1–48 characters, at most 192 bytes) |
| 43 | DEVICE_NICKNAMED (v1.1) | device ID (non-zero), nickname length u32 (zero clears), nickname (1–32 characters) |
| 44 | CHAT_MESSAGE_POSTED (v1.1, chat log) | message ID, content kind u8 (1 text, 2 attachment, 3 poll), option count u8 and multiple-choice u8 (both zero unless a poll), 1 reserved, blob ref (32), blob key (32): 84 bytes; a reply adds the ID of the message it answers (non-zero, not its own): 100 bytes |
| 45 | CHAT_MESSAGE_EDITED (v1.1, chat log) | message ID, blob ref (32), blob key (32): 80 bytes |
| 46 | CHAT_MESSAGE_DELETED (v1.1, chat log) | message ID, by_admin u8 (0 or 1), 3 reserved: 20 bytes |
| 47 | CHAT_REACTION_SET (v1.1, chat log) | message ID, on u8 (0 or 1), 3 reserved, emoji length u32, the emoji's UTF-8 (one emoji grapheme, 1–32 bytes) |
| 48 | CHAT_PIN_SET (v1.1, chat log) | message ID, on u8 (0 or 1), 3 reserved: 20 bytes |
| 49 | CHAT_POLL_VOTE (v1.1, chat log) | message ID, choice u16 (bit n is option n; 0 clears), 2 reserved: 20 bytes |
| 50 | CHAT_POLL_CLOSED (v1.1, chat log) | message ID, 4 reserved: 20 bytes |
| 51 | MEMBER_NAMED (v1.3) | name length u32 (zero clears), the header actor's own preferred name (1–32 characters) |
| 59 | RECIPE_SAVED (#333) | recipe ID [16], name (u16 length + UTF-8), ingredient count u8, reserved u8, each ingredient: staple flag u8 (0 or 1) + 3 reserved, staple item ID [16] when flagged, text (u16 + UTF-8); notes (u16 + UTF-8). At most 4,352 bytes after the ID |
| 60 | RECIPE_ARCHIVED (#333) | recipe ID [16] |
| 61 | DINNER_SET (#333) | civil date u32 (YYYYMMDD), recipe flag u8 (0 or 1) + 3 reserved, recipe ID [16] when flagged, name (u16 + UTF-8) |
| 62 | DINNER_CLEARED (#333) | civil date u32 |
| 63 | DINNER_COOK_SET (#333) | civil date u32, member flag u8 (0 or 1) + 3 reserved, member ID [16] when flagged (absent: "No one yet") |
| 64 | ITEM_EMOJI_SET (#344) | item ID [16], emoji flag u8 (0 or 1) + 3 reserved, emoji (u16 + UTF-8, one grapheme, at most 32 bytes) when flagged (absent: cleared) |
| 65 | CHAT_TOPIC_SET (#312, chat log) | message ID, state u8 (0 cleared, 1 open, 2 resolved), 3 reserved: 20 bytes |
| 66 | SHOPPING_SECTIONS_SET (#411) | section count u16 (0–30), reserved u16, then each section: section ID [16] (non-zero, unique), name (u16 length + UTF-8; trimmed, 1–40 bytes, no controls) |
| 67 | ITEM_SECTION_SET (#411) | item ID [16] (non-zero), section ID [16] (all zero: none): 32 bytes |
| 68 | ROUTINE_ROTATION_SET (#429) | routine ID [16] (non-zero), member count u8 (0, or 2–12), current index u8 (below the count; 0 when the count is 0), reserved u16, then each member ID [16] (non-zero, no repeats): 20 + 16 × count bytes. An empty list ends the rotation |
| 69 | ROUTINE_TURN_SET (#429) | routine ID [16] (non-zero), member ID [16] (non-zero): 32 bytes |
| 70 | SITTER_PAGE_SET (#442) | entry count u16 (0–30), reserved u16, then each entry: kind u8 (1 note, 2 reference record, 3 routine), 3 reserved, record ID [16] (non-zero; no entry twice); then the intro (u16 length + UTF-8; trimmed, 0–500 bytes, no controls but newline) |
| 75 | ALBUM_PHOTO_ADDED (#673) | photo ID [16] (non-zero), attachment ID [16] (starts `a1 b0`, not the prefix alone), caption (u16 length + UTF-8; trimmed, 0–200 bytes, no control characters) |
| 76 | ALBUM_PHOTO_REMOVED (#673) | photo ID [16] (non-zero): 16 bytes |
| 80 | MEAL_SET (#679) | civil date u32 (YYYYMMDD), slot u8 (1 breakfast, 2 lunch, 4 snack; never 3 dinner) + 3 reserved, recipe flag u8 (0 or 1) + 3 reserved, recipe ID [16] when flagged, name (u16 + UTF-8, as a dinner's) |
| 81 | MEAL_CLEARED (#679) | civil date u32, slot u8 (1, 2 or 4) + 3 reserved: 8 bytes |
| 82 | RECIPE_FAVOURITE_SET (#679) | recipe ID [16] (non-zero), favourite u8 (0 or 1) + 3 reserved: 20 bytes |
| 100 | PRIVATE_NOTE_SET (#489, private log) | note ID [16] (non-zero), text length u32 (0 removes the note; at most 2,048 bytes), UTF-8 text (no control characters except line feed). Reserved: still decoded; no surface writes it. Kinds without a definition in 100–199 fail with code 3 |
| 101 | JOURNAL_ENTRY_CREATED (#498, private log) | entry ID [16] (non-zero), civil date u32 (YYYYMMDD, a real date), title length u16 (≤ 200), photo count u8 (≤ 10), reserved u8, body length u32 (≤ 20,000), title (UTF-8, no controls, trimmed), body (UTF-8, no controls but line feed, trimmed), then each photo (136 bytes): type u8 (1 JPEG, 2 PNG, 3 WebP), reserved [3], sealed size u32 (29 to 4 MiB + 4 KiB), blob reference [32], key [32], thumbnail reference [32], thumbnail key [32] (all non-zero; no reference twice in an entry). Title, body or a photo is required |
| 102 | JOURNAL_ENTRY_EDITED (#498, private log) | as 101: the whole new content |
| 103 | JOURNAL_ENTRY_DELETED (#498, private log) | entry ID [16] (non-zero): 16 bytes |
| 104 | JOURNAL_ENTRY_RESTORED (#498, private log) | entry ID [16] (non-zero): 16 bytes |
| 120 | REMINDER_SET (#522, private log) | target kind u8 (1 item, 2 routine), 3 reserved, target ID [16] (non-zero), due instant i64 (Unix ms), UTC offset i16 (minutes, −720 to 840), zone length u8 (0–64), reserved u8, zone (ASCII letters, digits and `/ _ + -`): 32 + length bytes |
| 121 | REMINDER_CLEARED (#522, private log) | target kind u8, reason u8 (1 canceled, 2 done, 3 dismissed), 2 reserved, target ID [16], instant i64: 28 bytes |
| 130 | SETTING_SET (#525, private log) | key u16 (1–255), value length u8 (0–32), reserved u8, value (`a-z 0-9 -`; keys 1–7 take only their listed values): 4 + length bytes. 122–129 and 131–139 are reserved for reminders and settings |

Fixed-length payloads must have exactly their length. Text, title and bound
details beyond the byte layout (trimming, scalar counts, controls, per-entity
limits) are domain validation in `state.rs` and fail with code 4.

Device names (kinds 42 and 43, added in v1.1 without a protocol change) are
the exception: their names must already be canonical in the event, so the
decoder fails a name with surrounding whitespace, a control character, a
disguising format character (bidirectional controls, zero-width space, word
joiner, soft hyphen, byte-order mark; zero-width joiner and non-joiner are
allowed) or too many characters with code 2. Once decoded, a device-name
event never fails replay, because names are cosmetic (`replay/devices.rs`): a
device keeps the member that first described it, an event from another member
changes nothing, and a nickname for a device this history has not seen
described is kept as a nickname-only entry. The latest description and
nickname in replay order win. Commands enforce the strict rules. Device names are not part of KINS: they leave the engine
only through `kin_device_names`. An engine older than v1.1 fails both kinds
with code 3 (unsupported).

A member's preferred name (kind 51, #224, added in v1.3 without a protocol
change) follows the same canonical-name rules, at most 32 characters, and an
empty name clears it. It always names the event's own header actor (after
identity bindings), so no event can name another member. Once decoded it never
fails replay; the latest name in replay order wins, so devices converge however
events arrive. Member names are not part of KINS: they leave the engine only
through `kin_member_names`. An engine from before this addition fails kind 51
with code 3 (unsupported).

Chat events (kinds 44–50, v1.1, no protocol change) belong to the chat log
(above). A zero message ID, blob ref or key, an unknown content kind, a
`by_admin` other than 0 or 1, or a non-zero reserved byte fails with code 2.
Once decoded, a chat event never fails replay (`replay/chat.rs`): one that
conflicts with what the log knows is kept and changes nothing
([EVENTS](EVENTS.md#v110-household-chat) has the rules). An engine older than
v1.1 fails all three with code 3.

## KINS projection (protocol 24)

The 96-byte header holds `"KINS"`, version 24, reserved 0, then u32 counts:

```text
8  items      12 handoffs   16 talks      20 pulses
24 summary entries          28 summary total count
32 through_present u8, 33-35 reserved, 36 through event ID (16)
52 routines   56 areas      60 notes      64 steps
68 mode u8, 69-71 reserved
72 pins       76 playbooks  80 reference records
84 maintenance events       88 attachments           92 responsibilities
```

A 112-byte section table follows the header: one entry per domain section,
`revision u32, byte length u32`, in body order (`rust/src/sections.rs`). The
lengths cover the body exactly; a decoder rejects a table that does not.

| # | Section | Contents, in order |
|---|---|---|
| 0 | Items | Item records; one Area ID per Item; Steps; one planning date per Item; one last-changed timestamp per Item |
| 1 | Handoffs | Handoff records |
| 2 | Talks | Talk records |
| 3 | Pulses | Pulse records |
| 4 | Routines | Routine records; one next-occurrence date per Routine |
| 5–12 | Areas, Notes, Pins, Playbooks, Reference Records, Maintenance events, Attachments, Responsibilities | their records |
| 13 | Summary | summary entries |

Records:

- Items: item ID, created_by, created_at i64, classification u8, status u8
  (0 active, 1 completed, 2 archived), 2 reserved, text length u32, text.
  Then one Area ID per Item (zero = none); the Steps, grouped by Item in Item
  order: item ID, step ID, completed u8, archived u8, 2 reserved, text length
  u32, text; one planning date u32 per Item (zero = none); one last-changed
  timestamp i64 per Item (latest effective Item or Step event).
- Handoffs: handoff ID, created_by, created_at i64, status u8
  (0 unacknowledged, 1 acknowledged, 2 archived), 3 reserved, text length, text.
- Talks: talk ID, created_by, created_at i64, status u8
  (0 open, 1 resolved, 2 archived), 3 reserved, text length, text.
- Pulses (40 bytes each, ordered by actor): actor ID, set_at i64,
  expires_at i64, value u8, status u8 (0 active, 1 expired), 6 reserved.
- Routines: routine ID, created_by, created_at i64, created_on u32,
  occurrence key u32 (zero = none today), cadence u8, archived u8,
  occurrence u8 (0 none, 1 open, 2 completed), reserved u8, text length, text.
  Then one next-occurrence date u32 per Routine (zero when archived or past
  9999-12-31; otherwise later than the current key).
- Areas: area ID, archived u8, 3 reserved, name length u32, name.
- Notes: note ID, created_by, updated_by, created_at i64, updated_at i64,
  area ID, archived u8, 3 reserved, title length u32, body length u32, title, body.
- Pins (20 bytes each): target kind u8, 3 reserved, target ID.
- Playbooks: playbook ID, archived u8, entry count u8, title length u16,
  2 reserved, title, then entries as u16 length + text.
- Reference Records: record ID, area ID, title length u16, field count u8,
  archived u8, title, then fields as field ID, label length u16, value
  length u16, label, value.
- Maintenance events: maintenance ID, record ID, performed u32, next u32,
  routine ID, archived u8, reserved u8, summary length u16, summary.
- Attachments (36 bytes each): attachment ID, parent kind u8, removed u8,
  2 reserved, parent ID.
- Responsibilities (33 bytes each): target kind u8, target ID, member ID.
- Summary entries (at most 8): event ID, kind u8 (1–15), entity kind u8
  (1 Item, 2 Handoff, 3 Talk, 4 Routine), classification u8 (255 when
  absent; present only for item-added), reserved u8, text length u32, text.

Collections keep original add order and include archived tombstones, so the
browser filters views without reducing state. An empty household is exactly
the header and a table of zero lengths (208 bytes). Counts are bounded (10,000
combined entities, 32 Areas, 128 Notes, 16 Steps per Item, 10 Pins, 32
Playbooks, 128 Reference Records, 8,192 Maintenance events, 256 attachments)
and the whole result by 64 MiB.

### Section revisions

A revision tells the host whether a section changed since the last projection
from the same engine instance, so it can skip decoding and rendering an
unchanged section.

- The ABI stamps revisions on the projections returned by `kin_project`
  and `kin_execute`. Each section's counter starts at 0 per instance
  and increases by one (wrapping past `u32::MAX` to 1, never 0) whenever that
  section differs from the same section of the last projection the instance
  emitted. The comparison is exact: the section bytes and the header fields
  that describe it (its counts; for the summary also the total and through
  event, bytes 24–51). An unchanged section keeps its revision.
- The previous projection is the buffer the instance already retains as its
  last result (for a command, the whole KCMT result), moved aside rather than
  copied. Tracking costs one byte comparison per section. While a projection
  call runs, the old and the new result are both alive, so peak memory is up
  to two results instead of one. Between calls one result is retained, as
  before. A non-projection call in between keeps the old projection as the
  comparison basis, so it can outlive that call until the next projection or
  `kin_clear`. `kin_clear` drops it but
  keeps the counters, so a later projection advances every section instead of
  reusing a revision the host may still hold.
- Revision 0 means unversioned. The pure encoder and the KIMP projection
  write 0, and the host always decodes such a section.
- Revisions are a rendering aid, not part of replay or authority. They do not
  depend on event encoding, and equal history still yields identical section
  bytes. The golden fixtures hold a fresh instance's first projection, where
  every revision is 1.

The bridge keys reuse on the engine instance as well as the revision. A
revision is meaningful only within one instance.

## QR codes (#94, #95)

The engine writes and reads QR codes itself (`rust/src/qr/`, ISO/IEC 18004,
byte mode, level M, versions 1–10, about 200 bytes). The browser only draws
the matrix and reads the camera. Pairing links carry their secrets in the URL
fragment, so the payload never reaches a server log or `Referer`.

- `kin_qr_encode(ptr, len)`: the input is the text's UTF-8 bytes. The result
  is `KQRM | version:u16 = 1 | reserved:u16 = 0 | side:u32 | side*side bytes`,
  one byte per module in row-major order (1 dark, 0 light), with no quiet
  zone. Empty input is `2`; more than 213 bytes is `5`; invalid UTF-8 is `2`.
  The encoder itself works in fixed arrays sized for version 10; only the
  returned result buffer is allocated.
- `kin_qr_decode(ptr, len)`: the input is `width:u32 | height:u32 | luma`, where
  luma is `width*height` bytes of 8-bit grayscale, row-major. The result is the
  decoded payload bytes.
  - A zero size, or a luma length that doesn't equal `width*height`, is `2`.
  - A frame wider or taller than 1280, or with more than 921 600 pixels
    (1280 × 720), is `5`.
  - A frame with no symbol Kin can read is `7`.
  - Light-on-dark symbols are read: the decoder retries the frame inverted when
    the first pass fails.
  - Each pass has a work budget of 4 000 000 units, charged for scan pixel
    reads, alignment template checks, finder comparisons, timing samples and
    triangle attempts, so a noisy frame stops instead of searching on. Fixed
    linear passes over the frame are bounded by the frame limits instead.
  - At most 256 finder candidates are kept. Triangles from the 32 strongest
    are ranked by timing-pattern agreement, and up to 12 are tried. A frame
    with 30 or more finder-like patterns as strong as the symbol's own can
    lose the symbol, and so can one with more than 256 weaker multi-row
    patterns ahead of it in raster order (the table fills first). Either way
    it is refused, not misread. The slowest adversarial frame measured (dense
    finder-like tiles over all of 1280 × 720) took 36 ms natively.
  - The decoder's working memory (about 4.7 MB at 720p) is kept between calls,
    so its scratch doesn't grow for frames of the same size. The browser's QR
    codec (`web/wasm/kin-qr.js`, its own engine instance) keeps one frame
    input buffer per frame size and writes luma straight into it; each decode
    still allocates its small result buffer. `kin_clear` frees the scratch for
    reuse; WASM linear memory itself never shrinks.

Link sizes: an invitation link is the origin plus 20 bytes
(`/pair#code=F7KM-Q2DX`); a sign-in link is the origin plus 157 bytes
(`/link#r=` 32 hex, `&s=` 43 base64url, `&f=` the 32-byte fingerprint as 43
base64url, `&c=` a 22-character nonce). Both fit the 213-byte limit for any
origin up to 56 bytes. A longer origin can't show a sign-in QR
code: the computer says the code couldn't be drawn, and the computer signs in
with a passkey or a pairing code instead.

Limits of the decoder: version 1 symbols (up to 14 bytes) can fail on
perspective frames, because the fourth corner cannot be pinned without an
alignment pattern. Invitation and sign-in links are much longer, so they are
unaffected. Multi-segment symbols (mixed text modes) are refused, not
partially read. The decoder reads what a camera shows of a screen; it is not
tuned for printed codes under heavy blur.

## Side formats

- **KCMD v1** (command intent): `"KCMD"`, version 1, reserved, action code u16,
  reserved, then explicit event ID, household, actor, device, timestamp i64,
  logical time u64, entity ID, a u32 date field (Routine key or planning
  date), a u8 field (classification, Pulse value, cadence or mode), 3 reserved,
  Pulse expiry i64, payload length u32 and the action payload (128-byte fixed
  part). JS supplies identity, time and randomness; Rust chooses the event
  schema, builds the canonical payload and validates the command. Step
  commands carry the parent Item ID first in their payload. The entity ID is
  always the command's own entity, chosen by action (`ENTITY_FIELDS` in
  `web/wasm/kin-engine.js`). References to other entities (a note's or
  reference record's Area, a maintenance entry's record and Routine, a Step's
  Item, an attachment's parent) travel in the payload and never become the
  entity ID.
- **KCMT v1** (command result): `"KCMT"`, version 1, reserved, then event,
  metadata and projection lengths (u32 each) and the three buffers. Execution
  validates the history, requires a fresh event ID and a logical time above
  history, rejects stale Routine intents and Item completions or reopenings
  that would not change status, and returns the KINS projection of the
  candidate history (the instance history plus the new event, which is not
  kept).
- **KMET v1** (92 bytes): `"KMET"`, version 1, reserved, event/household/
  actor/device IDs, timestamp i64, logical time u64, event version u16, kind
  u16. **KMDQ v1 / KMDL v1** batch these: `"KMDQ"`, version, reserved, count,
  then length-prefixed events; the result is `"KMDL"` with the same prefix and
  `count` KMET records. One invalid record rejects the batch.
- **KDEV v1** (device names, `kin_device_names`): `"KDEV"`, version 1,
  reserved u16, device count u32, then per device in device-ID order: device
  ID, member ID (16 bytes each, after identity bindings), automatic-name
  length u16 (zero for a nickname-only entry), nickname length u16 (zero
  when none), the automatic name and the nickname (UTF-8). Every entry has at
  least one of the two names. The context is a record-less KINE request, as for
  `kin_project`. KCMD action 42 (`describe-device`) carries the name as its
  payload and a zero entity ID; action 43 (`nickname-device`) carries the
  target device as its entity ID and the nickname as its payload (empty
  clears). Executing either rejects a name that would change nothing.
- **KPRV v1** (a member's private projection, `kin_private_state`, #489,
  [ADR 0019](decisions/0019-member-private-log.md)): `"KPRV"`, version 1,
  reserved u16, member ID (16 bytes, zero while the log is empty), record
  count u32, section count u16, reserved u16; then each section: code u16,
  reserved u16, byte length u32, bytes. Sections ascend by code, each at most
  once, and a reader skips codes it doesn't know: later stories extend KPRV by
  adding sections. Section 1 (notes, the placeholder kind 100): note count
  u32, then each note in ascending ID order: ID [16], logical time u64,
  device ID [16], text length u32, text. Section 11 ("Just for me", #510,
  `private_items.rs`), present once the member has a private item or has
  set the Today setting: flags u32 (bit 0: dated items stay off Today and
  This week; other bits zero), live item count u32 (at most 2,000), then
  each live item in ascending ID order: ID [16], added timestamp i64, last
  change logical time u64, date u32 (0 none), status u8 (0 open, 1 done), 3
  zero bytes, text length u32, note length u32, text, note. Deleted items
  are left out.
  Section 12 (reminders, #522; present once there is one):
  count u32, then each in ascending target order (kind, then ID): target
  kind u8, 3 reserved, target ID [16], instant i64, UTC offset i16, zone
  length u8, reserved u8, logical time u64, device ID [16] (of the event
  that set it), zone. Section 13 (settings, #525): count u32, then each in
  ascending key order: key u16, value length u8, reserved u8, logical time
  u64, device ID [16], value (present once one is set).
  Section 101 (the journal, #498), present once the member
  has written an entry: entry count u32, then each live entry newest first (date descending, then
  later-created first, then ID): ID [16], created logical time u64, updated
  logical time u64, device ID [16] (of the latest change), date u32, title
  length u16, photo count u8, reserved u8, body length u32, title, body, then
  the photos as in kind 101. `web/wasm/kin-private.js` decodes them all
  (sections 12 and 13 through `web/wasm/kin-prefs.js`).
- **KBRD v1** (the fridge, `kin_board_state`, #317, [ADR 0011](decisions/0011-family-fridge.md)):
  `"KBRD"`, version 1, reserved u16, visible stroke count u32, visible magnet
  count u32, open-clear flag u8 + 3 reserved, open clear ID (16 bytes, zero
  when none); then each visible stroke in drawing order: ID, author (16 bytes
  each), colour u8 (palette index 0–7), width u8 (0–2), point count u16 and
  the points as absolute (x u16, y u16); then each visible magnet bottom to
  top: ID, author, content kind u8 (1 emoji, 2 Kin-drawn, 3 note), Kin
  number u8 (1–12, else 0), x u16, y u16, text length u16 and the UTF-8 text.
  The context is a record-less KINE request against the board log. KCMD
  actions 52–58 carry the board event's exact payload (below) as their text,
  with a zero entity ID and no option, date or expiry; `kin_board_execute`
  takes a u32 command length, the KCMD and the context, and only the board
  log accepts them.
- **Meals** (#333, [ADR 0012](decisions/0012-meals.md), `meals.rs`): kinds
  59–63 above are decoded strictly — text already canonical (whitespace runs
  collapsed and trimmed; notes keep their lines), flags 0 or 1 with zero
  reserved bytes, IDs non-zero, nothing left over — so they re-encode to the
  same bytes. Once decoded, a meals event never fails replay: a dinner naming
  a recipe the history lacks and an archive of an unknown recipe change
  nothing, an archived recipe stays archived, and caps are command rules.
  KCMD actions 59–63 carry the exact payload as their text, with a zero
  entity ID and no option, date or expiry, through `kin_execute`; Rust checks
  them against the current meals and items (`MealsState::check_command`).
- **KMLS v1** (meals, `kin_meals`): `"KMLS"`, version 1, reserved u16, recipe
  count u32, dinner count u32; then each active recipe in the order first
  saved: ID [16], name (u16 + UTF-8), ingredient count u8 + 3 reserved, each
  ingredient: staple status u8 (0 none, 1 active staple, 2 archived or
  missing) + 3 reserved, staple ID [16] (zero when none), text (u16 + UTF-8);
  notes (u16 + UTF-8); then each dinner from 35 days before the context's
  civil date to 370 after, ascending: date u32, flags u8 (bit 0 recipe, bit 1
  cook) + 3 reserved, recipe ID [16], cook member ID [16] (zero when absent),
  name as shown (an active recipe's current name, else the snapshot).
- **KMPQ v1 / KMSP v1** (the Shopping plan, `kin_meal_shopping_plan`): the
  32-byte query `"KMPQ"`, version 1, reserved u16, source u8 (1 recipe, 2 a
  date's dinner) + 3 reserved, recipe ID [16] (zero for a date), date u32
  (zero for a recipe), then a record-less KINE context. The result `"KMSP"`,
  version 1, reserved u16, line count u32, then each line: outcome u8 (1 add,
  2 re-add staple, 3 already on Shopping) + 3 reserved, staple ID [16] (zero
  unless re-added), text (u16 + UTF-8). Lines with the same text (collapsed,
  lowercased) count once; "already on Shopping" compares against active
  Shopping items the same way. A one-off dinner or an unknown or archived
  recipe fails with code 4.
- **Fuller meal plans (kinds 80–82, #679,
  [ADR 0022](decisions/0022-family-hub.md) §7).** The payloads are strict like
  the other meals kinds: a slot of 1, 2 or 4 (dinner stays on kinds 61–63),
  zero reserved bytes, a 0/1 flag word, a non-zero recipe ID and a canonical
  name, so they re-encode to the same bytes; anything else fails with code 2.
  KCMD actions 80 (`set-meal` `{ date, slot, recipeId?, name }`), 81
  (`clear-meal` `{ date, slot }`) and 82 (`set-recipe-favourite`
  `{ recipeId, favourite }`) carry the exact payload as their text with a
  zero entity ID and no option, date or expiry (`kin-meals.js`). Rust checks
  them against the current meals (`MealsState::check_command`, code 4): a
  recipe that exists and isn't archived, named as it is now; a meal to clear;
  and a change.
- **KMLS v2** (every meal and favourites, `kin_meal_plans`, #679): a new
  export, so KMLS v1 and `kin_meals` are unchanged. `"KMLS"`, version 2,
  reserved u16, recipe count u32, meal count u32; then each active recipe as
  in v1, except that the byte after the ingredient count holds flags (bit 0
  favourite) and two reserved bytes follow it; then each meal in the same
  window as v1's dinners, by date then slot: date u32, slot u8 (1 breakfast,
  2 lunch, 3 dinner, 4 snack), flags u8 (bit 0 recipe, bit 1 cook; a cook
  only on dinner), 2 reserved, recipe ID [16], cook member ID [16] (zero when
  absent), name as shown. JavaScript decodes either version
  (`decodeMeals`: `{ recipes, dinners, meals }`); the app reads v2.
- **KMPQ v2** (#679): the same 32 bytes as v1 with version 2, where byte 9 is
  a slot for source 3 and zero otherwise, and two sources are added: 3, a
  date's meal in that slot (slot 3 is the same as source 2), and 4, every
  meal with a recipe in the seven days from the date (which needs six more
  days before 9999-12-31, as KWKQ). The week's lines come day by day, each
  day's meals in slot order, each recipe once, and lines with the same text
  count once across recipes; a week without recipes is an empty plan, not an
  error. The result is KMSP v1. A v1 query reads as before and never takes a
  slot or sources 3–4 (code 2); versions other than 1 and 2 fail with code 3.
- **Item pictures (kind 64, #344).** The payload is strict like meals: a
  non-zero item ID, a 0/1 flag word with zero reserved bytes, and one emoji
  as `chat::check_emoji` accepts it; it re-encodes to the same bytes. KCMD
  action 64 (`set-item-emoji`) carries the exact payload as its text with a
  zero entity ID and no option, date or expiry; Rust checks it against the
  current items (`PicturesState::check_command`).
- **KIEM v1** (item emoji, `kin_item_emojis`): `"KIEM"`, version 1, reserved
  u16, count u32, then for each item that exists and isn't archived, in item
  ID order: item ID [16], emoji (u16 + UTF-8).
- **Store sections (kinds 66–67, #411).** The payloads are strict like
  meals: they re-encode to the same bytes, so an untrimmed name, a zero or
  repeated section ID or more than 30 sections fail with code 2. KCMD actions
  66 (`set-shopping-sections`) and 67 (`set-item-section`) carry the exact
  payload as their text with a zero entity ID and no option, date or expiry;
  the host trims names first (`kin-sections.js`). Rust checks them against
  the current state (`StoreSectionsState::check_command`, code 4): names
  unique ignoring case, the list changed; the item exists and isn't archived,
  the section is listed (or none), and the item's shown section changes.
- **KSHS v1** (store sections, `kin_shopping_sections`): `"KSHS"`, version 1,
  reserved u16, section count u32, then each section in the household's
  order: section ID [16], name (u16 + UTF-8); then item count u32 and, for
  each item that exists, isn't archived and whose section is in the list, in
  item ID order: item ID [16], section ID [16]. Items without a listed section
  are absent. The KINS projection is unchanged: its section table is part of
  replay protocol 24, so new domains get their own export, as item pictures
  did.
- **Routine rotations (kinds 68–69, #429).** The payloads are strict like
  store sections: they re-encode to the same bytes, so one member, more than
  12, a repeated or zero member, an index outside the list, or a non-zero
  index with an empty list fail with code 2. KCMD actions 68
  (`set-routine-rotation` `{ routineId, memberIds, currentIndex }`) and 69
  (`set-routine-turn` `{ routineId, memberId }`) carry the exact payload as
  their text with a zero entity ID and no option, date or expiry
  (`kin-rotations.js`). Rust checks them against the current state
  (`RotationsState::check_command`, code 4): the routine exists and isn't
  archived; a rotation changes the list or the turn, and ending one needs
  one; a turn needs a rotation that lists the member, who isn't already
  current. While a routine rotates, `change-responsibility` for it fails with
  code 4: its owner is whoever's turn it is.
- **KRRS v1** (routine rotations, `kin_routine_rotations`): `"KRRS"`,
  version 1, reserved u16, count u32, then for each routine that exists,
  isn't archived and rotates, in routine ID order: routine ID [16], member
  count u8 (2–12), current index u8, next index u8 (the one after current,
  wrapping), reserved u8, then each member ID [16] in turn order. JavaScript
  decodes it as `[{ routineId, memberIds, current, next }]` (member IDs).
  Every listed member counts: membership isn't in the history, so the host
  passes over inactive members (`turnAmong`, [ADR 0016](decisions/0016-routine-rotations.md)).
  The current member is also the routine's responsibility in KINS, so
  KMTD and KWKD follow the turn; KINS is unchanged.
- **The sitter page (kind 70, #442).** The payload is strict like store
  sections: it re-encodes to the same bytes, so an untrimmed intro, a control
  character other than newline, more than 500 intro bytes, an unknown entry
  kind, a zero ID, an entry twice or more than 30 entries fail with code 2.
  KCMD action 70 (`set-sitter-page`) carries the exact payload as its text
  with a zero entity ID and no option, date or expiry; the host trims the
  intro and turns line breaks into `\n` first (`kin-sitter.js`). Rust checks
  it against the current state (`SitterPageState::check_command`, code 4):
  every entry names a note, reference record or routine of its kind that
  exists and isn't archived, and the page changes. Only Adults may send it:
  Rust can't tell member kinds apart, so the host's command append path
  refuses it for anyone else (`canChangeSitterPage`); replay accepts a page
  from any member ([THREAT-MODEL](THREAT-MODEL.md)).
- **KSIT v1** (the sitter page, `kin_sitter_page`): `"KSIT"`, version 1,
  reserved u16, entry count u32, then each entry whose record exists and
  isn't archived, in the page's order: kind u8 (1 note, 2 reference record,
  3 routine), 3 reserved, record ID [16]; then the intro (u16 + UTF-8; length
  0 for none). The host takes titles, fields and text from the KINS
  projection by ID, so nothing is copied. A household that never set a page
  reports no entries and no intro.
- **The family album (kinds 75–76, #673).** The payloads are strict: they
  re-encode to the same bytes, so a zero photo ID, an attachment ID without
  the album prefix `a1 b0` (or with nothing after it), an untrimmed caption,
  a control character or more than 200 caption bytes fail with code 2. KCMD
  actions 75 (`add-album-photo`) and 76 (`remove-album-photo`) carry the
  exact payload as their text with a zero entity ID and no option, date or
  expiry; the host trims the caption and makes it one line first
  (`kin-album.js`). Rust checks them against the album
  (`AlbumState::check_command`, code 4): a new photo ID, an attachment no
  live photo uses, at most 500 photos; a removal names a live photo. Only
  whoever added a photo or a household admin may remove it: Rust can't tell
  who is an admin, so the host's command append path reads the album and
  refuses it for anyone else (`canRemoveAlbumPhoto`); replay accepts a
  removal from any member ([THREAT-MODEL](THREAT-MODEL.md)).
- **KALB v1** (the family album, `kin_album`): `"KALB"`, version 1,
  reserved u16, photo count u32 (≤ 500), removal count u32 (≤ 64); then each
  live photo, newest first: photo ID [16], attachment ID [16], added by
  (member ID) [16], added at i64 (Unix ms, the event's timestamp), caption
  (u16 + UTF-8); then each recent removal, newest first: photo ID [16],
  attachment ID [16], removed at i64. JavaScript decodes it as `{ photos:
  [{ photoId, attachmentId, addedBy, addedAt, caption }], removed: [{
  photoId, attachmentId, removedAt }] }`.
- **The family calendar (kinds 71–74, #656, `rust/src/calendar.rs`).** The
  payloads are strict like store sections: they re-encode to the same bytes.
  Kind 71, the event (72 fixed bytes, then attendees and texts):
  ```text
   0 event ID [16]
  16 flags u8: bit 0 all-day, 1 countdown, 2 repeats, 3 linked to a series
  17 attendee count u8 (0–16), reserved u16
  20 start date u32, start minute u16 (0–1439), end minute u16, end date u32
     (all-day: minutes 0, the end is the last date, inclusive)
  32 rule, 16 bytes (all zero without one): frequency u8 (1 daily, 2 weekly,
     3 monthly, 4 yearly), by u8 (0 none, 1 day of month, 2 nth weekday),
     weekdays u8 (bit 0 Monday … 6 Sunday; weekly only, non-empty), week
     start u8 (0–6; weekly only), interval u16 (1–1,000), count u16 (0 or
     1–1,000), until u32 (0 or a date on or after the start; not with a
     count), month day i8 (1–31 or -1), nth i8 (1–5 or -1), nth weekday u8
     (0–6), reserved u8
  48 series ID [16], original start date u32, minute u16, reserved u16 (all
     zero unless linked; never the event's own ID)
  72 attendee member IDs [16] each, strictly ascending, non-zero
     title (1–200), place (0–200), notes (0–2,000), zone (0–64; empty when
     all-day or floating), source UID (0–255): each u16 length + UTF-8
  ```
  Titles and places are trimmed single lines; notes have `\n` line breaks,
  no trailing space on a line and no control characters but newline; the
  zone is ASCII letters, digits, `/`, `_`, `-`, `+` with no empty segment;
  an event lasts at most 366 days. Kinds 72 and 73: event ID [16], scope u8
  (1 one occurrence, 2 the series), 3 reserved, original start date u32,
  minute u16, reserved u16 (zero for the series); 28 bytes. Kind 74: colour
  u8 (0–11, or 255 for the default), 3 reserved; it colours the event's own
  member. KCMD actions 71 (`save-calendar-event` `{ event }`), 72
  (`cancel-calendar-event` `{ eventId, occurrence }`), 73
  (`restore-calendar-event`, the same) and 74 (`set-member-colour`
  `{ colour }`) carry the exact payload as their text with a zero entity ID
  and no option, date or expiry (`kin-calendar.js`). Rust checks them
  against the current state (`CalendarState::check_command`, code 4): see
  [EVENTS](EVENTS.md#the-family-calendar).
- **KCAQ v1 / KCAL v1** (the calendar between two dates,
  `kin_calendar_range`, `rust/src/calendar_range.rs`): the 20-byte query
  `"KCAQ"`, version 1, reserved u16, from u32, to u32 (valid dates, from ≤ to,
  at most 400 days together, else code 2), flags u32 (bit 0 every event's
  definition, bit 1 cancelled occurrences too, marked; others zero), then a
  record-less KINE context. The result:
  ```text
   0 "KCAL", version u16 = 1, reserved u16
   8 from u32, to u32, today u32 (the context's civil date)
  20 flags u32: bit 0 occurrences past 5,000 left out, 1 items past 2,000
     left out, 2 routine occurrences past 5,000 left out, 3 the household
     mode pauses routines, 4 a next countdown follows
  24 colour, event, occurrence, item, routine and meal counts, u32 each
  48 the next countdown, one occurrence record (20 zero bytes when none)
  68 colours, 20 bytes each by member ID: member ID [16], colour u8 (0–11),
     3 reserved
     events by event ID: flags u8 (bit 0 cancelled as a whole, 1 cancelled
     through its series), reserved u8, cancelled occurrence count u16,
     payload length u32, each cancelled original start (date u32, minute u16,
     reserved u16; ascending), the kind-71 payload
     occurrences, 20 bytes each, earliest first (date, all-day before timed,
     minute, event ID): event index u32 (into the events above), start date
     u32, start minute u16, flags u8 (bit 0 all-day, 1 countdown, 2
     cancelled, 3 stands in for an occurrence of a series), reserved u8, end
     date u32, end minute u16, reserved u16
     items, 40 bytes each by date then text: item ID [16], date u32,
     classification u8, flags u8 (bit 0 owner), reserved u16, owner [16]
     routines, 44 bytes each by date then text: routine ID [16], opens u32,
     occurrence key u32, cadence u8 (as KINS), flags u8 (bit 0 owner, 1
     current, 2 done), reserved u16, owner [16]
     meals by date then slot: date u32, slot u8 (1 breakfast, 2 lunch, 3
     snack, 4 dinner), flags u8 (bit 0 recipe, 1 cook), reserved u16, recipe
     ID [16], cook [16] (zero when none), name u16 + UTF-8
  ```
  Occurrences overlapping the range count, including one that started before
  it and is still going on (a timed one ending exactly at midnight doesn't).
  The next countdown is the first occurrence of a countdown event from the
  context's date to 400 days on, in the range or not. Events are those an
  occurrence or the countdown names, or all of them with flag bit 0 (editing
  a series; finding an earlier import by source UID). Items, routines and
  meals are as KWKD has them over the range, except that meals include
  breakfast, lunch and snacks (kinds 80–81) beside dinners since #660, by
  date then KCAL slot (1 breakfast, 2 lunch, 3 snack, 4 dinner; a cook only
  on dinners), with no format change. At most
  2,000 events and 5,000 occurrences; the earliest are kept. JavaScript
  decodes it with `decodeCalendarRange` (`kin-calendar.js`).
- **KICS v1** (an iCalendar file as Kin events, `kin_ical_parse`, #666,
  `rust/src/ical.rs`): the input is the file's bytes (at most 2 MB, else
  code 5; the parse never fails on content). The result:
  ```text
   0 "KICS", version u16 = 1, reserved u16
   8 event count u32 (at most 5,000), skipped count u32, flags u32 (bit 0
     more than 5,000 events, the rest left out)
  20 the calendar's name (X-WR-CALNAME): u16 length + UTF-8
     per event: flags u32 (bit 0 repeat not kept, first occurrence only; 1
     time zone not understood, floating; 2 STATUS:CANCELLED; 3 an override,
     RECURRENCE-ID; 4 text shortened; 5 length shortened; 6 EXDATEs left
     out; 7 no title), series index u32 (0xFFFFFFFF none), original start
     date u32, minute u16, reserved u16 (zero without a series), EXDATE
     count u16 (at most 1,000), reserved u16, payload length u32, each
     EXDATE (date u32, minute u16, reserved u16; ascending), then the kind-71
     payload with a zero event ID and no series link
  ```
  The host gives each event an ID (an earlier import's when KCAL lists the
  same source UID), saves it, cancels its EXDATEs, and saves each override
  linked to its series' ID and original start, cancelling that occurrence.
  The parse reads VCALENDAR (X-WR-CALNAME) and VEVENT (UID, SUMMARY,
  LOCATION, DESCRIPTION, DTSTART, DTEND, DURATION, RRULE, EXDATE,
  RECURRENCE-ID, STATUS), unfolds lines, unquotes parameters and unescapes
  text; every other component, VTIMEZONE and VALARM included, is skipped.
  Zones: `Z` is `UTC`; an IANA TZID (also inside a longer path) is kept; a
  Windows or Outlook display name maps through a small table; anything else
  is floating, flagged ([ADR 0022](decisions/0022-family-hub.md) §3).
- <a id="the-chore-chart-676"></a>**The chore chart (kinds 77–79, #676,
  `rust/src/chores.rs`).** Payloads are strict and re-encode to the same
  bytes (code 2): 77 is routine ID [16], points u8 (0–10), 3 reserved; 78 is
  member ID [16], goal u16 (0–1000), reserved u16, text (u16 + UTF-8: 1–120
  bytes, trimmed, no control characters; empty exactly when the goal is 0);
  79 is member ID [16], joined u8 (0 or 1), 3 reserved. KCMD actions 77–79
  (`set-chore-points`, `set-chore-reward`, `set-chore-chart-joined`) carry
  the exact payload as their text with a zero entity ID and no option, date
  or expiry (`kin-chores.js`). Rust checks them against the current state
  (`ChoresState::check_command`, code 4): points name a live routine, every
  change changes something, and kind 79 comes from the member it names. The
  host gates the rest (`canSendChoreCommand`): points and rewards are for
  Adults, joining for an Adult while a household admin allows adults.
- **KCCQ v1 / KCCD v1** (the chore chart, `kin_chore_chart`): the query
  `"KCCQ"`, version 1, reserved u16, week start u32 (a Monday, YYYYMMDD),
  flags u8 (bit 0: adults allowed), 3 reserved, eight i64 day boundaries (the
  first instant of each day Monday–Sunday in the host's time zone, then the
  next Monday's; each day 1–25 hours), member count u16 (≤ 32), reserved
  u16 (84 bytes), then 20 bytes per member: ID [16] (non-zero, distinct),
  kind u8 (1 child, 2 Adult), 3 reserved; then a record-less KINE context
  whose civil date lies in the week. The result `"KCCD"`, version 1,
  reserved u16, week start u32, today u32, flags u8 (bit 0: routines
  paused), 3 reserved, member count u16, points-setting count u16 (24
  bytes); then 20 bytes per live routine whose points aren't 1: routine ID
  [16], points u8, 3 reserved; then each member on the chart (children
  always, Adults only when allowed and joined), in the query's order: ID
  [16], flags u8 (bit 0 Adult, bit 1 reward), reserved u8, points this week
  u16, reward goal u16 (0 for none), chore count u16, reward text (u16 +
  UTF-8), then 28 bytes per chore (by day, items before routines, then by
  text; at most 200): kind u8 (1 item, 2 routine), flags u8 (bit 0 done,
  bit 1 today: can be ticked or unticked now), points u8, reserved u8, ID
  [16], date u32 (the day it shows on), occurrence key u32 (0 for an item).
  Open items assigned to the member show on their planned day this week
  (undated and overdue ones today); done items on the day they were done,
  for whoever they're credited to; routine occurrences on the day they open,
  done ones for their credited member, open ones for the owner (only the
  current occurrence of a rotating routine). Points are the credited
  completions whose time falls in the week. JavaScript decodes it as `{
  start, today, routinesPaused, points: Map, members: [{ memberId, adult,
  points, reward, chores }] }`.
- **KMTQ v1 / KMTD v1** (a member's things today, `kin_my_things`): the
  24-byte query `"KMTQ"`, version 1, reserved u16, member ID [16] (non-zero),
  then a record-less KINE context. The result `"KMTD"`, version 1, reserved
  u16, count u32, then 28 bytes per thing: kind u8 (1 item, 2 routine), done
  u8 (0 or 1; 0 for an item), reserved u16, ID [16], occurrence date u32
  (YYYYMMDD; 0 for an item). Items are active, non-Staple, assigned to the
  member and planned for the context's date or earlier, or undated, soonest
  first (undated last), then by text; routines are assigned to the member
  with an occurrence open that day, by text, and none while the household
  mode pauses routines ([ADR 0013](decisions/0013-simple-view.md)).
- **KWKQ v1 / KWKD v1** (the household's week, `kin_week`, #417,
  `rust/src/week.rs`): the 16-byte query `"KWKQ"`, version 1, reserved u16,
  start date u32 (YYYYMMDD; a valid date with six more days before
  9999-12-31, else code 2), reserved u32, then a record-less KINE context.
  The result `"KWKD"`, version 1, reserved u16, start date u32, day count u8
  (always 7), flags u8 (bit 0: the household mode pauses routines), reserved
  u16; then for each of the seven consecutive days from the start: date
  u32, item count u16, routine count u16, meal count u8 (0 or 1),
  maintenance count u8, omitted u16 (entries dropped by the caps, saturating),
  then that day's entries in that order:
  - item, 36 bytes: item ID [16], classification u8 (0 Today, 1 Need,
    2 Shopping, 3 Staple), flags u8 (bit 0 owner), reserved u16, owner member
    ID [16] (zero when none). Active items whose planning date is that day.
    Overdue items (planned before the start) are **not** included: Today
    shows those. Undated, completed and archived items are left out.
  - routine, 40 bytes: routine ID [16], occurrence key u32, cadence u8 (as
    KINS), flags u8 (bit 0 owner, bit 1 current, bit 2 done), reserved u16,
    owner member ID [16] (zero when none). Each occurrence appears once, on
    the day it opens by the routine's cadence (`Cadence::current_key` and
    `next_start`); one already open on the start date appears on the start
    date. Weekdays routines have none on Saturday and Sunday. Archived
    routines have none, and none at all while the household mode isn't
    Normal (flag bit 0). "Current" is the occurrence open on the context's
    civil date; "done" is reported only for it (never without current).
  - meal: flags u8 (bit 0 recipe, bit 1 cook), 3 reserved, recipe ID [16]
    (zero when none), cook member ID [16] (zero when none), name as shown
    (u16 + UTF-8), as a KMLS dinner without its date.
  - maintenance, 36 bytes: maintenance ID [16], reference record ID [16],
    performed date u32. Entries not archived, on a reference record that
    isn't archived, whose next date is that day.
  Items, routines and maintenance sort by text (summary), then ID. Caps per
  day: 64 items, 64 routine occurrences, 32 maintenance entries (one dinner
  per date by the meals model); the rest of that kind are dropped and
  counted in `omitted`. The household mode is the history's at the context's
  as-of and applies to the whole week. Texts other than a dinner's name come
  from KINS by ID. Output is deterministic for a log, context and start.
- **KMNM v1** (preferred member names, `kin_member_names`, #224): `"KMNM"`,
  version 1, reserved u16, member count u32, then per member in member-ID
  order: member ID (16 bytes, after identity bindings), name length u16
  (never zero) and the name (UTF-8). Members without a preferred name are
  absent, and hosts keep their own fallback labels. The context is a
  record-less KINE request, as for `kin_project`. KCMD action 51
  (`name-member`) carries the name as its payload, a zero entity ID and no
  option or date (empty clears); there is no target, because a member can
  only name themselves. Executing it rejects a name that would change nothing.
- **Chat commands (KCMD 44–50 and 65, v1.1).** The entity ID is the message ID. Action 48 (`pin-chat-message`) carries `on` (0 or 1) in the u8 field and no payload.
  Action 65 (`set-chat-topic`, #312) carries the topic state in the u8 field
  (0 cleared, 1 open, 2 resolved; 3 and above are malformed) and no payload,
  date or expiry. Executing needs a message the log holds and its author has
  not deleted, and a change: open from no topic or a resolved one (refused
  past 200 open or resolved topics), resolved from open, both only on a
  message that shows (not removed by a named admin); cleared from either.
  Every refusal is code 4.
  Poll commands (#135): action 44 with content kind 3 posts a poll: the
  `date` field carries the option count in its low byte (2–10) and 1 in the
  next byte for multiple choice; the payload is the blob pair as for text (the
  question and the options' text live in the sealed blob). Action 49
  (`vote-chat-poll`) carries the choice as a bit set (bit n is option n) in
  the `date` field, replacing the member's earlier vote; 0 clears it. Action
  50 (`close-chat-poll`) carries nothing. Executing a vote needs an open poll
  that shows, a choice the poll allows (one bit unless multiple choice, none
  past the option count) and a change from the member's current vote; a close
  needs the poll's author and a poll not yet closed.
  Action 44 (`post-chat-message`) carries the content kind in the u8 field
  (1 text, 2 attachment, 3 poll) and a 64-byte payload: blob ref, then blob key; a
  reply adds a third 16 bytes, the ID of the message it answers (80 in all).
  Executing a reply requires a message the log holds that still shows (not
  deleted, not removed by a named admin).
  Action 45 (`edit-chat-message`) carries the 64-byte blob payload only (80
  is malformed) and a zero u8 field. Action 46 (`delete-chat-message`) carries `by_admin` (0 or 1) in the
  u8 field and no payload. A zero ref, key or reply ID is malformed (code 2). Executing
  requires a blob reference the chat log has never seen (to post or edit), a
  new message ID to post; the author, a text message and a message not
  deleted to edit; and to delete, a message not deleted, with `by_admin` 0
  for your own and 1 for another member's, once per admin and only with the
  actor among the admins named in the request. Action 47
  (`react-chat-message`) carries `on` (0 or 1) in the u8 field and the emoji
  as its text payload (1–32 bytes; one emoji grapheme, which executing
  checks, failing with code 4 otherwise). Executing requires a message the log holds that is neither
  deleted nor removed by a named admin, and a change: turning on a reaction
  the actor already has, or off one they lack, is refused, as is a 25th
  different emoji on one message (replay ignores one past the 24th too).
- **KCHQ v1** (chat page request, `kin_chat_page`): `"KCHQ"`, version 1,
  reserved u16, before u32 (the page ends before this message index;
  `0xFFFFFFFF` for the newest), limit u16 (1–500), flags u8 (bit 0: texts the
  arena holds; bit 1: retired blobs; bit 2: reactions; bit 3: pins; bit 4: polls; bit 5: topics, #312), reserved u8, admin count u32 (at most
  16), the admins' member IDs (16 bytes each, non-zero), then a record-less
  KINE context as for `kin_project`.
- **KCHF v1** (chat search request, `kin_chat_search`, #124): `"KCHF"`,
  version 1, reserved u16, limit u32 (1–200), flags u32 (bit 0: attachments
  only; bit 1: only messages mentioning one member, whose 16-byte ID follows
  the excluded IDs, #130), from i64 and to i64 (posted at or after `from`, before `to`, in
  milliseconds; 0 for no bound; `to` after `from` when both are set), query
  bytes u32 (at most 256), admin count u32 (at most 16), author count u32 (at
  most 16), excluded count u32 (at most 10,000). Then the query (UTF-8), the
  admins, the authors (only these members' messages) and the excluded
  message IDs (messages the member hid for themselves), 16 bytes each and
  non-zero for the admins and authors, then a record-less KINE context.
  Texts of retired blobs are forgotten first, as for a page, so a deleted
  message never matches. The search folds case and accents (Latin letters
  including Latin-1, Latin Extended-A, Romanian ș/ț and Vietnamese, Greek
  final sigma; combining accents and emoji selectors are ignored) and
  matches substrings over Unicode scalars, but never splits a grapheme
  (a joiner, skin tone, keycap, tag or combining mark continuing the match
  or starting it, a match after a joiner, or half of a flag). A query that
  folds to nothing (only a combining mark, say) matches nothing. An empty query lists the messages that pass the filters; a query
  matches text messages only. Nothing is indexed or kept between calls.
- **KCHR v1** (chat search result): `"KCHR"`, version 1, reserved u16, then
  u32s: total matches, results listed, unsearched total, unsearched listed
  (at most 256). Results come newest first, each 60 bytes then its ranges
  and excerpt: message ID @0, index u32 @16, range count u32 @20 (at most 4),
  author @24, posted at i64 @40, content kind u32 @48 (1 text, 2
  attachment), excerpt offset u32 @52 and excerpt length u32 @56; then
  (start u32, end u32) UTF-8 byte ranges into the whole text, then the
  excerpt, up to about 160 bytes of the text around the first match, cut on
  character boundaries and starting `offset` bytes into the text. Then one
  80-byte entry per unsearched message listed (newest first): its ID, blob
  ref and blob key, for texts the arena doesn't hold yet. The host opens
  them (`kin_chat_text`) and searches again.
- **KCHP v1** (chat page): `"KCHP"`, version 1, reserved u16, then u32s:
  total messages, index of the page's first message, messages in the page,
  text bytes, retired blobs. Then 128 bytes per message, oldest first:
  message ID @0, author @16, posting device @32 (after identity bindings),
  posted at i64 @48, edited at i64 @56 (0 if never), index u32 @64, status u8
  @68 (0 live, 1 edited, 2 deleted, 3 removed by an admin), content kind u8
  @69, reply flag u8 @70 (1 for a reply that still shows, else 0), mention
  flags u8 @71 (bit 0 everyone, bit 1 members are named; #130), blob ref @72 (zero unless live or edited), text offset
  u32 @104 and length u32 @108 (length 0: the arena doesn't hold the text),
  reaction groups u32 @112 (0 unless the request asked for reactions and the
  message is live or edited), named mentions u16 @116, poll option count u8 @118, poll flags u8 @119, poll voters u16 @120, 6 reserved
  (the named IDs follow the quotes in record order, 16 bytes each). Then 32 bytes of blob key per message (zero unless live or
  edited), the text bytes, and 32 bytes per retired blob: every blob replaced
  by an edit or deleted by its author, every blob brought by an event that
  applies nowhere ([EVENTS](EVENTS.md#v110-household-chat)), plus the blobs
  of messages removed by a named admin, each once and only if no live or
  edited message shows it (`ChatState::retired_blobs`). A request for
  reactions adds a last section: for each message in order, each of its
  groups, in the order replay first saw the emoji: emoji length u8, the
  emoji's UTF-8, member count u32 (at least 1), then 16 bytes per member's
  actor ID (in the order they reacted). A deleted or removed message has no
  groups. Last come the quotes (#129), one per record with the reply flag, in
  record order: the original's message ID, state u8 (0 this log doesn't hold
  it, 1 live, 2 edited, 3 deleted, 4 removed by a named admin), content kind
  u8 (0 if unknown), 2 reserved, its author, blob ref and blob key (zero
  unless live or edited), its index u32 (`0xFFFFFFFF` if unknown), text
  length u32, then the text (the arena's, for visible text, when texts were
  asked for: its first non-blank line, at most 256 bytes). The quoted text is never copied into the reply's event. Reading a page first forgets
  the arena's texts for those blobs, so a deleted message's text never comes
  back out. Message indexes
  are positions in posting (replay) order, so a late-arriving older message
  shifts them; hosts re-read from the newest after a sync. When the request
  asked for pins (#131, flag bit 3), the page ends with them, after the
  named mentions: a count u32 (at most 10), then per pin, oldest pinned
  first, who pinned it (16) and the message as a quote entry (same layout and
  rules as above; only messages that show are listed).
  When the request asked for polls (#135, flag bit 4), a poll's record carries
  its option count at byte 118, flags at 119 (1 multiple choice, 2 closed) and
  its voter count as a u16 at 120 (bytes 122–127 stay zero; all were reserved
  zero before). The page then ends with the votes of each shown poll, in
  record order: per voter, in ascending member order, the member ID (16), the
  chosen options as a u16 bit set and 2 zero bytes (20 bytes). At most 64
  voters are kept per poll. A member's vote is their latest, by logical time.
  When the request asked for topics (#312, flag bit 5), the page ends with
  the "To talk about" list, after the votes: a count u32 (at most 200), then
  per topic, newest change first: the message ID (16), state u8 (1 open, 2
  resolved), 3 zero bytes, who flagged it (16), then the message as a quote
  entry (same layout and rules as a pin's). Only topics whose message still
  shows are listed; a topic is never cleared in a page.
- **KAPQ v1 / KAPR v1** (voice waveform, `kin_audio_peaks`, #134):
  `"KAPQ"`, version 1, 3 reserved zero bytes, sample count u32 (1–16,000,000),
  then that many little-endian f32 samples (mono, -1.0 to 1.0); the byte length
  must match exactly. The result is `"KAPR"`, version 1, 3 reserved zero bytes,
  then 64 bytes. Sample `i` of `n` falls in bucket `i * 64 / n`; a bucket's
  byte is its largest magnitude (NaN counts as silence, anything past 1.0 as
  1.0) times 255, rounded. With fewer than 64 samples the unused buckets are
  0. One pass over the samples; no household or chat state is read or kept.
- **KCHT v1 / KCHS v1** (chat texts, `kin_chat_text`): `"KCHT"`, version 1,
  reserved u16, count u32 (1–500), then per text: blob ref (32, non-zero),
  length u32, the UTF-8 text. Every entry is framed before any is stored. The
  result is `"KCHS"`, version 1, reserved u16, count u32, then a status byte
  per text: 0 held (or already held: texts are content-addressed), 1 refused
  by the text rules. The arena holds at most 16 MiB: a batch that wouldn't
  fit starts it over once, before storing anything, so every text a batch
  reports as held is held, and the host supplies earlier texts again. The
  arena grows by copying into a new buffer and zero-filling the old one, so
  freed memory holds no text. Texts stay until lock (`kin_clear`) or
  `kin_chat_texts_clear` (a member who lost chat access while unlocked);
  `kin_chat_history_reset` keeps them, since the history mirror resets the
  chat log whenever it is handed a plain array.
- **KIMP v1** (import plan): `"KIMP"`, version 1, reserved, event count u32,
  next logical time u64, projection length u32, KINS projection. Duplicate
  event IDs, including exact duplicates, fail.
- **KARC v1** (archive container): `"KARC"`, version 1, reserved, metadata
  length u32 (1–1 MiB), ciphertext length u32 (at least a 16-byte tag), then
  both sections exactly; at most 160 MiB in total. Framing is not
  authentication; the browser authenticates the package before using it.

## JavaScript bridge

`web/wasm/kin-engine.js` loads and checks the module, allocates and copies
buffers, encodes KINE and KCMD, decodes KINS (`decodeProjection` in
`projection-decode.js`, one module per section family under `projection/`) and
converts status codes to safe messages. It never reduces events.
The engine reuses every decoded section of the last state it produced whose
revision is unchanged, keeping those arrays' identity. Cross-section
references are checked again on every decode. A replay or command history may
be a session-arena view, a `historyWith(view, extras)` source or an array of
canonical records; the history mirror (above) brings the instance up to date
with it before `kin_project` or `kin_execute`. `createEngine(exports)` wraps
instantiated exports for tests, `web/wasm/abi-test-support.mjs` replays whole
KINE requests through the raw ABI for tests, and `engine.projectionBytes(...)`
returns exact KINS bytes for the projection-equivalence oracle.

## History

Protocols 1–23 were additive: v1 Items, v2 classification and archive, v3
Handoff, v4 Talk, v5 Pulse with `as_of`, v6 catch-up summary, v7 Routines with
a civil date, v8 distributed ordering and identity bindings, v9 Areas, v10
Notes, v11 Steps, v12 richer cadences, v13 Shopping, v14 Staples, v15 modes,
v16 planning dates, v17 last-changed dates, v18 Pins, v19 Playbooks, v20
Reference Records, v21 Maintenance, v22 attachments, v23 responsibility, and
v24 Weekdays plus next-occurrence dates. Protocol 24's layout is the
accumulation of those sections. Refactor Slice 4 regrouped the KINS body into
per-domain sections behind a section table with revisions. The per-version contracts are in the release
records (for example [V0.7.0](planning/V0.7.0.md), [V0.9.0](planning/V0.9.0.md),
[V0.10.0](planning/V0.10.0.md) and `releases/`).
